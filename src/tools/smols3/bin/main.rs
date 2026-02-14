// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! smols3: A minimal S3-compatible server with pluggable storage backends.

use std::io::IsTerminal;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use s3s::auth::SimpleAuth;
use s3s::service::{S3Service, S3ServiceBuilder};
use serde::Deserialize;
use store::{
    CedarAuthorizer, ChunkingConfig, ChunkingStore, FjallStore, FjallStoreConfig, MemoryStore,
    SmolS3, SmolS3Config, Store,
};
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::EnvFilter;

use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as ConnBuilder;

// ---------------------------------------------------------------------------------------------------------------------

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Storage backend type.
#[derive(Debug, Clone, Copy, Default, ValueEnum)]
enum StorageBackend {
    /// In-memory storage (fast, non-persistent)
    #[default]
    Memory,
    /// Fjall-based persistent storage (LSM-tree)
    Fjall,
}

#[derive(Parser, Debug)]
#[command(name = "smols3", author = "Austin Seipp", version = "0.1.0")]
struct Cli {
    /// Host name to listen on.
    #[arg(long, default_value = "localhost")]
    host: String,

    /// Port number to listen on.
    #[arg(long, default_value = "8014")]
    port: u16,

    /// Storage backend to use.
    #[arg(long, value_enum, default_value_t = StorageBackend::Memory)]
    storage: StorageBackend,

    /// Path for persistent storage (required for fjall backend).
    #[arg(long)]
    storage_path: Option<PathBuf>,

    /// Enable content-defined chunking for deduplication.
    #[arg(long)]
    chunking: bool,

    /// Minimum chunk size in KB (default: 8).
    #[arg(long, default_value = "8")]
    chunk_min_kb: u32,

    /// Average chunk size in KB (default: 64).
    #[arg(long, default_value = "64")]
    chunk_avg_kb: u32,

    /// Maximum chunk size in KB (default: 256).
    #[arg(long, default_value = "256")]
    chunk_max_kb: u32,

    /// `tracing` filter for the console logs.
    #[arg(long, default_value = "info")]
    console_log: String,

    /// Access key for single-credential authentication.
    #[arg(long, env = "SMOLS3_ACCESS_KEY")]
    access_key: Option<String>,

    /// Secret key for single-credential authentication.
    #[arg(long, env = "SMOLS3_SECRET_KEY")]
    secret_key: Option<String>,

    /// Path to JSON config file for multi-credential authentication.
    #[arg(long)]
    auth_config: Option<PathBuf>,

    /// Path to Cedar policy file for authorization.
    #[arg(long)]
    policy_file: Option<PathBuf>,

    /// Path to directory containing Cedar policy files (*.cedar).
    #[arg(long)]
    policy_dir: Option<PathBuf>,

    /// Maximum allowed body size in bytes for PUT/upload requests. No limit if unset.
    #[arg(long)]
    max_body_size: Option<u64>,

    /// Maximum number of concurrent connections. Default: 1024.
    #[arg(long, default_value = "1024")]
    max_connections: usize,
}

/// Configuration for multi-credential authentication loaded from JSON.
#[derive(Deserialize)]
struct AuthConfig {
    credentials: Vec<AuthCredential>,
}

/// A single credential entry in the auth config.
#[derive(Deserialize)]
struct AuthCredential {
    access_key: String,
    secret_key: String,
}

/// Load authentication configuration from a JSON file.
fn load_auth_config(path: &Path) -> Result<SimpleAuth> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read auth config from {}", path.display()))?;
    let config: AuthConfig = serde_json::from_str(&content)
        .with_context(|| format!("failed to parse auth config from {}", path.display()))?;
    let mut auth = SimpleAuth::new();
    for cred in config.credentials {
        auth.register(cred.access_key, cred.secret_key.into());
    }
    Ok(auth)
}

/// Validate CLI arguments for consistency.
fn validate_cli(cli: &Cli) -> Result<()> {
    match (&cli.access_key, &cli.secret_key) {
        (Some(_), None) => {
            anyhow::bail!("--access-key requires --secret-key to also be specified");
        }
        (None, Some(_)) => {
            anyhow::bail!("--secret-key requires --access-key to also be specified");
        }
        _ => {}
    }

    if cli.policy_file.is_some() && cli.policy_dir.is_some() {
        anyhow::bail!("--policy-file and --policy-dir are mutually exclusive");
    }

    Ok(())
}

/// Load a Cedar policy from a single file.
fn load_policy_file(path: &Path) -> Result<CedarAuthorizer> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read policy file: {}", path.display()))?;
    CedarAuthorizer::from_policy_str(&content)
        .map_err(|e| anyhow::anyhow!("failed to parse policy: {}", e))
}

/// Load Cedar policies from a directory (all *.cedar files).
fn load_policy_dir(dir: &Path) -> Result<CedarAuthorizer> {
    let mut combined = String::new();
    for entry in
        std::fs::read_dir(dir).with_context(|| format!("failed to read policy dir: {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "cedar") {
            let content = std::fs::read_to_string(&path)
                .with_context(|| format!("failed to read: {}", path.display()))?;
            combined.push_str(&content);
            combined.push('\n');
        }
    }
    if combined.is_empty() {
        anyhow::bail!("no .cedar files found in {}", dir.display());
    }
    CedarAuthorizer::from_policy_str(&combined)
        .map_err(|e| anyhow::anyhow!("failed to parse policies: {}", e))
}

fn setup_tracing(filter: &str) -> Result<()> {
    let env_filter = EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .parse(filter)
        .context("invalid console_log filter")?;

    let enable_color = std::io::stdout().is_terminal();

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_ansi(enable_color)
        .init();

    Ok(())
}

/// Optionally wrap a store with ChunkingStore based on CLI flags.
fn wrap_with_chunking<S: Store + 'static>(store: S, cli: &Cli) -> Arc<dyn Store> {
    if cli.chunking {
        let config = ChunkingConfig {
            min_size: cli.chunk_min_kb * 1024,
            avg_size: cli.chunk_avg_kb * 1024,
            max_size: cli.chunk_max_kb * 1024,
        };
        info!(
            min_kb = cli.chunk_min_kb,
            avg_kb = cli.chunk_avg_kb,
            max_kb = cli.chunk_max_kb,
            "content-defined chunking enabled"
        );
        Arc::new(ChunkingStore::with_config(store, config))
    } else {
        Arc::new(store)
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    validate_cli(&cli)?;
    setup_tracing(&cli.console_log)?;
    run(cli)
}

#[tokio::main]
async fn run(cli: Cli) -> Result<()> {
    // Create storage backend
    let store: Arc<dyn Store> = match cli.storage {
        StorageBackend::Memory => {
            let store = MemoryStore::new();
            info!("initialized in-memory storage backend");
            wrap_with_chunking(store, &cli)
        }
        StorageBackend::Fjall => {
            let path = cli
                .storage_path
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("--storage-path is required for fjall backend"))?;
            let config = FjallStoreConfig::new(path);
            let store = FjallStore::open(config).context("failed to open fjall store")?;
            info!(path = %path.display(), "initialized fjall storage backend");
            wrap_with_chunking(store, &cli)
        }
    };

    // Determine authentication mode
    let auth: Option<SimpleAuth> = if let (Some(ak), Some(sk)) = (&cli.access_key, &cli.secret_key)
    {
        info!("authentication enabled (single credential)");
        Some(SimpleAuth::from_single(ak.clone(), sk.clone()))
    } else if let Some(config_path) = &cli.auth_config {
        let auth = load_auth_config(config_path)?;
        info!(path = %config_path.display(), "authentication enabled (config file)");
        Some(auth)
    } else {
        info!("authentication disabled");
        None
    };

    // Load authorization policies
    let access: Option<CedarAuthorizer> = if let Some(policy_path) = &cli.policy_file {
        let authorizer = load_policy_file(policy_path)?;
        info!(path = %policy_path.display(), "authorization enabled (policy file)");
        Some(authorizer)
    } else if let Some(policy_dir) = &cli.policy_dir {
        let authorizer = load_policy_dir(policy_dir)?;
        info!(path = %policy_dir.display(), "authorization enabled (policy directory)");
        Some(authorizer)
    } else {
        info!("authorization disabled (all authenticated requests allowed)");
        None
    };

    // Create S3 service using the storage backend
    let s3_config = SmolS3Config {
        max_body_size: cli.max_body_size,
    };
    if let Some(max) = cli.max_body_size {
        info!(max_bytes = max, "body size limit enabled");
    }
    let s3 = SmolS3::with_config(store, s3_config);
    let service = {
        let mut builder = S3ServiceBuilder::new(s3);
        if let Some(auth) = auth {
            builder.set_auth(auth);
        }
        if let Some(access) = access {
            builder.set_access(access);
        }
        builder.build()
    };

    // Run the HTTP server
    run_server(service, &cli.host, cli.port, cli.max_connections).await
}

async fn run_server(service: S3Service, host: &str, port: u16, max_connections: usize) -> Result<()> {
    let listener = TcpListener::bind((host, port))
        .await
        .context("failed to bind to address")?;
    let local_addr = listener.local_addr()?;

    let http_server = ConnBuilder::new(TokioExecutor::new());
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(max_connections));

    let mut ctrl_c = std::pin::pin!(tokio::signal::ctrl_c());

    info!(max_connections, "server is running at http://{local_addr}");

    loop {
        let (socket, _) = tokio::select! {
            res = listener.accept() => {
                match res {
                    Ok(conn) => conn,
                    Err(err) => {
                        tracing::error!("error accepting connection: {err}");
                        continue;
                    }
                }
            }
            _ = ctrl_c.as_mut() => {
                break;
            }
        };

        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let conn = http_server.serve_connection(TokioIo::new(socket), service.clone());
        let conn = graceful.watch(conn.into_owned());
        tokio::spawn(async move {
            let _ = conn.await;
            drop(permit);
        });
    }

    tokio::select! {
        () = graceful.shutdown() => {
             tracing::debug!("Gracefully shutdown!");
        },
        () = tokio::time::sleep(std::time::Duration::from_secs(10)) => {
             tracing::debug!("Waited 10 seconds for graceful shutdown, aborting...");
        }
    }

    info!("server is stopped");
    Ok(())
}
