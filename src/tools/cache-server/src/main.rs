// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Happy Fun Ball. Do not taunt.

use std::{path::PathBuf, str::FromStr, sync::Arc};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use dial9_tokio_telemetry::telemetry::{
    RotatingWriter, TelemetryHandle, TracedRuntime,
    cpu_profile::{CpuProfilingConfig, SchedEventConfig},
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
    /// Storage backend: "memory", "file:///path/to/dir", or a bare path
    #[arg(
        long,
        default_value = "memory",
        env = "CACHE_SERVER_STORE",
        global = true
    )]
    store: String,

    /// `tracing` filter for the console logs.
    #[arg(long, default_value = "info", env = "CACHE_SERVER_LOG", global = true)]
    console_log: String,

    /// Default TTL for cache entries in days (0 = no expiry).
    #[arg(
        long,
        default_value_t = 30,
        env = "CACHE_SERVER_DEFAULT_TTL_DAYS",
        global = true
    )]
    default_ttl_days: u32,

    // --- Tracing options ---
    /// Directory for dial9 runtime trace output. Defaults to
    /// $TMPDIR/cache-server-traces.
    #[arg(long, env = "CACHE_SERVER_TRACE_DIR", global = true)]
    trace_dir: Option<PathBuf>,

    /// Maximum size per trace segment file in MiB.
    #[arg(
        long,
        default_value_t = 10,
        env = "CACHE_SERVER_TRACE_MAX_FILE_MIB",
        global = true
    )]
    trace_max_file_mib: u64,

    /// Maximum total trace disk usage in MiB.
    #[arg(
        long,
        default_value_t = 50,
        env = "CACHE_SERVER_TRACE_MAX_TOTAL_MIB",
        global = true
    )]
    trace_max_total_mib: u64,

    /// Disable dial9 scheduler tracing (use a plain tokio runtime).
    #[arg(
        long,
        default_value_t = false,
        env = "CACHE_SERVER_DISABLE_DIAL9",
        global = true
    )]
    disable_dial9: bool,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the gRPC cache server (default when no subcommand is given)
    Serve(ServeArgs),

    /// Run standalone SlateDB compaction (database must already exist)
    Compact,
}

#[derive(Parser, Debug)]
struct ServeArgs {
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

    /// Per-request timeout in seconds (0 = no timeout)
    #[arg(long, default_value_t = 900, env = "CACHE_SERVER_REQUEST_TIMEOUT")]
    request_timeout: u64,

    /// Maximum concurrent requests across all connections (default 8192).
    /// Also limited to 256 per individual connection.
    #[arg(
        long,
        default_value_t = 8192,
        env = "CACHE_SERVER_MAX_CONCURRENT_REQUESTS"
    )]
    max_concurrent_requests: usize,

    /// Disable the embedded compactor (use with standalone `compact` subcommand)
    #[arg(long, default_value_t = false)]
    disable_compactor: bool,

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
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let rt_info = runtime::init();

    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    builder.worker_threads(rt_info.effective_cpus);

    if cli.disable_dial9 {
        let (runtime, guard) = TracedRuntime::build_disabled(builder)?;
        let handle = guard.handle();
        let result = runtime.block_on(async_main(cli, handle, None, None, rt_info));
        drop(runtime);
        guard
            .graceful_shutdown(std::time::Duration::from_secs(5))
            .ok();
        result
    } else {
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

        let caps = runtime::check_perf_capabilities();

        let mut traced = TracedRuntime::builder().with_task_tracking(true);
        if caps.cpu_profiling {
            traced = traced.with_cpu_profiling(CpuProfilingConfig::default());
            traced = traced.with_sched_events(SchedEventConfig {
                include_kernel: caps.kernel_stacks,
            });
        }
        let (runtime, guard) = traced
            .with_trace_path(&trace_path)
            .build_and_start(builder, writer)?;
        let handle = guard.handle();
        let result = runtime.block_on(async_main(
            cli,
            handle,
            Some(trace_dir),
            Some(caps),
            rt_info,
        ));
        // Drop the runtime first so worker threads exit and flush their
        // thread-local telemetry buffers to the central collector. Then
        // graceful_shutdown drains the collector, seals the final segment,
        // and gives the background worker time to symbolize + compress.
        drop(runtime);
        guard
            .graceful_shutdown(std::time::Duration::from_secs(5))
            .ok();
        result
    }
}

fn parse_backend(store: &str) -> Result<store::StoreBackend> {
    if store == "memory" {
        Ok(store::StoreBackend::Memory)
    } else if let Some(path) = store.strip_prefix("file://") {
        Ok(store::StoreBackend::LocalFs(path.to_string()))
    } else if store.starts_with('/') || store.starts_with('.') {
        Ok(store::StoreBackend::LocalFs(store.to_string()))
    } else {
        anyhow::bail!(
            "invalid --store value: {:?} (expected \"memory\", \"file:///path\", or a bare path)",
            store
        )
    }
}

fn default_ttl(days: u32) -> Option<jiff::SignedDuration> {
    if days == 0 {
        None
    } else {
        Some(jiff::SignedDuration::from_hours(i64::from(days) * 24))
    }
}

async fn async_main(
    cli: Cli,
    handle: TelemetryHandle,
    trace_dir: Option<PathBuf>,
    perf_caps: Option<runtime::PerfCapabilities>,
    rt_info: runtime::RuntimeInfo,
) -> Result<()> {
    match cli.command {
        Some(Command::Compact) => run_compactor(&cli, handle).await,
        Some(Command::Serve(ref args)) => {
            run_server(
                &cli,
                args,
                handle,
                trace_dir.as_ref(),
                perf_caps.as_ref(),
                &rt_info,
            )
            .await
        }
        None => {
            run_server(
                &cli,
                &ServeArgs::default(),
                handle,
                trace_dir.as_ref(),
                perf_caps.as_ref(),
                &rt_info,
            )
            .await
        }
    }
}

impl Default for ServeArgs {
    fn default() -> Self {
        Self {
            address: "127.0.0.1:8080".to_string(),
            tokio_console: false,
            request_timeout: 900,
            max_concurrent_requests: 8192,
            disable_compactor: false,
            otel_enabled: false,
            otel_endpoint: None,
            otel_service_name: "buck2-cache-server".to_string(),
            otel_sampling_ratio: None,
        }
    }
}

async fn run_compactor(cli: &Cli, handle: TelemetryHandle) -> Result<()> {
    let cli_console_layer = tracing_subscriber::fmt::layer().with_filter(
        filter::LevelFilter::from_str(cli.console_log.as_str()).context(
            "invalid --console-log filter (valid values: trace, debug, info, warn, error, off)",
        )?,
    );
    tracing_subscriber::registry()
        .with(cli_console_layer)
        .init();

    let backend = parse_backend(&cli.store)?;
    let object_store =
        store::create_object_store(&backend).context("failed to create object store")?;

    let compactor = Arc::new(store::CompactorBuilder::new(store::DB_PATH, object_store).build());

    tracing::info!(
        store = %cli.store,
        version = option_env!("depot_VERSION").unwrap_or("dev"),
        "standalone compactor running"
    );

    let compactor_task = {
        let c = Arc::clone(&compactor);
        handle.spawn(async move { c.run().await })
    };

    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("failed to install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("received SIGINT, stopping compactor...");
        }
        _ = sigterm.recv() => {
            tracing::info!("received SIGTERM, stopping compactor...");
        }
    }

    compactor.stop().await.context("failed to stop compactor")?;
    compactor_task.await?.context("compactor task failed")?;
    tracing::info!("compactor stopped cleanly");
    Ok(())
}

async fn run_server(
    cli: &Cli,
    args: &ServeArgs,
    handle: TelemetryHandle,
    trace_dir: Option<&PathBuf>,
    perf_caps: Option<&runtime::PerfCapabilities>,
    rt_info: &runtime::RuntimeInfo,
) -> Result<()> {
    // Build OTEL config from env + CLI
    let otel_config = telemetry::OtelConfig::from_env().with_cli_overrides(
        if args.otel_enabled { Some(true) } else { None },
        args.otel_endpoint.clone(),
        Some(args.otel_service_name.clone()),
        args.otel_sampling_ratio,
    );

    let tokio_console_layer = if args.tokio_console {
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

    rt_info.emit_diagnostics();
    if let Some(caps) = perf_caps {
        caps.emit_warnings();
    }

    let pressure_monitor = runtime::psi::PressureMonitor::spawn(
        rt_info.cgroup_dir.clone(),
        std::time::Duration::from_secs(2),
    );

    anyhow::ensure!(
        args.max_concurrent_requests > 0,
        "--max-concurrent-requests must be at least 1"
    );

    let backend = parse_backend(&cli.store)?;

    let store_settings = store::CacheStoreSettings {
        default_ttl: default_ttl(cli.default_ttl_days),
        disable_compactor: args.disable_compactor,
    };

    let cache_store = store::CacheStore::open(backend, store_settings)
        .await
        .with_context(|| format!("failed to open cache store (backend: {:?})", cli.store))?;
    let cache_store = Arc::new(cache_store);

    let address: std::net::SocketAddr = args.address.parse().with_context(|| {
        format!(
            "invalid listen address {:?} (expected HOST:PORT, e.g. 127.0.0.1:8080)",
            args.address,
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
        request_timeout_secs = args.request_timeout,
        max_concurrent_requests = args.max_concurrent_requests,
        disable_compactor = args.disable_compactor,
        dial9 = !cli.disable_dial9,
        trace_dir = trace_dir.map_or("disabled".to_string(), |d| d.display().to_string()),
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
                if args.request_timeout > 0 {
                    Some(std::time::Duration::from_secs(args.request_timeout))
                } else {
                    None
                },
                Some(args.max_concurrent_requests),
                handle,
                pressure_monitor,
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

mod pressure_gate;
pub mod reapi_grpc;
pub mod service;
pub mod store;

// ---------------------------------------------------------------------------------------------------------------------
