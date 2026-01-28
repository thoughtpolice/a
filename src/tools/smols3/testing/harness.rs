// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Test harness for HTTP interaction testing.

use std::sync::Arc;

use bytes::Bytes;
use http::{Request, Response};
use http_body_util::BodyExt;
use s3s::auth::SimpleAuth;
use s3s::service::{S3Service, S3ServiceBuilder};
use store::{SmolS3, Store};
use tower::Service;

/// Test harness wrapping an S3Service for HTTP-level testing.
///
/// The harness creates an S3Service from a Store implementation and allows
/// making HTTP requests directly without network I/O.
pub struct TestHarness {
    service: S3Service,
}

impl TestHarness {
    /// Create a new test harness with the given store.
    pub fn new<S: Store + 'static>(store: S) -> Self {
        Self::with_auth(store, None)
    }

    /// Create a new test harness with the given store and optional authentication.
    pub fn with_auth<S: Store + 'static>(store: S, auth: Option<SimpleAuth>) -> Self {
        let smol = SmolS3::new(Arc::new(store));
        let mut builder = S3ServiceBuilder::new(smol);
        if let Some(auth) = auth {
            builder.set_auth(auth);
        }
        let service = builder.build();
        Self { service }
    }

    /// Make an HTTP request and return the response.
    ///
    /// This calls the S3Service directly without any network I/O.
    pub async fn call(
        &self,
        req: Request<s3s::Body>,
    ) -> Response<s3s::Body> {
        let mut service = self.service.clone();
        service.call(req).await.expect("service call should not fail")
    }

    /// Make an HTTP request and collect the full response body.
    ///
    /// This is a convenience method that calls the service and collects
    /// the response body into bytes.
    pub async fn call_and_collect(
        &self,
        req: Request<s3s::Body>,
    ) -> (Response<()>, Bytes) {
        let resp = self.call(req).await;
        let (parts, body) = resp.into_parts();
        let body_bytes = body
            .collect()
            .await
            .expect("body collection should not fail")
            .to_bytes();
        (Response::from_parts(parts, ()), body_bytes)
    }
}
