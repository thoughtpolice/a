// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Cells as core/gui.sls packs them, read.

use super::*;

/// A cell, as core/gui.sls sends it.
#[derive(Clone, Copy)]
pub(super) struct Cell<'t> {
    pub(super) row: u32,
    pub(super) col: u32,
    pub(super) width: u32,
    pub(super) flags: u32,
    /// 0xAARRGGBB.
    pub(super) color: u32,
    /// 0xRRGGBB: what is behind its text.
    pub(super) background: u32,
    /// 0xAARRGGBB: its underline's color; alpha 0 for its text's.
    pub(super) underline: u32,
    pub(super) text: &'t str,
}

impl<'t> Cell<'t> {
    pub(super) fn parse(b: &[u8], text: &'t [u8]) -> Option<Cell<'t>> {
        let word =
            |i: usize| u32::from_ne_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]]);
        let (place, attrs, color, background, underline, start, len) = (
            word(0),
            word(1),
            word(2),
            word(3),
            word(4),
            word(5),
            word(6),
        );
        let text = text.get(start as usize..start.checked_add(len)? as usize)?;
        let flags = attrs & 0xffff;
        Some(Cell {
            row: place >> 16,
            col: place & 0xffff,
            width: (attrs >> 16).max(1),
            flags,
            // Faint text, at half strength, as ghostty draws it.
            color: if flags & DIM != 0 {
                color & 0x00ff_ffff | 0x8000_0000
            } else {
                color
            },
            background: background & 0x00ff_ffff,
            underline,
            text: std::str::from_utf8(text).ok()?,
        })
    }

    pub(super) fn style(&self) -> usize {
        usize::from(self.flags & BOLD != 0) | usize::from(self.flags & ITALIC != 0) << 1
    }
}

/// The cells of `cells` ([`CELL_BYTES`] each, with their texts in `text`)
/// that read as cells.
pub(super) fn parse_all<'t>(cells: &[u8], text: &'t [u8]) -> impl Iterator<Item = Cell<'t>> {
    cells
        .chunks_exact(CELL_BYTES)
        .filter_map(move |b| Cell::parse(b, text))
}

/// The characters of `cells` ([`CELL_BYTES`] each, with their texts in
/// `text`): each one's column, width in cells, and text.
pub fn characters(cells: &[u8], text: &[u8]) -> Vec<(u32, u32, String)> {
    parse_all(cells, text)
        .map(|c| (c.col, c.width, c.text.to_string()))
        .collect()
}

/// What makes a row look as it does: each cell's column, width,
/// attributes, color and text, whatever row it is on.
pub(super) fn row_key(cells: &[Cell]) -> Vec<u8> {
    let mut key = Vec::with_capacity(cells.len() * 20);
    for c in cells {
        for v in [
            c.col,
            c.width << 16 | c.flags,
            c.color,
            c.background,
            c.underline,
            c.text.len() as u32,
        ] {
            key.extend_from_slice(&v.to_ne_bytes());
        }
        key.extend_from_slice(c.text.as_bytes());
    }
    key
}
