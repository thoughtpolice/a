// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Hegel drives the machine in `test_machine` through operations, power
//! losses, kills, faults and reopenings.

use hegel::TestCase;
use hegel::generators as gs;

use crate::test_machine::{Draw, Machine};

struct Hegel<'a>(&'a TestCase);

impl Draw for Hegel<'_> {
    fn below(&mut self, n: u64) -> u64 {
        self.0.draw(gs::integers::<u64>().max_value(n - 1))
    }
}

/// Choices in a crash, of which there are many, are drawn without being
/// printed.
struct Quiet<'a>(&'a TestCase);

impl Draw for Quiet<'_> {
    fn below(&mut self, n: u64) -> u64 {
        self.0.draw_silent(gs::integers::<u64>().max_value(n - 1))
    }
}

#[hegel::test(test_cases = 1000, database = None)]
fn nothing_acknowledged_is_lost_and_nothing_torn_is_served(tc: TestCase) {
    let mut machine = Machine::new(&mut Hegel(&tc));
    let steps = tc.draw(gs::integers::<usize>().max_value(40));
    for _ in 0..steps {
        machine.step(&mut Hegel(&tc));
        for line in machine.log.drain(..) {
            tc.note(&line);
        }
    }
    machine.finish(&mut Quiet(&tc));
}
