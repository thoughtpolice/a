// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Generators that make a sample to mutate, radamsa's `random` and `jump`.
//!
//! radamsa usually mutates a sample file as it is. These generators make
//! other samples: random bytes when there is no sample at all, or a splice
//! of two samples that continues the first from a similar point in the
//! second.

use crate::fuse::fuse;
use crate::source::Source;
use crate::{MAX_BLOCK, MIN_BLOCK};

/// The shortest block of random bytes.
const MIN_RANDOM_BLOCK: usize = 32;

/// The largest stopping bound of the random generator. After each block it
/// draws a bound from 1 to 99 and stops with probability one over it.
const MAX_RANDOM_BOUND: usize = 100;

/// The initial stopping bound of the jump walk.
const INITIAL_JUMP_BOUND: usize = 3;

/// Random bytes in blocks of 32 to 4095, ending after each block with a
/// freshly drawn probability.
pub fn random<S: Source>(source: &mut S) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let len = source.range(MIN_RANDOM_BLOCK, MAX_BLOCK);
        out.extend((0..len).map(|_| source.below(256) as u8));
        let bound = source.range(1, MAX_RANDOM_BOUND);
        if source.below(bound) == 0 {
            return out;
        }
    }
}

/// Walks blocks of `a`, now and then also skipping a block of `b`, then
/// fuses the current blocks of each and continues with the rest of `b`.
/// The walk stops at each block with a falling probability, starting at
/// 1/3. An empty `a` gives `b`, and an empty `b` gives `a`.
pub fn jump<S: Source>(source: &mut S, a: &[u8], b: &[u8]) -> Vec<u8> {
    if a.is_empty() || b.is_empty() {
        return [a, b].concat();
    }
    let next = |source: &mut S, data: &[u8], start: usize| {
        (start + source.below(MAX_BLOCK).max(MIN_BLOCK)).min(data.len())
    };
    let (mut a_start, mut a_end) = (0, next(source, a, 0));
    let (mut b_start, mut b_end) = (0, next(source, b, 0));
    let mut out = Vec::new();
    let mut bound = INITIAL_JUMP_BOUND;
    loop {
        if source.below(bound) == 0 || a_end == a.len() {
            break;
        }
        bound += 1;
        // Two times in three, `b` advances along with `a`.
        let both = source.below(3) != 0;
        if both && b_end == b.len() {
            break;
        }
        out.extend_from_slice(&a[a_start..a_end]);
        (a_start, a_end) = (a_end, next(source, a, a_end));
        if both {
            (b_start, b_end) = (b_end, next(source, b, b_end));
        }
    }
    out.extend(fuse(source, &a[a_start..a_end], &b[b_start..b_end]));
    out.extend_from_slice(&b[b_end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{Rng, Script};

    #[test]
    fn zero_draws_give_one_short_block() {
        assert_eq!(random(&mut Script::new(&[])), [0; MIN_RANDOM_BLOCK]);
    }

    #[test]
    fn random_data_ends() {
        let mut rng = Rng::new(7);
        for _ in 0..100 {
            let data = random(&mut rng);
            assert!(data.len() >= MIN_RANDOM_BLOCK);
        }
    }

    #[test]
    fn jumps_keep_a_prefix_and_a_suffix() {
        let a: Vec<u8> = (0..2000).map(|index| (index % 251) as u8).collect();
        let b: Vec<u8> = (0..2000).map(|index| (index % 241) as u8).collect();
        let mut rng = Rng::new(11);
        for _ in 0..100 {
            let out = jump(&mut rng, &a, &b);
            // Each output starts like `a`, ends like `b`, or both.
            assert!(out.first() == a.first() || out.last() == b.last());
        }
        assert_eq!(jump(&mut rng, b"", b"tail"), b"tail");
        assert_eq!(jump(&mut rng, b"head", b""), b"head");
    }

    #[test]
    fn walks_blocks_of_a_before_jumping() {
        // Blocks of 256: stay on `a` once, advancing only `a`, then stop.
        let a = [b'a'; 600];
        let b = [b'b'; 600];
        let out = jump(&mut Script::new(&[256, 256, 1, 0, 256, 0]), &a, &b);
        assert!(out.starts_with(&[b'a'; 256]));
        assert!(out.ends_with(&[b'b'; 600 - 256]));
    }
}
