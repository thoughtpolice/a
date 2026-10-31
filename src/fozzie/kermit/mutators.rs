// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! The mutator table, with radamsa's names and descriptions, and dispatch.

use crate::lines::{LineOp, LineStore};
use crate::source::Source;
use crate::{bytes, lines};

macro_rules! mutators {
    ($($variant:ident => $name:literal, $description:literal;)*) => {
        /// One mutation strategy, named as in radamsa.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Mutator {
            $($variant,)*
        }

        impl Mutator {
            /// Every mutator, in table order.
            pub const ALL: &[Mutator] = &[$(Mutator::$variant,)*];

            /// The short name used in mutator lists, such as `bd`.
            pub fn name(self) -> &'static str {
                match self {
                    $(Mutator::$variant => $name,)*
                }
            }

            pub fn description(self) -> &'static str {
                match self {
                    $(Mutator::$variant => $description,)*
                }
            }
        }
    };
}

mutators! {
    ByteDrop => "bd", "drop a byte";
    ByteFlip => "bf", "flip one bit";
    ByteInsert => "bi", "insert a random byte";
    ByteRepeat => "br", "repeat a byte";
    BytePermute => "bp", "permute some bytes";
    ByteIncrement => "bei", "increment a byte by one";
    ByteDecrement => "bed", "decrement a byte by one";
    ByteRandom => "ber", "swap a byte with a random one";
    SequenceRepeat => "sr", "repeat a sequence of bytes";
    SequenceDelete => "sd", "delete a sequence of bytes";
    LineDelete => "ld", "delete a line";
    LineDeleteMany => "lds", "delete many lines";
    LineDuplicate => "lr2", "duplicate a line";
    LineClone => "li", "copy a line closeby";
    LineRepeat => "lr", "repeat a line";
    LineSwap => "ls", "swap two lines";
    LinePermute => "lp", "swap order of lines";
    LineInsert => "lis", "insert a line from elsewhere";
    LineReplace => "lrs", "replace a line with one from elsewhere";
    Nop => "nop", "do nothing (debug/test)";
}

impl Mutator {
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|mutator| mutator.name() == name)
    }

    /// Mutates `block` in place and returns the score step, positive when
    /// the data suited this mutator and negative when it did not. `store`
    /// is this mutator's memory of earlier blocks, used by `lis` and `lrs`.
    pub(crate) fn apply<S: Source>(
        self,
        source: &mut S,
        block: &mut Vec<u8>,
        store: &mut LineStore,
    ) -> i8 {
        match self {
            Mutator::ByteDrop => bytes::drop_byte(source, block),
            Mutator::ByteFlip => bytes::flip(source, block),
            Mutator::ByteInsert => bytes::insert(source, block),
            Mutator::ByteRepeat => bytes::repeat(source, block),
            Mutator::BytePermute => bytes::permute(source, block),
            Mutator::ByteIncrement => bytes::increment(source, block),
            Mutator::ByteDecrement => bytes::decrement(source, block),
            Mutator::ByteRandom => bytes::randomize(source, block),
            Mutator::SequenceRepeat => bytes::repeat_sequence(source, block),
            Mutator::SequenceDelete => bytes::delete_sequence(source, block),
            Mutator::LineDelete => lines::mutate(source, block, LineOp::Delete),
            Mutator::LineDeleteMany => lines::mutate(source, block, LineOp::DeleteRun),
            Mutator::LineDuplicate => lines::mutate(source, block, LineOp::Duplicate),
            Mutator::LineClone => lines::mutate(source, block, LineOp::Clone),
            Mutator::LineRepeat => lines::mutate(source, block, LineOp::Repeat),
            Mutator::LineSwap => lines::mutate(source, block, LineOp::Swap),
            Mutator::LinePermute => lines::mutate(source, block, LineOp::Permute),
            Mutator::LineInsert => store.insert(source, block),
            Mutator::LineReplace => store.replace(source, block),
            Mutator::Nop => 0,
        }
    }
}

/// A set of mutators, such as the ones that changed an input.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MutatorSet(u32);

const _: () = assert!(Mutator::ALL.len() <= u32::BITS as usize);

impl MutatorSet {
    pub fn insert(&mut self, mutator: Mutator) {
        self.0 |= 1 << mutator as u32;
    }

    pub fn contains(self, mutator: Mutator) -> bool {
        self.0 & (1 << mutator as u32) != 0
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn iter(self) -> impl Iterator<Item = Mutator> {
        Mutator::ALL
            .iter()
            .copied()
            .filter(move |mutator| self.contains(*mutator))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_and_round_trip() {
        for (index, mutator) in Mutator::ALL.iter().enumerate() {
            assert_eq!(*mutator as usize, index);
            assert_eq!(Mutator::from_name(mutator.name()), Some(*mutator));
        }
        assert_eq!(Mutator::from_name("xp"), None);
    }

    #[test]
    fn sets_hold_mutators() {
        let mut set = MutatorSet::default();
        assert!(set.is_empty());
        set.insert(Mutator::Nop);
        set.insert(Mutator::ByteDrop);
        assert_eq!(
            set.iter().collect::<Vec<_>>(),
            [Mutator::ByteDrop, Mutator::Nop]
        );
    }
}
