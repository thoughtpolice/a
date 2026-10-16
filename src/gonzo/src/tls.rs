// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! TLS configuration for the gRPC listener: PEM files in, a TLS 1.3
//! [`rustls::ServerConfig`] on the BoringSSL provider out.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};

/// Load a PEM certificate chain + private key into a server config running
/// on the BoringSSL provider (TLS 1.3, `h2`/`http/1.1` ALPN).
pub fn load_server_config(cert: &Path, key: &Path) -> Result<Arc<rustls::ServerConfig>> {
    let cert_pem = std::fs::read(cert)
        .with_context(|| format!("failed to read TLS certificate {}", cert.display()))?;
    let key_pem = std::fs::read(key)
        .with_context(|| format!("failed to read TLS private key {}", key.display()))?;
    let config = rustls_transport::server_config_from_pem(
        rustls_boring::arc_provider(),
        &cert_pem,
        &key_pem,
    )
    .map_err(|err| anyhow::anyhow!(err))
    .with_context(|| {
        format!(
            "failed to build TLS config from {} and {}",
            cert.display(),
            key.display()
        )
    })?;
    Ok(Arc::new(config))
}
