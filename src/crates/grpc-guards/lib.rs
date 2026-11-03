// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Tower layers that guard a gRPC server (tonic over hyper) by answering
//! for it: [`RequestTimeout`] bounds how long each route may take to
//! answer, and [`Shed`] turns requests away while the server is
//! overloaded. Both answer with a headers-only gRPC status
//! ([`status_response`]) rather than an HTTP error, so clients see an
//! ordinary gRPC failure they know how to retry.

mod shed;
mod timeout;

pub use shed::{Shed, ShedLayer};
pub use timeout::{RequestTimeout, RequestTimeouts};

/// A headers-only gRPC response carrying `code` and `message`, as tonic
/// itself sends for a status without a message body ("Trailers-Only").
///
/// `message` goes into a header as is: keep it to printable ASCII.
pub fn status_response<B: Default>(code: tonic::Code, message: &str) -> hyper::Response<B> {
    hyper::Response::builder()
        .status(200)
        .header("content-type", "application/grpc")
        .header("grpc-status", (code as i32).to_string())
        .header("grpc-message", message)
        .body(B::default())
        .expect("a printable message makes a valid response")
}

#[cfg(test)]
mod tests;
