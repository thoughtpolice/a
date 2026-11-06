// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Group commit: one sync of the dirty area's directory makes the names of
//! every file renamed in before it durable, so ingests finishing together
//! share it.
//!
//! Each rename into the dirty area takes a ticket, numbered in order,
//! after the rename. A sync reads the last ticket issued just before it
//! starts, and once it is done, every ticket up to that one is durable.
//! An ingest waits for its ticket. A sync is started whenever tickets wait
//! and none is running, so files renamed in while one runs wait for the
//! next, which covers all of them.
//!
//! A failed directory sync leaves unknown which names reached the disk,
//! and a later sync that succeeds does not settle it: after a failed
//! `fsync`, Linux may drop the error with the dirty pages. So the failure
//! is final: every waiting and later ingest fails, until the cache is
//! opened again, which syncs everything it finds.

use std::io;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::Inner;
use crate::fs::Fs;

pub(crate) struct Commits {
    state: Mutex<CommitState>,
    progress: watch::Sender<Progress>,
}

#[derive(Default)]
struct CommitState {
    /// The last ticket issued.
    issued: u64,
    syncing: bool,
}

#[derive(Clone, Default)]
struct Progress {
    /// The last ticket known durable.
    durable: u64,
    /// Why a sync failed, if one has.
    failed: Option<(io::ErrorKind, String)>,
}

impl Commits {
    pub fn new() -> Self {
        Commits {
            state: Mutex::default(),
            progress: watch::Sender::new(Progress::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CommitState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A ticket for a rename into the dirty area just made.
    pub fn issue(&self) -> u64 {
        let mut state = self.lock();
        state.issued += 1;
        state.issued
    }

    /// The error every ingest fails with once a sync has failed.
    pub fn failed(&self) -> Option<io::Error> {
        self.progress.borrow().failed.as_ref().map(failure)
    }
}

fn failure((kind, message): &(io::ErrorKind, String)) -> io::Error {
    io::Error::new(
        *kind,
        format!("syncing the dirty area failed, so the cache must be opened again: {message}"),
    )
}

impl<F: Fs> Inner<F> {
    /// Wait until `ticket`'s rename is durable.
    pub(crate) async fn wait_durable(self: &Arc<Self>, ticket: u64) -> io::Result<()> {
        let mut progress = self.commits.progress.subscribe();
        loop {
            {
                let now = progress.borrow_and_update();
                if now.durable >= ticket {
                    return Ok(());
                }
                if let Some(failed) = &now.failed {
                    return Err(failure(failed));
                }
            }
            self.start_sync();
            progress
                .changed()
                .await
                .expect("the cache keeps the sender");
        }
    }

    /// Start a sync of the dirty area, unless one is running or none is
    /// needed. It runs to the end whether or not anyone still waits, and
    /// starts the next if tickets were issued meanwhile.
    fn start_sync(self: &Arc<Self>) {
        {
            let mut state = self.commits.lock();
            let progress = self.commits.progress.borrow();
            if state.syncing || progress.failed.is_some() || progress.durable >= state.issued {
                return;
            }
            state.syncing = true;
        }
        let inner = self.clone();
        let syncing = Syncing(self.clone());
        tokio::spawn(async move {
            inner
                .fs
                .blocking(move || {
                    let work = syncing.0.clone();
                    let covered = work.commits.lock().issued;
                    let synced = work.fs.sync_dir(&work.layout.dirty);
                    work.commits.progress.send_modify(|progress| match synced {
                        Ok(()) => progress.durable = progress.durable.max(covered),
                        Err(e) => progress.failed = Some((e.kind(), e.to_string())),
                    });
                    drop(syncing);
                    work.start_sync();
                })
                .await
        });
    }
}

/// A sync started, which is over when this is dropped: when it is done,
/// or if its runtime shut down before it ran, so that the next waiter
/// starts another.
struct Syncing<F: Fs>(Arc<Inner<F>>);

impl<F: Fs> Drop for Syncing<F> {
    fn drop(&mut self) {
        self.0.commits.lock().syncing = false;
    }
}
