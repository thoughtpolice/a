// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Happy Fun Ball. Do not taunt.

use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use dial9::cpu::{CpuProfilingConfig, SchedEventConfig};
use dial9::memory::{Dial9Allocator, MemoryProfilingConfig};
use dial9::process::ProcessResourceUsageConfig;
use dial9::{
    Dial9HandleTokioExt as _, Dial9TokioHandle, DiskBuffer, RecorderPerfExt as _,
    TokioAttachOptions,
};
use tracing_subscriber::{filter, filter::FilterExt as _, prelude::*};

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

    /// Which events the console log shows: a level (`info`), or directives
    /// in `RUST_LOG` syntax, e.g. `info,slatedb::garbage_collector=debug`.
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
    /// $TMPDIR/cache-server-traces. Each subcommand records into its own
    /// subdirectory (`serve/`, `compact/`), which keeps earlier runs' traces
    /// within --trace-max-total-mib.
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

    /// Record one in this many kernel context switches (when the kernel
    /// allows scheduler events at all). Each carries a stack, and a busy
    /// server switches tens of thousands of times a second.
    #[arg(
        long,
        default_value_t = 10,
        env = "CACHE_SERVER_TRACE_SCHED_SAMPLE_INTERVAL",
        global = true
    )]
    trace_sched_sample_interval: u64,

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

    /// Most connections open at once; past it, new ones wait in the listen
    /// backlog. Defaults to three quarters of the open-files limit (which
    /// the server raises to its hard limit), keeping the rest for the store.
    #[arg(long, env = "CACHE_SERVER_MAX_CONNECTIONS")]
    max_connections: Option<usize>,

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
    sched_sample_interval: u64,
    metadata: Vec<(String, String)>,
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
        .with_process_resource_usage(ProcessResourceUsageConfig::default())
        .segment_metadata(metadata);
    if caps.cpu_profiling {
        recorder = recorder.with_cpu_profiling(CpuProfilingConfig::default());
        recorder = recorder.with_sched_events(
            SchedEventConfig::default()
                .sampling_interval(sched_sample_interval.max(1))
                .include_kernel(caps.kernel_stacks),
        );
    }
    Ok(recorder.build())
}

/// What every trace segment says about the process that wrote it, so
/// segments from different hosts, versions, and runs can be told apart.
fn trace_metadata(cli: &Cli, command: &str) -> Vec<(String, String)> {
    let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    [
        ("service.name", "buck2-cache-server".to_string()),
        (
            "service.version",
            option_env!("depot_VERSION").unwrap_or("dev").to_string(),
        ),
        ("host.name", hostname),
        ("process.pid", std::process::id().to_string()),
        ("cache_server.command", command.to_string()),
        ("cache_server.store", cli.store.clone()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

/// Claim `base/command` as this process's trace directory.
///
/// dial9 keeps a trace directory within its size budget across restarts by
/// itself (numbering on from, and evicting, the segments it finds), so
/// earlier runs' traces stay for post-mortems instead of being wiped. Two
/// writers in one directory would truncate and delete each other's
/// segments, though, so the directory is locked for the life of the
/// process: `None` if another process holds it.
fn claim_trace_dir(
    base: &std::path::Path,
    command: &str,
) -> Result<Option<(PathBuf, std::fs::File)>> {
    let dir = base.join(command);
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("failed to create trace directory {}", dir.display()))?;
    let lock = std::fs::File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(".lock"))
        .with_context(|| format!("failed to open the lock in {}", dir.display()))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Ok(None),
        Err(std::fs::TryLockError::Error(e)) => {
            return Err(e).with_context(|| format!("failed to lock {}", dir.display()));
        }
    }
    set_aside_raw_segments(&dir)?;
    Ok(Some((dir, lock)))
}

/// Rename raw `trace.N.bin` segments, left by a run that died (or whose
/// shutdown drain timed out) before symbolizing them, to
/// `trace.N.bin.unsymbolized`.
///
/// dial9's worker symbolizes whatever raw segments it finds against *this*
/// process's memory map, which would label an earlier run's stacks with the
/// wrong functions. The new name is still part of the segment's family, so
/// it counts against the size budget and is evicted with it.
fn set_aside_raw_segments(dir: &std::path::Path) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let raw = name
            .strip_prefix("trace.")
            .and_then(|rest| rest.strip_suffix(".bin"))
            .is_some_and(|index| index.parse::<u32>().is_ok());
        if raw {
            let aside = dir.join(format!("{name}.unsymbolized"));
            std::fs::rename(entry.path(), &aside)
                .with_context(|| format!("failed to set aside {}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// Toggle dial9 recording on each SIGUSR1, so an operator can pause tracing
/// on a busy server (or resume it) without a restart.
fn spawn_recording_toggle() -> Result<()> {
    let mut usr1 = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined1())
        .context("failed to install SIGUSR1 handler")?;
    // Housekeeping, so a plain spawn: nothing about it is worth tracing.
    tokio::spawn(async move {
        while usr1.recv().await.is_some() {
            let handle = dial9::Dial9Handle::current();
            if handle.is_enabled() {
                handle.disable();
            } else {
                handle.enable();
            }
            tracing::info!(
                recording = handle.is_enabled(),
                "SIGUSR1: toggled dial9 recording"
            );
        }
    });
    Ok(())
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

    let command = match cli.command {
        Some(Command::Compact) => "compact",
        Some(Command::Serve(_)) | None => "serve",
    };
    let claimed = if cli.disable_dial9 {
        None
    } else {
        let base = cli
            .trace_dir
            .clone()
            .unwrap_or_else(|| std::env::temp_dir().join("cache-server-traces"));
        let claimed = claim_trace_dir(&base, command)?;
        if claimed.is_none() {
            // Logging is not up yet.
            eprintln!(
                "warning: another process is recording into {}; running without dial9 \
                 tracing (give this one its own --trace-dir)",
                base.join(command).display()
            );
        }
        claimed
    };

    let Some((trace_dir, _trace_lock)) = claimed else {
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
        return result;
    };

    let caps = runtime::check_perf_capabilities();
    let recorder = start_recorder(
        &trace_dir,
        cli.trace_max_file_mib,
        cli.trace_max_total_mib,
        cli.trace_sched_sample_interval,
        trace_metadata(&cli, command),
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
    // and gives the background worker time to symbolize + compress. The
    // trace lock is held until after it.
    drop(runtime);
    recorder.graceful_shutdown(std::time::Duration::from_secs(5));
    result
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

#[cfg(test)]
mod bare_invocation_tests {
    use super::*;

    /// No subcommand runs `serve` exactly as `serve` with no flags would,
    /// environment and all.
    #[test]
    fn runs_serve_as_given_no_flags() {
        let Some(Command::Serve(serve)) = Cli::parse_from(["cache-server", "serve"]).command else {
            panic!("`serve` parses as the serve subcommand");
        };
        assert!(Cli::parse_from(["cache-server"]).command.is_none());
        assert_eq!(format!("{:?}", bare_serve_args()), format!("{serve:?}"));
    }

    /// `serve`'s environment variables reach the bare invocation. Checked
    /// in a child run of this test binary: setting a variable in this
    /// process would race other tests reading the environment.
    #[test]
    fn takes_the_environment() {
        let child = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .args(["--exact", "bare_invocation_tests::listens_where_told"])
            .env("CACHE_SERVER_ADDRESS", "127.0.0.1:4321")
            .output()
            .expect("run the child");
        let stdout = String::from_utf8_lossy(&child.stdout);
        assert!(
            child.status.success() && stdout.contains("1 passed"),
            "{stdout}{}",
            String::from_utf8_lossy(&child.stderr)
        );
    }

    /// The address `CACHE_SERVER_ADDRESS` sets, if any, else the default.
    #[test]
    fn listens_where_told() {
        let expected =
            std::env::var("CACHE_SERVER_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8080".into());
        assert_eq!(bare_serve_args().address, expected);
    }
}

#[cfg(test)]
mod console_filter_tests {
    use super::*;

    fn filter(arg: &str) -> Result<filter::EnvFilter> {
        console_filter(&Cli::parse_from(["cache-server", "--console-log", arg]))
    }

    #[test]
    fn levels_and_directives() {
        filter("warn").expect("a level");
        filter("info,slatedb::garbage_collector=debug").expect("directives");
        let err = filter("info,slatedb=loud").unwrap_err();
        assert!(format!("{err:#}").contains("--console-log"), "{err:#}");
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
        Some(Command::Compact) => run_compactor(&cli).await,
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
                &bare_serve_args(),
                handle,
                trace_dir.as_ref(),
                perf_caps.as_ref(),
                &rt_info,
            )
            .await
        }
    }
}

/// What `serve` runs with when no subcommand is given: as if it were given
/// without flags, so each takes its default or the value its environment
/// variable sets.
fn bare_serve_args() -> ServeArgs {
    ServeArgs::parse_from(["serve"])
}

/// Most times a second any one log statement reaches a log layer (see
/// [`telemetry::LogStormGuard`]).
const LOG_STATEMENT_RATE: u32 = 20;

/// Every 10 s, say how many log events `guards` dropped, if any.
fn spawn_suppression_report(guards: Vec<telemetry::LogStormGuard>) {
    const EVERY: std::time::Duration = std::time::Duration::from_secs(10);
    // Housekeeping, so a plain spawn.
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(EVERY);
        loop {
            tick.tick().await;
            let dropped: u64 = guards.iter().map(|g| g.take_suppressed()).sum();
            if dropped > 0 {
                tracing::warn!(
                    dropped,
                    "dropped {dropped} log events in the last {}s from statements logging \
                     more than {LOG_STATEMENT_RATE} times a second",
                    EVERY.as_secs()
                );
            }
        }
    });
}

/// The console log filter `--console-log` asks for.
fn console_filter(cli: &Cli) -> Result<filter::EnvFilter> {
    filter::EnvFilter::builder()
        .parse(&cli.console_log)
        .with_context(|| {
            format!(
                "invalid --console-log filter {:?} (a level such as `info`, or directives \
                 such as `info,slatedb=debug`)",
                cli.console_log
            )
        })
}

async fn run_compactor(cli: &Cli) -> Result<()> {
    let storm_guard = telemetry::LogStormGuard::new(LOG_STATEMENT_RATE);
    let cli_console_layer =
        tracing_subscriber::fmt::layer().with_filter(console_filter(cli)?.and(storm_guard.clone()));
    tracing_subscriber::registry()
        .with(cli_console_layer)
        .init();
    spawn_suppression_report(vec![storm_guard]);

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

    spawn_recording_toggle()?;
    // Housekeeping, so a plain spawn: its polls are still recorded, but
    // nothing waits on it to need wake tracking.
    let compactor_task = {
        let c = Arc::clone(&compactor);
        tokio::spawn(async move { c.run().await })
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
    // Each layer gets its own guard: one shared would count an event both
    // layers see twice.
    let console_guard = telemetry::LogStormGuard::new(LOG_STATEMENT_RATE);
    let otel_guard = telemetry::LogStormGuard::new(LOG_STATEMENT_RATE);
    let cli_console_layer = tracing_subscriber::fmt::layer()
        .with_filter(console_filter(cli)?.and(console_guard.clone()));

    // Request spans are INFO. Below that are every dependency's internals,
    // tokio's span per spawned task among them, which would be exported too.
    let otel_layer = telemetry::init_otel_layer(&otel_config)?
        .map(|layer| layer.with_filter(filter::LevelFilter::INFO.and(otel_guard.clone())));

    tracing_subscriber::registry()
        .with(tokio_console_layer)
        .with(cli_console_layer)
        .with(otel_layer)
        .init();
    spawn_suppression_report(vec![console_guard, otel_guard]);

    rt_info.emit_diagnostics();
    if let Some(caps) = perf_caps {
        caps.emit_warnings();
    }
    spawn_recording_toggle()?;

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

    let max_connections = args
        .max_connections
        .unwrap_or_else(|| runtime::fds::max_connections(rt_info.open_files.unwrap_or(1024)));

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
        max_connections,
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
                max_connections,
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
