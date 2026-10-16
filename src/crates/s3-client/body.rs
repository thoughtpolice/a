// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Resuming a `GetObject` body that breaks off partway.
//!
//! A dropped connection, or a server ending the body short of the length it
//! promised, fails the stream after the status line already said success.

use std::ops::Range;

use futures::StreamExt as _;

use crate::client::Client;
use crate::error::ErrorKind;
use crate::types::{ByteRange, ByteStream, GetObject};

/// What [`resumable`] needs to re-request the rest of a body.
struct Resume {
    client: Client,
    key: String,
    e_tag: String,
    version: Option<String>,
    /// The part of the requested range not yet delivered.
    remaining: Range<u64>,
    body: ByteStream,
    failures: usize,
}

/// `body`, the bytes in `range` of version `e_tag` of `key`, resumed after
/// each failure with a request for just the bytes not yet delivered.
///
/// The continuation carries `If-Match` on the original ETag, so it comes
/// from the same version. Consecutive failures without progress share the
/// client's attempt budget.
pub(crate) fn resumable(
    client: Client,
    key: String,
    e_tag: String,
    version: Option<String>,
    range: Range<u64>,
    body: ByteStream,
) -> ByteStream {
    let state = Resume {
        client,
        key,
        e_tag,
        version,
        remaining: range,
        body,
        failures: 0,
    };
    futures::stream::try_unfold(state, |mut state| async move {
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
                    let config = state.client.config();
                    if state.failures >= config.max_attempts {
                        return Err(error);
                    }
                    tracing::debug!(
                        key = %state.key,
                        %error,
                        remaining = ?state.remaining,
                        "resuming S3 response body",
                    );
                    tokio::time::sleep(config.backoff(state.failures)).await;
                    let options = GetObject {
                        range: Some(ByteRange::Bounded(state.remaining.clone())),
                        if_match: Some(state.e_tag.clone()),
                        version: state.version.clone(),
                        ..Default::default()
                    };
                    let continuation = state.client.get_or_head(&state.key, &options, false);
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
    .boxed()
}
