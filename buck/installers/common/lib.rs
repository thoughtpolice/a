// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Common framework for Buck2 installer binaries.
//!
//! Provides the [`InstallerHandler`] trait and [`run_installer`] entry point.
//! Installer implementations only need to implement the trait and call the
//! entry point from their `main()`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::sync::Notify;
use tonic::{Request, Response, Status};

pub use proto::installer_server::InstallerServer;
pub use proto::{DeviceMetadata, ErrorCategory, ErrorDetail};

/// Re-export so downstream crates don't need a direct tonic dependency.
pub use tonic::async_trait;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/// Common CLI arguments that buck2 passes to every installer.
///
/// Installer binaries should flatten this into their own `#[derive(clap::Parser)]`
/// struct so that installer-specific arguments are parsed alongside these:
///
/// ```ignore
/// #[derive(clap::Parser)]
/// struct MyArgs {
///     #[command(flatten)]
///     common: common::InstallerArgs,
///
///     #[arg(long)]
///     my_custom_flag: bool,
/// }
/// ```
#[derive(clap::Args, Debug)]
pub struct InstallerArgs {
    /// TCP port to listen on (assigned by buck2)
    #[arg(long = "tcp-port")]
    pub tcp_port: u16,

    /// Path for installer log output
    #[arg(long = "log-path")]
    pub log_path: PathBuf,
}

// ---------------------------------------------------------------------------
// Handler trait
// ---------------------------------------------------------------------------

/// Metadata about a file that buck2 has materialized and is ready for install.
pub struct FileReadyInfo {
    pub install_id: String,
    pub name: String,
    pub path: PathBuf,
    pub digest: String,
    pub digest_algorithm: String,
    pub size: u64,
}

/// Result returned by [`InstallerHandler::file_ready`].
pub struct FileResult {
    pub error: Option<ErrorDetail>,
    pub device_metadata: Vec<DeviceMetadata>,
}

impl Default for FileResult {
    fn default() -> Self {
        Self {
            error: None,
            device_metadata: Vec::new(),
        }
    }
}

/// Trait that installer implementations must provide.
///
/// Each method corresponds to one of the gRPC RPCs in `install.proto`.
#[tonic::async_trait]
pub trait InstallerHandler: Send + Sync + 'static {
    /// Called when buck2 announces an installation (target + expected files).
    async fn install(&self, install_id: &str, file_names: &[String]) -> Result<()>;

    /// Called when a single file has been materialized and is ready to install.
    async fn file_ready(&self, info: FileReadyInfo) -> Result<FileResult>;

    /// Called when buck2 asks the installer to shut down, once every file has
    /// been reported via [`InstallerHandler::file_ready`]. Installers that
    /// produce a single combined artifact should finalize it here rather than
    /// trying to detect the last file. Default is a no-op.
    ///
    /// An error here is reported back to buck2 and becomes the installer's exit
    /// status.
    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// gRPC service implementation
// ---------------------------------------------------------------------------

struct InstallerService<H> {
    handler: Arc<H>,
    shutdown: Arc<Notify>,
    shutdown_error: Arc<Mutex<Option<anyhow::Error>>>,
}

#[tonic::async_trait]
impl<H: InstallerHandler> proto::installer_server::Installer for InstallerService<H> {
    async fn install(
        &self,
        request: Request<proto::InstallInfoRequest>,
    ) -> std::result::Result<Response<proto::InstallResponse>, Status> {
        let req = request.into_inner();
        tracing::info!(install_id = %req.install_id, files = ?req.file_names, "install request");

        self.handler
            .install(&req.install_id, &req.file_names)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(proto::InstallResponse {
            install_id: req.install_id,
        }))
    }

    async fn file_ready(
        &self,
        request: Request<proto::FileReadyRequest>,
    ) -> std::result::Result<Response<proto::FileResponse>, Status> {
        let req = request.into_inner();
        tracing::info!(
            install_id = %req.install_id,
            name = %req.name,
            path = %req.path,
            size = req.size,
            "file ready"
        );

        let info = FileReadyInfo {
            install_id: req.install_id.clone(),
            name: req.name.clone(),
            path: PathBuf::from(&req.path),
            digest: req.digest,
            digest_algorithm: req.digest_algorithm,
            size: req.size,
        };

        let result = self
            .handler
            .file_ready(info)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(proto::FileResponse {
            install_id: req.install_id,
            name: req.name,
            path: req.path,
            error_detail: result.error,
            device_metadata: result.device_metadata,
        }))
    }

    async fn shutdown_server(
        &self,
        _request: Request<proto::ShutdownRequest>,
    ) -> std::result::Result<Response<proto::ShutdownResponse>, Status> {
        tracing::info!("shutdown requested");

        let result = self.handler.shutdown().await;

        // Stop the server before reporting a failure, otherwise a handler that
        // errors leaves buck2 waiting on a process that never exits.
        self.shutdown.notify_one();

        if let Err(e) = result {
            let status = Status::internal(e.to_string());
            *self.shutdown_error.lock().unwrap() = Some(e);
            return Err(status);
        }

        Ok(Response::new(proto::ShutdownResponse {}))
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Set up logging, start the gRPC server, and dispatch RPCs to the provided
/// handler. Returns when buck2 sends `ShutdownServer`, propagating any error
/// from [`InstallerHandler::shutdown`].
///
/// Callers are responsible for parsing CLI arguments (including
/// [`InstallerArgs`]) and constructing their handler before calling this.
pub async fn run_installer<H: InstallerHandler>(args: &InstallerArgs, handler: H) -> Result<()> {
    // Set up file-based logging
    let log_file = std::fs::File::create(&args.log_path)?;
    let subscriber = tracing_subscriber::fmt()
        .with_writer(std::sync::Mutex::new(log_file))
        .with_ansi(false)
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    tracing::info!(port = args.tcp_port, "starting installer");

    let shutdown = Arc::new(Notify::new());
    let shutdown_error = Arc::new(Mutex::new(None));
    let service = InstallerService {
        handler: Arc::new(handler),
        shutdown: shutdown.clone(),
        shutdown_error: shutdown_error.clone(),
    };

    let addr: SocketAddr = ([127, 0, 0, 1], args.tcp_port).into();
    tracing::info!(%addr, "listening");

    tonic::transport::Server::builder()
        .add_service(InstallerServer::new(service))
        .serve_with_shutdown(addr, shutdown.notified())
        .await?;

    if let Some(err) = shutdown_error.lock().unwrap().take() {
        tracing::error!(%err, "shutdown handler failed");
        return Err(err);
    }

    tracing::info!("server shut down");
    Ok(())
}
