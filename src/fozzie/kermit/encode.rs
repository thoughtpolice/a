// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

//! The re-encoding mutator, `ec`, beyond radamsa.
//!
//! Text often passes through layers that decode it: URLs, HTML, string
//! escapes, Unicode normalization, case folding. Bugs hide where one layer
//! decodes what another already checked, or where two disagree about an
//! encoding. `ec` re-encodes a run of text in one of those encodings.

use crate::source::Source;
use crate::text::{self, Chunk};

#[derive(Clone, Copy, Debug)]
enum Encoding {
    Percent,
    DoublePercent,
    HtmlDecimal,
    HtmlHex,
    UnicodeEscape,
    HexEscape,
    OctalEscape,
    Fullwidth,
    SwapCase,
    Utf16Le,
    Overlong,
}

const ENCODINGS: [Encoding; 11] = [
    Encoding::Percent,
    Encoding::DoublePercent,
    Encoding::HtmlDecimal,
    Encoding::HtmlHex,
    Encoding::UnicodeEscape,
    Encoding::HexEscape,
    Encoding::OctalEscape,
    Encoding::Fullwidth,
    Encoding::SwapCase,
    Encoding::Utf16Le,
    Encoding::Overlong,
];

/// Re-encodes a run of bytes in a text run or quoted string. Data that does
/// not start with text is refused, as by `ab`.
pub fn mutate<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let mut chunks = text::lex(block);
    if matches!(chunks.first(), None | Some(Chunk::Raw(_))) {
        return -1;
    }
    let texty: Vec<usize> = (0..chunks.len())
        .filter(|&index| {
            !matches!(chunks[index], Chunk::Raw(_)) && !chunk_bytes(&chunks[index]).is_empty()
        })
        .collect();
    if texty.is_empty() {
        return -1;
    }
    let chunk = texty[source.below(texty.len())];
    let bytes = match &mut chunks[chunk] {
        Chunk::Text(bytes) | Chunk::Quoted(_, bytes) => bytes,
        Chunk::Raw(_) => unreachable!("raw chunks were filtered out"),
    };
    let start = source.below(bytes.len());
    let end = source.range(start + 1, bytes.len() + 1);
    let encoding = ENCODINGS[source.below(ENCODINGS.len())];
    let encoded = encode(encoding, &bytes[start..end]);
    bytes.splice(start..end, encoded);
    *block = text::unlex(&chunks);
    source.delta_up()
}

fn chunk_bytes(chunk: &Chunk) -> &[u8] {
    match chunk {
        Chunk::Raw(bytes) | Chunk::Text(bytes) | Chunk::Quoted(_, bytes) => bytes,
    }
}

fn encode(encoding: Encoding, run: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for &byte in run {
        match encoding {
            Encoding::Percent => out.extend(format!("%{byte:02X}").bytes()),
            Encoding::DoublePercent => out.extend(format!("%25{byte:02X}").bytes()),
            Encoding::HtmlDecimal => out.extend(format!("&#{byte};").bytes()),
            Encoding::HtmlHex => out.extend(format!("&#x{byte:x};").bytes()),
            Encoding::UnicodeEscape => out.extend(format!("\\u{byte:04x}").bytes()),
            Encoding::HexEscape => out.extend(format!("\\x{byte:02x}").bytes()),
            Encoding::OctalEscape => out.extend(format!("\\{byte:03o}").bytes()),
            // U+FF01 to U+FF5E mirror ASCII 0x21 to 0x7e, and NFKC folds
            // them back.
            Encoding::Fullwidth => match byte {
                0x21..=0x7e => {
                    let point = char::from_u32(0xff01 + u32::from(byte - 0x21))
                        .expect("fullwidth forms are scalar values");
                    out.extend(point.to_string().bytes());
                }
                _ => out.push(byte),
            },
            Encoding::SwapCase => out.push(if byte.is_ascii_uppercase() {
                byte.to_ascii_lowercase()
            } else {
                byte.to_ascii_uppercase()
            }),
            Encoding::Utf16Le => out.extend([byte, 0]),
            // A two-byte encoding of a one-byte character, which strict
            // decoders reject and lenient ones accept.
            Encoding::Overlong => out.extend([0xc0 | byte >> 6, 0x80 | (byte & 0x3f)]),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    #[test]
    fn encodes_in_each_scheme() {
        let cases: [(Encoding, &[u8]); 11] = [
            (Encoding::Percent, b"%3C%2F"),
            (Encoding::DoublePercent, b"%253C%252F"),
            (Encoding::HtmlDecimal, b"&#60;&#47;"),
            (Encoding::HtmlHex, b"&#x3c;&#x2f;"),
            (Encoding::UnicodeEscape, b"\\u003c\\u002f"),
            (Encoding::HexEscape, b"\\x3c\\x2f"),
            (Encoding::OctalEscape, b"\\074\\057"),
            (Encoding::Fullwidth, "\u{ff1c}\u{ff0f}".as_bytes()),
            (Encoding::SwapCase, b"</"),
            (Encoding::Utf16Le, b"<\0/\0"),
            (Encoding::Overlong, b"\xc0\xbc\xc0\xaf"),
        ];
        for (encoding, expected) in cases {
            assert_eq!(encode(encoding, b"</"), expected, "{encoding:?}");
        }
        assert_eq!(encode(Encoding::SwapCase, b"aBc1"), b"AbC1");
    }

    #[test]
    fn re_encodes_a_run_inside_text() {
        // The text chunk, bytes 5 up to 6 + 2 = 8, percent-encoded.
        let mut block = b"path=../x".to_vec();
        mutate(&mut Script::new(&[0, 5, 2, 0]), &mut block);
        assert_eq!(block, b"path=%2E%2E%2Fx");
        // Inside a quoted string the quotes stay put.
        let mut quoted = b"say 'hi'".to_vec();
        mutate(&mut Script::new(&[1, 0, 1, 8]), &mut quoted);
        assert_eq!(quoted, b"say 'HI'");
    }

    #[test]
    fn binary_data_is_refused() {
        let mut block = b"\x00\x01data".to_vec();
        assert_eq!(mutate(&mut Script::new(&[]), &mut block), -1);
        assert_eq!(block, b"\x00\x01data");
    }
}
