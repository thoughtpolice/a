// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Installer that puts each file at its name under a prefix directory, as
//! `make install` does: `bin/tool` goes to `PREFIX/bin/tool`.
//!
//! The prefix is `~/.local` unless `--prefix` names another:
//!
//! ```sh
//! buck2 install //my:target                         # into ~/.local
//! buck2 install //my:target -- --prefix /opt/tool
//! ```
//!
//! A file is written beside its destination and renamed over it, so what
//! was there is replaced whole, never left half-written, and a program
//! that is running keeps its old executable (writing into a running one in
//! place fails with ETXTBSY). Buck's outputs are read-only; an installed
//! file is writable by its owner, executable only if the output was.
//!
//! On Windows, where a file has no modes, an installed file is only made
//! writable; and as a running program's executable cannot be replaced, nor
//! deleted, but can be renamed, one in the way is first moved aside, to be
//! deleted by the next install once it has exited.

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::Parser;
use common::{FileReadyInfo, FileResult, InstallerArgs, InstallerHandler};

#[derive(Parser, Debug)]
#[command(name = "prefix-installer")]
struct Args {
    #[command(flatten)]
    common: InstallerArgs,

    /// The directory files are installed under. Defaults to ~/.local.
    #[arg(long)]
    prefix: Option<PathBuf>,
}

struct PrefixHandler {
    prefix: PathBuf,
}

/// Where `name` goes under `prefix`: a relative path, which may not leave
/// it.
fn destination(prefix: &Path, name: &str) -> Result<PathBuf> {
    let path = Path::new(name);
    let normal = path.components().all(|c| matches!(c, Component::Normal(_)));
    if name.is_empty() || !normal {
        bail!("{name:?}: an installed file's name must be a relative path, without `..`");
    }
    Ok(prefix.join(path))
}

/// The file `dest` is written as before it is renamed into place: hidden,
/// beside it (a rename stays within a file system), and this process's own.
fn partial_path(dest: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(".");
    name.push(dest.file_name().unwrap_or_default());
    name.push(format!(".install-{}", std::process::id()));
    dest.with_file_name(name)
}

/// Copies `src` to `dest`, replacing it whole.
fn install_file(src: &Path, dest: &Path) -> Result<()> {
    let parent = dest.parent().context("no parent directory")?;
    std::fs::create_dir_all(parent).with_context(|| format!("{}", parent.display()))?;
    // Follows symlinks: Buck materializes outputs as links into its cache.
    let permissions = std::fs::metadata(src)
        .with_context(|| format!("{}", src.display()))?
        .permissions();
    let partial = partial_path(dest);
    let written = std::fs::copy(src, &partial)
        .and_then(|_| std::fs::set_permissions(&partial, writable(permissions)))
        .and_then(|_| replace(&partial, dest));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&partial);
        return Err(e).with_context(|| format!("{}", dest.display()));
    }
    Ok(())
}

/// The permissions an installed copy of a file with `of` gets.
#[cfg(unix)]
fn writable(of: std::fs::Permissions) -> std::fs::Permissions {
    let executable = of.mode() & 0o111 != 0;
    std::fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 })
}

#[cfg(not(unix))]
fn writable(mut of: std::fs::Permissions) -> std::fs::Permissions {
    #[allow(clippy::permissions_set_readonly_false)]
    of.set_readonly(false);
    of
}

/// Renames `partial` over `dest`.
#[cfg(unix)]
fn replace(partial: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::rename(partial, dest)
}

/// Renames `partial` over `dest`, moving `dest` aside first: a program that
/// is running cannot be replaced, but can be renamed.
#[cfg(not(unix))]
fn replace(partial: &Path, dest: &Path) -> std::io::Result<()> {
    let mut name = std::ffi::OsString::from(".");
    name.push(dest.file_name().unwrap_or_default());
    name.push(".old");
    let aside = dest.with_file_name(name);
    // One left by an install before this, which may still be running.
    let _ = std::fs::remove_file(&aside);
    if dest.exists() && std::fs::rename(dest, &aside).is_err() {
        // Then whatever was there is in use under that name as well.
        return std::fs::rename(partial, dest);
    }
    std::fs::rename(partial, dest)
}

#[common::async_trait]
impl InstallerHandler for PrefixHandler {
    async fn install(&self, install_id: &str, file_names: &[String]) -> Result<()> {
        tracing::info!(install_id, ?file_names, prefix = %self.prefix.display(), "install request");
        // Every name is checked before any file is ready, so a bad one
        // stops the install before anything is written.
        for name in file_names {
            destination(&self.prefix, name)?;
        }
        Ok(())
    }

    async fn file_ready(&self, info: FileReadyInfo) -> Result<FileResult> {
        let dest = destination(&self.prefix, &info.name)?;
        let src = info.path.clone();
        let to = dest.clone();
        tokio::task::spawn_blocking(move || install_file(&src, &to)).await??;
        println!("installed {}", dest.display());
        tracing::info!(name = %info.name, dest = %dest.display(), size = info.size, "installed");
        Ok(FileResult::default())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let prefix = match args.prefix {
        Some(prefix) => prefix,
        None => std::env::home_dir()
            .context("no home directory: pass --prefix")?
            .join(".local"),
    };
    common::run_installer(&args.common, PrefixHandler { prefix }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(name: &str, path: PathBuf) -> FileReadyInfo {
        FileReadyInfo {
            install_id: "test".into(),
            name: name.into(),
            path,
            digest: String::new(),
            digest_algorithm: String::new(),
            size: 0,
        }
    }

    // Modes, and a running program that keeps its file, are Unix's.
    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    // Modes, and a running program that keeps its file, are Unix's.
    #[cfg(unix)]
    #[tokio::test]
    async fn installs_under_the_prefix_with_writable_modes() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let prefix = tmp.path().join("prefix");
        let tool = tmp.path().join("tool");
        std::fs::write(&tool, "#!/bin/sh\n")?;
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o555))?;
        let data = tmp.path().join("data");
        std::fs::write(&data, "data")?;
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o444))?;

        let handler = PrefixHandler {
            prefix: prefix.clone(),
        };
        let names = ["bin/tool".to_string(), "share/tool/data".to_string()];
        handler.install("test", &names).await?;
        handler.file_ready(ready("bin/tool", tool)).await?;
        handler.file_ready(ready("share/tool/data", data)).await?;

        assert_eq!(
            std::fs::read_to_string(prefix.join("bin/tool"))?,
            "#!/bin/sh\n"
        );
        assert_eq!(mode(&prefix.join("bin/tool")), 0o755);
        assert_eq!(
            std::fs::read_to_string(prefix.join("share/tool/data"))?,
            "data"
        );
        assert_eq!(mode(&prefix.join("share/tool/data")), 0o644);
        Ok(())
    }

    // Modes, and a running program that keeps its file, are Unix's.
    #[cfg(unix)]
    #[tokio::test]
    async fn replaces_a_file_whole_leaving_nothing_beside_it() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let prefix = tmp.path().join("prefix");
        std::fs::create_dir_all(prefix.join("bin"))?;
        let old = prefix.join("bin/tool");
        std::fs::write(&old, "old")?;
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o555))?;
        // A program running the old file keeps it: the new one is another.
        let running = std::fs::File::open(&old)?;

        let new = tmp.path().join("new");
        std::fs::write(&new, "new")?;
        let handler = PrefixHandler {
            prefix: prefix.clone(),
        };
        handler.file_ready(ready("bin/tool", new)).await?;

        assert_eq!(std::fs::read_to_string(&old)?, "new");
        assert_eq!(std::io::read_to_string(running)?, "old");
        let left: Vec<_> = std::fs::read_dir(prefix.join("bin"))?
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, ["tool"]);
        Ok(())
    }

    #[tokio::test]
    async fn refuses_names_that_leave_the_prefix() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let handler = PrefixHandler {
            prefix: tmp.path().join("prefix"),
        };
        for name in [
            "../escape",
            "/etc/passwd",
            "bin/../../escape",
            "",
            "./bin/tool",
        ] {
            assert!(
                handler.install("test", &[name.to_string()]).await.is_err(),
                "{name:?} accepted"
            );
        }
        Ok(())
    }
}
