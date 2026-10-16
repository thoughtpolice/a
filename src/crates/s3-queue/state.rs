// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The queue file and the operations the broker applies to it.
//!
//! Everything here is pure. The broker applies a batch of operations to a
//! copy of the state it last read or wrote, writes the copy back with a
//! compare-and-set, and only then answers the batch.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use crate::protocol::{BrokerInfo, ClaimedJob};

/// The format version this crate reads and writes.
pub const FORMAT_VERSION: u32 = 1;

/// The whole queue, as it is stored in one object.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueState {
    pub version: u32,
    /// The broker clients should send requests to. Only the broker named
    /// here writes the file, apart from a new broker taking over.
    pub broker: Option<BrokerInfo>,
    /// Every job not yet completed, in push order.
    pub jobs: Vec<Job>,
    /// The most recently completed jobs, oldest first. A retried push of
    /// one of these is already done, and a retried completion has already
    /// happened.
    #[serde(default)]
    pub done: VecDeque<Done>,
}

/// A completed job, remembered so retries are recognized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Done {
    pub id: String,
    /// The claim that completed it. Only a retry from that claim is told
    /// the completion succeeded; any other claim lost the job.
    pub token: String,
}

/// One job in the queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Job {
    /// Chosen by the pusher, so a retried push is recognized.
    pub id: String,
    pub payload: String,
    /// Broker wall-clock milliseconds since the Unix epoch.
    pub pushed_at: u64,
    /// How many times a worker has claimed this job.
    pub attempts: u32,
    pub claim: Option<Claim>,
}

/// A worker's hold on a job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    /// Chosen by the worker, so a retried claim finds the job it already
    /// holds, and a heartbeat or completion from an older claim is refused.
    pub token: String,
    pub worker: String,
    pub claimed_at: u64,
    /// The last heartbeat the broker committed, in broker wall-clock
    /// milliseconds. It is a record for people reading the file; brokers
    /// time leases with their own monotonic clock (see [`Leases`]).
    pub heartbeat_at: u64,
}

/// A request a client makes of the broker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Push { id: String, payload: String },
    Claim { worker: String, token: String },
    Heartbeat { id: String, token: String },
    Complete { id: String, token: String },
}

/// The answer to one [`Op`], once the state it was applied to is durable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Pushed,
    Claimed(ClaimedJob),
    /// No job is available to claim right now.
    Empty,
    /// The heartbeat or completion was recorded.
    Done,
    /// This claim no longer holds the job. Its lease ran out and another
    /// worker claimed it, or the job never existed.
    Lost,
}

/// When each claim's lease started, by the broker's monotonic clock.
///
/// Leases start when the broker first sees a claim, either by granting it
/// or by loading a file that already holds it, and restart with every
/// heartbeat. A broker that takes over therefore gives every existing claim
/// a full lease, so neither clock skew between brokers nor the time workers
/// spent finding the new broker can expire a live worker's claim.
#[derive(Debug, Clone, Default)]
pub struct Leases {
    started: HashMap<(String, String), Instant>,
}

impl Leases {
    /// Track exactly the claims in `state`, starting a lease at `now` for
    /// any not already tracked.
    pub fn sync(&mut self, state: &QueueState, now: Instant) {
        let mut started = HashMap::with_capacity(self.started.len());
        for job in &state.jobs {
            if let Some(claim) = &job.claim {
                let key = (job.id.clone(), claim.token.clone());
                let at = self.started.get(&key).copied().unwrap_or(now);
                started.insert(key, at);
            }
        }
        self.started = started;
    }

    fn renew(&mut self, id: &str, token: &str, now: Instant) {
        self.started
            .insert((id.to_string(), token.to_string()), now);
    }

    fn expired(&self, id: &str, claim: &Claim, now: Instant, lease: Duration) -> bool {
        match self.started.get(&(id.to_string(), claim.token.clone())) {
            Some(at) => now.saturating_duration_since(*at) >= lease,
            None => false,
        }
    }

    /// When the earliest lease in `state` runs out, if any claim holds one.
    pub fn next_expiry(&self, lease: Duration) -> Option<Instant> {
        self.started.values().min().map(|at| *at + lease)
    }
}

/// What the broker needs to know to apply operations.
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    /// Monotonic time, for leases.
    pub now: Instant,
    /// Wall-clock milliseconds since the Unix epoch, for the record.
    pub wall_ms: u64,
}

/// Limits the broker applies.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// How long a claim lasts without a heartbeat.
    pub lease: Duration,
    /// How many completed job IDs the file remembers.
    pub done_capacity: usize,
}

impl QueueState {
    /// An empty queue.
    pub fn new() -> Self {
        Self {
            version: FORMAT_VERSION,
            ..Default::default()
        }
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("queue state always serializes")
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.jobs.iter().position(|job| job.id == id)
    }

    fn is_done(&self, id: &str) -> bool {
        self.done.iter().any(|done| done.id == id)
    }

    /// Apply `op`, returning its outcome, or `None` for a claim that found
    /// no job, which the broker may hold until one turns up.
    pub fn apply(
        &mut self,
        op: &Op,
        clock: Clock,
        limits: Limits,
        leases: &mut Leases,
    ) -> Option<Outcome> {
        Some(match op {
            Op::Push { id, payload } => {
                if self.position(id).is_none() && !self.is_done(id) {
                    self.jobs.push(Job {
                        id: id.clone(),
                        payload: payload.clone(),
                        pushed_at: clock.wall_ms,
                        attempts: 0,
                        claim: None,
                    });
                }
                Outcome::Pushed
            }
            Op::Claim { worker, token } => {
                // A retried claim gets the job it already holds.
                if let Some(job) = self
                    .jobs
                    .iter()
                    .find(|job| job.claim.as_ref().is_some_and(|c| &c.token == token))
                {
                    return Some(Outcome::Claimed(claimed(job)));
                }
                // The oldest job no live claim holds, so jobs run in push
                // order and an abandoned job is picked up before newer ones.
                let job = self.jobs.iter_mut().find(|job| match &job.claim {
                    None => true,
                    Some(claim) => leases.expired(&job.id, claim, clock.now, limits.lease),
                })?;
                job.attempts += 1;
                job.claim = Some(Claim {
                    token: token.clone(),
                    worker: worker.clone(),
                    claimed_at: clock.wall_ms,
                    heartbeat_at: clock.wall_ms,
                });
                leases.renew(&job.id, token, clock.now);
                Outcome::Claimed(claimed(job))
            }
            Op::Heartbeat { id, token } => match self.held(id, token) {
                Some(index) => {
                    let claim = self.jobs[index].claim.as_mut().expect("held");
                    claim.heartbeat_at = clock.wall_ms;
                    leases.renew(id, token, clock.now);
                    Outcome::Done
                }
                None => Outcome::Lost,
            },
            Op::Complete { id, token } => match self.held(id, token) {
                Some(index) => {
                    self.jobs.remove(index);
                    self.done.push_back(Done {
                        id: id.clone(),
                        token: token.clone(),
                    });
                    while self.done.len() > limits.done_capacity {
                        self.done.pop_front();
                    }
                    Outcome::Done
                }
                // A retried completion finds its first attempt done.
                None if self.done.iter().any(|d| &d.id == id && &d.token == token) => Outcome::Done,
                None => Outcome::Lost,
            },
        })
    }

    /// The index of job `id` if the claim `token` still holds it.
    fn held(&self, id: &str, token: &str) -> Option<usize> {
        self.position(id).filter(|&index| {
            self.jobs[index]
                .claim
                .as_ref()
                .is_some_and(|claim| claim.token == token)
        })
    }

    /// Whether some job could be claimed at `now`.
    pub fn claimable(&self, now: Instant, lease: Duration, leases: &Leases) -> bool {
        self.jobs.iter().any(|job| match &job.claim {
            None => true,
            Some(claim) => leases.expired(&job.id, claim, now, lease),
        })
    }
}

fn claimed(job: &Job) -> ClaimedJob {
    let claim = job.claim.as_ref().expect("claimed jobs have a claim");
    ClaimedJob {
        id: job.id.clone(),
        payload: job.payload.clone(),
        token: claim.token.clone(),
        attempts: job.attempts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: Limits = Limits {
        lease: Duration::from_secs(10),
        done_capacity: 3,
    };

    struct Harness {
        state: QueueState,
        leases: Leases,
        start: Instant,
    }

    impl Harness {
        fn new() -> Self {
            Self {
                state: QueueState::new(),
                leases: Leases::default(),
                start: Instant::now(),
            }
        }

        fn at(&mut self, secs: u64, op: Op) -> Option<Outcome> {
            let clock = Clock {
                now: self.start + Duration::from_secs(secs),
                wall_ms: 1_000 * secs,
            };
            self.state.apply(&op, clock, LIMITS, &mut self.leases)
        }
    }

    fn push(id: &str) -> Op {
        Op::Push {
            id: id.into(),
            payload: format!("payload of {id}"),
        }
    }

    fn claim(token: &str) -> Op {
        Op::Claim {
            worker: format!("worker {token}"),
            token: token.into(),
        }
    }

    fn heartbeat(id: &str, token: &str) -> Op {
        Op::Heartbeat {
            id: id.into(),
            token: token.into(),
        }
    }

    fn complete(id: &str, token: &str) -> Op {
        Op::Complete {
            id: id.into(),
            token: token.into(),
        }
    }

    fn claimed_id(outcome: Option<Outcome>) -> String {
        match outcome {
            Some(Outcome::Claimed(job)) => job.id,
            other => panic!("expected a claimed job, got {other:?}"),
        }
    }

    #[test]
    fn claims_hand_out_jobs_in_push_order() {
        let mut h = Harness::new();
        for id in ["a", "b", "c"] {
            assert_eq!(h.at(0, push(id)), Some(Outcome::Pushed));
        }
        assert_eq!(claimed_id(h.at(1, claim("t1"))), "a");
        assert_eq!(claimed_id(h.at(1, claim("t2"))), "b");
        assert_eq!(claimed_id(h.at(1, claim("t3"))), "c");
        assert_eq!(h.at(1, claim("t4")), None, "nothing left to claim");
    }

    #[test]
    fn retried_pushes_and_claims_are_recognized() {
        let mut h = Harness::new();
        h.at(0, push("a"));
        h.at(0, push("a"));
        assert_eq!(h.state.jobs.len(), 1);

        assert_eq!(claimed_id(h.at(1, claim("t1"))), "a");
        // The same token again is the same claim, not a second one.
        assert_eq!(claimed_id(h.at(2, claim("t1"))), "a");
        assert_eq!(h.state.jobs[0].attempts, 1);

        assert_eq!(h.at(3, complete("a", "t1")), Some(Outcome::Done));
        assert_eq!(h.at(4, complete("a", "t1")), Some(Outcome::Done));
        // A push retried after the job finished does not run it again.
        h.at(5, push("a"));
        assert!(h.state.jobs.is_empty());
    }

    #[test]
    fn an_expired_claim_passes_to_the_next_worker() {
        let mut h = Harness::new();
        h.at(0, push("a"));
        h.at(0, push("b"));
        assert_eq!(claimed_id(h.at(0, claim("t1"))), "a");
        assert_eq!(h.at(5, heartbeat("a", "t1")), Some(Outcome::Done));
        // The heartbeat at 5s holds the lease until 15s.
        assert_eq!(claimed_id(h.at(14, claim("t2"))), "b");
        assert_eq!(h.at(14, claim("t3")), None);
        assert_eq!(claimed_id(h.at(15, claim("t3"))), "a");
        assert_eq!(h.state.jobs[0].attempts, 2);

        // The first worker is fenced off.
        assert_eq!(h.at(16, heartbeat("a", "t1")), Some(Outcome::Lost));
        assert_eq!(h.at(16, complete("a", "t1")), Some(Outcome::Lost));
        assert_eq!(h.at(16, complete("a", "t3")), Some(Outcome::Done));
        // Once the job is done, only the claim that finished it hears so.
        assert_eq!(h.at(17, complete("a", "t3")), Some(Outcome::Done));
        assert_eq!(h.at(17, complete("a", "t1")), Some(Outcome::Lost));
    }

    #[test]
    fn a_new_broker_gives_existing_claims_a_full_lease() {
        let mut h = Harness::new();
        h.at(0, push("a"));
        h.at(0, claim("t1"));

        // Another broker loads the file 100s later. The claim's heartbeat
        // is ancient by the file's clock, but its lease starts now.
        let mut leases = Leases::default();
        let loaded = h.start + Duration::from_secs(100);
        leases.sync(&h.state, loaded);
        let clock = |secs| Clock {
            now: loaded + Duration::from_secs(secs),
            wall_ms: 1_000 * (100 + secs),
        };
        assert!(!h.state.claimable(clock(9).now, LIMITS.lease, &leases));
        assert_eq!(
            h.state.apply(&claim("t2"), clock(9), LIMITS, &mut leases),
            None
        );
        assert!(h.state.claimable(clock(10).now, LIMITS.lease, &leases));
        assert_eq!(
            claimed_id(h.state.apply(&claim("t2"), clock(10), LIMITS, &mut leases)),
            "a"
        );
    }

    #[test]
    fn the_done_list_keeps_only_the_newest_ids() {
        let mut h = Harness::new();
        for (i, id) in ["a", "b", "c", "d"].into_iter().enumerate() {
            let token = format!("t{i}");
            h.at(0, push(id));
            assert_eq!(claimed_id(h.at(0, claim(&token))), id);
            h.at(0, complete(id, &token));
        }
        let done: Vec<&str> = h.state.done.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(done, ["b", "c", "d"]);
    }

    #[test]
    fn unknown_jobs_are_lost() {
        let mut h = Harness::new();
        assert_eq!(h.at(0, heartbeat("x", "t")), Some(Outcome::Lost));
        assert_eq!(h.at(0, complete("x", "t")), Some(Outcome::Lost));
    }

    #[test]
    fn the_file_round_trips_through_json() {
        let mut h = Harness::new();
        h.state.broker = Some(BrokerInfo {
            id: "b1".into(),
            addr: "http://127.0.0.1:1".into(),
        });
        h.at(0, push("a"));
        h.at(0, push("b"));
        h.at(1, claim("t1"));
        let bytes = h.state.to_json();
        assert_eq!(QueueState::from_json(&bytes).unwrap(), h.state);
    }
}
