// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A rectangle of cells drawn on the CPU, with an effect over its text:
//! what terminals that show images get (docs/animation.md, the second
//! way). It draws backgrounds, and the characters made of shapes: block
//! elements and box drawing's straight lines, as kernel/font's sprites
//! draw them in windows. Other characters it does not draw: a rectangle
//! with them in it is drawn as cells instead.

use super::Effect;

/// A cell: its text, and its colors (0xRRGGBB).
pub struct Cell<'a> {
    pub text: &'a str,
    pub fg: u32,
    pub bg: u32,
}

/// The rectangles, in eighths of a cell (left, top, right, bottom, from
/// its top left), that make a character; None for one not drawn here.
pub fn shapes(text: &str) -> Option<Vec<[u8; 4]>> {
    let mut chars = text.chars();
    let c = match chars.next() {
        None => return Some(vec![]),
        Some(c) => c,
    };
    if chars.next().is_some() {
        return None;
    }
    // Lines from the middle: weights (0 none, 1 light, 2 heavy) of the
    // arms left, right, up and down.
    let lines = |[l, r, u, d]: [u8; 4]| {
        let mut out = vec![];
        let w = |weight: u8| if weight == 2 { 1 } else { 0 };
        let (hw, vw) = (w(l.max(r)), w(u.max(d)));
        if l > 0 {
            out.push([0, 3 - hw, 4 + vw + 1, 5 + hw]);
        }
        if r > 0 {
            out.push([3 - vw, 3 - hw, 8, 5 + hw]);
        }
        if u > 0 {
            out.push([3 - vw, 0, 5 + vw, 4 + hw + 1]);
        }
        if d > 0 {
            out.push([3 - vw, 3 - hw, 5 + vw, 8]);
        }
        out
    };
    Some(match c {
        ' ' | '\u{a0}' => vec![],
        '█' => vec![[0, 0, 8, 8]],
        '▀' => vec![[0, 0, 8, 4]],
        '▄' => vec![[0, 4, 8, 8]],
        '▌' => vec![[0, 0, 4, 8]],
        '▐' => vec![[4, 0, 8, 8]],
        '▔' => vec![[0, 0, 8, 1]],
        '▕' => vec![[7, 0, 8, 8]],
        // Lower eighths: ▁ is one, ▇ seven.
        '▁'..='▇' => {
            let n = c as u32 - 0x2580;
            vec![[0, 8 - n as u8, 8, 8]]
        }
        // Left eighths: ▉ is seven, ▏ one.
        '▉'..='▏' => {
            let n = 8 - (c as u32 - 0x2588);
            vec![[0, 0, n as u8, 8]]
        }
        '▖' => vec![[0, 4, 4, 8]],
        '▗' => vec![[4, 4, 8, 8]],
        '▘' => vec![[0, 0, 4, 4]],
        '▝' => vec![[4, 0, 8, 4]],
        '▙' => vec![[0, 0, 4, 8], [4, 4, 8, 8]],
        '▛' => vec![[0, 0, 8, 4], [0, 4, 4, 8]],
        '▜' => vec![[0, 0, 8, 4], [4, 4, 8, 8]],
        '▟' => vec![[4, 0, 8, 8], [0, 4, 4, 8]],
        '▚' => vec![[0, 0, 4, 4], [4, 4, 8, 8]],
        '▞' => vec![[4, 0, 8, 4], [0, 4, 4, 8]],
        '─' => lines([1, 1, 0, 0]),
        '━' => lines([2, 2, 0, 0]),
        '│' => lines([0, 0, 1, 1]),
        '┃' => lines([0, 0, 2, 2]),
        '┌' => lines([0, 1, 0, 1]),
        '┐' => lines([1, 0, 0, 1]),
        '└' => lines([0, 1, 1, 0]),
        '┘' => lines([1, 0, 1, 0]),
        '├' => lines([0, 1, 1, 1]),
        '┤' => lines([1, 0, 1, 1]),
        '┬' => lines([1, 1, 0, 1]),
        '┴' => lines([1, 1, 1, 0]),
        '┼' => lines([1, 1, 1, 1]),
        '┏' => lines([0, 2, 0, 2]),
        '┓' => lines([2, 0, 0, 2]),
        '┗' => lines([0, 2, 2, 0]),
        '┛' => lines([2, 0, 2, 0]),
        _ => return None,
    })
}

/// `cells` (`cols` across, row by row) drawn at `cell` pixels each, with
/// `effect` at `progress` over their text: RGBA pixels, row by row; None
/// if a cell has a character not drawn here.
pub fn raster(
    cells: &[Cell],
    cols: usize,
    cell: [usize; 2],
    effect: &Effect,
    progress: f32,
) -> Option<Vec<u8>> {
    let rows = cells.len().div_ceil(cols.max(1));
    let shapes: Vec<Vec<[u8; 4]>> = cells
        .iter()
        .map(|c| shapes(c.text))
        .collect::<Option<_>>()?;
    let (cw, ch) = (cell[0].max(1), cell[1].max(1));
    let (width, height) = (cols * cw, rows * ch);
    let mut out = vec![0u8; width * height * 4];
    // Points in cell widths: across, and down.
    let unit = cw as f32;
    let extent = [width as f32 / unit, height as f32 / unit];
    let amount = effect.amounts(progress, extent);
    for (i, (c, shapes)) in cells.iter().zip(&shapes).enumerate() {
        let (x0, y0) = ((i % cols) * cw, (i / cols) * ch);
        for py in 0..ch {
            let (fy0, fy1) = (
                py as f32 * 8.0 / ch as f32,
                (py + 1) as f32 * 8.0 / ch as f32,
            );
            for px in 0..cw {
                // How much of the pixel the shapes cover: their overlap
                // with it, in eighths of the cell scaled to pixels.
                let (fx0, fx1) = (
                    px as f32 * 8.0 / cw as f32,
                    (px + 1) as f32 * 8.0 / cw as f32,
                );
                let area = (fx1 - fx0) * (fy1 - fy0);
                let covered: f32 = shapes
                    .iter()
                    .map(|&[l, t, r, b]| {
                        let w = (fx1.min(f32::from(r)) - fx0.max(f32::from(l))).max(0.0);
                        let h = (fy1.min(f32::from(b)) - fy0.max(f32::from(t))).max(0.0);
                        w * h
                    })
                    .sum::<f32>()
                    .min(area)
                    / area;
                let (x, y) = (x0 + px, y0 + py);
                // Ink is shaded only where there is some.
                let color = if covered > 0.0 {
                    let point = [(x as f32 + 0.5) / unit, (y as f32 + 0.5) / unit];
                    let ink = super::mix(c.fg, effect.color, amount(point));
                    super::mix(c.bg, ink, covered)
                } else {
                    c.bg
                };
                let o = (y * width + x) * 4;
                out[o] = (color >> 16) as u8;
                out[o + 1] = (color >> 8) as u8;
                out[o + 2] = color as u8;
                out[o + 3] = 255;
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SHEEN;

    #[test]
    fn blocks_cover_their_cells() {
        let still = Effect {
            kind: SHEEN,
            params: [0.0, 1.0, 0.0, 0.0],
            color: 0xffffff,
        };
        let cells = [
            Cell {
                text: "█",
                fg: 0xff0000,
                bg: 0x000000,
            },
            Cell {
                text: "▄",
                fg: 0x00ff00,
                bg: 0x000000,
            },
            Cell {
                text: " ",
                fg: 0xffffff,
                bg: 0x0000ff,
            },
        ];
        let px = raster(&cells, 3, [4, 8], &still, 0.5).unwrap();
        let at = |x: usize, y: usize| {
            let o = (y * 12 + x) * 4;
            u32::from(px[o]) << 16 | u32::from(px[o + 1]) << 8 | u32::from(px[o + 2])
        };
        assert_eq!(at(1, 1), 0xff0000);
        assert_eq!((at(5, 1), at(5, 6)), (0x000000, 0x00ff00));
        assert_eq!(at(9, 3), 0x0000ff);
    }

    #[test]
    fn a_sheen_lights_ink_not_backgrounds() {
        let sheen = Effect {
            kind: SHEEN,
            params: [0.0, 1.0, 1.0, 0.0],
            color: 0xffffff,
        };
        let cells = [
            Cell {
                text: "█",
                fg: 0x000000,
                bg: 0x101010,
            },
            Cell {
                text: " ",
                fg: 0x000000,
                bg: 0x101010,
            },
        ];
        // Half way, the band is over the boundary between the two.
        let px = raster(&cells, 2, [4, 8], &sheen, 0.5).unwrap();
        let red = |x: usize| px[(4 * 8 + x) * 4];
        assert!(red(3) > 0x80, "the ink by the band is lit");
        assert_eq!(red(4), 0x10, "the background is not");
    }

    #[test]
    fn other_characters_are_not_drawn() {
        let e = Effect {
            kind: SHEEN,
            params: [0.0; 4],
            color: 0,
        };
        let cells = [Cell {
            text: "a",
            fg: 0,
            bg: 0,
        }];
        assert!(raster(&cells, 1, [4, 8], &e, 0.0).is_none());
    }
}
