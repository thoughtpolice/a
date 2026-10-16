// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Brokers and clients against an in-memory queue file.
//!
//! These run real brokers on loopback HTTP, with storage replaced by
//! [`MemoryStore`] behind wrappers that slow or hold writes, so failover
//! and step-down happen in a chosen order. `test_chaos3` runs the same
//! machinery against an S3 server that injects faults.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::{
    BrokerConfig, Changed, Error, HostConfig, MemoryStore, Queue, QueueConfig, QueueState, Store,
    StoreError, Versioned,
};

/// A store whose writes wait while a gate is closed, standing in for a
/// broker whose storage requests have stalled.
struct Gated {
    inner: Arc<MemoryStore>,
    open: watch::Receiver<bool>,
    delay: Duration,
}

#[async_trait]
impl Store for Gated {
    async fn load(&self) -> Result<Option<Versioned>, StoreError> {
        self.inner.load().await
    }

    async fn load_if_changed(&self, e_tag: &str) -> Result<Changed, StoreError> {
        self.inner.load_if_changed(e_tag).await
    }

    async fn swap(&self, expected: Option<&str>, state: &QueueState) -> Result<String, StoreError> {
        tokio::time::sleep(self.delay).await;
        let mut open = self.open.clone();
        open.wait_for(|open| *open)
            .await
            .expect("gate sender alive");
        self.inner.swap(expected, state).await
    }
}

/// One node of a cluster, with its own client, broker host and view of
/// storage.
struct Node {
    queue: Queue,
    gate: watch::Sender<bool>,
}

struct Cluster {
    store: Arc<MemoryStore>,
    broker: BrokerConfig,
    client: QueueConfig,
    /// Added to every write, so concurrent requests pile up into batches.
    write_delay: Duration,
}

impl Cluster {
    fn new() -> Self {
        Self {
            store: Arc::new(MemoryStore::new()),
            broker: BrokerConfig {
                lease: Duration::from_secs(10),
                refresh_interval: Duration::from_millis(100),
                ..Default::default()
            },
            client: QueueConfig {
                request_timeout: Duration::from_secs(2),
                operation_timeout: Duration::from_secs(20),
                retry_backoff: Duration::from_millis(5),
                ..Default::default()
            },
            write_delay: Duration::ZERO,
        }
    }

    fn node(&self) -> Node {
        let (gate, open) = watch::channel(true);
        let store = Arc::new(Gated {
            inner: Arc::clone(&self.store),
            open,
            delay: self.write_delay,
        });
        let config = QueueConfig {
            host: Some(HostConfig {
                listen: "127.0.0.1:0".parse().unwrap(),
                advertise: None,
                broker: self.broker.clone(),
            }),
            ..self.client.clone()
        };
        Node {
            queue: Queue::new(store, config),
            gate,
        }
    }

    async fn state(&self) -> QueueState {
        self.store
            .load()
            .await
            .unwrap()
            .expect("the queue exists")
            .state
    }
}

async fn claim_now(queue: &Queue, worker: &str) -> Option<crate::ClaimedJob> {
    queue.claim(worker, Duration::ZERO).await.unwrap()
}

#[tokio::test]
async fn group_commit_puts_concurrent_pushes_in_few_writes() {
    let cluster = Cluster {
        write_delay: Duration::from_millis(20),
        ..Cluster::new()
    };
    let node = cluster.node();
    node.queue.push("first").await.unwrap();
    let before = cluster.store.writes();

    let pushes = (0..200).map(|i| {
        let queue = node.queue.clone();
        tokio::spawn(async move { queue.push(format!("job {i}")).await.unwrap() })
    });
    for push in futures::future::join_all(pushes).await {
        push.unwrap();
    }

    let writes = cluster.store.writes() - before;
    assert!(writes <= 25, "200 pushes took {writes} writes");
    assert_eq!(cluster.state().await.jobs.len(), 201);
    let stats = node.queue.local_broker_stats().await.unwrap();
    assert_eq!(stats.requests, 201);
}

#[tokio::test]
async fn claims_follow_push_order() {
    let cluster = Cluster::new();
    let node = cluster.node();
    let mut ids = Vec::new();
    for i in 0..5 {
        ids.push(node.queue.push(format!("job {i}")).await.unwrap());
    }
    let mut claimed = Vec::new();
    while let Some(job) = claim_now(&node.queue, "w").await {
        assert_eq!(job.payload, format!("job {}", claimed.len()));
        assert_eq!(job.attempts, 1);
        claimed.push(job.id);
    }
    assert_eq!(claimed, ids);
}

#[tokio::test]
async fn a_waiting_claim_gets_a_job_pushed_later() {
    let cluster = Cluster::new();
    let node = cluster.node();
    let other = cluster.node();
    node.queue.push("warmup").await.unwrap();
    let warmup = claim_now(&node.queue, "w").await.unwrap();
    node.queue.complete(&warmup).await.unwrap();

    let started = Instant::now();
    let waiter = {
        let queue = node.queue.clone();
        tokio::spawn(async move { queue.claim("w", Duration::from_secs(10)).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    other.queue.push("late").await.unwrap();
    let job = waiter
        .await
        .unwrap()
        .unwrap()
        .expect("the waiting claim gets the job");
    assert_eq!(job.payload, "late");
    assert!(started.elapsed() < Duration::from_secs(5));

    // With nothing to claim, a claim returns empty once its wait is up.
    let started = Instant::now();
    assert!(
        node.queue
            .claim("w", Duration::from_millis(300))
            .await
            .unwrap()
            .is_none()
    );
    assert!(started.elapsed() >= Duration::from_millis(300));
}

#[tokio::test]
async fn a_crashed_broker_is_replaced_by_another_node() {
    let cluster = Cluster::new();
    let a = cluster.node();
    let b = cluster.node();
    a.queue.push("one").await.unwrap();
    let first = a
        .queue
        .local_broker()
        .await
        .expect("node a hosts the broker");
    b.queue.push("two").await.unwrap();
    assert!(b.queue.local_broker().await.is_none(), "b used a's broker");

    assert!(a.queue.abort_local_broker().await);
    b.queue.push("three").await.unwrap();
    let second = b.queue.local_broker().await.expect("node b took over");
    assert_ne!(first, second);
    assert_eq!(cluster.state().await.broker, Some(second.clone()));

    // Node a finds the new broker through the file.
    a.queue.push("four").await.unwrap();
    assert_eq!(a.queue.cached_broker(), Some(second));
    let payloads: Vec<String> = cluster
        .state()
        .await
        .jobs
        .into_iter()
        .map(|j| j.payload)
        .collect();
    assert_eq!(payloads, ["one", "two", "three", "four"]);
}

#[tokio::test]
async fn a_slow_broker_is_replaced_and_steps_down() {
    let mut cluster = Cluster::new();
    cluster.client.request_timeout = Duration::from_millis(300);
    let a = cluster.node();
    let b = cluster.node();
    a.queue.push("before").await.unwrap();
    let first = a.queue.local_broker().await.unwrap();

    // Node a's writes stall. Its own push sits in the broker's batch.
    a.gate.send_replace(false);
    let stalled = {
        let queue = a.queue.clone();
        tokio::spawn(async move { queue.push("stalled").await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Node b times out on the stalled broker and takes over.
    b.queue.push("during").await.unwrap();
    let second = b.queue.local_broker().await.expect("node b took over");
    assert_ne!(first, second);

    // The old broker's write goes through now, finds the file changed,
    // and the broker steps down, sending its client to the new broker.
    a.gate.send_replace(true);
    stalled.await.unwrap().unwrap();
    assert!(
        a.queue.local_broker().await.is_none(),
        "the old broker stopped"
    );

    let state = cluster.state().await;
    assert_eq!(state.broker, Some(second));
    let payloads: Vec<String> = state.jobs.into_iter().map(|j| j.payload).collect();
    assert_eq!(payloads, ["before", "during", "stalled"]);
}

#[tokio::test]
async fn an_idle_broker_notices_it_was_replaced() {
    let cluster = Cluster::new();
    let a = cluster.node();
    a.queue.push("x").await.unwrap();
    let first = a.queue.local_broker().await.unwrap();

    // Another broker takes over without the first one writing again.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let store: Arc<dyn Store> = cluster.store.clone();
    let second = crate::broker::start(store, listener, None, cluster.broker.clone(), Some(&first))
        .await
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    while a.queue.local_broker().await.is_some() {
        assert!(
            Instant::now() < deadline,
            "the old broker never stepped down"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Node a's next request is redirected to the new broker.
    let job = claim_now(&a.queue, "w").await.unwrap();
    assert_eq!(job.payload, "x");
    assert_eq!(a.queue.cached_broker().as_ref(), Some(second.info()));
}

#[tokio::test]
async fn a_lapsed_claim_passes_to_another_worker() {
    let mut cluster = Cluster::new();
    cluster.broker.lease = Duration::from_millis(300);
    let node = cluster.node();
    node.queue.push("job").await.unwrap();

    let first = claim_now(&node.queue, "w1").await.unwrap();
    let started = Instant::now();
    let second = node
        .queue
        .claim("w2", Duration::from_secs(5))
        .await
        .unwrap()
        .expect("the lapsed job is claimed again");
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert_eq!(second.id, first.id);
    assert_eq!(second.attempts, 2);

    assert!(matches!(
        node.queue.heartbeat(&first).await,
        Err(Error::Lost(_))
    ));
    assert!(matches!(
        node.queue.complete(&first).await,
        Err(Error::Lost(_))
    ));
    node.queue.complete(&second).await.unwrap();
    // Completing again, as a retry would, finds it done.
    node.queue.complete(&second).await.unwrap();
    assert!(cluster.state().await.jobs.is_empty());
}

#[tokio::test]
async fn heartbeats_keep_a_long_job_claimed() {
    let mut cluster = Cluster::new();
    cluster.broker.lease = Duration::from_millis(300);
    cluster.client.heartbeat_interval = Duration::from_millis(50);
    let node = cluster.node();
    node.queue.push("long").await.unwrap();
    let job = claim_now(&node.queue, "w1").await.unwrap();

    let thief = {
        let queue = node.queue.clone();
        tokio::spawn(async move { queue.claim("w2", Duration::from_millis(1500)).await })
    };
    let out = node
        .queue
        .run(&job, async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            42
        })
        .await
        .unwrap();
    assert_eq!(out, 42);
    assert!(
        thief.await.unwrap().unwrap().is_none(),
        "the job was never free"
    );
    let state = cluster.state().await;
    assert!(state.jobs.is_empty());
    assert_eq!(state.done.len(), 1);
    assert_eq!(state.done[0].id, job.id);
}

#[tokio::test]
async fn run_stops_work_whose_claim_lapsed() {
    let mut cluster = Cluster::new();
    cluster.broker.lease = Duration::from_millis(200);
    cluster.client.heartbeat_interval = Duration::from_millis(500);
    let node = cluster.node();
    node.queue.push("slow").await.unwrap();
    let job = claim_now(&node.queue, "w1").await.unwrap();

    // Another worker takes the job while the first is between heartbeats.
    let thief = node
        .queue
        .claim("w2", Duration::from_secs(2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(thief.id, job.id);
    let result = node
        .queue
        .run(&job, tokio::time::sleep(Duration::from_secs(10)))
        .await;
    assert!(matches!(result, Err(Error::Lost(_))), "{result:?}");
}

#[tokio::test]
async fn a_node_that_cannot_host_waits_for_one_that_can() {
    let cluster = Cluster::new();
    let pusher = Queue::new(
        cluster.store.clone(),
        QueueConfig {
            operation_timeout: Duration::from_secs(10),
            retry_backoff: Duration::from_millis(5),
            ..Default::default()
        },
    );
    let early = {
        let pusher = pusher.clone();
        tokio::spawn(async move { pusher.push("early").await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!early.is_finished(), "no broker exists yet");

    let host = cluster.node();
    host.queue.push("host").await.unwrap();
    early.await.unwrap().unwrap();
    assert_eq!(cluster.state().await.jobs.len(), 2);
}
