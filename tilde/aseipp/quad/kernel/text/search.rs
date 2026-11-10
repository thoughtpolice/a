// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Searching a buffer's text (lib.rs) for a pattern: a regular expression,
//! or literal text, run over the rope where it is ([`regex_cursor`]: the
//! `regex` crate's engines, reading a rope's chunks), never copied out.
//!
//! The syntax is the `regex` crate's. `^` and `$` match at the start and
//! end of each line; with `fold`, case is ignored. Positions are the text's
//! (characters), as are the matches given back.

use regex_cursor::engines::meta::Regex;
use regex_cursor::regex_automata::util::syntax;
use regex_cursor::{Input, RopeyCursor};

use crate::Text;

pub struct Search {
    regex: Regex,
}

/// The bytes before a position searched first for the match nearest
/// before it; doubled until one is found.
const BACK_WINDOW: usize = 64 * 1024;

impl Search {
    /// A search for `pattern`: a regular expression if `regex`, else the
    /// text itself.
    pub fn new(pattern: &str, regex: bool, fold: bool) -> Result<Search, String> {
        let pattern = if regex {
            pattern.to_string()
        } else {
            regex::escape(pattern)
        };
        Regex::builder()
            .syntax(
                syntax::Config::new()
                    .case_insensitive(fold)
                    .multi_line(true),
            )
            .build(&pattern)
            .map(|regex| Search { regex })
            .map_err(|e| e.to_string())
    }

    /// The first match in bytes `start..end` of `t`, in bytes.
    fn find(&self, t: &Text, start: usize, end: usize) -> Option<(usize, usize)> {
        let rope = t.rope();
        let input = Input::new(RopeyCursor::at(rope.slice(..), start)).range(start..end);
        self.regex.find(input).map(|m| (m.start(), m.end()))
    }

    fn chars(t: &Text, (s, e): (usize, usize)) -> (usize, usize) {
        (t.rope().byte_to_char(s), t.rope().byte_to_char(e))
    }

    /// The first match starting at or after `pos`; with `wrap`, else the
    /// first in the text.
    pub fn next(&self, t: &Text, pos: usize, wrap: bool) -> Option<(usize, usize)> {
        let rope = t.rope();
        let len = rope.len_bytes();
        let at = rope.char_to_byte(pos.min(t.len()));
        self.find(t, at, len)
            .or_else(|| wrap.then(|| self.find(t, 0, len)).flatten())
            .map(|m| Self::chars(t, m))
    }

    /// The match starting nearest before `pos`, or at it: of every place a
    /// match starts, overlapping or not. With `wrap`, else the last in the
    /// text.
    pub fn prev(&self, t: &Text, pos: usize, wrap: bool) -> Option<(usize, usize)> {
        let len = t.rope().len_bytes();
        let at = t.rope().char_to_byte(pos.min(t.len()));
        self.last_starting_by(t, at)
            .or_else(|| wrap.then(|| self.last_starting_by(t, len)).flatten())
            .map(|m| Self::chars(t, m))
    }

    /// The match whose start is the last at or before byte `at`.
    fn last_starting_by(&self, t: &Text, at: usize) -> Option<(usize, usize)> {
        let len = t.rope().len_bytes();
        let mut window = BACK_WINDOW;
        loop {
            let from = at.saturating_sub(window);
            let mut last = None;
            let mut start = from;
            // Every start, not just the matches a scan forwards takes: the
            // next search begins a byte past the last match's start.
            while start <= at {
                match self.find(t, start, len) {
                    Some(m) if m.0 <= at => {
                        last = Some(m);
                        start = m.0 + 1;
                    }
                    _ => break,
                }
            }
            if last.is_some() || from == 0 {
                return last;
            }
            window *= 2;
        }
    }

    /// Every match from `start` to `end` (characters), left to right and
    /// apart, as (start, end).
    pub fn all(&self, t: &Text, start: usize, end: usize) -> Vec<(usize, usize)> {
        let rope = t.rope();
        let s = rope.char_to_byte(start.min(t.len()));
        let e = rope.char_to_byte(end.min(t.len()));
        let input = Input::new(RopeyCursor::at(rope.slice(..), s)).range(s..e);
        self.regex
            .find_iter(input)
            .map(|m| Self::chars(t, (m.start(), m.end())))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::TestCase;
    use hegel::generators as gs;

    #[test]
    fn literal_text_is_not_a_pattern() {
        let t = Text::new("a.b (c) a*b\n");
        let s = Search::new("a*b", false, false).unwrap();
        assert_eq!(s.next(&t, 0, false), Some((8, 11)));
        let s = Search::new("(c)", false, false).unwrap();
        assert_eq!(s.next(&t, 0, false), Some((4, 7)));
    }

    #[test]
    fn patterns_lines_and_case() {
        let t = Text::new("Foo bar\nfoo baz\n日本 foo\n");
        let re = Search::new(r"^foo", true, false).unwrap();
        assert_eq!(re.next(&t, 0, false), Some((8, 11)));
        let folded = Search::new(r"^foo", true, true).unwrap();
        assert_eq!(folded.next(&t, 0, false), Some((0, 3)));
        // Positions are characters, past the wide ones too.
        let any = Search::new("foo", false, false).unwrap();
        assert_eq!(any.prev(&t, 100, false), Some((19, 22)));
        assert_eq!(any.all(&t, 0, t.len()), vec![(8, 11), (19, 22)]);
        assert!(Search::new("(", true, false).is_err());
    }

    #[test]
    fn searches_wrap_when_asked() {
        let t = Text::new("one two one");
        let s = Search::new("one", false, false).unwrap();
        assert_eq!(s.next(&t, 1, false), Some((8, 11)));
        assert_eq!(s.next(&t, 9, false), None);
        assert_eq!(s.next(&t, 9, true), Some((0, 3)));
        assert_eq!(s.prev(&t, 7, false), Some((0, 3)));
        assert_eq!(s.prev(&t, 0, false), Some((0, 3)));
        let none_before = Text::new("xx one");
        assert_eq!(s.prev(&none_before, 1, true), Some((3, 6)));
    }

    /// Literal searches agree with looking at every position, both ways,
    /// over texts longer than the window searched backwards first.
    #[hegel::test(test_cases = 100, database = None)]
    fn literal_searches_agree_with_looking_everywhere(tc: TestCase) {
        let alphabet = ['a', 'b', '\n', 'é'];
        let n = tc.draw(gs::integers::<usize>().max_value(300));
        let mut text: String = (0..n)
            .map(|_| alphabet[tc.draw(gs::integers::<usize>().max_value(3))])
            .collect();
        // Sometimes far more, so that a search back widens its window.
        if tc.draw(gs::booleans()) {
            text = "b".repeat(BACK_WINDOW + 7) + &text;
        }
        let chars: Vec<char> = text.chars().collect();
        let needle: String = (0..tc.draw(gs::integers::<usize>().min_value(1).max_value(3)))
            .map(|_| alphabet[tc.draw(gs::integers::<usize>().max_value(3))])
            .collect();
        let nc: Vec<char> = needle.chars().collect();
        let t = Text::new(&text);
        let s = Search::new(&needle, false, false).unwrap();
        let at = |i: usize| i + nc.len() <= chars.len() && chars[i..i + nc.len()] == nc[..];
        let pos = tc.draw(gs::integers::<usize>().max_value(chars.len()));
        let want_next = (pos..=chars.len())
            .find(|&i| at(i))
            .map(|i| (i, i + nc.len()));
        assert_eq!(s.next(&t, pos, false), want_next);
        let want_prev = (0..=pos).rev().find(|&i| at(i)).map(|i| (i, i + nc.len()));
        assert_eq!(s.prev(&t, pos, false), want_prev);
    }
}
