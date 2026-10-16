// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

mod client;

use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::Parser;
use tokio::io::AsyncReadExt;

use client::ReapiClient;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(
    name = "buck-log-uploader",
    about = "Upload buck2 event logs to a REAPI cache server",
    version = option_env!("depot_VERSION").unwrap_or("dev"),
)]
struct Args {
    /// Trace ID for this build invocation
    #[arg(long)]
    trace_id: String,

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
            eprintln!("buck-log-uploader: {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> Result<()> {
    let mut data = Vec::new();
    tokio::io::stdin()
        .read_to_end(&mut data)
        .await
        .context("failed to read stdin")?;

    if data.is_empty() {
        eprintln!("buck-log-uploader: stdin was empty, nothing to upload");
        return Ok(());
    }

    let (progress_tx, _progress_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut client = ReapiClient::connect(&args.server, &args.instance)
        .await
        .context("failed to connect to server")?;

    let size = data.len() as u64;
    let result = client
        .upload_bytes(data, progress_tx)
        .await
        .context("failed to upload log data")?;

    // Tag the CAS blob as a remote asset keyed by trace ID. No qualifiers are
    // needed because CAS already provides SHA-256 integrity verification.
    let uri = format!("buck2-logs://{}", args.trace_id);
    client
        .push_blob(&result.hash, size as i64, vec![uri.clone()], vec![])
        .await
        .context("failed to tag log as remote asset")?;

    if result.already_present {
        eprintln!("buck-log-uploader: already present in CAS");
    }
    eprintln!("buck-log-uploader: uploaded {size} bytes as {uri}");
    println!("{} {size}", result.hash);

    Ok(())
}
