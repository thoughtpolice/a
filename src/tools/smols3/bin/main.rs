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
use store::{FjallStore, FjallStoreConfig, MemoryStore, SmolS3, Store};
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
        _ => Ok(()),
    }
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
            Arc::new(store)
        }
        StorageBackend::Fjall => {
            let path = cli
                .storage_path
                .ok_or_else(|| anyhow::anyhow!("--storage-path is required for fjall backend"))?;
            let config = FjallStoreConfig::new(&path);
            let store = FjallStore::open(config).context("failed to open fjall store")?;
            info!(path = %path.display(), "initialized fjall storage backend");
            Arc::new(store)
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

    // Create S3 service using the storage backend
    let s3 = SmolS3::new(store);
    let service = {
        let mut builder = S3ServiceBuilder::new(s3);
        if let Some(auth) = auth {
            builder.set_auth(auth);
        }
        builder.build()
    };

    // Run the HTTP server
    run_server(service, &cli.host, cli.port).await
}

async fn run_server(service: S3Service, host: &str, port: u16) -> Result<()> {
    let listener = TcpListener::bind((host, port))
        .await
        .context("failed to bind to address")?;
    let local_addr = listener.local_addr()?;

    let http_server = ConnBuilder::new(TokioExecutor::new());
    let graceful = hyper_util::server::graceful::GracefulShutdown::new();

    let mut ctrl_c = std::pin::pin!(tokio::signal::ctrl_c());

    info!("server is running at http://{local_addr}");

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

        let conn = http_server.serve_connection(TokioIo::new(socket), service.clone());
        let conn = graceful.watch(conn.into_owned());
        tokio::spawn(async move {
            let _ = conn.await;
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
