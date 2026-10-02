// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Happy Fun Ball. Do not taunt.

use std::{path::PathBuf, str::FromStr, sync::Arc};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use dial9::cpu::{CpuProfilingConfig, SchedEventConfig};
use dial9::memory::{Dial9Allocator, MemoryProfilingConfig};
use dial9::process::ProcessResourceUsageConfig;
use dial9::{
    Dial9HandleTokioExt as _, Dial9TokioHandle, DiskBuffer, RecorderPerfExt as _,
    TokioAttachOptions,
};
use tracing_subscriber::{filter, prelude::*};

// ---------------------------------------------------------------------------------------------------------------------

// Wrap mimalloc in dial9's sampling allocator. This is a zero-cost passthrough
// to mimalloc until the recorder installs the memory profiler (which only
// happens when dial9 telemetry is enabled), at which point sampled allocations
// are recorded.
#[global_allocator]
static GLOBAL_ALLOCATOR: Dial9Allocator<mimalloc::MiMalloc> =
    Dial9Allocator::new(mimalloc::MiMalloc);

#[derive(Parser, Debug)]
#[command(
    name = "buck2-cache-server",
    author = "Austin Seipp",
    version = option_env!("depot_VERSION").unwrap_or("dev")
)]
struct Cli {
    /// Storage backend: "memory", "file:///path/to/dir", a bare path, or
    /// "s3://bucket[/prefix]" (configured via AWS_* environment variables)
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

    /// Per-request timeout in seconds (0 = no timeout), for every RPC but
    /// Remote Asset fetches (see --fetch-timeout)
    #[arg(long, default_value_t = 900, env = "CACHE_SERVER_REQUEST_TIMEOUT")]
    request_timeout: u64,

    /// The longest a Remote Asset fetch may run, in seconds (0 = no limit).
    /// Git clones get this long unless the request asks for less, HTTP
    /// fetches 60 s unless it asks for more.
    #[arg(long, default_value_t = 1800, env = "CACHE_SERVER_FETCH_TIMEOUT")]
    fetch_timeout: u64,

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

    // --- Storage caches ---
    /// In-memory cache of SST data blocks in MiB. Holds action cache,
    /// manifest, and asset entries; chunk data bypasses it.
    #[arg(
        long,
        default_value_t = store::DEFAULT_BLOCK_CACHE_BYTES / (1024 * 1024),
        env = "CACHE_SERVER_BLOCK_CACHE_MIB"
    )]
    block_cache_mib: u64,

    /// In-memory cache of SST indexes and bloom filters in MiB. Every lookup
    /// consults them; size it to hold all of them.
    #[arg(
        long,
        default_value_t = store::DEFAULT_META_CACHE_BYTES / (1024 * 1024),
        env = "CACHE_SERVER_META_CACHE_MIB"
    )]
    meta_cache_mib: u64,

    /// In-memory cache of small blobs (64 KiB or less) in MiB, kept once
    /// read so reading them again skips the store's LSM; 0 turns it off.
    #[arg(
        long,
        default_value_t = store::DEFAULT_SMALL_BLOB_CACHE_BYTES / (1024 * 1024),
        env = "CACHE_SERVER_SMALL_BLOB_CACHE_MIB"
    )]
    small_blob_cache_mib: u64,

    /// In-memory cache of action cache entries in MiB, kept once read so
    /// reading them again skips the store's LSM, and dropped when written; 0
    /// turns it off.
    #[arg(
        long,
        default_value_t = store::DEFAULT_ACTION_RESULT_CACHE_BYTES / (1024 * 1024),
        env = "CACHE_SERVER_ACTION_RESULT_CACHE_MIB"
    )]
    action_result_cache_mib: u64,

    /// In-memory cache of blob manifests (of blobs over 4 KiB) in MiB, kept
    /// once read so reading the blob again skips one of the store's
    /// lookups; 0 turns it off.
    #[arg(
        long,
        default_value_t = store::DEFAULT_MANIFEST_CACHE_BYTES / (1024 * 1024),
        env = "CACHE_SERVER_MANIFEST_CACHE_MIB"
    )]
    manifest_cache_mib: u64,

    /// Most MiB of writes held in memory before they are flushed to the
    /// store's L0 SSTs; past it, writes wait for a flush. It must exceed the
    /// 64 MiB L0 SST size (default: SlateDB's, 1024).
    #[arg(long, env = "CACHE_SERVER_WRITE_BUFFER_MIB")]
    write_buffer_mib: Option<u64>,

    /// S3 stores only: a local directory caching SST data read from (and
    /// recently written to) S3. Disabled when unset.
    #[arg(long, env = "CACHE_SERVER_OBJECT_STORE_CACHE_DIR")]
    object_store_cache_dir: Option<PathBuf>,

    /// Local stores only: refuse uploads while the store's disk has fewer
    /// than this many GiB free, so it never fills (default: a tenth of the
    /// filesystem, at least 1 GiB; 0 turns the check off). Reads continue.
    #[arg(long, env = "CACHE_SERVER_DISK_RESERVE_GIB")]
    disk_reserve_gib: Option<u64>,

    /// Most GiB the object store cache holds.
    #[arg(
        long,
        default_value_t = 16,
        env = "CACHE_SERVER_OBJECT_STORE_CACHE_GIB"
    )]
    object_store_cache_gib: u64,

    // --- TLS options ---
    /// PEM certificate chain; enables TLS on the listener
    #[arg(long, env = "CACHE_SERVER_TLS_CERT", requires = "tls_key")]
    tls_cert: Option<PathBuf>,

    /// PEM private key for --tls-cert
    #[arg(long, env = "CACHE_SERVER_TLS_KEY", requires = "tls_cert")]
    tls_key: Option<PathBuf>,

    /// Directory for spooling git packfiles during clones. Large repository
    /// fetches write multi-GiB temporary files here; point it at real disk
    /// (the default system temp dir is often RAM-backed tmpfs).
    #[arg(long, env = "CACHE_SERVER_GIT_SPOOL_DIR")]
    git_spool_dir: Option<std::path::PathBuf>,

    /// Remote Asset HTTP fetches allowed to run at once. Each may hold up to
    /// 256 MiB in memory; identical concurrent requests share one fetch.
    #[arg(
        long,
        default_value_t = 16,
        env = "CACHE_SERVER_MAX_CONCURRENT_HTTP_FETCHES"
    )]
    max_concurrent_http_fetches: usize,

    /// Remote Asset git clones allowed to run at once. Each spools its pack
    /// under --git-spool-dir and holds the pack's index in memory; identical
    /// concurrent requests share one clone.
    #[arg(
        long,
        default_value_t = 2,
        env = "CACHE_SERVER_MAX_CONCURRENT_GIT_CLONES"
    )]
    max_concurrent_git_clones: usize,

    /// Remote Asset OCI image fetches allowed to run at once. Each streams
    /// a few layers at a time into the store; identical concurrent requests
    /// share one fetch.
    #[arg(
        long,
        default_value_t = 4,
        env = "CACHE_SERVER_MAX_CONCURRENT_OCI_FETCHES"
    )]
    max_concurrent_oci_fetches: usize,

    /// A Docker `config.json` whose `auths` hold credentials for OCI
    /// registries that refuse anonymous pulls: per registry host, an `auth`
    /// (base64 of `username:password`) or a `username` and `password`.
    /// Credentials go only to the registry they are for and to the token
    /// service its challenges name, and only over TLS.
    #[arg(long, env = "CACHE_SERVER_OCI_AUTH_FILE")]
    oci_auth_file: Option<PathBuf>,

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

/// Build and start the dial9 recorder that writes trace segments into
/// `trace_dir`.
///
/// `base_path` names the segment *directory* — in 0.3 it was a file path that
/// dial9 rotated around, and passing one now just makes a directory of that
/// name. Sources whose kernel prerequisites are missing are left out; the
/// recorder still records everything else.
fn start_recorder(
    trace_dir: &std::path::Path,
    max_file_mib: u64,
    max_total_mib: u64,
    caps: &runtime::PerfCapabilities,
) -> Result<dial9::Recorder> {
    let writer = DiskBuffer::builder()
        .base_path(trace_dir)
        .max_file_size(max_file_mib * 1024 * 1024)
        .max_total_size(max_total_mib * 1024 * 1024)
        .build()
        .with_context(|| format!("failed to open trace directory {}", trace_dir.display()))?;

    // Sampling memory profiling rides on the Dial9Allocator that wraps
    // mimalloc (a passthrough until the recorder starts). Sampled at ~512 KiB
    // with liveset tracking off by default, so the steady-state overhead is
    // negligible.
    let mut recorder = dial9::recorder(writer)
        .with_memory_profiling(
            MemoryProfilingConfig::builder()
                .sample_rate_bytes(512 * 1024)
                .build(),
        )
        .with_process_resource_usage(ProcessResourceUsageConfig::default());
    if caps.cpu_profiling {
        recorder = recorder.with_cpu_profiling(CpuProfilingConfig::default());
        recorder = recorder
            .with_sched_events(SchedEventConfig::default().include_kernel(caps.kernel_stacks));
    }
    Ok(recorder.build())
}

/// How the server attaches its runtime to the recorder.
///
/// The attach is also what marks the calling thread as traced, so the spawn
/// handle has to be taken after it.
fn attach_options() -> TokioAttachOptions {
    TokioAttachOptions::builder()
        .task_tracking_enabled(true)
        .build()
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let rt_info = runtime::init();

    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    builder.worker_threads(rt_info.effective_cpus);

    if cli.disable_dial9 {
        let recorder = dial9::recorder_disabled();
        let runtime = recorder
            .handle()
            .attach_tokio_runtime(builder, TokioAttachOptions::default())?;
        let result = dial9::block_on(
            &runtime,
            async_main(cli, Dial9TokioHandle::current(), None, None, rt_info),
        );
        drop(runtime);
        recorder.graceful_shutdown(std::time::Duration::from_secs(5));
        result
    } else {
        let trace_dir = cli
            .trace_dir
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join("cache-server-traces"));
        let _ = std::fs::remove_dir_all(&trace_dir);

        let caps = runtime::check_perf_capabilities();
        let recorder = start_recorder(
            &trace_dir,
            cli.trace_max_file_mib,
            cli.trace_max_total_mib,
            &caps,
        )?;

        let runtime = recorder
            .handle()
            .attach_tokio_runtime(builder, attach_options())?;

        // Only the attach marks this thread as traced, so a handle taken
        // before it would spawn without wake tracking and say nothing.
        let handle = Dial9TokioHandle::current();

        let result = dial9::block_on(
            &runtime,
            async_main(cli, handle, Some(trace_dir), Some(caps), rt_info),
        );
        // Drop the runtime first so worker threads exit and flush their
        // thread-local telemetry buffers to the central collector. Then
        // graceful_shutdown drains the collector, seals the final segment,
        // and gives the background worker time to symbolize + compress.
        drop(runtime);
        recorder.graceful_shutdown(std::time::Duration::from_secs(5));
        result
    }
}

/// Read the registry credentials in the Docker `config.json` at `path`.
fn read_oci_credentials(path: &std::path::Path) -> Result<fetch_oci::RegistryCredentials> {
    let json = std::fs::read(path)
        .with_context(|| format!("failed to read --oci-auth-file {}", path.display()))?;
    let credentials = fetch_oci::RegistryCredentials::from_docker_config(&json)
        .map_err(anyhow::Error::msg)
        .with_context(|| format!("invalid --oci-auth-file {}", path.display()))?;
    tracing::info!(
        registries = ?credentials.registries().collect::<Vec<_>>(),
        "read OCI registry credentials",
    );
    Ok(credentials)
}

fn parse_backend(store: &str) -> Result<store::StoreBackend> {
    if store == "memory" {
        Ok(store::StoreBackend::Memory)
    } else if let Some(path) = store.strip_prefix("file://") {
        Ok(store::StoreBackend::LocalFs(path.to_string()))
    } else if let Some(rest) = store.strip_prefix("s3://") {
        let (bucket, prefix) = match rest.split_once('/') {
            Some((bucket, prefix)) => {
                let prefix = prefix.trim_matches('/');
                (bucket, (!prefix.is_empty()).then(|| prefix.to_string()))
            }
            None => (rest, None),
        };
        if bucket.is_empty() {
            anyhow::bail!("invalid --store value: {:?} (missing bucket name)", store);
        }
        Ok(store::StoreBackend::S3 {
            bucket: bucket.to_string(),
            prefix,
        })
    } else if store.starts_with('/') || store.starts_with('.') {
        Ok(store::StoreBackend::LocalFs(store.to_string()))
    } else {
        anyhow::bail!(
            "invalid --store value: {:?} (expected \"memory\", \"file:///path\", \
             \"s3://bucket[/prefix]\", or a bare path)",
            store
        )
    }
}

#[cfg(test)]
mod parse_backend_tests {
    use super::*;

    #[test]
    fn memory_and_paths() {
        assert!(matches!(
            parse_backend("memory").unwrap(),
            store::StoreBackend::Memory,
        ));
        assert!(matches!(
            parse_backend("file:///var/cache").unwrap(),
            store::StoreBackend::LocalFs(path) if path == "/var/cache",
        ));
        assert!(matches!(
            parse_backend("./relative").unwrap(),
            store::StoreBackend::LocalFs(path) if path == "./relative",
        ));
        parse_backend("garbage").unwrap_err();
    }

    #[test]
    fn s3_urls() {
        assert!(matches!(
            parse_backend("s3://bucket").unwrap(),
            store::StoreBackend::S3 { bucket, prefix: None } if bucket == "bucket",
        ));
        assert!(matches!(
            parse_backend("s3://bucket/").unwrap(),
            store::StoreBackend::S3 { bucket, prefix: None } if bucket == "bucket",
        ));
        assert!(matches!(
            parse_backend("s3://bucket/some/prefix/").unwrap(),
            store::StoreBackend::S3 { bucket, prefix: Some(prefix) }
                if bucket == "bucket" && prefix == "some/prefix",
        ));
        parse_backend("s3://").unwrap_err();
        parse_backend("s3:///prefix-without-bucket").unwrap_err();
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
    handle: Dial9TokioHandle,
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
            fetch_timeout: 1800,
            max_concurrent_requests: 8192,
            disable_compactor: false,
            block_cache_mib: store::DEFAULT_BLOCK_CACHE_BYTES / (1024 * 1024),
            meta_cache_mib: store::DEFAULT_META_CACHE_BYTES / (1024 * 1024),
            write_buffer_mib: None,
            small_blob_cache_mib: store::DEFAULT_SMALL_BLOB_CACHE_BYTES / (1024 * 1024),
            action_result_cache_mib: store::DEFAULT_ACTION_RESULT_CACHE_BYTES / (1024 * 1024),
            manifest_cache_mib: store::DEFAULT_MANIFEST_CACHE_BYTES / (1024 * 1024),
            object_store_cache_dir: None,
            object_store_cache_gib: 16,
            disk_reserve_gib: None,
            tls_cert: None,
            tls_key: None,
            git_spool_dir: None,
            max_concurrent_http_fetches: 16,
            max_concurrent_git_clones: 2,
            max_concurrent_oci_fetches: 4,
            oci_auth_file: None,
            otel_enabled: false,
            otel_endpoint: None,
            otel_service_name: "buck2-cache-server".to_string(),
            otel_sampling_ratio: None,
        }
    }
}

async fn run_compactor(cli: &Cli, handle: Dial9TokioHandle) -> Result<()> {
    let cli_console_layer = tracing_subscriber::fmt::layer().with_filter(
        filter::LevelFilter::from_str(cli.console_log.as_str()).context(
            "invalid --console-log filter (valid values: trace, debug, info, warn, error, off)",
        )?,
    );
    tracing_subscriber::registry()
        .with(cli_console_layer)
        .init();

    // The compactor takes no OTEL flags; the standard environment variables
    // (OTEL_EXPORTER_OTLP_ENDPOINT, ...) enable metrics export.
    let otel_config = telemetry::OtelConfig::from_env();
    telemetry::init_metrics(&otel_config)?;

    let backend = parse_backend(&cli.store)?;
    let object_store =
        store::create_object_store(&backend).context("failed to create object store")?;

    // The same CACHE_SERVER_SLATEDB_* compactor options the server would use.
    let settings = store::settings_for(&backend).context("invalid SlateDB settings")?;
    let mut builder = store::CompactorBuilder::new(store::DB_PATH, object_store);
    if let Some(options) = settings.compactor_options {
        builder = builder.with_options(options);
    }
    if otel_config.enabled {
        builder = builder.with_metrics_recorder(telemetry::OtelMetricsRecorder::new());
    }
    let compactor = Arc::new(builder.build());

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
    telemetry::shutdown_otel();
    Ok(())
}

async fn run_server(
    cli: &Cli,
    args: &ServeArgs,
    handle: Dial9TokioHandle,
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
        rt_info.pressure_dir().map(std::path::Path::to_path_buf),
        std::time::Duration::from_secs(2),
    );

    anyhow::ensure!(
        args.max_concurrent_requests > 0,
        "--max-concurrent-requests must be at least 1"
    );

    let backend = parse_backend(&cli.store)?;
    let oci_credentials = match &args.oci_auth_file {
        Some(path) => read_oci_credentials(path)?,
        None => fetch_oci::RegistryCredentials::default(),
    };

    // Before the store opens: SlateDB registers its metrics as it is built,
    // and instruments created before the meter provider is installed stay
    // no-ops for good.
    telemetry::init_metrics(&otel_config)?;

    const MIB: u64 = 1024 * 1024;
    let store_settings = store::CacheStoreSettings {
        default_ttl: default_ttl(cli.default_ttl_days),
        disable_compactor: args.disable_compactor,
        // `open` derives the SlateDB settings from the backend and the
        // CACHE_SERVER_SLATEDB_* environment.
        slatedb_overrides: None,
        block_cache_bytes: Some(args.block_cache_mib * MIB),
        meta_cache_bytes: Some(args.meta_cache_mib * MIB),
        write_buffer_bytes: args.write_buffer_mib.map(|mib| mib * MIB),
        object_store_cache: args.object_store_cache_dir.clone().map(|dir| {
            store::ObjectStoreCache {
                dir,
                max_bytes: usize::try_from(args.object_store_cache_gib * 1024 * MIB).ok(),
            }
        }),
        metrics_recorder: otel_config
            .enabled
            .then(|| telemetry::OtelMetricsRecorder::new() as Arc<dyn store::MetricsRecorder>),
        disk_reserve_bytes: args.disk_reserve_gib.map(|gib| gib * 1024 * MIB),
        presence_cache_entries: None,
        small_blob_cache_bytes: Some(args.small_blob_cache_mib * MIB),
        action_result_cache_bytes: Some(args.action_result_cache_mib * MIB),
        manifest_cache_bytes: Some(args.manifest_cache_mib * MIB),
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

    let tls_config = match (&args.tls_cert, &args.tls_key) {
        (Some(cert), Some(key)) => Some(tls::load_server_config(cert, key)?),
        (None, None) => None,
        // clap's `requires` enforces the pairing for CLI use; this guards
        // direct construction of ServeArgs.
        _ => anyhow::bail!("--tls-cert and --tls-key must be given together"),
    };

    if !address.ip().is_loopback() {
        if tls_config.is_none() {
            tracing::warn!(
                %address,
                "listening on non-loopback address without authentication or TLS"
            );
        } else {
            tracing::warn!(
                %address,
                "listening on non-loopback address without client authentication"
            );
        }
    }

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
        tls = tls_config.is_some(),
        otel = otel_config.enabled,
        request_timeout_secs = args.request_timeout,
        fetch_timeout_secs = args.fetch_timeout,
        max_concurrent_requests = args.max_concurrent_requests,
        disable_compactor = args.disable_compactor,
        dial9 = dial9::Dial9Handle::current().is_enabled(),
        load_shedding = pressure_monitor.is_some(),
        trace_dir = trace_dir.map_or("disabled".to_string(), |d| d.display().to_string()),
        "cache-server ready",
    );

    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let shutdown_notify2 = shutdown_notify.clone();
    // Set if the store stops under the server (see below).
    let store_failure = Arc::new(std::sync::OnceLock::new());

    let shutdown = {
        let store = cache_store.clone();
        let store_failure = store_failure.clone();
        async move {
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("failed to install SIGTERM handler");

            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    tracing::info!("received SIGINT, draining connections...");
                }
                _ = sigterm.recv() => {
                    tracing::info!("received SIGTERM, draining connections...");
                }
                // A store fenced by another writer, or stopped by a failed
                // background task, fails every request from then on: stop
                // serving rather than answer them all with errors.
                reason = store.failed() => {
                    tracing::error!(?reason, "the store has stopped, draining connections...");
                    let _ = store_failure.set(reason);
                }
            }
            shutdown_notify2.notify_one();
        }
    };

    let drain_deadline = async {
        shutdown_notify.notified().await;
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        tracing::warn!("drain timeout (10s), forcing shutdown");
    };

    let request_timeout =
        (args.request_timeout > 0).then(|| std::time::Duration::from_secs(args.request_timeout));
    let fetch_config = service::FetchConfig {
        cpus: rt_info.effective_cpus,
        git_spool_dir: args.git_spool_dir.clone(),
        max_fetch_time: (args.fetch_timeout > 0)
            .then(|| std::time::Duration::from_secs(args.fetch_timeout)),
        max_http_fetches: args.max_concurrent_http_fetches,
        max_git_clones: args.max_concurrent_git_clones,
        max_oci_fetches: args.max_concurrent_oci_fetches,
        oci_credentials,
    };
    let result = tokio::select! {
        r = reapi_grpc::start_reapi_grpc(
                address,
                tls_config,
                shutdown,
                cache_store.clone(),
                request_timeout,
                Some(args.max_concurrent_requests),
                fetch_config,
                handle,
                pressure_monitor,
        ) => r,
        _ = drain_deadline => Ok(()),
    };

    if let Some(reason) = store_failure.get() {
        telemetry::shutdown_otel();
        return Err(match reason {
            store::CloseReason::Fenced => anyhow::anyhow!(
                "another writer opened the store, fencing this one off; only one writer can \
                 run at a time, and restarting this one would fence the other in turn"
            ),
            reason => anyhow::anyhow!(
                "the store stopped after a background task failed ({reason:?}); see the log \
                 above for the cause"
            ),
        });
    }

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
mod request_timeout;
pub mod service;
pub mod store;
pub mod tls;

#[cfg(test_module_dial9)]
mod test_dial9;

#[cfg(test_module_request_timeout)]
mod test_request_timeout;

#[cfg(test_module_serve)]
mod test_serve;

#[cfg(test_module_tls)]
mod test_tls;

// ---------------------------------------------------------------------------------------------------------------------
