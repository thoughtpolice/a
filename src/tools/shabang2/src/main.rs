// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! shabang2 — DotSlash-compatible tool launcher with built-in HTTP.
//!
//! Makes JSON manifest files executable via shebang. Downloads, caches,
//! and executes platform-specific binaries described in the manifest.

mod archive;
mod cache;
mod exec;
mod http;
mod lock;
mod manifest;
mod platform;

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// DotSlash-compatible tool launcher with built-in HTTP and archive support.
#[derive(Parser)]
#[command(name = "shabang2", version = "0.1.0")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Path to the shabang2 manifest file (used in shebang mode).
    manifest: Option<PathBuf>,

    /// Arguments passed through to the executed binary.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Execute a manifest file (same as shebang mode, but explicit).
    Exec {
        /// Path to the manifest file.
        file: PathBuf,
        /// Arguments to pass to the binary.
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },

    /// Download and cache the artifact without executing it.
    Fetch {
        /// Path to the manifest file.
        file: PathBuf,
    },

    /// Print the cache directory path.
    CacheDir,

    /// Remove all cached artifacts.
    Clean,
}

fn main() -> Result<()> {
    init_tracing();

    // When invoked via shebang, the kernel calls:
    //   /usr/bin/env shabang2 <script-path> <user-args...>
    // So the first positional arg is the manifest path.
    let cli = Cli::parse();

    match cli.command {
        Some(Command::Exec { file, args }) => run_manifest(&file, &args),
        Some(Command::Fetch { file }) => fetch_manifest(&file),
        Some(Command::CacheDir) => print_cache_dir(),
        Some(Command::Clean) => clean_cache(),
        None => {
            // Shebang mode: manifest path is the first positional arg
            let manifest_path = cli.manifest.context("no manifest file specified")?;
            run_manifest(&manifest_path, &cli.args)
        }
    }
}

/// Initialize tracing based on `SHABANG2_LOG` environment variable.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_env("SHABANG2_LOG").unwrap_or_else(|_| EnvFilter::new("off"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}

/// Core flow: parse manifest, resolve platform, check cache, fetch if
/// needed, then exec.
fn run_manifest(path: &PathBuf, args: &[String]) -> Result<()> {
    let manifest = manifest::parse_manifest_file(path)
        .with_context(|| format!("failed to load: {}", path.display()))?;

    let entry = platform::resolve_platform(&manifest.platforms)
        .with_context(|| format!("in manifest '{}'", manifest.name))?;

    tracing::info!(
        name = %manifest.name,
        platform = %platform::current_platform_key(),
        format = ?entry.format,
        size = entry.size,
        "resolved platform entry"
    );

    let cache = cache::Cache::new()?;

    // Try cache first
    if let Ok(Some(cached_path)) = cache.lookup(entry) {
        tracing::info!(path = %cached_path.display(), "cache hit");
        return exec::exec_binary(&cached_path, args);
    }

    // Acquire lock to prevent concurrent downloads of the same artifact
    let lock_path = cache
        .base_dir()
        .join(format!("{}.lock", cache::Cache::cache_key(entry)));
    let _lock = lock::FileLock::acquire(&lock_path).context("acquiring cache lock")?;

    // Double-check after lock (another process may have populated the cache)
    if let Ok(Some(cached_path)) = cache.lookup(entry) {
        tracing::info!(path = %cached_path.display(), "cache hit after lock");
        return exec::exec_binary(&cached_path, args);
    }

    // Fetch, verify, extract, cache
    let cached_path = fetch_verify_extract_cache(entry, &cache)?;

    // Execute
    exec::exec_binary(&cached_path, args)
}

/// Fetch from providers, verify integrity, extract, and store in cache.
fn fetch_verify_extract_cache(
    entry: &manifest::PlatformEntry,
    cache: &cache::Cache,
) -> Result<PathBuf> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("creating tokio runtime")?;

    let data = rt.block_on(fetch_from_providers(entry))?;

    // Verify size
    if data.len() as u64 != entry.size {
        bail!(
            "size mismatch: expected {} bytes, got {} bytes",
            entry.size,
            data.len(),
        );
    }

    // Verify hash
    verify_hash(entry, &data)?;

    // Extract to temp directory
    let temp_dir = tempfile::tempdir().context("creating temp dir for extraction")?;
    let _extracted = archive::extract(&data, entry.format, &entry.path, temp_dir.path())?;

    // Store in cache
    cache.store(entry, temp_dir.path())
}

/// Try each provider in sequence until one succeeds.
async fn fetch_from_providers(entry: &manifest::PlatformEntry) -> Result<Vec<u8>> {
    let mut last_err = None;

    for (i, provider) in entry.providers.iter().enumerate() {
        tracing::info!(
            provider = i,
            url = %provider.url,
            "attempting fetch"
        );
        match http::fetch_url(&provider.url).await {
            Ok(data) => return Ok(data),
            Err(e) => {
                tracing::warn!(
                    provider = i,
                    err = %e,
                    "provider failed"
                );
                last_err = Some(e);
            }
        }
    }

    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no providers configured")))
}

/// Verify the hash of downloaded data against the manifest entry.
fn verify_hash(entry: &manifest::PlatformEntry, data: &[u8]) -> Result<()> {
    let computed = match entry.hash {
        manifest::HashAlgorithm::Sha256 => {
            use sha2::Digest;
            hex::encode(sha2::Sha256::digest(data))
        }
        manifest::HashAlgorithm::Blake3 => blake3::hash(data).to_hex().to_string(),
    };

    if computed != entry.digest {
        bail!(
            "hash mismatch for '{}':\n  expected: {}\n  computed: {}",
            entry.path,
            entry.digest,
            computed,
        );
    }

    tracing::info!(algorithm = ?entry.hash, "hash verified");
    Ok(())
}

/// Fetch and cache an artifact without executing it.
fn fetch_manifest(path: &PathBuf) -> Result<()> {
    let manifest = manifest::parse_manifest_file(path)
        .with_context(|| format!("failed to load: {}", path.display()))?;

    let entry = platform::resolve_platform(&manifest.platforms)
        .with_context(|| format!("in manifest '{}'", manifest.name))?;

    let cache = cache::Cache::new()?;

    // Already cached?
    if let Ok(Some(cached_path)) = cache.lookup(entry) {
        eprintln!("already cached: {}", cached_path.display());
        return Ok(());
    }

    // Acquire lock
    let lock_path = cache
        .base_dir()
        .join(format!("{}.lock", cache::Cache::cache_key(entry)));
    let _lock = lock::FileLock::acquire(&lock_path)?;

    // Double-check after lock
    if let Ok(Some(cached_path)) = cache.lookup(entry) {
        eprintln!("already cached: {}", cached_path.display());
        return Ok(());
    }

    let cached_path = fetch_verify_extract_cache(entry, &cache)?;
    eprintln!("fetched {} -> {}", manifest.name, cached_path.display());
    Ok(())
}

/// Print the cache directory path.
fn print_cache_dir() -> Result<()> {
    let cache = cache::Cache::new()?;
    println!("{}", cache.base_dir().display());
    Ok(())
}

/// Remove all cached artifacts.
fn clean_cache() -> Result<()> {
    let cache = cache::Cache::new()?;
    let dir = cache.base_dir();
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .with_context(|| format!("removing cache dir: {}", dir.display()))?;
        eprintln!("removed {}", dir.display());
    } else {
        eprintln!("cache dir does not exist: {}", dir.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verify_hash_sha256_ok() {
        let data = b"hello world";
        let entry = manifest::PlatformEntry {
            size: data.len() as u64,
            hash: manifest::HashAlgorithm::Sha256,
            digest: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9".to_string(),
            format: manifest::ArchiveFormat::Plain,
            path: "test".to_string(),
            providers: vec![],
        };
        verify_hash(&entry, data).unwrap();
    }

    #[test]
    fn test_verify_hash_sha256_mismatch() {
        let data = b"hello world";
        let entry = manifest::PlatformEntry {
            size: data.len() as u64,
            hash: manifest::HashAlgorithm::Sha256,
            digest: "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
            format: manifest::ArchiveFormat::Plain,
            path: "test".to_string(),
            providers: vec![],
        };
        let err = verify_hash(&entry, data).unwrap_err();
        assert!(err.to_string().contains("hash mismatch"));
    }

    #[test]
    fn test_verify_hash_blake3_ok() {
        let data = b"hello world";
        let hash = blake3::hash(data);
        let entry = manifest::PlatformEntry {
            size: data.len() as u64,
            hash: manifest::HashAlgorithm::Blake3,
            digest: hash.to_hex().to_string(),
            format: manifest::ArchiveFormat::Plain,
            path: "test".to_string(),
            providers: vec![],
        };
        verify_hash(&entry, data).unwrap();
    }
}
