// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Sample property-based tests using hegel <https://hegel.dev>, the
//! Hypothesis-derived PBT library. Exercises the generator API and the
//! `#[hegel::test]` / `#[hegel::state_machine]` macros end-to-end under
//! the buck2 test runner.
//!
//! NOTE: our rust toolchain compiles everything with `-Cpanic=abort`, and
//! hegel drives input rejection (`TestCase::assume`/`reject`), the
//! `#[hegel::state_machine]` stateful driver, and shrink-on-failure through
//! unwinding (`resume_unwind`), which aborts the process under panic=abort.
//! Plain `#[hegel::test]` properties that draw from generators work fine,
//! but: a failing property aborts on the first counterexample instead of
//! reporting a minimized one, and `assume`/`reject`/`stateful::run` must
//! be avoided entirely.

use hegel::TestCase;
use hegel::generators as gs;

/// Run-length encode a byte slice into (count, value) pairs.
fn rle_encode(data: &[u8]) -> Vec<(usize, u8)> {
    let mut out: Vec<(usize, u8)> = Vec::new();
    for &b in data {
        match out.last_mut() {
            Some((n, v)) if *v == b => *n += 1,
            _ => out.push((1, b)),
        }
    }
    out
}

/// Decode (count, value) pairs back into bytes.
fn rle_decode(runs: &[(usize, u8)]) -> Vec<u8> {
    let mut out = Vec::new();
    for &(n, v) in runs {
        out.extend(std::iter::repeat_n(v, n));
    }
    out
}

#[hegel::test]
fn rle_roundtrips(tc: TestCase) {
    let data = tc.draw(gs::vecs(gs::integers::<u8>()));
    assert_eq!(rle_decode(&rle_encode(&data)), data);
}

#[hegel::test]
fn rle_is_maximal(tc: TestCase) {
    // Every run is non-empty, and adjacent runs never share a value —
    // otherwise the encoding isn't canonical.
    let data = tc.draw(gs::vecs(gs::integers::<u8>()));
    let runs = rle_encode(&data);
    assert!(runs.iter().all(|&(n, _)| n > 0));
    assert!(runs.windows(2).all(|w| w[0].1 != w[1].1));
    assert_eq!(runs.iter().map(|&(n, _)| n).sum::<usize>(), data.len());
}

#[hegel::test]
fn sort_is_idempotent(tc: TestCase) {
    let mut v = tc.draw(gs::vecs(gs::integers::<i64>()));
    let len = v.len();
    v.sort();
    let once = v.clone();
    v.sort();
    assert_eq!(v, once);
    assert_eq!(v.len(), len);
}

#[hegel::test]
fn stack_push_pop_are_inverses(tc: TestCase) {
    // A lightweight model test: interpret a drawn op sequence against both
    // Vec and an index-tracked model of its length.
    let ops = tc.draw(gs::vecs(gs::integers::<i8>()));
    let mut stack: Vec<i8> = Vec::new();
    let mut model_len: usize = 0;
    for op in ops {
        if op >= 0 {
            stack.push(op);
            model_len += 1;
        } else if stack.pop().is_some() {
            model_len -= 1;
        }
        assert_eq!(stack.len(), model_len);
    }
}
