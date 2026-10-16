// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The client's error type.

use reqwest::StatusCode;

/// What kind of failure an [`Error`] is, for callers that branch on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ErrorKind {
    /// The object, upload or bucket does not exist (404).
    NotFound,
    /// A conditional read found the object unchanged (304).
    NotModified,
    /// A write or read precondition did not hold (412). A conditional write
    /// whose `If-Match` object has vanished also reports this, though S3
    /// itself answers 404 there.
    PreconditionFailed,
    /// The service reported a conflicting concurrent operation (409).
    Conflict,
    /// The credentials lack permission (403).
    PermissionDenied,
    /// The request carried no valid credentials (401).
    Unauthenticated,
    /// Anything else, such as other statuses, transport failures, malformed
    /// responses and invalid arguments.
    Other,
}

impl ErrorKind {
    fn of_status(status: StatusCode) -> Self {
        match status {
            StatusCode::NOT_FOUND => Self::NotFound,
            StatusCode::NOT_MODIFIED => Self::NotModified,
            StatusCode::PRECONDITION_FAILED => Self::PreconditionFailed,
            StatusCode::CONFLICT => Self::Conflict,
            StatusCode::FORBIDDEN => Self::PermissionDenied,
            StatusCode::UNAUTHORIZED => Self::Unauthenticated,
            _ => Self::Other,
        }
    }
}

impl std::fmt::Display for ErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotFound => "not found",
            Self::NotModified => "not modified",
            Self::PreconditionFailed => "precondition failed",
            Self::Conflict => "conflict",
            Self::PermissionDenied => "permission denied",
            Self::Unauthenticated => "unauthenticated",
            Self::Other => "error",
        })
    }
}

/// A failed S3 request.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The service answered with a non-success status, after any retries.
    #[error("HTTP {status} from {url}: {body}")]
    Status {
        kind: ErrorKind,
        status: StatusCode,
        url: String,
        /// The start of the response body, usually an S3 XML error.
        body: String,
    },
    /// The request never got a response, after any retries.
    #[error("request to {url} failed after {attempts} attempt(s): {source}")]
    Transport {
        url: String,
        attempts: usize,
        source: reqwest::Error,
    },
    /// A response body broke off and could not be resumed.
    #[error("reading the response body from {url} failed: {source}")]
    Body { url: String, source: reqwest::Error },
    /// The response was not what S3 promises, or the request could not be
    /// built from the arguments.
    #[error("{message}")]
    Invalid {
        message: String,
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
}

impl Error {
    pub(crate) fn status(status: StatusCode, url: String, body: String) -> Self {
        Self::Status {
            kind: ErrorKind::of_status(status),
            status,
            url,
            body,
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
            source: None,
        }
    }

    pub(crate) fn invalid_from(
        message: impl Into<String>,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self::Invalid {
            message: message.into(),
            source: Some(Box::new(source)),
        }
    }

    /// What kind of failure this is.
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Status { kind, .. } => *kind,
            _ => ErrorKind::Other,
        }
    }

    /// The HTTP status the service answered with, if it answered.
    pub fn http_status(&self) -> Option<StatusCode> {
        match self {
            Self::Status { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// The same error reported as `kind`, keeping the status it came with.
    pub(crate) fn with_kind(mut self, new: ErrorKind) -> Self {
        if let Self::Status { kind, .. } = &mut self {
            *kind = new;
        }
        self
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
