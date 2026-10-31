// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Where kermit's randomness comes from.
//!
//! Every decision a mutator makes goes through [`Source::below`]. A campaign
//! backs it with the fast [`Rng`]; a property-testing engine can back it with
//! its own draws instead, record them as a choice sequence, and shrink that
//! sequence. To make shrinking meaningful, each helper here maps a zero draw
//! to the simplest outcome: no extra mutation, the first position, the
//! identity permutation.

/// A stream of bounded choices.
pub trait Source {
    /// A uniform value in `0..upper`, or 0 when `upper` is 0 or 1.
    fn below(&mut self, upper: usize) -> usize;

    /// Marks the start of one mutator's draws, so a recording source can
    /// group them. The default ignores it.
    fn begin(&mut self, _label: &'static str) {}

    /// Marks the end of the draws `begin` opened.
    fn end(&mut self) {}

    /// A value in `low..high`, or `low` when the range is empty.
    fn range(&mut self, low: usize, high: usize) -> usize {
        low + self.below(high.saturating_sub(low))
    }

    /// True with probability `numerator / denominator`. A zero draw is false.
    fn chance(&mut self, numerator: usize, denominator: usize) -> bool {
        self.below(denominator) >= denominator - numerator.min(denominator)
    }

    /// A log-scaled value below `2^bits`. It draws a bit length below
    /// `bits`, then a value with exactly that many bits, so small values are
    /// as likely as large orders of magnitude. `bits` must be at most 64.
    fn log(&mut self, bits: u32) -> usize {
        match self.below(bits as usize) {
            0 => 0,
            width => {
                let base = 1_usize << (width - 1);
                base + self.below(base)
            }
        }
    }

    /// A score step of +1 or -1, each half the time.
    fn delta(&mut self) -> i8 {
        if self.chance(1, 2) { 1 } else { -1 }
    }

    /// A score step of +1 eleven times in twenty, and -1 otherwise.
    fn delta_up(&mut self) -> i8 {
        if self.chance(11, 20) { 1 } else { -1 }
    }

    /// Permutes `items` in place. All-zero draws leave the order unchanged.
    fn shuffle<T>(&mut self, items: &mut [T]) {
        for index in 0..items.len() {
            let other = index + self.below(items.len() - index);
            items.swap(index, other);
        }
    }

    /// Two distinct indices below `len`, in random order. `len` must be at
    /// least 2.
    fn two_of(&mut self, len: usize) -> (usize, usize) {
        debug_assert!(len >= 2);
        let first = self.below(len);
        let second = (first + 1 + self.below(len - 1)) % len;
        (first, second)
    }
}

/// A seeded xorshift64 generator. It is fast and deterministic per seed,
/// and it is not cryptographic.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(if seed == 0 {
            0x9e37_79b9_7f4a_7c15
        } else {
            seed
        })
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut value = self.0;
        value ^= value << 13;
        value ^= value >> 7;
        value ^= value << 17;
        self.0 = value;
        value
    }
}

impl Source for Rng {
    fn below(&mut self, upper: usize) -> usize {
        if upper <= 1 {
            0
        } else {
            (self.next_u64() % upper as u64) as usize
        }
    }
}

/// A source that replays fixed draws, then answers 0. Tests use it to pin a
/// mutator's choices.
#[cfg(test)]
pub(crate) struct Script(pub std::collections::VecDeque<usize>);

#[cfg(test)]
impl Script {
    pub fn new(draws: &[usize]) -> Self {
        Self(draws.iter().copied().collect())
    }
}

#[cfg(test)]
impl Source for Script {
    fn below(&mut self, upper: usize) -> usize {
        let draw = self.0.pop_front().unwrap_or(0);
        if upper <= 1 {
            0
        } else {
            assert!(draw < upper, "scripted draw {draw} is not below {upper}");
            draw
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_draws_are_the_simplest_outcomes() {
        let mut zeros = Script::new(&[]);
        assert!(!zeros.chance(4, 5));
        assert_eq!(zeros.log(10), 0);
        assert_eq!(zeros.range(3, 9), 3);
        let mut items = [1, 2, 3, 4];
        zeros.shuffle(&mut items);
        assert_eq!(items, [1, 2, 3, 4]);
    }

    #[test]
    fn helpers_stay_in_bounds() {
        let mut rng = Rng::new(7);
        for _ in 0..10_000 {
            assert!(rng.log(10) < 1024);
            let value = rng.range(2, 20);
            assert!((2..20).contains(&value));
            let (a, b) = rng.two_of(3);
            assert!(a != b && a < 3 && b < 3);
        }
        assert_eq!(rng.range(5, 5), 5);
        assert_eq!(rng.below(0), 0);
    }

    #[test]
    fn rng_is_deterministic_per_seed() {
        let draws = |seed| {
            let mut rng = Rng::new(seed);
            (0..8).map(|_| rng.below(1000)).collect::<Vec<_>>()
        };
        assert_eq!(draws(42), draws(42));
        assert_ne!(draws(42), draws(43));
    }
}
