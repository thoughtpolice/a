// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Tarball installer that collects files into a compressed `.tar.gz` archive.
//!
//! By default the archive is written to `$TMPDIR/buck2-tarball-<uuid>.tar.gz`.
//! Use `--output` to choose the destination and `--prefix` to nest every entry
//! under a directory inside the archive:
//!
//! ```sh
//! buck2 install //my:target -- --output release.tar.gz --prefix myproject-1.0
//! ```

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Result, bail};
use clap::Parser;
use common::{FileReadyInfo, FileResult, InstallerArgs, InstallerHandler};

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

struct InstallState {
    expected: usize,
    received: Vec<(String, PathBuf)>,
}

struct TarballHandler {
    output: PathBuf,
    prefix: Option<String>,
    installs: Mutex<HashMap<String, InstallState>>,
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
            installs: Mutex::new(HashMap::new()),
        }
    }

    fn build_tarball(&self, state: &InstallState) -> Result<()> {
        if let Some(parent) = self.output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::File::create(&self.output)?;
        let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);

        for (name, path) in &state.received {
            let archive_path = match &self.prefix {
                Some(p) => format!("{p}/{name}"),
                None => name.clone(),
            };
            archive.append_path_with_name(path, &archive_path)?;
        }

        let encoder = archive.into_inner()?;
        encoder.finish()?;
        Ok(())
    }
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
        let mut installs = self.installs.lock().unwrap();
        installs.insert(
            install_id.to_string(),
            InstallState {
                expected: file_names.len(),
                received: Vec::new(),
            },
        );
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

        let should_finalize = {
            let mut installs = self.installs.lock().unwrap();
            let state = installs
                .get_mut(&info.install_id)
                .ok_or_else(|| anyhow::anyhow!("unknown install_id: {}", info.install_id))?;
            state.received.push((info.name.clone(), info.path));
            state.received.len() == state.expected
        };

        if should_finalize {
            let installs = self.installs.lock().unwrap();
            let state = installs.get(&info.install_id).unwrap();
            self.build_tarball(state)?;
            println!("tarball created: {}", self.output.display());
        }

        Ok(FileResult::default())
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
    use super::*;

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
            .file_ready(FileReadyInfo {
                install_id: "test-1".to_string(),
                name: "alpha.txt".to_string(),
                path: src_a,
                digest: String::new(),
                digest_algorithm: String::new(),
                size: 17,
            })
            .await?;

        handler
            .file_ready(FileReadyInfo {
                install_id: "test-1".to_string(),
                name: "beta.txt".to_string(),
                path: src_b,
                digest: String::new(),
                digest_algorithm: String::new(),
                size: 16,
            })
            .await?;

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
            .file_ready(FileReadyInfo {
                install_id: "test-2".to_string(),
                name: "greeting.txt".to_string(),
                path: src,
                digest: String::new(),
                digest_algorithm: String::new(),
                size: 5,
            })
            .await?;

        let file = std::fs::File::open(&tarball_path)?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(decoder);

        let paths: Vec<String> = archive
            .entries()?
            .map(|e| e.unwrap().path().unwrap().to_string_lossy().to_string())
            .collect();

        assert_eq!(paths, vec!["myapp-1.0/greeting.txt"]);

        Ok(())
    }

    #[tokio::test]
    async fn rejects_unknown_install_id() {
        let tmp = tempfile::tempdir().unwrap();
        let handler = TarballHandler::new(Some(tmp.path().join("out.tar.gz")), None);

        let result = handler
            .file_ready(FileReadyInfo {
                install_id: "bogus".to_string(),
                name: "x.txt".to_string(),
                path: PathBuf::from("/dev/null"),
                digest: String::new(),
                digest_algorithm: String::new(),
                size: 0,
            })
            .await;

        assert!(result.is_err());
    }
}
