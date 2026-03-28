// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

mod client;

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::Parser;

use client::ReapiClient;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(
    name = "buck-log-downloader",
    about = "Download buck2 event logs from a REAPI cache server",
    version = option_env!("depot_VERSION").unwrap_or("dev"),
)]
struct Args {
    /// Trace ID of the build invocation to download
    trace_id: String,

    /// Output file path
    output: PathBuf,

    /// REAPI server URL
    #[arg(
        long,
        default_value = "http://127.0.0.1:8080",
        env = "CACHE_CLIENT_SERVER"
    )]
    server: String,

    /// Instance name for REAPI requests
    #[arg(long, default_value = "", env = "CACHE_CLIENT_INSTANCE")]
    instance: String,
}

fn main() -> ExitCode {
    let args = Args::parse();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    match rt.block_on(run(args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("buck-log-downloader: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> Result<()> {
    let mut client = ReapiClient::connect(&args.server, &args.instance)
        .await
        .context("failed to connect to server")?;

    let uri = format!("buck2-logs://{}", args.trace_id);
    let (progress_tx, _progress_rx) = tokio::sync::mpsc::unbounded_channel();

    let result = client
        .fetch_asset(&uri, vec![], &args.output, progress_tx)
        .await
        .with_context(|| format!("failed to fetch log for trace {}", args.trace_id))?;

    eprintln!(
        "buck-log-downloader: downloaded {} bytes to {}",
        result.size,
        args.output.display(),
    );

    Ok(())
}
