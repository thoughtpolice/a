// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Configure mimalloc arena reserves based on detected cgroup memory
//! limits.
//!
//! Mimalloc's default arena reserve can be 1 GiB+ on 64-bit systems.
//! In a 512 MiB container this causes unnecessary virtual memory
//! overhead and can confuse OOM killers that inspect commit charge.

/// Tune mimalloc arena settings for the given memory limit.
///
/// If `memory_limit` is `Some`, sets the arena reserve to
/// `min(limit / 4, 256 MiB)` so that mimalloc does not pre-reserve
/// more virtual address space than the container can back.
///
/// If `memory_limit` is `None`, mimalloc's compiled-in defaults are
/// left untouched.
pub(crate) fn configure(memory_limit: Option<u64>) {
    let Some(limit) = memory_limit else {
        return;
    };

    const MAX_RESERVE: u64 = 256 * 1024 * 1024; // 256 MiB
    let reserve_bytes = std::cmp::min(limit / 4, MAX_RESERVE);

    // ArenaReserve is specified in KiB in the mimalloc option API.
    let reserve_kib = (reserve_bytes / 1024) as i64;
    mimalloc::option_set(mimalloc::MiOption::ArenaReserve, reserve_kib);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_limit_leaves_defaults() {
        let before = mimalloc::option_get(mimalloc::MiOption::ArenaReserve);
        configure(None);
        let after = mimalloc::option_get(mimalloc::MiOption::ArenaReserve);
        assert_eq!(before, after);
    }

    #[test]
    fn small_limit_caps_reserve() {
        // 512 MiB container → reserve should be 128 MiB (limit / 4).
        let original = mimalloc::option_get(mimalloc::MiOption::ArenaReserve);

        configure(Some(512 * 1024 * 1024));
        let value = mimalloc::option_get(mimalloc::MiOption::ArenaReserve);
        // 128 MiB = 131072 KiB
        assert_eq!(value, 131072, "should be limit/4 for small containers");

        mimalloc::option_set(mimalloc::MiOption::ArenaReserve, original);
    }

    #[test]
    fn large_limit_caps_at_256mib() {
        // 8 GiB container → limit/4 = 2 GiB, but capped at 256 MiB.
        let original = mimalloc::option_get(mimalloc::MiOption::ArenaReserve);

        configure(Some(8 * 1024 * 1024 * 1024));
        let value = mimalloc::option_get(mimalloc::MiOption::ArenaReserve);
        // 256 MiB = 262144 KiB
        assert_eq!(value, 262144, "should cap at 256 MiB");

        mimalloc::option_set(mimalloc::MiOption::ArenaReserve, original);
    }
}
