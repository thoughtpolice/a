// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! HTTP(S) fetching with redirect support.
//!
//! Uses hyper + openssl for built-in HTTPS support without shelling out
//! to curl. Handles 3xx redirects (up to 10 hops) which is required for
//! GitHub release URLs that always 302 to objects.githubusercontent.com.

use anyhow::{Result, bail};

/// Fetch the contents of `url` via HTTP(S), following redirects.
///
/// # Stub
///
/// This is a stub for Phase 1. The real implementation (Phase 2) will use
/// hyper + openssl + tokio-openssl following the cache-server http_fetch
/// pattern.
pub async fn fetch_url(_url: &str) -> Result<Vec<u8>> {
    bail!("http::fetch_url not yet implemented (Phase 2)")
}
