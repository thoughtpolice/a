// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Resuming a `GetObject` body that breaks off partway.
//!
//! A dropped connection, or a server ending the body short of the length it
//! promised, fails the stream after the status line already said success.

use std::ops::Range;

use futures::StreamExt as _;

use crate::client::Client;
use crate::error::{ErrorKind, Result};
use crate::presign::{PresignedClient, PresignedRequest};
use crate::transport::Transport;
use crate::types::{ByteRange, ByteStream, GetObject, GetObjectOutput};

/// Where a body's object can be read again.
pub(crate) enum Source {
    /// A key, read with the client's credentials.
    Object {
        client: Client,
        key: String,
        version: Option<String>,
    },
    /// A presigned `GetObject`, which a holder may send with any range.
    Presigned {
        client: PresignedClient,
        request: PresignedRequest,
    },
}

impl Source {
    fn transport(&self) -> &Transport {
        match self {
            Self::Object { client, .. } => client.transport(),
            Self::Presigned { client, .. } => client.transport(),
        }
    }

    /// The object, for logs.
    fn describe(&self) -> String {
        match self {
            Self::Object { key, .. } => key.clone(),
            Self::Presigned { request, .. } => request.display_url(),
        }
    }

    /// The bytes in `range` of the version whose ETag is `e_tag`.
    async fn read(&self, range: Range<u64>, e_tag: &str) -> Result<GetObjectOutput> {
        let mut options = GetObject {
            range: Some(ByteRange::Bounded(range)),
            if_match: Some(e_tag.to_string()),
            ..Default::default()
        };
        match self {
            Self::Object {
                client,
                key,
                version,
            } => {
                options.version = version.clone();
                client.get_or_head(key, &options, false).await
            }
            Self::Presigned { client, request } => client.get_once(request, &options).await,
        }
    }
}

/// What [`resumable`] needs to re-request the rest of a body.
struct Resume {
    source: Source,
    e_tag: String,
    /// The part of the requested range not yet delivered.
    remaining: Range<u64>,
    body: ByteStream,
    failures: usize,
}

/// `output`, its body resumed after each failure with a request through
/// `source` for just the bytes not yet delivered.
///
/// The continuation carries `If-Match` on the original ETag, so it comes
/// from the same version; a response without an ETag is left as it is.
/// Consecutive failures without progress share the client's attempt budget.
pub(crate) fn resumable(source: Source, mut output: GetObjectOutput) -> GetObjectOutput {
    let Some(e_tag) = output.info.e_tag.clone() else {
        return output;
    };
    let state = Resume {
        source,
        e_tag,
        remaining: output.range.clone(),
        body: output.body,
        failures: 0,
    };
    output.body = futures::stream::try_unfold(state, |mut state| async move {
        loop {
            match state.body.next().await {
                None => return Ok(None),
                Some(Ok(bytes)) => {
                    state.remaining.start += bytes.len() as u64;
                    state.failures = 0;
                    return Ok(Some((bytes, state)));
                }
                Some(Err(error)) => {
                    if state.remaining.is_empty() {
                        // Every promised byte arrived; only the end failed.
                        return Ok(None);
                    }
                    state.failures += 1;
                    let transport = state.source.transport();
                    if state.failures >= transport.max_attempts {
                        return Err(error);
                    }
                    tracing::debug!(
                        object = %state.source.describe(),
                        %error,
                        remaining = ?state.remaining,
                        "resuming S3 response body",
                    );
                    tokio::time::sleep(transport.backoff(state.failures)).await;
                    let continuation = state.source.read(state.remaining.clone(), &state.e_tag);
                    state.body = match continuation.await {
                        Ok(output) => output.body,
                        // The object changed since the body started, so its
                        // remaining bytes are gone and the read has failed.
                        Err(other) if other.kind() == ErrorKind::PreconditionFailed => {
                            return Err(error);
                        }
                        Err(other) => return Err(other),
                    };
                }
            }
        }
    })
    .boxed();
    output
}
