// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT
//
// Ported from radamsa, © 2013 Aki Helin. See LICENSE.

//! Alignment-based fusing and the mutators built on it, radamsa's `ft`,
//! `fn` and `fo`.
//!
//! Fusing joins a prefix of one byte string to a suffix of another at a
//! point where both continue alike. The search starts from every position
//! of each string and repeatedly keeps the pairs whose next bytes match,
//! so a longer search finds a longer shared context. The result often
//! reads as a plausible splice of the two, such as a repeated or truncated
//! element of a list.

use crate::source::Source;

/// How many candidate pairs the search may examine in total.
const SEARCH_FUEL: usize = 100_000;

/// The search stops after each refinement with probability 1/8.
const SEARCH_STOP: usize = 8;

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

/// Positions in `a` and `b` that a node's pairs have reached: every pair
/// shares the bytes read so far.
type Node = (Vec<usize>, Vec<usize>);

fn jump_points<S: Source>(source: &mut S, a: &[u8], b: &[u8]) -> (usize, usize) {
    let start = if a == b {
        alternate(source, a.len())
    } else {
        ((0..a.len()).collect(), (0..b.len()).collect())
    };
    let mut nodes = vec![start];
    let mut fuel = SEARCH_FUEL;
    loop {
        if fuel == 0 || source.below(SEARCH_STOP) == 0 {
            return any_pair(source, &nodes);
        }
        let next = refine(a, b, &nodes);
        if next.is_empty() {
            return any_pair(source, &nodes);
        }
        fuel = fuel.saturating_sub(next.len());
        nodes = next;
    }
}

/// When fusing a string with itself, deals the positions after the first
/// into the jump and landing sets at random, so the jump rarely lands
/// where it started.
fn alternate<S: Source>(source: &mut S, len: usize) -> Node {
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

/// Advances every node by one byte, keeping, for each byte value, the
/// positions in `a` and in `b` that continue with it.
fn refine(a: &[u8], b: &[u8], nodes: &[Node]) -> Vec<Node> {
    let mut out = Vec::new();
    for (froms, tos) in nodes {
        let mut by_byte: Vec<Node> = vec![(Vec::new(), Vec::new()); 256];
        for &position in froms {
            if let Some(&byte) = a.get(position) {
                by_byte[byte as usize].0.push(position + 1);
            }
        }
        for &position in tos {
            if let Some(&byte) = b.get(position) {
                by_byte[byte as usize].1.push(position + 1);
            }
        }
        out.extend(
            by_byte
                .into_iter()
                .filter(|(froms, tos)| !froms.is_empty() && !tos.is_empty()),
        );
    }
    out
}

fn any_pair<S: Source>(source: &mut S, nodes: &[Node]) -> (usize, usize) {
    let (froms, tos) = &nodes[source.below(nodes.len())];
    (
        froms[source.below(froms.len())],
        tos[source.below(tos.len())],
    )
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
        // Refine once, then stop. The two nodes hold the X pair and the Y
        // pair, and either jump comes right after its shared byte.
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
