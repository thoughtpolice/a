// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! HTTP(S) fetching with redirect support.
//!
//! Uses hyper + rustls with the in-tree BoringSSL crypto provider for built-in
//! HTTPS support without shelling out to curl. Handles 3xx redirects (up to 10
//! hops) which is required for GitHub release URLs that always 302 to
//! objects.githubusercontent.com.

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use http::Uri;
use http_body_util::{BodyExt, Empty};
use hyper_rustls::HttpsConnectorBuilder;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

const MAX_REDIRECTS: u32 = 10;
const USER_AGENT: &str = "shabang2/0.1.0";

/// Fetch the contents of `url` via HTTP(S), following redirects.
pub async fn fetch_url(url: &str) -> Result<Vec<u8>> {
    let mut uri: Uri = url.parse().context("invalid URL")?;
    let https = HttpsConnectorBuilder::new()
        .with_provider_and_native_roots(rustls_boring::arc_provider())
        .context("loading native root certificates")?
        .https_or_http()
        .enable_http1()
        .build();
    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new()).build(https);

    for i in 0..=MAX_REDIRECTS {
        let req = hyper::Request::get(uri.clone())
            .header(hyper::header::USER_AGENT, USER_AGENT)
            .body(Empty::<Bytes>::new())
            .context("building request")?;
        let resp = client
            .request(req)
            .await
            .with_context(|| format!("GET {uri}"))?;

        if resp.status().is_redirection() {
            let location = resp
                .headers()
                .get(hyper::header::LOCATION)
                .context("redirect without Location header")?;
            let location_str = location.to_str().context("non-ASCII Location header")?;
            uri = resolve_redirect(&uri, location_str)?;
            tracing::debug!(redirect = i, uri = %uri, "following redirect");
            continue;
        }

        if !resp.status().is_success() {
            bail!("HTTP {} for {}", resp.status(), uri);
        }

        let body = resp
            .into_body()
            .collect()
            .await
            .context("reading response body")?
            .to_bytes();
        tracing::debug!(size = body.len(), "download complete");
        return Ok(body.to_vec());
    }

    bail!("too many redirects (max {MAX_REDIRECTS})")
}

/// Resolve a potentially-relative redirect Location against the original URI.
fn resolve_redirect(base: &Uri, location: &str) -> Result<Uri> {
    // Absolute URL
    if location.starts_with("http://") || location.starts_with("https://") {
        return location.parse().context("parsing redirect URL");
    }

    // Relative path — reuse scheme, authority from base
    let scheme = base.scheme_str().unwrap_or("https");
    let authority = base.authority().context("base URL has no authority")?;
    let absolute = format!("{scheme}://{authority}{location}");
    absolute.parse().context("parsing resolved redirect URL")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_redirect_absolute() {
        let base: Uri = "https://github.com/foo/bar".parse().unwrap();
        let resolved = resolve_redirect(&base, "https://cdn.example.com/file.zst").unwrap();
        assert_eq!(resolved.to_string(), "https://cdn.example.com/file.zst");
    }

    #[test]
    fn test_resolve_redirect_relative() {
        let base: Uri = "https://github.com/foo/bar".parse().unwrap();
        let resolved = resolve_redirect(&base, "/other/path?q=1").unwrap();
        assert_eq!(resolved.to_string(), "https://github.com/other/path?q=1");
    }

    #[tokio::test]
    async fn test_fetch_url_invalid() {
        let err = fetch_url("not-a-valid-url").await;
        assert!(err.is_err());
    }
}
