// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Generative contracts for the effect conflict relation.
//!
//! Every generator here is bounded by construction so a derandomized run
//! spends its whole case budget on accepted cases; the assertion helpers print
//! their context before panicking and Hegel shrinks the failure.

use hegel::{Generator, TestCase, generators as gs};
use wedge::ir::Operation;
use wedge::opcode::CoreOpcode;
use wedge::semantics::effects_for_operation;

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

macro_rules! property_panic {
    ($($message:tt)*) => {{
        eprintln!($($message)*);
        panic!("property failed after printing its diagnostic");
    }};
}

macro_rules! property_assert {
    ($condition:expr, $($message:tt)*) => {{
        if !$condition {
            property_panic!($($message)*);
        }
    }};
}

#[hegel::test(test_cases = 400, derandomize = true, database = None)]
fn effect_conflicts_are_symmetric_and_cover_every_aliasing_writer(tc: TestCase) {
    let left = tc.draw(gs::sampled_from(CoreOpcode::ALL).print_as_debug());
    let right = tc.draw(gs::sampled_from(CoreOpcode::ALL).print_as_debug());
    // Without immediates the classifiers default to the first memory, table,
    // and global, so shared resources are common.
    let left_effects = effects_for_operation(&Operation::core(left, vec![], vec![]));
    let right_effects = effects_for_operation(&Operation::core(right, vec![], vec![]));

    property_assert!(
        left_effects.conflicts_with(&right_effects) == right_effects.conflicts_with(&left_effects),
        "conflict is not symmetric for {} and {}",
        left.parser_name(),
        right.parser_name()
    );
    let shared_writer = left_effects.accesses.iter().any(|a| {
        right_effects
            .accesses
            .iter()
            .any(|b| a.resource == b.resource && (a.access.writes() || b.access.writes()))
    });
    if shared_writer {
        property_assert!(
            left_effects.conflicts_with(&right_effects),
            "{} and {} share a written resource but do not conflict",
            left.parser_name(),
            right.parser_name()
        );
    }
    if left_effects.is_barrier() && (!right_effects.accesses.is_empty() || right_effects.allocates)
    {
        property_assert!(
            left_effects.conflicts_with(&right_effects),
            "barrier {} does not conflict with {}",
            left.parser_name(),
            right.parser_name()
        );
    }
}
