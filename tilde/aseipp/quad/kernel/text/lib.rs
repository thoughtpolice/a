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
}

impl Text {
    pub fn new(s: &str) -> Text {
        Text {
            rope: Rope::from_str(s),
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
        self.rope.insert(pos, s);
    }

    pub fn remove(&mut self, start: usize, end: usize) {
        let end = self.clamp(end);
        let start = start.min(end);
        self.rope.remove(start..end);
    }

    /// Where `needle` first occurs at or after `from`.
    pub fn find_forward(&self, needle: &str, from: usize) -> Option<usize> {
        let needle: Vec<char> = needle.chars().collect();
        if needle.is_empty() || from + needle.len() > self.len() {
            return None;
        }
        let end = kmp(&needle, self.rope.chars_at(from))?;
        Some(from + end + 1 - needle.len())
    }

    /// Where `needle` last occurs starting at or before `from`.
    pub fn find_backward(&self, needle: &str, from: usize) -> Option<usize> {
        let mut needle: Vec<char> = needle.chars().collect();
        let m = needle.len();
        if m == 0 || m > self.len() {
            return None;
        }
        // The match ending last, at or before from + m: KMP over the
        // text before that, read backwards, for the needle reversed.
        let last_end = from.min(self.len() - m) + m;
        needle.reverse();
        let back = kmp(&needle, self.rope.chars_at(last_end).reversed())?;
        Some(last_end - back - 1)
    }
}

/// Knuth-Morris-Pratt: the index in `haystack` of the last character of
/// the first occurrence of `needle` (not empty) in it.
fn kmp(needle: &[char], haystack: impl Iterator<Item = char>) -> Option<usize> {
    // fail[i]: the length of the longest proper prefix of needle[..=i]
    // that is also its suffix.
    let mut fail = vec![0; needle.len()];
    let mut k = 0;
    for i in 1..needle.len() {
        while k > 0 && needle[i] != needle[k] {
            k = fail[k - 1];
        }
        if needle[i] == needle[k] {
            k += 1;
        }
        fail[i] = k;
    }
    let mut k = 0;
    for (i, c) in haystack.enumerate() {
        while k > 0 && c != needle[k] {
            k = fail[k - 1];
        }
        if c == needle[k] {
            k += 1;
        }
        if k == needle.len() {
            return Some(i);
        }
    }
    None
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
        let want_forward = if n.is_empty() {
            None
        } else {
            (from..=m.0.len()).find(|&i| at(i))
        };
        assert_eq!(
            t.find_forward(&needle, from),
            want_forward,
            "{needle:?} from {from}"
        );
        let want_backward = if n.is_empty() || n.len() > m.0.len() {
            None
        } else {
            (0..=from.min(m.0.len() - n.len())).rev().find(|&i| at(i))
        };
        assert_eq!(
            t.find_backward(&needle, from),
            want_backward,
            "{needle:?} back from {from}"
        );
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
