// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! OpenTelemetry for gonzo: its cache metrics ([`CacheMetrics`]), and the
//! generic pieces it uses, re-exported from their crates:
//!
//! - [`otel_wide`]: OTLP export, and wide events (`wide!`, `wide_inc!`,
//!   `wide_timed!`, [`with_wide_context`]).
//! - [`tracing_storm`]: [`LogStormGuard`], a cap on how often any one log
//!   statement fires.
//! - [`slatedb_otel`]: [`OtelMetricsRecorder`], SlateDB's metrics as
//!   OpenTelemetry instruments.
//!
//! Export is configured by the standard `OTEL_*` variables (see
//! [`OtelConfig::from_env_or`]); the service is called [`SERVICE_NAME`]
//! unless `OTEL_SERVICE_NAME` says otherwise.

mod metrics;

pub use metrics::{CacheMetrics, init_metrics, metrics};
pub use otel_wide::{
    KeyValue, OtelConfig, WideEventGuard, increment_counter, start_request, try_current_context,
    wide, wide_inc, wide_timed, with_wide_context,
};
pub use otel_wide::{init_tracing_layer as init_otel_layer, shutdown as shutdown_otel};
pub use slatedb_otel::OtelMetricsRecorder;
pub use tracing_storm::LogStormGuard;

/// What gonzo calls itself to OpenTelemetry, by default.
pub const SERVICE_NAME: &str = "gonzo";
