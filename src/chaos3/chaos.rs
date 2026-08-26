// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Request-driven automatic fault campaigns, using faultline's seeded decisions.
//!
//! A request receives its campaign position at admission and keeps that position
//! through commit. Its decisions depend on the campaign seed, active request
//! number, and static boundary/action names, never on time or completion order.
//! This is deterministic fault selection, not a deterministic network scheduler.

use std::fmt;
use std::io::Write as _;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use faultline::{Buggify, ConfigError, Probability};
use s3s::S3Result;

use crate::faults::S3Fault;

/// The value of `--chaos`, which belongs in reproduction reports with the
/// seed. A policy is frozen once a test pins a seed against its name.
pub(crate) const PROFILE: &str = "storage-v1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ChaosConfig {
    pub(crate) warmup_requests: u64,
    pub(crate) requests: Option<u64>,
    pub(crate) trace: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    Warmup,
    Active,
    Recovery,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Warmup => "warmup",
            Self::Active => "active",
            Self::Recovery => "recovery",
        }
    }
}

/// Static names are generated alongside the ordinary failpoint handles.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Sites {
    pub(crate) boundary: &'static str,
    /// A boundary after a visible mutation selects a different error and is
    /// counted separately.
    pub(crate) committed: bool,
    pub(crate) error: &'static str,
    pub(crate) long_delay: &'static str,
    pub(crate) short_delay: &'static str,
    pub(crate) yield_now: &'static str,
}

/// Static names for a streamed response body.
#[derive(Clone, Copy, Debug)]
pub(crate) struct BodySites {
    pub(crate) boundary: &'static str,
    pub(crate) truncate: &'static str,
    pub(crate) cut: &'static str,
}

#[derive(Clone, Debug)]
pub(crate) struct Chaos {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    seed: u64,
    config: ChaosConfig,
    counts: Mutex<Counts>,
}

#[derive(Debug, Default)]
struct Counts {
    requests: u64,
    in_flight: u64,
    recovery_reported: bool,
    visits: u64,
    errors_before: u64,
    errors_after_commit: u64,
    delays: u64,
    yields: u64,
    truncations: u64,
}

/// Counters describe effects selected at reached boundaries, including effects
/// whose request was subsequently cancelled. Warmup/recovery do not add visits.
#[derive(Debug)]
pub(crate) struct Snapshot {
    /// Phase of the next admission; earlier active requests may still be running.
    pub(crate) phase: Phase,
    pub(crate) requests: u64,
    pub(crate) in_flight: u64,
    pub(crate) visits: u64,
    pub(crate) errors_before: u64,
    pub(crate) errors_after_commit: u64,
    pub(crate) delays: u64,
    pub(crate) yields: u64,
    pub(crate) truncations: u64,
}

/// Held across the whole S3 handler, including its post-commit boundary.
#[derive(Debug)]
pub(crate) struct Visit {
    chaos: Chaos,
    request: u64,
    phase: Phase,
    /// Seeds an active request's decisions. Warmup and recovery select nothing.
    seed: Option<u64>,
}

#[derive(Debug)]
enum Effect {
    Off,
    Error(S3Fault),
    Delay(Duration),
    Yield,
}

/// A truncation names the chunk the body ends before.
#[derive(Debug)]
enum BodyEffect {
    Off,
    Truncate(usize),
}

/// Counters saturate so that exhaustion ends injection instead of wrapping.
fn bump(counter: &mut u64) {
    *counter = counter.saturating_add(1);
}

impl Chaos {
    pub(crate) fn new(seed: u64, config: ChaosConfig) -> Result<Self, ConfigError> {
        // Fail at setup, never silently run a supposedly adversarial test with
        // instrumentation compiled out. CLI count validation happens separately.
        if !faultline::enabled() {
            return Err(ConfigError::Disabled);
        }
        Ok(Self {
            inner: Arc::new(Inner {
                seed,
                config,
                counts: Mutex::new(Counts::default()),
            }),
        })
    }

    pub(crate) fn begin(&self) -> Visit {
        let (request, phase) = {
            let mut counts = self.inner.counts.lock().unwrap();
            let phase = self.inner.phase(counts.requests);
            bump(&mut counts.requests);
            bump(&mut counts.in_flight);
            (counts.requests, phase)
        };
        let seed = (phase == Phase::Active).then(|| {
            // Domain separation, not a second random generator. Multiplication
            // by an odd constant maps active ordinals to distinct u64 salts.
            // Warmup does not consume active ordinals or any decisions.
            let ordinal = request - self.inner.config.warmup_requests;
            self.inner.seed ^ ordinal.wrapping_mul(0x9e37_79b9_7f4a_7c15)
        });
        Visit {
            chaos: self.clone(),
            request,
            phase,
            seed,
        }
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        let counts = self.inner.counts.lock().unwrap();
        Snapshot {
            phase: self.inner.phase(counts.requests),
            requests: counts.requests,
            in_flight: counts.in_flight,
            visits: counts.visits,
            errors_before: counts.errors_before,
            errors_after_commit: counts.errors_after_commit,
            delays: counts.delays,
            yields: counts.yields,
            truncations: counts.truncations,
        }
    }

    /// Report cumulative coverage without doing I/O under a decision/store lock.
    pub(crate) fn report(&self) {
        let s = self.snapshot();
        eprintln!(
            "chaos3 chaos: profile={PROFILE} seed={} phase={} requests={} in_flight={} \
             visits={} errors_before={} errors_after_commit={} delays={} yields={} \
             truncations={}",
            self.inner.seed,
            s.phase.name(),
            s.requests,
            s.in_flight,
            s.visits,
            s.errors_before,
            s.errors_after_commit,
            s.delays,
            s.yields,
            s.truncations,
        );
    }

    pub(crate) fn announce(&self) {
        let config = self.inner.config;
        let requests = config
            .requests
            .map_or_else(|| "unlimited".to_owned(), |n| n.to_string());
        eprintln!(
            "chaos3 chaos config: profile={PROFILE} seed={} warmup_requests={} \
             chaos_requests={requests} trace={}",
            self.inner.seed, config.warmup_requests, config.trace,
        );
        self.report();
    }
}

impl Inner {
    fn phase(&self, admitted: u64) -> Phase {
        // Counter exhaustion ends injection instead of reusing a request seed.
        if admitted == u64::MAX {
            Phase::Recovery
        } else if admitted < self.config.warmup_requests {
            Phase::Warmup
        } else if self
            .config
            .requests
            .is_some_and(|limit| admitted - self.config.warmup_requests >= limit)
        {
            Phase::Recovery
        } else {
            Phase::Active
        }
    }
}

impl Visit {
    fn select(&self, sites: &Sites) -> Effect {
        let Some(seed) = self.seed else {
            return Effect::Off;
        };
        let fires = |site, chance| Buggify::decide(seed, site, Probability::new(chance).unwrap());
        if fires(sites.error, if sites.committed { 0.05 } else { 0.10 }) {
            Effect::Error(if sites.committed {
                S3Fault::InternalError
            } else {
                S3Fault::SlowDown
            })
        } else if fires(sites.long_delay, 0.02) {
            Effect::Delay(Duration::from_millis(1000))
        } else if fires(sites.short_delay, 0.10) {
            Effect::Delay(Duration::from_millis(50))
        } else if fires(sites.yield_now, 0.20) {
            Effect::Yield
        } else {
            Effect::Off
        }
    }

    /// Count and trace one decision at a boundary of this request.
    ///
    /// `counter` selects the effect's counter, if the decision chose one.
    fn record(
        &self,
        boundary: &'static str,
        action: &dyn fmt::Debug,
        counter: impl FnOnce(&mut Counts) -> Option<&mut u64>,
    ) {
        if self.phase == Phase::Active {
            let mut counts = self.chaos.inner.counts.lock().unwrap();
            bump(&mut counts.visits);
            if let Some(counter) = counter(&mut counts) {
                bump(counter);
            }
        }
        if self.chaos.inner.config.trace {
            // Include off decisions: the trace also establishes admission order.
            // Static labels only; no bucket names, object keys, or payloads.
            // Stderr is unbuffered, so build the line first and write it once.
            let line = format!(
                "chaos3 chaos trace: seed={} request={} boundary={boundary} phase={} \
                 action={action:?}\n",
                self.chaos.inner.seed,
                self.request,
                self.phase.name(),
            );
            let _ = std::io::stderr().write_all(line.as_bytes());
        }
    }

    pub(crate) async fn hit(&self, sites: &Sites) -> S3Result<()> {
        let effect = self.select(sites);
        self.record(sites.boundary, &effect, |counts| match &effect {
            Effect::Off => None,
            Effect::Error(_) if sites.committed => Some(&mut counts.errors_after_commit),
            Effect::Error(_) => Some(&mut counts.errors_before),
            Effect::Delay(_) => Some(&mut counts.delays),
            Effect::Yield => Some(&mut counts.yields),
        });
        match effect {
            Effect::Off => Ok(()),
            Effect::Error(error) => Err(error.into()),
            Effect::Delay(delay) => {
                tokio::time::sleep(delay).await;
                Ok(())
            }
            Effect::Yield => {
                tokio::task::yield_now().await;
                Ok(())
            }
        }
    }

    /// Decide as a streamed body starts whether to cut it, and before which
    /// of its `chunks` chunks.
    ///
    /// The cut position is uniform over the body, so a single-chunk body ends
    /// before any byte and a longer one ends anywhere short of its promised
    /// length, as a lost connection would. An empty body has no chunks and
    /// never reaches this boundary.
    pub(crate) fn truncation(&self, sites: &BodySites, chunks: usize) -> Option<usize> {
        if chunks == 0 {
            return None;
        }
        let effect = match self.seed {
            Some(seed)
                if Buggify::decide(seed, sites.truncate, Probability::new(0.05).unwrap()) =>
            {
                let position = Buggify::sample(seed, sites.cut) % (chunks as u64);
                BodyEffect::Truncate(position as usize)
            }
            _ => BodyEffect::Off,
        };
        self.record(sites.boundary, &effect, |counts| match effect {
            BodyEffect::Off => None,
            BodyEffect::Truncate(_) => Some(&mut counts.truncations),
        });
        match effect {
            BodyEffect::Off => None,
            BodyEffect::Truncate(position) => Some(position),
        }
    }
}

impl Drop for Visit {
    fn drop(&mut self) {
        let finished = {
            let mut counts = self.chaos.inner.counts.lock().unwrap();
            counts.in_flight -= 1;
            let finished = counts.in_flight == 0
                && self.chaos.inner.phase(counts.requests) == Phase::Recovery
                && !counts.recovery_reported;
            counts.recovery_reported |= finished;
            finished
        };
        // A finite campaign announces its drained state even if the test exits
        // before the periodic reporter ticks. Cancelling a handler also drains.
        if finished {
            self.chaos.report();
        }
    }
}
