// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! OpenTelemetry tracing layer setup.

use std::sync::OnceLock;

use anyhow::{Context, Result};
use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::{
    Resource,
    trace::{RandomIdGenerator, Sampler, SdkTracerProvider},
};
use tracing_subscriber::Layer;

use super::OtelConfig;

/// Global tracer provider for shutdown.
static TRACER_PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();

/// Initialize the OpenTelemetry tracing layer.
///
/// Returns `None` if OTEL is disabled or not configured.
/// Returns `Some(layer)` that can be added to the tracing subscriber.
pub fn init_otel_layer<S>(
    config: &OtelConfig,
) -> Result<Option<Box<dyn Layer<S> + Send + Sync + 'static>>>
where
    S: tracing::Subscriber
        + for<'span> tracing_subscriber::registry::LookupSpan<'span>
        + Send
        + Sync,
{
    if !config.enabled {
        return Ok(None);
    }

    let endpoint = config
        .endpoint
        .as_ref()
        .context("OTEL endpoint required when enabled")?;

    let resource = Resource::builder()
        .with_attribute(KeyValue::new(
            opentelemetry_semantic_conventions::resource::SERVICE_NAME,
            config.service_name.clone(),
        ))
        .build();

    let sampler = match config.sampling_ratio {
        Some(ratio) => Sampler::TraceIdRatioBased(ratio),
        None => Sampler::AlwaysOn,
    };

    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(endpoint)
        .build()
        .context("failed to create OTLP span exporter")?;

    let provider = SdkTracerProvider::builder()
        .with_sampler(sampler)
        .with_id_generator(RandomIdGenerator::default())
        .with_resource(resource)
        .with_batch_exporter(exporter)
        .build();

    let tracer = provider.tracer("cache-server");

    let _ = TRACER_PROVIDER.set(provider.clone());
    opentelemetry::global::set_tracer_provider(provider);

    let layer = tracing_opentelemetry::layer().with_tracer(tracer);

    Ok(Some(Box::new(layer)))
}

/// Shutdown OpenTelemetry, flushing any pending spans.
pub fn shutdown_otel() {
    if let Some(provider) = TRACER_PROVIDER.get() {
        let _ = provider.shutdown();
    }
}
