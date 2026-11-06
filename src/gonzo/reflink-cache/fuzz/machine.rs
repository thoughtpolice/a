// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Structure-aware: the input chooses the operations, power losses,
//! kills, faults and reopenings of the state machine the crash tests use
//! (`test_machine.rs`), on a cache on a simulated filesystem, and every
//! step is checked against its model.

#![no_main]

// ASan must own allocations in address-sanitized targets so its redzones
// are effective; coverage-only targets use the repository allocator.
#[cfg(not(fozzie_asan))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

// The machine refers to the crate's API through `crate::`.
#[allow(unused_imports)]
use reflink_cache::*;

#[path = "../test_machine.rs"]
mod machine;

use arbitrary::Unstructured;
use machine::{Draw, Machine};

/// Steps an input may take at most, so each stays quick.
const MAX_STEPS: usize = 80;

/// Choices from the input; once it runs out, every choice is 0.
struct Input<'a, 'b>(&'b mut Unstructured<'a>);

impl Draw for Input<'_, '_> {
    fn below(&mut self, n: u64) -> u64 {
        self.0.int_in_range(0..=n - 1).unwrap_or(0)
    }
}

fn run(data: &[u8]) {
    let mut u = Unstructured::new(data);
    let mut input = Input(&mut u);
    let mut machine = Machine::new(&mut input);
    for _ in 0..MAX_STEPS {
        if input.0.is_empty() {
            break;
        }
        machine.step(&mut input);
        machine.log.clear();
    }
    machine.finish(&mut input);
}

fozzie::fuzz_target!(|data: &[u8]| {
    run(data);
});
