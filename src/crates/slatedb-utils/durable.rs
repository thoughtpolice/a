// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A SlateDB database whose writes return once durable, behind a write
//! admission gate, and whose reads honor expiry.

use bytes::Bytes;
use slatedb::config::{DurabilityLevel, ReadOptions};
use slatedb::{CloseReason, Db, WriteBatch};
use write_admission::{Admission, Permit, Refused};

/// Why a write failed: refused before it began, or failed in SlateDB.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Refused(#[from] Refused),
    #[error(transparent)]
    Db(#[from] slatedb::Error),
}

/// Milliseconds since the Unix epoch, the unit of SlateDB's expiry times.
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Reads that see only durable data, for deciding whether a write can be
/// skipped: a write still in flight is not yet stored as far as a writer
/// that would rely on it is concerned, and skipping on its strength would
/// acknowledge a write before anything made it durable.
pub fn durable_reads() -> ReadOptions {
    ReadOptions {
        durability_filter: DurabilityLevel::Remote,
        ..ReadOptions::default()
    }
}

/// Reads that leave the block cache alone: of bulk data that would evict
/// what the cache is for (see [`flush_cache_policy`]).
///
/// [`flush_cache_policy`]: crate::segments::flush_cache_policy
pub fn uncached_reads() -> ReadOptions {
    ReadOptions {
        cache_blocks: false,
        ..ReadOptions::default()
    }
}

/// A [`Db`] whose writes are admitted first and return once durable.
///
/// SlateDB acknowledges a write as soon as it is in the in-memory WAL, and
/// makes it durable on the next flush tick. A store that answered then
/// could lose a write it had told its client succeeded, or report a value
/// present that a crash then takes away, so every write here waits.
/// Concurrent waits are satisfied by the same flush.
pub struct DurableDb {
    db: Db,
    admission: Admission,
}

impl std::fmt::Debug for DurableDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DurableDb").finish_non_exhaustive()
    }
}

impl DurableDb {
    /// `db`, its writes gated by `admission`.
    pub fn new(db: Db, admission: Admission) -> Self {
        Self { db, admission }
    }

    /// The database, for reads and anything else this does not wrap.
    /// Writes through it skip admission and durability.
    pub fn db(&self) -> &Db {
        &self.db
    }

    /// The gate writes pass.
    pub fn admission(&self) -> &Admission {
        &self.admission
    }

    /// Admit a write of the caller's own, or refuse it. Hold the permit
    /// until the write is done.
    pub fn admit(&self) -> Result<Permit<'_>, Refused> {
        self.admission.admit()
    }

    /// The value at `key` and when it expires (ms since the epoch), or
    /// `None` if it is absent or has expired.
    ///
    /// SlateDB drops an expired value only once compaction reaches it, and
    /// until then a plain read still returns it: a value would outlive its
    /// TTL by however long compaction takes, and worse, a write of it
    /// could be skipped as already stored just before compaction removed
    /// it.
    pub async fn get_live(
        &self,
        key: &[u8],
        options: &ReadOptions,
    ) -> Result<Option<(Bytes, Option<i64>)>, slatedb::Error> {
        let Some(entry) = self.db.get_key_value_with_options(key, options).await? else {
            return Ok(None);
        };
        if entry.expire_ts.is_some_and(|at| at <= now_millis()) {
            return Ok(None);
        }
        Ok(Some((entry.value, entry.expire_ts)))
    }

    /// Put `value` at `key`, returning once it is durable.
    pub async fn put(&self, key: Bytes, value: Bytes) -> Result<(), Error> {
        let _write = self.admit()?;
        self.db.put_bytes(key, value).await?.await_durable().await?;
        Ok(())
    }

    /// Write `batch`, returning once it is durable.
    pub async fn commit(&self, batch: WriteBatch) -> Result<(), Error> {
        let _write = self.admit()?;
        self.db.write(batch).await?.await_durable().await?;
        Ok(())
    }

    /// Write `batch` without waiting for it to be durable. Writes become
    /// durable in order, so a later [`commit`](Self::commit) returning
    /// means this one is durable too.
    pub async fn write_ahead(&self, batch: WriteBatch) -> Result<(), Error> {
        let _write = self.admit()?;
        self.db.write(batch).await?;
        Ok(())
    }

    /// Resolves once the database has stopped for any reason but a clean
    /// close, with that reason: fenced by another writer that opened it, or
    /// stopped by a failed background task (WAL upload, memtable flush,
    /// compaction, garbage collection). Every operation fails from then on.
    /// Never resolves otherwise.
    pub async fn failed(&self) -> CloseReason {
        let mut status = self.db.subscribe();
        loop {
            match status.borrow_and_update().close_reason {
                None => {}
                Some(CloseReason::Clean) => break,
                Some(reason) => return reason,
            }
            if status.changed().await.is_err() {
                break;
            }
        }
        std::future::pending().await
    }

    /// Close the database cleanly.
    pub async fn close(&self) -> Result<(), slatedb::Error> {
        self.db.close().await
    }
}
