// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Happy Fun Ball. Do not taunt.

use std::{str::FromStr, sync::Arc};

use clap::Parser;
use tracing_subscriber::{filter, prelude::*};

// ---------------------------------------------------------------------------------------------------------------------

#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser, Debug)]
#[command(
    name = "buck2-cache-server",
    author = "Austin Seipp",
    version = "0.1.0"
)]
struct Cli {
    /// The address to listen on
    #[arg(short, long, default_value = "127.0.0.1:8080")]
    address: String,

    /// Enable tokio-console debugging subscriber
    #[arg(long, default_value_t = false)]
    tokio_console: bool,

    /// `tracing` filter for the console logs.
    #[arg(long, default_value = "info")]
    console_log: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    let tokio_console_layer = if cli.tokio_console {
        Some(console_subscriber::spawn())
    } else {
        None
    };
    let cli_console_layer = tracing_subscriber::fmt::layer()
        .with_filter(filter::LevelFilter::from_str(cli.console_log.as_str()).unwrap());

    tracing_subscriber::registry()
        .with(tokio_console_layer)
        .with(cli_console_layer)
        //  .with(..potential additional layer..)
        .init();

    let address = cli.address.parse().unwrap();
    tracing::info!(
        message = "Starting buck2-cache-server",
        address = format!("{}", address)
    );

    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    let shutdown_notify2 = shutdown_notify.clone();

    let shutdown = async move {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler");

        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("received SIGINT, draining connections...");
            }
            _ = sigterm.recv() => {
                tracing::info!("received SIGTERM, draining connections...");
            }
        }

        shutdown_notify2.notify_one();
    };

    let drain_deadline = async {
        shutdown_notify.notified().await;
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        tracing::warn!("drain timeout (10s), forcing shutdown");
    };

    tokio::select! {
        _ = reapi_grpc::start_reapi_grpc(address, shutdown) => Ok(()),
        _ = drain_deadline => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------------------------------------

pub mod reapi_grpc;
pub mod service;
pub mod store;

// ---------------------------------------------------------------------------------------------------------------------
