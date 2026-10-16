// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A FIFO job queue kept in a single object on S3.
//!
//! This follows the brokered, highly available design in turbopuffer's
//! [post on queues in object storage][post]. The whole
//! queue is one JSON object. Object storage gives it durability, and
//! conditional writes (`If-Match` on the ETag) make every change a
//! compare-and-set, so concurrent writers cannot lose each other's changes.
//!
//! Having every client compare-and-set the object directly works, but one
//! object takes a write at a time, and each write takes a round trip to
//! storage, so contention caps the whole queue at a few operations per
//! second. Instead one process, the broker, does all the writing:
//!
//! - **Group commit.** Requests that arrive while a write is in flight are
//!   applied together in the next write, so throughput no longer depends on
//!   write latency. See [`broker`].
//! - **Acknowledged after commit.** The broker answers a request only after
//!   the write holding its effect has succeeded, so an answered push is
//!   durable.
//! - **Broker failover.** The file names the broker. A client whose
//!   request to the broker times out reads the file, and if the same
//!   broker is still named, starts a broker on its own node, which takes
//!   over by writing itself into the file. The broker holds nothing the
//!   file does not, so moving it is cheap. If the old broker was only slow,
//!   its next compare-and-set fails, it rereads the file, finds itself
//!   replaced, and stops, sending its clients on to the new one.
//! - **Heartbeats.** A claimed job carries the worker's latest heartbeat.
//!   A claim that misses heartbeats for a whole lease lapses, and the next
//!   worker to claim gets the job. Jobs are therefore delivered at least
//!   once.
//!
//! Each operation is safe to retry. Pushes carry an ID and claims a token,
//! both chosen by the client, and the file remembers recently completed
//! job IDs, so a retry whose first attempt took effect is recognized rather
//! than applied twice. Heartbeats and completions present the claim's
//! token, which fences off a worker whose claim lapsed. That worker hears
//! it lost the job, even after another worker finishes it.
//!
//! The queue file looks like this:
//!
//! ```json
//! {
//!   "version": 1,
//!   "broker": {"id": "6f1c...", "addr": "http://10.0.0.5:7070"},
//!   "jobs": [
//!     {"id": "a1", "payload": "index ns=42", "pushed_at": 1760000000000,
//!      "attempts": 1, "claim": {"token": "c9...", "worker": "node-2",
//!      "claimed_at": 1760000001000, "heartbeat_at": 1760000004000}},
//!     {"id": "a2", "payload": "index ns=7", "pushed_at": 1760000000500,
//!      "attempts": 0, "claim": null}
//!   ],
//!   "done": [{"id": "a0", "token": "51..."}]
//! }
//! ```
//!
//! The whole file is read and written for every batch, so it suits queues
//! of thousands of small jobs, not millions of large ones.
//!
//! [post]: https://turbopuffer.com/blog/object-storage-queue
//!
//! ```no_run
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! use std::sync::Arc;
//! use std::time::Duration;
//!
//! use s3_queue::{HostConfig, Queue, QueueConfig, S3QueueStore};
//!
//! let client = s3_client::ClientBuilder::from_env().with_bucket("jobs").build()?;
//! let store = Arc::new(S3QueueStore::new(client, "indexing/queue.json"));
//! let queue = Queue::new(store, QueueConfig {
//!     host: Some(HostConfig {
//!         listen: "10.0.0.5:7070".parse()?,
//!         advertise: None,
//!         broker: Default::default(),
//!     }),
//!     ..Default::default()
//! });
//!
//! queue.push("index ns=42").await?;
//! if let Some(job) = queue.claim("node-2", Duration::from_secs(10)).await? {
//!     queue.run(&job, async { /* do the work */ }).await?;
//! }
//! # Ok(())
//! # }
//! ```

pub mod broker;
mod client;
pub mod protocol;
pub mod state;
mod store;

pub use crate::broker::{BrokerConfig, BrokerHandle, BrokerStats, StartError};
pub use crate::client::{Error, HostConfig, Queue, QueueConfig, Result};
pub use crate::protocol::{BrokerInfo, ClaimedJob};
pub use crate::state::QueueState;
pub use crate::store::{Changed, MemoryStore, S3QueueStore, Store, StoreError, Versioned};

#[cfg(test)]
mod test_queue;

#[cfg(test_module_chaos3)]
mod test_chaos3;
