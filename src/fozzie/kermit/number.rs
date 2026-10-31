// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! The textual number mutator, radamsa's `num`.
//!
//! It finds the runs of ASCII digits in a block, picks one, and rewrites it
//! as a nearby, boundary or far-away value. Numbers are arbitrary precision,
//! so a long digit run and the boundary values up to 2^128 + 1 come out
//! exactly.

use crate::lines::binarish;
use crate::source::Source;
use num_bigint::{BigInt, BigUint};

/// The bit widths whose boundaries are interesting: 2^k - 1, 2^k and
/// 2^k + 1 for each.
const BOUNDARY_BITS: [u32; 11] = [1, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128];

/// Rewrites one decimal number in `block`.
///
/// Text with numbers is rewarded. Data with no numbers, or that looks
/// binary, is mildly penalized, since numbers are rarer there.
pub fn mutate<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let numbers = digit_runs(block);
    if numbers.is_empty() {
        return if source.below(10) == 0 { -1 } else { 0 };
    }
    let range = numbers[source.below(numbers.len())].clone();
    let value: BigInt = std::str::from_utf8(&block[range.clone()])
        .expect("digits are ASCII")
        .parse()
        .expect("a digit run parses");
    let rendered = change(source, value).to_string();
    block.splice(range, rendered.bytes());
    if binarish(block) { -1 } else { 2 }
}

/// The byte ranges of maximal ASCII digit runs.
fn digit_runs(block: &[u8]) -> Vec<std::ops::Range<usize>> {
    let mut runs = Vec::new();
    let mut start = None;
    for (index, byte) in block.iter().enumerate() {
        match (byte.is_ascii_digit(), start) {
            (true, None) => start = Some(index),
            (false, Some(begin)) => {
                runs.push(begin..index);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(begin) = start {
        runs.push(begin..block.len());
    }
    runs
}

/// A nearby, boundary or far-away replacement for `value`.
pub(crate) fn change<S: Source>(source: &mut S, value: BigInt) -> BigInt {
    match source.below(12) {
        0 => value + 1,
        1 => value - 1,
        2 => BigInt::ZERO,
        3 => BigInt::from(1),
        4..=6 => boundary(source),
        7 => value + boundary(source),
        8 => boundary(source) - value,
        9 => {
            let twice = (&value * 2u32).magnitude().clone();
            let offset = BigInt::from(below_big(source, &twice));
            value - offset
        }
        _ => {
            let bits = source.range(1, 129) as u32;
            let offset = BigInt::from(log_big(source, bits));
            if source.below(3) == 0 {
                value - offset
            } else {
                value + offset
            }
        }
    }
}

/// One of the 33 boundary values.
fn boundary<S: Source>(source: &mut S) -> BigInt {
    let index = source.below(BOUNDARY_BITS.len() * 3);
    let power = BigInt::from(1) << BOUNDARY_BITS[index / 3];
    power + (index % 3) as i32 - 1
}

/// A uniform value below `bound`, drawn as 32-bit limbs, most significant
/// first, so zero draws give zero.
fn below_big<S: Source>(source: &mut S, bound: &BigUint) -> BigUint {
    if let Ok(small) = usize::try_from(bound) {
        return BigUint::from(source.below(small));
    }
    let limbs = bound.to_u32_digits();
    let top = *limbs.last().expect("a large bound has limbs");
    let mut digits = vec![0u32; limbs.len()];
    *digits.last_mut().expect("nonempty") = source.below(top as usize + 1) as u32;
    for digit in digits.iter_mut().rev().skip(1) {
        *digit = source.below(1 << 32) as u32;
    }
    BigUint::from_slice(&digits) % bound
}

/// The arbitrary-precision form of [`Source::log`]: a value below `2^bits`,
/// log-scaled.
fn log_big<S: Source>(source: &mut S, bits: u32) -> BigUint {
    match source.below(bits as usize) as u32 {
        0 => BigUint::ZERO,
        width => {
            let base = BigUint::from(1u32) << (width - 1);
            let offset = below_big(source, &base);
            base + offset
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    fn run(draws: &[usize], input: &[u8]) -> (i8, String) {
        let mut block = input.to_vec();
        let delta = mutate(&mut Script::new(draws), &mut block);
        (delta, String::from_utf8_lossy(&block).into_owned())
    }

    #[test]
    fn finds_digit_runs() {
        assert_eq!(digit_runs(b"a1 22b333"), vec![1..2, 3..5, 6..9]);
        assert_eq!(digit_runs(b"none"), vec![]);
    }

    #[test]
    fn rewrites_the_chosen_number() {
        assert_eq!(run(&[1, 0], b"x=9, y=41"), (2, "x=9, y=42".to_string()));
        assert_eq!(run(&[0, 1], b"x=0"), (2, "x=-1".to_string()));
        assert_eq!(
            run(&[0, 2], b"12345678901234567890123"),
            (2, "0".to_string())
        );
    }

    #[test]
    fn boundaries_include_wide_integers() {
        // Index 32 is 2^128 + 1, past what u128 can hold.
        assert_eq!(
            run(&[0, 4, 32], b"7"),
            (2, "340282366920938463463374607431768211457".to_string())
        );
        assert_eq!(run(&[0, 4, 0], b"7"), (2, "1".to_string()));
    }

    #[test]
    fn numberless_data_is_untouched() {
        assert_eq!(run(&[0], b"abc"), (-1, "abc".to_string()));
        assert_eq!(run(&[5], b"abc"), (0, "abc".to_string()));
    }

    #[test]
    fn binary_data_is_penalized() {
        assert_eq!(run(&[0, 0], b"\xff1"), (-1, "\u{fffd}2".to_string()));
    }

    #[test]
    fn large_draws_stay_below_their_bound() {
        let mut rng = crate::Rng::new(5);
        let bound = BigUint::from(3u32) << 100;
        for _ in 0..1000 {
            assert!(below_big(&mut rng, &bound) < bound);
            assert!(log_big(&mut rng, 128) < BigUint::from(1u32) << 128);
        }
    }
}
