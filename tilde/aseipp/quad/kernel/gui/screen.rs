// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A window's screen, kept from frame to frame: its rows, each as
//! core/gui.sls encodes it (rectangles and cells, placed in the row as if
//! it were the top one) and laid out once ([`Fonts::row`]). A frame
//! ([`Update`]) brings only the rows that changed, and the scrolls that
//! moved the others, as the editor's "line" and "scroll" messages do; the
//! rows it did not bring are drawn as they were, with no work but copying.

use std::rc::Rc;

use quad_font::{CELL_BYTES, Fonts, Layout, RECT_BYTES, append_records};
use quad_fx::{EFFECT_BYTES, Placed};
use quad_image::Placement;

/// A rectangle's edges (gui.slang's `Rect::edges`, at byte 20): the sides
/// that reach on to the window's edge, over its padding. core/gui.sls marks
/// a row's backgrounds that may reach up or down `EDGE_ROW`.
const EDGE_TOP: u32 = 4;
const EDGE_BOTTOM: u32 = 8;
const EDGE_ROW: u32 = 16;

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
    /// The effects placed over it (docs/animation.md): all of them.
    pub effects: Vec<Placed>,
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

/// The rows `effects` cover.
fn effect_rows(effects: &[Placed]) -> impl Iterator<Item = usize> + '_ {
    effects.iter().flat_map(|e| {
        let top = e.cells[1].max(0.0) as usize;
        top..top + e.cells[3].max(0.0) as usize
    })
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
    /// The effects placed over it, and when they came.
    pub effects: Vec<Placed>,
    pub effects_came: Option<std::time::Instant>,
}

impl Screen {
    /// The effects, as gui.slang's Effects, `since` milliseconds after
    /// they came; and the milliseconds until any next changes (0 while
    /// one moves), or None once none will.
    pub fn effects_at(&self, since: f64) -> (Vec<u8>, Option<f64>) {
        let mut bytes = Vec::with_capacity(self.effects.len() * EFFECT_BYTES);
        let mut next: Option<f64> = None;
        for e in &self.effects {
            bytes.extend_from_slice(&e.gpu_bytes(e.progress(since)));
            if let Some(n) = e.next_change(since) {
                next = Some(next.map_or(n, |m: f64| m.min(n)));
            }
        }
        (bytes, next)
    }

    /// The rows the effects cover.
    pub fn effect_rows(&self) -> impl Iterator<Item = usize> + '_ {
        effect_rows(&self.effects)
    }

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
            // Row r shows what row r + by did, or nothing.
            let rows = &mut self.rows[top..bottom];
            let k = by.unsigned_abs() as usize;
            if k >= rows.len() {
                rows.fill_with(Row::default);
            } else if by > 0 {
                rows.rotate_left(k);
                let n = rows.len();
                rows[n - k..].fill_with(Row::default);
            } else {
                rows.rotate_right(k);
                rows[..k].fill_with(Row::default);
            }
            damaged[top..bottom].fill(true);
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
        // The effects come again with each frame, older: where what they
        // draw changes, where they were and where they are are drawn again.
        let since = self
            .effects_came
            .map_or(0.0, |came| came.elapsed().as_secs_f64() * 1000.0);
        let drawn = self.effects_at(since).0;
        let old = std::mem::replace(&mut self.effects, update.effects);
        if drawn != self.effects_at(0.0).0 {
            for r in effect_rows(&old).chain(effect_rows(&self.effects)) {
                if let Some(d) = damaged.get_mut(r) {
                    *d = true;
                }
            }
        }
        self.effects_came = Some(std::time::Instant::now());
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
            .map(|r| quad_font::characters(&r.data.cells, &r.data.text))
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
        let mut out = Layout::default();
        for (y, row) in self.rows.iter_mut().enumerate() {
            let laid = row
                .laid
                .get_or_insert_with(|| fonts.row(&row.data.cells, &row.data.text));
            out.append_moved(laid, y as f32 * ch, y as f32);
        }
        (self.rects(), out)
    }

    /// Its rectangles, every row's in its place. Those core/gui.sls marks
    /// [`EDGE_ROW`] reach up to the window's top in the top row, and down
    /// to its bottom in the bottom one, over its padding.
    fn rects(&self) -> Vec<u8> {
        let mut rects = Vec::new();
        let last = self.rows.len().saturating_sub(1);
        for (y, row) in self.rows.iter().enumerate() {
            let start = rects.len();
            append_records(&mut rects, &row.data.rects, RECT_BYTES, y as f32);
            let reach = if y == 0 { EDGE_TOP } else { 0 } | if y == last { EDGE_BOTTOM } else { 0 };
            if reach == 0 {
                continue;
            }
            for record in rects[start..].chunks_exact_mut(RECT_BYTES) {
                let edges = u32::from_ne_bytes(record[20..24].try_into().unwrap());
                if edges & EDGE_ROW != 0 {
                    record[20..24].copy_from_slice(&(edges | reach).to_ne_bytes());
                }
            }
        }
        rects
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

    /// Whatever rows are at the top and bottom, once scrolled, their
    /// backgrounds that may reach up or down do, and no others reach
    /// further than core/gui.sls sent them.
    #[hegel::test(test_cases = 300, database = None)]
    fn only_the_top_and_bottom_rows_reach_past_them(tc: TestCase) {
        let edges_of = |rects: &[u8]| -> Vec<u32> {
            rects
                .chunks_exact(RECT_BYTES)
                .map(|r| u32::from_ne_bytes(r[20..24].try_into().unwrap()))
                .collect()
        };
        let n = tc.draw(gs::integers::<u32>().min_value(1).max_value(8));
        let mut screen = Screen::default();
        let changed = (0..n)
            .map(|i| {
                let mut row = rect_row(0.0);
                let e = [0, 1, 2, EDGE_ROW, EDGE_ROW | 3]
                    [tc.draw(gs::integers::<usize>().max_value(4))];
                row.rects[20..24].copy_from_slice(&e.to_ne_bytes());
                (i, row)
            })
            .collect();
        screen.apply(Update {
            rows: n,
            whole: true,
            changed,
            ..Update::default()
        });
        let by = tc.draw(
            gs::integers::<i32>()
                .min_value(-(n as i32))
                .max_value(n as i32),
        );
        screen.apply(Update {
            rows: n,
            scrolls: vec![(0, n, by)],
            ..Update::default()
        });
        let mut want = Vec::new();
        for (y, row) in screen.rows.iter().enumerate() {
            for e in edges_of(&row.data.rects) {
                let reach = if y == 0 { EDGE_TOP } else { 0 }
                    | if y + 1 == n as usize { EDGE_BOTTOM } else { 0 };
                want.push(if e & EDGE_ROW != 0 { e | reach } else { e });
            }
        }
        assert_eq!(edges_of(&screen.rects()), want);
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
