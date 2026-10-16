// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The open-files limit, and how many connections it leaves room for.
//!
//! Every connection is a descriptor, and so is every SST file a local store
//! has open. Many systems start processes with a soft limit of 1024 under a
//! far higher hard one; a server that keeps it runs out under a modest
//! number of clients, and once out, the store's next open fails too.

/// Raise the soft limit on open files to the hard one. Returns the soft
/// limit before and after, or `None` if it could not be read.
pub(crate) fn raise_open_files_limit() -> Option<(u64, u64)> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit writes only into `limit`.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return None;
    }
    let before = limit.rlim_cur as u64;
    if limit.rlim_cur < limit.rlim_max {
        let raised = libc::rlimit {
            rlim_cur: limit.rlim_max,
            rlim_max: limit.rlim_max,
        };
        // SAFETY: setrlimit only reads `raised`.
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raised) } == 0 {
            return Some((before, raised.rlim_cur as u64));
        }
    }
    Some((before, before))
}

/// Connections to allow when `open_files` descriptors are available: a
/// quarter of them (at least 1024) stay for the store, the logs, and the
/// rest, and never fewer than 64 connections.
pub fn max_connections(open_files: u64) -> usize {
    let reserve = (open_files / 4).max(1024);
    usize::try_from(open_files.saturating_sub(reserve))
        .unwrap_or(usize::MAX)
        .max(64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connections_leave_room_for_the_store() {
        assert_eq!(max_connections(1024), 64);
        assert_eq!(max_connections(4096), 3072);
        assert_eq!(max_connections(1 << 20), 3 << 18);
    }

    #[test]
    fn the_soft_limit_ends_at_the_hard_one() {
        let (before, after) = raise_open_files_limit().expect("getrlimit");
        assert!(after >= before);
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: as above.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
            0
        );
        assert_eq!(limit.rlim_cur, limit.rlim_max);
    }
}
