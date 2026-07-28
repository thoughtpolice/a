// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Errors returned by [`ReapiClient`](crate::ReapiClient).

/// Errors produced while talking to an REAPI server.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The endpoint URL could not be parsed, or names a scheme this client
    /// cannot speak.
    #[error("invalid endpoint {url}: {reason}")]
    InvalidEndpoint { url: String, reason: String },

    /// The TCP/HTTP2 connection could not be established.
    #[error("failed to connect to {url}")]
    Connect {
        url: String,
        #[source]
        source: tonic::transport::Error,
    },

    /// An RPC failed. `NOT_FOUND` is *not* reported here for reads: those
    /// surface as `Ok(None)` so that a cache miss is not an error condition.
    #[error("{rpc} failed: {source}")]
    Rpc {
        rpc: &'static str,
        #[source]
        source: tonic::Status,
    },

    /// The server returned bytes whose digest does not match the one that was
    /// requested. This is an integrity failure, not a miss: it means the
    /// content-addressed store handed back content that is not what it was
    /// asked for.
    #[error(
        "digest mismatch reading {expected} ({function}): server returned content hashing to {actual}"
    )]
    DigestMismatch {
        function: crate::DigestFunction,
        expected: String,
        actual: String,
    },

    /// The server returned a blob whose length disagrees with the requested
    /// digest's `size_bytes`.
    #[error("size mismatch reading {expected}: expected {expected_size} bytes, got {actual_size}")]
    SizeMismatch {
        expected: String,
        expected_size: i64,
        actual_size: i64,
    },

    /// A digest was rejected before it reached the wire.
    #[error("invalid digest: {0}")]
    InvalidDigest(String),
}

/// Convenience alias for results from this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;
