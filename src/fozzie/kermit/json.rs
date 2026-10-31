// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

//! The JSON value mutator, `jv`, beyond radamsa.
//!
//! JSON parsers disagree at the edges: numbers past double precision or
//! 64 bits, `-0`, lone UTF-16 surrogates in escapes, nesting deep enough to
//! exhaust a recursive parser's stack. `jv` finds the JSON-ish values in a
//! block and replaces one with such a value, often of another type.

use crate::source::Source;
use std::ops::Range;

/// Replacements at JSON's edges, simplest first.
const AWKWARD: &[&[u8]] = &[
    b"",
    b"null",
    b"true",
    b"false",
    b"0",
    b"-0",
    b"\"\"",
    b"[]",
    b"{}",
    b"1e309",
    b"-1e309",
    b"1e-400",
    b"0.1e1",
    b"1E+2",
    b"00",
    b"0x10",
    b"NaN",
    b"Infinity",
    b"9007199254740993",
    b"-9223372036854775809",
    b"18446744073709551616",
    b"123456789012345678901234567890",
    b"\"\\ud800\"",
    b"\"\\udc00\\ud800\"",
    b"\"\\u0000\"",
    b"\"\\\"\"",
    b"\"\\",
    b"{\"\":null,\"\":null}",
    b"[1,]",
    b"{\"a\":1,}",
];

/// The deepest nesting and longest string `jv` makes: 64 KiB.
const MAX_LOG_SIZE: u32 = 17;

/// Replaces one JSON-ish value. Scores rise on blocks that start like
/// JSON, and fall on other text whose numbers and words look like values.
pub fn mutate<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let values = values(block);
    if values.is_empty() {
        return -1;
    }
    let range = values[source.below(values.len())].clone();
    let replacement = match source.below(AWKWARD.len() + 2) {
        index if index < AWKWARD.len() => AWKWARD[index].to_vec(),
        index => {
            let size = source.log(MAX_LOG_SIZE).max(1);
            if index == AWKWARD.len() {
                // Deep nesting: [[[...]]].
                [vec![b'['; size], vec![b']'; size]].concat()
            } else {
                [&b"\""[..], &vec![b'a'; size], b"\""].concat()
            }
        }
    };
    let looks_json = matches!(
        block.iter().find(|byte| !byte.is_ascii_whitespace()),
        Some(b'{' | b'[')
    );
    block.splice(range, replacement);
    if looks_json { 1 } else { -1 }
}

/// The byte ranges of strings, numbers and `true`, `false` and `null`.
/// Numbers and words count only where they stand alone, not inside a word.
fn values(data: &[u8]) -> Vec<Range<usize>> {
    let word =
        |byte: Option<&u8>| byte.is_some_and(|&byte| byte.is_ascii_alphanumeric() || byte == b'_');
    let mut out = Vec::new();
    let mut at = 0;
    while at < data.len() {
        let start = at;
        let alone = start == 0 || !word(data.get(start - 1));
        let end = match data[at] {
            b'"' => string_end(data, at),
            b'-' | b'0'..=b'9' if alone => number_end(data, at),
            b't' | b'f' | b'n' if alone => [&b"true"[..], b"false", b"null"]
                .iter()
                .find(|literal| {
                    data[at..].starts_with(literal) && !word(data.get(at + literal.len()))
                })
                .map(|literal| at + literal.len()),
            _ => None,
        };
        match end {
            Some(end) => {
                out.push(start..end);
                at = end;
            }
            None => at += 1,
        }
    }
    out
}

/// The end of the string opened at `at`, or `None` if it never closes.
fn string_end(data: &[u8], at: usize) -> Option<usize> {
    let mut end = at + 1;
    loop {
        match *data.get(end)? {
            b'\\' => end += 2,
            b'"' => return Some(end + 1),
            _ => end += 1,
        }
    }
}

/// The end of a number such as `-12.5e+3` starting at `at`.
fn number_end(data: &[u8], at: usize) -> Option<usize> {
    let digits = |from: usize| {
        from + data[from..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count()
    };
    let mut end = at + usize::from(data[at] == b'-');
    let integer = digits(end);
    if integer == end {
        return None;
    }
    end = integer;
    if data.get(end) == Some(&b'.') && digits(end + 1) > end + 1 {
        end = digits(end + 1);
    }
    if matches!(data.get(end), Some(b'e' | b'E')) {
        let sign = end + 1 + usize::from(matches!(data.get(end + 1), Some(b'+' | b'-')));
        if digits(sign) > sign {
            end = digits(sign);
        }
    }
    (!data
        .get(end)
        .is_some_and(|&byte| byte.is_ascii_alphanumeric() || byte == b'_'))
    .then_some(end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    fn found(data: &[u8]) -> Vec<&[u8]> {
        values(data).into_iter().map(|range| &data[range]).collect()
    }

    #[test]
    fn finds_values() {
        assert_eq!(
            found(br#"{"a": [1, -2.5e3, true], "b\"": null}"#),
            [
                &br#""a""#[..],
                b"1",
                b"-2.5e3",
                b"true",
                br#""b\"""#,
                b"null"
            ]
        );
        // Not inside words, and not unterminated.
        assert_eq!(found(b"x1 nullable 7up \"open"), Vec::<&[u8]>::new());
    }

    #[test]
    fn replaces_a_value_with_an_awkward_one() {
        let mut block = br#"{"n": 5}"#.to_vec();
        assert_eq!(mutate(&mut Script::new(&[1, 18]), &mut block), 1);
        assert_eq!(block, br#"{"n": 9007199254740993}"#);
        let mut block = br#"{"n": 5}"#.to_vec();
        mutate(&mut Script::new(&[0, 22]), &mut block);
        assert_eq!(block, br#"{"\ud800": 5}"#);
    }

    #[test]
    fn nests_deeply_or_writes_long_strings() {
        let mut block = b"[0]".to_vec();
        // Deep nesting of log width 3 plus offset 1: five levels.
        mutate(&mut Script::new(&[0, AWKWARD.len(), 3, 1]), &mut block);
        assert_eq!(block, b"[[[[[[]]]]]]");
        let mut block = b"[0]".to_vec();
        mutate(&mut Script::new(&[0, AWKWARD.len() + 1, 2, 0]), &mut block);
        assert_eq!(block, b"[\"aa\"]");
    }

    #[test]
    fn plain_text_scores_down() {
        let mut block = b"I have 3 apples".to_vec();
        assert_eq!(mutate(&mut Script::new(&[0, 4]), &mut block), -1);
        assert_eq!(block, b"I have 0 apples");
        assert_eq!(
            mutate(&mut Script::new(&[]), &mut b"no values".to_vec()),
            -1
        );
    }
}
