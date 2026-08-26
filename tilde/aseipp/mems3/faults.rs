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
//! completion can find that the upload has already been consumed.
//!
//! Points are bound during construction so misspelled configuration fails at
//! startup. Handles are cached here rather than looked up on every request.
//! Store clones share their injector, while independently constructed stores
//! have independent plans, counters, pauses, and BUGGIFY runs.

use std::str::FromStr;

use faultline::{Injector, Point};
use s3s::{S3Error, S3Result};

use crate::chaos::{Chaos, Sites, Visit};

#[derive(Debug)]
pub(crate) struct Boundary {
    point: Point<S3Fault>,
    sites: Sites,
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
        match fault {
            S3Fault::InternalError => s3s::s3_error!(InternalError, "injected by mems3 faultline"),
            S3Fault::SlowDown => s3s::s3_error!(SlowDown, "injected by mems3 faultline"),
            S3Fault::ServiceUnavailable => {
                s3s::s3_error!(ServiceUnavailable, "injected by mems3 faultline")
            }
            S3Fault::RequestTimeout => {
                s3s::s3_error!(RequestTimeout, "injected by mems3 faultline")
            }
            S3Fault::AccessDenied => s3s::s3_error!(AccessDenied, "injected by mems3 faultline"),
        }
    }
}

// Keep the discoverable names and their bound handles in one declaration.
macro_rules! fault_points {
    ($($field:ident => $name:literal),+ $(,)?) => {
        /// Every configurable failpoint, bound before the server accepts traffic.
        pub(crate) const POINT_NAMES: &[&str] = &[$($name),+];

        #[derive(Clone, Debug)]
        pub(crate) struct Faults {
            injector: Injector<S3Fault>,
            chaos: Option<Chaos>,
            $(pub(crate) $field: std::sync::Arc<Boundary>),+
        }

        impl Faults {
            pub(crate) fn new(injector: Injector<S3Fault>) -> Self {
                Self {
                    $($field: std::sync::Arc::new(Boundary {
                        point: injector.point($name),
                        sites: Sites {
                            boundary: $name,
                            error: concat!($name, ".auto.error"),
                            long_delay: concat!($name, ".auto.long_delay"),
                            short_delay: concat!($name, ".auto.short_delay"),
                            yield_now: concat!($name, ".auto.yield"),
                        },
                    })),+,
                    injector,
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

    pub(crate) fn injector(&self) -> &Injector<S3Fault> {
        &self.injector
    }

    /// Evaluate an operation's point, then the shared request BUGGIFY sites.
    ///
    /// BUGGIFY is disabled until the caller explicitly enables a run. Its
    /// named sites deliberately share activation and visit order across all
    /// operations: one site yields to another task, and the other returns
    /// SlowDown. The seed repeats probability decisions for a given visit
    /// order; it cannot reproduce concurrent request scheduling.
    pub(crate) async fn before(&self, boundary: &Boundary) -> S3Result<Option<Visit>> {
        faultline::fail_point_async!(&boundary.point, |fault: S3Fault| Err(fault.into()));
        if faultline::buggify!(self.injector, "s3.request.yield") {
            tokio::task::yield_now().await;
        }
        if faultline::buggify!(self.injector, "s3.request.slow_down") {
            return Err(S3Fault::SlowDown.into());
        }
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
}
