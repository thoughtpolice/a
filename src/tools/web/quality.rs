// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Result;
use oxc::allocator::Allocator;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc_formatter::JsFormatOptions;
use oxc_linter::{
    ConfigStore, ConfigStoreBuilder, ContextSubHost, ContextSubHostOptions, ExternalPluginStore,
    LintOptions, Linter, ModuleRecord, Oxlintrc,
};
use rsvelte::{ComponentOptions, Engine};
use rsvelte_formatter::{
    CssFormatOptions, FormatOptions, LineWidth, css_variant_from_lang, format_css_source,
};
use serde_json::{Value, json};

use crate::diagnostics::{Diagnostic, Position, byte_at};
use crate::inspect::source_type;

// An explicit, stable subset of recommended correctness rules, independent of
// any target-platform lint policy and without a JS plugin host.
const OXC_RULES: &[&str] = &[
    "constructor-super",
    "no-debugger",
    "no-dupe-class-members",
    "no-dupe-keys",
    "no-duplicate-case",
    "no-func-assign",
    "no-import-assign",
    "no-setter-return",
    "no-this-before-super",
    "no-unreachable",
    "no-unsafe-finally",
    "valid-typeof",
];

fn oxc_linter() -> Result<Linter> {
    let mut rules = serde_json::Map::new();
    for rule in OXC_RULES {
        rules.insert((*rule).into(), json!("error"));
    }
    let config: Oxlintrc =
        serde_json::from_value(json!({"plugins": [], "categories": {}, "rules": rules}))?;
    let mut plugins = ExternalPluginStore::default();
    let config = ConfigStoreBuilder::from_oxlintrc(true, config, None, &mut plugins, None)?
        .build(&mut plugins)?;
    Ok(Linter::new(
        LintOptions::default(),
        ConfigStore::new(config, Default::default(), plugins),
        None,
    ))
}

fn lint_js(linter: &Linter, path: &Path, source: &str) -> Vec<Diagnostic> {
    let name = path.to_string_lossy();
    let source_type = match source_type(path) {
        Ok(source_type) => source_type,
        Err(error) => return vec![Diagnostic::io(&name, error)],
    };
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if !parsed.diagnostics.is_empty() {
        return parsed
            .diagnostics
            .iter()
            .map(|d| Diagnostic::oxc(&name, source, d, 0))
            .collect();
    }
    let semantic = SemanticBuilder::new_linter().build(&parsed.program);
    if !semantic.diagnostics.is_empty() {
        return semantic
            .diagnostics
            .iter()
            .map(|d| Diagnostic::oxc(&name, source, d, 0))
            .collect();
    }
    let record = Arc::new(ModuleRecord::new(
        path,
        &parsed.module_record,
        &semantic.semantic,
    ));
    let host = ContextSubHost::new(
        semantic.semantic,
        record,
        0,
        ContextSubHostOptions::default(),
    );
    linter
        .run(path, vec![host], &allocator)
        .into_iter()
        .map(|message| Diagnostic::oxc(&name, source, &message.error, 0))
        .collect()
}

fn lint_svelte(path: &Path, source: &str) -> Vec<Diagnostic> {
    let name = path.to_string_lossy();
    let options = rsvelte_core::CompileOptions {
        filename: Some(name.to_string()),
        ..Default::default()
    };
    rsvelte_lint::lint_source(
        source,
        path,
        &options,
        &rsvelte_lint::LintConfig::recommended(),
    )
    .into_iter()
    .map(|diagnostic| {
        let span = diagnostic.range.and_then(|range| {
            byte_at(
                source,
                Position {
                    line: range.start.line,
                    column: range.start.column,
                },
            )
            .zip(byte_at(
                source,
                Position {
                    line: range.end.line,
                    column: range.end.column,
                },
            ))
        });
        Diagnostic::new(
            &name,
            source,
            diagnostic.severity.label(),
            diagnostic.code.unwrap_or_else(|| "svelte-lint".into()),
            diagnostic.message,
            span,
        )
    })
    .collect()
}

pub fn lint(paths: &[PathBuf], deny_warnings: bool) -> Result<bool> {
    let linter = oxc_linter()?;
    let mut files = Vec::with_capacity(paths.len());
    let mut success = true;
    for path in paths {
        let name = path.to_string_lossy();
        let diagnostics = match fs::read_to_string(path) {
            Ok(source) if name.ends_with(".svelte") => lint_svelte(path, &source),
            Ok(source) if name.ends_with(".svelte.ts") || name.ends_with(".svelte.js") => {
                let mut diagnostics = lint_svelte(path, &source);
                diagnostics.extend(lint_js(&linter, path, &source));
                diagnostics
            }
            Ok(source) => lint_js(&linter, path, &source),
            Err(error) => vec![Diagnostic::io(&name, error.to_string())],
        };
        success &= !diagnostics
            .iter()
            .any(|d| d.severity == "error" || (deny_warnings && d.severity == "warning"));
        files.push(json!({"path": name, "diagnostics": diagnostics}));
    }
    crate::print_json(&json!({"files": files, "success": success}))?;
    Ok(success)
}

pub fn format_source(path: &Path, source: &str) -> std::result::Result<String, Vec<Diagnostic>> {
    let name = path.to_string_lossy();
    if name.ends_with(".svelte") {
        let style_formatter = Arc::new(|body: &str, lang: &str, width: usize| {
            if !matches!(
                lang.to_ascii_lowercase().as_str(),
                "css" | "postcss" | "scss" | "less"
            ) {
                return Err(format!(
                    "unsupported style language {lang:?}; native formatting supports CSS, PostCSS, SCSS and Less"
                ));
            }
            let options = CssFormatOptions {
                line_width: LineWidth::try_from(u16::try_from(width).unwrap_or(u16::MAX))
                    .unwrap_or_default(),
                ..CssFormatOptions::default()
            };
            format_css_source(body, css_variant_from_lang(lang), &options)
                .map_err(|error| error.to_string())
        });
        let options = FormatOptions::new().with_style_formatter(style_formatter);
        return rsvelte_formatter::format(source, &options).map_err(|error| {
            let mut diagnostic = Diagnostic::new(
                &name,
                source,
                "error",
                "format-error",
                error.to_string(),
                None,
            );
            // The formatter erases its parser's typed error. Recover a source
            // location from the original compiler only on this failure path.
            if let Err(failure) =
                Engine::new().prepare(source, ComponentOptions::new().filename(name.as_ref()))
            {
                diagnostic.start = failure.diagnostic.span.map(|span| span.start());
                diagnostic.end = failure.diagnostic.span.map(|span| span.end());
                diagnostic.location = diagnostic
                    .start
                    .map(|byte| crate::diagnostics::position(source, byte));
                diagnostic.end_location = diagnostic
                    .end
                    .map(|byte| crate::diagnostics::position(source, byte));
            }
            vec![diagnostic]
        });
    }
    let source_type = source_type(path).map_err(|error| vec![Diagnostic::io(&name, error)])?;
    let allocator = Allocator::default();
    let formatted =
        oxc_formatter::format(&allocator, source, source_type, JsFormatOptions::default())
            .map_err(|error| vec![Diagnostic::oxc(&name, source, &error, 0)])?;
    formatted
        .print()
        .map(|printed| printed.into_code())
        .map_err(|error| {
            vec![Diagnostic::new(
                &name,
                source,
                "error",
                "format-error",
                error.to_string(),
                None,
            )]
        })
}

pub fn format(paths: &[PathBuf], check: bool, write: bool) -> Result<bool> {
    let mut files = Vec::with_capacity(paths.len());
    let mut success = true;
    for path in paths {
        let name = path.to_string_lossy();
        let result = fs::read_to_string(path)
            .map_err(|error| vec![Diagnostic::io(&name, error.to_string())])
            .and_then(|source| format_source(path, &source).map(|formatted| (source, formatted)));
        let file: Value = match result {
            Ok((source, formatted)) => {
                let changed = source != formatted;
                if check && changed {
                    success = false;
                }
                let mut diagnostics = Vec::new();
                if write && changed {
                    if let Err(error) = fs::write(path, &formatted) {
                        success = false;
                        diagnostics.push(Diagnostic::io(&name, error.to_string()));
                    }
                }
                let mut file =
                    json!({"path": name, "changed": changed, "diagnostics": diagnostics});
                if !check && !write {
                    file["code"] = json!(formatted);
                }
                file
            }
            Err(diagnostics) => {
                success = false;
                json!({"path": name, "diagnostics": diagnostics})
            }
        };
        files.push(file);
    }
    crate::print_json(&json!({"files": files, "success": success}))?;
    Ok(success)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_typescript_is_not_formatted_into_valid_code() {
        let errors = format_source(Path::new("broken.ts"), "export const value: = 1;").unwrap_err();
        assert!(
            errors
                .iter()
                .any(|error| error.severity == "error" && error.start.is_some())
        );
    }

    #[test]
    fn formatting_preserves_type_imports_and_assertions_and_reaches_a_fixed_point() {
        let source = "// retain this\nimport type{Config}from './types.ts';\nimport data from './data.json' with {type:'json'};\nexport const value:Config=data;";
        let formatted = format_source(Path::new("config.ts"), source).unwrap();
        let inspected = crate::inspect::inspect_source("config.ts", &formatted);
        assert_eq!(inspected["imports"][0]["kind"], "type");
        assert_eq!(
            inspected["imports"][1]["attributes"]["raw"]
                .as_str()
                .unwrap()
                .contains("json"),
            true
        );
        assert!(formatted.contains("// retain this"));
        assert_eq!(
            format_source(Path::new("config.ts"), &formatted).unwrap(),
            formatted
        );
    }

    #[test]
    fn svelte_formatter_formats_embedded_css_and_is_idempotent() {
        let source = "<script lang='ts'>let color:string='red';</script><div style:color>Hi</div><style>div{padding:0;margin:1px}</style>";
        let formatted = format_source(Path::new("Color.svelte"), source).unwrap();
        assert!(formatted.contains("padding: 0;"));
        assert!(formatted.contains("margin: 1px;"));
        assert_eq!(
            format_source(Path::new("Color.svelte"), &formatted).unwrap(),
            formatted
        );
    }

    #[test]
    fn native_oxc_rules_reject_unreachable_code() {
        let diagnostics = lint_js(
            &oxc_linter().unwrap(),
            Path::new("unreachable.ts"),
            "export function run() { return 1; throw new Error('unreachable'); }",
        );
        assert!(
            diagnostics
                .iter()
                .any(|d| d.code.contains("no-unreachable") && d.start.is_some())
        );
    }
}
