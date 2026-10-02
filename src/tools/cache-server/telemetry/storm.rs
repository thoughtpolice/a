// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A cap on how often any one log statement may fire.
//!
//! Some failures log once per request, or once per write: SlateDB warns on
//! every write it holds back while its memtables drain, which under a burst of
//! uploads is tens of thousands of identical lines a second. That costs CPU
//! for formatting and writing them, floods whatever collects the logs, and
//! buries everything else. [`LogStormGuard`] lets each statement through at
//! most a fixed number of times a second and counts what it drops, for
//! [`LogStormGuard::take_suppressed`] to report.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use tracing::level_filters::LevelFilter;
use tracing::{Event, Metadata};
use tracing_subscriber::layer::{Context, Filter};

/// Statements are tracked in this many slots, by callsite address; two
/// statements sharing a slot share its budget.
const SLOTS: usize = 1024;

/// Drops events from any one statement beyond `per_second` a second.
///
/// A per-layer [`Filter`], to combine with a layer's own (`.and(guard)`).
/// Clones share their budget, so give each layer its own guard: an event
/// that two layers see would otherwise count twice.
#[derive(Clone)]
pub struct LogStormGuard {
    inner: Arc<Inner>,
}

struct Inner {
    /// Per slot: the second (since `epoch`) it counts in, high 32 bits, and
    /// events seen in it, low 32.
    slots: Box<[AtomicU64]>,
    epoch: Instant,
    per_second: u32,
    suppressed: AtomicU64,
}

impl LogStormGuard {
    pub fn new(per_second: u32) -> Self {
        Self {
            inner: Arc::new(Inner {
                slots: (0..SLOTS).map(|_| AtomicU64::new(0)).collect(),
                epoch: Instant::now(),
                per_second,
                suppressed: AtomicU64::new(0),
            }),
        }
    }

    /// Whether the statement at `callsite` may log now.
    fn admit(&self, callsite: usize) -> bool {
        let inner = &*self.inner;
        // Callsites are statics, at least 8-aligned: drop the low bits.
        let slot = &inner.slots[(callsite >> 3).wrapping_mul(0x9E37_79B9) % SLOTS];
        let now = inner.epoch.elapsed().as_secs() as u32;
        let mut current = slot.load(Ordering::Relaxed);
        loop {
            let (second, count) = ((current >> 32) as u32, current as u32);
            let count = if second == now {
                count.saturating_add(1)
            } else {
                1
            };
            let next = (u64::from(now) << 32) | u64::from(count);
            match slot.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => {
                    let admitted = count <= inner.per_second;
                    if !admitted {
                        inner.suppressed.fetch_add(1, Ordering::Relaxed);
                    }
                    return admitted;
                }
                Err(seen) => current = seen,
            }
        }
    }

    /// Events dropped since the last call.
    pub fn take_suppressed(&self) -> u64 {
        self.inner.suppressed.swap(0, Ordering::Relaxed)
    }
}

impl<S> Filter<S> for LogStormGuard {
    fn enabled(&self, _meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        true
    }

    fn event_enabled(&self, event: &Event<'_>, _cx: &Context<'_, S>) -> bool {
        self.admit(std::ptr::from_ref(event.metadata()) as usize)
    }

    /// Any level, as far as this filter goes: combined with another, the
    /// other's level stands. (A filter without a hint would make the
    /// combination's "anything", and every `trace!` in every dependency,
    /// such as foyer's on each cache access and tokio's on each timer poll,
    /// would be built and dispatched only to be dropped.)
    fn max_level_hint(&self) -> Option<LevelFilter> {
        Some(LevelFilter::TRACE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use tracing::Subscriber;
    use tracing_subscriber::filter::FilterExt as _;
    use tracing_subscriber::layer::Layer;
    use tracing_subscriber::prelude::*;

    /// Counts the events that reach it.
    #[derive(Clone, Default)]
    struct Count(Arc<Mutex<usize>>);

    impl<S: Subscriber> Layer<S> for Count {
        fn on_event(&self, _event: &Event<'_>, _ctx: Context<'_, S>) {
            *self.0.lock().unwrap() += 1;
        }
    }

    #[test]
    fn a_noisy_statement_is_capped_and_others_still_log() {
        let guard = LogStormGuard::new(5);
        let seen = Count::default();
        let subscriber =
            tracing_subscriber::registry().with(seen.clone().with_filter(guard.clone()));
        tracing::subscriber::with_default(subscriber, || {
            for _ in 0..1000 {
                tracing::warn!("the same thing again");
            }
            tracing::error!("something else");
        });
        // The storm is cut to its budget (two if the second ticked over
        // mid-loop); the other statement is untouched.
        let seen = *seen.0.lock().unwrap();
        assert!((6..=11).contains(&seen), "{seen} events got through");
        let dropped = guard.take_suppressed();
        assert_eq!(dropped as usize + seen, 1001);
        assert_eq!(guard.take_suppressed(), 0);
    }

    /// The guard leaves the level to the filter it is combined with, and
    /// on its own passes every level: what the layers ask for is the level
    /// events are built at.
    #[test]
    fn the_guard_leaves_the_level_to_the_filters() {
        let subscriber = tracing_subscriber::registry()
            .with(None::<Count>)
            .with(Count::default().with_filter(LevelFilter::WARN.and(LogStormGuard::new(5))));
        assert_eq!(subscriber.max_level_hint(), Some(LevelFilter::WARN));

        let subscriber = tracing_subscriber::registry()
            .with(Count::default().with_filter(LevelFilter::WARN.and(LogStormGuard::new(5))))
            .with(Count::default().with_filter(LogStormGuard::new(5)));
        assert_eq!(subscriber.max_level_hint(), Some(LevelFilter::TRACE));
    }

    #[test]
    fn the_budget_renews_every_second() {
        let guard = LogStormGuard::new(2);
        let site = 0x1000;
        assert!(guard.admit(site));
        assert!(guard.admit(site));
        assert!(!guard.admit(site));
        // Pretend a second has passed by rewinding the slot's clock.
        let slot = &guard.inner.slots[(site >> 3).wrapping_mul(0x9E37_79B9) % SLOTS];
        let current = slot.load(Ordering::Relaxed);
        let second = (current >> 32) as u32;
        slot.store(
            (u64::from(second.wrapping_sub(1)) << 32) | (current & 0xffff_ffff),
            Ordering::Relaxed,
        );
        assert!(guard.admit(site));
    }
}
