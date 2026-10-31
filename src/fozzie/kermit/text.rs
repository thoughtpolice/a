// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! The ASCII string mutator, radamsa's `ab`.
//!
//! A lexer splits a block into raw bytes, text runs and quoted strings. The
//! mutator then picks a text run or the inside of a quoted string and puts
//! trouble there: format directives, shell metacharacters, escape sequences,
//! a long run of `a`s, or a trailing NUL.

use crate::source::Source;

/// How many text bytes in a row start a text run. Shorter runs stay raw.
const MIN_TEXT: usize = 6;

/// Strings that commonly break text handling.
const SILLY: &[&[u8]] = &[
    b"%n",
    b"%n",
    b"%s",
    b"%d",
    b"%p",
    b"%#x",
    b"\\0",
    b"aaaa%d%n",
    b"`xcalc`",
    b";xcalc",
    b"$(xcalc)",
    b"!xcalc",
    b"\"xcalc",
    b"'xcalc",
    b"\\x00",
    b"\\r\\n",
    b"\\r",
    b"\\n",
    b"\\x0a",
    b"\\x0d",
    b"NaN",
    b"+inf",
    b"$PATH",
    b"$!!",
    b"!!",
    b"&#000;",
    b"\\u0000",
    b"$&",
    b"$+",
    b"$`",
    b"$'",
    b"$1",
];

/// Lengths of `a` runs at signed and unsigned 8-, 14-, 15- and 16-bit
/// boundaries.
const RUN_LENGTHS: [usize; 10] = [127, 128, 255, 256, 16383, 16384, 32767, 32768, 65535, 65536];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Chunk {
    /// Bytes that do not look like text.
    Raw(Vec<u8>),
    /// Printable ASCII, tabs and line breaks.
    Text(Vec<u8>),
    /// A quoted string, as its quote byte and the bytes between the quotes.
    Quoted(u8, Vec<u8>),
}

/// Puts trouble into a text run or quoted string of `block`. Data that does
/// not start with text is refused.
pub fn mutate<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let mut chunks = lex(block);
    if matches!(chunks.first(), None | Some(Chunk::Raw(_))) {
        return -1;
    }
    // radamsa draws chunks until it finds one that is not raw; drawing among
    // the others directly has the same distribution and always finishes.
    let texty: Vec<usize> = chunks
        .iter()
        .enumerate()
        .filter(|(_, chunk)| !matches!(chunk, Chunk::Raw(_)))
        .map(|(i, _)| i)
        .collect();
    match &mut chunks[texty[source.below(texty.len())]] {
        Chunk::Text(bytes) | Chunk::Quoted(_, bytes) => trouble(source, bytes),
        Chunk::Raw(_) => unreachable!("raw chunks were filtered out"),
    }
    *block = unlex(&chunks);
    source.delta_up()
}

fn trouble<S: Source>(source: &mut S, bytes: &mut Vec<u8>) {
    match source.below(4) {
        0 => {
            let at = source.below(bytes.len());
            let bad = badness(source);
            bytes.splice(at..at, bad);
        }
        1 => {
            let at = source.below(bytes.len());
            let bad = badness(source);
            let end = (at + bad.len()).min(bytes.len());
            bytes.splice(at..end, bad);
        }
        2 => {
            let count = match source.below(11) {
                10 => source.below(1024),
                index => RUN_LENGTHS[index],
            };
            let at = source.below(bytes.len());
            bytes.splice(at..at, std::iter::repeat_n(b'a', count));
        }
        _ => bytes.push(0),
    }
}

/// One to twenty silly strings, concatenated.
fn badness<S: Source>(source: &mut S) -> Vec<u8> {
    let count = source.below(20) + 1;
    let mut out = Vec::new();
    for _ in 0..count {
        let silly = SILLY[source.below(SILLY.len())];
        out.splice(0..0, silly.iter().copied());
    }
    out
}

fn is_text(byte: u8) -> bool {
    matches!(byte, b'\t' | b'\n' | b'\r' | 0x20..=0x7e)
}

/// Whether `data` starts with `MIN_TEXT` text bytes, or is shorter and all
/// text.
fn starts_texty(data: &[u8]) -> bool {
    data.iter().take(MIN_TEXT).all(|&byte| is_text(byte))
}

/// Splits `data` into chunks that [`unlex`] reassembles exactly.
pub fn lex(data: &[u8]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut raw = Vec::new();
    let mut at = 0;
    while at < data.len() {
        if !starts_texty(&data[at..]) {
            raw.push(data[at]);
            at += 1;
            continue;
        }
        if !raw.is_empty() {
            chunks.push(Chunk::Raw(std::mem::take(&mut raw)));
        }
        at = lex_text(data, at, &mut chunks);
    }
    if !raw.is_empty() {
        chunks.push(Chunk::Raw(raw));
    }
    chunks
}

/// Lexes text from `at` up to the first byte that is not text, splitting out
/// quoted strings, and returns where it stopped.
fn lex_text(data: &[u8], mut at: usize, chunks: &mut Vec<Chunk>) -> usize {
    let mut text = Vec::new();
    while at < data.len() {
        let byte = data[at];
        if byte == b'"' || byte == b'\'' {
            match quoted(data, at) {
                Some((contents, end)) => {
                    if !text.is_empty() {
                        chunks.push(Chunk::Text(std::mem::take(&mut text)));
                    }
                    chunks.push(Chunk::Quoted(byte, contents));
                    // radamsa goes back to deciding between raw and text
                    // after a quoted string.
                    return end;
                }
                None => {
                    // Not a string after all. Keep the text up to where the
                    // string broke off, and resume lexing there.
                    let stop = quote_stop(data, at);
                    text.extend_from_slice(&data[at..stop]);
                    chunks.push(Chunk::Text(text));
                    return stop;
                }
            }
        }
        if !is_text(byte) {
            break;
        }
        text.push(byte);
        at += 1;
    }
    chunks.push(Chunk::Text(text));
    at
}

/// Scans the quoted string opened at `open`. Returns its contents and the
/// position after the closing quote, or `None` when a byte that is not text
/// or the end of the data comes first.
fn quoted(data: &[u8], open: usize) -> Option<(Vec<u8>, usize)> {
    let quote = data[open];
    let mut contents = Vec::new();
    let mut at = open + 1;
    while at < data.len() {
        let byte = data[at];
        if byte == quote {
            return Some((contents, at + 1));
        }
        if byte == b'\\' && data.get(at + 1).is_some_and(|&next| is_text(next)) {
            contents.extend_from_slice(&data[at..at + 2]);
            at += 2;
            continue;
        }
        if !is_text(byte) && byte != b'\\' {
            return None;
        }
        contents.push(byte);
        at += 1;
    }
    None
}

/// Where an unterminated string opened at `open` stops. That is the first
/// byte that is neither text nor an escape, or the end of the data.
fn quote_stop(data: &[u8], open: usize) -> usize {
    let mut at = open + 1;
    while at < data.len() {
        let byte = data[at];
        if byte == b'\\' && data.get(at + 1).is_some_and(|&next| is_text(next)) {
            at += 2;
        } else if is_text(byte) || byte == b'\\' {
            at += 1;
        } else {
            return at;
        }
    }
    data.len()
}

pub fn unlex(chunks: &[Chunk]) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in chunks {
        match chunk {
            Chunk::Raw(bytes) | Chunk::Text(bytes) => out.extend_from_slice(bytes),
            Chunk::Quoted(quote, bytes) => {
                out.push(*quote);
                out.extend_from_slice(bytes);
                out.push(*quote);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;
    use Chunk::*;

    #[test]
    fn lexes_text_strings_and_raw_bytes() {
        assert_eq!(
            lex(b"say \"hi \\\"x\\\"\" ok\x01\x02"),
            vec![
                Text(b"say ".to_vec()),
                Quoted(b'"', b"hi \\\"x\\\"".to_vec()),
                // Fewer than six text bytes before a raw one are raw.
                Raw(b" ok\x01\x02".to_vec()),
            ],
        );
        assert_eq!(
            lex(b"\x01abcdefgh"),
            vec![Raw(b"\x01".to_vec()), Text(b"abcdefgh".to_vec())]
        );
        // Too little text between raw bytes stays raw.
        assert_eq!(lex(b"\x01ab\x02"), vec![Raw(b"\x01ab\x02".to_vec())]);
    }

    #[test]
    fn unterminated_strings_are_text() {
        assert_eq!(lex(b"it's fine"), vec![Text(b"it's fine".to_vec())]);
        // The string breaks off at \x01, after six text bytes.
        assert_eq!(
            lex(b"say 'b\x01cdefgh"),
            vec![
                Text(b"say 'b".to_vec()),
                Raw(b"\x01".to_vec()),
                Text(b"cdefgh".to_vec())
            ]
        );
    }

    #[test]
    fn mutates_inside_a_string() {
        // Pick the quoted chunk, index 1 of the texty ones, and append a NUL.
        let mut block = b"x = 'abc'".to_vec();
        mutate(&mut Script::new(&[1, 3]), &mut block);
        assert_eq!(block, b"x = 'abc\0'");
    }

    #[test]
    fn inserts_and_overwrites_badness() {
        // Text chunk 0; insert at 1; two silly strings, %n then %s, each
        // prepended, so %s comes first.
        let mut block = b"hello".to_vec();
        mutate(&mut Script::new(&[0, 0, 1, 1, 0, 2]), &mut block);
        assert_eq!(block, b"h%s%nello");
        let mut over = b"hello".to_vec();
        mutate(&mut Script::new(&[0, 1, 1, 0, 2]), &mut over);
        assert_eq!(over, b"h%slo");
    }

    #[test]
    fn inserts_a_boundary_run_of_as() {
        let mut block = b"hello".to_vec();
        mutate(&mut Script::new(&[0, 2, 1, 4]), &mut block);
        assert!(block.starts_with(b"hell") && block.ends_with(b"ao"));
        assert_eq!(block.iter().filter(|&&byte| byte == b'a').count(), 128);
    }

    #[test]
    fn binary_starts_are_refused() {
        let mut block = b"\x00\x01text text".to_vec();
        assert_eq!(mutate(&mut Script::new(&[]), &mut block), -1);
        assert_eq!(block, b"\x00\x01text text");
    }
}
