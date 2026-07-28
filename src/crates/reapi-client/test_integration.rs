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
use std::time::{Duration, Instant};

use crate::{ConnectOptions, Digest, DigestFunction, Error, ReapiClient};

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
