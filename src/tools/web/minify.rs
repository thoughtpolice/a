// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail};
use oxc::allocator::Allocator;
use oxc::codegen::{Codegen, CodegenOptions, CodegenReturn, CommentOptions, LegalComment};
use oxc::minifier::{
    CompressOptions, CompressOptionsKeepNames, MangleOptions, MangleOptionsKeepNames, Minifier,
    MinifierOptions,
};
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc_sourcemap::{SourceMap, Token};
use serde_json::json;

use crate::diagnostics::{Diagnostic, Position, byte_at};

// This is a post-bundle transform, not a resolver or a TypeScript checker.
fn minify_source<'a>(
    allocator: &'a Allocator,
    source: &'a str,
    name: &Path,
    emit_map: bool,
) -> std::result::Result<CodegenReturn<'a>, Vec<Diagnostic>> {
    let parsed = Parser::new(allocator, source, SourceType::mjs()).parse();
    let path = name.to_string_lossy();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|d| Diagnostic::oxc(&path, source, d, 0))
            .collect());
    }
    let mut program = parsed.program;
    // The minifier's internal semantic passes do not return syntax diagnostics.
    // Validate before giving it an AST (e.g. duplicate lexical bindings).
    let checked = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&program);
    if !checked.diagnostics.is_empty() {
        return Err(checked
            .diagnostics
            .iter()
            .map(|d| Diagnostic::oxc(&path, source, d, 0))
            .collect());
    }
    drop(checked);
    let mut compress = CompressOptions::smallest();
    compress.drop_debugger = false;
    compress.keep_names = CompressOptionsKeepNames::all_true();
    compress.treeshake.invalid_import_side_effects = true;
    let result = Minifier::new(MinifierOptions {
        compress: Some(compress),
        mangle: Some(MangleOptions {
            keep_names: MangleOptionsKeepNames::all_true(),
            ..MangleOptions::default()
        }),
        // Public object properties are ABI, not private bundle bindings.
        mangle_properties: None,
    })
    .minify(allocator, &mut program);
    Ok(Codegen::new()
        .with_options(CodegenOptions {
            minify: true,
            source_map_path: emit_map.then(|| name.to_path_buf()),
            comments: CommentOptions {
                legal: LegalComment::Inline,
                ..CommentOptions::disabled()
            },
            ..CodegenOptions::default()
        })
        .with_scoping(result.scoping)
        .build(&program))
}

// Consume the two maps: keep the generated token allocation and move authored
// metadata, rather than cloning a large bundle's names and sourcesContent.
fn compose<'a>(generated: SourceMap<'a>, input: SourceMap<'a>) -> SourceMap<'a> {
    let lookup = input.generate_lookup_table();
    let mut parts = generated.into_parts();
    for token in &mut parts.tokens {
        let original = token
            .get_source_id()
            .and_then(|_| input.lookup_token(&lookup, token.get_src_line(), token.get_src_col()))
            .filter(|original| original.get_source_id().is_some());
        *token = if let Some(original) = original {
            Token::new(
                token.get_dst_line(),
                token.get_dst_col(),
                original.get_src_line(),
                original.get_src_col(),
                original.get_source_id(),
                original.get_name_id(),
            )
        } else {
            // Do not attribute generated/unmapped code to a nearby authored file.
            Token::new(token.get_dst_line(), token.get_dst_col(), 0, 0, None, None)
        };
    }
    drop(lookup);
    let original = input.into_parts();
    parts.names = original.names;
    parts.sources = original.sources;
    parts.source_contents = original.source_contents;
    parts.source_root = original.source_root;
    parts.x_google_ignore_list = original.x_google_ignore_list;
    // A debug ID identifies the old bundle; it is not valid for this output.
    parts.debug_id = None;
    parts.token_chunks = None;
    SourceMap::from_parts(parts)
}

fn remap_diagnostics(diagnostics: &mut [Diagnostic], map: &SourceMap<'_>) {
    let lookup = map.generate_lookup_table();
    for diagnostic in diagnostics {
        let mapped = diagnostic
            .location
            .and_then(|position| map.lookup_token(&lookup, position.line - 1, position.column))
            .filter(|token| token.get_source_id().is_some());
        let Some(token) = mapped else {
            // Retain the honest bundle location when no authored mapping exists.
            continue;
        };
        let id = token.get_source_id().unwrap();
        let Some(path) = map.get_source(id) else {
            continue;
        };
        diagnostic.path = match map.get_source_root() {
            Some(root) if !root.is_empty() && !path.starts_with('/') && !path.contains(':') => {
                format!("{}/{path}", root.trim_end_matches('/'))
            }
            _ => path.to_owned(),
        };
        let start = Position {
            line: token.get_src_line() + 1,
            column: token.get_src_col(),
        };
        let end = diagnostic
            .end_location
            .and_then(|position| map.lookup_token(&lookup, position.line - 1, position.column))
            .filter(|end| end.get_source_id() == Some(id))
            .map(|end| Position {
                line: end.get_src_line() + 1,
                column: end.get_src_col(),
            });
        diagnostic.location = Some(start);
        diagnostic.end_location = end;
        let source = map.get_source_content(id);
        diagnostic.start = source.and_then(|source| byte_at(source, start));
        diagnostic.end = source.and_then(|source| end.and_then(|end| byte_at(source, end)));
    }
}

// Source-map URLs are relative to the JS file, including when callers put the
// map in a different directory. Encode path bytes so spaces/# do not break URLs.
fn map_url(output: &Path, map: &Path) -> Result<String> {
    let cwd = std::env::current_dir()?;
    let normalize = |path: &Path| {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        let mut normalized = std::path::PathBuf::new();
        for component in absolute.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                _ => normalized.push(component.as_os_str()),
            }
        }
        normalized
    };
    let output = normalize(output);
    let map = normalize(map);
    let parent = output
        .parent()
        .context("output must have a parent directory")?;
    let from = parent.components();
    let to = map.components();
    let common = from
        .clone()
        .zip(to.clone())
        .take_while(|(a, b)| a == b)
        .count();
    let mut relative = std::path::PathBuf::new();
    for _ in from.skip(common) {
        relative.push("..");
    }
    for component in to.skip(common) {
        relative.push(component.as_os_str());
    }
    let mut url = String::with_capacity(relative.as_os_str().as_encoded_bytes().len());
    for &byte in relative.as_os_str().as_encoded_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            url.push(byte as char);
        } else {
            write!(url, "%{byte:02X}").unwrap();
        }
    }
    Ok(url)
}

pub fn run(
    input: &Path,
    output: &Path,
    input_map: Option<&Path>,
    output_map: Option<&Path>,
) -> Result<bool> {
    if input_map.is_some() && output_map.is_none() {
        bail!("--input-map requires --output-map; refusing to discard authored source mappings")
    }
    if output_map == Some(output) {
        bail!("JavaScript and source map outputs must differ")
    }
    let source =
        fs::read_to_string(input).with_context(|| format!("reading {}", input.display()))?;
    let map_json = input_map
        .map(fs::read_to_string)
        .transpose()
        .context("reading input source map")?;
    let authored = map_json
        .as_deref()
        .map(SourceMap::from_json_string)
        .transpose()
        .context("parsing input source map")?;
    let allocator = Allocator::default();
    let mut generated = match minify_source(&allocator, &source, input, output_map.is_some()) {
        Ok(generated) => generated,
        Err(mut diagnostics) => {
            if let Some(map) = &authored {
                remap_diagnostics(&mut diagnostics, map);
            }
            crate::print_json(&json!({"success": false, "diagnostics": diagnostics}))?;
            return Ok(false);
        }
    };
    if let Some(path) = output_map {
        let map = generated
            .map
            .take()
            .context("Oxc did not emit a minification source map")?;
        let mut map = if let Some(authored) = authored {
            compose(map, authored)
        } else {
            map
        };
        map.set_file(
            output
                .file_name()
                .and_then(|name| name.to_str())
                .context("output filename must be UTF-8")?,
        );
        let url = map_url(output, path)?;
        write!(generated.code, "\n//# sourceMappingURL={url}\n").unwrap();
        fs::write(path, map.to_json_string())
            .with_context(|| format!("writing {}", path.display()))?;
    }
    fs::write(output, generated.code).with_context(|| format!("writing {}", output.display()))?;
    crate::print_json(
        &json!({"success": true, "output": output, "map": output_map, "diagnostics": []}),
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diagnostics::position;
    use oxc::ast::ast::{StringLiteral, TemplateLiteral};
    use oxc::ast_visit::Visit;
    use std::borrow::Cow;

    #[derive(Default)]
    struct Literals(Vec<(String, u32)>);
    impl<'a> Visit<'a> for Literals {
        fn visit_string_literal(&mut self, literal: &StringLiteral<'a>) {
            self.0.push((literal.value.to_string(), literal.span.start));
        }
        fn visit_template_literal(&mut self, literal: &TemplateLiteral<'a>) {
            // Compression may use either JavaScript spelling of a constant string.
            if literal.expressions.is_empty()
                && let Some(value) = literal
                    .quasis
                    .first()
                    .and_then(|quasi| quasi.value.cooked.as_ref())
            {
                self.0.push((value.to_string(), literal.span.start));
            }
        }
    }

    #[test]
    fn maps_generated_literal_coordinates_to_each_authored_source() {
        let source = "export function first() { return '🧭'; }\nexport function second() { return 'second'; }\n";
        let tokens = ["'🧭'", "'second'"]
            .iter()
            .enumerate()
            .map(|(id, literal)| {
                let at = position(source, source.find(literal).unwrap() as u32);
                Token::new(
                    at.line - 1,
                    at.column,
                    id as u32 + 6,
                    3,
                    Some(id as u32),
                    Some(id as u32),
                )
            })
            .collect::<Vec<_>>();
        let mut input = SourceMap::new(
            None,
            vec![Cow::Borrowed("first"), Cow::Borrowed("second")],
            Some(Cow::Borrowed("/authored")),
            vec![Cow::Borrowed("a.ts"), Cow::Borrowed("b.ts")],
            vec![
                Some(Cow::Borrowed("a content")),
                Some(Cow::Borrowed("b content")),
            ],
            tokens.into_boxed_slice(),
            None,
        );
        input.set_x_google_ignore_list(vec![1]);
        let allocator = Allocator::default();
        let generated = minify_source(&allocator, source, Path::new("bundle.js"), true).unwrap();
        let map = compose(generated.map.unwrap(), input);
        let parsed = Parser::new(&allocator, &generated.code, SourceType::mjs()).parse();
        assert!(parsed.diagnostics.is_empty());
        let mut literals = Literals::default();
        literals.visit_program(&parsed.program);
        let lookup = map.generate_lookup_table();
        for (value, id) in [("🧭", 0), ("second", 1)] {
            let (_, byte) = literals
                .0
                .iter()
                .find(|(literal, _)| literal == value)
                .unwrap();
            let at = position(&generated.code, *byte);
            let token = map.lookup_token(&lookup, at.line - 1, at.column).unwrap();
            assert_eq!(token.get_source_id(), Some(id));
            assert_eq!((token.get_src_line(), token.get_src_col()), (id + 6, 3));
            assert_eq!(
                map.get_name(token.get_name_id().unwrap()),
                Some(if id == 0 { "first" } else { "second" })
            );
        }
        assert_eq!(map.get_source_root(), Some("/authored"));
        assert_eq!(map.get_source_content(1), Some("b content"));
        assert_eq!(map.get_x_google_ignore_list(), Some([1].as_slice()));
    }

    #[test]
    fn malformed_bundle_diagnostic_uses_authored_utf16_coordinates() {
        let allocator = Allocator::default();
        let source = "export const value = ;";
        let mut errors = minify_source(&allocator, source, Path::new("bundle.js"), false)
            .err()
            .unwrap();
        let content = "// 🧭\n    value";
        let map = SourceMap::new(
            None,
            vec![],
            None,
            vec![Cow::Borrowed("src/entry.ts")],
            vec![Some(Cow::Borrowed(content))],
            vec![Token::new(0, 0, 1, 4, Some(0), None)].into_boxed_slice(),
            None,
        );
        remap_diagnostics(&mut errors, &map);
        let error = &errors[0];
        assert_eq!(error.path, "src/entry.ts");
        assert_eq!(error.start, Some(content.find("value").unwrap() as u32));
        assert_eq!(
            (error.location.unwrap().line, error.location.unwrap().column),
            (2, 4)
        );
    }

    #[test]
    fn semantically_invalid_bundle_is_rejected_before_minification() {
        let allocator = Allocator::default();
        let errors = minify_source(
            &allocator,
            "let value; let value; export { value };",
            Path::new("bundle.js"),
            false,
        )
        .err()
        .unwrap();
        assert!(
            errors
                .iter()
                .any(|error| error.severity == "error" && error.start.is_some())
        );
    }

    #[test]
    fn source_map_url_is_relative_and_encoded() {
        assert_eq!(
            map_url(
                Path::new("/build/js/index.js"),
                Path::new("/build/maps/index #.map")
            )
            .unwrap(),
            "../maps/index%20%23.map"
        );
    }
}
