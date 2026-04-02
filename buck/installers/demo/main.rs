// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Demo installer that copies files into a directory.
//!
//! By default, files are installed to `$TMPDIR/buck2-install-<uuid>/`.
//! Use `--output-dir` to specify a custom destination:
//!
//! ```sh
//! buck2 install //my:target -- --output-dir /path/to/dir
//! ```

use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use common::{FileReadyInfo, FileResult, InstallerArgs, InstallerHandler};

#[derive(Parser, Debug)]
#[command(name = "demo-installer")]
struct Args {
    #[command(flatten)]
    common: InstallerArgs,

    /// Directory to install files into. If not specified, a unique temporary
    /// directory is created under $TMPDIR.
    #[arg(long)]
    output_dir: Option<PathBuf>,
}

struct DemoHandler {
    dest_dir: PathBuf,
}

impl DemoHandler {
    fn new(output_dir: Option<PathBuf>) -> Result<Self> {
        let dest_dir = match output_dir {
            Some(dir) => dir,
            None => {
                let id = uuid::Uuid::new_v4();
                std::env::temp_dir().join(format!("buck2-install-{id}"))
            }
        };
        std::fs::create_dir_all(&dest_dir)?;
        println!(
            "demo installer: files will be installed to {}",
            dest_dir.display()
        );
        Ok(Self { dest_dir })
    }
}

#[common::async_trait]
impl InstallerHandler for DemoHandler {
    async fn install(&self, install_id: &str, file_names: &[String]) -> Result<()> {
        tracing::info!(
            install_id,
            ?file_names,
            dest = %self.dest_dir.display(),
            "received install request"
        );
        Ok(())
    }

    async fn file_ready(&self, info: FileReadyInfo) -> Result<FileResult> {
        let dest = self.dest_dir.join(&info.name);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::copy(&info.path, &dest).await?;
        println!("  installed: {}", dest.display());
        tracing::info!(
            name = %info.name,
            src = %info.path.display(),
            dest = %dest.display(),
            size = info.size,
            "installed file"
        );
        Ok(FileResult::default())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let handler = DemoHandler::new(args.output_dir)?;
    common::run_installer(&args.common, handler).await
}
