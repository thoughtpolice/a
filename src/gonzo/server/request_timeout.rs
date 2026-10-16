// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Tower layer bounding how long a request may take to produce its
//! response, by route.
//!
//! Remote Asset fetches clone repositories and download archives, which
//! takes minutes; every other RPC is bounded far tighter, except for
//! `Execute` and `WaitExecution`, which last as long as the action runs
//! (its own timeout bounds it). A request out of time is answered
//! `DEADLINE_EXCEEDED`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

/// Time limits per route; `None` is no limit.
#[derive(Clone, Copy, Debug)]
pub struct RequestTimeouts {
    /// For every RPC but Remote Asset fetches and executions.
    pub default: Option<Duration>,
    /// For the Remote Asset `Fetch` service.
    pub fetch: Option<Duration>,
}

/// Tower service applying [`RequestTimeouts`] to `inner`.
#[derive(Clone)]
pub struct RequestTimeout<S> {
    inner: S,
    timeouts: RequestTimeouts,
    /// Path prefix of the Fetch service's methods: `/<service name>/`.
    fetch_prefix: Arc<str>,
    /// Path prefix of the Execution service's methods.
    execution_prefix: Arc<str>,
}

impl<S> RequestTimeout<S> {
    pub fn new(inner: S, timeouts: RequestTimeouts) -> Self {
        use tonic::server::NamedService as _;
        type Fetch =
            protos::build::bazel::remote::asset::v1::fetch_server::FetchServer<api::FetchService>;
        type Execution =
            protos::build::bazel::remote::execution::v2::execution_server::ExecutionServer<
                scheduler::ExecutionService,
            >;
        Self {
            inner,
            timeouts,
            fetch_prefix: format!("/{}/", Fetch::NAME).into(),
            execution_prefix: format!("/{}/", Execution::NAME).into(),
        }
    }

    fn limit(&self, path: &str) -> Option<Duration> {
        if path.starts_with(&*self.fetch_prefix) {
            self.timeouts.fetch
        } else if path.starts_with(&*self.execution_prefix) {
            None
        } else {
            self.timeouts.default
        }
    }
}

impl<S, ReqBody, ResBody> tower::Service<hyper::Request<ReqBody>> for RequestTimeout<S>
where
    S: tower::Service<hyper::Request<ReqBody>, Response = hyper::Response<ResBody>>,
    S::Future: Send + 'static,
    ResBody: Default + Send + 'static,
{
    type Response = hyper::Response<ResBody>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: hyper::Request<ReqBody>) -> Self::Future {
        let limit = self.limit(req.uri().path());
        let response = self.inner.call(req);
        let Some(limit) = limit else {
            return Box::pin(response);
        };
        Box::pin(async move {
            match tokio::time::timeout(limit, response).await {
                Ok(response) => response,
                // A headers-only gRPC response, as tonic itself sends for a
                // status without a message body.
                Err(_) => Ok(hyper::Response::builder()
                    .status(200)
                    .header("content-type", "application/grpc")
                    .header("grpc-status", "4") // DEADLINE_EXCEEDED
                    .header(
                        "grpc-message",
                        format!("request exceeded the server's {}s limit", limit.as_secs()),
                    )
                    .body(ResBody::default())
                    .expect("static response parts are valid")),
            }
        })
    }
}
