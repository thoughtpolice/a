// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! CLI/TUI-shaped adapter over [`reapi_client`].
//!
//! Everything protocol-shaped — resource names, batch-versus-stream selection,
//! digest verification, asset lookups, directory materialization — lives in
//! `reapi-client`. What remains here is what only this tool needs: filesystem
//! I/O for the CLI's file arguments, result records the TUI renders, and an
//! adapter from the library's progress callback to the channel the event loop
//! already listens on.

use std::path::Path;

use anyhow::{Context, Result};
use reapi_client::{ConnectOptions, Digest, Progress, ReapiClient as Client};
use tokio::sync::mpsc;

pub use reapi_client::{DigestFunction, ServerCapabilities};

/// Interactive users tolerate a slower connect than a launcher does, and the
/// server may be across a network rather than on loopback.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Progress update sent from background gRPC operations.
#[derive(Debug, Clone)]
pub struct ProgressUpdate {
    pub transferred: u64,
    pub total: u64,
}

/// Result of a successful upload.
#[derive(Debug, Clone)]
pub struct UploadResult {
    pub hash: String,
    pub size: u64,
    pub already_present: bool,
}

/// Result of a successful download.
#[derive(Debug, Clone)]
pub struct DownloadResult {
    pub hash: String,
    pub size: u64,
    pub output_path: String,
}

/// Result of a successful fetch (URI resolution + download).
#[derive(Debug, Clone)]
pub struct FetchResult {
    pub uri: String,
    pub hash: String,
    pub size: u64,
    pub output_path: String,
}

/// Bridge the library's progress callback onto the channel the TUI polls.
///
/// A closed receiver is not an error: the CLI drops its receiver immediately
/// because it has nothing to draw.
fn progress_sink(tx: mpsc::UnboundedSender<ProgressUpdate>) -> Progress {
    Progress::new(move |transferred, total| {
        let _ = tx.send(ProgressUpdate { transferred, total });
    })
}

/// Wrapper around [`reapi_client::ReapiClient`] that speaks in file paths and
/// display records.
pub struct ReapiClient {
    inner: Client,
    function: DigestFunction,
}

impl ReapiClient {
    /// Connect to an REAPI server.
    ///
    /// `function` fixes the digest function for every operation on this
    /// client. It is explicit rather than defaulted so that each tool states
    /// which keyspace it is reading and writing: blobs stored under SHA-256
    /// are invisible to a BLAKE3 lookup and vice versa.
    pub async fn connect(url: &str, instance_name: &str, function: DigestFunction) -> Result<Self> {
        let inner = Client::connect(
            ConnectOptions::new(url)
                .instance_name(instance_name)
                .connect_timeout(CONNECT_TIMEOUT),
        )
        .await
        .context("failed to connect to server")?;

        Ok(Self { inner, function })
    }

    /// The digest function this client transfers with.
    pub fn digest_function(&self) -> DigestFunction {
        self.function
    }

    /// Fetch server capabilities.
    pub async fn get_capabilities(&mut self) -> Result<ServerCapabilities> {
        self.inner
            .get_capabilities()
            .await
            .context("GetCapabilities RPC failed")
    }

    /// Upload a file to CAS. Returns the digest.
    pub async fn upload_file(
        &mut self,
        path: &Path,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<UploadResult> {
        let data = tokio::fs::read(path)
            .await
            .with_context(|| format!("failed to read {}", path.display()))?;
        self.upload_bytes(data, progress_tx).await
    }

    /// Upload raw bytes to CAS. Returns the digest.
    pub async fn upload_bytes(
        &mut self,
        data: Vec<u8>,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<UploadResult> {
        let data = bytes::Bytes::from(data);
        let digest = Digest::of(self.function, &data);
        let progress = progress_sink(progress_tx);
        progress.report(0, digest.size as u64);

        // Skipping an upload the server does not need is worth one round trip
        // when the alternative is re-sending the whole blob.
        let missing = self
            .inner
            .find_missing(self.function, std::slice::from_ref(&digest))
            .await
            .context("FindMissingBlobs RPC failed")?;

        if missing.is_empty() {
            progress.report(digest.size as u64, digest.size as u64);
            return Ok(UploadResult {
                hash: digest.hash,
                size: digest.size as u64,
                already_present: true,
            });
        }

        self.inner
            .write_blob_with_progress(self.function, &digest, data, &progress)
            .await
            .context("uploading blob failed")?;

        Ok(UploadResult {
            hash: digest.hash,
            size: digest.size as u64,
            already_present: false,
        })
    }

    /// Download a blob from CAS by digest and write it to `output_path`.
    pub async fn download_blob(
        &mut self,
        hash: &str,
        size: u64,
        output_path: &Path,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<DownloadResult> {
        let digest = Digest::new(hash, size as i64);
        let data = self
            .inner
            .read_blob_with_progress(self.function, &digest, &progress_sink(progress_tx))
            .await
            .context("downloading blob failed")?
            .with_context(|| format!("blob {hash}/{size} not found"))?;

        tokio::fs::write(output_path, &data)
            .await
            .with_context(|| format!("failed to write {}", output_path.display()))?;

        Ok(DownloadResult {
            hash: digest.hash,
            size,
            output_path: output_path.display().to_string(),
        })
    }

    /// Push a remote asset association, mapping URIs + qualifiers to a blob
    /// already present in CAS.
    pub async fn push_blob(
        &mut self,
        hash: &str,
        size: i64,
        uris: Vec<String>,
        qualifiers: Vec<(String, String)>,
    ) -> Result<()> {
        self.inner
            .push_blob(self.function, &Digest::new(hash, size), &uris, &qualifiers)
            .await
            .context("PushBlob RPC failed")
    }

    /// Fetch a remote asset by URI + qualifiers and write it to disk.
    ///
    /// Git repositories and container images resolve to a directory tree and
    /// are materialized under `output_path`; everything else is a single blob
    /// written to it.
    pub async fn fetch_asset(
        &mut self,
        uri: &str,
        qualifiers: Vec<(String, String)>,
        output_path: &Path,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<FetchResult> {
        if is_directory_fetch(uri, &qualifiers) {
            self.fetch_directory_asset(uri, qualifiers, output_path, progress_tx)
                .await
        } else {
            self.fetch_blob_asset(uri, qualifiers, output_path, progress_tx)
                .await
        }
    }

    /// Fetch a remote asset as a directory tree and materialize it under
    /// `output_path`.
    pub async fn fetch_directory_asset(
        &mut self,
        uri: &str,
        qualifiers: Vec<(String, String)>,
        output_path: &Path,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<FetchResult> {
        let uris = vec![uri.to_string()];
        let progress = progress_sink(progress_tx);
        let asset = self
            .inner
            .fetch_directory(self.function, &uris, &qualifiers)
            .await
            .context("FetchDirectory failed")?;

        self.inner
            .materialize_directory(self.function, &asset.digest, output_path, &progress)
            .await
            .with_context(|| format!("writing tree to {}", output_path.display()))?;

        Ok(FetchResult {
            uri: asset.uri,
            hash: asset.digest.hash,
            size: asset.digest.size as u64,
            output_path: output_path.display().to_string(),
        })
    }

    /// Fetch a remote asset as a single blob and write it to `output_path`.
    pub async fn fetch_blob_asset(
        &mut self,
        uri: &str,
        qualifiers: Vec<(String, String)>,
        output_path: &Path,
        progress_tx: mpsc::UnboundedSender<ProgressUpdate>,
    ) -> Result<FetchResult> {
        let uris = vec![uri.to_string()];
        let progress = progress_sink(progress_tx);
        let asset = self
            .inner
            .fetch_blob(self.function, &uris, &qualifiers)
            .await
            .context("FetchBlob failed")?;

        let data = self
            .inner
            .read_blob_with_progress(self.function, &asset.digest, &progress)
            .await
            .context("downloading fetched blob failed")?
            .with_context(|| {
                format!(
                    "server resolved {} to {} but does not hold it",
                    asset.uri, asset.digest
                )
            })?;

        tokio::fs::write(output_path, &data)
            .await
            .with_context(|| format!("failed to write {}", output_path.display()))?;

        Ok(FetchResult {
            uri: asset.uri,
            hash: asset.digest.hash,
            size: asset.digest.size as u64,
            output_path: output_path.display().to_string(),
        })
    }
}

/// Returns true if the URI and qualifiers indicate a directory fetch: a git
/// clone, or a container image (an `oci://` or `docker://` URI), which
/// arrives as an OCI image layout.
///
/// A heuristic, and deliberately kept in this tool rather than in the library:
/// which qualifiers imply a tree is a convention between particular clients
/// and servers, not part of the protocol.
fn is_directory_fetch(uri: &str, qualifiers: &[(String, String)]) -> bool {
    let scheme = uri.split_once("://").map_or("", |(scheme, _)| scheme);
    scheme.eq_ignore_ascii_case("oci")
        || scheme.eq_ignore_ascii_case("docker")
        || qualifiers.iter().any(|(name, value)| {
            (name == "resource_type" && value == "application/x-git")
                || name == "vcs.branch"
                || name == "vcs.commit"
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIT: &str = "https://example.com/repo";

    #[test]
    fn git_qualifiers_select_a_directory_fetch() {
        assert!(is_directory_fetch(
            GIT,
            &[("vcs.commit".to_string(), "abc".to_string())]
        ));
        assert!(is_directory_fetch(
            GIT,
            &[("vcs.branch".to_string(), "main".to_string())]
        ));
        assert!(is_directory_fetch(
            GIT,
            &[("resource_type".to_string(), "application/x-git".to_string())]
        ));
    }

    #[test]
    fn other_qualifiers_select_a_blob_fetch() {
        assert!(!is_directory_fetch(GIT, &[]));
        assert!(!is_directory_fetch(
            GIT,
            &[("checksum.sri".to_string(), "sha256-abc".to_string())]
        ));
        // A resource_type that is not git must not be mistaken for a tree.
        assert!(!is_directory_fetch(
            GIT,
            &[(
                "resource_type".to_string(),
                "application/octet-stream".to_string()
            )]
        ));
    }

    #[test]
    fn image_uris_select_a_directory_fetch() {
        let digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert!(is_directory_fetch(
            &format!("oci://ghcr.io/a/b@{digest}"),
            &[]
        ));
        assert!(is_directory_fetch(
            &format!("Docker://docker.io/a/b@{digest}"),
            &[]
        ));
        assert!(!is_directory_fetch("https://example.com/oci://x", &[]));
    }

    #[test]
    fn progress_updates_reach_the_channel() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let progress = progress_sink(tx);

        progress.report(3, 9);
        progress.report(9, 9);

        let first = rx.try_recv().expect("first update");
        assert_eq!((first.transferred, first.total), (3, 9));
        let second = rx.try_recv().expect("second update");
        assert_eq!((second.transferred, second.total), (9, 9));
    }

    /// The CLI drops its receiver because it has nothing to draw; that must
    /// not surface as an error mid-transfer.
    #[test]
    fn a_dropped_receiver_is_not_an_error() {
        let (tx, rx) = mpsc::unbounded_channel();
        let progress = progress_sink(tx);
        drop(rx);
        progress.report(1, 2);
    }
}
