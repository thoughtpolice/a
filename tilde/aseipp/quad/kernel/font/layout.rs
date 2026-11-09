// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! What draws some cells: glyphs, rectangles and pictures, as the shaders
//! read them.

use super::*;

/// What draws some cells: glyphs ([`GLYPH_BYTES`] each), rectangles
/// ([`RECT_BYTES`] each, in cells) for underlines and other lines, and
/// pictures ([`PICTURE_BYTES`] each, in pixels) of color glyphs, whose
/// pixels are in [`Fonts::colors`].
#[derive(Default)]
pub struct Layout {
    pub glyphs: Vec<u8>,
    pub rects: Vec<u8>,
    pub pictures: Vec<u8>,
}

impl Layout {
    /// Appends `other`, moved down `pixels` (its glyphs) and `cells` (its
    /// rectangles): a row laid out at the top, put where it is.
    pub fn append_moved(&mut self, other: &Layout, pixels: f32, cells: f32) {
        let moved = |out: &mut Vec<u8>, from: &[u8], size: usize, dy: f32| {
            let start = out.len();
            out.extend_from_slice(from);
            // y is each record's second f32.
            for record in out[start..].chunks_exact_mut(size) {
                let y = f32::from_ne_bytes(record[4..8].try_into().unwrap()) + dy;
                record[4..8].copy_from_slice(&y.to_ne_bytes());
            }
        };
        moved(&mut self.glyphs, &other.glyphs, GLYPH_BYTES, pixels);
        moved(&mut self.rects, &other.rects, RECT_BYTES, cells);
        moved(&mut self.pictures, &other.pictures, PICTURE_BYTES, pixels);
    }

    /// A color glyph's picture: at `rect` (pixels), its pixels from
    /// `offset` in [`Fonts::colors`], `stride` to a row.
    pub(super) fn picture(&mut self, rect: [f32; 4], offset: u32, stride: u32) {
        for v in rect {
            self.pictures.extend_from_slice(&v.to_ne_bytes());
        }
        for v in [offset, stride, 0, 0] {
            self.pictures.extend_from_slice(&v.to_ne_bytes());
        }
    }

    /// A glyph whose em-space origin is at pixel `origin`, `px` pixels to
    /// the em. Its quad is a pixel wider on each side than the shape, for
    /// the edges' antialiasing.
    pub(super) fn glyph(
        &mut self,
        shape: &Shape,
        origin: [f32; 2],
        px: f32,
        color: u32,
        background: u32,
    ) {
        let [x0, y0, x1, y1] = shape.bounds;
        let pad = 1.0 / px;
        let em = [x0 - pad, y1 + pad, x1 + pad, y0 - pad];
        let rect = [
            origin[0] + em[0] * px,
            origin[1] - em[1] * px,
            (em[2] - em[0]) * px,
            (em[1] - em[3]) * px,
        ];
        for v in rect.into_iter().chain(em).chain(shape.banding) {
            self.glyphs.extend_from_slice(&v.to_ne_bytes());
        }
        let band_max = u32::from(shape.band_max[0]) | u32::from(shape.band_max[1]) << 16;
        for v in [shape.location, band_max, color, background] {
            self.glyphs.extend_from_slice(&v.to_ne_bytes());
        }
    }

    /// A rectangle, in cells.
    pub(super) fn rect(&mut self, bounds: [f32; 4], color: u32) {
        for v in bounds {
            self.rects.extend_from_slice(&v.to_ne_bytes());
        }
        for v in [color, 0, 0, 0] {
            self.rects.extend_from_slice(&v.to_ne_bytes());
        }
    }
}
