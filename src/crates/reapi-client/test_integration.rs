// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Round-trips against a real `cache-server` process.
//!
//! These deliberately do not use a hand-written stub server. The bugs worth
//! catching here are wire-format ones — the digest-function segment in a
//! resource name, the `DigestFunction.Value` numbers, whether a miss arrives
//! as an initial `NOT_FOUND` — and a stub would encode the same assumptions as
//! the client, agree with it, and be wrong in the same direction.

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::{BATCH_THRESHOLD, ConnectOptions, Digest, DigestFunction, Error, Progress, ReapiClient};

/// A `cache-server` child process, killed when the test drops it.
struct ServerGuard {
    child: Child,
    url: String,
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Ask the OS for an unused port, then hand it to the server. There is an
/// unavoidable gap between releasing the port and the server binding it; on a
/// loopback interface in a test that is not worth defending against.
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

async fn start_server() -> (ServerGuard, ReapiClient) {
    let binary = buck_resources::get("src/crates/reapi-client/cache-server")
        .expect("cache-server binary resource");

    let port = free_port();
    let child = Command::new(&binary)
        // `--store`/`--console-log` are global; `--address` belongs to the
        // `serve` subcommand, which must be named explicitly to reach it even
        // though it is the default.
        .args([
            "--store",
            "memory",
            "--console-log",
            "error",
            "serve",
            "--address",
            &format!("127.0.0.1:{port}"),
        ])
        .spawn()
        .expect("spawn cache-server");

    let guard = ServerGuard {
        child,
        url: format!("http://127.0.0.1:{port}"),
    };

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match ReapiClient::connect(ConnectOptions::new(&guard.url)).await {
            Ok(client) => return (guard, client),
            Err(e) if Instant::now() >= deadline => {
                panic!("cache-server did not become ready at {}: {e}", guard.url)
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

#[tokio::test]
async fn sha256_blob_round_trip() {
    let (_server, mut client) = start_server().await;
    let data = bytes::Bytes::from_static(b"the quick brown fox");
    let digest = Digest::of(DigestFunction::Sha256, &data);

    client
        .write_blob(DigestFunction::Sha256, &digest, data.clone())
        .await
        .expect("write");
    let got = client
        .read_blob(DigestFunction::Sha256, &digest)
        .await
        .expect("read");

    assert_eq!(got.as_deref(), Some(&data[..]));
}

/// The one that matters most: BLAKE3 exercises the digest-function segment in
/// the resource name and proto value 9, neither of which SHA-256 touches.
#[tokio::test]
async fn blake3_blob_round_trip() {
    let (_server, mut client) = start_server().await;
    let data = bytes::Bytes::from_static(b"the quick brown fox");
    let digest = Digest::of(DigestFunction::Blake3, &data);

    client
        .write_blob(DigestFunction::Blake3, &digest, data.clone())
        .await
        .expect("write");
    let got = client
        .read_blob(DigestFunction::Blake3, &digest)
        .await
        .expect("read");

    assert_eq!(got.as_deref(), Some(&data[..]));
}

/// Real artifacts are 9-38 MB, so every one of them takes the multi-message
/// write path. Exercise it with a blob spanning several chunks.
#[tokio::test]
async fn large_blob_spans_multiple_write_chunks() {
    let (_server, mut client) = start_server().await;
    let data: Vec<u8> = (0..5 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
    let data = bytes::Bytes::from(data);
    let digest = Digest::of(DigestFunction::Sha256, &data);

    client
        .write_blob(DigestFunction::Sha256, &digest, data.clone())
        .await
        .expect("write");
    let got = client
        .read_blob(DigestFunction::Sha256, &digest)
        .await
        .expect("read")
        .expect("present");

    assert_eq!(got.len(), data.len());
    assert_eq!(got, data);
}

#[tokio::test]
async fn empty_blob_round_trip() {
    let (_server, mut client) = start_server().await;
    let data = bytes::Bytes::new();
    let digest = Digest::of(DigestFunction::Sha256, &data);

    client
        .write_blob(DigestFunction::Sha256, &digest, data)
        .await
        .expect("write");
    let got = client
        .read_blob(DigestFunction::Sha256, &digest)
        .await
        .expect("read");

    assert_eq!(got.as_deref(), Some(&b""[..]));
}

/// A miss must be `Ok(None)`, not an error — the whole optimistic-read design
/// rests on this.
#[tokio::test]
async fn absent_blob_reads_as_none() {
    let (_server, mut client) = start_server().await;
    let digest = Digest::of(DigestFunction::Sha256, b"never uploaded");

    let got = client
        .read_blob(DigestFunction::Sha256, &digest)
        .await
        .expect("read should not error on a miss");

    assert_eq!(got, None);
}

#[tokio::test]
async fn find_missing_distinguishes_present_from_absent() {
    let (_server, mut client) = start_server().await;
    let present = bytes::Bytes::from_static(b"present");
    let present_digest = Digest::of(DigestFunction::Sha256, &present);
    let absent_digest = Digest::of(DigestFunction::Sha256, b"absent");

    client
        .write_blob(DigestFunction::Sha256, &present_digest, present)
        .await
        .expect("write");

    let missing = client
        .find_missing(
            DigestFunction::Sha256,
            &[present_digest.clone(), absent_digest.clone()],
        )
        .await
        .expect("find_missing");

    assert_eq!(missing, vec![absent_digest]);
}

#[tokio::test]
async fn find_missing_of_nothing_makes_no_request() {
    let (_server, mut client) = start_server().await;
    assert!(
        client
            .find_missing(DigestFunction::Sha256, &[])
            .await
            .expect("find_missing")
            .is_empty()
    );
}

/// Both mappings `sync` writes: the bare URI, and the `checksum.sri` variant.
/// That the mapping then resolves through FetchBlob is the server's own
/// tested behaviour; what is checked here is that the requests this client
/// builds are well-formed enough to be accepted.
#[tokio::test]
async fn push_blob_records_bare_and_sri_mappings() {
    let (_server, mut client) = start_server().await;
    let data = bytes::Bytes::from_static(b"an artifact");
    let digest = Digest::of(DigestFunction::Sha256, &data);
    let uris = vec!["https://example.com/artifact.zst".to_string()];

    client
        .write_blob(DigestFunction::Sha256, &digest, data)
        .await
        .expect("write");

    client
        .push_blob(DigestFunction::Sha256, &digest, &uris, &[])
        .await
        .expect("push bare");

    let sri = digest.to_sri(DigestFunction::Sha256).expect("sha256 has sri");
    client
        .push_blob(
            DigestFunction::Sha256,
            &digest,
            &uris,
            &[("checksum.sri".to_string(), sri)],
        )
        .await
        .expect("push with checksum.sri");
}

/// Mapping a URI to content the server does not hold must fail, otherwise
/// `sync` could publish a dangling promise.
#[tokio::test]
async fn push_blob_for_absent_content_is_rejected() {
    let (_server, mut client) = start_server().await;
    let digest = Digest::of(DigestFunction::Sha256, b"never uploaded");

    let err = client
        .push_blob(
            DigestFunction::Sha256,
            &digest,
            &["https://example.com/nope".to_string()],
            &[],
        )
        .await
        .expect_err("push of an absent blob must fail");

    assert!(matches!(err, Error::Rpc { .. }), "unexpected error: {err}");
}

/// A caller that miscounts its own bytes should be caught before the wire.
#[tokio::test]
async fn write_blob_rejects_size_disagreement() {
    let (_server, mut client) = start_server().await;
    let data = bytes::Bytes::from_static(b"four");
    let mut digest = Digest::of(DigestFunction::Sha256, &data);
    digest.size = 99;

    let err = client
        .write_blob(DigestFunction::Sha256, &digest, data)
        .await
        .expect_err("size disagreement must be rejected");

    assert!(
        matches!(err, Error::SizeMismatch { .. }),
        "unexpected error: {err}"
    );
}

/// SHA-256 and BLAKE3 digests live in separate keyspaces, so writing under one
/// must not make the other appear present.
#[tokio::test]
async fn digest_functions_do_not_alias() {
    let (_server, mut client) = start_server().await;
    let data = bytes::Bytes::from_static(b"same bytes, two hashes");
    let sha = Digest::of(DigestFunction::Sha256, &data);
    let blake = Digest::of(DigestFunction::Blake3, &data);

    client
        .write_blob(DigestFunction::Sha256, &sha, data)
        .await
        .expect("write sha256");

    assert!(
        client
            .read_blob(DigestFunction::Blake3, &blake)
            .await
            .expect("read")
            .is_none()
    );
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

#[tokio::test]
async fn capabilities_report_the_digest_functions_the_server_accepts() {
    let (_server, mut client) = start_server().await;

    let caps = client.get_capabilities().await.expect("capabilities");

    // The server supports these three; the client can only transfer with two
    // of them, which is exactly why capabilities are reported as names rather
    // than as this crate's DigestFunction.
    assert!(caps.digest_functions.contains(&"SHA-256".to_string()));
    assert!(caps.digest_functions.contains(&"BLAKE3".to_string()));
    assert!(caps.max_batch_total_size_bytes > 0);
    assert!(caps.high_api_version.is_some());
}

// ---------------------------------------------------------------------------
// Batch / stream boundary
// ---------------------------------------------------------------------------

/// Blobs either side of the threshold take different wire paths and must be
/// indistinguishable to the caller — including how a miss is reported.
#[tokio::test]
async fn both_transfer_paths_round_trip_and_miss_alike() {
    let (_server, mut client) = start_server().await;

    for size in [
        BATCH_THRESHOLD as usize - 1,
        BATCH_THRESHOLD as usize,
        BATCH_THRESHOLD as usize + 1,
    ] {
        let data = bytes::Bytes::from(vec![b'x'; size]);
        let digest = Digest::of(DigestFunction::Sha256, &data);

        let absent = Digest::of(DigestFunction::Sha256, &vec![b'y'; size]);
        assert_eq!(
            client.read_blob(DigestFunction::Sha256, &absent).await.unwrap(),
            None,
            "a {size}-byte blob must miss as Ok(None)"
        );

        client
            .write_blob(DigestFunction::Sha256, &digest, data.clone())
            .await
            .unwrap_or_else(|e| panic!("write of {size} bytes: {e}"));
        let got = client
            .read_blob(DigestFunction::Sha256, &digest)
            .await
            .unwrap_or_else(|e| panic!("read of {size} bytes: {e}"));

        assert_eq!(got.as_ref().map(|b| b.len()), Some(size));
        assert_eq!(got, Some(data));
    }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/// Progress must reach the total on both paths, and the total must be the
/// digest's declared size from the very first callback.
#[tokio::test]
async fn progress_is_reported_for_uploads_and_downloads() {
    let (_server, mut client) = start_server().await;
    let data = bytes::Bytes::from(vec![b'z'; 5 * 1024 * 1024]);
    let digest = Digest::of(DigestFunction::Sha256, &data);
    let total = data.len() as u64;

    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = Arc::clone(&seen);
    let progress = Progress::new(move |done, total| recorder.lock().unwrap().push((done, total)));

    client
        .write_blob_with_progress(DigestFunction::Sha256, &digest, data.clone(), &progress)
        .await
        .expect("write");

    let uploads = std::mem::take(&mut *seen.lock().unwrap());
    assert!(uploads.len() > 1, "expected several updates, got {uploads:?}");
    assert!(uploads.iter().all(|(_, t)| *t == total));
    assert_eq!(uploads.last().unwrap().0, total);

    client
        .read_blob_with_progress(DigestFunction::Sha256, &digest, &progress)
        .await
        .expect("read");

    let downloads = seen.lock().unwrap().clone();
    assert!(downloads.len() > 1, "expected several updates");
    assert!(downloads.iter().all(|(_, t)| *t == total));
    assert_eq!(downloads.last().unwrap().0, total);
}

// ---------------------------------------------------------------------------
// Remote Asset fetch
// ---------------------------------------------------------------------------

/// The half of the asset contract `sync` depends on but could not previously
/// check: that a pushed mapping is actually resolvable afterwards.
#[tokio::test]
async fn a_pushed_mapping_resolves_through_fetch_blob() {
    let (_server, mut client) = start_server().await;
    let data = bytes::Bytes::from_static(b"an artifact");
    let digest = Digest::of(DigestFunction::Sha256, &data);
    let uris = vec!["https://example.com/artifact.zst".to_string()];

    client
        .write_blob(DigestFunction::Sha256, &digest, data)
        .await
        .expect("write");
    client
        .push_blob(DigestFunction::Sha256, &digest, &uris, &[])
        .await
        .expect("push");

    let fetched = client
        .fetch_blob(DigestFunction::Sha256, &uris, &[])
        .await
        .expect("fetch");

    assert_eq!(fetched.digest, digest);
    assert_eq!(fetched.uri, uris[0]);
}

/// Qualifiers are part of the asset key, which is why `sync` pushes twice.
/// A mapping pushed bare must not be found by a checksum-carrying fetch.
#[tokio::test]
async fn qualifiers_participate_in_the_asset_key() {
    let (_server, mut client) = start_server().await;
    let data = bytes::Bytes::from_static(b"qualified");
    let digest = Digest::of(DigestFunction::Sha256, &data);
    let uris = vec!["https://example.com/q".to_string()];
    let sri = vec![(
        "checksum.sri".to_string(),
        digest.to_sri(DigestFunction::Sha256).unwrap(),
    )];

    client
        .write_blob(DigestFunction::Sha256, &digest, data)
        .await
        .expect("write");
    client
        .push_blob(DigestFunction::Sha256, &digest, &uris, &[])
        .await
        .expect("push bare");

    // Bare key hits.
    assert_eq!(
        client
            .fetch_blob(DigestFunction::Sha256, &uris, &[])
            .await
            .expect("bare fetch")
            .digest,
        digest
    );

    // The SRI key is a different key, and nothing was pushed under it.
    // (The server may try the origin; example.com is not resolvable here, so
    // either way this must not report the blob as found.)
    match client.fetch_blob(DigestFunction::Sha256, &uris, &sri).await {
        Err(Error::AssetFetch { .. }) => {}
        Err(other) => panic!("unexpected error: {other}"),
        Ok(found) => panic!("SRI key should not have resolved, got {found:?}"),
    }

    // After pushing under the SRI key too, it resolves.
    client
        .push_blob(DigestFunction::Sha256, &digest, &uris, &sri)
        .await
        .expect("push sri");
    assert_eq!(
        client
            .fetch_blob(DigestFunction::Sha256, &uris, &sri)
            .await
            .expect("sri fetch")
            .digest,
        digest
    );
}

// ---------------------------------------------------------------------------
// Directory materialization
// ---------------------------------------------------------------------------

#[tokio::test]
async fn materialize_directory_writes_files_symlinks_and_subtrees() {
    use prost::Message as _;
    use protos::build::bazel::remote::execution::v2 as reapi;

    let (_server, mut client) = start_server().await;

    async fn put(client: &mut ReapiClient, data: &[u8]) -> Digest {
        let bytes = bytes::Bytes::copy_from_slice(data);
        let digest = Digest::of(DigestFunction::Sha256, &bytes);
        client
            .write_blob(DigestFunction::Sha256, &digest, bytes)
            .await
            .expect("write");
        digest
    }

    let plain = put(&mut client, b"plain contents").await;
    let script = put(&mut client, b"#!/bin/sh\ntrue\n").await;
    let nested = put(&mut client, b"nested contents").await;

    let to_node = |digest: &Digest| reapi::Digest {
        hash: digest.hash.clone(),
        size_bytes: digest.size,
    };

    let subdir = reapi::Directory {
        files: vec![reapi::FileNode {
            name: "nested.txt".to_string(),
            digest: Some(to_node(&nested)),
            is_executable: false,
            ..Default::default()
        }],
        ..Default::default()
    };
    let subdir_digest = put(&mut client, &subdir.encode_to_vec()).await;

    let root = reapi::Directory {
        files: vec![
            reapi::FileNode {
                name: "plain.txt".to_string(),
                digest: Some(to_node(&plain)),
                is_executable: false,
                ..Default::default()
            },
            reapi::FileNode {
                name: "run.sh".to_string(),
                digest: Some(to_node(&script)),
                is_executable: true,
                ..Default::default()
            },
        ],
        directories: vec![reapi::DirectoryNode {
            name: "sub".to_string(),
            digest: Some(to_node(&subdir_digest)),
        }],
        symlinks: vec![reapi::SymlinkNode {
            name: "link".to_string(),
            target: "plain.txt".to_string(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let root_digest = put(&mut client, &root.encode_to_vec()).await;

    let dest = tempfile::tempdir().expect("tempdir");
    client
        .materialize_directory(
            DigestFunction::Sha256,
            &root_digest,
            dest.path(),
            &Progress::none(),
        )
        .await
        .expect("materialize");

    let at = |name: &str| dest.path().join(name);
    assert_eq!(std::fs::read(at("plain.txt")).unwrap(), b"plain contents");
    assert_eq!(
        std::fs::read(at("sub/nested.txt")).unwrap(),
        b"nested contents"
    );
    assert_eq!(
        std::fs::read_link(at("link")).unwrap(),
        std::path::Path::new("plain.txt")
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: std::path::PathBuf| std::fs::metadata(p).unwrap().permissions().mode();
        assert_ne!(mode(at("run.sh")) & 0o111, 0, "run.sh should be executable");
        assert_eq!(
            mode(at("plain.txt")) & 0o111,
            0,
            "plain.txt should not be executable"
        );
    }
}
