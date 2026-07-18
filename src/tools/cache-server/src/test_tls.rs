// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The TLS config loader against the committed test certificate pair.

use std::path::{Path, PathBuf};

use crate::tls;

fn fixture(name: &str) -> PathBuf {
    buck_resources::get(format!("src/tools/cache-server/{name}")).expect("test fixture")
}

#[test]
fn loads_committed_test_pair() {
    let config = tls::load_server_config(&fixture("cert.pem"), &fixture("key.pem"))
        .expect("load server config");
    assert_eq!(
        config.alpn_protocols,
        vec![b"h2".to_vec(), b"http/1.1".to_vec()]
    );
}

#[test]
fn missing_cert_file_is_an_error() {
    let err = tls::load_server_config(Path::new("/nonexistent/cert.pem"), &fixture("key.pem"))
        .expect_err("missing certificate must fail");
    assert!(err.to_string().contains("certificate"), "{err:#}");
}

#[test]
fn key_handed_over_as_certificate_is_an_error() {
    let err = tls::load_server_config(&fixture("key.pem"), &fixture("key.pem"))
        .expect_err("a private key is not a certificate chain");
    assert!(format!("{err:#}").contains("no certificates"), "{err:#}");
}
