// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Wide events infrastructure for request-scoped telemetry.
//!
//! This module implements the "wide events" pattern where each request gets
//! a single rich span with all relevant attributes collected throughout the
//! request lifecycle. Each canonical request span is marked with `canon: true`
//! (following the pattern from Jeremy Morrell's guide on wide events).
//!
//! ## Key Design
//!
//! - Uses OpenTelemetry's native `Span::set_attribute()` which is fully dynamic
//! - No pre-declaration of fields needed (unlike tracing::instrument)
//! - Stores the OTEL Context in task-local storage for access from anywhere
//! - Automatically sets `canon: true` and tracks `duration_ms` for request spans
//!
//! ## Usage
//!
//! ```ignore
//! // At request entry point (recommended approach):
//! async fn handle_request(&self, req: Request) -> Result<Response> {
//!     telemetry::with_wide_context("cas.find_missing_blobs", async {
//!         wide!("user.id", user_id);
//!         wide!("request.size_bytes", 1024i64);
//!         wide_inc!("stats.cache_hits");
//!         // ... handler code
//!     }).await
//! }
//!
//! // Or using the guard directly:
//! let _span = telemetry::start_request("cas.find_missing_blobs");
//! ```

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Instant;

use opentelemetry::trace::{Span, SpanKind, TraceContextExt, Tracer};
use opentelemetry::{Context, KeyValue};
use parking_lot::RwLock;

tokio::task_local! {
    /// Task-local storage for the current wide event context.
    static WIDE_CONTEXT: RefCell<Option<WideEventState>>;
}

/// Internal state for a wide event.
struct WideEventState {
    /// The OTEL context containing the span.
    context: Context,
    /// Atomic counters for aggregated stats.
    counters: Arc<RwLock<HashMap<&'static str, Arc<AtomicI64>>>>,
    /// When the request started (for duration tracking).
    start_time: Instant,
}

/// RAII guard that manages the wide event span lifecycle.
///
/// When dropped, finalizes all counters to the span (including `duration_ms`)
/// and ends the span.
pub struct WideEventGuard {
    context: Context,
    counters: Arc<RwLock<HashMap<&'static str, Arc<AtomicI64>>>>,
    start_time: Instant,
}

impl Drop for WideEventGuard {
    fn drop(&mut self) {
        let span = self.context.span();

        let duration_ms = self.start_time.elapsed().as_secs_f64() * 1000.0;
        span.set_attribute(KeyValue::new("duration_ms", duration_ms));

        let counters = self.counters.read();
        for (key, counter) in counters.iter() {
            span.set_attribute(KeyValue::new(*key, counter.load(Ordering::Relaxed)));
        }

        span.end();
    }
}

/// Start a new wide event span for a request.
///
/// Creates a span with `canon: true` automatically set. Duration is tracked
/// and recorded as `duration_ms` when the guard is dropped.
///
/// Returns a guard that must be held for the duration of the request.
pub fn start_request(name: &'static str) -> WideEventGuard {
    let tracer = opentelemetry::global::tracer("cache-server");
    let mut span = tracer
        .span_builder(name)
        .with_kind(SpanKind::Server)
        .start(&tracer);

    span.set_attribute(KeyValue::new("canon", true));

    let context = Context::current_with_span(span);
    let counters = Arc::new(RwLock::new(HashMap::new()));
    let start_time = Instant::now();

    WideEventGuard {
        context,
        counters,
        start_time,
    }
}

/// Run an async block with wide event context available.
///
/// This is the recommended way to use wide events. It creates a canonical
/// request span with `canon: true`, makes the context available to `wide!`
/// and `wide_inc!` macros throughout the async block, and automatically
/// records `duration_ms` when complete.
pub async fn with_wide_context<F, T>(name: &'static str, f: F) -> T
where
    F: Future<Output = T>,
{
    let guard = start_request(name);
    let state = WideEventState {
        context: guard.context.clone(),
        counters: guard.counters.clone(),
        start_time: guard.start_time,
    };

    WIDE_CONTEXT
        .scope(RefCell::new(Some(state)), async {
            let result = f.await;
            drop(guard);
            result
        })
        .await
}

/// Try to get the current OTEL context, if one is active.
///
/// Returns `None` if called outside a wide event context.
pub fn try_current_context() -> Option<Context> {
    WIDE_CONTEXT
        .try_with(|cell| cell.borrow().as_ref().map(|s| s.context.clone()))
        .ok()
        .flatten()
}

/// Increment a counter on the current wide event.
///
/// Counters are aggregated and finalized to the span when the guard is dropped.
pub fn increment_counter(key: &'static str, delta: i64) {
    let _ = WIDE_CONTEXT.try_with(|cell| {
        if let Some(state) = cell.borrow().as_ref() {
            let counters = state.counters.read();
            if let Some(counter) = counters.get(key) {
                counter.fetch_add(delta, Ordering::Relaxed);
                return;
            }
            drop(counters);

            let mut counters = state.counters.write();
            counters
                .entry(key)
                .or_insert_with(|| Arc::new(AtomicI64::new(0)))
                .fetch_add(delta, Ordering::Relaxed);
        }
    });
}

/// Add an attribute to the current wide event span.
///
/// No-op if called outside a wide event context.
///
/// # Example
///
/// ```ignore
/// wide!("user.id", user_id);
/// wide!("request.size_bytes", 1024i64);
/// wide!("cache.backend", "memory");
/// wide!("compression.enabled", true);
/// ```
#[macro_export]
macro_rules! wide {
    ($key:expr, $value:expr) => {{
        use $crate::__macro_internals::TraceContextExt;
        if let Some(cx) = $crate::try_current_context() {
            cx.span()
                .set_attribute($crate::__macro_internals::KeyValue::new($key, $value));
        }
    }};
}

/// Increment a counter on the current wide event.
///
/// Counters are aggregated across the request and finalized when the span ends.
/// No-op if called outside a wide event context.
///
/// # Example
///
/// ```ignore
/// wide_inc!("stats.cache_hits");           // increment by 1
/// wide_inc!("stats.bytes_read", 1024);     // increment by specific amount
/// ```
#[macro_export]
macro_rules! wide_inc {
    ($key:expr) => {
        $crate::wide_inc!($key, 1i64)
    };
    ($key:expr, $delta:expr) => {{
        $crate::increment_counter($key, $delta as i64);
    }};
}

/// Time an operation and record duration in milliseconds.
///
/// The duration is accumulated into the specified counter.
///
/// # Example
///
/// ```ignore
/// let data = wide_timed!("store.lookup_ms", self.store.get(&key))?;
/// ```
#[macro_export]
macro_rules! wide_timed {
    ($key:expr, $expr:expr) => {{
        let start = std::time::Instant::now();
        let result = $expr;
        let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
        $crate::wide_inc!($key, duration_ms as i64);
        result
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_counter_increment() {
        let counters = Arc::new(RwLock::new(HashMap::new()));

        {
            let mut write = counters.write();
            let counter = write
                .entry("test.counter")
                .or_insert_with(|| Arc::new(AtomicI64::new(0)));
            counter.fetch_add(5, Ordering::Relaxed);
        }

        {
            let read = counters.read();
            let counter = read.get("test.counter").unwrap();
            assert_eq!(counter.load(Ordering::Relaxed), 5);
        }
    }
}
