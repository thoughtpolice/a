// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Bounding how long a request may take to produce its response, by
//! route.
//!
//! Some RPCs take minutes (a Remote Asset fetch cloning a repository, say)
//! where every other RPC is bounded far tighter. A request out of time is
//! answered `DEADLINE_EXCEEDED`.
//!
//! The limit covers the time until a response starts. A streaming
//! response, once started, goes on as long as it needs: REAPI's `Execute`
//! answers at once with a stream of the operation's stages, which lasts as
//! long as the action runs (its own timeout bounds it).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

/// Time limits by route: the first route whose path prefix a request's
/// path starts with sets its limit, else the default does. `None` is no
/// limit.
#[derive(Clone, Debug, Default)]
pub struct RequestTimeouts {
    default: Option<Duration>,
    routes: Arc<[(Arc<str>, Option<Duration>)]>,
}

impl RequestTimeouts {
    /// `default` for every route.
    pub fn new(default: Option<Duration>) -> Self {
        Self {
            default,
            routes: Arc::new([]),
        }
    }

    /// `limit` for requests whose path starts with `prefix`.
    pub fn route(mut self, prefix: impl Into<Arc<str>>, limit: Option<Duration>) -> Self {
        let mut routes = self.routes.to_vec();
        routes.push((prefix.into(), limit));
        self.routes = routes.into();
        self
    }

    /// `limit` for every method of the tonic service `S`.
    pub fn service<S: tonic::server::NamedService>(self, limit: Option<Duration>) -> Self {
        self.route(format!("/{}/", S::NAME), limit)
    }

    /// The limit on a request for `path`.
    pub fn limit(&self, path: &str) -> Option<Duration> {
        self.routes
            .iter()
            .find(|(prefix, _)| path.starts_with(&**prefix))
            .map_or(self.default, |(_, limit)| *limit)
    }
}

/// Tower service applying [`RequestTimeouts`] to `inner`.
#[derive(Clone)]
pub struct RequestTimeout<S> {
    inner: S,
    timeouts: RequestTimeouts,
}

impl<S> RequestTimeout<S> {
    pub fn new(inner: S, timeouts: RequestTimeouts) -> Self {
        Self { inner, timeouts }
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
        let limit = self.timeouts.limit(req.uri().path());
        let response = self.inner.call(req);
        let Some(limit) = limit else {
            return Box::pin(response);
        };
        Box::pin(async move {
            match tokio::time::timeout(limit, response).await {
                Ok(response) => response,
                Err(_) => Ok(crate::status_response(
                    tonic::Code::DeadlineExceeded,
                    &format!("request exceeded the server's {}s limit", limit.as_secs()),
                )),
            }
        })
    }
}
