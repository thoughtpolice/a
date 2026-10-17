// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Operations, the queues they wait in, and the workers that run them.
//!
//! This is the scheduler without its network services: clients
//! [`submit`](Scheduler::submit) actions and watch their [`Stage`]; workers
//! [`connect`](Scheduler::connect) and are sent actions to run, at most one
//! per slot, which they report [`finished`](Scheduler::finished). Everything
//! is in memory, as in Buildbarn's scheduler: a restart loses the queue, and
//! clients execute their actions again.
//!
//! Actions queue by [`Requirements`], oldest first, and a worker with a free
//! slot takes the oldest action of any queue it can run. Identical cacheable
//! actions submitted while one is under way share it. An action whose last
//! client stops waiting is dropped from its queue, or stopped on its worker.
//! An action whose worker goes away is queued again, a limited number of
//! times. An action no connected worker can run fails, once that has been
//! so for a grace period, which rides out a worker reconnecting.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime};

use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use gonzo_protos::worker::v1::{
    Assign, Cancel, Hello, SchedulerMessage, scheduler_message::Message,
};
use protos::build::bazel::remote::execution::v2::{Action, Command, Digest, ExecuteResponse};
use protos::google::rpc::{Code, Status};

use crate::platform::{Offer, Requirements};

/// How the scheduler treats actions and workers.
#[derive(Clone, Debug)]
pub struct Config {
    /// How long an action may wait while no connected worker can run it.
    pub unmatched_grace: Duration,
    /// How many times an action may be handed to a worker that then goes
    /// away before it fails.
    pub max_attempts: u32,
    /// How long a finished operation can still be looked up by name.
    pub keep_finished: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            unmatched_grace: Duration::from_secs(30),
            max_attempts: 2,
            keep_finished: Duration::from_secs(60),
        }
    }
}

/// An action to execute, as read from the CAS.
#[derive(Debug)]
pub struct Job {
    /// A `DigestFunction.Value`.
    pub digest_function: i32,
    pub action_digest: Digest,
    pub action: Action,
    pub command: Command,
    pub requirements: Requirements,
}

impl Job {
    /// Whether the action's result may be cached, and so shared with
    /// identical actions submitted while it runs.
    pub fn cacheable(&self) -> bool {
        !self.action.do_not_cache
    }

    fn key(&self) -> ActionKey {
        (
            self.digest_function,
            self.action_digest.hash.clone(),
            self.action_digest.size_bytes,
        )
    }
}

/// Identical actions: same digest function and action digest.
type ActionKey = (i32, String, i64);

/// Where an operation is.
#[derive(Clone, Debug)]
pub enum Stage {
    Queued,
    Executing,
    Completed(Arc<ExecuteResponse>),
}

impl Stage {
    pub fn is_completed(&self) -> bool {
        matches!(self, Stage::Completed(_))
    }
}

/// A worker's handle on the scheduler, for as long as it is connected.
pub type WorkerId = u64;

/// One client's interest in an operation. Dropping it stops the client
/// waiting, and dropping the last one for an unfinished operation cancels it.
#[derive(Debug)]
pub struct Subscription {
    pub name: String,
    pub job: Arc<Job>,
    pub stages: watch::Receiver<Stage>,
    _watching: Watching,
}

#[derive(Debug)]
struct Watching {
    scheduler: Weak<Mutex<State>>,
    name: String,
}

impl Drop for Watching {
    fn drop(&mut self) {
        if let Some(state) = self.scheduler.upgrade() {
            lock(&state).unwatch(&self.name);
        }
    }
}

/// See the module documentation. Cheap to clone.
#[derive(Clone, Debug)]
pub struct Scheduler {
    state: Arc<Mutex<State>>,
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Default)]
struct State {
    config: Config,
    /// Every operation, finished ones until they are pruned.
    operations: HashMap<String, Operation>,
    /// Unfinished cacheable operations, by action.
    in_flight: HashMap<ActionKey, String>,
    queues: BTreeMap<Requirements, Queue>,
    workers: HashMap<WorkerId, Worker>,
    next_worker: WorkerId,
    /// Orders operations across queues.
    next_seq: u64,
}

#[derive(Debug, Default)]
struct Queue {
    /// Operation names, oldest first, with their sequence numbers.
    waiting: VecDeque<(u64, String)>,
    /// Since when no connected worker could run this queue's actions.
    unmatched_since: Option<Instant>,
}

#[derive(Debug)]
struct Operation {
    job: Arc<Job>,
    seq: u64,
    queued_at: SystemTime,
    stage: watch::Sender<Stage>,
    watchers: usize,
    /// How many times it has been handed to a worker.
    attempts: u32,
    worker: Option<WorkerId>,
    finished_at: Option<Instant>,
}

#[derive(Debug)]
struct Worker {
    name: String,
    offer: Offer,
    slots: usize,
    /// Operations it has been given and not reported finished, including
    /// cancelled ones still stopping.
    running: HashSet<String>,
    to_worker: mpsc::UnboundedSender<SchedulerMessage>,
}

impl Scheduler {
    pub fn new(config: Config) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                config,
                ..Default::default()
            })),
        }
    }

    /// Queue `job`, or join the identical cacheable one already under way.
    pub fn submit(&self, job: Job) -> Subscription {
        let mut state = lock(&self.state);
        let name = match state.in_flight.get(&job.key()) {
            Some(name) if job.cacheable() => name.clone(),
            _ => state.enqueue(job),
        };
        state.dispatch();
        self.watch(&mut state, &name)
            .expect("the operation was just found or made")
    }

    /// Watch the operation called `name`, if there is one.
    pub fn subscribe(&self, name: &str) -> Option<Subscription> {
        self.watch(&mut lock(&self.state), name)
    }

    fn watch(&self, state: &mut State, name: &str) -> Option<Subscription> {
        let op = state.operations.get_mut(name)?;
        op.watchers += 1;
        Some(Subscription {
            name: name.to_string(),
            job: op.job.clone(),
            stages: op.stage.subscribe(),
            _watching: Watching {
                scheduler: Arc::downgrade(&self.state),
                name: name.to_string(),
            },
        })
    }

    /// The operation called `name` and where it is, without waiting on it.
    pub fn peek(&self, name: &str) -> Option<(Arc<Job>, Stage)> {
        let state = lock(&self.state);
        let op = state.operations.get(name)?;
        Some((op.job.clone(), op.stage.borrow().clone()))
    }

    /// Stop the operation called `name`, whoever is waiting for it.
    pub fn cancel(&self, name: &str) -> bool {
        // Cancelling frees no slot: a worker's stays taken until it says
        // it has stopped. So there is nothing new to dispatch.
        lock(&self.state).cancel(name)
    }

    /// Register a worker. Actions for it arrive on the receiver, until
    /// [`disconnect`](Self::disconnect).
    pub fn connect(&self, hello: &Hello) -> (WorkerId, mpsc::UnboundedReceiver<SchedulerMessage>) {
        let (to_worker, from_scheduler) = mpsc::unbounded_channel();
        let mut state = lock(&self.state);
        let id = state.next_worker;
        state.next_worker += 1;
        let worker = Worker {
            name: hello.name.clone(),
            offer: Offer::new(&hello.properties),
            slots: hello.slots.max(1) as usize,
            running: HashSet::new(),
            to_worker,
        };
        tracing::info!(
            worker = %worker.name,
            offer = %worker.offer,
            slots = worker.slots,
            version = %hello.version,
            "worker connected"
        );
        state.workers.insert(id, worker);
        state.dispatch();
        (id, from_scheduler)
    }

    /// The job a worker was given as `name`, if it is still the worker's.
    pub fn assigned(&self, worker: WorkerId, name: &str) -> Option<Arc<Job>> {
        let state = lock(&self.state);
        let op = state.operations.get(name)?;
        (op.worker == Some(worker) && !op.stage.borrow().is_completed()).then(|| op.job.clone())
    }

    /// A worker has stopped running `name`, with `response`. Frees its slot,
    /// and completes the operation if it was still the worker's.
    pub fn finished(&self, worker: WorkerId, name: &str, response: ExecuteResponse) {
        let mut state = lock(&self.state);
        let Some(w) = state.workers.get_mut(&worker) else {
            return;
        };
        if !w.running.remove(name) {
            tracing::warn!(worker = %w.name, operation = name, "worker finished an operation it was not running");
            return;
        }
        if state
            .operations
            .get(name)
            .is_some_and(|op| op.worker == Some(worker) && !op.stage.borrow().is_completed())
        {
            state.complete(name, response);
        }
        state.dispatch();
    }

    /// A worker has gone. Its unfinished operations queue again, or fail
    /// once they have lost too many workers.
    pub fn disconnect(&self, worker: WorkerId) {
        let mut state = lock(&self.state);
        let Some(w) = state.workers.remove(&worker) else {
            return;
        };
        tracing::info!(worker = %w.name, running = w.running.len(), "worker disconnected");
        let max_attempts = state.config.max_attempts;
        for name in w.running {
            let Some(op) = state.operations.get_mut(&name) else {
                continue;
            };
            if op.stage.borrow().is_completed() {
                continue;
            }
            op.worker = None;
            if op.attempts >= max_attempts {
                let message = format!(
                    "the action lost its worker {} times (last: {})",
                    op.attempts, w.name
                );
                state.complete(&name, failure(Code::Unavailable, message));
            } else {
                op.stage.send_replace(Stage::Queued);
                let (seq, requirements) = (op.seq, op.job.requirements.clone());
                // Back to the front, by its original place in line.
                let queue = state.queues.entry(requirements).or_default();
                let at = queue.waiting.partition_point(|(s, _)| *s < seq);
                queue.waiting.insert(at, (seq, name));
            }
        }
        state.dispatch();
    }

    /// Fail actions that no worker has been able to run for the grace
    /// period, and forget operations finished long enough ago.
    pub fn sweep(&self) {
        let mut state = lock(&self.state);
        state.sweep(Instant::now());
    }

    /// Run [`sweep`](Self::sweep) every second until the scheduler is
    /// dropped.
    pub fn spawn_sweeper(&self) {
        let state = Arc::downgrade(&self.state);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let Some(state) = state.upgrade() else {
                    return;
                };
                lock(&state).sweep(Instant::now());
            }
        });
    }
}

impl State {
    fn enqueue(&mut self, job: Job) -> String {
        let name = format!("operations/{}", uuid::Uuid::new_v4());
        let seq = self.next_seq;
        self.next_seq += 1;
        let job = Arc::new(job);
        if job.cacheable() {
            self.in_flight.insert(job.key(), name.clone());
        }
        self.queues
            .entry(job.requirements.clone())
            .or_default()
            .waiting
            .push_back((seq, name.clone()));
        self.operations.insert(
            name.clone(),
            Operation {
                job,
                seq,
                queued_at: SystemTime::now(),
                stage: watch::Sender::new(Stage::Queued),
                watchers: 0,
                attempts: 0,
                worker: None,
                finished_at: None,
            },
        );
        name
    }

    /// Hand queued actions to workers with free slots until none is left
    /// that any free worker can run.
    fn dispatch(&mut self) {
        loop {
            let mut assigned = false;
            for (&id, worker) in self.workers.iter_mut() {
                if worker.running.len() >= worker.slots {
                    continue;
                }
                // The oldest action of any queue this worker can run.
                let Some(queue) = self
                    .queues
                    .iter_mut()
                    .filter(|(req, queue)| !queue.waiting.is_empty() && worker.offer.satisfies(req))
                    .min_by_key(|(_, queue)| queue.waiting[0].0)
                    .map(|(_, queue)| queue)
                else {
                    continue;
                };
                let (_, name) = queue.waiting.pop_front().expect("queue is not empty");
                let op = self
                    .operations
                    .get_mut(&name)
                    .expect("queued operations exist");
                op.attempts += 1;
                op.worker = Some(id);
                op.stage.send_replace(Stage::Executing);
                worker.running.insert(name.clone());
                let assign = Assign {
                    operation: name.clone(),
                    digest_function: op.job.digest_function,
                    action_digest: Some(op.job.action_digest.clone()),
                    action: Some(op.job.action.clone()),
                    command: Some(op.job.command.clone()),
                    queued: Some(prost_types::Timestamp::from(op.queued_at)),
                };
                tracing::debug!(worker = %worker.name, operation = %name, "assigned");
                // A worker whose session has ended disconnects shortly, and
                // its actions queue again then.
                let _ = worker.to_worker.send(SchedulerMessage {
                    message: Some(Message::Assign(assign)),
                });
                assigned = true;
            }
            if !assigned {
                break;
            }
        }
    }

    fn complete(&mut self, name: &str, response: ExecuteResponse) {
        let Some(op) = self.operations.get_mut(name) else {
            return;
        };
        op.worker = None;
        op.finished_at = Some(Instant::now());
        op.stage.send_replace(Stage::Completed(Arc::new(response)));
        let key = op.job.key();
        if self.in_flight.get(&key).is_some_and(|n| n == name) {
            self.in_flight.remove(&key);
        }
    }

    fn unwatch(&mut self, name: &str) {
        let Some(op) = self.operations.get_mut(name) else {
            return;
        };
        op.watchers -= 1;
        if op.watchers == 0 && !op.stage.borrow().is_completed() {
            tracing::debug!(operation = name, "nobody is waiting; cancelling");
            self.cancel(name);
        }
    }

    fn cancel(&mut self, name: &str) -> bool {
        let Some(op) = self.operations.get(name) else {
            return false;
        };
        if op.stage.borrow().is_completed() {
            return true;
        }
        match op.worker {
            // Its slot stays taken until the worker says it has stopped.
            Some(id) => {
                if let Some(worker) = self.workers.get(&id) {
                    let _ = worker.to_worker.send(SchedulerMessage {
                        message: Some(Message::Cancel(Cancel {
                            operation: name.to_string(),
                        })),
                    });
                }
            }
            None => {
                if let Some(queue) = self.queues.get_mut(&op.job.requirements) {
                    queue.waiting.retain(|(_, n)| n != name);
                }
            }
        }
        self.complete(
            name,
            failure(Code::Cancelled, "the operation was cancelled"),
        );
        true
    }

    fn sweep(&mut self, now: Instant) {
        let grace = self.config.unmatched_grace;
        let mut expired = Vec::new();
        for (requirements, queue) in &mut self.queues {
            if queue.waiting.is_empty() {
                queue.unmatched_since = None;
                continue;
            }
            if self
                .workers
                .values()
                .any(|w| w.offer.satisfies(requirements))
            {
                queue.unmatched_since = None;
                continue;
            }
            let since = *queue.unmatched_since.get_or_insert(now);
            if now.duration_since(since) >= grace {
                queue.unmatched_since = None;
                expired.push((requirements.clone(), std::mem::take(&mut queue.waiting)));
            }
        }
        if !expired.is_empty() {
            let offers: Vec<String> = self
                .workers
                .values()
                .map(|w| format!("{} ({})", w.name, w.offer))
                .collect();
            let workers = if offers.is_empty() {
                "no workers are connected".to_string()
            } else {
                format!("connected workers: {}", offers.join("; "))
            };
            for (requirements, waiting) in expired {
                let message = format!(
                    "no worker can run an action requiring {requirements} \
                     ({workers})"
                );
                tracing::warn!("{message}");
                for (_, name) in waiting {
                    self.complete(&name, failure(Code::FailedPrecondition, message.clone()));
                }
            }
        }
        self.queues.retain(|_, queue| !queue.waiting.is_empty());

        let keep = self.config.keep_finished;
        self.operations.retain(|_, op| {
            op.finished_at
                .is_none_or(|at| now.duration_since(at) < keep)
        });
    }
}

/// A response for an action that did not run to completion.
pub fn failure(code: Code, message: impl Into<String>) -> ExecuteResponse {
    ExecuteResponse {
        status: Some(Status {
            code: code as i32,
            message: message.into(),
            details: Vec::new(),
        }),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use protos::build::bazel::remote::execution::v2::{ActionResult, Platform, platform::Property};

    fn properties(pairs: &[(&str, &str)]) -> Vec<Property> {
        pairs
            .iter()
            .map(|(name, value)| Property {
                name: name.to_string(),
                value: value.to_string(),
            })
            .collect()
    }

    fn job(hash: &str, arch: &str) -> Job {
        let platform = Platform {
            properties: properties(&[("Arch", arch)]),
        };
        Job {
            digest_function: 1,
            action_digest: Digest {
                hash: hash.to_string(),
                size_bytes: 1,
            },
            action: Action {
                platform: Some(platform.clone()),
                ..Default::default()
            },
            command: Command::default(),
            requirements: Requirements::new(Some(&platform)),
        }
    }

    fn hello(name: &str, arch: &str, slots: u32) -> Hello {
        Hello {
            name: name.to_string(),
            properties: properties(&[("Arch", arch)]),
            slots,
            version: "test".to_string(),
        }
    }

    fn ok(exit_code: i32) -> ExecuteResponse {
        ExecuteResponse {
            result: Some(ActionResult {
                exit_code,
                ..Default::default()
            }),
            status: Some(Status::default()),
            ..Default::default()
        }
    }

    /// The operations sent to a worker so far, by kind.
    fn drain(rx: &mut mpsc::UnboundedReceiver<SchedulerMessage>) -> (Vec<String>, Vec<String>) {
        let (mut assigned, mut cancelled) = (Vec::new(), Vec::new());
        while let Ok(message) = rx.try_recv() {
            match message.message {
                Some(Message::Assign(a)) => assigned.push(a.operation),
                Some(Message::Cancel(c)) => cancelled.push(c.operation),
                None => {}
            }
        }
        (assigned, cancelled)
    }

    fn stage(sub: &Subscription) -> Stage {
        sub.stages.borrow().clone()
    }

    fn code(stage: &Stage) -> Option<i32> {
        match stage {
            Stage::Completed(response) => response.status.as_ref().map(|s| s.code),
            _ => None,
        }
    }

    #[tokio::test]
    async fn actions_go_to_workers_that_can_run_them() {
        let scheduler = Scheduler::new(Config::default());
        let (amd64, mut amd64_rx) = scheduler.connect(&hello("amd64", "amd64", 4));
        let (arm64, mut arm64_rx) = scheduler.connect(&hello("arm64", "arm64", 4));

        let a = scheduler.submit(job("a", "amd64"));
        let b = scheduler.submit(job("b", "arm64"));
        assert_eq!(drain(&mut amd64_rx).0, [a.name.clone()]);
        assert_eq!(drain(&mut arm64_rx).0, [b.name.clone()]);
        assert!(matches!(stage(&a), Stage::Executing));

        assert_eq!(
            scheduler
                .assigned(amd64, &a.name)
                .unwrap()
                .action_digest
                .hash,
            "a"
        );
        assert!(
            scheduler.assigned(arm64, &a.name).is_none(),
            "not that worker's"
        );
        scheduler.finished(amd64, &a.name, ok(0));
        let Stage::Completed(response) = stage(&a) else {
            panic!("completed");
        };
        assert_eq!(response.result.as_ref().unwrap().exit_code, 0);
    }

    #[tokio::test]
    async fn a_worker_runs_as_many_actions_as_it_has_slots_oldest_first() {
        let scheduler = Scheduler::new(Config::default());
        let subs: Vec<_> = (0..3)
            .map(|i| scheduler.submit(job(&format!("{i}"), "amd64")))
            .collect();
        let (worker, mut rx) = scheduler.connect(&hello("w", "amd64", 2));
        assert_eq!(
            drain(&mut rx).0,
            [subs[0].name.clone(), subs[1].name.clone()]
        );
        assert!(matches!(stage(&subs[2]), Stage::Queued));

        scheduler.finished(worker, &subs[1].name, ok(0));
        assert_eq!(drain(&mut rx).0, [subs[2].name.clone()]);
    }

    #[tokio::test]
    async fn identical_cacheable_actions_share_one_execution() {
        let scheduler = Scheduler::new(Config::default());
        let first = scheduler.submit(job("same", "amd64"));
        let second = scheduler.submit(job("same", "amd64"));
        assert_eq!(first.name, second.name);

        let mut uncacheable = job("same", "amd64");
        uncacheable.action.do_not_cache = true;
        let third = scheduler.submit(uncacheable);
        assert_ne!(third.name, first.name);

        let (worker, mut rx) = scheduler.connect(&hello("w", "amd64", 4));
        assert_eq!(drain(&mut rx).0.len(), 2);
        scheduler.finished(worker, &first.name, ok(0));
        assert!(stage(&second).is_completed());

        // Once it is done, the same action runs anew.
        let fourth = scheduler.submit(job("same", "amd64"));
        assert_ne!(fourth.name, first.name);
    }

    #[tokio::test]
    async fn an_action_nobody_waits_for_is_cancelled() {
        let scheduler = Scheduler::new(Config::default());
        let (worker, mut rx) = scheduler.connect(&hello("w", "amd64", 1));
        let running = scheduler.submit(job("running", "amd64"));
        let queued = scheduler.submit(job("queued", "amd64"));
        let also_running = scheduler.subscribe(&running.name).expect("exists");
        assert_eq!(drain(&mut rx).0, [running.name.clone()]);

        // A queued action leaves its queue.
        let queued_name = queued.name.clone();
        drop(queued);
        assert!(
            code(
                &scheduler
                    .subscribe(&queued_name)
                    .map(|s| stage(&s))
                    .unwrap()
            )
            .is_some()
        );

        // A running one is stopped, once its last client goes.
        let name = running.name.clone();
        drop(running);
        assert_eq!(drain(&mut rx).1, Vec::<String>::new());
        drop(also_running);
        assert_eq!(drain(&mut rx).1, [name.clone()]);

        // Its slot is taken until the worker says it has stopped.
        let next = scheduler.submit(job("next", "amd64"));
        assert!(drain(&mut rx).0.is_empty());
        scheduler.finished(worker, &name, failure(Code::Cancelled, "stopped"));
        assert_eq!(drain(&mut rx).0, [next.name.clone()]);
    }

    #[tokio::test]
    async fn actions_of_a_lost_worker_queue_again_then_fail() {
        let scheduler = Scheduler::new(Config::default());
        let early = scheduler.submit(job("early", "amd64"));
        let late = scheduler.submit(job("late", "amd64"));

        let (first, mut rx) = scheduler.connect(&hello("first", "amd64", 1));
        assert_eq!(drain(&mut rx).0, [early.name.clone()]);
        scheduler.disconnect(first);
        assert!(matches!(stage(&early), Stage::Queued));

        // Back at the front of the line, ahead of the later action.
        let (second, mut rx) = scheduler.connect(&hello("second", "amd64", 1));
        assert_eq!(drain(&mut rx).0, [early.name.clone()]);
        scheduler.disconnect(second);
        assert_eq!(code(&stage(&early)), Some(Code::Unavailable as i32));

        let (_third, mut rx) = scheduler.connect(&hello("third", "amd64", 1));
        assert_eq!(drain(&mut rx).0, [late.name.clone()]);
    }

    #[tokio::test(start_paused = true)]
    async fn an_action_no_worker_can_run_fails_after_the_grace_period() {
        let config = Config::default();
        let scheduler = Scheduler::new(config.clone());
        let (_amd64, _rx) = scheduler.connect(&hello("amd64", "amd64", 1));
        let stranded = scheduler.submit(job("stranded", "arm64"));
        let rescued = scheduler.submit(job("rescued", "riscv64"));

        scheduler.sweep();
        tokio::time::advance(config.unmatched_grace / 2).await;
        let (_riscv, mut riscv_rx) = scheduler.connect(&hello("riscv", "riscv64", 1));
        assert_eq!(drain(&mut riscv_rx).0, [rescued.name.clone()]);
        scheduler.sweep();
        assert!(!stage(&stranded).is_completed());

        tokio::time::advance(config.unmatched_grace / 2).await;
        scheduler.sweep();
        assert_eq!(
            code(&stage(&stranded)),
            Some(Code::FailedPrecondition as i32)
        );
        let Stage::Completed(response) = stage(&stranded) else {
            unreachable!()
        };
        let message = &response.status.as_ref().unwrap().message;
        assert!(
            message.contains("Arch=arm64") && message.contains("amd64 (Arch=amd64)"),
            "{message}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn finished_operations_are_forgotten_after_a_while() {
        let config = Config::default();
        let scheduler = Scheduler::new(config.clone());
        let (worker, _rx) = scheduler.connect(&hello("w", "amd64", 1));
        let sub = scheduler.submit(job("a", "amd64"));
        scheduler.finished(worker, &sub.name, ok(0));

        let waiting = scheduler.subscribe(&sub.name).expect("still there");
        assert!(stage(&waiting).is_completed());
        tokio::time::advance(config.keep_finished).await;
        scheduler.sweep();
        assert!(scheduler.subscribe(&sub.name).is_none());
    }
}
