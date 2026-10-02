// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! How operations (steps of a workload) are issued, and what they did.
//!
//! Three system models, as Schroeder, Wierman, and Harchol-Balter define
//! them in "Open Versus Closed: A Cautionary Tale" (NSDI '06):
//!
//! - **Closed**: `concurrency` workers each issue an operation, wait for
//!   it, think, and issue the next. Work arrives only as work completes, so
//!   a slower server is simply offered less, and no more than `concurrency`
//!   operations ever queue: under heavy load, response times come out far
//!   lower than arrivals that do not wait their turn would see.
//! - **Open**: operations arrive at a rate (a Poisson process unless asked
//!   otherwise) whether or not earlier ones are done, as requests from many
//!   independent clients do. Queues grow without bound as the load nears
//!   what the server can do.
//! - **Partly open**: sessions arrive as the open model's operations do,
//!   and each issues a geometrically distributed number of operations one
//!   after another, thinking between them. Sessions of one operation are the
//!   open model; long ones behave like the closed model.
//!
//! In the open models an operation's response time runs from when it was
//! due, not from when it was sent: time spent waiting on the generator (for
//! a free slot, or a late dispatch) counts like time in any other queue, so
//! a server that falls behind cannot hide it by holding the generator back.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::data::Rng;
use crate::hist::Histogram;

/// What one kind of RPC did.
#[derive(Default, Clone)]
pub struct OpStats {
    pub latency: Histogram,
    pub ok: u64,
    pub bytes: u64,
    pub errors: BTreeMap<String, u64>,
}

/// What a slot's operations did.
pub struct Recorder {
    /// Each RPC, from when it was sent.
    pub ops: BTreeMap<&'static str, OpStats>,
    /// Each operation, from when it arrived (was due) to its completion.
    pub response: Histogram,
    /// How long after it was due each arrival started (open models).
    pub late: Histogram,
    pub verified: u64,
    pub verify_failures: u64,
    pub first_failures: Vec<String>,
    /// When the operation under way arrived.
    pub arrived: Instant,
    /// Whether the operation under way counts: it arrived after the warm-up.
    /// Verification counts regardless.
    measuring: bool,
    /// When the last operation that counts completed.
    last_done: Option<Instant>,
    progress: Option<Arc<AtomicU64>>,
}

impl Default for Recorder {
    fn default() -> Self {
        Self {
            ops: BTreeMap::new(),
            response: Histogram::default(),
            late: Histogram::default(),
            verified: 0,
            verify_failures: 0,
            first_failures: Vec::new(),
            arrived: Instant::now(),
            measuring: true,
            last_done: None,
            progress: None,
        }
    }
}

impl Recorder {
    fn new(progress: Arc<AtomicU64>) -> Self {
        Self {
            progress: Some(progress),
            ..Self::default()
        }
    }

    fn tick(&self) {
        if let Some(p) = &self.progress {
            p.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn ok(&mut self, op: &'static str, started: Instant, bytes: u64) {
        self.tick();
        if !self.measuring {
            return;
        }
        let s = self.ops.entry(op).or_default();
        s.latency.record(started.elapsed().as_nanos() as u64);
        s.ok += 1;
        s.bytes += bytes;
    }

    pub fn err(&mut self, op: &'static str, started: Instant, status: &tonic::Status) {
        self.tick();
        if !self.measuring {
            return;
        }
        let s = self.ops.entry(op).or_default();
        s.latency.record(started.elapsed().as_nanos() as u64);
        let mut msg: String = status.message().chars().take(80).collect();
        if msg.is_empty() {
            msg = "(no message)".into();
        }
        *s.errors
            .entry(format!("{:?}: {msg}", status.code()))
            .or_default() += 1;
    }

    /// Record the outcome of `op`, started at `started`.
    pub fn result<T>(
        &mut self,
        op: &'static str,
        started: Instant,
        result: &Result<T, tonic::Status>,
        bytes: impl FnOnce(&T) -> u64,
    ) {
        match result {
            Ok(v) => self.ok(op, started, bytes(v)),
            Err(status) => self.err(op, started, status),
        }
    }

    pub fn verify(&mut self, ok: bool, what: impl FnOnce() -> String) {
        if ok {
            self.verified += 1;
        } else {
            self.verify_failures += 1;
            if self.first_failures.len() < 10 {
                self.first_failures.push(what());
            }
        }
    }

    /// Begin an operation that arrived at `arrived`, counting it if
    /// `measured`.
    fn begin(&mut self, arrived: Instant, measured: bool) {
        self.arrived = arrived;
        self.measuring = measured;
    }

    /// Complete the operation begun last.
    fn finish(&mut self) {
        if self.measuring {
            let now = Instant::now();
            self.response.record((now - self.arrived).as_nanos() as u64);
            self.last_done = Some(self.last_done.map_or(now, |t| t.max(now)));
        }
    }

    pub fn merge(&mut self, other: Recorder) {
        for (op, s) in other.ops {
            let mine = self.ops.entry(op).or_default();
            mine.latency.merge(&s.latency);
            mine.ok += s.ok;
            mine.bytes += s.bytes;
            for (e, n) in s.errors {
                *mine.errors.entry(e).or_default() += n;
            }
        }
        self.response.merge(&other.response);
        self.late.merge(&other.late);
        self.verified += other.verified;
        self.verify_failures += other.verify_failures;
        for f in other.first_failures {
            if self.first_failures.len() < 10 {
                self.first_failures.push(f);
            }
        }
        self.last_done = self.last_done.max(other.last_done);
    }
}

/// A load to apply: each slot keeps a `State` and runs `step`, one
/// operation, whenever the model issues one.
pub trait Workload: Send + Sync + 'static {
    type State: Send + 'static;

    /// The state of slot `worker`; slots are numbered from 0 and never
    /// reused for another, so `worker` keeps the slots' streams apart.
    fn state(&self, worker: usize) -> Self::State;

    fn step<'a>(
        &'a self,
        state: &'a mut Self::State,
        rec: &'a mut Recorder,
    ) -> impl Future<Output = ()> + Send + 'a;
}

/// How arrivals are spaced.
#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum Arrivals {
    /// Exponential gaps: arrivals from many independent clients.
    Poisson,
    /// Equal gaps.
    Uniform,
}

/// How operations are issued.
#[derive(Clone, Debug)]
pub enum Model {
    /// `concurrency` workers, each issuing an operation once its last one
    /// completes and it has thought for an exponential time of mean `think`.
    Closed { concurrency: usize, think: Duration },
    /// Sessions arriving at a rate; see [`Sessions`].
    Sessions(Sessions),
}

/// The open and partly-open models.
#[derive(Clone, Debug)]
pub struct Sessions {
    /// Sessions per second.
    pub rate: f64,
    pub arrivals: Arrivals,
    /// Mean operations per session (geometric); 1 is the open model.
    pub length: f64,
    /// Mean think time (exponential) between a session's operations.
    pub think: Duration,
    /// Most sessions under way at once. An arrival that finds them all busy
    /// waits for one to end, and the wait counts in its response time.
    pub max_in_flight: usize,
}

impl Model {
    pub fn describe(&self) -> String {
        match self {
            Model::Closed { concurrency, think } => {
                let mut s = format!("closed, {concurrency} workers");
                if !think.is_zero() {
                    s += &format!(", {} think", fmt_ns(think.as_nanos() as u64));
                }
                s
            }
            Model::Sessions(s) => {
                let arrivals = match s.arrivals {
                    Arrivals::Poisson => "Poisson",
                    Arrivals::Uniform => "uniform",
                };
                if s.length == 1.0 {
                    format!("open, {} arrivals/s ({arrivals})", s.rate)
                } else {
                    format!(
                        "partly open, {} sessions/s ({arrivals}) of {} operations, {} think",
                        s.rate,
                        s.length,
                        fmt_ns(s.think.as_nanos() as u64)
                    )
                }
            }
        }
    }

    /// Operations per second offered, for the models that offer a rate.
    pub fn offered(&self) -> Option<f64> {
        match self {
            Model::Closed { .. } => None,
            Model::Sessions(s) => Some(s.rate * s.length),
        }
    }
}

/// How long to run a model, and what to count.
#[derive(Clone, Copy)]
pub struct Plan {
    /// Operations arriving this soon after the start do not count.
    pub warmup: Duration,
    /// How long operations arrive for after the warm-up.
    pub duration: Duration,
    /// Stop after this many counted operations.
    pub ops: Option<u64>,
    pub quiet: bool,
}

/// What a run of one model did.
pub struct Outcome {
    pub model: Model,
    pub rec: Recorder,
    /// From the end of the warm-up to the last counted completion.
    pub span: Duration,
    /// Most operations (closed) or sessions (open) under way at once.
    pub peak_in_flight: usize,
    /// Arrivals that found every slot busy and waited for one.
    pub waited: u64,
}

#[derive(Clone, Copy)]
struct Clock {
    start: Instant,
    /// The end of the warm-up.
    window: Instant,
    /// No operation arrives after this.
    end: Instant,
}

/// What a run's tasks share.
struct Shared {
    clock: Clock,
    ops: Option<u64>,
    /// Counted operations begun.
    begun: AtomicU64,
    /// Operations (closed) or sessions (open) under way.
    in_flight: AtomicUsize,
    /// How late the latest arrival was dispatched, in ns.
    behind_ns: AtomicU64,
}

impl Shared {
    /// Whether an operation arriving at `arrived` may go ahead: it does not
    /// count (warm-up), or `ops` has room for it.
    fn admit(&self, arrived: Instant) -> bool {
        arrived < self.clock.window
            || self
                .ops
                .is_none_or(|ops| self.begun.fetch_add(1, Ordering::Relaxed) < ops)
    }
}

struct Slot<S> {
    state: S,
    rec: Recorder,
    /// Think times.
    rng: Rng,
}

impl<S: Send + 'static> Slot<S> {
    async fn op<W: Workload<State = S>>(&mut self, workload: &W, arrived: Instant, clock: &Clock) {
        self.rec.begin(arrived, arrived >= clock.window);
        workload.step(&mut self.state, &mut self.rec).await;
        self.rec.finish();
    }

    async fn think(&mut self, mean: Duration) {
        if !mean.is_zero() {
            let secs = self.rng.exp(mean.as_secs_f64());
            wait_awake(Instant::now() + Duration::from_secs_f64(secs)).await;
        }
    }
}

fn new_slot<W: Workload>(
    workload: &W,
    index: usize,
    seed: u64,
    progress: &Arc<AtomicU64>,
) -> Slot<W::State> {
    Slot {
        state: workload.state(index),
        rec: Recorder::new(Arc::clone(progress)),
        rng: Rng::keyed(&[seed, 0x7417, index as u64]),
    }
}

/// Runs models of one workload, keeping its slots (and their states) from
/// one run to the next, so later runs carry on the streams of earlier ones.
pub struct Driver<W: Workload> {
    workload: Arc<W>,
    seed: u64,
    idle: Vec<Slot<W::State>>,
    created: usize,
    progress: Arc<AtomicU64>,
}

impl<W: Workload> Driver<W> {
    pub fn new(workload: W, seed: u64) -> Self {
        Self {
            workload: Arc::new(workload),
            seed,
            idle: Vec::new(),
            created: 0,
            progress: Arc::new(AtomicU64::new(0)),
        }
    }

    fn slot(&mut self) -> Slot<W::State> {
        self.idle.pop().unwrap_or_else(|| {
            self.created += 1;
            new_slot(&*self.workload, self.created - 1, self.seed, &self.progress)
        })
    }

    /// Run `model` as `plan` says; `run` numbers the runs of one driver,
    /// to give each its own arrivals.
    pub async fn run(&mut self, model: &Model, plan: &Plan, run: u64) -> Outcome {
        let start = Instant::now();
        let clock = Clock {
            start,
            window: start + plan.warmup,
            end: start + plan.warmup + plan.duration,
        };
        let shared = Arc::new(Shared {
            clock,
            ops: plan.ops,
            begun: AtomicU64::new(0),
            in_flight: AtomicUsize::new(0),
            behind_ns: AtomicU64::new(0),
        });
        let open = matches!(model, Model::Sessions(_));
        let ticker = (!plan.quiet).then(|| ticker(Arc::clone(&self.progress), &shared, open));
        let (peak_in_flight, waited) = match model {
            Model::Closed { concurrency, think } => {
                self.closed(*concurrency, *think, &shared).await;
                (*concurrency, 0)
            }
            Model::Sessions(sessions) => self.sessions(sessions.clone(), run, &shared).await,
        };
        if let Some(t) = ticker {
            t.abort();
        }

        let mut rec = Recorder::default();
        for slot in &mut self.idle {
            let fresh = Recorder::new(Arc::clone(&self.progress));
            rec.merge(std::mem::replace(&mut slot.rec, fresh));
        }
        let span = rec
            .last_done
            .map_or(plan.duration, |t| t.saturating_duration_since(clock.window));
        Outcome {
            model: model.clone(),
            rec,
            span,
            peak_in_flight,
            waited,
        }
    }

    async fn closed(&mut self, concurrency: usize, think: Duration, shared: &Arc<Shared>) {
        let workers: Vec<_> = (0..concurrency)
            .map(|_| {
                let mut slot = self.slot();
                let workload = Arc::clone(&self.workload);
                let shared = Arc::clone(shared);
                tokio::spawn(async move {
                    loop {
                        let now = Instant::now();
                        if now >= shared.clock.end || !shared.admit(now) {
                            break;
                        }
                        shared.in_flight.fetch_add(1, Ordering::Relaxed);
                        slot.op(&*workload, now, &shared.clock).await;
                        shared.in_flight.fetch_sub(1, Ordering::Relaxed);
                        slot.think(think).await;
                    }
                    slot
                })
            })
            .collect();
        for w in workers {
            self.idle.push(w.await.expect("worker panicked"));
        }
    }

    /// Dispatch sessions as they arrive, from a thread of their own so that
    /// arrivals keep to their schedule however busy the runtime is, each
    /// [`LEAD`] early. Returns the most sessions under way at once, and how
    /// many arrivals waited for a slot.
    async fn sessions(
        &mut self,
        sessions: Sessions,
        run: u64,
        shared: &Arc<Shared>,
    ) -> (usize, u64) {
        let mut idle = std::mem::take(&mut self.idle);
        let mut created = self.created;
        let seed = self.seed;
        let workload = Arc::clone(&self.workload);
        let progress = Arc::clone(&self.progress);
        let shared = Arc::clone(shared);
        let handle = tokio::runtime::Handle::current();
        let (idle, created, peak, waited) = tokio::task::spawn_blocking(move || {
            let (free_tx, free_rx) = mpsc::channel::<Slot<W::State>>();
            let clock = shared.clock;
            let mut gaps = Rng::keyed(&[seed, 0xa441, run]);
            let mean_gap = 1.0 / sessions.rate;
            // After each operation, another follows with this probability.
            let again = 1.0 - 1.0 / sessions.length;
            let (mut peak, mut waited) = (0, 0);
            let mut due = clock.start;
            loop {
                due += Duration::from_secs_f64(match sessions.arrivals {
                    Arrivals::Poisson => gaps.exp(mean_gap),
                    Arrivals::Uniform => mean_gap,
                });
                let full = shared
                    .ops
                    .is_some_and(|ops| shared.begun.load(Ordering::Relaxed) >= ops);
                if due >= clock.end || full {
                    break;
                }
                let send_at = due.checked_sub(LEAD).unwrap_or(due);
                wait_until(send_at);

                idle.extend(free_rx.try_iter());
                let out = created - idle.len();
                let slot = if out >= sessions.max_in_flight {
                    waited += 1;
                    free_rx.recv().expect("sessions hold a sender")
                } else if let Some(slot) = idle.pop() {
                    slot
                } else {
                    created += 1;
                    new_slot(&*workload, created - 1, seed, &progress)
                };
                let behind = Instant::now().saturating_duration_since(send_at);
                shared
                    .behind_ns
                    .store(behind.as_nanos() as u64, Ordering::Relaxed);
                let under_way = shared.in_flight.fetch_add(1, Ordering::Relaxed) + 1;
                peak = peak.max(under_way);

                handle.spawn(session(
                    Arc::clone(&workload),
                    slot,
                    due,
                    again,
                    sessions.think,
                    Arc::clone(&shared),
                    free_tx.clone(),
                ));
            }
            // Every slot comes back once its session ends.
            while idle.len() < created {
                idle.push(free_rx.recv().expect("sessions hold a sender"));
            }
            (idle, created, peak, waited)
        })
        .await
        .expect("dispatcher panicked");
        self.idle = idle;
        self.created = created;
        (peak, waited)
    }
}

/// One session: operations one after another, the first due at `due`,
/// each followed by another with probability `again` after a think.
async fn session<W: Workload>(
    workload: Arc<W>,
    mut slot: Slot<W::State>,
    due: Instant,
    again: f64,
    think: Duration,
    shared: Arc<Shared>,
    free: mpsc::Sender<Slot<W::State>>,
) {
    let clock = shared.clock;
    wait_awake(due).await;
    if due >= clock.window {
        slot.rec.late.record(due.elapsed().as_nanos() as u64);
    }
    let mut arrived = due;
    while shared.admit(arrived) {
        slot.op(&*workload, arrived, &clock).await;
        if again <= 0.0 || !slot.rng.chance(again) {
            break;
        }
        slot.think(think).await;
        arrived = Instant::now();
        if arrived >= clock.end {
            break;
        }
    }
    shared.in_flight.fetch_sub(1, Ordering::Relaxed);
    // The dispatcher waits for every slot, so it is still listening.
    let _ = free.send(slot);
}

/// How long before it is due a session is dispatched, and before a think
/// ends its task is woken. Waking a parked runtime worker means waking its
/// core, and a core in its deepest idle state takes hundreds of microseconds
/// to answer; the runtime's timer, besides, ticks once a millisecond. An
/// arrival dispatched on time would start late, a think of 300 us would last
/// a millisecond, and response times and loads would carry the error.
/// Woken early, each waits out the rest on a worker already awake.
const LEAD: Duration = Duration::from_millis(1);

/// Wait until `t`: on the runtime's timer until [`LEAD`] before it, then
/// awake, polling.
async fn wait_awake(t: Instant) {
    if let Some(early) = t.checked_sub(LEAD)
        && early > Instant::now()
    {
        tokio::time::sleep_until(early.into()).await;
    }
    while Instant::now() < t {
        tokio::task::yield_now().await;
    }
}

/// Block until `t`. Sleeps overshoot by tens of microseconds, more than
/// the gap between arrivals at high rates, so the last stretch spins.
fn wait_until(t: Instant) {
    const SPIN: Duration = Duration::from_micros(200);
    loop {
        let now = Instant::now();
        if now >= t {
            return;
        }
        let left = t - now;
        if left > SPIN {
            std::thread::sleep(left - SPIN);
        } else {
            std::hint::spin_loop();
        }
    }
}

/// Print the RPC rate every second (and, for the open models, what is
/// under way and how far dispatch lags its schedule).
fn ticker(
    progress: Arc<AtomicU64>,
    shared: &Arc<Shared>,
    open: bool,
) -> tokio::task::JoinHandle<()> {
    let shared = Arc::clone(shared);
    tokio::spawn(async move {
        let mut last = progress.load(Ordering::Relaxed);
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.tick().await;
        loop {
            interval.tick().await;
            let now = progress.load(Ordering::Relaxed);
            let warm = if Instant::now() < shared.clock.window {
                "  (warm-up)"
            } else {
                ""
            };
            let t = shared.clock.start.elapsed().as_secs_f64();
            if open {
                eprintln!(
                    "  {t:>5.1}s  {:>9} rpc/s  {:>6} in flight  dispatch {} late{warm}",
                    now - last,
                    shared.in_flight.load(Ordering::Relaxed),
                    fmt_ns(shared.behind_ns.load(Ordering::Relaxed)),
                );
            } else {
                eprintln!("  {t:>5.1}s  {:>9} rpc/s{warm}", now - last);
            }
            last = now;
        }
    })
}

fn fmt_ns(ns: u64) -> String {
    match ns {
        0..1_000 => format!("{ns}ns"),
        1_000..1_000_000 => format!("{:.1}us", ns as f64 / 1e3),
        1_000_000..1_000_000_000 => format!("{:.2}ms", ns as f64 / 1e6),
        _ => format!("{:.2}s", ns as f64 / 1e9),
    }
}

fn row(name: &str, ok: u64, rate: f64, mb: Option<f64>, h: &Histogram) {
    let mb = mb.map_or("-".to_string(), |mb| format!("{mb:.1}"));
    println!(
        "  {:<28} {:>10} {:>10.0} {:>10} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9}",
        name,
        ok,
        rate,
        mb,
        fmt_ns(h.mean()),
        fmt_ns(h.quantile(0.5)),
        fmt_ns(h.quantile(0.9)),
        fmt_ns(h.quantile(0.99)),
        fmt_ns(h.quantile(0.999)),
        fmt_ns(h.max()),
    );
}

/// Print a table of `out`: operations from arrival, then each RPC from
/// when it was sent.
pub fn report(name: &str, out: &Outcome) {
    let rec = &out.rec;
    let secs = out.span.as_secs_f64();
    println!("== {name}: {} ({secs:.1}s)", out.model.describe());
    println!(
        "  {:<28} {:>10} {:>10} {:>10} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9}",
        "", "ok", "per s", "MB/s", "mean", "p50", "p90", "p99", "p99.9", "max"
    );
    let n = rec.response.count();
    row("operation", n, n as f64 / secs, None, &rec.response);
    for (op, s) in &rec.ops {
        let rate = s.latency.count() as f64 / secs;
        row(
            op,
            s.ok,
            rate,
            Some(s.bytes as f64 / secs / 1e6),
            &s.latency,
        );
        for (e, count) in &s.errors {
            println!("      {count:>8} x {e}");
        }
    }
    if let Model::Sessions(sessions) = &out.model {
        let late = &rec.late;
        println!(
            "  offered {:.0}/s, done {:.0}/s; arrivals started late by p50 {}, p99 {}, max {}; \
             {} sessions under way at most (--max-in-flight {})",
            out.model.offered().unwrap_or_default(),
            n as f64 / secs,
            fmt_ns(late.quantile(0.5)),
            fmt_ns(late.quantile(0.99)),
            fmt_ns(late.max()),
            out.peak_in_flight,
            sessions.max_in_flight,
        );
        if out.waited > 0 {
            println!(
                "  ! {} arrivals found every slot busy and waited (the wait counts in their \
                 response time); the server is overloaded, or --max-in-flight is too low",
                out.waited
            );
        }
    }
    println!(
        "  verified {}  verify failures {}",
        rec.verified, rec.verify_failures
    );
    for f in &rec.first_failures {
        println!("      ! {f}");
    }
}

/// Print operation response times across `runs` of one workload.
pub fn summary(name: &str, runs: &[Outcome]) {
    println!("== {name}: operations, from arrival to completion");
    println!(
        "  {:<56} {:>10} {:>10} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9}",
        "model", "offered/s", "done/s", "mean", "p50", "p90", "p99", "p99.9", "max"
    );
    for out in runs {
        let h = &out.rec.response;
        let offered = out
            .model
            .offered()
            .map_or("-".to_string(), |r| format!("{r:.0}"));
        println!(
            "  {:<56} {:>10} {:>10.0} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9}",
            out.model.describe(),
            offered,
            h.count() as f64 / out.span.as_secs_f64(),
            fmt_ns(h.mean()),
            fmt_ns(h.quantile(0.5)),
            fmt_ns(h.quantile(0.9)),
            fmt_ns(h.quantile(0.99)),
            fmt_ns(h.quantile(0.999)),
            fmt_ns(h.max()),
        );
    }
}

fn hist_json(h: &Histogram) -> serde_json::Value {
    serde_json::json!({
        "count": h.count(),
        "mean_ns": h.mean(),
        "p50_ns": h.quantile(0.5),
        "p90_ns": h.quantile(0.9),
        "p99_ns": h.quantile(0.99),
        "p999_ns": h.quantile(0.999),
        "max_ns": h.max(),
    })
}

/// `out` as JSON, for comparing runs.
pub fn to_json(name: &str, out: &Outcome) -> serde_json::Value {
    let rec = &out.rec;
    let secs = out.span.as_secs_f64();
    let ops: serde_json::Map<String, serde_json::Value> = rec
        .ops
        .iter()
        .map(|(op, s)| {
            let n = s.latency.count();
            (
                op.to_string(),
                serde_json::json!({
                    "ok": s.ok,
                    "errors": s.errors,
                    "rate": n as f64 / secs,
                    "mb_per_s": s.bytes as f64 / secs / 1e6,
                    "mean_ns": s.latency.mean(),
                    "p50_ns": s.latency.quantile(0.5),
                    "p90_ns": s.latency.quantile(0.9),
                    "p99_ns": s.latency.quantile(0.99),
                    "p999_ns": s.latency.quantile(0.999),
                    "max_ns": s.latency.max(),
                }),
            )
        })
        .collect();
    serde_json::json!({
        "workload": name,
        "model": out.model.describe(),
        "offered_per_s": out.model.offered(),
        "done_per_s": rec.response.count() as f64 / secs,
        "seconds": secs,
        "response": hist_json(&rec.response),
        "late": hist_json(&rec.late),
        "peak_in_flight": out.peak_in_flight,
        "waited_for_slot": out.waited,
        "verified": rec.verified,
        "verify_failures": rec.verify_failures,
        "ops": ops,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Operations that take `0` and do nothing else.
    struct Nap(Duration);

    impl Workload for Nap {
        type State = ();

        fn state(&self, _worker: usize) {}

        async fn step(&self, _state: &mut (), rec: &mut Recorder) {
            let t = Instant::now();
            if !self.0.is_zero() {
                tokio::time::sleep(self.0).await;
            }
            rec.ok("nap", t, 0);
        }
    }

    fn block_on<F: Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn plan(ops: u64) -> Plan {
        Plan {
            warmup: Duration::ZERO,
            duration: Duration::from_secs(60),
            ops: Some(ops),
            quiet: true,
        }
    }

    fn open(rate: f64, max_in_flight: usize) -> Model {
        Model::Sessions(Sessions {
            rate,
            arrivals: Arrivals::Poisson,
            length: 1.0,
            think: Duration::ZERO,
            max_in_flight,
        })
    }

    #[test]
    fn each_model_stops_at_ops() {
        let models = [
            Model::Closed {
                concurrency: 4,
                think: Duration::ZERO,
            },
            open(2000.0, 64),
            Model::Sessions(Sessions {
                rate: 500.0,
                arrivals: Arrivals::Uniform,
                length: 4.0,
                think: Duration::from_millis(1),
                max_in_flight: 64,
            }),
        ];
        block_on(async {
            let mut driver = Driver::new(Nap(Duration::from_millis(1)), 1);
            for (run, model) in models.iter().enumerate() {
                let out = driver.run(model, &plan(100), run as u64).await;
                assert_eq!(out.rec.response.count(), 100, "{}", model.describe());
                assert_eq!(out.rec.ops["nap"].ok, 100, "{}", model.describe());
                assert_eq!(out.waited, 0, "{}", model.describe());
            }
        });
    }

    #[test]
    fn open_arrivals_wait_and_count_the_wait() {
        // One slot, 20 ms operations, arrivals every millisecond or so: each
        // arrival waits for the ones before it, and its response time says
        // so. A closed loop would report 20 ms throughout.
        block_on(async {
            let mut driver = Driver::new(Nap(Duration::from_millis(20)), 1);
            let out = driver.run(&open(1000.0, 1), &plan(10), 0).await;
            assert_eq!(out.rec.response.count(), 10);
            assert!(out.waited >= 5, "waited {}", out.waited);
            assert_eq!(out.peak_in_flight, 1);
            let max = Duration::from_nanos(out.rec.response.max());
            assert!(max >= Duration::from_millis(120), "max response {max:?}");
        });
    }

    #[test]
    fn think_times_are_not_rounded_to_timer_ticks() {
        // One worker thinking 300 us on average between instant operations
        // gets through about 1000 in 300 ms; on the runtime's millisecond
        // timer alone it would manage about 300.
        block_on(async {
            let mut driver = Driver::new(Nap(Duration::ZERO), 1);
            let model = Model::Closed {
                concurrency: 1,
                think: Duration::from_micros(300),
            };
            let plan = Plan {
                warmup: Duration::ZERO,
                duration: Duration::from_millis(300),
                ops: None,
                quiet: true,
            };
            let n = driver.run(&model, &plan, 0).await.rec.response.count();
            assert!((700..=1300).contains(&n), "{n} operations");
        });
    }

    #[test]
    fn warm_up_operations_do_not_count() {
        block_on(async {
            let mut driver = Driver::new(Nap(Duration::from_millis(1)), 1);
            let plan = Plan {
                warmup: Duration::from_millis(200),
                duration: Duration::from_millis(200),
                ops: None,
                quiet: true,
            };
            let out = driver.run(&open(500.0, 64), &plan, 0).await;
            // About 100 arrive after the warm-up, and as many before it.
            let n = out.rec.response.count();
            assert!((40..=170).contains(&n), "{n} counted");
            assert_eq!(out.rec.ops["nap"].ok, n);
        });
    }
}
