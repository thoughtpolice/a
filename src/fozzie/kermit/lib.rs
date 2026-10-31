// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Kermit is radamsa's black-box mutation engine, ported to Rust.
//!
//! Kermit turns a sample input into an interestingly different one without
//! knowing its format. It guesses at structure instead: lines, decimal
//! numbers, quoted strings, bracketed trees and UTF-8, falling back to plain
//! bytes. Each call picks a *pattern*, which mutates once, possibly many
//! times, or in a burst at one place. It then walks to a block of up to
//! 4 KiB and tries mutators in a weighted random order until one changes
//! the block.
//!
//! Mutators keep a score between 2 and 10 that they adjust themselves. A
//! line mutator gains on text and loses on binary data, so over a run the
//! mix adapts to the input. A mutator's chance of going first is its score
//! times the priority the [`Config`] gives it.
//!
//! All randomness comes through a [`Source`], so the same seed reproduces
//! the same outputs, and a property-testing engine can drive and shrink
//! the choices.

mod bytes;
mod lines;
mod list;
mod mutators;
mod number;
#[cfg(test)]
mod properties;
mod source;
mod text;
mod tree;
mod utf8;

pub use mutators::{Mutator, MutatorSet};
pub use source::{Rng, Source};

use lines::LineStore;
use std::cmp::Reverse;
use std::fmt;
use std::ops::Range;

/// radamsa's default mutators and priorities, less `ft`, `fn`, `fo` and
/// `xp`, which kermit has not ported yet. Like radamsa, kermit leaves the
/// tree mutators out of the default list.
pub const DEFAULT_MUTATORS: &str =
    "num=5,ld,lds,lr2,li,ls,lp,lr,lis,lrs,sr,sd,bd,bf,bi,br,bp,bei,bed,ber,uw,ui=2,ab";

/// radamsa's default patterns and priorities.
pub const DEFAULT_PATTERNS: &str = "od,nd=2,bu";

const MIN_SCORE: i32 = 2;
const MAX_SCORE: i32 = 10;

/// The initial bound of the block walk. Kermit mutates the first block with
/// probability about 1/12, and each later one slightly less often.
const INITIAL_IP: usize = 24;
const MIN_BLOCK: usize = 256;
const MAX_BLOCK: usize = 4096;

/// How many more rounds of every mutator to try when none changed a block.
const MAX_RETRIES: usize = 24;

/// How a call spreads its mutations over the input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pattern {
    /// One mutation.
    Once,
    /// One mutation, then with probability 4/5 another, at or after the
    /// last one, and so on.
    Many,
    /// Two or more mutations of the same block.
    Burst,
}

impl Pattern {
    pub const ALL: &[Pattern] = &[Pattern::Once, Pattern::Many, Pattern::Burst];

    pub fn name(self) -> &'static str {
        match self {
            Pattern::Once => "od",
            Pattern::Many => "nd",
            Pattern::Burst => "bu",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Pattern::Once => "Mutate once",
            Pattern::Many => "Mutate possibly many times",
            Pattern::Burst => "Make several mutations closeby once",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|pattern| pattern.name() == name)
    }
}

/// Which mutators and patterns a [`Kermit`] uses, and how often.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    mutators: Vec<(Mutator, u32)>,
    patterns: Vec<(Pattern, u32)>,
}

impl Config {
    /// Parses radamsa-style lists of comma-separated names, each optionally
    /// followed by `=priority`. Priority 1 is the default and 0 disables an
    /// entry, as in `"num=5,ld,bd=0"`.
    pub fn parse(mutators: &str, patterns: &str) -> Result<Self, ParseError> {
        let mutators = parse_list(mutators, "mutator", Mutator::from_name)?;
        let patterns = parse_list(patterns, "pattern", Pattern::from_name)?;
        Ok(Self { mutators, patterns })
    }
}

impl Default for Config {
    fn default() -> Self {
        Self::parse(DEFAULT_MUTATORS, DEFAULT_PATTERNS).expect("the defaults parse")
    }
}

/// Why a mutator or pattern list did not parse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError(String);

impl fmt::Display for ParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ParseError {}

/// Parses `list`, keeping the enabled entries in order.
fn parse_list<T: Copy + PartialEq>(
    list: &str,
    kind: &str,
    lookup: impl Fn(&str) -> Option<T>,
) -> Result<Vec<(T, u32)>, ParseError> {
    let mut seen = Vec::new();
    let mut enabled = Vec::new();
    for entry in list.split(',') {
        let (name, priority) = match entry.split_once('=') {
            Some((name, priority)) => (name, priority),
            None => (entry, "1"),
        };
        let item = lookup(name).ok_or_else(|| ParseError(format!("unknown {kind} {name:?}")))?;
        let priority: u32 = priority
            .parse()
            .map_err(|_| ParseError(format!("bad priority {priority:?} for {kind} {name:?}")))?;
        if seen.contains(&item) {
            return Err(ParseError(format!("{kind} {name:?} is listed twice")));
        }
        seen.push(item);
        if priority > 0 {
            enabled.push((item, priority));
        }
    }
    if enabled.is_empty() {
        return Err(ParseError(format!("no {kind} is enabled")));
    }
    Ok(enabled)
}

/// One mutated input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mutation {
    pub data: Vec<u8>,
    pub pattern: Pattern,
    /// The mutators that changed the data. Empty only when nothing could:
    /// an empty input with no mutator that inserts, say.
    pub applied: MutatorSet,
}

/// A mutation engine whose mutator scores adapt over successive calls.
#[derive(Clone, Debug)]
pub struct Kermit {
    slots: Vec<Slot>,
    patterns: Vec<(Pattern, u32)>,
}

#[derive(Clone, Debug)]
struct Slot {
    mutator: Mutator,
    priority: u32,
    score: i32,
    store: LineStore,
}

impl Kermit {
    /// Creates an engine with random initial scores drawn from `source`.
    pub fn new<S: Source>(config: &Config, source: &mut S) -> Self {
        let slots = config
            .mutators
            .iter()
            .map(|&(mutator, priority)| Slot {
                mutator,
                priority,
                score: (source.below(MAX_SCORE as usize) as i32).max(MIN_SCORE),
                store: LineStore::default(),
            })
            .collect();
        let mut patterns = config.patterns.clone();
        patterns.sort_by_key(|&(_, priority)| Reverse(priority));
        Self { slots, patterns }
    }

    /// Each enabled mutator with its current score.
    pub fn scores(&self) -> impl Iterator<Item = (Mutator, i32)> + '_ {
        self.slots.iter().map(|slot| (slot.mutator, slot.score))
    }

    /// Mutates `input`. The output has no size limit, so a caller with one
    /// truncates it.
    pub fn mutate<S: Source>(&mut self, source: &mut S, input: &[u8]) -> Mutation {
        let pattern = self.pattern(source);
        let mut data = input.to_vec();
        let mut applied = MutatorSet::default();
        match pattern {
            Pattern::Once => {
                self.mutate_once(source, &mut data, 0, &mut applied);
            }
            Pattern::Many => {
                let mut from = 0;
                loop {
                    from = self.mutate_once(source, &mut data, from, &mut applied);
                    if !source.chance(4, 5) {
                        break;
                    }
                }
            }
            Pattern::Burst => {
                let range = block(source, data.len(), 0);
                let mut chunk = data[range.clone()].to_vec();
                self.force_change(source, &mut chunk, &mut applied);
                let mut count = 1;
                while source.chance(4, 5) || count < 2 {
                    self.force_change(source, &mut chunk, &mut applied);
                    count += 1;
                }
                data.splice(range, chunk);
            }
        }
        Mutation {
            data,
            pattern,
            applied,
        }
    }

    fn pattern<S: Source>(&self, source: &mut S) -> Pattern {
        let total = self
            .patterns
            .iter()
            .map(|(_, priority)| *priority as usize)
            .sum();
        let mut pick = source.below(total);
        for &(pattern, priority) in &self.patterns {
            match pick.checked_sub(priority as usize) {
                Some(rest) => pick = rest,
                None => return pattern,
            }
        }
        unreachable!("the pick is below the total")
    }

    /// Mutates one block at or after `from`, returning where it starts.
    fn mutate_once<S: Source>(
        &mut self,
        source: &mut S,
        data: &mut Vec<u8>,
        from: usize,
        applied: &mut MutatorSet,
    ) -> usize {
        let range = block(source, data.len(), from);
        let start = range.start;
        let mut chunk = data[range.clone()].to_vec();
        self.force_change(source, &mut chunk, applied);
        data.splice(range, chunk);
        start
    }

    /// Runs the mutators over `block` until one changes it, in up to
    /// `MAX_RETRIES + 1` rounds.
    fn force_change<S: Source>(
        &mut self,
        source: &mut S,
        block: &mut Vec<u8>,
        applied: &mut MutatorSet,
    ) -> bool {
        (0..=MAX_RETRIES).any(|_| self.round(source, block, applied))
    }

    /// Tries each mutator once, in a random order weighted by score times
    /// priority, until one changes `block`. Every mutator tried updates its
    /// score.
    fn round<S: Source>(
        &mut self,
        source: &mut S,
        block: &mut Vec<u8>,
        applied: &mut MutatorSet,
    ) -> bool {
        let mut order: Vec<(usize, usize)> = (0..self.slots.len())
            .map(|index| {
                let slot = &self.slots[index];
                (
                    source.below(slot.score as usize * slot.priority as usize),
                    index,
                )
            })
            .collect();
        order.sort_by_key(|&(key, _)| Reverse(key));
        for (_, index) in order {
            let slot = &mut self.slots[index];
            let before = block.clone();
            source.begin(slot.mutator.name());
            let delta = slot.mutator.apply(source, block, &mut slot.store);
            source.end();
            slot.score = (slot.score + i32::from(delta)).clamp(MIN_SCORE, MAX_SCORE);
            if *block != before {
                applied.insert(slot.mutator);
                return true;
            }
        }
        false
    }
}

/// Walks blocks of 256 to 4095 bytes from `from`, stopping at each with a
/// falling probability, and always at the last.
fn block<S: Source>(source: &mut S, len: usize, from: usize) -> Range<usize> {
    let mut bound = source.below(INITIAL_IP);
    let mut start = from;
    loop {
        let end = (start + source.below(MAX_BLOCK).max(MIN_BLOCK)).min(len);
        if end == len || source.below(bound) == 0 {
            return start..end;
        }
        bound += 1;
        start = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(mutators: &str, patterns: &str, seed: u64) -> (Kermit, Rng) {
        let mut rng = Rng::new(seed);
        let config = Config::parse(mutators, patterns).expect("test lists parse");
        (Kermit::new(&config, &mut rng), rng)
    }

    #[test]
    fn parses_lists() {
        let config = Config::parse("sr=5,bd,bf=0", "od").expect("parses");
        assert_eq!(
            config.mutators,
            [(Mutator::SequenceRepeat, 5), (Mutator::ByteDrop, 1)]
        );
        assert_eq!(config.patterns, [(Pattern::Once, 1)]);
        Config::default();
        for (mutators, error) in [
            ("xp", "unknown mutator \"xp\""),
            ("bd=-1", "bad priority \"-1\" for mutator \"bd\""),
            ("bd,bd=2", "mutator \"bd\" is listed twice"),
            ("bd=0", "no mutator is enabled"),
            ("", "unknown mutator \"\""),
        ] {
            assert_eq!(
                Config::parse(mutators, "od").unwrap_err().to_string(),
                error
            );
        }
    }

    #[test]
    fn the_same_seed_gives_the_same_outputs() {
        let run = |seed| {
            let (mut kermit, mut rng) = engine(DEFAULT_MUTATORS, DEFAULT_PATTERNS, seed);
            (0..50)
                .map(|_| kermit.mutate(&mut rng, b"HAL 9000\n(a b) \"c\"\n").data)
                .collect::<Vec<_>>()
        };
        assert_eq!(run(1), run(1));
        assert_ne!(run(1), run(2));
    }

    // Under nd or bu a later mutation can undo an earlier one, so this holds
    // only for od.
    #[test]
    fn every_single_mutation_changes_a_nonempty_input() {
        let (mut kermit, mut rng) = engine(DEFAULT_MUTATORS, "od", 4);
        for _ in 0..2000 {
            let mutation = kermit.mutate(&mut rng, b"Fuzztron 2000");
            assert_ne!(mutation.data, b"Fuzztron 2000");
            assert!(!mutation.applied.is_empty());
        }
    }

    #[test]
    fn empty_inputs_grow() {
        let (mut kermit, mut rng) = engine(DEFAULT_MUTATORS, "od", 5);
        for _ in 0..100 {
            assert!(!kermit.mutate(&mut rng, b"").data.is_empty());
        }
    }

    #[test]
    fn patterns_set_how_many_mutations_apply() {
        for (pattern, at_least, at_most) in [("od", 1, Some(1)), ("nd", 1, None), ("bu", 2, None)] {
            let (mut kermit, mut rng) = engine("bi", pattern, 6);
            for _ in 0..200 {
                let grown = kermit.mutate(&mut rng, b"abc").data.len() - 3;
                assert!(grown >= at_least, "{pattern} grew by {grown}");
                assert!(
                    at_most.is_none_or(|most| grown <= most),
                    "{pattern} grew by {grown}"
                );
            }
        }
    }

    #[test]
    fn scores_follow_what_suits_the_data() {
        // Line mutators lose on binary data, and the byte mutator, which
        // steps at random, does the changing.
        let (mut kermit, mut rng) = engine("ld,lr2,bd", "od", 7);
        for _ in 0..200 {
            kermit.mutate(&mut rng, b"\x00\xff binary");
        }
        let scores: Vec<_> = kermit.scores().take(2).collect();
        assert_eq!(
            scores,
            [
                (Mutator::LineDelete, MIN_SCORE),
                (Mutator::LineDuplicate, MIN_SCORE)
            ]
        );

        let (mut kermit, mut rng) = engine("ld,lr2", "od", 7);
        for _ in 0..200 {
            kermit.mutate(&mut rng, b"x = 1\ny = 2\n");
        }
        assert!(kermit.scores().all(|(_, score)| score == MAX_SCORE));
    }

    #[test]
    fn mutations_land_in_later_blocks_of_large_inputs() {
        let (mut kermit, mut rng) = engine("bei", "od", 8);
        let input = vec![b'a'; 64 * 1024];
        let mut last_quarter = 0;
        for _ in 0..500 {
            let output = kermit.mutate(&mut rng, &input).data;
            let at = output
                .iter()
                .position(|&byte| byte != b'a')
                .expect("one byte changed");
            last_quarter += usize::from(at >= 48 * 1024);
        }
        assert!(last_quarter > 0);
    }
}
