// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A window's screen, kept from frame to frame: its rows, each as
//! core/gui.sls encodes it (rectangles and cells, placed in the row as if
//! it were the top one) and laid out once ([`Fonts::row`]). A frame
//! ([`Update`]) brings only the rows that changed, and the scrolls that
//! moved the others, as the editor's "line" and "scroll" messages do; the
//! rows it did not bring are drawn as they were, with no work but copying.

use std::rc::Rc;

use crate::font::{CELL_BYTES, Fonts, Layout, RECT_BYTES};
use crate::image::Placement;

/// A row's rectangles (backgrounds, the cursor: [`RECT_BYTES`] each) and
/// cells ([`CELL_BYTES`] each, with their `text`), at the top.
#[derive(Clone, Default)]
pub struct RowData {
    pub rects: Vec<u8>,
    pub cells: Vec<u8>,
    pub text: Vec<u8>,
}

/// What changed since the last frame.
#[derive(Default)]
pub struct Update {
    /// The screen's size in rows.
    pub rows: u32,
    /// Every row is in `changed`: forget what was there.
    pub whole: bool,
    /// Rows `top` to `bottom` (exclusive) moved up `n` (down, for n < 0),
    /// in order, before the changed rows are put in place.
    pub scrolls: Vec<(u32, u32, i32)>,
    pub changed: Vec<(u32, RowData)>,
    /// 0xRRGGBB, where nothing else is drawn.
    pub background: u32,
    /// The text's color where cells leave it to the terminal.
    pub foreground: u32,
    /// Where the text cursor is, (row, column), drawn or not.
    pub cursor: Option<(u32, u32)>,
    pub placements: Vec<Placement>,
}

fn u32s(bytes: &[u8]) -> impl Iterator<Item = u32> + '_ {
    bytes
        .chunks_exact(4)
        .map(|w| u32::from_ne_bytes(w.try_into().unwrap()))
}

impl Update {
    /// The changed rows from their encodings: `index` has four u32s for
    /// each (the row, and how many rectangles, cells and bytes of text it
    /// has), taken in order from `rects`, `cells` and `text`; `scrolls`
    /// three i32s (top, bottom, n) for each scroll.
    pub fn rows_from(
        scrolls: &[u8],
        index: &[u8],
        rects: &[u8],
        cells: &[u8],
        text: &[u8],
    ) -> Result<(Vec<(u32, u32, i32)>, Vec<(u32, RowData)>), String> {
        if scrolls.len() % 12 != 0 || index.len() % 16 != 0 {
            return Err("frame: scrolls are three i32s, rows four u32s".into());
        }
        let scrolls = scrolls
            .chunks_exact(12)
            .map(|s| {
                let at = |i: usize| i32::from_ne_bytes(s[i * 4..i * 4 + 4].try_into().unwrap());
                (at(0) as u32, at(1) as u32, at(2))
            })
            .collect();
        let (mut r, mut c, mut t) = (0, 0, 0);
        let mut changed = Vec::new();
        let words: Vec<u32> = u32s(index).collect();
        for w in words.chunks_exact(4) {
            let (row, nr, nc, nt) = (w[0], w[1] as usize, w[2] as usize, w[3] as usize);
            let (r1, c1, t1) = (r + nr * RECT_BYTES, c + nc * CELL_BYTES, t + nt);
            if r1 > rects.len() || c1 > cells.len() || t1 > text.len() {
                return Err("frame: rows run past their data".into());
            }
            changed.push((
                row,
                RowData {
                    rects: rects[r..r1].to_vec(),
                    cells: cells[c..c1].to_vec(),
                    text: text[t..t1].to_vec(),
                },
            ));
            (r, c, t) = (r1, c1, t1);
        }
        Ok((scrolls, changed))
    }
}

#[derive(Default)]
struct Row {
    data: RowData,
    /// Its glyphs, lines and color glyphs' pictures, laid out at the top,
    /// for [`Screen::epoch`].
    laid: Option<Rc<Layout>>,
}

#[derive(Default)]
pub struct Screen {
    rows: Vec<Row>,
    /// The fonts' epoch the rows' layouts are good for.
    epoch: u64,
    pub background: u32,
    pub foreground: u32,
    pub cursor: Option<(u32, u32)>,
    pub placements: Vec<Placement>,
}

impl Screen {
    /// Takes a frame's changes. Returns the rows that show something new:
    /// those changed, and those scrolls moved.
    pub fn apply(&mut self, update: Update) -> Vec<bool> {
        let n = update.rows as usize;
        if update.whole {
            self.rows.clear();
        }
        self.rows.resize_with(n, Row::default);
        let mut damaged = vec![update.whole; n];
        for (top, bottom, by) in update.scrolls {
            let (top, bottom) = (top as usize, (bottom as usize).min(n));
            if top >= bottom {
                continue;
            }
            let mut moved: Vec<Option<Row>> = self.rows[top..bottom]
                .iter_mut()
                .map(|r| Some(std::mem::take(r)))
                .collect();
            for r in top..bottom {
                let from = r as i64 + i64::from(by);
                self.rows[r] = if (top as i64..bottom as i64).contains(&from) {
                    moved[from as usize - top].take().unwrap_or_default()
                } else {
                    Row::default()
                };
                damaged[r] = true;
            }
        }
        for (r, data) in update.changed {
            if let Some(row) = self.rows.get_mut(r as usize) {
                *row = Row { data, laid: None };
                damaged[r as usize] = true;
            }
        }
        self.background = update.background;
        self.foreground = update.foreground;
        self.cursor = update.cursor;
        self.placements = update.placements;
        damaged
    }

    /// How many rows it has.
    pub fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// Each row's characters: column, width in cells, and text.
    pub fn characters(&self) -> Vec<Vec<(u32, u32, String)>> {
        self.rows
            .iter()
            .map(|r| crate::font::characters(&r.data.cells, &r.data.text))
            .collect()
    }

    /// What draws the screen: its rectangles, then its glyphs and lines
    /// ([`Layout`]), every row in its place.
    pub fn layout(&mut self, fonts: &mut Fonts) -> (Vec<u8>, Layout) {
        fonts.trim();
        if self.epoch != fonts.epoch {
            for row in &mut self.rows {
                row.laid = None;
            }
            self.epoch = fonts.epoch;
        }
        let ch = fonts.metrics.cell[1];
        let mut rects = Vec::new();
        let mut out = Layout::default();
        for (y, row) in self.rows.iter_mut().enumerate() {
            moved(&mut rects, &row.data.rects, RECT_BYTES, y as f32);
            let laid = row
                .laid
                .get_or_insert_with(|| fonts.row(&row.data.cells, &row.data.text));
            out.append_moved(laid, y as f32 * ch, y as f32);
        }
        (rects, out)
    }
}

/// Appends `from`'s records, `size` bytes each, moved down `dy`: y is each
/// record's second f32.
fn moved(out: &mut Vec<u8>, from: &[u8], size: usize, dy: f32) {
    let start = out.len();
    out.extend_from_slice(from);
    for record in out[start..].chunks_exact_mut(size) {
        let y = f32::from_ne_bytes(record[4..8].try_into().unwrap()) + dy;
        record[4..8].copy_from_slice(&y.to_ne_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::TestCase;
    use hegel::generators as gs;

    fn rect_row(y: f32) -> RowData {
        let mut rects = Vec::new();
        for v in [1.0f32, y, 2.0, 1.0] {
            rects.extend_from_slice(&v.to_ne_bytes());
        }
        rects.extend_from_slice(&[0; 16]);
        RowData {
            rects,
            ..RowData::default()
        }
    }

    fn marks(screen: &Screen) -> Vec<f32> {
        // Each test row's one rectangle has its row's mark as its x.
        screen
            .rows
            .iter()
            .map(|r| {
                r.data
                    .rects
                    .get(0..4)
                    .map_or(-1.0, |b| f32::from_ne_bytes(b.try_into().unwrap()))
            })
            .collect()
    }

    fn marked(x: f32) -> RowData {
        let mut row = rect_row(0.0);
        row.rects[0..4].copy_from_slice(&x.to_ne_bytes());
        row
    }

    #[test]
    fn scrolls_move_rows_and_leave_blank_ones() {
        let mut screen = Screen::default();
        screen.apply(Update {
            rows: 5,
            whole: true,
            changed: (0..5).map(|i| (i, marked(i as f32))).collect(),
            ..Update::default()
        });
        let damaged = screen.apply(Update {
            rows: 5,
            scrolls: vec![(1, 4, 1)],
            changed: vec![(3, marked(9.0))],
            ..Update::default()
        });
        assert_eq!(marks(&screen), [0.0, 2.0, 3.0, 9.0, 4.0]);
        assert_eq!(damaged, [false, true, true, true, false]);
        screen.apply(Update {
            rows: 5,
            scrolls: vec![(0, 5, -2)],
            ..Update::default()
        });
        assert_eq!(marks(&screen), [-1.0, -1.0, 0.0, 2.0, 3.0]);
    }

    #[test]
    fn rows_are_read_from_their_encodings() {
        let row = rect_row(0.0);
        let index: Vec<u8> = [7u32, 1, 0, 0]
            .iter()
            .flat_map(|v| v.to_ne_bytes())
            .collect();
        let scrolls: Vec<u8> = [1i32, 5, -1].iter().flat_map(|v| v.to_ne_bytes()).collect();
        let (s, changed) = Update::rows_from(&scrolls, &index, &row.rects, &[], &[]).unwrap();
        assert_eq!(s, [(1, 5, -1)]);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].0, 7);
        assert!(Update::rows_from(&[], &index, &[], &[], &[]).is_err());
    }

    /// However rows are scrolled and changed, the screen holds what a
    /// plain list of rows, moved and changed the same way, holds; and the
    /// rows it does not say are damaged show what they showed before.
    #[hegel::test(test_cases = 300, database = None)]
    fn the_rows_are_a_plain_lists_however_they_move(tc: TestCase) {
        let n = tc.draw(gs::integers::<u32>().min_value(1).max_value(12));
        let mut screen = Screen::default();
        screen.apply(Update {
            rows: n,
            whole: true,
            changed: (0..n).map(|i| (i, marked(i as f32))).collect(),
            ..Update::default()
        });
        let mut model: Vec<f32> = (0..n).map(|i| i as f32).collect();
        let mut next = 100.0;
        let frames = tc.draw(gs::integers::<usize>().max_value(6));
        for _ in 0..frames {
            let top = tc.draw(gs::integers::<u32>().max_value(n));
            let bottom = tc.draw(gs::integers::<u32>().min_value(top).max_value(n));
            let by = tc.draw(
                gs::integers::<i32>()
                    .min_value(-(n as i32))
                    .max_value(n as i32),
            );
            let rows = tc.draw(gs::vecs(gs::integers::<u32>().max_value(n - 1)).max_size(4));
            let before = marks(&screen);
            let old = model.clone();
            for r in top..bottom {
                let from = i64::from(r) + i64::from(by);
                model[r as usize] = if (i64::from(top)..i64::from(bottom)).contains(&from) {
                    old[from as usize]
                } else {
                    -1.0
                };
            }
            let mut changed = Vec::new();
            for r in rows {
                model[r as usize] = next;
                changed.push((r, marked(next)));
                next += 1.0;
            }
            let damaged = screen.apply(Update {
                rows: n,
                scrolls: vec![(top, bottom, by)],
                changed,
                ..Update::default()
            });
            assert_eq!(marks(&screen), model);
            for r in 0..n as usize {
                if !damaged[r] {
                    assert_eq!(before[r], model[r], "row {r} changed, undamaged");
                }
            }
        }
    }

    /// Whatever bytes Scheme sends, they are read as rows or refused,
    /// never more.
    #[hegel::test(test_cases = 300, database = None)]
    fn any_encoding_is_read_or_refused(tc: TestCase) {
        let bytes = |tc: &TestCase| tc.draw(gs::binary().max_size(96));
        let (scrolls, index, rects, cells, text) =
            (bytes(&tc), bytes(&tc), bytes(&tc), bytes(&tc), bytes(&tc));
        let _ = Update::rows_from(&scrolls, &index, &rects, &cells, &text);
    }
}
