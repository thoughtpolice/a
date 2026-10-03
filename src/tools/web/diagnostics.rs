// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use oxc::diagnostics::{OxcDiagnostic, Severity};
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub path: String,
    pub severity: &'static str,
    pub code: String,
    pub message: String,
    pub start: Option<u32>,
    pub end: Option<u32>,
    pub location: Option<Position>,
    pub end_location: Option<Position>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
}

pub fn position(source: &str, byte: u32) -> Position {
    let mut byte = (byte as usize).min(source.len());
    while !source.is_char_boundary(byte) {
        byte -= 1;
    }
    let before = &source[..byte];
    let line = before.bytes().filter(|&b| b == b'\n').count() as u32 + 1;
    let column = before
        .rsplit('\n')
        .next()
        .unwrap_or("")
        .encode_utf16()
        .count() as u32;
    Position { line, column }
}

pub fn byte_at(source: &str, position: Position) -> Option<u32> {
    let mut offset = 0;
    for (index, line) in source.split_inclusive('\n').enumerate() {
        if index as u32 + 1 == position.line {
            let mut column = 0;
            for (byte, ch) in line.char_indices() {
                if column == position.column {
                    return Some((offset + byte) as u32);
                }
                column += ch.len_utf16() as u32;
            }
            return (column == position.column).then_some((offset + line.len()) as u32);
        }
        offset += line.len();
    }
    (position.line == 1 && position.column == 0 && source.is_empty()).then_some(0)
}

impl Diagnostic {
    pub fn new(
        path: &str,
        source: &str,
        severity: &'static str,
        code: impl Into<String>,
        message: impl Into<String>,
        span: Option<(u32, u32)>,
    ) -> Self {
        Self {
            path: path.to_owned(),
            severity,
            code: code.into(),
            message: message.into(),
            start: span.map(|s| s.0),
            end: span.map(|s| s.1),
            location: span.map(|s| position(source, s.0)),
            end_location: span.map(|s| position(source, s.1)),
            help: None,
        }
    }

    pub fn io(path: &str, message: impl Into<String>) -> Self {
        Self::new(path, "", "error", "file-error", message, None)
    }

    pub fn svelte(path: &str, source: &str, diagnostic: &rsvelte::Diagnostic) -> Self {
        let severity = match diagnostic.severity {
            rsvelte::DiagnosticSeverity::Warning => "warning",
            _ => "error",
        };
        Self::new(
            path,
            source,
            severity,
            &diagnostic.code,
            &diagnostic.message,
            diagnostic.span.map(|span| (span.start(), span.end())),
        )
    }

    pub fn oxc(path: &str, source: &str, diagnostic: &OxcDiagnostic, offset: u32) -> Self {
        let span = diagnostic
            .labels
            .iter()
            .find(|label| label.primary())
            .or_else(|| diagnostic.labels.first())
            .map(|label| {
                (
                    label.offset() as u32 + offset,
                    (label.offset() + label.len()) as u32 + offset,
                )
            });
        let severity = match diagnostic.severity {
            Severity::Warning => "warning",
            Severity::Advice => "info",
            _ => "error",
        };
        let code = if diagnostic.code.is_some() {
            diagnostic.code.to_string()
        } else {
            "parse-error".into()
        };
        let mut result = Self::new(
            path,
            source,
            severity,
            code,
            diagnostic.message.as_ref(),
            span,
        );
        result.help = diagnostic.help.as_deref().map(str::to_owned);
        result
    }

    pub fn remap(
        &mut self,
        original: &str,
        intermediate: &str,
        map: &oxc_sourcemap::SourceMap<'_>,
    ) {
        let lookup = map.generate_lookup_table();
        let mapped = |byte| {
            let pos = position(intermediate, byte);
            let token = map.lookup_token_approx(&lookup, pos.line - 1, pos.column)?;
            token.get_source_id()?;
            byte_at(
                original,
                Position {
                    line: token.get_src_line() + 1,
                    column: token.get_src_col(),
                },
            )
        };
        self.start = self.start.and_then(mapped);
        self.end = self.end.and_then(mapped);
        self.location = self.start.map(|byte| position(original, byte));
        self.end_location = self.end.map(|byte| position(original, byte));
    }
}
