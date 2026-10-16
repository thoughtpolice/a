// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Pushers and workers, and how they find a broker.
//!
//! A [`Queue`] reads the broker's address from the queue file and sends it
//! requests. When a request to the broker times out or cannot connect, the
//! client reads the file again. If the file still names the same broker,
//! and this node may host one, it starts a broker of its own, which takes
//! over by writing its address into the file. Any node can become the
//! broker this way, and since a broker holds nothing the file does not,
//! moving it loses nothing.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::StatusCode;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::net::TcpListener;
use tokio::time::Instant;

use crate::broker::{self, BrokerConfig, BrokerHandle, StartError};
use crate::protocol::{
    BrokerInfo, ClaimRequest, ClaimResponse, ClaimedJob, ErrorBody, JobRequest, PushRequest,
};
use crate::state::QueueState;
use crate::store::{Store, StoreError};

/// A failed queue operation.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The claim no longer holds the job. Its lease ran out and another
    /// worker may have it, so stop working on it.
    #[error("the claim on job {0} was lost")]
    Lost(String),
    /// No broker answered before the operation's deadline.
    #[error("no broker answered within {after:?}; last error: {last}")]
    Timeout { after: Duration, last: String },
    #[error("could not read the queue file: {0}")]
    Store(#[from] StoreError),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Where a node listens when it hosts the broker.
#[derive(Debug, Clone)]
pub struct HostConfig {
    pub listen: SocketAddr,
    /// The base URL others reach `listen` at. Defaults to `http://` and the
    /// bound address, which suits a specific interface address but not
    /// `0.0.0.0`.
    pub advertise: Option<String>,
    pub broker: BrokerConfig,
}

/// Client settings.
#[derive(Debug, Clone)]
pub struct QueueConfig {
    /// How long a request to the broker may take before this client gives
    /// up on that broker and fails over. A claim's wait comes on top.
    /// Defaults to 5 seconds.
    pub request_timeout: Duration,
    /// How long an operation keeps trying, through failovers and storage
    /// errors, before it fails. Defaults to 60 seconds.
    pub operation_timeout: Duration,
    /// The first delay between attempts, doubling up to 1 second. Defaults
    /// to 25 milliseconds.
    pub retry_backoff: Duration,
    /// How often [`Queue::run`] heartbeats a job. Keep it well under the
    /// broker's lease. Defaults to 3 seconds.
    pub heartbeat_interval: Duration,
    /// Host a broker on this node when none answers. `None` leaves that to
    /// other nodes.
    pub host: Option<HostConfig>,
}

impl Default for QueueConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(5),
            operation_timeout: Duration::from_secs(60),
            retry_backoff: Duration::from_millis(25),
            heartbeat_interval: Duration::from_secs(3),
            host: None,
        }
    }
}

/// A handle on one queue, for pushing jobs and for working on them.
/// Cloning it is cheap, and clones share the broker connection.
#[derive(Clone)]
pub struct Queue {
    inner: Arc<Inner>,
}

struct Inner {
    store: Arc<dyn Store>,
    config: QueueConfig,
    http: reqwest::Client,
    /// The broker requests go to, once known.
    broker: Mutex<Option<BrokerInfo>>,
    /// The broker this node hosts, if any. The lock also keeps this node to
    /// one failover at a time.
    local: tokio::sync::Mutex<Option<BrokerHandle>>,
}

impl std::fmt::Debug for Queue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Queue")
            .field("broker", &self.cached_broker())
            .finish_non_exhaustive()
    }
}

/// What one attempt at a request came to.
enum Attempt<T> {
    Done(T),
    Lost,
    /// The broker answered that it is not the broker, naming its successor
    /// if it knows one.
    Moved(Option<BrokerInfo>),
    /// The broker answered, but could not do it right now.
    Retry(String),
    /// The broker did not answer.
    Unreachable(String),
}

impl Queue {
    pub fn new(store: Arc<dyn Store>, config: QueueConfig) -> Self {
        let http = reqwest::Client::builder()
            .http1_only()
            .connect_timeout(Duration::from_secs(2))
            .build()
            .expect("the HTTP client configuration is valid");
        Self {
            inner: Arc::new(Inner {
                store,
                config,
                http,
                broker: Mutex::new(None),
                local: tokio::sync::Mutex::new(None),
            }),
        }
    }

    /// Add a job with a fresh ID, returning the ID once the job is durable.
    pub async fn push(&self, payload: impl Into<String>) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.push_with_id(&id, payload).await?;
        Ok(id)
    }

    /// Add a job with the given ID, returning once it is durable. Pushing
    /// an ID already queued, or recently completed, does nothing.
    pub async fn push_with_id(&self, id: &str, payload: impl Into<String>) -> Result<()> {
        let request = PushRequest {
            id: id.to_string(),
            payload: payload.into(),
        };
        let _: serde_json::Value = self.call("/v1/push", &request, Duration::ZERO, id).await?;
        Ok(())
    }

    /// Claim the oldest job nobody holds, waiting up to `wait` for one.
    ///
    /// The claim lasts as long as `heartbeat` keeps renewing it. If its
    /// lease runs out, another worker can claim the job, so jobs run at
    /// least once.
    pub async fn claim(&self, worker: &str, wait: Duration) -> Result<Option<ClaimedJob>> {
        let request = ClaimRequest {
            worker: worker.to_string(),
            token: uuid::Uuid::new_v4().to_string(),
            wait_ms: wait.as_millis() as u64,
        };
        let response: ClaimResponse = self.call("/v1/claim", &request, wait, "").await?;
        Ok(response.job)
    }

    /// Renew the lease on `job`. Fails with [`Error::Lost`] if the claim no
    /// longer holds it.
    pub async fn heartbeat(&self, job: &ClaimedJob) -> Result<()> {
        let _: serde_json::Value = self
            .call("/v1/heartbeat", &job_request(job), Duration::ZERO, &job.id)
            .await?;
        Ok(())
    }

    /// Finish `job`, removing it from the queue. Fails with [`Error::Lost`]
    /// if the claim no longer holds it.
    pub async fn complete(&self, job: &ClaimedJob) -> Result<()> {
        let _: serde_json::Value = self
            .call("/v1/complete", &job_request(job), Duration::ZERO, &job.id)
            .await?;
        Ok(())
    }

    /// Run `work` on a claimed job, heartbeating while it runs and
    /// completing the job when it finishes.
    ///
    /// If a heartbeat finds the claim lost, `work` is dropped and the
    /// result is [`Error::Lost`]. A heartbeat that fails for any other
    /// reason is tried again at the next interval; the lease, not this
    /// client, decides when the claim lapses.
    pub async fn run<T>(&self, job: &ClaimedJob, work: impl Future<Output = T>) -> Result<T> {
        let heartbeats = async {
            let mut ticks = tokio::time::interval(self.inner.config.heartbeat_interval);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticks.tick().await;
            loop {
                ticks.tick().await;
                match self.heartbeat(job).await {
                    Ok(()) => {}
                    Err(Error::Lost(id)) => return Error::Lost(id),
                    Err(error) => tracing::warn!(job = %job.id, %error, "heartbeat failed"),
                }
            }
        };
        tokio::select! {
            output = work => {
                self.complete(job).await?;
                Ok(output)
            }
            error = heartbeats => Err(error),
        }
    }

    /// The queue file as it is now, read straight from storage.
    pub async fn state(&self) -> Result<Option<QueueState>> {
        Ok(self.inner.store.load().await?.map(|v| v.state))
    }

    /// The broker this client last talked to or learned of.
    pub fn cached_broker(&self) -> Option<BrokerInfo> {
        self.inner.broker.lock().expect("broker lock").clone()
    }

    /// The broker this node hosts, if it hosts one that is still running.
    pub async fn local_broker(&self) -> Option<BrokerInfo> {
        let local = self.inner.local.lock().await;
        local
            .as_ref()
            .filter(|handle| handle.is_running())
            .map(|handle| handle.info().clone())
    }

    /// Counters from the broker this node hosts, if any.
    pub async fn local_broker_stats(&self) -> Option<broker::BrokerStats> {
        self.inner
            .local
            .lock()
            .await
            .as_ref()
            .map(BrokerHandle::stats)
    }

    /// Stop the broker this node hosts, if any, the way a crash would.
    /// Returns whether there was one.
    pub async fn abort_local_broker(&self) -> bool {
        match self.inner.local.lock().await.take() {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    }

    fn set_broker(&self, broker: Option<BrokerInfo>) {
        *self.inner.broker.lock().expect("broker lock") = broker;
    }

    /// Send `body` to `path` on the broker until it answers, failing over
    /// as needed. `wait` is how long the broker may hold the request.
    async fn call<B: Serialize, R: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
        wait: Duration,
        job: &str,
    ) -> Result<R> {
        let config = &self.inner.config;
        let started = Instant::now();
        let deadline = started + config.operation_timeout + wait;
        let mut failures = 0u32;
        let mut last = String::from("no attempt finished");
        loop {
            let now = Instant::now();
            let backoff = match failures {
                0 => Duration::ZERO,
                n => config
                    .retry_backoff
                    .saturating_mul(1 << n.min(6))
                    .min(Duration::from_secs(1)),
            };
            if now + backoff >= deadline {
                return Err(Error::Timeout {
                    after: started.elapsed(),
                    last,
                });
            }
            tokio::time::sleep(backoff).await;
            failures += 1;

            let broker = match self.find_broker().await {
                Ok(Some(broker)) => broker,
                Ok(None) => {
                    last = "the queue has no broker".into();
                    continue;
                }
                Err(error) => {
                    last = error.to_string();
                    continue;
                }
            };
            let timeout = config.request_timeout + wait;
            match self.attempt(&broker, path, body, timeout).await {
                Attempt::Done(response) => {
                    if failures > 1 {
                        tracing::debug!(%path, attempts = failures, "request went through");
                    }
                    return Ok(response);
                }
                Attempt::Lost => return Err(Error::Lost(job.to_string())),
                Attempt::Moved(Some(successor)) => {
                    last = format!("broker {} was replaced by {}", broker.id, successor.id);
                    self.set_broker(Some(successor));
                    // Go straight to the successor.
                    failures = 0;
                }
                Attempt::Moved(None) => {
                    last = format!("broker {} was replaced", broker.id);
                    self.fail_over(&broker).await;
                }
                Attempt::Retry(error) => last = error,
                Attempt::Unreachable(error) => {
                    last = format!("broker {} at {}: {error}", broker.id, broker.addr);
                    tracing::debug!(%path, error = %last, "broker unreachable");
                    self.fail_over(&broker).await;
                }
            }
        }
    }

    async fn attempt<B: Serialize, R: DeserializeOwned>(
        &self,
        broker: &BrokerInfo,
        path: &str,
        body: &B,
        timeout: Duration,
    ) -> Attempt<R> {
        let response = self
            .inner
            .http
            .post(format!("{}{path}", broker.addr))
            .json(body)
            .timeout(timeout)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => return Attempt::Unreachable(error.to_string()),
        };
        let status = response.status();
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => return Attempt::Unreachable(error.to_string()),
        };
        match status {
            StatusCode::OK => match serde_json::from_slice(&bytes) {
                Ok(parsed) => Attempt::Done(parsed),
                Err(error) => Attempt::Retry(format!("invalid response from the broker: {error}")),
            },
            StatusCode::CONFLICT => Attempt::Lost,
            StatusCode::MISDIRECTED_REQUEST => {
                let body: Option<ErrorBody> = serde_json::from_slice(&bytes).ok();
                Attempt::Moved(body.and_then(|b| b.broker))
            }
            StatusCode::SERVICE_UNAVAILABLE => Attempt::Retry(format!(
                "the broker could not reach storage: {}",
                String::from_utf8_lossy(&bytes)
            )),
            // Something that is not a broker, such as a new process on the
            // old broker's port.
            other => {
                Attempt::Unreachable(format!("HTTP {other}: {}", String::from_utf8_lossy(&bytes)))
            }
        }
    }

    /// The broker to send requests to. That is the one last used, else the
    /// one the file names, else one this node starts for a file with none.
    async fn find_broker(&self) -> Result<Option<BrokerInfo>> {
        if let Some(broker) = self.cached_broker() {
            return Ok(Some(broker));
        }
        let state = self.inner.store.load().await?.map(|v| v.state);
        match state.and_then(|s| s.broker) {
            Some(broker) => {
                self.set_broker(Some(broker.clone()));
                Ok(Some(broker))
            }
            None => Ok(self.host(None).await),
        }
    }

    /// Replace `failed`, which did not answer, with whoever the file names
    /// now or with a broker this node starts.
    async fn fail_over(&self, failed: &BrokerInfo) {
        let mut local = self.inner.local.lock().await;
        if let Some(handle) = &*local {
            if !handle.is_running() {
                *local = None;
            } else if handle.info() == failed {
                // A new broker here would face the same storage as the old
                // one, so leave replacing it to another node.
                self.set_broker(Some(failed.clone()));
                return;
            }
        }
        let current = match self.inner.store.load().await {
            Ok(current) => current.and_then(|v| v.state.broker),
            Err(error) => {
                tracing::warn!(%error, "could not read the queue file to fail over");
                self.set_broker(None);
                return;
            }
        };
        match current {
            Some(current) if current != *failed => {
                self.set_broker(Some(current));
            }
            _ => {
                drop(local);
                let started = self.host(Some(failed)).await;
                self.set_broker(started);
            }
        }
    }

    /// Start a broker on this node, if it may host one, replacing
    /// `replacing` or taking a file with no broker. Returns the broker the
    /// file names afterwards, if known.
    async fn host(&self, replacing: Option<&BrokerInfo>) -> Option<BrokerInfo> {
        let host = self.inner.config.host.as_ref()?;
        let mut local = self.inner.local.lock().await;
        if let Some(handle) = &*local
            && handle.is_running()
        {
            return Some(handle.info().clone());
        }
        let listener = match TcpListener::bind(host.listen).await {
            Ok(listener) => listener,
            Err(error) => {
                tracing::warn!(%error, listen = %host.listen, "could not listen for a broker");
                return None;
            }
        };
        let started = broker::start(
            Arc::clone(&self.inner.store),
            listener,
            host.advertise.clone(),
            host.broker.clone(),
            replacing,
        )
        .await;
        match started {
            Ok(handle) => {
                let info = handle.info().clone();
                *local = Some(handle);
                Some(info)
            }
            Err(StartError::Taken(current)) => Some(current),
            Err(error) => {
                tracing::warn!(%error, "could not start a broker");
                None
            }
        }
    }
}

fn job_request(job: &ClaimedJob) -> JobRequest {
    JobRequest {
        id: job.id.clone(),
        token: job.token.clone(),
    }
}
