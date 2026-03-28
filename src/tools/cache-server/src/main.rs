// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Happy Fun Ball. Do not taunt.

use std::{str::FromStr, sync::Arc};

use anyhow::{Context, Result};
use clap::Parser;
use tracing_subscriber::{filter, prelude::*};

// ---------------------------------------------------------------------------------------------------------------------

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser, Debug)]
#[command(
    name = "buck2-cache-server",
    author = "Austin Seipp",
    version = "0.1.0"
)]
struct Cli {
    /// The address to listen on
    #[arg(short, long, default_value = "127.0.0.1:8080")]
    address: String,

    /// Enable tokio-console debugging subscriber
    #[arg(long, default_value_t = false)]
    tokio_console: bool,

    /// Storage backend: "memory" or "file:///path/to/dir"
    #[arg(long, default_value = "memory")]
    store: String,

    /// `tracing` filter for the console logs.
    #[arg(long, default_value = "info")]
    console_log: String,

    // --- OTEL options ---
    /// Enable OpenTelemetry export (also enabled if OTEL_EXPORTER_OTLP_ENDPOINT is set)
    #[arg(long)]
    otel_enabled: bool,

    /// OTLP endpoint (e.g., "http://localhost:4317")
    #[arg(long, env = "OTEL_EXPORTER_OTLP_ENDPOINT")]
    otel_endpoint: Option<String>,

    /// Service name for OTEL resource
    #[arg(long, default_value = "buck2-cache-server")]
    otel_service_name: String,

    /// Sampling ratio (0.0-1.0). Omit for always_on.
    #[arg(long)]
    otel_sampling_ratio: Option<f64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Build OTEL config from env + CLI
    let otel_config = telemetry::OtelConfig::from_env().with_cli_overrides(
        if cli.otel_enabled { Some(true) } else { None },
        cli.otel_endpoint.clone(),
        Some(cli.otel_service_name.clone()),
        cli.otel_sampling_ratio,
    );

    let tokio_console_layer = if cli.tokio_console {
        Some(console_subscriber::spawn())
    } else {
        None
    };
    let cli_console_layer = tracing_subscriber::fmt::layer().with_filter(
        filter::LevelFilter::from_str(cli.console_log.as_str())
            .context("invalid console_log filter")?,
    );

    let otel_layer = telemetry::init_otel_layer(&otel_config)?;

    tracing_subscriber::registry()
        .with(tokio_console_layer)
        .with(cli_console_layer)
        .with(otel_layer)
        .init();

    let backend = if cli.store == "memory" {
        store::StoreBackend::Memory
    } else if let Some(path) = cli.store.strip_prefix("file://") {
        store::StoreBackend::LocalFs(path.to_string())
    } else {
        anyhow::bail!(
            "invalid --store value: {:?} (expected \"memory\" or \"file:///path\")",
            cli.store
        );
    };

    let cache_store = store::CacheStore::open(backend)
        .await
        .with_context(|| format!("failed to open cache store (backend: {:?})", cli.store))?;
    let cache_store = Arc::new(cache_store);

    let address: std::net::SocketAddr = cli.address.parse().with_context(|| {
        format!(
            "invalid listen address {:?} (expected HOST:PORT, e.g. 127.0.0.1:8080)",
            cli.address,
        )
    })?;

    telemetry::init_metrics(&otel_config)?;
    if otel_config.enabled {
        tracing::info!(
            endpoint = ?otel_config.endpoint,
            service_name = %otel_config.service_name,
            sampling = ?otel_config.sampling_ratio,
            "OpenTelemetry export enabled"
        );
    }

    tracing::info!(
        %address,
        store = %cli.store,
        "cache-server ready",
    );

    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let shutdown_notify2 = shutdown_notify.clone();

    let shutdown = async move {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler");

        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("received SIGINT, draining connections...");
            }
            _ = sigterm.recv() => {
                tracing::info!("received SIGTERM, draining connections...");
            }
        }
        shutdown_notify2.notify_one();
    };

    let drain_deadline = async {
        shutdown_notify.notified().await;
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        tracing::warn!("drain timeout (10s), forcing shutdown");
    };

    let result = tokio::select! {
        r = reapi_grpc::start_reapi_grpc(address, shutdown, cache_store.clone()) => r,
        _ = drain_deadline => Ok(()),
    };

    cache_store
        .close()
        .await
        .context("failed to close cache store")?;
    telemetry::shutdown_otel();
    result.map_err(|e| anyhow::anyhow!("{}", e))
}

// ---------------------------------------------------------------------------------------------------------------------

pub mod reapi_grpc;
pub mod service;
pub mod store;

// ---------------------------------------------------------------------------------------------------------------------
