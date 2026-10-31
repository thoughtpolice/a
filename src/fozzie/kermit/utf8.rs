// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! UTF-8 mutators, radamsa's `uw` and `ui`.

use crate::source::Source;

/// Byte sequences that text handling often gets wrong: direction overrides,
/// invisible joiners, noncharacters, lone surrogates, byte order marks,
/// strings that grow under normalization, and an encoding past U+10FFFF.
/// Some are deliberately invalid UTF-8.
const FUNNY_BYTES: &[&[u8]] = &[
    b"\xe2\x80\xae",     // U+202E right-to-left override
    b"\xe2\x80\xad",     // U+202D left-to-right override
    b"\xe1\xa0\x8e",     // U+180E Mongolian vowel separator
    b"\xe2\x81\xa0",     // U+2060 word joiner
    b"\xef\xbb\xbe",     // U+FEFE reserved
    b"\xef\xbf\xbf",     // U+FFFF not a character
    b"\xe0\xbf\xad",     // U+0FED unassigned
    b"\xed\xba\xad",     // U+DEAD lone low surrogate
    b"\xed\xaa\xad",     // U+DAAD lone high surrogate
    b"\xef\xa3\xbf",     // U+F8FF private use (Apple)
    b"\xef\xbc\x8f",     // U+FF0F full-width solidus
    b"\xf0\x9d\x9f\x96", // U+1D7D6 mathematical bold digit eight
    b"\xc3\x9f",         // U+00DF IDNA deviation
    b"\xef\xb7\xba",     // U+FDFD grows 11x (UTF-8) and 18x (UTF-16) under NFKC
    b"\xce\x90",         // U+0390 grows 3x (UTF-8) under NFD
    b"\xe1\xbe\x82",     // U+1F82 grows 4x (UTF-16) under NFD
    b"\xef\xac\xac",     // U+FB2C grows 3x (UTF-16) under NFC
    b"\xf0\x9d\x85\xa0", // U+1D160 grows 3x (UTF-8) under NFC
    b"\xf4\x8f\xbf\xbe", // U+10FFFE, a noncharacter at the top of the range
    b"\xef\xbf\xbf",     // U+FFFF again: 65535
    b"\xf0\x90\x80\x80", // U+10000: 65536
    b"\xef\xbb\xbf",     // UTF-8 byte order mark
    b"\xfe\xff",         // UTF-16 big-endian byte order mark
    b"\xff\xfe",         // UTF-16 little-endian byte order mark
    b"\0\0\xff\xff",
    b"\xff\xff\0\0",
    b"+/v8", // UTF-7 byte order marks
    b"+/v9",
    b"+/v+",
    b"+/v/",
    b"\xf7\x64\x4c", // UTF-1, UTF-EBCDIC, SCSU, BOCU-1 and GB-18030 marks
    b"\xdd\x73\x66\x73",
    b"\x0e\xfe\xff",
    b"\xfb\xee\x28",
    b"\xfb\xee\x28\xff",
    b"\x84\x31\x95\x33",
];

/// Code points, single and inclusive ranges, inserted as valid UTF-8:
/// whitespace and separators, bidirectional controls, zero-width and
/// combining characters, fillers, tags, Thai vowels and U+1F4A9.
const FUNNY_CODE_POINTS: &[(u32, u32)] = &[
    (0x0009, 0x000d),
    (0x00a0, 0x00a0),
    (0x1680, 0x1680),
    (0x180e, 0x180e),
    (0x2000, 0x200a),
    (0x2028, 0x2028),
    (0x2029, 0x2029),
    (0x202f, 0x202f),
    (0x205f, 0x205f),
    (0x3000, 0x3000),
    (0x200e, 0x200f),
    (0x202a, 0x202e),
    (0x200c, 0x200d),
    (0x0345, 0x0345),
    (0x00b7, 0x00b7),
    (0x02d0, 0x02d1),
    (0xff70, 0xff70),
    (0x02b0, 0x02b8),
    (0xfdd0, 0xfdd0),
    (0x034f, 0x034f),
    (0x115f, 0x1160),
    (0x2065, 0x2069),
    (0x3164, 0x3164),
    (0xffa0, 0xffa0),
    (0xe0001, 0xe0001),
    (0xe0020, 0xe007f),
    (0x0e40, 0x0e44),
    (0x1f4a9, 0x1f4a9),
];

/// Re-encodes a byte below 0x40 as an overlong two-byte sequence, which a
/// length calculation or a validating decoder may mishandle. A wider byte
/// is left alone.
pub fn widen<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let at = source.below(block.len());
    let delta = source.delta();
    if let Some(&byte) = block.get(at)
        && byte < 0x40
    {
        block.splice(at..=at, [0xc0, byte | 0x80]);
    }
    delta
}

/// Inserts one funny sequence before a random byte. Like `bi`, this also
/// grows an empty block.
pub fn insert<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let at = source.below(block.len());
    let delta = source.delta();
    let sequence = funny(source.below(funny_count()));
    block.splice(at..at, sequence);
    delta
}

fn funny_count() -> usize {
    FUNNY_BYTES.len()
        + FUNNY_CODE_POINTS
            .iter()
            .map(|(low, high)| (high - low + 1) as usize)
            .sum::<usize>()
}

/// The `index`th funny sequence. The raw byte sequences come first, then
/// each code point in table order.
fn funny(mut index: usize) -> Vec<u8> {
    if let Some(bytes) = FUNNY_BYTES.get(index) {
        return bytes.to_vec();
    }
    index -= FUNNY_BYTES.len();
    for &(low, high) in FUNNY_CODE_POINTS {
        let len = (high - low + 1) as usize;
        if index < len {
            let point = char::from_u32(low + index as u32).expect("the table holds scalar values");
            return point.to_string().into_bytes();
        }
        index -= len;
    }
    unreachable!("index below funny_count()")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    #[test]
    fn widen_makes_an_overlong_encoding() {
        let mut block = b"a/b".to_vec();
        widen(&mut Script::new(&[1]), &mut block);
        assert_eq!(block, b"a\xc0\xafb");
        let mut wide = b"z".to_vec();
        widen(&mut Script::new(&[0]), &mut wide);
        assert_eq!(wide, b"z");
    }

    #[test]
    fn insert_uses_both_tables() {
        let mut block = b"ab".to_vec();
        insert(&mut Script::new(&[1, 0, 0]), &mut block);
        assert_eq!(block, b"a\xe2\x80\xaeb");
        let last = funny_count() - 1;
        let mut empty = Vec::new();
        insert(&mut Script::new(&[0, 0, last]), &mut empty);
        assert_eq!(empty, "\u{1f4a9}".as_bytes());
    }

    #[test]
    fn every_code_point_entry_encodes() {
        for index in FUNNY_BYTES.len()..funny_count() {
            assert!(std::str::from_utf8(&funny(index)).is_ok());
        }
    }
}
