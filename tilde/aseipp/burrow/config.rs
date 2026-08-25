// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Logging, configuration paths, and durable endpoint identity.

use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use iroh::SecretKey;
use tracing::info;
use tracing_subscriber::EnvFilter;

/// Builds the log filter and reports whether RUST_LOG supplied it.
///
/// An unset, empty or unparseable RUST_LOG falls back to the `--verbose`
/// default. A typo in an environment variable should not cost you every log
/// line, least of all the allowlist refusal.
pub(super) fn log_filter_from(verbose: u8, rust_log: Option<&str>) -> (EnvFilter, bool) {
    // noq 1.2 warns once or twice per connection when multipath delivers ACK
    // timestamps out of order across paths ("received a timestamp early than
    // a previous recorded time, ignoring"). Nothing goes wrong, but without
    // this filter the warning lands in the terminal on every ssh.
    const QUIET_PACING: &str = "noq_proto::connection::pacing=error";
    let default = match verbose {
        0 => format!("warn,burrow=info,{QUIET_PACING}"),
        1 => format!("info,burrow=debug,{QUIET_PACING}"),
        _ => format!("debug,{QUIET_PACING}"),
    };
    let configured = rust_log
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| match EnvFilter::try_new(value) {
            Ok(filter) => Some(filter),
            Err(err) => {
                eprintln!("burrow: ignoring RUST_LOG={value:?}: {err}");
                None
            }
        });
    match configured {
        Some(filter) => (
            filter.add_directive(
                QUIET_PACING
                    .parse()
                    .expect("the built-in pacing directive is valid"),
            ),
            true,
        ),
        None => (EnvFilter::new(default), false),
    }
}

fn log_filter(verbose: u8) -> (EnvFilter, bool) {
    let rust_log = std::env::var("RUST_LOG").ok();
    log_filter_from(verbose, rust_log.as_deref())
}

pub(super) fn init_logging(verbose: u8) {
    let (filter, from_env) = log_filter(verbose);
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr)
        // Filtering by crate is useless if you cannot see which crate wrote
        // a line, so show targets whenever the filter came from RUST_LOG.
        .with_target(from_env || verbose > 0)
        .init();
}

/// The config directory named by `var`. The XDG spec says to ignore the
/// variable unless it holds an absolute path, and burrow has its own reason
/// to. A relative path resolves against the current directory, and an ssh
/// `ProxyCommand` inherits whatever directory you ran ssh in, so burrow
/// would answer to a different endpoint ID depending on where you were.
fn absolute_dir(dir: Option<PathBuf>) -> Option<PathBuf> {
    dir.filter(|dir| dir.is_absolute())
}

pub(super) fn default_key_path_from(
    xdg: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf> {
    let config_dir = match absolute_dir(xdg) {
        Some(dir) => dir,
        None => absolute_dir(home)
            .context("neither XDG_CONFIG_HOME nor HOME holds an absolute path, so pass --key")?
            .join(".config"),
    };
    Ok(config_dir.join("burrow").join("key"))
}

pub(super) fn default_key_path() -> Result<PathBuf> {
    default_key_path_from(
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

/// Reads the hex secret key at `path`, or generates and stores one if the
/// file does not exist. The key determines the endpoint ID, so both sides
/// need a stable one. The server needs it to stay dialable, the client to
/// stay on the allowlist.
pub(super) fn load_or_create_key(path: &Path) -> Result<SecretKey> {
    match read_key(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        result => {
            return result.with_context(|| format!("reading secret key {}", path.display()));
        }
    }
    let key = SecretKey::generate();
    match write_new_key(path, &key) {
        Ok(()) => {
            info!(path = %path.display(), "generated a new secret key");
            Ok(key)
        }
        // Another burrow generated one first, say two ssh sessions starting
        // together. Its key is the one on disk, so use that.
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => read_key(path)
            .with_context(|| format!("reading the secret key {} just created", path.display())),
        Err(err) => {
            Err(err).with_context(|| format!("writing a new secret key to {}", path.display()))
        }
    }
}

/// Reads the key file, and refuses one that other users can read. This key
/// is all of burrow's authentication, so it gets the treatment ssh gives a
/// private key.
fn read_key(path: &Path) -> io::Result<SecretKey> {
    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not a regular file", path.display()),
        ));
    }
    let mode = metadata.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(io::Error::other(format!(
            "mode {:o} lets other users read it. Run: chmod 600 {}",
            mode & 0o7777,
            path.display()
        )));
    }
    let text = std::io::read_to_string(file)?;
    text.trim()
        .parse()
        .map_err(|_| io::Error::other("not a 32-byte hex secret key"))
}

/// Writes a key nobody else has written yet, or fails with `AlreadyExists`.
///
/// The key goes into a temporary file, which Burrow flushes before publishing
/// it without replacing an existing key. An interrupted first run cannot leave
/// a half-written key behind. That used to be a trap with no way out, because
/// later runs refuse to parse a short file and nothing would replace one.
fn write_new_key(path: &Path, key: &SecretKey) -> io::Result<()> {
    let dir = key_parent(path);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    // tempfile opens at mode 0600 and removes the file if we never persist
    // it, so an interrupted run leaves nothing behind.
    let mut temp = tempfile::Builder::new().prefix(".key").tempfile_in(dir)?;
    writeln!(temp, "{}", hex::encode(key.to_bytes()))?;
    temp.as_file().sync_all()?;
    // persist_noclobber creates the destination exactly once and reports
    // AlreadyExists if a racing burrow got there first.
    temp.persist_noclobber(path).map_err(|err| err.error)?;
    // Flushing the file does not flush the directory entry pointing at it.
    std::fs::File::open(dir)?.sync_all()
}

fn key_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

#[cfg(test)]
#[path = "tests/config.rs"]
mod tests;
