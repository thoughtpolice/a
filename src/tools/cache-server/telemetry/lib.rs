// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! OpenTelemetry integration for the cache server.
//!
//! This module provides OTEL export capabilities including:
//! - Trace export via OTLP
//! - Metrics export via OTLP
//! - Wide events pattern for rich, request-scoped telemetry
//!
//! ## Wide Events
//!
//! The wide events pattern allows adding attributes to the current request's
//! span from anywhere in the codebase without pre-declaration:
//!
//! ```ignore
//! // Anywhere in your code - no setup needed!
//! wide!("user.id", user_id);
//! wide!("request.size_bytes", 1024i64);
//! wide_inc!("stats.cache_hits");
//! ```
//!
//! ## Configuration
//!
//! Uses standard OTEL environment variables:
//! - `OTEL_EXPORTER_OTLP_ENDPOINT` - OTLP endpoint (e.g., "http://localhost:4317")
//! - `OTEL_SERVICE_NAME` - Service name (defaults to "buck2-cache-server")
//! - `OTEL_TRACES_SAMPLER_ARG` - Sampling ratio (e.g., "0.1" for 10%)

mod layer;
mod metrics;
mod wide;

use std::env;

pub use layer::{init_otel_layer, shutdown_otel};
pub use metrics::{CacheMetrics, init_metrics, metrics};
pub use opentelemetry::KeyValue;
pub use wide::{
    WideEventGuard, increment_counter, start_request, try_current_context, with_wide_context,
};

/// Re-export of opentelemetry types needed by the `wide!` macro.
/// These are internal implementation details and should not be used directly.
#[doc(hidden)]
pub mod __macro_internals {
    pub use opentelemetry::KeyValue;
    pub use opentelemetry::trace::TraceContextExt;
}

/// OpenTelemetry configuration.
#[derive(Debug, Clone)]
pub struct OtelConfig {
    /// Whether OTEL export is enabled.
    pub enabled: bool,
    /// OTLP endpoint (e.g., "http://localhost:4317").
    pub endpoint: Option<String>,
    /// Service name for OTEL resource.
    pub service_name: String,
    /// Sampling ratio (0.0 to 1.0, or None for always_on).
    pub sampling_ratio: Option<f64>,
}

impl Default for OtelConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: None,
            service_name: "buck2-cache-server".to_string(),
            sampling_ratio: None,
        }
    }
}

impl OtelConfig {
    /// Create config from environment variables.
    pub fn from_env() -> Self {
        let endpoint = env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok();
        let service_name =
            env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "buck2-cache-server".to_string());
        let sampling_ratio = env::var("OTEL_TRACES_SAMPLER_ARG")
            .ok()
            .and_then(|s| s.parse::<f64>().ok());

        Self {
            enabled: endpoint.is_some(),
            endpoint,
            service_name,
            sampling_ratio,
        }
    }

    /// Merge CLI arguments into config (CLI takes precedence).
    pub fn with_cli_overrides(
        mut self,
        enabled: Option<bool>,
        endpoint: Option<String>,
        service_name: Option<String>,
        sampling_ratio: Option<f64>,
    ) -> Self {
        if let Some(e) = enabled {
            self.enabled = e;
        }
        if let Some(ep) = endpoint {
            self.endpoint = Some(ep);
            self.enabled = true;
        }
        if let Some(sn) = service_name {
            self.service_name = sn;
        }
        if let Some(sr) = sampling_ratio {
            self.sampling_ratio = Some(sr);
        }
        self
    }
}
