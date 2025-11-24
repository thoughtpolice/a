// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Test program to print mimalloc statistics after performing allocations.

use mimalloc::{
    bin_size, collect, good_size, process_info, stats_get, stats_get_merged, stats_reset,
};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn print_stats() {
    println!("=== mimalloc Statistics Test ===\n");

    // Reset statistics to start fresh
    stats_reset();

    // Print process info before allocations
    println!("--- Process Info (before allocations) ---");
    let info_before = process_info();
    println!("{}", info_before);
    println!();

    // Perform various allocations
    println!("Performing allocations...");
    let mut allocations = Vec::new();

    // Small allocations
    for i in 0..100 {
        allocations.push(vec![0u8; 32]);
        if i % 10 == 0 {
            allocations.push(vec![0u8; 1024]);
        }
    }

    // Medium allocations
    for _ in 0..10 {
        allocations.push(vec![0u8; 8192]);
    }

    // Large allocation
    allocations.push(vec![0u8; 1024 * 1024]);

    println!("Allocations complete.\n");

    // Print some bin sizes and good_size examples
    println!("--- Bin Sizes and Good Sizes ---");
    for i in 0..10 {
        if let Some(size) = bin_size(i) {
            println!("Bin {}: {} bytes", i, size);
        }
    }
    println!();

    println!("Good size examples:");
    for size in [1, 10, 100, 1000, 10000] {
        let good = good_size(size);
        println!(
            "  {} bytes -> {} bytes ({}% overhead)",
            size,
            good,
            ((good - size) * 100) / size.max(1)
        );
    }
    println!();

    // Get statistics without merging
    println!("--- Statistics (without merge) ---");
    let stats = stats_get();
    println!("{}", stats);
    println!();

    // Get statistics with merging
    println!("--- Statistics (with merge) ---");
    let stats_merged = stats_get_merged();
    println!("{}", stats_merged);
    println!();

    // Print detailed bin statistics
    println!("--- Detailed Bin Statistics ---");
    println!("Non-zero malloc bins:");
    for (i, bin) in stats_merged.malloc_bins().enumerate() {
        if bin.current() > 0 {
            println!(
                "  Bin {}: {} bytes allocated (count: {})",
                i,
                bin.current(),
                bin.total()
            );
        }
    }
    println!();

    // Print process info after allocations
    println!("--- Process Info (after allocations) ---");
    let info_after = process_info();
    println!("{}", info_after);
    println!();

    println!("--- Memory Deltas ---");
    println!(
        "  RSS increase: {} bytes",
        info_after.peak_rss as i64 - info_before.peak_rss as i64
    );
    println!(
        "  Commit increase: {} bytes",
        info_after.peak_commit as i64 - info_before.peak_commit as i64
    );
    println!();

    // Demonstrate collect
    drop(allocations);
    println!("--- After freeing allocations ---");
    collect(false); // Gentle GC
    let stats_after_free = stats_get_merged();
    println!(
        "Current normal allocations: {} bytes",
        stats_after_free.malloc_normal().current()
    );
    println!(
        "Peak normal allocations: {} bytes",
        stats_after_free.malloc_normal().peak()
    );
    println!();

    // Force GC
    collect(true);
    println!("After forced collection:");
    let stats_after_collect = stats_get_merged();
    println!(
        "Current normal allocations: {} bytes",
        stats_after_collect.malloc_normal().current()
    );
}

fn main() {
    print_stats();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_print_stats() {
        print_stats();
    }
}
