// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

//! Dictionary mutators, `di` and `dr`, beyond radamsa.
//!
//! A dictionary holds tokens the data is likely to contain: keywords, magic
//! numbers, or values a coverage-guided fuzzer saw the target compare
//! against. Splicing one in can get past a check that random edits would
//! take millions of tries to satisfy. The tokens come from
//! [`Config::dictionary`](crate::Config::dictionary) and
//! [`Kermit::dictionary_mut`](crate::Kermit::dictionary_mut).

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
    fn no_tokens_no_change() {
        let mut block = b"abc".to_vec();
        assert_eq!(insert(&mut Script::new(&[]), &mut block, &[]), -1);
        assert_eq!(overwrite(&mut Script::new(&[]), &mut block, &[]), -1);
        assert_eq!(block, b"abc");
    }
}
