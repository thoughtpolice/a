// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The simplification pass on generated modules: whatever wasm-smith draws
//! must simplify to a program that verifies and behaves exactly like the
//! original under the reference interpreter, invocation by invocation and
//! in the state each leaves behind.

use arbitrary::Unstructured;
use hegel::{HealthCheck, TestCase, generators as gs};
use wedge_testing::equivalence::{self, Verdict};
use wedge_testing::smith;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// A fixed pseudo-random byte stream, so the sample below is the same on
/// every run.
fn entropy(seed: u64, len: usize) -> Vec<u8> {
    let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ 0x2545_f491_4f6c_dd1d;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

/// The pass has to find work in generated modules for the comparison to
/// mean anything, so this keeps an eye on how often it does.
#[test]
fn generated_modules_are_simplified_and_compared() {
    let mut compared = 0;
    let mut changed = 0;
    let mut invocations = 0;
    let mut inconclusive = Vec::new();
    for seed in 1..=48 {
        let module = smith::executable_module(&entropy(seed, 4096)).expect("a module");
        match equivalence::check_simplified(
            &module,
            &mut Unstructured::new(&entropy(seed ^ 0x5eed, 512)),
        ) {
            Verdict::Equivalent {
                invocations: count,
                statistics,
            } => {
                compared += 1;
                invocations += count;
                changed += usize::from(statistics.changed());
            }
            Verdict::Inconclusive(why) => inconclusive.push(why),
            Verdict::Unverifiable(why) | Verdict::Divergent(why) => {
                panic!("seed {seed}: {why}\n{}", smith::text(&module))
            }
        }
    }
    eprintln!(
        "{compared}/48 modules compared over {invocations} invocations, {changed} changed by the pass; inconclusive: {inconclusive:#?}"
    );
    assert!(
        compared >= 24,
        "only {compared} of 48 generated modules were compared"
    );
    assert!(
        changed >= 12,
        "the pass changed only {changed} of 48 generated modules"
    );
    assert!(
        invocations >= 48,
        "only {invocations} invocations were compared"
    );
}

#[hegel::test(
    test_cases = 96,
    derandomize = true,
    database = None,
    suppress_health_check = [HealthCheck::FilterTooMuch]
)]
fn simplified_modules_behave_like_the_original(tc: TestCase) {
    let entropy = tc.draw_silent(gs::binary().max_size(4096));
    let arguments = tc.draw_silent(gs::binary().max_size(512));
    let module =
        smith::executable_module(&entropy).expect("wasm-smith draws a module from any byte string");
    tc.note(&smith::text(&module));
    match equivalence::check_simplified(&module, &mut Unstructured::new(&arguments)) {
        Verdict::Equivalent { .. } => {}
        Verdict::Inconclusive(why) => {
            tc.note(&why);
            tc.assume(false);
        }
        Verdict::Unverifiable(why) | Verdict::Divergent(why) => panic!("{why}"),
    }
}

/// The full profile, garbage collection and typed references included: the
/// pass must at least keep every generated program verifying, and equal to
/// itself where the comparison can run.
#[hegel::test(
    test_cases = 64,
    derandomize = true,
    database = None,
    suppress_health_check = [HealthCheck::FilterTooMuch]
)]
fn simplified_full_profile_modules_verify(tc: TestCase) {
    let entropy = tc.draw_silent(gs::binary().max_size(4096));
    let module = smith::module(&entropy).expect("wasm-smith draws a module from any byte string");
    tc.note(&smith::text(&module));
    match equivalence::check_simplified(&module, &mut Unstructured::new(&[])) {
        Verdict::Equivalent { .. } | Verdict::Inconclusive(_) => {}
        Verdict::Unverifiable(why) | Verdict::Divergent(why) => panic!("{why}"),
    }
}
