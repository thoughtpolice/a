// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Byte and byte-sequence mutators, radamsa's `bd`, `bf`, `bi`, `br`, `bp`,
//! `bei`, `bed`, `ber`, `sr` and `sd`.
//!
//! Each takes the block to mutate and returns its score step. The byte
//! mutators step at random. They work on any data, so their success says
//! little about whether the data suits them.

use crate::source::Source;

/// Removes one byte.
pub fn drop_byte<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let at = source.below(block.len());
    let delta = source.delta();
    if !block.is_empty() {
        block.remove(at);
    }
    delta
}

/// Adds one to a byte, wrapping.
pub fn increment<S: Source>(source: &mut S, block: &mut [u8]) -> i8 {
    edit(source, block, |_, byte| byte.wrapping_add(1))
}

/// Subtracts one from a byte, wrapping.
pub fn decrement<S: Source>(source: &mut S, block: &mut [u8]) -> i8 {
    edit(source, block, |_, byte| byte.wrapping_sub(1))
}

/// Flips one bit of a byte.
pub fn flip<S: Source>(source: &mut S, block: &mut [u8]) -> i8 {
    edit(source, block, |source, byte| byte ^ (1 << source.below(8)))
}

/// Replaces a byte with a random one.
pub fn randomize<S: Source>(source: &mut S, block: &mut [u8]) -> i8 {
    edit(source, block, |source, _| source.below(256) as u8)
}

/// Inserts a random byte before a random position. Unlike radamsa, this also
/// grows an empty block, so an empty seed still yields new inputs.
pub fn insert<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let at = source.below(block.len());
    let delta = source.delta();
    let byte = source.below(256) as u8;
    block.insert(at, byte);
    delta
}

/// Repeats one byte up to 128 KiB times, favouring short runs.
pub fn repeat<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let at = source.below(block.len());
    let delta = source.delta();
    let count = repeat_len(source);
    if let Some(&byte) = block.get(at) {
        block.splice(at..at, std::iter::repeat_n(byte, count));
    }
    delta
}

/// Permutes a run of 2 to 19 bytes.
pub fn permute<S: Source>(source: &mut S, block: &mut [u8]) -> i8 {
    let at = source.below(block.len());
    let delta = source.delta();
    let len = source.range(2, 20);
    if !block.is_empty() {
        let end = (at + len).min(block.len());
        source.shuffle(&mut block[at..end]);
    }
    delta
}

/// Repeats a byte sequence 2 to 1023 times in place.
pub fn repeat_sequence<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let len = block.len();
    if len < 2 {
        return 0;
    }
    let start = source.range(0, len - 1);
    let end = source.range(start + 1, len);
    let count = source.log(10).max(2);
    let delta = source.delta();
    let stutter = block[start..end].to_vec();
    let copies = stutter.iter().copied().cycle().take(stutter.len() * count);
    block.splice(start..end, copies);
    delta
}

/// Deletes a byte sequence that may run to the end of the block.
pub fn delete_sequence<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    crate::list::delete_run(source, block);
    source.delta()
}

/// Applies `change` to a random byte, drawing the position first and then
/// the score step, as radamsa does.
fn edit<S: Source>(source: &mut S, block: &mut [u8], change: impl FnOnce(&mut S, u8) -> u8) -> i8 {
    let at = source.below(block.len());
    let delta = source.delta();
    if let Some(byte) = block.get(at).copied() {
        block[at] = change(source, byte);
    }
    delta
}

/// A repeat count below 2^k, where k doubles from 1 with probability 1/2
/// per step up to 2^17.
fn repeat_len<S: Source>(source: &mut S) -> usize {
    let mut limit = 2;
    while source.below(2) != 0 && limit < 0x20000 {
        limit <<= 1;
    }
    source.below(limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    fn run(draws: &[usize], input: &[u8], f: fn(&mut Script, &mut Vec<u8>) -> i8) -> Vec<u8> {
        let mut block = input.to_vec();
        f(&mut Script::new(draws), &mut block);
        block
    }

    #[test]
    fn single_byte_edits() {
        assert_eq!(run(&[1], b"abc", drop_byte), b"ac");
        assert_eq!(run(&[2], b"abc", |s, b| increment(s, b)), b"abd");
        assert_eq!(run(&[0], b"\0bc", |s, b| decrement(s, b)), b"\xffbc");
        assert_eq!(run(&[0, 0, 5], b"\0", |s, b| flip(s, b)), b" ");
        assert_eq!(run(&[1, 0, 0x41], b"xy", |s, b| randomize(s, b)), b"xA");
        assert_eq!(run(&[1, 0, 0x41], b"xy", insert), b"xAy");
        assert_eq!(run(&[0, 0, 0x41], b"", insert), b"A");
    }

    #[test]
    fn empty_blocks_are_left_alone() {
        for f in [drop_byte, repeat, repeat_sequence, delete_sequence] {
            assert_eq!(run(&[], b"", f), b"");
        }
        assert_eq!(run(&[], b"", |s, b| flip(s, b)), b"");
    }

    #[test]
    fn repeat_adds_copies_before_the_byte() {
        // Position 1 and the delta come first. The length walk then doubles
        // once to 4, stops, and draws 3 below 4.
        assert_eq!(run(&[1, 0, 1, 0, 3], b"abc", repeat), b"abbbbc");
    }

    #[test]
    fn sequence_repeat_keeps_the_surrounding_bytes() {
        // Start 1 and end 2 + 1 pick "bc". Log width 2 plus offset 1 makes 3.
        assert_eq!(run(&[1, 1, 2, 1], b"abcde", repeat_sequence), b"abcbcbcde");
        assert_eq!(run(&[], b"a", repeat_sequence), b"a");
    }

    #[test]
    fn sequence_delete_removes_a_run() {
        assert_eq!(run(&[1, 2], b"abcde", delete_sequence), b"ade");
    }

    #[test]
    fn permute_stays_within_the_block() {
        let mut rng = crate::Rng::new(3);
        for _ in 0..1000 {
            let mut block = b"abcdef".to_vec();
            permute(&mut rng, &mut block);
            let mut sorted = block.clone();
            sorted.sort();
            assert_eq!(sorted, b"abcdef");
        }
    }
}
