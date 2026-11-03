// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! OpenTelemetry for a service: OTLP export of traces and metrics, and
//! wide events.
//!
//! ## Wide events
//!
//! Each request gets one rich span, to which code anywhere below it adds
//! attributes without declaring them first (see [`wide`]):
//!
//! ```ignore
//! otel_wide::with_wide_context("cas.find_missing_blobs", async {
//!     otel_wide::wide!("user.id", user_id);
//!     otel_wide::wide!("request.size_bytes", 1024i64);
//!     otel_wide::wide_inc!("stats.cache_hits");
//! })
//! .await
//! ```
//!
//! ## Configuration
//!
//! [`OtelConfig::from_env_or`] reads the standard variables:
//! - `OTEL_EXPORTER_OTLP_ENDPOINT`: the OTLP endpoint (e.g.
//!   `http://localhost:4317`); export is on when it is set.
//! - `OTEL_SERVICE_NAME`: the service name, else the one given.
//! - `OTEL_TRACES_SAMPLER_ARG`: the sampling ratio (e.g. `0.1` for 10%).

mod layer;
pub mod wide;

use std::env;

use anyhow::{Context as _, Result};
use opentelemetry_otlp::WithExportConfig as _;

pub use layer::{init_tracing_layer, shutdown};
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
    /// Export off, under OpenTelemetry's name for a service that gave none.
    fn default() -> Self {
        Self::new("unknown_service")
    }
}

impl OtelConfig {
    /// Export off, for the service `service_name`.
    pub fn new(service_name: impl Into<String>) -> Self {
        Self {
            enabled: false,
            endpoint: None,
            service_name: service_name.into(),
            sampling_ratio: None,
        }
    }

    /// Configuration from the standard environment variables, naming the
    /// service `default_service` unless `OTEL_SERVICE_NAME` says otherwise.
    pub fn from_env_or(default_service: &str) -> Self {
        let endpoint = env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok();
        let service_name =
            env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| default_service.to_string());
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

    /// The OTel resource describing the service.
    fn resource(&self) -> opentelemetry_sdk::Resource {
        opentelemetry_sdk::Resource::builder()
            .with_attribute(KeyValue::new(
                opentelemetry_semantic_conventions::resource::SERVICE_NAME,
                self.service_name.clone(),
            ))
            .build()
    }
}

/// Install a global meter provider exporting over OTLP, if `config`
/// enables export; otherwise leave the no-op provider in place. Either
/// way, instruments made from `opentelemetry::global::meter` afterwards
/// report wherever the config says.
pub fn init_meter_provider(config: &OtelConfig) -> Result<()> {
    if !config.enabled {
        return Ok(());
    }
    let endpoint = config
        .endpoint
        .as_ref()
        .context("OTEL endpoint required when enabled")?;
    let exporter = opentelemetry_otlp::MetricExporter::builder()
        .with_tonic()
        .with_endpoint(endpoint)
        .build()
        .context("failed to create OTLP metric exporter")?;
    let provider = opentelemetry_sdk::metrics::SdkMeterProvider::builder()
        .with_resource(config.resource())
        .with_reader(opentelemetry_sdk::metrics::PeriodicReader::builder(exporter).build())
        .build();
    opentelemetry::global::set_meter_provider(provider);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_overrides_win_and_an_endpoint_enables_export() {
        let config = OtelConfig::new("svc").with_cli_overrides(
            None,
            Some("http://localhost:4317".into()),
            Some("other".into()),
            Some(0.5),
        );
        assert!(config.enabled);
        assert_eq!(config.service_name, "other");
        assert_eq!(config.sampling_ratio, Some(0.5));
        let off = config.with_cli_overrides(Some(false), None, None, None);
        assert!(!off.enabled);
    }

    #[test]
    fn disabled_export_installs_nothing() {
        init_meter_provider(&OtelConfig::new("svc")).expect("no-op");
    }

    #[tokio::test]
    async fn wide_events_are_no_ops_outside_a_request() {
        assert!(try_current_context().is_none());
        wide!("key", 1i64);
        wide_inc!("counter");
        let value = with_wide_context("request", async {
            assert!(try_current_context().is_some());
            wide!("key", "value");
            wide_inc!("counter", 2);
            wide_timed!("timed_ms", 7)
        })
        .await;
        assert_eq!(value, 7);
    }
}
