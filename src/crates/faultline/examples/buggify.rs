// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Seeded BUGGIFY exploration of a chunked copy.
//!
//! BUGGIFY branches perturb the copy without changing what it promises: tiny
//! chunks and extra yields must still produce identical output. Each seed
//! explores a different combination of active sites. Pass a seed to replay
//! one run: `buck2 run //src/crates/faultline:example-buggify -- 12`.

use faultline::{BuggifyConfig, Injector, buggify};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

async fn copy(faults: &Injector<()>, input: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len());
    let mut rest = input;
    while !rest.is_empty() {
        let chunk = if buggify!(faults, "copy.tiny_chunk") {
            1
        } else {
            4096
        };
        let (head, tail) = rest.split_at(chunk.min(rest.len()));
        output.extend_from_slice(head);
        rest = tail;
        if buggify!(faults, "copy.yield") {
            tokio::task::yield_now().await;
        }
    }
    output
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let input: Vec<u8> = (0..10_000u32).map(|i| i as u8).collect();
    let seeds: Vec<u64> = match std::env::args().nth(1) {
        Some(seed) => vec![seed.parse().expect("seed must be a u64")],
        None => (0..8).collect(),
    };

    for seed in seeds {
        let faults = Injector::with_seed(seed);
        let run = faults.buggify().scoped(BuggifyConfig::default()).unwrap();
        assert_eq!(copy(&faults, &input).await, input, "seed {seed}");
        run.release();

        let sites: Vec<String> = run
            .snapshot()
            .iter()
            .map(|site| {
                let state = if site.activated { "active" } else { "inactive" };
                format!("{} {state} {}/{}", site.name, site.fired, site.hits)
            })
            .collect();
        println!("seed {seed}: {}", sites.join(", "));
    }
}
