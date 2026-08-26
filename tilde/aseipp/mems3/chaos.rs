// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Request-driven automatic fault campaigns, using faultline's BUGGIFY decisions.
//!
//! A request receives its campaign position at admission and keeps that position
//! through commit. Its random streams depend on the campaign seed, active request
//! number, and static boundary/action names, never on time or completion order.
//! This is deterministic fault selection, not a deterministic network scheduler.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use faultline::{Buggify, BuggifyConfig, ConfigError, Probability};
use s3s::S3Result;

use crate::faults::S3Fault;

/// The versioned policy name belongs in reproduction reports with the seed.
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
#[derive(Debug)]
pub(crate) struct Sites {
    pub(crate) boundary: &'static str,
    pub(crate) error: &'static str,
    pub(crate) long_delay: &'static str,
    pub(crate) short_delay: &'static str,
    pub(crate) yield_now: &'static str,
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
    boundaries: BTreeMap<&'static str, BoundaryCounts>,
}

#[derive(Clone, Copy, Debug, Default)]
struct BoundaryCounts {
    visits: u64,
    errors: u64,
    delays: u64,
    yields: u64,
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
}

/// Held across the whole S3 handler, including its post-commit boundary.
#[derive(Debug)]
pub(crate) struct Visit {
    inner: Arc<Inner>,
    request: u64,
    phase: Phase,
    decisions: Option<Buggify>,
}

#[derive(Debug)]
enum Effect {
    Off,
    Error(S3Fault),
    Delay(Duration),
    Yield,
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

    fn phase(&self, admitted: u64) -> Phase {
        self.inner.phase(admitted)
    }

    pub(crate) fn begin(&self) -> Visit {
        let (request, phase) = {
            let mut counts = self.inner.counts.lock().unwrap();
            let phase = self.phase(counts.requests);
            counts.requests = counts.requests.saturating_add(1);
            counts.in_flight = counts.in_flight.saturating_add(1);
            (counts.requests, phase)
        };
        let decisions = (phase == Phase::Active).then(|| {
            // Domain separation, not a second random generator. Multiplication
            // by an odd constant maps active ordinals to distinct u64 salts.
            // Warmup does not consume active ordinals or any BUGGIFY decisions.
            let ordinal = request - self.inner.config.warmup_requests;
            let seed = self.inner.seed ^ ordinal.wrapping_mul(0x9e37_79b9_7f4a_7c15);
            let decisions = Buggify::new(seed);
            decisions
                .enable(BuggifyConfig {
                    activation: Probability::ALWAYS,
                    firing: Probability::NEVER,
                })
                .expect("instrumentation checked when the campaign was created");
            decisions
        });
        Visit {
            inner: self.inner.clone(),
            request,
            phase,
            decisions,
        }
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        let counts = self.inner.counts.lock().unwrap();
        let mut snapshot = Snapshot {
            phase: self.phase(counts.requests),
            requests: counts.requests,
            in_flight: counts.in_flight,
            visits: 0,
            errors_before: 0,
            errors_after_commit: 0,
            delays: 0,
            yields: 0,
        };
        for (name, boundary) in &counts.boundaries {
            snapshot.visits = snapshot.visits.saturating_add(boundary.visits);
            let errors = if name.ends_with(".after_commit") {
                &mut snapshot.errors_after_commit
            } else {
                &mut snapshot.errors_before
            };
            *errors = errors.saturating_add(boundary.errors);
            snapshot.delays = snapshot.delays.saturating_add(boundary.delays);
            snapshot.yields = snapshot.yields.saturating_add(boundary.yields);
        }
        snapshot
    }

    /// Report cumulative coverage without doing I/O under a decision/store lock.
    pub(crate) fn report(&self) {
        let s = self.snapshot();
        eprintln!(
            "mems3 chaos: profile={PROFILE} seed={} phase={} requests={} in_flight={} \
             visits={} errors_before={} errors_after_commit={} delays={} yields={}",
            self.inner.seed,
            s.phase.name(),
            s.requests,
            s.in_flight,
            s.visits,
            s.errors_before,
            s.errors_after_commit,
            s.delays,
            s.yields,
        );
    }

    pub(crate) fn announce(&self) {
        let config = self.inner.config;
        let requests = config
            .requests
            .map_or_else(|| "unlimited".to_owned(), |n| n.to_string());
        eprintln!(
            "mems3 chaos config: profile={PROFILE} seed={} warmup_requests={} \
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
        let Some(decisions) = &self.decisions else {
            return Effect::Off;
        };
        let fires =
            |site, chance| decisions.test_with_probability(site, Probability::new(chance).unwrap());
        let committed = sites.boundary.ends_with(".after_commit");
        if fires(sites.error, if committed { 0.05 } else { 0.10 }) {
            Effect::Error(if committed {
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

    pub(crate) async fn hit(&self, sites: &Sites) -> S3Result<()> {
        let effect = self.select(sites);
        if self.phase == Phase::Active {
            let mut counts = self.inner.counts.lock().unwrap();
            let boundary = counts.boundaries.entry(sites.boundary).or_default();
            boundary.visits = boundary.visits.saturating_add(1);
            match &effect {
                Effect::Error(_) => boundary.errors = boundary.errors.saturating_add(1),
                Effect::Delay(_) => boundary.delays = boundary.delays.saturating_add(1),
                Effect::Yield => boundary.yields = boundary.yields.saturating_add(1),
                Effect::Off => {}
            }
        }
        if self.inner.config.trace {
            // Include off decisions: the trace also establishes admission order.
            // Static labels only; no bucket names, object keys, or payloads.
            eprintln!(
                "mems3 chaos trace: seed={} request={} boundary={} phase={} action={effect:?}",
                self.inner.seed,
                self.request,
                sites.boundary,
                self.phase.name(),
            );
        }
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
}

impl Drop for Visit {
    fn drop(&mut self) {
        let finished = {
            let mut counts = self.inner.counts.lock().unwrap();
            counts.in_flight -= 1;
            let finished = counts.in_flight == 0
                && self.inner.phase(counts.requests) == Phase::Recovery
                && !counts.recovery_reported;
            counts.recovery_reported |= finished;
            finished
        };
        // A finite campaign announces its drained state even if the test exits
        // before the periodic reporter ticks. Cancelling a handler also drains.
        if finished {
            Chaos {
                inner: self.inner.clone(),
            }
            .report();
        }
    }
}
