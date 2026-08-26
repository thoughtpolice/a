// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fault boundaries owned by one in-memory S3 server.
//!
//! Every implemented operation visits a `before` point before reading a
//! streaming object body or acquiring a storage lock. An injected error leaves
//! storage untouched. Selected writes also visit `after_commit`, after making
//! their state visible and releasing the lock. An error at that boundary means
//! the client sees a failure even though the write succeeded: retrying a
//! conditional PUT can then fail its precondition, and retrying multipart
//! completion can find that the upload has already been consumed. A GetObject
//! response visits the `body` point before each chunk it streams, where a
//! fault ends the body short of the length the headers promised.
//!
//! Points are bound during construction so misspelled configuration fails at
//! startup. Handles are cached here rather than looked up on every request.
//! Store clones share their injectors, while independently constructed stores
//! have independent plans, counters, and pauses.

use std::io;
use std::str::FromStr;

use bytes::Bytes;
use faultline::{ConfigError, Injector, ParseError, Plan, Point};
use s3s::dto::StreamingBlob;
use s3s::{S3Error, S3ErrorCode, S3Result};

use crate::chaos::{BodySites, Chaos, Sites, Visit};

/// Streamed bodies are split into chunks of this size, and a body fault ends
/// the body between two chunks. It matches the block size a storage client
/// reads through range requests, so a cut can land inside a multi-block read.
pub(crate) const BODY_CHUNK_SIZE: usize = 4 * 1024;

/// The one point whose plans carry a [`BodyFault`] instead of an [`S3Fault`].
const GET_OBJECT_BODY: &str = "s3.get_object.body";

#[derive(Clone, Debug)]
pub(crate) struct Boundary {
    point: Point<S3Fault>,
    sites: Sites,
}

#[derive(Clone, Debug)]
struct BodyBoundary {
    point: Point<BodyFault>,
    sites: BodySites,
}

/// S3 protocol errors a fault plan can return to a client.
///
/// These preserve ordinary S3 status codes and XML error responses. For
/// example, `return(SlowDown)` exercises a client's retry handling through a
/// 503 response, and `return(AccessDenied)` exercises a non-retryable 403.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum S3Fault {
    InternalError,
    SlowDown,
    ServiceUnavailable,
    RequestTimeout,
    AccessDenied,
}

impl S3Fault {
    fn code(&self) -> S3ErrorCode {
        match self {
            Self::InternalError => S3ErrorCode::InternalError,
            Self::SlowDown => S3ErrorCode::SlowDown,
            Self::ServiceUnavailable => S3ErrorCode::ServiceUnavailable,
            Self::RequestTimeout => S3ErrorCode::RequestTimeout,
            Self::AccessDenied => S3ErrorCode::AccessDenied,
        }
    }
}

impl FromStr for S3Fault {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "" | "InternalError" => Ok(Self::InternalError),
            "SlowDown" => Ok(Self::SlowDown),
            "ServiceUnavailable" => Ok(Self::ServiceUnavailable),
            "RequestTimeout" => Ok(Self::RequestTimeout),
            "AccessDenied" => Ok(Self::AccessDenied),
            _ => Err(format!(
                "unknown S3 fault {value:?}; expected InternalError, SlowDown, \
                 ServiceUnavailable, RequestTimeout, or AccessDenied"
            )),
        }
    }
}

impl From<S3Fault> for S3Error {
    fn from(fault: S3Fault) -> Self {
        S3Error::with_message(fault.code(), "injected by chaos3 faultline")
    }
}

/// How a fault plan ends a streamed response body.
///
/// The headers have already been sent, so the client sees a successful status
/// and then a read that fails short of the promised length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BodyFault {
    Truncate,
}

impl FromStr for BodyFault {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "" | "truncate" => Ok(Self::Truncate),
            _ => Err(format!("unknown body fault {value:?}; expected truncate")),
        }
    }
}

/// A parsed plan for a named point, typed by the kind of point it targets.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum FaultPlan {
    Error(Plan<S3Fault>),
    Body(Plan<BodyFault>),
}

impl FaultPlan {
    /// Parse a plan for `name`, whose kind selects the payload type.
    pub(crate) fn parse(name: &str, plan: &str) -> Result<Self, ParseError> {
        if name == GET_OBJECT_BODY {
            plan.parse().map(Self::Body)
        } else {
            plan.parse().map(Self::Error)
        }
    }
}

// Keep the discoverable names and their bound handles in one declaration.
macro_rules! fault_points {
    ($($field:ident => $name:literal),+ $(,)?) => {
        /// Every configurable failpoint, bound before the server accepts traffic.
        pub(crate) const POINT_NAMES: &[&str] = &[$($name,)+ GET_OBJECT_BODY];

        #[derive(Clone, Debug)]
        pub(crate) struct Faults {
            injector: Injector<S3Fault>,
            bodies: Injector<BodyFault>,
            chaos: Option<Chaos>,
            get_object_body: BodyBoundary,
            $(pub(crate) $field: Boundary),+
        }

        impl Faults {
            pub(crate) fn new(injector: Injector<S3Fault>) -> Self {
                let bodies = Injector::with_seed(injector.seed());
                Self {
                    $($field: Boundary {
                        point: injector.point($name),
                        sites: Sites {
                            boundary: $name,
                            committed: $name.ends_with(".after_commit"),
                            error: concat!($name, ".auto.error"),
                            long_delay: concat!($name, ".auto.long_delay"),
                            short_delay: concat!($name, ".auto.short_delay"),
                            yield_now: concat!($name, ".auto.yield"),
                        },
                    }),+,
                    get_object_body: BodyBoundary {
                        point: bodies.point(GET_OBJECT_BODY),
                        sites: BodySites {
                            boundary: GET_OBJECT_BODY,
                            truncate: "s3.get_object.body.auto.truncate",
                            cut: "s3.get_object.body.auto.cut",
                        },
                    },
                    injector,
                    bodies,
                    chaos: None,
                }
            }
        }
    };
}

fault_points! {
    create_bucket_before => "s3.create_bucket.before",
    delete_bucket_before => "s3.delete_bucket.before",
    head_bucket_before => "s3.head_bucket.before",
    list_buckets_before => "s3.list_buckets.before",
    put_object_before => "s3.put_object.before",
    put_object_after_commit => "s3.put_object.after_commit",
    get_object_before => "s3.get_object.before",
    head_object_before => "s3.head_object.before",
    delete_object_before => "s3.delete_object.before",
    delete_object_after_commit => "s3.delete_object.after_commit",
    copy_object_before => "s3.copy_object.before",
    copy_object_after_commit => "s3.copy_object.after_commit",
    delete_objects_before => "s3.delete_objects.before",
    delete_objects_after_commit => "s3.delete_objects.after_commit",
    list_objects_v2_before => "s3.list_objects_v2.before",
    create_multipart_upload_before => "s3.create_multipart_upload.before",
    upload_part_before => "s3.upload_part.before",
    complete_multipart_upload_before => "s3.complete_multipart_upload.before",
    complete_multipart_upload_after_commit => "s3.complete_multipart_upload.after_commit",
    abort_multipart_upload_before => "s3.abort_multipart_upload.before",
}

impl Default for Faults {
    fn default() -> Self {
        Self::new(Injector::new())
    }
}

impl Faults {
    pub(crate) fn set_chaos(&mut self, chaos: Chaos) {
        self.chaos = Some(chaos);
    }

    /// The registry of error points, shared by clones of the store.
    pub(crate) fn injector(&self) -> &Injector<S3Fault> {
        &self.injector
    }

    /// The registry of body points, seeded like the error points.
    pub(crate) fn bodies(&self) -> &Injector<BodyFault> {
        &self.bodies
    }

    pub(crate) fn seed(&self) -> u64 {
        self.injector.seed()
    }

    /// Every bound point name in sorted order.
    pub(crate) fn points(&self) -> Vec<String> {
        let mut names = self.injector.points();
        names.extend(self.bodies.points());
        names.sort_unstable();
        names
    }

    /// Install a plan on the named point of the kind the plan was parsed for.
    pub(crate) fn configure(&self, name: &str, plan: FaultPlan) -> Result<(), ConfigError> {
        match plan {
            FaultPlan::Error(plan) => self.injector.configure(name, plan),
            FaultPlan::Body(plan) => self.bodies.configure(name, plan),
        }
    }

    /// Evaluate an operation's entry point, then admit the request to the
    /// campaign if one is attached.
    pub(crate) async fn before(&self, boundary: &Boundary) -> S3Result<Option<Visit>> {
        faultline::fail_point_async!(&boundary.point, |fault: S3Fault| Err(fault.into()));
        let visit = self.chaos.as_ref().map(Chaos::begin);
        if let Some(visit) = &visit {
            visit.hit(&boundary.sites).await?;
        }
        Ok(visit)
    }

    /// Visit a write's response boundary after its storage lock is released.
    pub(crate) async fn after_commit(
        &self,
        boundary: &Boundary,
        visit: Option<&Visit>,
    ) -> S3Result<()> {
        faultline::fail_point_async!(&boundary.point, |fault: S3Fault| Err(fault.into()));
        if let Some(visit) = visit {
            visit.hit(&boundary.sites).await?;
        }
        Ok(())
    }

    /// Stream a GetObject body, visiting the body point before every chunk.
    ///
    /// A returned fault, or the cut the campaign chose when the response
    /// started, ends the body early. The visit stays in flight until the
    /// client has taken the last chunk or dropped the response, so a campaign
    /// drains after its bodies.
    pub(crate) fn body(&self, bytes: Bytes, visit: Option<Visit>) -> StreamingBlob {
        let chunks = bytes.len().div_ceil(BODY_CHUNK_SIZE);
        let point = self.get_object_body.point.clone();
        let cut = visit
            .as_ref()
            .and_then(|visit| visit.truncation(&self.get_object_body.sites, chunks));
        let stream =
            futures::stream::unfold((bytes, 0, visit), move |(mut bytes, index, visit)| {
                let point = point.clone();
                async move {
                    if bytes.is_empty() {
                        return None;
                    }
                    if point.hit_async().await.is_break() || cut == Some(index) {
                        // A pending body makes the connection flush what it has
                        // buffered, so the client receives the headers and every
                        // earlier chunk before the cut.
                        tokio::task::yield_now().await;
                        let error = io::Error::other("body truncated by chaos3 faultline");
                        return Some((Err(error), (Bytes::new(), index, visit)));
                    }
                    let chunk = bytes.split_to(bytes.len().min(BODY_CHUNK_SIZE));
                    Some((Ok(chunk), (bytes, index + 1, visit)))
                }
            });
        StreamingBlob::wrap(stream)
    }
}
