// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The closed-loop driver: `concurrency` workers each run one operation
//! after another until the deadline, recording every RPC.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::hist::Histogram;

/// What one kind of RPC did.
#[derive(Default, Clone)]
pub struct OpStats {
    pub latency: Histogram,
    pub ok: u64,
    pub bytes: u64,
    pub errors: BTreeMap<String, u64>,
}

/// What one worker saw.
#[derive(Default)]
pub struct Recorder {
    pub ops: BTreeMap<&'static str, OpStats>,
    pub verified: u64,
    pub verify_failures: u64,
    pub first_failures: Vec<String>,
    progress: Option<Arc<AtomicU64>>,
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
        let s = self.ops.entry(op).or_default();
        s.latency.record(started.elapsed().as_nanos() as u64);
        s.ok += 1;
        s.bytes += bytes;
        self.tick();
    }

    pub fn err(&mut self, op: &'static str, started: Instant, status: &tonic::Status) {
        let s = self.ops.entry(op).or_default();
        s.latency.record(started.elapsed().as_nanos() as u64);
        let mut msg: String = status.message().chars().take(80).collect();
        if msg.is_empty() {
            msg = "(no message)".into();
        }
        *s.errors
            .entry(format!("{:?}: {msg}", status.code()))
            .or_default() += 1;
        self.tick();
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
        self.verified += other.verified;
        self.verify_failures += other.verify_failures;
        for f in other.first_failures {
            if self.first_failures.len() < 10 {
                self.first_failures.push(f);
            }
        }
    }
}

/// A load to apply: each worker keeps a `State` and runs `step` in a loop.
pub trait Workload: Send + Sync + 'static {
    type State: Send + 'static;

    fn state(&self, worker: usize) -> Self::State;

    fn step<'a>(
        &'a self,
        state: &'a mut Self::State,
        rec: &'a mut Recorder,
    ) -> impl Future<Output = ()> + Send + 'a;
}

/// Run `workload` with `concurrency` workers for `duration`, or until `ops`
/// steps have started if given, printing the operation rate every second
/// unless `quiet`.
pub async fn run<W: Workload>(
    workload: Arc<W>,
    concurrency: usize,
    duration: Duration,
    ops: Option<u64>,
    quiet: bool,
) -> (Recorder, Duration) {
    let progress = Arc::new(AtomicU64::new(0));
    let begun = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let deadline = started + duration;
    let workers: Vec<_> = (0..concurrency)
        .map(|i| {
            let workload = Arc::clone(&workload);
            let begun = Arc::clone(&begun);
            let mut rec = Recorder::new(Arc::clone(&progress));
            tokio::spawn(async move {
                let mut state = workload.state(i);
                while Instant::now() < deadline
                    && ops.is_none_or(|ops| begun.fetch_add(1, Ordering::Relaxed) < ops)
                {
                    workload.step(&mut state, &mut rec).await;
                }
                rec
            })
        })
        .collect();

    let ticker = (!quiet).then(|| {
        let progress = Arc::clone(&progress);
        tokio::spawn(async move {
            let mut last = 0;
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.tick().await;
            loop {
                interval.tick().await;
                let now = progress.load(Ordering::Relaxed);
                eprintln!(
                    "  {:>5.1}s  {:>9} rpc/s",
                    started.elapsed().as_secs_f64(),
                    now - last
                );
                last = now;
            }
        })
    });

    let mut total = Recorder::default();
    for w in workers {
        total.merge(w.await.expect("worker panicked"));
    }
    let elapsed = started.elapsed();
    if let Some(t) = ticker {
        t.abort();
    }
    (total, elapsed)
}

fn fmt_ns(ns: u64) -> String {
    match ns {
        0..1_000 => format!("{ns}ns"),
        1_000..1_000_000 => format!("{:.1}us", ns as f64 / 1e3),
        1_000_000..1_000_000_000 => format!("{:.2}ms", ns as f64 / 1e6),
        _ => format!("{:.2}s", ns as f64 / 1e9),
    }
}

/// Print a table of `rec` over `elapsed`.
pub fn report(name: &str, rec: &Recorder, elapsed: Duration) {
    let secs = elapsed.as_secs_f64();
    println!("== {name} ({secs:.1}s)");
    println!(
        "  {:<28} {:>10} {:>10} {:>10} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9}",
        "op", "ok", "rpc/s", "MB/s", "mean", "p50", "p90", "p99", "p99.9", "max"
    );
    for (op, s) in &rec.ops {
        let n = s.latency.count();
        println!(
            "  {:<28} {:>10} {:>10.0} {:>10.1} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9}",
            op,
            s.ok,
            n as f64 / secs,
            s.bytes as f64 / secs / 1e6,
            fmt_ns(s.latency.mean()),
            fmt_ns(s.latency.quantile(0.5)),
            fmt_ns(s.latency.quantile(0.9)),
            fmt_ns(s.latency.quantile(0.99)),
            fmt_ns(s.latency.quantile(0.999)),
            fmt_ns(s.latency.max()),
        );
        for (e, count) in &s.errors {
            println!("      {count:>8} x {e}");
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

/// `rec` as JSON, for comparing runs.
pub fn to_json(name: &str, rec: &Recorder, elapsed: Duration) -> serde_json::Value {
    let secs = elapsed.as_secs_f64();
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
        "seconds": secs,
        "verified": rec.verified,
        "verify_failures": rec.verify_failures,
        "ops": ops,
    })
}
