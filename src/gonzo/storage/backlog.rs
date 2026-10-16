// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Refuses writes while the store is too far behind on them.
//!
//! A write waits inside SlateDB while its memtables cannot be flushed: L0
//! is full until compaction catches up, and compaction goes as fast as the
//! disk. Nothing else bounds that wait, so writes arriving faster than the
//! disk takes them join a queue that grows for as long as they do, and
//! uploads come to take tens of seconds while connections fill with
//! requests waiting on them. Once the oldest write under way has waited
//! longer than a limit, new writes are refused at once instead (the server
//! answers RESOURCE_EXHAUSTED, which Bazel and Buck treat as a failed cache
//! upload, not a failed build) until the store catches up. Reads are never
//! refused, and writes already under way carry on.

use std::collections::BTreeSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::error::{Result, StoreError};

/// How long the oldest write under way may have waited before new ones
/// are refused, by default.
pub const DEFAULT_MAX_WRITE_WAIT: Duration = Duration::from_secs(2);

/// The writes under way, by when each began.
pub(crate) struct Backlog {
    limit: Duration,
    under_way: Mutex<BTreeSet<(Instant, u64)>>,
    next: AtomicU64,
    /// Whether the last write to ask was refused, to log only the changes.
    refusing: AtomicBool,
}

/// A write under way; dropping it (done or abandoned) takes it off the
/// backlog.
pub(crate) struct Ticket<'a> {
    backlog: &'a Backlog,
    key: (Instant, u64),
}

impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        self.backlog
            .under_way
            .lock()
            .expect("backlog lock")
            .remove(&self.key);
    }
}

impl Backlog {
    /// Refuse writes once the oldest under way has waited past `limit`.
    pub(crate) fn new(limit: Duration) -> Self {
        Self {
            limit,
            under_way: Mutex::new(BTreeSet::new()),
            next: AtomicU64::new(0),
            refusing: AtomicBool::new(false),
        }
    }

    /// Admit a write, or refuse it while the store is behind.
    pub(crate) fn admit(&self) -> Result<Ticket<'_>> {
        let now = Instant::now();
        let mut under_way = self.under_way.lock().expect("backlog lock");
        let waited = under_way.first().map_or(Duration::ZERO, |(oldest, _)| {
            now.saturating_duration_since(*oldest)
        });
        if waited > self.limit {
            drop(under_way);
            if !self.refusing.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    waited_ms = waited.as_millis() as u64,
                    "the store is behind on writes; refusing new ones until it catches up"
                );
            }
            return Err(StoreError::Behind { waited });
        }
        let key = (now, self.next.fetch_add(1, Ordering::Relaxed));
        under_way.insert(key);
        drop(under_way);
        if self.refusing.swap(false, Ordering::Relaxed) {
            tracing::info!("the store has caught up on writes; taking them again");
        }
        Ok(Ticket { backlog: self, key })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_only_while_a_write_has_waited_too_long() {
        let backlog = Backlog::new(Duration::from_millis(50));
        let first = backlog.admit().unwrap();
        let second = backlog.admit().unwrap();
        std::thread::sleep(Duration::from_millis(80));

        let refused = backlog.admit().err().unwrap();
        assert!(
            matches!(refused, StoreError::Behind { waited } if waited >= Duration::from_millis(80)),
            "{refused}"
        );

        // The oldest finishing leaves one just as old: still behind.
        drop(first);
        assert!(backlog.admit().is_err());
        // Nothing under way: caught up.
        drop(second);
        let third = backlog.admit().unwrap();
        // A fresh write under way does not hold others back.
        assert!(backlog.admit().is_ok());
        drop(third);
    }
}
