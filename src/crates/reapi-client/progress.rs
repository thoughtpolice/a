// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Optional transfer progress reporting.
//!
//! Progress is opt-in and off by default. A caller that never asks for it
//! links no reporting machinery and pays nothing, which matters for
//! latency-sensitive one-shot users; interactive ones hand in a callback.

use std::sync::Arc;

/// A sink for transfer progress.
///
/// [`Progress::none()`] (also [`Default`]) discards updates. Cloning is cheap:
/// the callback is behind an `Arc`, so a `Progress` can be handed to several
/// concurrent transfers.
#[derive(Clone, Default)]
pub struct Progress {
    sink: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
}

impl Progress {
    /// Report to `sink`, which receives `(transferred, total)` in bytes.
    ///
    /// `total` is the digest's declared size, so it is known before the first
    /// byte moves and does not change mid-transfer.
    pub fn new(sink: impl Fn(u64, u64) + Send + Sync + 'static) -> Self {
        Self {
            sink: Some(Arc::new(sink)),
        }
    }

    /// Discard all updates.
    pub fn none() -> Self {
        Self { sink: None }
    }

    /// True if anything is listening.
    pub fn is_enabled(&self) -> bool {
        self.sink.is_some()
    }

    pub(crate) fn report(&self, transferred: u64, total: u64) {
        if let Some(sink) = &self.sink {
            sink(transferred, total);
        }
    }
}

impl std::fmt::Debug for Progress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Progress")
            .field("enabled", &self.is_enabled())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn default_is_disabled_and_silently_discards() {
        let progress = Progress::default();
        assert!(!progress.is_enabled());
        progress.report(1, 2);
    }

    #[test]
    fn updates_reach_the_sink_in_order() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        let progress = Progress::new(move |done, total| {
            recorder.lock().unwrap().push((done, total));
        });

        assert!(progress.is_enabled());
        progress.report(0, 10);
        progress.report(4, 10);
        progress.report(10, 10);

        assert_eq!(*seen.lock().unwrap(), vec![(0, 10), (4, 10), (10, 10)]);
    }

    #[test]
    fn clones_share_one_sink() {
        let count = Arc::new(Mutex::new(0usize));
        let counter = Arc::clone(&count);
        let progress = Progress::new(move |_, _| *counter.lock().unwrap() += 1);

        let cloned = progress.clone();
        progress.report(1, 1);
        cloned.report(1, 1);

        assert_eq!(*count.lock().unwrap(), 2);
    }
}
