// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The HTTP protocol between clients and the broker.
//!
//! Every request is a `POST` of a JSON body to `/v1/<operation>`. The
//! broker answers only after the queue file holding the result is durable:
//!
//! | Status | Body | Meaning |
//! |--------|------|---------|
//! | 200 | the operation's response | Done and durable |
//! | 409 | [`ErrorBody`] | The job is no longer held by this claim |
//! | 421 | [`ErrorBody`] with `broker` | This broker is not, or no longer, the broker |
//! | 503 | [`ErrorBody`] | Object storage failed; retry the same request |
//!
//! Every operation is safe to retry with the same body. Pushes carry the
//! job ID and claims carry the claim token, both chosen by the client, so
//! the broker recognizes a request whose first attempt took effect.

use serde::{Deserialize, Serialize};

/// Which broker a queue file names, and where to reach it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BrokerInfo {
    /// Unique per broker process, so a broker restarted on the same address
    /// is a different broker.
    pub id: String,
    /// The base URL clients send requests to, such as `http://10.0.0.5:7070`.
    pub addr: String,
}

/// A job a worker holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimedJob {
    pub id: String,
    pub payload: String,
    /// The claim's token, which heartbeats and completion must present.
    pub token: String,
    /// How many times workers have claimed the job, this claim included. More
    /// than one means an earlier worker stopped heartbeating, and may have
    /// done some or all of the work.
    pub attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushRequest {
    pub id: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimRequest {
    pub worker: String,
    pub token: String,
    /// How long the broker may hold the request open waiting for a job.
    #[serde(default)]
    pub wait_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimResponse {
    pub job: Option<ClaimedJob>,
}

/// The body of a heartbeat or completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobRequest {
    pub id: String,
    pub token: String,
}

/// The body of every non-200 response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub error: String,
    /// For a 421, the broker the file names now, if this broker knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub broker: Option<BrokerInfo>,
}
