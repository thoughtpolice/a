// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Tarball installer that collects files into a compressed `.tar.gz` archive.
//!
//! The archive is reproducible: entries are sorted by path, and every header
//! field that would otherwise record the build machine — mtime, uid, gid, and
//! any mode bits beyond "is it executable" — is normalized, so the same inputs
//! produce byte-identical output. (Identical for a given compressor: upgrading
//! flate2 or its backend can change the compressed bytes without changing the
//! archive's contents.)
//!
//! Sorting means nothing can be written until every file is known, so the
//! archive is built in `shutdown`, once buck2 has reported them all.
//!
//! By default the archive is written to `$TMPDIR/buck2-tarball-<uuid>.tar.gz`.
//! Use `--output` to choose the destination and `--prefix` to nest every entry
//! under a directory inside the archive:
//!
//! ```sh
//! buck2 install //my:target -- --output release.tar.gz --prefix myproject-1.0
//! ```

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Result, bail};
use clap::Parser;
use common::{FileReadyInfo, FileResult, InstallerArgs, InstallerHandler};

type Archive = tar::Builder<flate2::write::GzEncoder<std::fs::File>>;

/// Recorded in the gzip header in place of the platform that built the archive.
const OS_UNKNOWN: u8 = 255;

#[derive(Parser, Debug)]
#[command(name = "tarball-installer")]
struct Args {
    #[command(flatten)]
    common: InstallerArgs,

    /// Output path for the tarball. Defaults to a unique file in $TMPDIR.
    #[arg(long)]
    output: Option<PathBuf>,

    /// Optional prefix directory inside the tarball (e.g. "myproject-1.0").
    #[arg(long)]
    prefix: Option<String>,
}

#[derive(Default)]
struct State {
    install_ids: HashSet<String>,
    entries: Vec<(String, PathBuf)>,
}

struct TarballHandler {
    output: PathBuf,
    prefix: Option<String>,
    state: Mutex<State>,
}

impl TarballHandler {
    fn new(output: Option<PathBuf>, prefix: Option<String>) -> Self {
        let output = output.unwrap_or_else(|| {
            let id = uuid::Uuid::new_v4();
            std::env::temp_dir().join(format!("buck2-tarball-{id}.tar.gz"))
        });
        println!("tarball installer: output will be {}", output.display());
        Self {
            output,
            prefix,
            state: Mutex::new(State::default()),
        }
    }
}

/// The archive is built next to its destination and moved into place only once
/// it is complete, so a failed install never leaves a truncated `.tar.gz` where
/// a good one used to be.
fn partial_path(output: &Path) -> PathBuf {
    let mut name = output.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    output.with_file_name(name)
}

/// Strip everything that would differ between two otherwise identical builds.
/// The executable bit is the only source metadata worth carrying into the
/// archive, so it is the only thing that survives.
fn normalized_header(meta: &std::fs::Metadata) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Regular);
    header.set_size(meta.len());
    header.set_mtime(0);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mode(if meta.permissions().mode() & 0o111 == 0 {
        0o644
    } else {
        0o755
    });
    header
}

fn build_tarball(output: &Path, prefix: Option<&str>, entries: Vec<(String, PathBuf)>) -> Result<()> {
    let partial = partial_path(output);
    match write_archive(&partial, prefix, entries) {
        Ok(()) => {
            std::fs::rename(&partial, output)?;
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(e)
        }
    }
}

fn write_archive(partial: &Path, prefix: Option<&str>, entries: Vec<(String, PathBuf)>) -> Result<()> {
    if let Some(parent) = partial.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = std::fs::File::create(partial)?;
    let encoder = flate2::GzBuilder::new()
        .mtime(0)
        .operating_system(OS_UNKNOWN)
        .write(file, flate2::Compression::default());
    let mut archive: Archive = tar::Builder::new(encoder);

    for (name, path) in entries {
        // Follows symlinks: buck2 materializes artifacts as links into its
        // cache, and a distributable archive wants the contents, not the link.
        let meta = std::fs::metadata(&path)?;
        if !meta.is_file() {
            bail!("{}: only regular files can be archived", path.display());
        }

        let archive_path = match prefix {
            Some(p) => format!("{p}/{name}"),
            None => name,
        };
        let mut header = normalized_header(&meta);
        archive.append_data(&mut header, &archive_path, std::fs::File::open(&path)?)?;

        tracing::debug!(entry = %archive_path, "appended to archive");
    }

    archive.into_inner()?.finish()?;
    Ok(())
}

#[common::async_trait]
impl InstallerHandler for TarballHandler {
    async fn install(&self, install_id: &str, file_names: &[String]) -> Result<()> {
        tracing::info!(
            install_id,
            ?file_names,
            output = %self.output.display(),
            "received install request"
        );
        self.state
            .lock()
            .unwrap()
            .install_ids
            .insert(install_id.to_string());
        Ok(())
    }

    async fn file_ready(&self, info: FileReadyInfo) -> Result<FileResult> {
        tracing::info!(
            install_id = %info.install_id,
            name = %info.name,
            path = %info.path.display(),
            size = info.size,
            "file ready"
        );

        let mut state = self.state.lock().unwrap();
        if !state.install_ids.contains(&info.install_id) {
            bail!("unknown install_id: {}", info.install_id);
        }
        state.entries.push((info.name, info.path));

        Ok(FileResult::default())
    }

    async fn shutdown(&self) -> Result<()> {
        let mut entries = {
            let mut state = self.state.lock().unwrap();
            std::mem::take(&mut state.entries)
        };
        if entries.is_empty() {
            tracing::warn!("no files received, skipping tarball");
            return Ok(());
        }

        // Files are reported concurrently, in no particular order.
        entries.sort();
        let count = entries.len();

        let output = self.output.clone();
        let prefix = self.prefix.clone();
        // Compression is blocking work; keep it off the runtime's workers.
        tokio::task::spawn_blocking(move || build_tarball(&output, prefix.as_deref(), entries))
            .await??;

        println!("tarball created: {} ({count} files)", self.output.display());
        tracing::info!(output = %self.output.display(), count, "tarball created");
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let handler = TarballHandler::new(args.output, args.prefix);
    common::run_installer(&args.common, handler).await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn ready(install_id: &str, name: &str, path: PathBuf) -> FileReadyInfo {
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        FileReadyInfo {
            install_id: install_id.to_string(),
            name: name.to_string(),
            path,
            digest: String::new(),
            digest_algorithm: String::new(),
            size,
        }
    }

    fn entry_paths(tarball: &Path) -> Result<Vec<String>> {
        let file = std::fs::File::open(tarball)?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);
        archive
            .entries()?
            .map(|e| Ok(e?.path()?.to_string_lossy().to_string()))
            .collect()
    }

    /// Install `names` (created with the given contents) and finalize.
    async fn install_all(output: &Path, names: &[&str], dir: &Path) -> Result<()> {
        let handler = TarballHandler::new(Some(output.to_path_buf()), None);
        handler
            .install("test", &names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
            .await?;

        for name in names {
            let src = dir.join(name);
            std::fs::write(&src, format!("contents of {name}"))?;
            handler.file_ready(ready("test", name, src)).await?;
        }

        handler.shutdown().await
    }

    #[tokio::test]
    async fn creates_tarball_with_files() -> Result<()> {
        let tmp = tempfile::tempdir()?;

        // Create source files
        let src_a = tmp.path().join("src_a.txt");
        std::fs::write(&src_a, "contents of alpha")?;

        let src_b = tmp.path().join("src_b.txt");
        std::fs::write(&src_b, "contents of beta")?;

        let tarball_path = tmp.path().join("out.tar.gz");
        let handler = TarballHandler::new(Some(tarball_path.clone()), None);

        let file_names = vec!["alpha.txt".to_string(), "beta.txt".to_string()];
        handler.install("test-1", &file_names).await?;

        handler
            .file_ready(ready("test-1", "alpha.txt", src_a))
            .await?;
        handler.file_ready(ready("test-1", "beta.txt", src_b)).await?;
        handler.shutdown().await?;

        // Extract and verify
        assert!(tarball_path.exists(), "tarball should exist");
        let file = std::fs::File::open(&tarball_path)?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);

        let mut entries: HashMap<String, String> = HashMap::new();
        for entry in archive.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.to_string_lossy().to_string();
            let mut contents = String::new();
            std::io::Read::read_to_string(&mut entry, &mut contents)?;
            entries.insert(path, contents);
        }

        assert_eq!(entries.len(), 2);
        assert_eq!(entries["alpha.txt"], "contents of alpha");
        assert_eq!(entries["beta.txt"], "contents of beta");

        Ok(())
    }

    #[tokio::test]
    async fn creates_tarball_with_prefix() -> Result<()> {
        let tmp = tempfile::tempdir()?;

        let src = tmp.path().join("src.txt");
        std::fs::write(&src, "hello")?;

        let tarball_path = tmp.path().join("prefixed.tar.gz");
        let handler =
            TarballHandler::new(Some(tarball_path.clone()), Some("myapp-1.0".to_string()));

        handler
            .install("test-2", &["greeting.txt".to_string()])
            .await?;

        handler
            .file_ready(ready("test-2", "greeting.txt", src))
            .await?;
        handler.shutdown().await?;

        assert_eq!(entry_paths(&tarball_path)?, vec!["myapp-1.0/greeting.txt"]);

        Ok(())
    }

    #[tokio::test]
    async fn output_appears_only_at_shutdown() -> Result<()> {
        let tmp = tempfile::tempdir()?;

        let src = tmp.path().join("src.txt");
        std::fs::write(&src, "hello")?;

        let tarball_path = tmp.path().join("late.tar.gz");
        let handler = TarballHandler::new(Some(tarball_path.clone()), None);

        handler.install("test-3", &["only.txt".to_string()]).await?;
        handler.file_ready(ready("test-3", "only.txt", src)).await?;

        assert!(
            !tarball_path.exists(),
            "tarball should not appear before shutdown"
        );

        handler.shutdown().await?;

        assert_eq!(entry_paths(&tarball_path)?, vec!["only.txt"]);
        assert!(
            !partial_path(&tarball_path).exists(),
            "partial archive should be renamed away"
        );

        Ok(())
    }

    #[tokio::test]
    async fn entries_are_sorted() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let tarball_path = tmp.path().join("sorted.tar.gz");

        install_all(&tarball_path, &["c.txt", "a.txt", "b.txt"], tmp.path()).await?;

        assert_eq!(entry_paths(&tarball_path)?, ["a.txt", "b.txt", "c.txt"]);

        Ok(())
    }

    #[tokio::test]
    async fn normalizes_entry_metadata() -> Result<()> {
        let tmp = tempfile::tempdir()?;

        let plain = tmp.path().join("plain.txt");
        std::fs::write(&plain, "data")?;
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o600))?;

        let exec = tmp.path().join("tool");
        std::fs::write(&exec, "#!/bin/sh\n")?;
        std::fs::set_permissions(&exec, std::fs::Permissions::from_mode(0o700))?;

        let tarball_path = tmp.path().join("normalized.tar.gz");
        let handler = TarballHandler::new(Some(tarball_path.clone()), None);
        handler
            .install("test-4", &["plain.txt".to_string(), "tool".to_string()])
            .await?;
        handler.file_ready(ready("test-4", "plain.txt", plain)).await?;
        handler.file_ready(ready("test-4", "tool", exec)).await?;
        handler.shutdown().await?;

        let file = std::fs::File::open(&tarball_path)?;
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));

        let mut modes: HashMap<String, u32> = HashMap::new();
        for entry in archive.entries()? {
            let entry = entry?;
            let name = entry.path()?.to_string_lossy().to_string();
            let header = entry.header();

            // The source files were written moments ago, owned by whoever runs
            // the test, so a zero here can only come from normalization.
            assert_eq!(header.mtime()?, 0, "{name}: mtime not normalized");
            assert_eq!(header.uid()?, 0, "{name}: uid not normalized");
            assert_eq!(header.gid()?, 0, "{name}: gid not normalized");

            modes.insert(name, header.mode()?);
        }

        assert_eq!(modes["plain.txt"], 0o644);
        assert_eq!(modes["tool"], 0o755, "the executable bit must survive");

        Ok(())
    }

    #[tokio::test]
    async fn byte_identical_across_runs() -> Result<()> {
        let names = ["b.txt", "a.txt", "c.txt"];

        let first_dir = tempfile::tempdir()?;
        let first = first_dir.path().join("first.tar.gz");
        install_all(&first, &names, first_dir.path()).await?;

        // Same contents, different source directory, and reported in a
        // different order.
        let second_dir = tempfile::tempdir()?;
        let second = second_dir.path().join("second.tar.gz");
        let mut reordered = names;
        reordered.reverse();
        install_all(&second, &reordered, second_dir.path()).await?;

        assert_eq!(
            std::fs::read(&first)?,
            std::fs::read(&second)?,
            "identical inputs must produce identical archives"
        );

        Ok(())
    }

    #[tokio::test]
    async fn shutdown_without_files_is_a_no_op() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let tarball_path = tmp.path().join("empty.tar.gz");
        let handler = TarballHandler::new(Some(tarball_path.clone()), None);

        handler.shutdown().await?;

        assert!(!tarball_path.exists(), "no files means no tarball");

        Ok(())
    }

    #[tokio::test]
    async fn missing_source_fails_at_shutdown() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let tarball_path = tmp.path().join("doomed.tar.gz");
        let handler = TarballHandler::new(Some(tarball_path.clone()), None);

        handler.install("test-5", &["gone.txt".to_string()]).await?;
        handler
            .file_ready(ready("test-5", "gone.txt", tmp.path().join("nonexistent")))
            .await?;

        assert!(
            handler.shutdown().await.is_err(),
            "a source file that cannot be read must fail the install"
        );
        assert!(!tarball_path.exists(), "failed archive must not be published");
        assert!(
            !partial_path(&tarball_path).exists(),
            "failed archive must be cleaned up"
        );

        Ok(())
    }

    #[tokio::test]
    async fn rejects_directory_entries() -> Result<()> {
        let tmp = tempfile::tempdir()?;

        let dir = tmp.path().join("adir");
        std::fs::create_dir(&dir)?;
        std::fs::write(dir.join("inner.txt"), "buried")?;

        let tarball_path = tmp.path().join("dir.tar.gz");
        let handler = TarballHandler::new(Some(tarball_path.clone()), None);

        handler.install("test-6", &["adir".to_string()]).await?;
        handler.file_ready(ready("test-6", "adir", dir)).await?;

        assert!(
            handler.shutdown().await.is_err(),
            "a directory must fail loudly rather than archive as an empty entry"
        );
        assert!(!tarball_path.exists());

        Ok(())
    }

    #[tokio::test]
    async fn rejects_unknown_install_id() {
        let tmp = tempfile::tempdir().unwrap();
        let handler = TarballHandler::new(Some(tmp.path().join("out.tar.gz")), None);

        let result = handler
            .file_ready(ready("bogus", "x.txt", PathBuf::from("/dev/null")))
            .await;

        assert!(result.is_err());
    }
}
