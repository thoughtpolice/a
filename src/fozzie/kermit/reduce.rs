// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT

//! Structure-aware reduction of failing inputs.
//!
//! A fuzzer's minimizer deletes byte ranges until no deletion keeps the
//! failure. [`reduce`] goes on from there with what kermit guesses about
//! the input's structure. It deletes whole lines and bracketed nodes,
//! empties and unwraps nodes, lowers decimal numbers, and replaces letters
//! and binary bytes with simpler ones.
//!
//! Every change it keeps makes the input shortlex smaller: shorter, or as
//! long and lexicographically less. Reduction therefore always ends.

use crate::lines::binarish;
use crate::number::digit_runs;
use crate::tree::{self, Tree};
use num_bigint::BigUint;
use std::ops::Range;

/// How many values the number pass tries for one number. A binary search
/// needs one per bit, so this covers numbers up to about 2^64 exactly and
/// stops early on longer digit runs.
const NUMBER_PROBES: usize = 64;

/// Reduces `input`, keeping only the changes for which `fails` still
/// returns true. `input` itself should fail. The passes repeat until none
/// of them changes the input, and an error from `fails` stops reduction.
pub fn reduce<E>(
    mut input: Vec<u8>,
    mut fails: impl FnMut(&[u8]) -> Result<bool, E>,
) -> Result<Vec<u8>, E> {
    loop {
        let before = input.clone();
        input = greedy(input, line_deletions, &mut fails)?;
        input = greedy(input, node_changes, &mut fails)?;
        input = lower_numbers(input, &mut fails)?;
        input = greedy(input, byte_simplifications, &mut fails)?;
        if input == before {
            return Ok(input);
        }
    }
}

/// Replaces `range` with `with`.
struct Change {
    range: Range<usize>,
    with: Vec<u8>,
}

impl Change {
    fn delete(range: Range<usize>) -> Self {
        Self {
            range,
            with: Vec::new(),
        }
    }

    fn apply(&self, input: &[u8]) -> Vec<u8> {
        [
            &input[..self.range.start],
            &self.with,
            &input[self.range.end..],
        ]
        .concat()
    }
}

/// Whether `a` is shortlex smaller than `b`.
fn simpler(a: &[u8], b: &[u8]) -> bool {
    a.len() < b.len() || (a.len() == b.len() && a < b)
}

/// Tries the changes `pass` proposes in order, keeping each that is simpler
/// and still fails. After a kept change the pass proposes again from the
/// same place in its list, since the changes before it failed already.
fn greedy<E>(
    mut input: Vec<u8>,
    pass: fn(&[u8]) -> Vec<Change>,
    fails: &mut impl FnMut(&[u8]) -> Result<bool, E>,
) -> Result<Vec<u8>, E> {
    let mut start = 0;
    'propose: loop {
        let changes = pass(&input);
        for (index, change) in changes.iter().enumerate().skip(start) {
            let candidate = change.apply(&input);
            if simpler(&candidate, &input) && fails(&candidate)? {
                input = candidate;
                start = index;
                continue 'propose;
            }
        }
        return Ok(input);
    }
}

/// Deletes each line of an input with more than one.
fn line_deletions(input: &[u8]) -> Vec<Change> {
    let mut changes = Vec::new();
    let mut at = 0;
    for line in input.split_inclusive(|&byte| byte == b'\n') {
        changes.push(Change::delete(at..at + line.len()));
        at += line.len();
    }
    if changes.len() < 2 {
        changes.clear();
    }
    changes
}

/// Deletes each bracketed or quoted node, then empties each, then unwraps
/// each, larger nodes first within each kind. Binary-looking data has no
/// nodes, as for the tree mutators.
fn node_changes(input: &[u8]) -> Vec<Change> {
    if binarish(input) {
        return Vec::new();
    }
    fn walk(trees: &[Tree], at: &mut usize, out: &mut Vec<Range<usize>>) {
        for tree in trees {
            match tree {
                Tree::Byte(_) => *at += 1,
                Tree::Node(children) => {
                    let start = *at;
                    walk(children, at, out);
                    out.push(start..*at);
                }
            }
        }
    }
    let mut nodes = Vec::new();
    walk(&tree::parse(input), &mut 0, &mut nodes);
    nodes.sort_by_key(|node| std::cmp::Reverse(node.len()));
    let inner = |node: &Range<usize>| node.start + 1..node.end - 1;
    let deletions = nodes.iter().map(|node| Change::delete(node.clone()));
    let empties = nodes.iter().map(|node| Change::delete(inner(node)));
    let unwraps = nodes.iter().map(|node| Change {
        range: node.clone(),
        with: input[inner(node)].to_vec(),
    });
    deletions.chain(empties).chain(unwraps).collect()
}

/// Lowers each decimal number to the least value that still fails, by a
/// binary search that assumes larger values fail as smaller ones do. It
/// tries zero first, and a number that fails at no lower value stays.
fn lower_numbers<E>(
    mut input: Vec<u8>,
    fails: &mut impl FnMut(&[u8]) -> Result<bool, E>,
) -> Result<Vec<u8>, E> {
    // Rewriting digits as digits keeps the runs, so the index stays valid.
    let mut index = 0;
    while let Some(run) = digit_runs(&input).get(index).cloned() {
        index += 1;
        let digits = std::str::from_utf8(&input[run.clone()]).expect("digits are ASCII");
        let mut high: BigUint = digits.parse().expect("a digit run parses");
        let with = |value: &BigUint| {
            Change {
                range: run.clone(),
                with: value.to_string().into_bytes(),
            }
            .apply(&input)
        };
        let mut low = None;
        let mut best = None;
        for _ in 0..NUMBER_PROBES {
            // Zero first, then halfway between the highest value known to
            // pass and the lowest known to fail.
            let probe = match &low {
                None => BigUint::ZERO,
                Some(low) if &high - low > BigUint::from(1_u8) => (low + &high) / 2_u8,
                Some(_) => break,
            };
            let candidate = with(&probe);
            if simpler(&candidate, &input) && fails(&candidate)? {
                best = Some(candidate);
                if probe == BigUint::ZERO {
                    break;
                }
                high = probe;
            } else {
                low = Some(probe);
            }
        }
        if let Some(best) = best {
            input = best;
        }
    }
    Ok(input)
}

/// The simplest byte like `byte`: `a` for a lowercase letter, `A` for an
/// uppercase one, and zero for a byte that is not text. Digits, which the
/// number pass lowers, and other text stay.
fn simplest(byte: u8) -> Option<u8> {
    match byte {
        b'a'..=b'z' => Some(b'a'),
        b'A'..=b'Z' => Some(b'A'),
        b'\t' | b'\n' | b'\r' | b' '..=b'~' => None,
        _ => Some(0),
    }
}

/// Replaces each run of bytes that simplify alike with the simplest of
/// them, so `Hello` becomes `Aaaaa`, then tries each byte alone.
fn byte_simplifications(input: &[u8]) -> Vec<Change> {
    let mut runs = Vec::new();
    let mut at = 0;
    while at < input.len() {
        let class = simplest(input[at]);
        let end = at
            + input[at..]
                .iter()
                .take_while(|&&byte| simplest(byte) == class)
                .count();
        if let Some(byte) = class {
            runs.push(Change {
                range: at..end,
                with: vec![byte; end - at],
            });
        }
        at = end;
    }
    let singles = input.iter().enumerate().filter_map(|(at, &byte)| {
        simplest(byte).map(|simple| Change {
            range: at..at + 1,
            with: vec![simple],
        })
    });
    let mut changes: Vec<Change> = runs.into_iter().collect();
    changes.extend(singles);
    changes
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;

    fn reduced(input: &[u8], fails: impl Fn(&[u8]) -> bool) -> Vec<u8> {
        let fails = |candidate: &[u8]| Ok::<_, Infallible>(fails(candidate));
        let Ok(out) = reduce(input.to_vec(), fails);
        out
    }

    fn contains(data: &[u8], needle: &[u8]) -> bool {
        data.windows(needle.len()).any(|window| window == needle)
    }

    #[test]
    fn deletes_lines() {
        let input = b"first\nNEEDLE\nlast\n";
        assert_eq!(
            reduced(input, |data| contains(data, b"NEEDLE")),
            b"NEEDLE\n"
        );
    }

    #[test]
    fn deletes_empties_and_unwraps_nodes() {
        let input = b"call(f(x), [one, two], {k: \"v\"})";
        // The nodes the failure needs no part of go, and the call's
        // parentheses with them. Loose bytes such as the commas are left
        // for a byte-range minimizer.
        assert_eq!(
            reduced(input, |data| contains(data, b"(x)")),
            b"aaaaa(x), , "
        );
        assert_eq!(reduced(input, |data| contains(data, b"[]")), b"aaaaa, [], ");
    }

    #[test]
    fn lowers_numbers_to_the_boundary() {
        let input = b"width=640000\nheight=480\n";
        let overflows = |data: &[u8]| {
            data.split(|&byte| byte == b'\n').any(|line| {
                line.strip_prefix(b"width=")
                    .and_then(|value| std::str::from_utf8(value).ok()?.parse::<u64>().ok())
                    .is_some_and(|value| value > 0xffff)
            })
        };
        assert_eq!(reduced(input, overflows), b"width=65536\n");
        // Zero comes first, and a number nothing lower fails at stays.
        assert_eq!(
            reduced(b"x=12 y=34", |data| contains(data, b"y=")),
            b"a=0 y=0"
        );
        assert_eq!(reduced(b"n=12", |data| data == b"n=12"), b"n=12");
    }

    #[test]
    fn simplifies_letters_and_binary_bytes() {
        let input = b"Hello, World";
        let out = reduced(input, |data| data.len() == 12 && contains(data, b", "));
        assert_eq!(out, b"Aaaaa, Aaaaa");
        let input = [0xde, 0xad, 0xbe, 0xef];
        assert_eq!(
            reduced(&input, |data| data.get(1) == Some(&0xad)),
            [0, 0xad, 0, 0]
        );
    }

    #[test]
    fn errors_stop_reduction() {
        let mut calls = 0;
        let result = reduce(b"a\nb\n".to_vec(), |_| {
            calls += 1;
            Err("target died")
        });
        assert_eq!(result, Err("target died"));
        assert_eq!(calls, 1);
    }
}
