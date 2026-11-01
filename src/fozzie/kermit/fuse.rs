// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Alignment-based fusing and the mutators built on it, radamsa's `ft`,
//! `fn` and `fo`.
//!
//! Fusing joins a prefix of one byte string to a suffix of another at a
//! point where both continue alike. radamsa searches from every position
//! of each string, repeatedly keeping the pairs whose next bytes match, so
//! a longer search finds a longer shared context. The result often reads
//! as a plausible splice of the two, such as a repeated or truncated
//! element of a list.
//!
//! On strings that share long contexts, such as a block and its own first
//! half, that search carries thousands of pairs through every step, and a
//! fuse of two 4 KiB blocks took milliseconds. Kermit draws the context
//! length as radamsa's search would reach it, then finds the positions
//! that share a context of that length by hashing, in time proportional
//! to the strings whatever the length.

use crate::source::Source;
use std::ops::Range;

/// The search stops after each byte of context with probability 1/8.
const SEARCH_STOP: usize = 8;

/// The modulus of the context hashes, the Mersenne prime 2^61 - 1. A
/// prime modulus avoids the collisions of strings such as Thue-Morse
/// sequences that defeat any hash modulo a power of two.
const HASH_MODULUS: u64 = (1 << 61) - 1;

/// The base of the context hashes.
const HASH_BASE: u64 = 0x1f35_a2b9_c7e4_d063 % HASH_MODULUS;

/// Jumps from a position in the block to a similar one in the same block.
pub fn fuse_this<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    *block = fuse(source, block, block);
    source.delta_up()
}

/// Fuses the block's first half into the block, then into its second half,
/// which likely clones data between similar positions. radamsa fuses with
/// the next block when there is one; kermit always uses the block itself,
/// as radamsa does for the last block.
pub fn fuse_next<S: Source>(source: &mut S, block: &mut Vec<u8>) -> i8 {
    let (first, second) = block.split_at(block.len() / 2);
    let joined = fuse(source, first, block);
    let out = fuse(source, &joined, second);
    *block = out;
    source.delta_up()
}

/// Fuses the block with a block remembered from an earlier call, in both
/// directions, then remembers the current block with probability 1/3.
pub fn fuse_old<S: Source>(source: &mut S, block: &mut Vec<u8>, old: &mut Option<Vec<u8>>) -> i8 {
    let remembered = old.take().unwrap_or_else(|| block.clone());
    let (a1, a2) = block.split_at(block.len() / 2);
    let (o1, o2) = remembered.split_at(remembered.len() / 2);
    let mut out = fuse(source, a1, o1);
    out.extend(fuse(source, o2, a2));
    *old = Some(if source.below(3) == 0 {
        std::mem::take(block)
    } else {
        remembered
    });
    *block = out;
    source.delta_up()
}

/// Joins `a[..i]` to `b[j..]`, for positions that share a context.
pub fn fuse<S: Source>(source: &mut S, a: &[u8], b: &[u8]) -> Vec<u8> {
    if a.is_empty() {
        return b.to_vec();
    }
    if b.is_empty() {
        return a.to_vec();
    }
    let (from, to) = jump_points(source, a, b);
    let mut out = a[..from].to_vec();
    out.extend_from_slice(&b[to..]);
    out
}

/// Positions in `a` and `b` to search from.
type Starts = (Vec<usize>, Vec<usize>);

/// A position in `a` and one in `b` just after a context both share. The
/// context's length is that of radamsa's search, which reads one more
/// byte at each step with probability 7/8, and stops early when no longer
/// context is shared. Unlike radamsa's search, this one needs no fuel
/// limit, since it costs the same at any length.
fn jump_points<S: Source>(source: &mut S, a: &[u8], b: &[u8]) -> (usize, usize) {
    let (froms, tos) = if a == b {
        alternate(source, a.len())
    } else {
        ((0..a.len()).collect(), (0..b.len()).collect())
    };
    let longest = a.len().min(b.len());
    let mut wanted = 0;
    while wanted < longest && source.below(SEARCH_STOP) != 0 {
        wanted += 1;
    }
    let (hashes_a, hashes_b) = (Prefixes::new(a), Prefixes::new(b));
    let shared = |len| Shared::new(&hashes_a, &hashes_b, &froms, &tos, len);
    let mut found = shared(wanted);
    if found.nodes.is_empty() {
        // Contexts of length `low` are shared and of length `high` are not.
        // Every start shares the empty context.
        let (mut low, mut high) = (0, wanted);
        while high - low > 1 {
            let middle = low + (high - low) / 2;
            if shared(middle).nodes.is_empty() {
                high = middle;
            } else {
                low = middle;
            }
        }
        found = shared(low);
    }
    found.any_pair(source)
}

/// The prefix hashes of a string, from which the hash of any of its
/// substrings follows in constant time.
struct Prefixes {
    hashes: Vec<u64>,
    powers: Vec<u64>,
}

impl Prefixes {
    fn new(data: &[u8]) -> Self {
        let mut hashes = Vec::with_capacity(data.len() + 1);
        let mut powers = Vec::with_capacity(data.len() + 1);
        let (mut hash, mut power) = (0, 1);
        hashes.push(hash);
        powers.push(power);
        for &byte in data {
            // Bytes count from 1 so that zero bytes still change the hash.
            hash = add(multiply(hash, HASH_BASE), u64::from(byte) + 1);
            power = multiply(power, HASH_BASE);
            hashes.push(hash);
            powers.push(power);
        }
        Self { hashes, powers }
    }

    fn substring(&self, start: usize, len: usize) -> u64 {
        let shifted = multiply(self.hashes[start], self.powers[len]);
        add(self.hashes[start + len], HASH_MODULUS - shifted)
    }
}

/// `a * b` modulo 2^61 - 1, for `a` and `b` below it. Since 2^61 is 1
/// modulo 2^61 - 1, the product's high bits fold onto its low ones, which
/// is far cheaper than a 128-bit division.
fn multiply(a: u64, b: u64) -> u64 {
    let product = u128::from(a) * u128::from(b);
    add((product as u64) & HASH_MODULUS, (product >> 61) as u64)
}

/// `a + b` modulo 2^61 - 1, for `a` and `b` below it.
fn add(a: u64, b: u64) -> u64 {
    let sum = a + b;
    if sum >= HASH_MODULUS {
        sum - HASH_MODULUS
    } else {
        sum
    }
}

/// The contexts of one length that `a` and `b` share. Each node is a
/// context, and holds the positions just after it in `a` and in `b`.
struct Shared {
    /// Each candidate's context hash and the position after it, in order.
    in_a: Vec<(u64, usize)>,
    in_b: Vec<(u64, usize)>,
    /// Each node's runs of `in_a` and `in_b`. Keeping runs rather than
    /// lists of positions saves two allocations per node, and two strings
    /// of random bytes share a context at almost every position.
    nodes: Vec<(Range<usize>, Range<usize>)>,
}

impl Shared {
    /// Finds the contexts of `len` bytes that start at one of `froms` in
    /// `a` and at one of `tos` in `b`.
    fn new(a: &Prefixes, b: &Prefixes, froms: &[usize], tos: &[usize], len: usize) -> Self {
        let contexts = |data: &Prefixes, starts: &[usize]| {
            let end = data.hashes.len() - 1;
            let mut out: Vec<(u64, usize)> = starts
                .iter()
                .filter(|&&start| start + len <= end)
                .map(|&start| (data.substring(start, len), start + len))
                .collect();
            out.sort_unstable();
            out
        };
        let (in_a, in_b) = (contexts(a, froms), contexts(b, tos));
        let mut nodes = Vec::new();
        let (mut i, mut j) = (0, 0);
        while i < in_a.len() && j < in_b.len() {
            let (hash_a, hash_b) = (in_a[i].0, in_b[j].0);
            let i_end = i + in_a[i..].partition_point(|&(hash, _)| hash == hash_a);
            let j_end = j + in_b[j..].partition_point(|&(hash, _)| hash == hash_b);
            if hash_a <= hash_b {
                if hash_a == hash_b {
                    nodes.push((i..i_end, j..j_end));
                    j = j_end;
                }
                i = i_end;
            } else {
                j = j_end;
            }
        }
        Self { in_a, in_b, nodes }
    }

    /// A random node's random positions in `a` and `b`.
    fn any_pair<S: Source>(&self, source: &mut S) -> (usize, usize) {
        let (froms, tos) = &self.nodes[source.below(self.nodes.len())];
        (
            self.in_a[froms.start + source.below(froms.len())].1,
            self.in_b[tos.start + source.below(tos.len())].1,
        )
    }
}

/// When fusing a string with itself, deals the positions after the first
/// into the jump and landing sets at random, so the jump rarely lands
/// where it started.
fn alternate<S: Source>(source: &mut S, len: usize) -> Starts {
    let (mut from, mut to) = (vec![0], vec![0]);
    for position in 1..len {
        if source.below(2) == 1 {
            from.push(position);
        } else {
            to.push(position);
        }
    }
    (from, to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Script;

    /// Whether `out` is some prefix of `a` followed by some suffix of `b`.
    fn is_splice(out: &[u8], a: &[u8], b: &[u8]) -> bool {
        (0..=a.len()).any(|i| out.starts_with(&a[..i]) && b.ends_with(&out[i..]))
    }

    #[test]
    fn fusing_splices_a_prefix_onto_a_suffix() {
        let mut rng = crate::Rng::new(11);
        let (a, b) = (&b"<a><b>x</b></a>"[..], &b"<b>yy</b><c/>"[..]);
        for _ in 0..1000 {
            assert!(is_splice(&fuse(&mut rng, a, b), a, b));
            assert!(is_splice(&fuse(&mut rng, a, a), a, a));
        }
        assert_eq!(fuse(&mut rng, b"", b"z"), b"z");
        assert_eq!(fuse(&mut rng, b"z", b""), b"z");
    }

    #[test]
    fn a_longer_search_jumps_between_matching_bytes() {
        // One byte of context, then stop. The two nodes hold the X pair
        // and the Y pair, and either jump comes right after its shared
        // byte.
        let (a, b) = (b"aXbYc", b"pYqXr");
        for node in [0, 1] {
            let (from, to) = jump_points(&mut Script::new(&[1, 0, node]), a, b);
            assert_eq!(a[from - 1], b[to - 1]);
            assert_eq!(
                fuse(&mut Script::new(&[1, 0, node]), a, b).len(),
                from + b.len() - to
            );
        }
    }

    #[test]
    fn long_shared_contexts_are_found() {
        // Seven steps of context, then stop: only "abcdefg" in a and b,
        // and "bcdefgh", are that long.
        let (a, b) = (b"xxabcdefghxx", b"yyyyabcdefghyy");
        for node in [0, 1] {
            let mut draws = vec![1; 7];
            draws.extend([0, node]);
            let (from, to) = jump_points(&mut Script::new(&draws), a, b);
            assert!(from >= 7 && to >= 7);
            assert_eq!(a[from - 7..from], b[to - 7..to]);
        }
        // Asking for more context than is shared settles for the longest
        // shared one, "abcdefgh".
        let (from, to) = jump_points(&mut Script::new(&[1; 12]), a, b);
        assert_eq!((from, to), (10, 12));
    }

    #[test]
    fn shared_contexts_match_byte_by_byte() {
        let mut rng = crate::Rng::new(3);
        for _ in 0..200 {
            let a: Vec<u8> = (0..rng.below(40)).map(|_| b"ab"[rng.below(2)]).collect();
            let b: Vec<u8> = (0..rng.below(40)).map(|_| b"ab"[rng.below(2)]).collect();
            let len = rng.below(6);
            let froms: Vec<usize> = (0..a.len()).collect();
            let tos: Vec<usize> = (0..b.len()).collect();
            let found = Shared::new(&Prefixes::new(&a), &Prefixes::new(&b), &froms, &tos, len);
            let positions = |run: &Range<usize>, of: &[(u64, usize)]| -> Vec<usize> {
                of[run.clone()].iter().map(|&(_, at)| at).collect()
            };
            let nodes: Vec<Starts> = found
                .nodes
                .iter()
                .map(|(froms, tos)| (positions(froms, &found.in_a), positions(tos, &found.in_b)))
                .collect();
            let mut expected: Vec<Starts> = Vec::new();
            let mut contexts: Vec<&[u8]> = (0..a.len())
                .filter(|&i| i + len <= a.len())
                .map(|i| &a[i..i + len])
                .collect();
            contexts.sort();
            contexts.dedup();
            for context in contexts {
                let after = |data: &[u8]| -> Vec<usize> {
                    (0..data.len())
                        .filter(|&i| data[i..].starts_with(context))
                        .map(|i| i + len)
                        .collect()
                };
                let in_b = after(&b);
                if !in_b.is_empty() {
                    expected.push((after(&a), in_b));
                }
            }
            let mut got = nodes;
            got.sort();
            expected.sort();
            assert_eq!(got, expected, "{a:?} {b:?} {len}");
        }
    }

    #[test]
    fn zero_draws_take_all_of_b() {
        assert_eq!(fuse(&mut Script::new(&[]), b"abc", b"xyz"), b"xyz");
    }

    #[test]
    fn fuse_old_mixes_in_the_remembered_block() {
        let mut old = Some(b"AAAA".to_vec());
        let mut block = b"BBBB".to_vec();
        fuse_old(&mut Script::new(&[]), &mut block, &mut old);
        // Zero draws take all of the second string of each fuse: the old
        // first half, then the block's second half.
        assert_eq!(block, b"AABB");
        assert_eq!(old.as_deref(), Some(&b"BBBB"[..]));
    }
}
