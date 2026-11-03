// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! OpenTelemetry metrics for the cache server.

use std::sync::OnceLock;

use anyhow::Result;
use opentelemetry::KeyValue;
use opentelemetry::metrics::{Counter, Histogram, Meter, UpDownCounter};

use super::OtelConfig;

/// Global metrics instance.
static METRICS: OnceLock<CacheMetrics> = OnceLock::new();

/// Pre-registered cache metrics.
pub struct CacheMetrics {
    /// Number of cache hits.
    pub cache_hits: Counter<u64>,
    /// Number of cache misses.
    pub cache_misses: Counter<u64>,
    /// Bytes read from cache.
    pub bytes_read: Counter<u64>,
    /// Bytes written to cache.
    pub bytes_written: Counter<u64>,
    /// Request duration in seconds.
    pub request_duration: Histogram<f64>,
    /// Blob sizes in bytes.
    pub blob_size: Histogram<u64>,
    /// Number of active requests.
    pub active_requests: UpDownCounter<i64>,
    /// Number of completed requests.
    pub completed_requests: Counter<u64>,
    /// Number of request errors.
    pub errors: Counter<u64>,
}

impl CacheMetrics {
    fn new(meter: &Meter) -> Self {
        Self {
            cache_hits: meter
                .u64_counter("cache.hits")
                .with_description("Number of cache hits")
                .build(),
            cache_misses: meter
                .u64_counter("cache.misses")
                .with_description("Number of cache misses")
                .build(),
            bytes_read: meter
                .u64_counter("cache.bytes_read")
                .with_description("Total bytes read from cache")
                .build(),
            bytes_written: meter
                .u64_counter("cache.bytes_written")
                .with_description("Total bytes written to cache")
                .build(),
            request_duration: meter
                .f64_histogram("request.duration")
                .with_description("Request duration in seconds")
                .with_unit("s")
                .build(),
            blob_size: meter
                .u64_histogram("cache.blob_size")
                .with_description("Size of blobs in bytes")
                .with_unit("By")
                .build(),
            active_requests: meter
                .i64_up_down_counter("request.active")
                .with_description("Number of active requests")
                .build(),
            completed_requests: meter
                .u64_counter("request.completed")
                .with_description("Number of completed requests")
                .build(),
            errors: meter
                .u64_counter("request.errors")
                .with_description("Number of request errors")
                .build(),
        }
    }
}

/// Initialize OTEL metrics: install the meter provider `config` asks for
/// (see [`otel_wide::init_meter_provider`]) and register gonzo's.
pub fn init_metrics(config: &OtelConfig) -> Result<()> {
    otel_wide::init_meter_provider(config)?;
    let meter = opentelemetry::global::meter(crate::SERVICE_NAME);
    let _ = METRICS.set(CacheMetrics::new(&meter));
    Ok(())
}

/// Get the global cache metrics.
///
/// Returns lazily-initialized no-op metrics if `init_metrics` was not called.
pub fn metrics() -> &'static CacheMetrics {
    METRICS.get_or_init(|| {
        let meter = opentelemetry::global::meter(crate::SERVICE_NAME);
        CacheMetrics::new(&meter)
    })
}
