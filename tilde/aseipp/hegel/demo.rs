// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Sample property-based tests using hegel <https://hegel.dev>, the
//! Hypothesis-derived PBT library. Exercises the generator API and the
//! `#[hegel::test]` / `#[hegel::state_machine]` macros end-to-end under
//! the buck2 test runner.
//!
//! The rust toolchain keeps rustc's default `panic=unwind`, which hegel
//! depends on: input rejection (`TestCase::assume`/`reject`), the
//! `#[hegel::state_machine]` stateful driver, and shrink-on-failure all
//! travel through unwinding (`resume_unwind`). `assume_rejects_without_aborting`
//! is the smoke test that rejection survives Buck's test build.

use hegel::generators as gs;
use hegel::{HealthCheck, TestCase};

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

#[hegel::test(suppress_health_check = [HealthCheck::FilterTooMuch])]
fn assume_rejects_without_aborting(tc: TestCase) {
    // Half of the drawn cases are rejected, which hegel reports by unwinding
    // out of `assume`; under `panic=abort` the first rejection would kill
    // the process.
    let keep = tc.draw(gs::booleans());
    tc.assume(keep);
    assert!(keep);
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
