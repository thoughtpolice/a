// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp, 2024-2025 Egglog Authors
// SPDX-License-Identifier: Apache-2.0

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    egglog::cli(egglog::EGraph::default())
}
