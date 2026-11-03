// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Sizing quick_cache shards for values of uneven weight.

/// A quick_cache of `capacity_bytes` in shards of at least `min_shard_bytes`,
/// and no more of them than quick_cache would use by default (four per CPU).
///
/// quick_cache splits its budget evenly between shards and turns away any
/// entry heavier than a shard's share. A cache holding a few large values
/// among many small ones (SST indexes among blocks, say) must keep its
/// shards at least as large as the largest value it means to keep, or it
/// keeps none of them.
pub fn shard_options(capacity_bytes: u64, min_shard_bytes: u64) -> quick_cache::Options {
    // quick_cache sizes its tables from an item estimate; 4 KiB a piece
    // errs high for caches of blocks and small values.
    let items = usize::try_from(capacity_bytes / 4096)
        .unwrap_or(usize::MAX)
        .clamp(1024, 1 << 22);
    let default_shards = std::thread::available_parallelism().map_or(4, |n| n.get() * 4);
    let shards = usize::try_from(capacity_bytes / min_shard_bytes.max(1))
        .unwrap_or(usize::MAX)
        .clamp(1, default_shards);
    quick_cache::OptionsBuilder::new()
        .estimated_items_capacity(items)
        .weight_capacity(capacity_bytes.max(1))
        .shards(shards)
        .build()
        .expect("valid cache options")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Len;

    impl quick_cache::Weighter<u64, Vec<u8>> for Len {
        fn weight(&self, _key: &u64, value: &Vec<u8>) -> u64 {
            value.len() as u64
        }
    }

    /// A value as large as a shard's minimum is kept alongside thousands
    /// of small ones.
    #[test]
    fn large_values_are_kept() {
        let capacity = 128 << 20;
        let cache = quick_cache::sync::Cache::<u64, Vec<u8>, Len>::with_options(
            shard_options(capacity, 16 << 20),
            Len,
            Default::default(),
            Default::default(),
        );
        for key in 0..4096 {
            cache.insert(key, vec![0; 4096]);
        }
        cache.insert(u64::MAX, vec![0; 6 << 20]);
        assert!(cache.get(&u64::MAX).is_some());
        assert!(cache.weight() <= capacity);
    }
}
