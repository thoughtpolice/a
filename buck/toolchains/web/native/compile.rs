// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::borrow::Cow;
use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Component, Path};

use anyhow::{Context, Result, bail};
use oxc::allocator::Allocator;
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};
use oxc_sourcemap::{SourceMap, Token};
use rsvelte::{ComponentOptions, CssMode, Engine, ProjectionOptions};
use rsvelte_core::compiler::{GenerateMode, ModuleCompileOptions, compile_module};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::diagnostics::{Diagnostic, Position, byte_at};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    files: Vec<Input>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    source: String,
    name: String,
}

pub struct Compiled<'source> {
    pub artifacts: Vec<(String, Cow<'source, str>)>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn js_name(name: &str) -> Result<String> {
    if name.ends_with(".svelte") {
        Ok(format!("{name}.js"))
    } else if let Some(prefix) = name.strip_suffix(".svelte.ts") {
        Ok(format!("{prefix}.svelte.js"))
    } else if matches!(
        Path::new(name).extension().and_then(|ext| ext.to_str()),
        Some("ts" | "js" | "tsx" | "jsx" | "mts" | "mjs" | "cts" | "cjs")
    ) {
        Ok(name.to_owned())
    } else {
        bail!("expected a Svelte component or JavaScript/TypeScript source, got {name}")
    }
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.contains('\\')
        || name.contains('\0')
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || Path::new(name)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        bail!("manifest name must be a normalized relative slash-separated path: {name:?}")
    }
    js_name(name)?;
    Ok(())
}

fn reserve_outputs<'a>(names: impl IntoIterator<Item = &'a str>) -> Result<()> {
    let mut outputs = HashSet::new();
    for name in names {
        let component = name.ends_with(".svelte");
        let rune_module = name.ends_with(".svelte.ts") || name.ends_with(".svelte.js");
        let mut paths = Vec::new();
        for target in ["client", "server"] {
            let js = format!("{target}/{}", js_name(&name)?);
            if component || rune_module {
                paths.push(format!("{js}.map"));
            }
            paths.push(js);
            if component {
                paths.push(format!("{target}/{name}.css"));
                paths.push(format!("{target}/{name}.css.map"));
            }
        }
        if component {
            paths.push(format!("check/{name}.tsx"));
            paths.push(format!("check/{name}.tsx.map"));
        } else {
            paths.push(format!("check/{name}"));
        }
        if component || rune_module {
            paths.push(format!("facts/{name}.json"));
        }
        for path in paths {
            if let Some(duplicate) = outputs.replace(path) {
                bail!("duplicate output path {duplicate}; check manifest source names")
            }
        }
    }
    Ok(())
}

fn range(range: rsvelte::ByteRange) -> Value {
    json!({"start": range.start(), "end": range.end()})
}

pub fn facts_json(facts: &rsvelte::ComponentFacts) -> Value {
    json!({
        "runes": facts.runes, "css_scope": facts.css_scope,
        "uses_legacy_props": facts.uses_legacy_props,
        "uses_legacy_rest_props": facts.uses_legacy_rest_props,
        "uses_legacy_slots": facts.uses_legacy_slots,
        "uses_render_tags": facts.uses_render_tags,
        "uses_component_bindings": facts.uses_component_bindings,
        "scripts": facts.scripts.iter().map(|script| json!({
            "kind": match script.kind { rsvelte::ScriptKind::Module => "module", _ => "instance" },
            "tag": range(script.tag), "content": range(script.content), "typescript": script.typescript,
        })).collect::<Vec<_>>(),
        "style": facts.style.as_ref().map(|style| json!({"tag": range(style.tag), "content": range(style.content)})),
        "props": facts.props.iter().map(|prop| json!({"name": prop.name, "local_name": prop.local_name,
            "declaration": prop.declaration.map(range), "bindable": prop.bindable})).collect::<Vec<_>>(),
        "exports": facts.exports.iter().map(|export| json!({"name": export.name, "local_name": export.local_name})).collect::<Vec<_>>(),
    })
}

fn normalized_map(map: &str, source: &str, name: &str, output: &str) -> Result<String> {
    let mut map = SourceMap::from_json_string(map)?;
    if map.get_sources().len() != 1 {
        bail!("{name}: expected one source in compiler map")
    }
    map.set_sources([name]);
    map.set_source_contents(vec![Some(source)]);
    map.set_file(output);
    Ok(map.to_json_string())
}

fn push_code(
    artifacts: &mut Vec<(String, Cow<'_, str>)>,
    output: String,
    mut code: String,
    map: String,
) {
    let basename = Path::new(&output).file_name().unwrap().to_string_lossy();
    write!(code, "\n//# sourceMappingURL={basename}.map\n").unwrap();
    artifacts.push((format!("{output}.map"), map.into()));
    artifacts.push((output, code.into()));
}

pub fn erase_types(
    source: &str,
    name: &str,
) -> std::result::Result<(String, SourceMap<'static>), Vec<Diagnostic>> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::ts()).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(parsed
            .diagnostics
            .iter()
            .map(|d| Diagnostic::oxc(name, source, d, 0))
            .collect());
    }
    let mut program = parsed.program;
    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .with_enum_eval(true)
        .build(&program);
    if !semantic.diagnostics.is_empty() {
        return Err(semantic
            .diagnostics
            .iter()
            .map(|d| Diagnostic::oxc(name, source, d, 0))
            .collect());
    }
    let mut options = TransformOptions::default();
    // A value import remains a dependency even if only a type uses its binding.
    options.typescript.only_remove_type_imports = true;
    let transformed = Transformer::new(&allocator, Path::new(name), &options)
        .build_with_scoping(semantic.semantic.into_scoping(), &mut program);
    if !transformed.diagnostics.is_empty() {
        return Err(transformed
            .diagnostics
            .iter()
            .map(|d| Diagnostic::oxc(name, source, d, 0))
            .collect());
    }
    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(name.into()),
            ..CodegenOptions::default()
        })
        .build(&program);
    match generated.map {
        Some(map) => Ok((generated.code, map.into_owned())),
        None => Err(vec![Diagnostic::io(
            name,
            "Oxc did not emit a TypeScript erasure source map",
        )]),
    }
}

fn component(
    engine: &Engine,
    source: &str,
    name: &str,
) -> std::result::Result<Compiled<'static>, Vec<Diagnostic>> {
    let js = format!("{name}.js");
    let css = format!("{name}.css");
    let options = ComponentOptions::new()
        .filename(name)
        .output_filename(&js)
        .css_output_filename(&css)
        .css_mode(CssMode::External)
        .source_maps(true);
    let mut prepared = engine
        .prepare(source, options)
        .map_err(|error| vec![Diagnostic::svelte(name, source, &error.diagnostic)])?;
    let typescript = prepared
        .facts()
        .scripts
        .iter()
        .any(|script| script.typescript);
    let mut facts = facts_json(prepared.facts());
    let projection = engine
        .project(
            source,
            ProjectionOptions::new()
                .filename(name)
                .typescript(typescript),
        )
        .map_err(|error| vec![Diagnostic::svelte(name, source, &error.diagnostic)])?;
    facts["projection"] = json!({
        "runes": projection.facts.runes,
        "props": projection.facts.props.iter().map(|prop| json!({"name": prop.name,
            "local_name": prop.local_name, "optional": prop.optional, "bindable": prop.bindable,
            "type_annotation": prop.type_annotation})).collect::<Vec<_>>(),
        "exports": projection.facts.exports.iter().map(|export| json!({"name": export.name,
            "local_name": export.local_name, "type_annotation": export.type_annotation})).collect::<Vec<_>>(),
        "events": projection.facts.events,
        "exact_mappings": projection.exact_mappings.as_ref().map(|map| map.segments().iter()
            .map(|segment| json!({"source": range(segment.source), "generated": range(segment.generated)})).collect::<Vec<_>>()),
    });
    let (client, server) = prepared
        .compile_both()
        .map_err(|error| vec![Diagnostic::svelte(name, source, &error.diagnostic)])?;
    let mut compiled = Compiled {
        artifacts: Vec::new(),
        diagnostics: Vec::new(),
    };
    let artifact_result = (|| -> Result<()> {
        let output = format!("check/{name}.tsx");
        let map = projection
            .source_map
            .as_deref()
            .context("projection did not emit a source map")?;
        // TSX projection is consumed by the checker, with exact mappings also available in facts.
        compiled.artifacts.push((
            format!("{output}.map"),
            normalized_map(map, source, name, &output)?.into(),
        ));
        compiled.artifacts.push((output, projection.code.into()));
        for (target, artifact) in [("client", client), ("server", server)] {
            compiled.diagnostics.extend(
                artifact
                    .diagnostics
                    .iter()
                    .map(|d| Diagnostic::svelte(name, source, d)),
            );
            let output = format!("{target}/{js}");
            let map = artifact
                .javascript
                .source_map
                .as_deref()
                .context("compiler did not emit a JavaScript source map")?;
            let map = normalized_map(map, source, name, &output)?;
            push_code(
                &mut compiled.artifacts,
                output,
                artifact.javascript.code,
                map,
            );
            if let Some(style) = artifact.css {
                let output = format!("{target}/{css}");
                let map = style
                    .source_map
                    .as_deref()
                    .context("compiler did not emit a CSS source map")?;
                compiled.artifacts.push((
                    format!("{output}.map"),
                    normalized_map(map, source, name, &output)?.into(),
                ));
                let basename = Path::new(&output).file_name().unwrap().to_string_lossy();
                let mut code = style.code;
                write!(code, "\n/*# sourceMappingURL={basename}.map */\n").unwrap();
                compiled.artifacts.push((output, code.into()));
            }
        }
        compiled.artifacts.push((
            format!("facts/{name}.json"),
            serde_json::to_string(&facts)?.into(),
        ));
        Ok(())
    })();
    artifact_result.map_err(|error| {
        vec![Diagnostic::io(
            name,
            format!("artifact generation: {error:#}"),
        )]
    })?;
    compiled
        .diagnostics
        .sort_by(|a, b| (&a.start, &a.code).cmp(&(&b.start, &b.code)));
    compiled.diagnostics.dedup_by(|a, b| {
        a.start == b.start && a.end == b.end && a.code == b.code && a.message == b.message
    });
    Ok(compiled)
}

fn module<'source>(
    source: &'source str,
    name: &str,
) -> std::result::Result<Compiled<'source>, Vec<Diagnostic>> {
    let erased = if name.ends_with(".ts") {
        Some(erase_types(source, name)?)
    } else {
        None
    };
    let intermediate = erased.as_ref().map_or(source, |(code, _)| code.as_str());
    let mut compiled = Compiled {
        artifacts: Vec::new(),
        diagnostics: Vec::new(),
    };
    let output_name =
        js_name(name).map_err(|error| vec![Diagnostic::io(name, error.to_string())])?;
    let erased_lookup = erased.as_ref().map(|(_, map)| map.generate_lookup_table());
    for (target, generate) in [
        ("client", GenerateMode::Client),
        ("server", GenerateMode::Server),
    ] {
        let result = compile_module(
            intermediate,
            ModuleCompileOptions {
                generate,
                filename: Some(name.into()),
                ..ModuleCompileOptions::default()
            },
        )
        .map_err(|error| {
            let raw = error.diagnostic();
            let mut diagnostic = Diagnostic::new(
                name,
                intermediate,
                "error",
                raw.code.unwrap_or_else(|| "compile-error".into()),
                raw.message,
                raw.span,
            );
            if let Some((_, map)) = &erased {
                diagnostic.remap(source, intermediate, map);
            }
            vec![diagnostic]
        })?;
        for warning in result.warnings {
            let pos = |p: rsvelte_core::compiler::Position| Position {
                line: p.line as u32,
                column: p.column as u32,
            };
            let start = warning.start.and_then(|p| byte_at(intermediate, pos(p)));
            let end = warning.end.and_then(|p| byte_at(intermediate, pos(p)));
            let mut diagnostic = Diagnostic::new(
                name,
                intermediate,
                "warning",
                warning.code,
                warning.message,
                start.zip(end),
            );
            if let Some((_, map)) = &erased {
                diagnostic.remap(source, intermediate, map);
            }
            compiled.diagnostics.push(diagnostic);
        }
        let output = format!("{target}/{output_name}");
        let map = (|| -> Result<String> {
            let raw = result
                .js
                .map
                .as_deref()
                .context("rune compiler did not emit a source map")?;
            let mut map = SourceMap::from_json_string(raw)?;
            if map.get_sources().len() > 1 {
                bail!("rune compiler emitted more than one map source")
            }
            if let Some((_, input)) = &erased {
                // Oxc and rsvelte share source-map v8. Compose coordinates in
                // place, borrowing the erasure map instead of cloning it twice.
                let lookup = erased_lookup.as_ref().unwrap();
                let mut parts = map.into_parts();
                for token in &mut parts.tokens {
                    let original = token
                        .get_source_id()
                        .and_then(|_| {
                            input.lookup_token_approx(
                                lookup,
                                token.get_src_line(),
                                token.get_src_col(),
                            )
                        })
                        .filter(|token| token.get_source_id().is_some());
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
                        Token::new(token.get_dst_line(), token.get_dst_col(), 0, 0, None, None)
                    };
                }
                parts.names = input.get_names().map(Cow::Borrowed).collect();
                parts.sources = input.get_sources().map(Cow::Borrowed).collect();
                parts.source_contents = input
                    .get_source_contents()
                    .map(|text| text.map(Cow::Borrowed))
                    .collect();
                parts.token_chunks = None;
                map = SourceMap::from_parts(parts);
            }
            map.set_sources([name]);
            map.set_source_contents(vec![Some(source)]);
            map.set_file(&output);
            Ok(map.to_json_string())
        })()
        .map_err(|error| vec![Diagnostic::io(name, format!("source map: {error:#}"))])?;
        push_code(&mut compiled.artifacts, output, result.js.code, map);
    }
    compiled
        .artifacts
        .push((format!("check/{name}"), source.into()));
    compiled.artifacts.push((
        format!("facts/{name}.json"),
        json!({"kind": "module", "runes": true, "typescript": erased.is_some()})
            .to_string()
            .into(),
    ));
    Ok(compiled)
}

pub fn compile_source<'source>(
    engine: &Engine,
    source: &'source str,
    name: &str,
) -> std::result::Result<Compiled<'source>, Vec<Diagnostic>> {
    if name.ends_with(".svelte") {
        component(engine, source, name)
    } else if name.ends_with(".svelte.ts") || name.ends_with(".svelte.js") {
        module(source, name)
    } else {
        Ok(Compiled {
            artifacts: ["client", "server", "check"]
                .into_iter()
                .map(|target| (format!("{target}/{name}"), Cow::Borrowed(source)))
                .collect(),
            diagnostics: Vec::new(),
        })
    }
}

pub fn run(manifest_path: &Path, out_dir: &Path) -> Result<bool> {
    let manifest: Manifest = serde_json::from_str(
        &fs::read_to_string(manifest_path)
            .with_context(|| format!("reading {}", manifest_path.display()))?,
    )
    .with_context(|| format!("parsing {}", manifest_path.display()))?;
    for input in &manifest.files {
        validate_name(&input.name)?;
    }
    reserve_outputs(manifest.files.iter().map(|input| input.name.as_str()))?;
    fs::create_dir_all(out_dir)?;
    let engine = Engine::new();
    let mut diagnostics = Vec::new();
    let mut files = Vec::new();
    for input in manifest.files {
        let source = fs::read_to_string(&input.source);
        let compiled = match &source {
            Ok(source) => compile_source(&engine, source, &input.name),
            Err(error) => Err(vec![Diagnostic::io(
                &input.name,
                format!("reading {}: {error}", input.source),
            )]),
        };
        match compiled {
            Ok(compiled) => {
                let mut artifacts = Vec::new();
                for (name, content) in compiled.artifacts {
                    let output = out_dir.join(&name);
                    fs::create_dir_all(output.parent().unwrap())?;
                    fs::write(&output, content.as_bytes())
                        .with_context(|| format!("writing {}", output.display()))?;
                    artifacts.push(name);
                }
                diagnostics.extend(compiled.diagnostics);
                files.push(
                    json!({"name": input.name, "source": input.source, "artifacts": artifacts}),
                );
            }
            Err(errors) => diagnostics.extend(errors),
        }
    }
    let success = !diagnostics.iter().any(|d| d.severity == "error");
    let report =
        json!({"schema": 1, "success": success, "files": files, "diagnostics": diagnostics});
    fs::write(
        out_dir.join("diagnostics.json"),
        serde_json::to_vec(&report["diagnostics"])?,
    )?;
    fs::write(out_dir.join("manifest.json"), serde_json::to_vec(&report)?)?;
    crate::print_json(&report)?;
    Ok(success)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact<'a>(compiled: &'a Compiled<'_>, name: &str) -> &'a str {
        &compiled
            .artifacts
            .iter()
            .find(|(path, _)| path == name)
            .unwrap()
            .1
    }

    #[test]
    fn malformed_component_reports_source_range_without_artifacts() {
        let source = "<script lang=\"ts\">\nlet count = $state(0);\n</script>\n{#if count}<p>missing close</p>";
        let diagnostics = compile_source(&Engine::new(), source, "Broken.svelte")
            .err()
            .unwrap();
        assert!(diagnostics.iter().any(|d| d.severity == "error"
            && d.path == "Broken.svelte"
            && d.start.is_some()
            && d.location.is_some()));
    }

    #[test]
    fn projection_preserves_prop_contract_and_exact_source_coordinates() {
        let source = "<script lang=\"ts\">\nlet { value = 1 }: { value?: number } = $props();\n</script><p>{value}</p><style>p { color: red }</style>";
        let compiled = compile_source(&Engine::new(), source, "nested/Value.svelte")
            .unwrap_or_else(|errors| panic!("{errors:?}"));
        let facts: Value =
            serde_json::from_str(artifact(&compiled, "facts/nested/Value.svelte.json")).unwrap();
        assert_eq!(facts["projection"]["props"][0]["name"], "value");
        assert_eq!(facts["projection"]["props"][0]["optional"], true);
        let projected = artifact(&compiled, "check/nested/Value.svelte.tsx");
        let mappings = facts["projection"]["exact_mappings"].as_array().unwrap();
        let value_byte = source.find("value =").unwrap();
        let segment = mappings
            .iter()
            .find(|segment| {
                segment["source"]["start"].as_u64().unwrap() as usize <= value_byte
                    && value_byte < segment["source"]["end"].as_u64().unwrap() as usize
            })
            .unwrap();
        let src = segment["source"]["start"].as_u64().unwrap() as usize;
        let dst = segment["generated"]["start"].as_u64().unwrap() as usize;
        assert_eq!(
            &source[value_byte..value_byte + 5],
            &projected[dst + value_byte - src..dst + value_byte - src + 5]
        );
        for target in ["client", "server"] {
            let map: Value = serde_json::from_str(artifact(
                &compiled,
                &format!("{target}/nested/Value.svelte.js.map"),
            ))
            .unwrap();
            assert_eq!(map["sources"], json!(["nested/Value.svelte"]));
            assert_eq!(map["sourcesContent"], json!([source]));
            assert_eq!(map["file"], format!("{target}/nested/Value.svelte.js"));
            let css = artifact(&compiled, &format!("{target}/nested/Value.svelte.css"));
            assert!(css.contains(facts["css_scope"].as_str().unwrap()));
        }
    }

    #[test]
    fn rune_module_maps_are_composed_back_to_typescript_not_erased_javascript() {
        let source = "type Value = number;\nconst initial: Value = 42;\nlet value = $state(initial);\nexport const model = { get value() { return value; } };\n";
        let compiled = compile_source(&Engine::new(), source, "state.svelte.ts")
            .unwrap_or_else(|errors| panic!("{errors:?}"));
        let source_line =
            crate::diagnostics::position(source, source.find("initial:").unwrap() as u32).line - 1;
        for target in ["client", "server"] {
            let output = format!("{target}/state.svelte.js");
            let code = artifact(&compiled, &output);
            let generated_byte = code.find("initial =").unwrap() as u32;
            let generated_position = crate::diagnostics::position(code, generated_byte);
            let map =
                SourceMap::from_json_string(artifact(&compiled, &format!("{output}.map"))).unwrap();
            let lookup = map.generate_lookup_table();
            let token = map
                .lookup_token_approx(
                    &lookup,
                    generated_position.line - 1,
                    generated_position.column,
                )
                .unwrap();
            assert_eq!(token.get_src_line(), source_line);
            assert_eq!(
                map.get_source_content(token.get_source_id().unwrap()),
                Some(source)
            );
        }
        assert_eq!(artifact(&compiled, "check/state.svelte.ts"), source);
    }

    #[test]
    fn traversal_and_cross_view_output_collisions_are_rejected_before_writing() {
        assert!(validate_name("../outside.svelte").is_err());
        assert!(validate_name("/absolute.svelte").is_err());
        assert!(validate_name("nested/../outside.svelte").is_err());
        assert!(reserve_outputs(["Widget.svelte", "Widget.svelte.ts"]).is_err());
        assert!(reserve_outputs(["Widget.svelte", "Widget.svelte.tsx"]).is_err());
    }
}
