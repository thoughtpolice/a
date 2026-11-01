// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

//! Dictionary mutators, `di` and `dr`, beyond radamsa.
//!
//! A dictionary holds tokens the data is likely to contain: keywords, magic
//! numbers, or values a coverage-guided fuzzer saw the target compare
//! against. Splicing one in can get past a check that random edits would
//! take millions of tries to satisfy. The tokens come from
//! [`Config::dictionary`](crate::Config::dictionary) and
//! [`Kermit::dictionary_mut`](crate::Kermit::dictionary_mut), and
//! [`parse_dictionary`](crate::parse_dictionary) reads them from the
//! dictionary files AFL and libFuzzer use.

use crate::ParseError;
use crate::source::Source;

/// Inserts a token before a random byte, or at the end.
pub fn insert<S: Source>(source: &mut S, block: &mut Vec<u8>, tokens: &[Vec<u8>]) -> i8 {
    let Some(token) = pick(source, tokens) else {
        return -1;
    };
    let at = source.below(block.len() + 1);
    block.splice(at..at, token.iter().copied());
    source.delta_up()
}

/// Overwrites bytes at a random position with a token, growing the block
/// when the token runs past its end.
pub fn overwrite<S: Source>(source: &mut S, block: &mut Vec<u8>, tokens: &[Vec<u8>]) -> i8 {
    let Some(token) = pick(source, tokens) else {
        return -1;
    };
    let at = source.below(block.len() + 1);
    let end = (at + token.len()).min(block.len());
    block.splice(at..end, token.iter().copied());
    source.delta_up()
}

/// Parses an AFL or libFuzzer dictionary. Each line holds a token in
/// double quotes, optionally after a name and an `@level`, as in
/// `kw_get@1="GET"`. AFL reads the level and kermit ignores it. Blank
/// lines and lines starting with `#` are skipped. Inside the quotes `\\`, `\"` and `\xHH` stand for a backslash, a quote
/// and the byte `HH`; other bytes stand for themselves.
pub fn parse(text: &[u8]) -> Result<Vec<Vec<u8>>, ParseError> {
    let mut tokens = Vec::new();
    for (index, line) in text.split(|&byte| byte == b'\n').enumerate() {
        let line = line.trim_ascii();
        if line.is_empty() || line.starts_with(b"#") {
            continue;
        }
        let error = |why: &str| ParseError(format!("line {}: {why}", index + 1));
        let open = line
            .iter()
            .position(|&byte| byte == b'"')
            .ok_or_else(|| error("expected a token in double quotes"))?;
        let name = match line[..open].trim_ascii_end() {
            [] => Some(&[][..]),
            name => name.strip_suffix(b"=").map(<[u8]>::trim_ascii_end),
        };
        let name_byte = |byte: &u8| byte.is_ascii_alphanumeric() || b"_@.-".contains(byte);
        if !name.is_some_and(|name| name.iter().all(name_byte)) {
            return Err(error("expected `name=\"token\"` or `\"token\"`"));
        }
        tokens.push(unescape(&line[open + 1..]).map_err(error)?);
    }
    Ok(tokens)
}

/// Decodes a quoted token up to its closing quote, which must end the line.
fn unescape(quoted: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::new();
    let mut bytes = quoted.iter().copied();
    loop {
        match bytes.next().ok_or("the token has no closing quote")? {
            b'"' => break,
            b'\\' => match bytes.next() {
                Some(byte @ (b'\\' | b'"')) => out.push(byte),
                Some(b'x') => {
                    let digits = [bytes.next(), bytes.next()];
                    let value = match digits {
                        [Some(high), Some(low)] => std::str::from_utf8(&[high, low])
                            .ok()
                            .and_then(|hex| u8::from_str_radix(hex, 16).ok()),
                        _ => None,
                    };
                    out.push(value.ok_or("`\\x` needs two hex digits")?);
                }
                _ => return Err("unknown escape, expected `\\\\`, `\\\"` or `\\xHH`"),
            },
            byte => out.push(byte),
        }
    }
    if bytes.next().is_some() {
        return Err("text after the closing quote");
    }
    Ok(out)
}

fn pick<'a, S: Source>(source: &mut S, tokens: &'a [Vec<u8>]) -> Option<&'a [u8]> {
    (!tokens.is_empty()).then(|| tokens[source.below(tokens.len())].as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    #[test]
    fn splices_tokens() {
        let tokens = [b"MAGIC".to_vec(), b"<?xml".to_vec()];
        let mut block = b"abc".to_vec();
        insert(&mut Script::new(&[0, 3]), &mut block, &tokens);
        assert_eq!(block, b"abcMAGIC");
        let mut block = b"abcdefgh".to_vec();
        overwrite(&mut Script::new(&[1, 2]), &mut block, &tokens);
        assert_eq!(block, b"ab<?xmlh");
        let mut block = b"ab".to_vec();
        overwrite(&mut Script::new(&[0, 1]), &mut block, &tokens);
        assert_eq!(block, b"aMAGIC");
    }

    #[test]
    fn parses_dictionary_files() {
        let text = br#"
# HTTP
kw_get="GET"
kw_ver@2 = "HTTP/1.1"
"\x00\xFFq\"\\"
=""
"#;
        assert_eq!(
            parse(text).unwrap(),
            [&b"GET"[..], b"HTTP/1.1", b"\x00\xffq\"\\", b""]
        );
        for (text, error) in [
            (&b"GET"[..], "line 1: expected a token in double quotes"),
            (
                b"\nkw \"GET\"",
                "line 2: expected `name=\"token\"` or `\"token\"`",
            ),
            (
                b"k!=\"x\"",
                "line 1: expected `name=\"token\"` or `\"token\"`",
            ),
            (b"\"open", "line 1: the token has no closing quote"),
            (b"\"\\x4\"", "line 1: `\\x` needs two hex digits"),
            (
                b"\"\\n\"",
                "line 1: unknown escape, expected `\\\\`, `\\\"` or `\\xHH`",
            ),
            (b"\"a\" b", "line 1: text after the closing quote"),
        ] {
            assert_eq!(parse(text).unwrap_err().to_string(), error);
        }
    }

    #[test]
    fn no_tokens_no_change() {
        let mut block = b"abc".to_vec();
        assert_eq!(insert(&mut Script::new(&[]), &mut block, &[]), -1);
        assert_eq!(overwrite(&mut Script::new(&[]), &mut block, &[]), -1);
        assert_eq!(block, b"abc");
    }
}
