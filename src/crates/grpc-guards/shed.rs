// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Shedding load: turning requests away at once, `UNAVAILABLE`, while the
//! server says it is overloaded (under memory pressure, say), rather than
//! taking on work that could get it killed. Clients retry with backoff.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

/// Why to shed a request, if one should be: `None` admits it.
type Overloaded = dyn Fn() -> Option<String> + Send + Sync;

/// Tower [`Layer`](tower::Layer) shedding requests while `overloaded`
/// gives a reason to.
#[derive(Clone)]
pub struct ShedLayer {
    overloaded: Arc<Overloaded>,
    message: Arc<str>,
}

impl ShedLayer {
    /// Shed requests, answering `message`, whenever `overloaded` says why
    /// (which is logged); admit them when it says `None`. It is asked once
    /// per request, so it should be cheap: a look at state some monitor
    /// keeps.
    pub fn new(
        overloaded: impl Fn() -> Option<String> + Send + Sync + 'static,
        message: impl Into<Arc<str>>,
    ) -> Self {
        Self {
            overloaded: Arc::new(overloaded),
            message: message.into(),
        }
    }
}

impl<S> tower::Layer<S> for ShedLayer {
    type Service = Shed<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Shed {
            inner,
            layer: self.clone(),
        }
    }
}

/// Tower service shedding requests as its [`ShedLayer`] says.
#[derive(Clone)]
pub struct Shed<S> {
    inner: S,
    layer: ShedLayer,
}

impl<S, ReqBody, ResBody> tower::Service<hyper::Request<ReqBody>> for Shed<S>
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
        match (self.layer.overloaded)() {
            None => Box::pin(self.inner.call(req)),
            Some(reason) => {
                tracing::warn!(%reason, path = req.uri().path(), "shedding a request");
                let response =
                    crate::status_response(tonic::Code::Unavailable, &self.layer.message);
                Box::pin(async move { Ok(response) })
            }
        }
    }
}
