// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The broker, the one process that writes the queue file.
//!
//! The broker keeps the file it last read or wrote in memory with its
//! version. Requests arrive over HTTP and wait in a channel. One loop takes
//! everything waiting, applies it to a copy of the state, and writes the
//! copy back with a compare-and-set on the version. While that write is in
//! flight, new requests pile up in the channel and become the next batch.
//! This is group commit, so one write carries every request that arrived
//! during the previous one, and the write rate stays at one per round trip
//! to storage however many clients there are.
//!
//! No request gets an answer until the write holding its effect has
//! succeeded. If the compare-and-set fails, someone else wrote the file.
//! The broker reloads it, and if the file names a different broker, this
//! one has been replaced. It answers everything it holds with the new
//! broker's address and stops. Two brokers can briefly run at once this
//! way, but only one of them can write, so the file stays consistent.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use http_body_util::{BodyExt as _, Full, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;

use crate::protocol::{
    BrokerInfo, ClaimRequest, ClaimResponse, ErrorBody, JobRequest, PushRequest,
};
use crate::state::{Clock, Leases, Limits, Op, Outcome, QueueState};
use crate::store::{Changed, Store, StoreError};

/// The largest request body the broker reads.
const MAX_REQUEST_BYTES: usize = 1 << 20;

/// How many requests can wait for the loop before senders block.
const CHANNEL_CAPACITY: usize = 1 << 16;

/// How many times one batch is reapplied after a conflicting write that
/// did not replace this broker.
const CONFLICT_RETRIES: usize = 3;

/// Broker settings.
#[derive(Debug, Clone)]
pub struct BrokerConfig {
    /// How long a claim lasts without a heartbeat. Defaults to 10 seconds.
    pub lease: Duration,
    /// How many completed job IDs the file remembers, so that retried
    /// pushes and completions of finished jobs are recognized. Defaults to
    /// 1024.
    pub done_capacity: usize,
    /// How long an idle broker goes without checking that the file still
    /// names it. A replaced broker that never writes would otherwise keep
    /// answering claims from a stale copy. Defaults to 1 second.
    pub refresh_interval: Duration,
    /// The longest a claim may wait for a job. Defaults to 30 seconds.
    pub max_wait: Duration,
    /// How many compare-and-set attempts taking over gets. Defaults to 10.
    pub takeover_attempts: usize,
}

impl Default for BrokerConfig {
    fn default() -> Self {
        Self {
            lease: Duration::from_secs(10),
            done_capacity: 1024,
            refresh_interval: Duration::from_secs(1),
            max_wait: Duration::from_secs(30),
            takeover_attempts: 10,
        }
    }
}

/// Why a broker did not start.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// The file already names another live broker.
    #[error("the queue already has broker {} at {}", .0.id, .0.addr)]
    Taken(BrokerInfo),
    #[error("could not take over the queue file: {0}")]
    Store(#[from] StoreError),
    #[error("could not serve HTTP: {0}")]
    Io(#[from] std::io::Error),
}

/// Counters a running broker keeps.
#[derive(Debug, Default)]
struct Counters {
    requests: AtomicU64,
    commits: AtomicU64,
    conflicts: AtomicU64,
    storage_errors: AtomicU64,
}

/// A snapshot of a broker's counters.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct BrokerStats {
    /// Requests the loop has taken from the channel.
    pub requests: u64,
    /// Successful writes of the queue file, the takeover included.
    pub commits: u64,
    /// Writes that found the file changed underneath.
    pub conflicts: u64,
    /// Reads and writes that failed for any other reason.
    pub storage_errors: u64,
}

/// Why the loop did not answer a request with an [`Outcome`].
#[derive(Debug, Clone)]
enum Refusal {
    /// This broker has been replaced, by the given one if known.
    NotBroker(Option<BrokerInfo>),
    /// Storage failed. The request may or may not have taken effect.
    Unavailable(String),
}

type Reply = Result<Outcome, Refusal>;

/// A request waiting for the loop.
struct Pending {
    op: Op,
    /// For a claim, how long it may wait for a job.
    deadline: Option<Instant>,
    reply: oneshot::Sender<Reply>,
}

/// What the HTTP side and the loop share.
struct Shared {
    info: BrokerInfo,
    config: BrokerConfig,
    tx: mpsc::Sender<Pending>,
    /// The broker that replaced this one, once the loop knows.
    successor: Mutex<Option<BrokerInfo>>,
    counters: Counters,
}

/// A running broker. Dropping the handle stops it the way a crash would.
#[derive(Debug)]
pub struct BrokerHandle {
    info: BrokerInfo,
    shared: Arc<SharedDebug>,
    core: JoinHandle<()>,
    server: JoinHandle<()>,
}

/// [`Shared`] behind a `Debug` impl that prints only the identity.
struct SharedDebug(Arc<Shared>);

impl std::fmt::Debug for SharedDebug {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Broker")
            .field("info", &self.0.info)
            .finish()
    }
}

impl BrokerHandle {
    pub fn info(&self) -> &BrokerInfo {
        &self.info
    }

    /// Whether the broker still believes the file names it. It stops on
    /// learning that another broker replaced it.
    pub fn is_running(&self) -> bool {
        !self.core.is_finished()
    }

    /// The broker that replaced this one, if it has learned of one.
    pub fn successor(&self) -> Option<BrokerInfo> {
        self.shared
            .0
            .successor
            .lock()
            .expect("successor lock")
            .clone()
    }

    pub fn stats(&self) -> BrokerStats {
        let counters = &self.shared.0.counters;
        BrokerStats {
            requests: counters.requests.load(Ordering::Relaxed),
            commits: counters.commits.load(Ordering::Relaxed),
            conflicts: counters.conflicts.load(Ordering::Relaxed),
            storage_errors: counters.storage_errors.load(Ordering::Relaxed),
        }
    }

    /// Stop at once, without answering anything held or telling anyone,
    /// as a crashed process would. Open connections close.
    pub fn abort(&self) {
        self.core.abort();
        self.server.abort();
    }
}

impl Drop for BrokerHandle {
    fn drop(&mut self) {
        self.abort();
    }
}

/// Start a broker serving on `listener`, taking over the queue file in
/// `store`.
///
/// The file must name no broker, or the broker in `replacing`, which the
/// caller has found unresponsive. A file naming any other broker means
/// someone else got there first, and the result is
/// [`StartError::Taken`] with that broker. `advertise` is the base URL
/// clients reach the listener at, by default `http://` and its address.
pub async fn start(
    store: Arc<dyn Store>,
    listener: TcpListener,
    advertise: Option<String>,
    config: BrokerConfig,
    replacing: Option<&BrokerInfo>,
) -> Result<BrokerHandle, StartError> {
    let addr = match advertise {
        Some(addr) => addr,
        None => format!("http://{}", listener.local_addr()?),
    };
    let info = BrokerInfo {
        id: uuid::Uuid::new_v4().to_string(),
        addr,
    };
    let (state, e_tag) = take_over(&*store, &info, &config, replacing).await?;
    tracing::info!(broker = %info.id, addr = %info.addr, "took over the queue");

    let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
    let shared = Arc::new(Shared {
        info: info.clone(),
        config,
        tx,
        successor: Mutex::new(None),
        counters: Counters::default(),
    });
    shared.counters.commits.fetch_add(1, Ordering::Relaxed);
    let mut leases = Leases::default();
    let now = Instant::now();
    leases.sync(&state, now);
    let core = Core {
        shared: Arc::clone(&shared),
        store,
        state,
        e_tag,
        leases,
        waiting: Vec::new(),
        last_confirmed: now,
    };
    Ok(BrokerHandle {
        info,
        shared: Arc::new(SharedDebug(Arc::clone(&shared))),
        core: tokio::spawn(core.run(rx)),
        server: tokio::spawn(serve(listener, shared)),
    })
}

/// Write `info` into the file as its broker, returning the file written and
/// its version.
async fn take_over(
    store: &dyn Store,
    info: &BrokerInfo,
    config: &BrokerConfig,
    replacing: Option<&BrokerInfo>,
) -> Result<(QueueState, String), StartError> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let (mut state, e_tag) = match store.load().await? {
            Some(current) => (current.state, Some(current.e_tag)),
            None => (QueueState::new(), None),
        };
        if let Some(current) = &state.broker
            && Some(current) != replacing
        {
            return Err(StartError::Taken(current.clone()));
        }
        state.broker = Some(info.clone());
        match store.swap(e_tag.as_deref(), &state).await {
            Ok(e_tag) => return Ok((state, e_tag)),
            // The old broker is slow, not dead, and wrote in the meantime.
            // Try again on top of its write.
            Err(StoreError::Conflict) if attempt < config.takeover_attempts => continue,
            Err(error) => return Err(error.into()),
        }
    }
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// The group commit loop.
struct Core {
    shared: Arc<Shared>,
    store: Arc<dyn Store>,
    /// The file as of version `e_tag`, which this broker last read or wrote.
    state: QueueState,
    e_tag: String,
    leases: Leases,
    /// Claims that found no job and may still wait for one, oldest first.
    waiting: Vec<Pending>,
    /// When the file last proved to still name this broker.
    last_confirmed: Instant,
}

impl Core {
    fn limits(&self) -> Limits {
        Limits {
            lease: self.shared.config.lease,
            done_capacity: self.shared.config.done_capacity,
        }
    }

    async fn run(mut self, mut rx: mpsc::Receiver<Pending>) {
        loop {
            let mut batch = Vec::new();
            tokio::select! {
                pending = rx.recv() => match pending {
                    Some(pending) => batch.push(pending),
                    None => return,
                },
                () = tokio::time::sleep_until(self.next_wakeup()) => {}
            }
            // Everything that arrived while the last write was in flight.
            while let Ok(pending) = rx.try_recv() {
                batch.push(pending);
            }
            self.shared
                .counters
                .requests
                .fetch_add(batch.len() as u64, Ordering::Relaxed);

            // Waiting claims alone never write, so check the file on
            // schedule even while they wait. Otherwise a replaced broker
            // could hold its workers' claims forever.
            if Instant::now() >= self.last_confirmed + self.shared.config.refresh_interval
                && let Err(successor) = self.refresh().await
            {
                self.waiting.extend(batch);
                self.step_down(successor, rx);
                return;
            }
            if !(batch.is_empty() && self.waiting.is_empty())
                && let Err(successor) = self.round(batch).await
            {
                self.step_down(successor, rx);
                return;
            }
        }
    }

    /// When the loop next has something to do without a new request. A
    /// waiting claim may run out of time or find a lease expired, and the
    /// file comes due for a check.
    fn next_wakeup(&self) -> Instant {
        let mut next = self.last_confirmed + self.shared.config.refresh_interval;
        for pending in &self.waiting {
            if let Some(deadline) = pending.deadline {
                next = next.min(deadline);
            }
        }
        if !self.waiting.is_empty()
            && let Some(expiry) = self.leases.next_expiry(self.shared.config.lease)
        {
            next = next.min(expiry);
        }
        next
    }

    /// Apply `batch`, and the claims still waiting, and answer them.
    async fn round(&mut self, batch: Vec<Pending>) -> Result<(), Option<BrokerInfo>> {
        let mut pending = std::mem::take(&mut self.waiting);
        pending.extend(batch);
        let mut conflicts = 0;
        let mut confirmed = false;
        loop {
            let clock = Clock {
                now: Instant::now(),
                wall_ms: wall_ms(),
            };
            let mut next = self.state.clone();
            let mut leases = self.leases.clone();
            let outcomes: Vec<Option<Outcome>> = pending
                .iter()
                .map(|p| next.apply(&p.op, clock, self.limits(), &mut leases))
                .collect();
            if next == self.state {
                // Nothing to write, so the answers come from memory. If
                // another broker has replaced this one, memory may be stale,
                // and a retried claim could get a job someone has since
                // finished. Anything but "nothing to claim" is checked
                // against the file first.
                let informative = outcomes
                    .iter()
                    .any(|o| o.as_ref().is_some_and(|o| *o != Outcome::Empty));
                if informative && !confirmed {
                    match self.store.load_if_changed(&self.e_tag).await {
                        Ok(Changed::Unchanged) => self.last_confirmed = clock.now,
                        Ok(Changed::Changed(current)) => {
                            if let Err(successor) = self.adopt(current, clock.now) {
                                self.waiting = pending;
                                return Err(successor);
                            }
                        }
                        Err(error) => {
                            self.refuse_all(pending, &error);
                            return Ok(());
                        }
                    }
                    confirmed = true;
                    continue;
                }
                self.answer(pending, outcomes, clock.now);
                return Ok(());
            }
            match self.store.swap(Some(&self.e_tag), &next).await {
                Ok(e_tag) => {
                    self.shared.counters.commits.fetch_add(1, Ordering::Relaxed);
                    self.state = next;
                    self.e_tag = e_tag;
                    self.leases = leases;
                    self.last_confirmed = clock.now;
                    self.answer(pending, outcomes, clock.now);
                    return Ok(());
                }
                Err(StoreError::Conflict) => {
                    self.shared
                        .counters
                        .conflicts
                        .fetch_add(1, Ordering::Relaxed);
                    conflicts += 1;
                    let current = match self.store.load().await {
                        Ok(current) => current,
                        Err(error) => {
                            self.refuse_all(pending, &error);
                            return Ok(());
                        }
                    };
                    if let Err(successor) = self.adopt(current, clock.now) {
                        self.waiting = pending;
                        return Err(successor);
                    }
                    confirmed = true;
                    if conflicts > CONFLICT_RETRIES {
                        let error = StoreError::Conflict;
                        self.refuse_all(pending, &error);
                        return Ok(());
                    }
                }
                Err(error) => {
                    // The write may or may not have happened. If it did, the
                    // next write conflicts and the reload finds it.
                    self.refuse_all(pending, &error);
                    return Ok(());
                }
            }
        }
    }

    /// Take `current` as the file, unless it names another broker or is
    /// gone, in which case this broker has been replaced.
    fn adopt(
        &mut self,
        current: Option<crate::store::Versioned>,
        now: Instant,
    ) -> Result<(), Option<BrokerInfo>> {
        let Some(current) = current else {
            tracing::warn!(broker = %self.shared.info.id, "the queue file is gone");
            return Err(None);
        };
        if current.state.broker.as_ref() != Some(&self.shared.info) {
            return Err(current.state.broker);
        }
        self.state = current.state;
        self.e_tag = current.e_tag;
        self.leases.sync(&self.state, now);
        self.last_confirmed = now;
        Ok(())
    }

    /// Check, cheaply, that the file still names this broker.
    async fn refresh(&mut self) -> Result<(), Option<BrokerInfo>> {
        let now = Instant::now();
        match self.store.load_if_changed(&self.e_tag).await {
            Ok(Changed::Unchanged) => {
                self.last_confirmed = now;
                Ok(())
            }
            Ok(Changed::Changed(current)) => self.adopt(current, now),
            Err(error) => {
                self.shared
                    .counters
                    .storage_errors
                    .fetch_add(1, Ordering::Relaxed);
                tracing::warn!(%error, "could not check the queue file");
                // Try again after another interval rather than at once.
                self.last_confirmed = now;
                Ok(())
            }
        }
    }

    /// Answer each request whose outcome is known, and keep claims that
    /// found nothing waiting until their deadline.
    fn answer(&mut self, pending: Vec<Pending>, outcomes: Vec<Option<Outcome>>, now: Instant) {
        for (pending, outcome) in pending.into_iter().zip(outcomes) {
            match outcome {
                Some(outcome) => {
                    let _ = pending.reply.send(Ok(outcome));
                }
                None if pending.deadline.is_some_and(|d| d > now) && !pending.reply.is_closed() => {
                    self.waiting.push(pending);
                }
                None => {
                    let _ = pending.reply.send(Ok(Outcome::Empty));
                }
            }
        }
    }

    fn refuse_all(&self, pending: Vec<Pending>, error: &StoreError) {
        self.shared
            .counters
            .storage_errors
            .fetch_add(1, Ordering::Relaxed);
        tracing::warn!(%error, requests = pending.len(), "could not write the queue file");
        let refusal = Refusal::Unavailable(error.to_string());
        for pending in pending {
            let _ = pending.reply.send(Err(refusal.clone()));
        }
    }

    /// Stop being the broker, sending everyone held, and everyone still
    /// arriving, to `successor`. A round that finds this broker replaced
    /// leaves its requests in `waiting` for this.
    fn step_down(mut self, successor: Option<BrokerInfo>, mut rx: mpsc::Receiver<Pending>) {
        tracing::info!(
            broker = %self.shared.info.id,
            successor = ?successor.as_ref().map(|b| &b.id),
            "another broker replaced this one",
        );
        *self.shared.successor.lock().expect("successor lock") = successor.clone();
        rx.close();
        let refusal = Refusal::NotBroker(successor);
        let held = std::mem::take(&mut self.waiting);
        for pending in held
            .into_iter()
            .chain(std::iter::from_fn(|| rx.try_recv().ok()))
        {
            let _ = pending.reply.send(Err(refusal.clone()));
        }
    }
}

/// Accept connections until the handle aborts this task, which also
/// closes every connection it accepted.
async fn serve(listener: TcpListener, shared: Arc<Shared>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        tracing::warn!(%error, "accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let shared = Arc::clone(&shared);
                connections.spawn(serve_connection(stream, peer, shared));
            }
            Some(_) = connections.join_next() => {}
        }
    }
}

async fn serve_connection(stream: tokio::net::TcpStream, peer: SocketAddr, shared: Arc<Shared>) {
    let service = hyper::service::service_fn(move |request| {
        let shared = Arc::clone(&shared);
        async move { Ok::<_, Infallible>(handle(request, &shared).await) }
    });
    if let Err(error) = hyper::server::conn::http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .await
    {
        tracing::debug!(%peer, %error, "connection ended");
    }
}

fn json_response(status: StatusCode, body: &impl Serialize) -> Response<Full<Bytes>> {
    let body = serde_json::to_vec(body).expect("responses always serialize");
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)))
        .expect("static response parts are valid")
}

fn error_response(status: StatusCode, error: impl Into<String>) -> Response<Full<Bytes>> {
    json_response(
        status,
        &ErrorBody {
            error: error.into(),
            broker: None,
        },
    )
}

async fn read_json<T: DeserializeOwned>(
    request: Request<Incoming>,
) -> Result<T, Response<Full<Bytes>>> {
    let body = Limited::new(request.into_body(), MAX_REQUEST_BYTES)
        .collect()
        .await
        .map_err(|e| error_response(StatusCode::BAD_REQUEST, format!("reading the body: {e}")))?
        .to_bytes();
    serde_json::from_slice(&body)
        .map_err(|e| error_response(StatusCode::BAD_REQUEST, format!("invalid request: {e}")))
}

async fn handle(request: Request<Incoming>, shared: &Shared) -> Response<Full<Bytes>> {
    if request.method() == Method::GET && request.uri().path() == "/v1/broker" {
        return json_response(StatusCode::OK, &shared.info);
    }
    if request.method() != Method::POST {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "requests are POSTs");
    }
    let path = request.uri().path().to_string();
    let (op, deadline) = match path.as_str() {
        "/v1/push" => match read_json::<PushRequest>(request).await {
            Ok(r) => (
                Op::Push {
                    id: r.id,
                    payload: r.payload,
                },
                None,
            ),
            Err(response) => return response,
        },
        "/v1/claim" => match read_json::<ClaimRequest>(request).await {
            Ok(r) => {
                let wait = Duration::from_millis(r.wait_ms).min(shared.config.max_wait);
                (
                    Op::Claim {
                        worker: r.worker,
                        token: r.token,
                    },
                    Some(Instant::now() + wait),
                )
            }
            Err(response) => return response,
        },
        "/v1/heartbeat" | "/v1/complete" => match read_json::<JobRequest>(request).await {
            Ok(r) if path == "/v1/heartbeat" => (
                Op::Heartbeat {
                    id: r.id,
                    token: r.token,
                },
                None,
            ),
            Ok(r) => (
                Op::Complete {
                    id: r.id,
                    token: r.token,
                },
                None,
            ),
            Err(response) => return response,
        },
        _ => return error_response(StatusCode::NOT_FOUND, format!("no such operation {path}")),
    };

    let (reply, answer) = oneshot::channel();
    let pending = Pending {
        op,
        deadline,
        reply,
    };
    let reply = match shared.tx.send(pending).await {
        Ok(()) => answer.await.ok(),
        Err(_) => None,
    };
    let reply = reply.unwrap_or_else(|| {
        let successor = shared.successor.lock().expect("successor lock").clone();
        Err(Refusal::NotBroker(successor))
    });
    match reply {
        Ok(Outcome::Pushed | Outcome::Done) => {
            json_response(StatusCode::OK, &serde_json::json!({}))
        }
        Ok(Outcome::Claimed(job)) => {
            json_response(StatusCode::OK, &ClaimResponse { job: Some(job) })
        }
        Ok(Outcome::Empty) => json_response(StatusCode::OK, &ClaimResponse { job: None }),
        Ok(Outcome::Lost) => {
            error_response(StatusCode::CONFLICT, "the claim no longer holds this job")
        }
        Err(Refusal::NotBroker(broker)) => json_response(
            StatusCode::MISDIRECTED_REQUEST,
            &ErrorBody {
                error: "this broker has been replaced".into(),
                broker,
            },
        ),
        Err(Refusal::Unavailable(error)) => error_response(StatusCode::SERVICE_UNAVAILABLE, error),
    }
}
