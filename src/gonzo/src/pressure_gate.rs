// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Tower layer that sheds load when cgroup memory pressure is high.
//!
//! When the [`PressureMonitor`](runtime::psi::PressureMonitor) reports
//! memory pressure at or above a configurable threshold, incoming
//! requests are rejected immediately with gRPC status `UNAVAILABLE`.
//! This prevents the process from being OOM-killed under sustained
//! memory contention, and signals clients to retry with backoff.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use runtime::psi::{PressureLevel, PressureMonitor};

/// Tower [`Layer`](tower::Layer) that wraps a service with
/// pressure-aware load shedding.
#[derive(Clone)]
pub struct PressureGateLayer {
    monitor: PressureMonitor,
    threshold: PressureLevel,
}

impl PressureGateLayer {
    /// Create a new layer that rejects requests when memory pressure
    /// reaches `threshold` or above.
    pub fn new(monitor: PressureMonitor, threshold: PressureLevel) -> Self {
        Self { monitor, threshold }
    }
}

impl<S> tower::Layer<S> for PressureGateLayer {
    type Service = PressureGate<S>;

    fn layer(&self, inner: S) -> Self::Service {
        PressureGate {
            inner,
            monitor: self.monitor.clone(),
            threshold: self.threshold,
        }
    }
}

/// Tower service that gates requests on cgroup memory pressure.
#[derive(Clone)]
pub struct PressureGate<S> {
    inner: S,
    monitor: PressureMonitor,
    threshold: PressureLevel,
}

impl<S, ReqBody, ResBody> tower::Service<hyper::Request<ReqBody>> for PressureGate<S>
where
    S: tower::Service<hyper::Request<ReqBody>, Response = hyper::Response<ResBody>>,
    S::Future: Send + 'static,
    S::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    ResBody: Default + Send + 'static,
{
    type Response = hyper::Response<ResBody>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: hyper::Request<ReqBody>) -> Self::Future {
        let state = self.monitor.current();
        if state.memory >= self.threshold {
            tracing::warn!(
                memory = %state.memory,
                path = req.uri().path(),
                "rejecting request due to memory pressure"
            );

            // Return an HTTP response with gRPC UNAVAILABLE status.
            // gRPC status is conveyed via trailers, but for immediate
            // rejection we use the headers-only short-circuit that
            // tonic and grpc-go both understand.
            let resp = hyper::Response::builder()
                .status(200)
                .header("content-type", "application/grpc")
                .header("grpc-status", "14") // UNAVAILABLE
                .header("grpc-message", "server under memory pressure, retry later")
                .body(ResBody::default())
                .unwrap();
            Box::pin(async move { Ok(resp) })
        } else {
            let fut = self.inner.call(req);
            Box::pin(fut)
        }
    }
}
