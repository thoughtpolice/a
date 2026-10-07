// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc::ast_visit::{Visit, walk};
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::{GetSpan, SourceType, Span};
use rsvelte::{ComponentOptions, Engine, ProjectionOptions};
use serde_json::{Value, json};

use crate::diagnostics::Diagnostic;

pub fn source_type(path: &Path) -> std::result::Result<SourceType, String> {
    SourceType::from_path(path)
        .map_err(|error| format!("unsupported source path {}: {error}", path.display()))
}

#[derive(Default)]
struct Inspection {
    imports: Vec<Value>,
    computed_imports: Vec<Value>,
    comments: Vec<Value>,
    references: Vec<Value>,
    self_types: Option<String>,
    diagnostics: Vec<Diagnostic>,
}

struct Imports<'result, 'source> {
    result: &'result mut Inspection,
    source: &'source str,
    offset: u32,
    // Projection-generated helpers are not source dependencies. Only byte-exact
    // source regions are inspected when looking for template dynamic imports.
    projection: Option<&'source rsvelte::ProjectionMap>,
    dynamic_only: bool,
    external_module: bool,
}

impl Imports<'_, '_> {
    fn span(&self, span: Span) -> Option<(u32, u32)> {
        if let Some(map) = self.projection {
            let span = rsvelte::ByteRange::new(span.start, span.end)?;
            let mapped = map.generated_range_to_source(span)?;
            Some((mapped.start(), mapped.end()))
        } else {
            Some((span.start + self.offset, span.end + self.offset))
        }
    }

    fn import(
        &mut self,
        value: &str,
        span: Span,
        kind: &str,
        dynamic: bool,
        attributes: Option<Span>,
    ) {
        let Some((start, end)) = self.span(span) else {
            return;
        };
        let mut import = json!({"specifier": value, "kind": kind, "dynamic": dynamic, "start": start, "end": end});
        if let Some(attributes) = attributes {
            import["attributes"] = json!({"raw": &self.source[attributes.start as usize..attributes.end as usize],
                "start": attributes.start + self.offset, "end": attributes.end + self.offset});
        }
        self.result.imports.push(import);
    }
}

#[derive(Default)]
struct ImportMetaIndicator(bool);

impl<'a> Visit<'a> for ImportMetaIndicator {
    fn visit_import_meta(&mut self, _: &ImportMeta) {
        self.0 = true;
    }
}

impl<'a> Visit<'a> for Imports<'_, '_> {
    fn visit_program(&mut self, node: &Program<'a>) {
        // External modules need top-level imports/exports or import.meta;
        // SourceType::ts()/d.ts() alone cannot distinguish augmentations from
        // ambient modules. Nested ambient exports are not module indicators.
        self.external_module = node.body.iter().any(|statement| match statement {
            Statement::ImportDeclaration(_)
            | Statement::ExportAllDeclaration(_)
            | Statement::ExportDefaultDeclaration(_)
            | Statement::ExportDeclaration(_)
            | Statement::ExportNamedDeclaration(_)
            | Statement::ExportFromDeclaration(_)
            | Statement::TSExportAssignment(_) => true,
            Statement::TSImportEqualsDeclaration(import) => {
                matches!(
                    &import.module_reference,
                    TSModuleReference::ExternalModuleReference(_)
                )
            }
            _ => false,
        });
        if !self.external_module {
            let mut indicator = ImportMetaIndicator::default();
            indicator.visit_program(node);
            self.external_module = indicator.0;
        }
        walk::walk_program(self, node);
    }

    fn visit_ts_external_module_declaration(&mut self, node: &TSExternalModuleDeclaration<'a>) {
        if !self.dynamic_only && self.external_module {
            self.import(node.id.value.as_str(), node.id.span, "type", false, None);
        }
        walk::walk_ts_external_module_declaration(self, node);
    }

    fn visit_import_expression(&mut self, node: &ImportExpression<'a>) {
        let first_import = self.result.imports.len();
        let first_computed = self.result.computed_imports.len();
        match node.source.get_inner_expression() {
            Expression::StringLiteral(literal) => self.import(
                literal.value.as_str(),
                literal.span,
                "code",
                true,
                node.options.as_ref().map(GetSpan::span),
            ),
            Expression::TemplateLiteral(literal) if literal.expressions.is_empty() => {
                if let Some(value) = literal
                    .quasis
                    .first()
                    .and_then(|quasi| quasi.value.cooked.as_ref())
                {
                    self.import(
                        value.as_str(),
                        literal.span,
                        "code",
                        true,
                        node.options.as_ref().map(GetSpan::span),
                    );
                }
            }
            expression => {
                if let Some((start, end)) = self.span(expression.span()) {
                    self.result.computed_imports.push(json!({"start": start, "end": end, "dynamic": true,
                        "expression": &self.source[expression.span().start as usize..expression.span().end as usize]}));
                }
            }
        }
        if let Some(phase) = node.phase {
            for import in self.result.imports[first_import..]
                .iter_mut()
                .chain(self.result.computed_imports[first_computed..].iter_mut())
            {
                import["phase"] = json!(match phase {
                    ImportPhase::Source => "source",
                    ImportPhase::Defer => "defer",
                });
            }
        }
        walk::walk_import_expression(self, node);
    }

    fn visit_ts_import_type(&mut self, node: &TSImportType<'a>) {
        if !self.dynamic_only {
            self.import(
                node.source.value.as_str(),
                node.source.span,
                "type",
                false,
                node.options.as_ref().map(|options| options.span),
            );
        }
        walk::walk_ts_import_type(self, node);
    }

    fn visit_ts_import_equals_declaration(&mut self, node: &TSImportEqualsDeclaration<'a>) {
        if !self.dynamic_only {
            if let TSModuleReference::ExternalModuleReference(reference) = &node.module_reference {
                self.import(
                    reference.expression.value.as_str(),
                    reference.expression.span,
                    if node.import_kind == ImportOrExportKind::Type {
                        "type"
                    } else {
                        "code"
                    },
                    false,
                    None,
                );
            }
        }
        walk::walk_ts_import_equals_declaration(self, node);
    }

    fn visit_import_declaration(&mut self, node: &ImportDeclaration<'a>) {
        if !self.dynamic_only {
            if let Some(phase) = node.phase {
                let start = node.source.span.start + self.offset;
                for import in &mut self.result.imports {
                    if import["start"].as_u64() == Some(start as u64) {
                        import["phase"] = json!(match phase {
                            ImportPhase::Source => "source",
                            ImportPhase::Defer => "defer",
                        });
                    }
                }
            }
            if let Some(clause) = &node.with_clause {
                self.attributes(node.source.span, clause);
            }
        }
        walk::walk_import_declaration(self, node);
    }

    fn visit_export_from_declaration(&mut self, node: &ExportFromDeclaration<'a>) {
        if !self.dynamic_only {
            if let Some(clause) = &node.with_clause {
                self.attributes(node.source.span, clause);
            }
        }
        walk::walk_export_from_declaration(self, node);
    }

    fn visit_export_all_declaration(&mut self, node: &ExportAllDeclaration<'a>) {
        if !self.dynamic_only {
            if let Some(clause) = &node.with_clause {
                self.attributes(node.source.span, clause);
            }
        }
        walk::walk_export_all_declaration(self, node);
    }
}

impl Imports<'_, '_> {
    fn attributes(&mut self, literal: Span, attributes: &WithClause<'_>) {
        let start = literal.start + self.offset;
        let values: serde_json::Map<String, Value> = attributes
            .with_entries
            .iter()
            .map(|entry| {
                let key = match &entry.key {
                    ImportAttributeKey::Identifier(identifier) => identifier.name.as_str(),
                    ImportAttributeKey::StringLiteral(literal) => literal.value.as_str(),
                };
                (key.to_owned(), json!(entry.value.value.as_str()))
            })
            .collect();
        for import in &mut self.result.imports {
            if import["start"].as_u64() == Some(start as u64) {
                import["attributes"] = json!({"raw": &self.source[attributes.span.start as usize..attributes.span.end as usize],
                    "start": attributes.span.start + self.offset, "end": attributes.span.end + self.offset,
                    "values": values});
            }
        }
    }
}

// Comment directives are read from parser-produced comments, never from strings
// or regex matches in code. Attribute scanning is limited to the directive text.
fn quoted_attribute<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let bytes = text.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if !(bytes[cursor].is_ascii_alphanumeric() || matches!(bytes[cursor], b'_' | b'-' | b'@')) {
            cursor += 1;
            continue;
        }
        let begin = cursor;
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric()
                || matches!(bytes[cursor], b'_' | b'-' | b'@'))
        {
            cursor += 1;
        }
        let name = &text[begin..cursor];
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if bytes.get(cursor) != Some(&b'=') {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let quote = *bytes.get(cursor)?;
        if !matches!(quote, b'\'' | b'"') {
            continue;
        }
        cursor += 1;
        let begin = cursor;
        while cursor < bytes.len() && bytes[cursor] != quote {
            cursor += 1;
        }
        if cursor == bytes.len() {
            return None;
        }
        let value = &text[begin..cursor];
        cursor += 1;
        if name == key {
            return Some(value);
        }
    }
    None
}

// JSDoc is comment metadata, not JavaScript code. Locate only type expressions
// and @import declarations, then let Oxc parse their module literals (including
// escapes) rather than interpreting import-like text with a source regex.
fn inspect_jsdoc(result: &mut Inspection, content: &str, offset: u32) {
    let bytes = content.as_bytes();
    let mut cursor = 0;
    let mut braces = 0usize;
    let mut typed_tag = false;
    while cursor < bytes.len() {
        if bytes[cursor] == b'@' {
            let end = content[cursor + 1..]
                .find(|character: char| !character.is_ascii_alphabetic())
                .map_or(bytes.len(), |length| cursor + 1 + length);
            typed_tag = matches!(
                &content[cursor + 1..end],
                "type"
                    | "param"
                    | "returns"
                    | "return"
                    | "typedef"
                    | "callback"
                    | "extends"
                    | "implements"
                    | "satisfies"
                    | "this"
                    | "throws"
                    | "template"
                    | "property"
                    | "prop"
            );
            braces = 0;
        }
        if matches!(bytes[cursor], b'\'' | b'"' | b'`') {
            let delimiter = bytes[cursor];
            cursor += 1;
            while cursor < bytes.len() {
                let byte = bytes[cursor];
                cursor += 1;
                if byte == b'\\' {
                    cursor = (cursor + 1).min(bytes.len());
                } else if byte == delimiter {
                    break;
                }
            }
            continue;
        }
        match bytes[cursor] {
            b'{' => braces += 1,
            b'}' => braces = braces.saturating_sub(1),
            _ => {}
        }
        let declaration = cursor > 0 && bytes[cursor - 1] == b'@';
        if !content[cursor..].starts_with("import")
            || (!declaration && (!typed_tag || braces == 0))
            || (cursor > 0
                && (bytes[cursor - 1].is_ascii_alphanumeric() || bytes[cursor - 1] == b'_'))
            || bytes
                .get(cursor + 6)
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        {
            // Move by characters, so UTF-8 descriptions cannot split a slice.
            cursor += content[cursor..].chars().next().unwrap().len_utf8();
            continue;
        }
        let start = cursor;
        let mut end = cursor + 6;
        while bytes.get(end).is_some_and(u8::is_ascii_whitespace) {
            end += 1;
        }
        if !declaration && bytes.get(end) != Some(&b'(') {
            cursor = end;
            continue;
        }
        let mut depth = 0usize;
        let mut clause_depth = 0usize;
        let mut quote = None;
        let mut escaped = false;
        while end < bytes.len() {
            let byte = bytes[end];
            end += 1;
            if let Some(delimiter) = quote {
                if escaped {
                    escaped = false;
                } else if byte == b'\\' {
                    escaped = true;
                } else if byte == delimiter {
                    quote = None;
                    if declaration && clause_depth == 0 {
                        break;
                    }
                }
                continue;
            }
            if matches!(byte, b'\'' | b'"') {
                quote = Some(byte);
            } else if byte == b'{' {
                clause_depth += 1;
            } else if byte == b'}' {
                clause_depth = clause_depth.saturating_sub(1);
            } else if byte == b'(' {
                depth += 1;
            } else if byte == b')' {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    break;
                }
            }
        }
        if quote.is_some()
            || end == bytes.len() && !declaration && bytes.get(end.saturating_sub(1)) != Some(&b')')
        {
            cursor += 6;
            continue;
        }
        let prefix = if declaration { "" } else { "type T=" };
        let mut fragment = format!("{prefix}{};", &content[start..end]).into_bytes();
        let mut line_prefix = false;
        for byte in &mut fragment {
            if *byte == b'\n' {
                line_prefix = true;
            } else if line_prefix && *byte == b'*' {
                *byte = b' ';
                line_prefix = false;
            } else if !byte.is_ascii_whitespace() {
                line_prefix = false;
            }
        }
        let fragment = String::from_utf8(fragment).unwrap();
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, &fragment, SourceType::ts()).parse();
        if parsed.diagnostics.is_empty() {
            let mut metadata = Inspection::default();
            for (specifier, requests) in &parsed.module_record.requested_modules {
                for request in requests {
                    metadata.imports.push(json!({"specifier": specifier.as_str(), "start": request.span.start, "end": request.span.end}));
                }
            }
            Imports {
                result: &mut metadata,
                source: &fragment,
                offset: 0,
                projection: None,
                dynamic_only: false,
                external_module: false,
            }
            .visit_program(&parsed.program);
            for import in metadata.imports {
                let start = offset as u64 + start as u64 + import["start"].as_u64().unwrap()
                    - prefix.len() as u64;
                let end = offset as u64 + cursor as u64 + import["end"].as_u64().unwrap()
                    - prefix.len() as u64;
                result.references.push(json!({"specifier": import["specifier"], "kind": "jsdoc", "start": start, "end": end}));
            }
        }
        cursor = end;
    }
}

fn inspect_js(
    result: &mut Inspection,
    path: &str,
    original: &str,
    source: &str,
    source_type: SourceType,
    offset: u32,
) {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    result.diagnostics.extend(
        parsed
            .diagnostics
            .iter()
            .map(|d| Diagnostic::oxc(path, original, d, offset)),
    );
    if !parsed.diagnostics.is_empty() {
        return;
    }
    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&parsed.program);
    result.diagnostics.extend(
        semantic
            .diagnostics
            .iter()
            .map(|d| Diagnostic::oxc(path, original, d, offset)),
    );
    if !semantic.diagnostics.is_empty() {
        return;
    }
    for (specifier, requests) in &parsed.module_record.requested_modules {
        for request in requests {
            let mut has_bindings = false;
            let mut only_types = true;
            if request.is_import {
                for entry in &parsed.module_record.import_entries {
                    if entry.statement_span == request.statement_span {
                        has_bindings = true;
                        only_types &= entry.is_type;
                    }
                }
            } else {
                for entry in parsed
                    .module_record
                    .indirect_export_entries
                    .iter()
                    .chain(parsed.module_record.star_export_entries.iter())
                {
                    if entry.statement_span == request.statement_span {
                        has_bindings = true;
                        only_types &= entry.is_type;
                    }
                }
            }
            let kind = if request.is_type || (has_bindings && only_types) {
                "type"
            } else {
                "code"
            };
            result.imports.push(
                json!({"specifier": specifier.as_str(), "kind": kind, "dynamic": false,
                "start": request.span.start + offset, "end": request.span.end + offset}),
            );
        }
    }
    Imports {
        result,
        source,
        offset,
        projection: None,
        dynamic_only: false,
        external_module: false,
    }
    .visit_program(&parsed.program);
    for comment in &parsed.program.comments {
        let content =
            &source[comment.content_span().start as usize..comment.content_span().end as usize];
        let raw = &source[comment.span.start as usize..comment.span.end as usize];
        result.comments.push(json!({"raw": raw, "start": comment.span.start + offset, "end": comment.span.end + offset}));
        if let Some(reference) = content
            .trim_start()
            .strip_prefix('/')
            .map(str::trim_start)
            .and_then(|text| text.strip_prefix("<reference"))
            .filter(|text| text.starts_with(char::is_whitespace))
        {
            for kind in ["path", "types"] {
                if let Some(specifier) = quoted_attribute(reference, kind) {
                    result
                        .references
                        .push(json!({"specifier": specifier, "kind": kind,
                        "start": comment.span.start + offset, "end": comment.span.end + offset}));
                }
            }
        }
        for (directive, kind) in [
            ("@ts-self-types", "self-types"),
            ("@ts-types", "ts-types"),
            ("@deno-types", "deno-types"),
        ] {
            if let Some(specifier) = quoted_attribute(content, directive) {
                result
                    .references
                    .push(json!({"specifier": specifier, "kind": kind,
                    "start": comment.span.start + offset, "end": comment.span.end + offset}));
                if kind == "self-types" {
                    result.self_types = Some(specifier.to_owned());
                }
            }
        }
        if comment.is_jsdoc() {
            inspect_jsdoc(result, content, comment.content_span().start + offset);
        }
    }
}

pub fn inspect_source(path: &str, source: &str) -> Value {
    let mut result = Inspection::default();
    if path.ends_with(".svelte") {
        let engine = Engine::new();
        match engine.prepare(source, ComponentOptions::new().filename(path)) {
            Ok(prepared) => {
                for script in &prepared.facts().scripts {
                    let start = script.content.start() as usize;
                    let end = script.content.end() as usize;
                    inspect_js(
                        &mut result,
                        path,
                        source,
                        &source[start..end],
                        if script.typescript {
                            SourceType::ts()
                        } else {
                            SourceType::mjs()
                        },
                        start as u32,
                    );
                }
                let typescript = prepared
                    .facts()
                    .scripts
                    .iter()
                    .any(|script| script.typescript);
                match engine.project(
                    source,
                    ProjectionOptions::new()
                        .filename(path)
                        .typescript(typescript),
                ) {
                    Ok(projected) => {
                        if let Some(map) = &projected.exact_mappings {
                            let allocator = Allocator::default();
                            let parsed =
                                Parser::new(&allocator, &projected.code, SourceType::tsx()).parse();
                            if parsed.diagnostics.is_empty() {
                                Imports {
                                    result: &mut result,
                                    source: &projected.code,
                                    offset: 0,
                                    projection: Some(map),
                                    dynamic_only: true,
                                    external_module: false,
                                }
                                .visit_program(&parsed.program);
                            } else {
                                result.diagnostics.push(Diagnostic::io(path, "cannot inspect template imports: generated TSX projection failed to parse"));
                            }
                        } else {
                            result.diagnostics.push(Diagnostic::io(
                                path,
                                "cannot inspect template imports: projection has no exact mappings",
                            ));
                        }
                    }
                    Err(error) => {
                        result
                            .diagnostics
                            .push(Diagnostic::svelte(path, source, &error.diagnostic))
                    }
                }
            }
            Err(error) => {
                result
                    .diagnostics
                    .push(Diagnostic::svelte(path, source, &error.diagnostic))
            }
        }
    } else {
        match source_type(Path::new(path)) {
            Ok(source_type) => inspect_js(&mut result, path, source, source, source_type, 0),
            Err(error) => result.diagnostics.push(Diagnostic::io(path, error)),
        }
    }
    result
        .imports
        .sort_by_key(|import| import["start"].as_u64());
    result.imports.dedup_by(|a, b| {
        a["start"] == b["start"] && a["end"] == b["end"] && a["kind"] == b["kind"]
    });
    result
        .computed_imports
        .sort_by_key(|import| import["start"].as_u64());
    result
        .computed_imports
        .dedup_by(|a, b| a["start"] == b["start"] && a["end"] == b["end"]);
    let mut file = json!({"path": path, "imports": result.imports, "computed_imports": result.computed_imports,
        "references": result.references, "comments": result.comments, "diagnostics": result.diagnostics});
    if let Some(types) = result.self_types {
        file["self_types"] = json!(types);
    }
    file
}

pub fn run(paths: &[PathBuf]) -> Result<bool> {
    let mut files = Vec::with_capacity(paths.len());
    let mut success = true;
    for path in paths {
        let name = path.to_string_lossy();
        let file = match fs::read_to_string(path) {
            Ok(source) => inspect_source(&name, &source),
            Err(error) => {
                json!({"path": name, "imports": [], "references": [], "computed_imports": [],
                "comments": [], "diagnostics": [Diagnostic::io(&name, error.to_string())]})
            }
        };
        success &= file["diagnostics"]
            .as_array()
            .is_some_and(|diagnostics| diagnostics.iter().all(|d| d["severity"] != "error"));
        files.push(file);
    }
    crate::print_json(&json!({"files": files}))?;
    Ok(success)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_augmentation_requires_top_level_external_module_syntax() {
        for path in ["ambient.ts", "ambient.d.ts"] {
            let ambient = inspect_source(
                path,
                "declare module 'virtual' { export interface Item { value: string } }",
            );
            assert_eq!(ambient["diagnostics"], json!([]));
            assert_eq!(ambient["imports"], json!([]));

            let external = inspect_source(
                path,
                "export {}; declare module 'virtual' { interface Item { value: string } }",
            );
            assert_eq!(external["diagnostics"], json!([]));
            assert_eq!(external["imports"][0]["specifier"], "virtual");
            assert_eq!(external["imports"][0]["kind"], "type");
            assert_eq!(external["imports"][0]["dynamic"], false);
        }
        let source = "import type { Item } from './base.ts'; declare module './café.ts' { interface Extra { item: Item } }";
        let external = inspect_source("augmentation.ts", source);
        assert_eq!(external["diagnostics"], json!([]));
        let augmentation = &external["imports"][1];
        assert_eq!(augmentation["specifier"], "./café.ts");
        assert_eq!(augmentation["kind"], "type");
        let start = augmentation["start"].as_u64().unwrap() as usize;
        let end = augmentation["end"].as_u64().unwrap() as usize;
        assert_eq!(&source[start..end], "'./café.ts'");
        for source in [
            "void import.meta.url; declare module 'virtual' { interface Options { extra: string } }",
            "declare module 'virtual' { interface Options { extra: string } } function url() { return import.meta.url; }",
        ] {
            let external = inspect_source("augmentation.ts", source);
            assert_eq!(external["diagnostics"], json!([]));
            assert_eq!(external["imports"][0]["specifier"], "virtual");
            assert_eq!(external["imports"][0]["kind"], "type");
        }
    }

    #[test]
    fn dynamic_import_phases_distinguish_proposals_from_normal_imports() {
        let file = inspect_source(
            "phases.js",
            "const source = () => import.source('./data.wasm'); const deferred = () => import.defer(`./café.js`); const ordinary = () => import('./plain.js'); const computed = (target) => import.defer(target);",
        );
        assert_eq!(file["diagnostics"], json!([]));
        let imports = file["imports"].as_array().unwrap();
        assert_eq!(imports[0]["specifier"], "./data.wasm");
        assert_eq!(imports[0]["phase"], "source");
        assert_eq!(imports[1]["specifier"], "./café.js");
        assert_eq!(imports[1]["phase"], "defer");
        assert_eq!(imports[2]["specifier"], "./plain.js");
        assert!(imports[2].get("phase").is_none());
        for import in imports {
            assert_eq!(import["dynamic"], true);
            assert_eq!(import["kind"], "code");
        }
        assert_eq!(file["computed_imports"][0]["phase"], "defer");
        assert_eq!(file["computed_imports"][0]["dynamic"], true);
        assert_eq!(file["computed_imports"][0]["expression"], "target");
    }

    #[test]
    fn import_boundaries_ignore_strings_comments_and_shadowed_calls() {
        let source = r#"
// import pretend from 'comment';
const text = "import('string')";
function local(require: (name: string) => void) { require('local'); }
import type { Item } from './item.ts';
import { type Config } from './config.ts';
export { type Value } from './value.ts';
import data from './data.json' with { type: 'json' };
const load = () => import('./real.ts');
const computed = (path: string) => import(path);
type Other = import('./other.ts').Other;
"#;
        let file = inspect_source("boundary.ts", source);
        assert_eq!(file["diagnostics"], json!([]));
        let imports = file["imports"].as_array().unwrap();
        let expected = [
            ("./item.ts", "type", false),
            ("./config.ts", "type", false),
            ("./value.ts", "type", false),
            ("./data.json", "code", false),
            ("./real.ts", "code", true),
            ("./other.ts", "type", false),
        ];
        assert_eq!(imports.len(), expected.len());
        for (import, (specifier, kind, dynamic)) in imports.iter().zip(expected) {
            assert_eq!(import["specifier"], specifier);
            assert_eq!(import["kind"], kind);
            assert_eq!(import["dynamic"], dynamic);
            let start = import["start"].as_u64().unwrap() as usize;
            let end = import["end"].as_u64().unwrap() as usize;
            assert!(source[start..end].contains(specifier));
        }
        assert_eq!(imports[3]["attributes"]["values"]["type"], "json");
        assert_eq!(file["computed_imports"][0]["expression"], "path");
    }

    #[test]
    fn directives_come_only_from_real_comments() {
        let source = r#"/// <reference types = "platform" />
/// <reference path='./ambient.d.ts' />
/* @ts-self-types = './mod.d.ts' */
const fake = "/// <reference types='fake' />";
"#;
        let file = inspect_source("directives.ts", source);
        assert_eq!(file["diagnostics"], json!([]));
        assert_eq!(file["references"][0]["specifier"], "platform");
        assert_eq!(file["references"][1]["specifier"], "./ambient.d.ts");
        assert_eq!(file["references"].as_array().unwrap().len(), 3);
        assert_eq!(file["self_types"], "./mod.d.ts");
    }

    #[test]
    fn comment_type_edges_decode_literals_and_keep_authored_spans() {
        let source = r#"// @deno-types="./runtime.d.ts"
import value from "./runtime.js";
// @ts-types='./other.d.ts'
export { value };
/** @type {import("./caf\u00e9.ts").Value} */
let item;
/** @import { Other } from "./other.ts" */
let other;
// @type {import("./not-jsdoc.ts").Value}
const fake = "/** @type {import('./string.ts').Value} */";
/** @type {"import('./literal.ts')"} */
let literal;
/** @example { import('./example.ts') } */
let example;
"#;
        let file = inspect_source("metadata.js", source);
        assert_eq!(file["diagnostics"], json!([]));
        let references = file["references"].as_array().unwrap();
        let expected = [
            (
                "./runtime.d.ts",
                "deno-types",
                r#"// @deno-types="./runtime.d.ts""#,
            ),
            ("./other.d.ts", "ts-types", "// @ts-types='./other.d.ts'"),
            ("./café.ts", "jsdoc", r#""./caf\u00e9.ts""#),
            ("./other.ts", "jsdoc", r#""./other.ts""#),
        ];
        assert_eq!(references.len(), expected.len());
        for (reference, (specifier, kind, spelling)) in references.iter().zip(expected) {
            assert_eq!(reference["specifier"], specifier);
            assert_eq!(reference["kind"], kind);
            let start = reference["start"].as_u64().unwrap() as usize;
            let end = reference["end"].as_u64().unwrap() as usize;
            assert_eq!(&source[start..end], spelling);
        }
    }

    #[test]
    fn malformed_import_reports_original_unicode_byte_location() {
        let source = "// café\nimport { from './bad.ts';";
        let file = inspect_source("bad.ts", source);
        let diagnostic = &file["diagnostics"][0];
        assert_eq!(diagnostic["severity"], "error");
        assert_eq!(diagnostic["location"]["line"], 2);
        assert!(diagnostic["start"].as_u64().unwrap() >= "// café\n".len() as u64);
        assert_eq!(file["imports"], json!([]));
    }

    #[test]
    fn component_script_import_spans_remain_in_original_source() {
        let source = "<script lang=\"ts\">\nimport type { Item } from './item.ts';\nlet item: Item;\n</script><p>{item}</p>";
        let file = inspect_source("Item.svelte", source);
        assert_eq!(file["diagnostics"], json!([]));
        let import = &file["imports"][0];
        assert_eq!(import["kind"], "type");
        assert_eq!(import["specifier"], "./item.ts");
        let start = import["start"].as_u64().unwrap() as usize;
        let end = import["end"].as_u64().unwrap() as usize;
        assert_eq!(&source[start..end], "'./item.ts'");
    }
}
