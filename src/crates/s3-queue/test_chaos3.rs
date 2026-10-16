// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The queue against chaos3, a separate S3-compatible server process.
//!
//! Buck starts one chaos3 server per scenario and hands its endpoint and
//! credentials to the test through the environment. Fault budgets belong
//! to a server, so a scenario with faults holds exactly one test, and every
//! test uses its own queue file.

// Each scenario compiles only its own tests, leaving some helpers unused;
// the healthy scenario uses them all, so it keeps the lints.
#![cfg_attr(not(chaos3_scenario = "healthy"), allow(dead_code, unused_imports))]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;

use crate::{BrokerConfig, Error, HostConfig, Queue, QueueConfig, QueueState, S3QueueStore, Store};

fn var(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        panic!("{name} is unset: run this through `buck2 test`, which starts chaos3")
    })
}

fn s3() -> s3_client::Client {
    s3_client::ClientBuilder::from_env()
        .with_endpoint(var("CHAOS3_ENDPOINT"))
        .with_bucket(var("CHAOS3_BUCKET"))
        .with_allow_http(true)
        .with_timeout(Some(Duration::from_secs(10)))
        .build()
        .expect("chaos3 client configuration is valid")
}

/// A queue file no other test, or earlier attempt of this one, has used.
fn queue_key(test: &str) -> String {
    format!("{test}-{}/queue.json", std::process::id())
}

fn store(key: &str) -> Arc<S3QueueStore> {
    Arc::new(S3QueueStore::new(s3(), key))
}

/// A node that can host the broker.
fn node(key: &str, config: &QueueConfig, broker: &BrokerConfig) -> Queue {
    Queue::new(
        store(key),
        QueueConfig {
            host: Some(HostConfig {
                listen: "127.0.0.1:0".parse().unwrap(),
                advertise: None,
                broker: broker.clone(),
            }),
            ..config.clone()
        },
    )
}

async fn file(key: &str) -> QueueState {
    store(key)
        .load()
        .await
        .unwrap()
        .expect("the queue exists")
        .state
}

fn payloads(state: &QueueState) -> Vec<&str> {
    state.jobs.iter().map(|j| j.payload.as_str()).collect()
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn workers_drain_the_queue_in_push_order() {
    let key = queue_key("drain");
    let queue = node(&key, &QueueConfig::default(), &BrokerConfig::default());
    let mut pushed = Vec::new();
    for i in 0..20 {
        pushed.push(queue.push(format!("job {i}")).await.unwrap());
    }
    let state = file(&key).await;
    assert_eq!(state.jobs.len(), 20);
    assert_eq!(state.broker, queue.local_broker().await);

    let mut claimed = Vec::new();
    while let Some(job) = queue.claim("w", Duration::ZERO).await.unwrap() {
        queue.complete(&job).await.unwrap();
        claimed.push(job.id);
    }
    assert_eq!(claimed, pushed);
    let state = file(&key).await;
    assert!(state.jobs.is_empty());
    assert_eq!(state.done.len(), 20);
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn a_crashed_broker_is_replaced_by_another_node() {
    let key = queue_key("crash");
    let config = QueueConfig {
        request_timeout: Duration::from_secs(2),
        ..Default::default()
    };
    let nodes: Vec<Queue> = (0..3)
        .map(|_| node(&key, &config, &BrokerConfig::default()))
        .collect();
    nodes[0].push("one").await.unwrap();
    let first = nodes[0].local_broker().await.unwrap();
    nodes[1].push("two").await.unwrap();

    assert!(nodes[0].abort_local_broker().await);
    nodes[1].push("three").await.unwrap();
    let second = nodes[1].local_broker().await.expect("node 1 took over");
    nodes[2].push("four").await.unwrap();
    nodes[0].push("five").await.unwrap();
    assert!(nodes[2].local_broker().await.is_none());
    assert!(nodes[0].local_broker().await.is_none());

    let state = file(&key).await;
    assert_ne!(first, second);
    assert_eq!(state.broker, Some(second));
    assert_eq!(payloads(&state), ["one", "two", "three", "four", "five"]);
}

// The third PutObject stalls for three seconds at the server, as if the
// broker's storage had become slow. The first two are the broker's
// takeover and the first push.
#[cfg(chaos3_scenario = "slow_broker")]
#[tokio::test]
async fn a_slow_broker_is_replaced_and_steps_down() {
    let key = queue_key("slow");
    let config = QueueConfig {
        request_timeout: Duration::from_secs(1),
        ..Default::default()
    };
    let a = node(&key, &config, &BrokerConfig::default());
    let b = node(&key, &config, &BrokerConfig::default());
    a.push("before").await.unwrap();
    let first = a.local_broker().await.unwrap();

    let stalled = {
        let a = a.clone();
        tokio::spawn(async move { a.push("stalled").await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Node b gives up on the stalled broker and takes over.
    b.push("during").await.unwrap();
    let second = b.local_broker().await.expect("node b took over");
    assert_ne!(first, second);

    // The stalled write lands on a file that has moved on, so its
    // compare-and-set fails and the old broker steps down. Node a's push
    // then goes through the new broker.
    stalled.await.unwrap().unwrap();
    assert!(a.local_broker().await.is_none(), "the old broker stopped");
    let state = file(&key).await;
    assert_eq!(state.broker, Some(second));
    assert_eq!(payloads(&state), ["before", "during", "stalled"]);
}

/// What the chaos workload saw, in the order it saw it.
#[derive(Default)]
struct History {
    clock: AtomicU64,
    pushed: Mutex<HashSet<String>>,
    /// For each job, every claim of it, as the tick when the claim request
    /// was sent.
    claims: Mutex<HashMap<String, Vec<u64>>>,
    /// For each job, the ticks when a completion of it was acknowledged.
    completed: Mutex<HashMap<String, Vec<u64>>>,
}

impl History {
    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::SeqCst)
    }

    fn outstanding(&self) -> usize {
        let pushed = self.pushed.lock().unwrap();
        let completed = self.completed.lock().unwrap();
        pushed
            .iter()
            .filter(|id| !completed.contains_key(*id))
            .count()
    }
}

/// Whether a worker should drop this claim on the floor, as a crashed
/// worker would. About one job in eight is abandoned on its first claim.
fn abandon(job: &crate::ClaimedJob) -> bool {
    job.attempts == 1 && job.id.bytes().map(u32::from).sum::<u32>() % 8 == 0
}

/// Push, claim and complete jobs from three nodes while chaos3 runs its
/// `storage-v1` campaign and the broker crashes repeatedly, then check that
/// no acknowledged push was lost, every job completed exactly once, and no
/// job was handed out after its completion was acknowledged.
#[cfg(chaos3_scenario = "storage_v1")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_queue_survives_storage_chaos_and_broker_crashes() {
    const NODES: usize = 3;
    const JOBS_PER_NODE: usize = 40;
    const WORKERS_PER_NODE: usize = 2;
    const CRASHES: usize = 4;

    let key = queue_key("chaos");
    let config = QueueConfig {
        request_timeout: Duration::from_secs(3),
        operation_timeout: Duration::from_secs(90),
        heartbeat_interval: Duration::from_millis(500),
        ..Default::default()
    };
    let broker = BrokerConfig {
        lease: Duration::from_secs(3),
        refresh_interval: Duration::from_millis(500),
        ..Default::default()
    };
    let nodes: Vec<Queue> = (0..NODES).map(|_| node(&key, &config, &broker)).collect();
    let history = Arc::new(History::default());
    let stop = Arc::new(AtomicBool::new(false));

    let mut pushers = Vec::new();
    for (n, queue) in nodes.iter().enumerate() {
        let (queue, history) = (queue.clone(), Arc::clone(&history));
        pushers.push(tokio::spawn(async move {
            for i in 0..JOBS_PER_NODE {
                let id = format!("n{n}-j{i:03}");
                queue
                    .push_with_id(&id, format!("work for {id}"))
                    .await
                    .unwrap_or_else(|e| panic!("push {id}: {e}"));
                history.pushed.lock().unwrap().insert(id);
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        }));
    }

    let mut workers = Vec::new();
    for (n, queue) in nodes.iter().enumerate() {
        for w in 0..WORKERS_PER_NODE {
            let (queue, history, stop) = (queue.clone(), Arc::clone(&history), Arc::clone(&stop));
            let worker = format!("n{n}-w{w}");
            workers.push(tokio::spawn(async move {
                while !stop.load(Ordering::SeqCst) {
                    let sent = history.tick();
                    let job = match queue.claim(&worker, Duration::from_millis(500)).await {
                        Ok(Some(job)) => job,
                        Ok(None) => continue,
                        Err(e) => panic!("{worker} claim: {e}"),
                    };
                    history
                        .claims
                        .lock()
                        .unwrap()
                        .entry(job.id.clone())
                        .or_default()
                        .push(sent);
                    if abandon(&job) {
                        continue;
                    }
                    match queue
                        .run(&job, tokio::time::sleep(Duration::from_millis(20)))
                        .await
                    {
                        Ok(()) => {
                            let at = history.tick();
                            history
                                .completed
                                .lock()
                                .unwrap()
                                .entry(job.id.clone())
                                .or_default()
                                .push(at);
                        }
                        // Its lease ran out while storage was slow; another
                        // worker will finish it.
                        Err(Error::Lost(_)) => {}
                        Err(e) => panic!("{worker} job {}: {e}", job.id),
                    }
                }
            }));
        }
    }

    // Crash whichever node hosts the broker, every so often.
    let mut crashes = 0;
    for _ in 0..CRASHES {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        for queue in &nodes {
            if queue.abort_local_broker().await {
                crashes += 1;
            }
        }
    }

    for pusher in pushers {
        pusher.await.unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    while history.outstanding() > 0 {
        assert!(
            Instant::now() < deadline,
            "{} jobs never completed",
            history.outstanding()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    stop.store(true, Ordering::SeqCst);
    for worker in workers {
        worker.await.unwrap();
    }

    // Every acknowledged push completed, exactly once.
    let pushed = history.pushed.lock().unwrap().clone();
    let completed = history.completed.lock().unwrap().clone();
    assert_eq!(pushed.len(), NODES * JOBS_PER_NODE);
    for id in &pushed {
        let times = completed.get(id).map_or(0, Vec::len);
        assert_eq!(times, 1, "job {id} completed {times} times");
    }

    // No claim sent after a job's completion was acknowledged got that job.
    let claims = history.claims.lock().unwrap().clone();
    for (id, sent) in &claims {
        let done = completed[id][0];
        for &at in sent {
            assert!(
                at < done,
                "job {id} was claimed at tick {at}, after completing at {done}"
            );
        }
    }
    let reclaimed = claims.values().filter(|sent| sent.len() > 1).count();
    assert!(reclaimed > 0, "no abandoned job was claimed again");

    let state = file(&key).await;
    assert!(
        state.jobs.is_empty(),
        "{} jobs left in the file",
        state.jobs.len()
    );
    assert!(state.broker.is_some());
    assert!(crashes >= 2, "only {crashes} broker crashes");

    // The campaign really did fail writes that had taken effect, and fail
    // others before they did, so the run exercised ambiguous commits.
    let log = std::fs::read_to_string(var("CHAOS3_LOG")).unwrap();
    let errors_at = |boundary: &str| {
        log.lines()
            .filter(|line| line.contains(&format!("boundary={boundary} ")))
            .filter(|line| line.contains("action=Error"))
            .count()
    };
    let after_commit = errors_at("s3.put_object.after_commit");
    let before = errors_at("s3.put_object.before");
    eprintln!(
        "chaos: {crashes} crashes, {reclaimed} jobs claimed again, \
         {after_commit} PutObject errors after commit, {before} before"
    );
    assert!(after_commit > 0, "no PutObject failed after committing");
    assert!(before > 0, "no PutObject failed before committing");
}
