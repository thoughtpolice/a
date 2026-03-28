// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Happy Fun Ball. Do not taunt.

use std::{path::PathBuf, str::FromStr, sync::Arc};

use anyhow::{Context, Result};
use clap::Parser;
use dial9_tokio_telemetry::telemetry::{
    CpuProfilingConfig, RotatingWriter, SchedEventConfig, TelemetryHandle, TracedRuntime,
};
use tracing_subscriber::{filter, prelude::*};

// ---------------------------------------------------------------------------------------------------------------------

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser, Debug)]
#[command(
    name = "buck2-cache-server",
    author = "Austin Seipp",
    version = option_env!("depot_VERSION").unwrap_or("dev")
)]
struct Cli {
    /// The address to listen on
    #[arg(
        short,
        long,
        default_value = "127.0.0.1:8080",
        env = "CACHE_SERVER_ADDRESS"
    )]
    address: String,

    /// Enable tokio-console debugging subscriber
    #[arg(long, default_value_t = false)]
    tokio_console: bool,

    /// Storage backend: "memory", "file:///path/to/dir", or a bare path
    #[arg(long, default_value = "memory", env = "CACHE_SERVER_STORE")]
    store: String,

    /// `tracing` filter for the console logs.
    #[arg(long, default_value = "info", env = "CACHE_SERVER_LOG")]
    console_log: String,

    /// Per-request timeout in seconds (0 = no timeout)
    #[arg(long, default_value_t = 300, env = "CACHE_SERVER_REQUEST_TIMEOUT")]
    request_timeout: u64,

    /// Maximum concurrent requests across all connections (default 8192).
    /// Also limited to 256 per individual connection.
    #[arg(
        long,
        default_value_t = 8192,
        env = "CACHE_SERVER_MAX_CONCURRENT_REQUESTS"
    )]
    max_concurrent_requests: usize,

    // --- OTEL options ---
    /// Enable OpenTelemetry export (also enabled if OTEL_EXPORTER_OTLP_ENDPOINT is set)
    #[arg(long)]
    otel_enabled: bool,

    /// OTLP endpoint (e.g., "http://localhost:4317")
    #[arg(long, env = "OTEL_EXPORTER_OTLP_ENDPOINT")]
    otel_endpoint: Option<String>,

    /// Service name for OTEL resource
    #[arg(
        long,
        default_value = "buck2-cache-server",
        env = "CACHE_SERVER_OTEL_SERVICE_NAME"
    )]
    otel_service_name: String,

    /// Sampling ratio (0.0-1.0). Omit for always_on.
    #[arg(long, env = "CACHE_SERVER_OTEL_SAMPLING_RATIO")]
    otel_sampling_ratio: Option<f64>,

    /// Default TTL for cache entries in days (0 = no expiry).
    #[arg(long, default_value_t = 30, env = "CACHE_SERVER_DEFAULT_TTL_DAYS")]
    default_ttl_days: u32,

    // --- Tracing options ---
    /// Directory for dial9 runtime trace output. Defaults to
    /// $TMPDIR/cache-server-traces.
    #[arg(long, env = "CACHE_SERVER_TRACE_DIR")]
    trace_dir: Option<PathBuf>,

    /// Maximum size per trace segment file in MiB.
    #[arg(long, default_value_t = 10, env = "CACHE_SERVER_TRACE_MAX_FILE_MIB")]
    trace_max_file_mib: u64,

    /// Maximum total trace disk usage in MiB.
    #[arg(long, default_value_t = 50, env = "CACHE_SERVER_TRACE_MAX_TOTAL_MIB")]
    trace_max_total_mib: u64,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let trace_dir = cli
        .trace_dir
        .clone()
        .unwrap_or_else(|| std::env::temp_dir().join("cache-server-traces"));
    let _ = std::fs::remove_dir_all(&trace_dir);

    let trace_path = trace_dir.join("trace.bin");
    let writer = RotatingWriter::builder()
        .base_path(&trace_path)
        .max_file_size(cli.trace_max_file_mib * 1024 * 1024)
        .max_total_size(cli.trace_max_total_mib * 1024 * 1024)
        .build()?;

    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();

    let (runtime, guard) = TracedRuntime::builder()
        .with_task_tracking(true)
        .with_cpu_profiling(CpuProfilingConfig::default())
        .with_sched_events(SchedEventConfig {
            include_kernel: true,
        })
        .with_trace_path(&trace_path)
        .build_and_start(builder, writer)?;
    let handle = guard.handle();
    runtime.block_on(async {
        let result = async_main(cli, handle, trace_dir).await;
        // Give the background worker time to symbolize the final trace segment
        // before exiting. Without this, Drop hard-kills the worker and stack
        // traces are left as raw addresses.
        guard
            .graceful_shutdown(std::time::Duration::from_secs(5))
            .await
            .ok();
        result
    })
}

async fn async_main(cli: Cli, handle: TelemetryHandle, trace_dir: PathBuf) -> Result<()> {
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
        filter::LevelFilter::from_str(cli.console_log.as_str()).context(
            "invalid --console-log filter (valid values: trace, debug, info, warn, error, off)",
        )?,
    );

    let otel_layer = telemetry::init_otel_layer(&otel_config)?;

    tracing_subscriber::registry()
        .with(tokio_console_layer)
        .with(cli_console_layer)
        .with(otel_layer)
        .init();

    anyhow::ensure!(
        cli.max_concurrent_requests > 0,
        "--max-concurrent-requests must be at least 1"
    );

    let backend = if cli.store == "memory" {
        store::StoreBackend::Memory
    } else if let Some(path) = cli.store.strip_prefix("file://") {
        store::StoreBackend::LocalFs(path.to_string())
    } else if cli.store.starts_with('/') || cli.store.starts_with('.') {
        store::StoreBackend::LocalFs(cli.store.clone())
    } else {
        anyhow::bail!(
            "invalid --store value: {:?} (expected \"memory\", \"file:///path\", or a bare path)",
            cli.store
        );
    };

    let store_settings = store::CacheStoreSettings {
        default_ttl: if cli.default_ttl_days == 0 {
            None
        } else {
            Some(jiff::SignedDuration::from_hours(
                i64::from(cli.default_ttl_days) * 24,
            ))
        },
    };

    let cache_store = store::CacheStore::open(backend, store_settings)
        .await
        .with_context(|| format!("failed to open cache store (backend: {:?})", cli.store))?;
    let cache_store = Arc::new(cache_store);

    let address: std::net::SocketAddr = cli.address.parse().with_context(|| {
        format!(
            "invalid listen address {:?} (expected HOST:PORT, e.g. 127.0.0.1:8080)",
            cli.address,
        )
    })?;

    if !address.ip().is_loopback() {
        tracing::warn!(
            %address,
            "listening on non-loopback address without authentication or TLS"
        );
    }

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
        default_ttl_days = cli.default_ttl_days,
        version = option_env!("depot_VERSION").unwrap_or("dev"),
        otel = otel_config.enabled,
        request_timeout_secs = cli.request_timeout,
        max_concurrent_requests = cli.max_concurrent_requests,
        trace_dir = %trace_dir.display(),
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
        r = reapi_grpc::start_reapi_grpc(
                address,
                shutdown,
                cache_store.clone(),
                if cli.request_timeout > 0 {
                    Some(std::time::Duration::from_secs(cli.request_timeout))
                } else {
                    None
                },
                Some(cli.max_concurrent_requests),
                handle,
        ) => r,
        _ = drain_deadline => Ok(()),
    };

    cache_store
        .close()
        .await
        .context("failed to close cache store")?;
    telemetry::shutdown_otel();

    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("Address already in use") || msg.contains("os error 98") {
                anyhow::bail!(
                    "failed to bind to {}: address already in use \
                     (is another cache-server running?)",
                    address
                );
            }
            Err(anyhow::anyhow!("{}", e))
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------

pub mod reapi_grpc;
pub mod service;
pub mod store;

// ---------------------------------------------------------------------------------------------------------------------
