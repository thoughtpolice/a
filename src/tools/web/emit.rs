// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io::{BufWriter, Write as _};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use oxc::allocator::Allocator;
use oxc::ast::{ast::*, builder::AstBuilder};
use oxc::ast_visit::{VisitMut, walk_mut};
use oxc::codegen::{Codegen, CodegenOptions, CommentOptions, LegalComment};
use oxc::isolated_declarations::{IsolatedDeclarations, IsolatedDeclarationsOptions};
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};
use oxc_sourcemap::{SourceMap, Token};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    modules: Vec<Module>,
    declarations: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Module {
    input: PathBuf,
    output: PathBuf,
    rewrites: BTreeMap<String, String>,
}

struct Rewriter<'a, 'm> {
    allocator: &'a Allocator,
    rewrites: &'m BTreeMap<String, String>,
    unsupported: bool,
}

impl<'a> Rewriter<'a, '_> {
    fn literal(&self, literal: &mut StringLiteral<'a>) {
        if let Some(value) = self.rewrites.get(literal.value.as_str()) {
            literal.value = self.allocator.alloc_str(value).into();
            // A changed value must never be printed using the authored raw token.
            literal.raw = None;
        }
    }
}

impl<'a> VisitMut<'a> for Rewriter<'a, '_> {
    fn visit_import_declaration(&mut self, node: &mut ImportDeclaration<'a>) {
        self.literal(&mut node.source);
        self.unsupported |= node.phase.is_some();
        walk_mut::walk_import_declaration(self, node);
    }

    fn visit_export_from_declaration(&mut self, node: &mut ExportFromDeclaration<'a>) {
        self.literal(&mut node.source);
        walk_mut::walk_export_from_declaration(self, node);
    }

    fn visit_export_all_declaration(&mut self, node: &mut ExportAllDeclaration<'a>) {
        self.literal(&mut node.source);
        walk_mut::walk_export_all_declaration(self, node);
    }

    fn visit_import_expression(&mut self, node: &mut ImportExpression<'a>) {
        self.unsupported |= node.phase.is_some();
        match node.source.get_inner_expression_mut() {
            Expression::StringLiteral(literal) => self.literal(literal),
            Expression::TemplateLiteral(literal) if literal.expressions.is_empty() => {
                if let Some(value) = literal.quasis.first().and_then(|q| q.value.cooked.as_ref())
                    && let Some(rewritten) = self.rewrites.get(value.as_str())
                {
                    node.source = Expression::new_string_literal(
                        literal.span,
                        self.allocator.alloc_str(rewritten),
                        None,
                        &AstBuilder::new(self.allocator),
                    );
                }
            }
            // Computed imports cannot be relocated or dependency-validated.
            _ => self.unsupported = true,
        }
        walk_mut::walk_import_expression(self, node);
    }

    fn visit_ts_import_type(&mut self, node: &mut TSImportType<'a>) {
        self.literal(&mut node.source);
        walk_mut::walk_ts_import_type(self, node);
    }

    fn visit_ts_external_module_declaration(&mut self, node: &mut TSExternalModuleDeclaration<'a>) {
        self.literal(&mut node.id);
        walk_mut::walk_ts_external_module_declaration(self, node);
    }

    fn visit_ts_import_equals_declaration(&mut self, node: &mut TSImportEqualsDeclaration<'a>) {
        if let TSModuleReference::ExternalModuleReference(reference) = &mut node.module_reference {
            self.literal(&mut reference.expression);
            // Type-only imports erase cleanly; value require() is not an ESM ABI.
            self.unsupported |= node.import_kind != ImportOrExportKind::Type;
        }
        walk_mut::walk_ts_import_equals_declaration(self, node);
    }

    fn visit_ts_export_assignment(&mut self, _node: &mut TSExportAssignment<'a>) {
        self.unsupported = true;
    }

    fn visit_decorator(&mut self, _node: &mut Decorator<'a>) {
        self.unsupported = true;
    }
}

fn bounded(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || path.to_string_lossy().contains('\\')
    {
        bail!(
            "output must be a nonempty package-relative path: {}",
            path.display()
        );
    }
    Ok(())
}

fn url_name(name: &std::ffi::OsStr) -> String {
    let bytes = name.as_encoded_bytes();
    let mut value = String::with_capacity(bytes.len());
    for &byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            value.push(byte as char);
        } else {
            write!(value, "%{byte:02X}").unwrap();
        }
    }
    value
}

fn write_output(root: &Path, relative: &Path, parts: &[&str]) -> Result<()> {
    bounded(relative)?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&current)
            && metadata.file_type().is_symlink()
        {
            bail!("refusing symlink output {}", current.display());
        }
    }
    fs::create_dir_all(current.parent().context("output parent")?)?;
    let mut file = BufWriter::new(
        fs::File::create(&current).with_context(|| format!("writing {}", current.display()))?,
    );
    for part in parts {
        file.write_all(part.as_bytes())?;
    }
    file.flush()?;
    Ok(())
}

pub fn run(manifest: &Path, out_dir: &Path) -> Result<bool> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest)?)?;
    if out_dir
        .ancestors()
        .any(|path| fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()))
    {
        bail!("output directory ancestors must not be symlinks");
    }
    fs::create_dir_all(out_dir)?;
    let mut outputs = BTreeSet::new();
    for module in &manifest.modules {
        bounded(&module.output)?;
        let extension = module
            .input
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if !matches!(extension, "js" | "mjs" | "ts" | "mts") {
            bail!(
                "ESM distribution supports .js/.mjs/.ts/.mts only: {}",
                module.input.display()
            );
        }
        if module.input.file_name().is_some_and(|name| {
            name.to_string_lossy().ends_with(".d.ts") || name.to_string_lossy().ends_with(".d.mts")
        }) {
            bail!("declaration files are not executable source modules");
        }
        if !matches!(
            module.output.extension().and_then(|e| e.to_str()),
            Some("js" | "mjs")
        ) {
            bail!("emitted module must have a .js or .mjs output extension");
        }
        for output in [
            module.output.clone(),
            PathBuf::from(format!("{}.map", module.output.display())),
        ] {
            if !outputs.insert(output) {
                bail!("colliding package outputs");
            }
        }
        if manifest.declarations && matches!(extension, "ts" | "mts") {
            let declaration = module.output.with_extension(
                if module.output.extension().is_some_and(|e| e == "mjs") {
                    "d.mts"
                } else {
                    "d.ts"
                },
            );
            if !outputs.insert(declaration) {
                bail!("colliding declaration outputs");
            }
        }
    }
    for module in manifest.modules {
        let source = fs::read_to_string(&module.input)?;
        let allocator = Allocator::default();
        let source_type =
            SourceType::from_path(&module.input).map_err(|e| anyhow::anyhow!("{e}"))?;
        let parsed = Parser::new(&allocator, &source, source_type).parse();
        if !parsed.diagnostics.is_empty() {
            bail!(
                "{}: parse errors: {:?}",
                module.input.display(),
                parsed.diagnostics
            );
        }
        let mut program = parsed.program;
        let mut rewriter = Rewriter {
            allocator: &allocator,
            rewrites: &module.rewrites,
            unsupported: false,
        };
        rewriter.visit_program(&mut program);
        if rewriter.unsupported {
            bail!(
                "{}: distribution does not support computed imports, decorators, phased imports or CommonJS TypeScript declarations",
                module.input.display()
            );
        }
        let checked = SemanticBuilder::new()
            .with_check_syntax_error(true)
            .with_enum_eval(true)
            .build(&program);
        if !checked.diagnostics.is_empty() {
            bail!(
                "{}: invalid module: {:?}",
                module.input.display(),
                checked.diagnostics
            );
        }
        if checked
            .semantic
            .scoping()
            .root_unresolved_references()
            .keys()
            .any(|name| {
                matches!(
                    name.as_str(),
                    "require" | "module" | "exports" | "__dirname" | "__filename"
                )
            })
        {
            bail!(
                "{}: CommonJS globals are unsupported in ESM distribution",
                module.input.display()
            );
        }
        let comments = CommentOptions {
            legal: LegalComment::Inline,
            ..CommentOptions::default()
        };
        if manifest.declarations && source_type.is_typescript() {
            let declaration = IsolatedDeclarations::new(
                &allocator,
                IsolatedDeclarationsOptions {
                    strip_internal: false,
                },
            )
            .build(&program);
            if !declaration.diagnostics.is_empty() {
                bail!(
                    "{}: isolated declarations require explicit export annotations: {:?}",
                    module.input.display(),
                    declaration.diagnostics
                );
            }
            let declaration_path = module.output.with_extension(
                if module.output.extension().is_some_and(|e| e == "mjs") {
                    "d.mts"
                } else {
                    "d.ts"
                },
            );
            let code = Codegen::new()
                .with_options(CodegenOptions {
                    comments: comments.clone(),
                    ..CodegenOptions::default()
                })
                .build(&declaration.program)
                .code;
            // Every emitted declaration describes an ESM module, including an
            // import.meta-only source whose indicator isolated emission erases.
            write_output(out_dir, &declaration_path, &[&code, "\nexport {};\n"])?;
        }
        let mut options = TransformOptions::default();
        // An authored value import must still execute when only types use its binding.
        options.typescript.only_remove_type_imports = true;
        let transformed = Transformer::new(&allocator, &module.input, &options)
            .build_with_scoping(checked.semantic.into_scoping(), &mut program);
        if !transformed.diagnostics.is_empty() {
            bail!(
                "{}: transform errors: {:?}",
                module.input.display(),
                transformed.diagnostics
            );
        }
        #[allow(deprecated)]
        let requires_helpers = !transformed.helpers_used.is_empty();
        if requires_helpers {
            bail!(
                "{}: this syntax requires an undeclared transformer helper runtime and is unsupported in unbundled distribution",
                module.input.display()
            );
        }
        let authored_name = PathBuf::from(url_name(
            module.input.file_name().context("source basename")?,
        ));
        let generated = Codegen::new()
            .with_options(CodegenOptions {
                comments,
                source_map_path: Some(authored_name),
                ..CodegenOptions::default()
            })
            .with_scoping(Some(transformed.scoping))
            .build(&program);
        // Reparse the emitted ESM: unsupported parser proposals must never escape
        // as JavaScript that a normal ESM consumer cannot even parse.
        let emitted = Parser::new(&allocator, &generated.code, SourceType::mjs()).parse();
        if !emitted.diagnostics.is_empty() {
            bail!(
                "{}: emitted JavaScript is invalid: {:?}",
                module.input.display(),
                emitted.diagnostics
            );
        }
        let mut map = generated
            .map
            .context("emitter did not produce authored source map")?;
        let types_header = if manifest.declarations && source_type.is_typescript() {
            let declaration = module.output.with_extension(
                if module.output.extension().is_some_and(|e| e == "mjs") {
                    "d.mts"
                } else {
                    "d.ts"
                },
            );
            let name = url_name(declaration.file_name().context("declaration basename")?);
            let mut parts = map.into_parts();
            for token in &mut parts.tokens {
                let line = token.get_dst_line();
                let shift = u32::from(line >= u32::from(program.hashbang.is_some()));
                *token = Token::new(
                    line + shift,
                    token.get_dst_col(),
                    token.get_src_line(),
                    token.get_src_col(),
                    token.get_source_id(),
                    token.get_name_id(),
                );
            }
            parts.token_chunks = None;
            map = SourceMap::from_parts(parts);
            format!("// @ts-self-types=\"./{name}\"\n")
        } else {
            String::new()
        };
        let map_path = PathBuf::from(format!("{}.map", module.output.display()));
        write_output(out_dir, &map_path, &[&map.to_json_string()])?;
        let map_url = url_name(map_path.file_name().context("map basename")?);
        let (leading, code) = if !types_header.is_empty() && generated.code.starts_with("#!") {
            let end = generated
                .code
                .find('\n')
                .context("hashbang requires a newline")?
                + 1;
            generated.code.split_at(end)
        } else {
            ("", generated.code.as_str())
        };
        write_output(
            out_dir,
            &module.output,
            &[
                leading,
                &types_header,
                code,
                "\n//# sourceMappingURL=",
                &map_url,
                "\n",
            ],
        )?;
    }
    crate::print_json(&serde_json::json!({"success": true}))?;
    Ok(true)
}
