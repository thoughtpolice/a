// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A buffer's text: a rope ([`ropey`]), for core/text.sls.
//!
//! Positions are counted in characters (Unicode scalar values), as Chez
//! Scheme's strings count them, and a line ends at "\n" alone (ropey's
//! `cr_lines` and `unicode_lines` are off: see buck/third-party/rust's
//! Cargo.toml). Line n starts after the n-th newline, so text that ends in
//! one has an empty last line. Every edit and lookup takes time in the
//! logarithm of the text's size, where the gap buffer this replaces took
//! time in its number of lines.
//!
//! Positions and lines are clamped to the text, rather than panicking:
//! Scheme hands them over as they come.

pub mod search;

use ropey::Rope;

pub struct Text {
    rope: Rope,
    hashes: Option<LineHashes>,
}

/// The hashes of a text's lines (quad_diff's, for diffs against another
/// version), kept once asked for: an edit marks the lines it touched as
/// stale, and they alone are hashed again when next asked for.
struct LineHashes {
    hashes: Vec<u64>,
    stale: Vec<bool>,
    any_stale: bool,
}

impl Text {
    pub fn new(s: &str) -> Text {
        Text {
            rope: Rope::from_str(s),
            hashes: None,
        }
    }

    /// The file at `path`, as UTF-8, with what is not replaced by U+FFFD.
    pub fn read(path: &str) -> std::io::Result<Text> {
        let bytes = std::fs::read(path)?;
        Ok(Text::new(&String::from_utf8_lossy(&bytes)))
    }

    pub fn len(&self) -> usize {
        self.rope.len_chars()
    }

    /// The rope itself, for searches (search.rs) to read.
    pub fn rope(&self) -> &Rope {
        &self.rope
    }

    fn clamp(&self, pos: usize) -> usize {
        pos.min(self.len())
    }

    pub fn line_count(&self) -> usize {
        self.rope.len_lines()
    }

    /// Where `line` starts (the last line's start, past the last).
    pub fn line_start(&self, line: usize) -> usize {
        self.rope.line_to_char(line.min(self.line_count() - 1))
    }

    /// Where `line` ends: at its newline, or at the end of the text.
    pub fn line_end(&self, line: usize) -> usize {
        if line + 1 >= self.line_count() {
            self.len()
        } else {
            self.rope.line_to_char(line + 1) - 1
        }
    }

    /// The line `pos` is on.
    pub fn line_of(&self, pos: usize) -> usize {
        self.rope.char_to_line(self.clamp(pos))
    }

    /// The text from `start` to `end`.
    pub fn slice(&self, start: usize, end: usize) -> String {
        let end = self.clamp(end);
        let start = start.min(end);
        self.rope.slice(start..end).to_string()
    }

    pub fn insert(&mut self, pos: usize, s: &str) {
        let pos = self.clamp(pos);
        if let Some(h) = &mut self.hashes {
            let line = self.rope.char_to_line(pos);
            let added = s.matches('\n').count();
            h.stale[line] = true;
            h.hashes
                .splice(line + 1..line + 1, std::iter::repeat_n(0, added));
            h.stale
                .splice(line + 1..line + 1, std::iter::repeat_n(true, added));
            h.any_stale = true;
        }
        self.rope.insert(pos, s);
    }

    pub fn remove(&mut self, start: usize, end: usize) {
        let end = self.clamp(end);
        let start = start.min(end);
        if let Some(h) = &mut self.hashes {
            let (l1, l2) = (self.rope.char_to_line(start), self.rope.char_to_line(end));
            h.hashes.drain(l1 + 1..=l2);
            h.stale.drain(l1 + 1..=l2);
            h.stale[l1] = true;
            h.any_stale = true;
        }
        self.rope.remove(start..end);
    }

    /// Each line's hash (quad_diff::hash_line, without its newline): from
    /// now on, kept as the text is edited.
    pub fn line_hashes(&mut self) -> &[u64] {
        let rope = &self.rope;
        let hash = |line: ropey::RopeSlice| {
            let n = line.len_chars();
            let line = if n > 0 && line.char(n - 1) == '\n' {
                line.slice(..n - 1)
            } else {
                line
            };
            quad_diff::hash_line(line.chunks())
        };
        // All at first, in one pass; then the lines edits made stale.
        let h = self.hashes.get_or_insert_with(|| {
            let hashes: Vec<u64> = rope.lines().map(hash).collect();
            let n = hashes.len();
            LineHashes {
                hashes,
                stale: vec![false; n],
                any_stale: false,
            }
        });
        if h.any_stale {
            for (i, stale) in h.stale.iter_mut().enumerate() {
                if *stale {
                    h.hashes[i] = hash(rope.line(i));
                    *stale = false;
                }
            }
            h.any_stale = false;
        }
        &h.hashes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::TestCase;
    use hegel::generators as gs;

    /// The text as a string and the positions of its line starts, the way
    /// core/text.sls used to keep them: what the rope must agree with.
    struct Model(Vec<char>);

    impl Model {
        fn starts(&self) -> Vec<usize> {
            std::iter::once(0)
                .chain(
                    (0..self.0.len())
                        .filter(|&i| self.0[i] == '\n')
                        .map(|i| i + 1),
                )
                .collect()
        }
        fn string(&self) -> String {
            self.0.iter().collect()
        }
    }

    /// Text drawn from a few characters, newlines and wide ones among them,
    /// so that lines and matches come often.
    fn text(tc: &TestCase, max: usize) -> String {
        let alphabet = ['a', 'b', '\n', 'é', '日', '\r'];
        let n = tc.draw(gs::integers::<usize>().max_value(max));
        (0..n)
            .map(|_| alphabet[tc.draw(gs::integers::<usize>().max_value(alphabet.len() - 1))])
            .collect()
    }

    /// After any edits, lines, slices and searches agree with the model.
    #[hegel::test(test_cases = 300, database = None)]
    fn edits_and_lookups_agree_with_a_string(tc: TestCase) {
        let initial = text(&tc, 40);
        let mut t = Text::new(&initial);
        if tc.draw(gs::booleans()) {
            t.line_hashes();
        }
        let mut m = Model(initial.chars().collect());
        for _ in 0..tc.draw(gs::integers::<usize>().max_value(8)) {
            let len = m.0.len();
            let a = tc.draw(gs::integers::<usize>().max_value(len));
            if tc.draw(gs::booleans()) {
                let s = text(&tc, 6);
                t.insert(a, &s);
                m.0.splice(a..a, s.chars());
            } else {
                let b = tc.draw(gs::integers::<usize>().min_value(a).max_value(len));
                t.remove(a, b);
                m.0.drain(a..b);
            }
        }
        let starts = m.starts();
        // Hashes kept through the edits are a fresh text's.
        assert_eq!(t.line_hashes(), Text::new(&m.string()).line_hashes());
        assert_eq!(t.len(), m.0.len());
        assert_eq!(t.line_count(), starts.len());
        for (line, &s) in starts.iter().enumerate() {
            assert_eq!(t.line_start(line), s);
            let e = starts.get(line + 1).map_or(m.0.len(), |n| n - 1);
            assert_eq!(t.line_end(line), e);
        }
        for pos in 0..=m.0.len() {
            let line = starts.iter().rposition(|&s| s <= pos).unwrap();
            assert_eq!(t.line_of(pos), line, "line of {pos}");
        }
        assert_eq!(t.slice(0, m.0.len() + 3), m.string());
        let needle = text(&tc, 3);
        let n: Vec<char> = needle.chars().collect();
        let at = |i: usize| i + n.len() <= m.0.len() && m.0[i..i + n.len()] == n[..];
        let from = tc.draw(gs::integers::<usize>().max_value(m.0.len()));
        // The text itself, searched for (not a pattern).
        if !n.is_empty() {
            let found = search::Search::new(&needle, false, false)
                .unwrap()
                .next(&t, from, false)
                .map(|(start, _)| start);
            let want = (from..=m.0.len()).find(|&i| at(i));
            assert_eq!(found, want, "{needle:?} from {from}");
        }
    }

    #[test]
    fn lines_end_at_newlines_alone() {
        let t = Text::new("a\r\nb\rc\u{2028}d\n");
        assert_eq!(t.line_count(), 3);
        assert_eq!((t.line_start(1), t.line_end(1)), (3, 8));
        assert_eq!(t.line_start(9), 9);
        assert_eq!(Text::new("").line_count(), 1);
    }
}
