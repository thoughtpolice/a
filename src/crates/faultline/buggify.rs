// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use rand::{RngExt, SeedableRng, rngs::StdRng};

use crate::{ConfigError, Probability, enabled};

/// The two independent probabilities used by a BUGGIFY run.
///
/// A site first decides whether it is activated for the whole run. Each visit
/// to an activated site then independently decides whether to fire. Defaults
/// match FoundationDB: 25% activation and 25% firing. Keeping most sites
/// inactive lets a run repeatedly exercise a subset of perturbations instead
/// of selecting from every instrumented branch on every visit.
///
/// These probabilities control different decisions. A firing override cannot
/// activate a site that was excluded from the run:
///
/// ```
/// use faultline::{Buggify, BuggifyConfig, Probability};
///
/// let faults = Buggify::new(42);
/// faults.enable(BuggifyConfig {
///     activation: Probability::NEVER,
///     firing: Probability::ALWAYS,
/// })?;
/// assert!(!faults.test_with_probability("small_batch", Probability::ALWAYS));
/// assert!(!faults.snapshot()[0].activated);
///
/// faults.enable(BuggifyConfig {
///     activation: Probability::ALWAYS,
///     firing: Probability::NEVER,
/// })?;
/// assert!(!faults.test("small_batch"));
/// assert!(faults.snapshot()[0].activated);
/// assert!(faults.test_with_probability("small_batch", Probability::ALWAYS));
/// # Ok::<(), faultline::ConfigError>(())
/// ```
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BuggifyConfig {
    /// Probability of activating a site on its first visit in a run.
    pub activation: Probability,
    /// Probability that a visit to an activated site fires.
    ///
    /// [`Buggify::test_with_probability`] overrides this value for one visit.
    pub firing: Probability,
}

impl Default for BuggifyConfig {
    fn default() -> Self {
        Self {
            activation: Probability { value: 0.25 },
            firing: Probability { value: 0.25 },
        }
    }
}

/// Cumulative observations for a site in one BUGGIFY run.
///
/// Use [`Buggify::snapshot`] to inspect the current run or
/// [`BuggifyGuard::snapshot`] to retain diagnostics from a completed run.
/// An inactive site with nonzero `hits` was reached but excluded by its
/// activation decision. An active site with zero `fired` visits has not yet
/// selected its perturbation. Both counters saturate at `u64::MAX`.
///
/// Sites appear only when visited during an enabled run. An empty snapshot
/// therefore does not establish that the program contains no BUGGIFY sites.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuggifySite {
    /// The explicit name or source location identifying this site.
    pub name: &'static str,
    /// The activation decision retained for the whole run.
    pub activated: bool,
    /// Visits to this site, including visits while it is inactive.
    pub hits: u64,
    /// Visits that fired. Counts saturate at `u64::MAX`.
    pub fired: u64,
}

/// Instance-local, reproducible BUGGIFY decisions, disabled until enabled.
///
/// BUGGIFY suits broad exploration: a branch might choose a tiny batch, add
/// an extra async yield, or exercise an uncommon implementation path. The
/// application implements that behavior after a boolean decision. Use a
/// targeted [`crate::Plan`] when a test needs a specific fault schedule, such
/// as exactly two failed requests followed by recovery.
///
/// Compiling with the `failpoints` feature makes BUGGIFY available;
/// [`crate::enabled`] reports that build setting. A new controller still
/// returns false until [`Self::enable`] or [`Self::scoped`] starts a run.
/// Clones share that run, while separate controllers are isolated.
/// [`Self::decide`] makes a single seeded decision without any run.
///
/// Services normally use [`crate::Injector::buggify`] and the
/// [`crate::buggify!`] macro. The macro supplies a source-location name when
/// omitted; an explicit name also works with the direct [`Self::test`] API:
///
/// ```
/// use faultline::{buggify, BuggifyConfig, Injector, Probability};
///
/// let faults = Injector::<()>::with_seed(42);
/// assert!(!buggify!(faults, "worker.small_batch"));
/// let _run = faults.buggify().scoped(BuggifyConfig {
///     activation: Probability::ALWAYS,
///     firing: Probability::ALWAYS,
/// })?;
/// let batch_size = if buggify!(faults, "worker.small_batch") { 1 } else { 64 };
/// assert_eq!(batch_size, 1);
/// assert!(faults.buggify().test("worker.small_batch"));
/// assert_eq!(faults.buggify().snapshot()[0].hits, 2);
/// # Ok::<(), faultline::ConfigError>(())
/// ```
///
/// Each site has one independent random stream, used first for activation
/// and then for firing decisions. Unrelated site registration order and
/// traffic do not change that stream, and ordinary failpoint streams are
/// separate. Replay assumes the same seed, site names, probabilities, visit
/// order within each site, and library versions. Concurrent tasks can reach
/// a site in different orders; this controller is not a deterministic
/// scheduler and does not reproduce whole service executions by itself.
#[derive(Clone, Debug)]
pub struct Buggify {
    inner: Arc<State>,
}

#[derive(Debug)]
struct State {
    seed: u64,
    current: Mutex<Option<Arc<Run>>>,
}

#[derive(Debug)]
struct Run {
    config: BuggifyConfig,
    sites: Mutex<BTreeMap<&'static str, Site>>,
}

impl Run {
    fn snapshot(&self) -> Vec<BuggifySite> {
        self.sites
            .lock()
            .unwrap()
            .values()
            .map(|site| site.observations)
            .collect()
    }
}

#[derive(Debug)]
struct Site {
    observations: BuggifySite,
    rng: StdRng,
}

/// The random stream of one site, restarted by every run with this seed.
///
/// FNV-1a over the name keeps streams independent of registration order, and
/// the final constant separates them from a failpoint of the same name.
fn site_stream(seed: u64, name: &str) -> StdRng {
    let name_hash = name.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    StdRng::seed_from_u64(seed ^ name_hash ^ 0x6275676769667921)
}

impl Buggify {
    /// Create a disabled controller with a reproducible seed.
    ///
    /// Prefer [`crate::Injector::buggify`] when the service also has named
    /// failpoints. Construct this directly when only boolean perturbations
    /// are needed. Calls made before a run starts neither fire nor register
    /// sites, even in an instrumentation-enabled build.
    pub fn new(seed: u64) -> Self {
        Self {
            inner: Arc::new(State {
                seed,
                current: Mutex::new(None),
            }),
        }
    }

    /// Start a fresh run, discarding previous activation decisions and counts.
    ///
    /// Each run restarts the random streams from this controller's seed.
    /// Calling this while already enabled also starts over. This is a fresh
    /// run boundary, unlike FoundationDB's enable toggle, which preserves its
    /// cached site decisions until they are cleared separately. Use
    /// [`Self::scoped`] when the run should end with a lexical scope.
    ///
    /// Instrumentation-disabled builds return [`ConfigError::Disabled`].
    ///
    /// Repeating the same visits after a reset reproduces their decisions:
    ///
    /// ```
    /// use faultline::{Buggify, BuggifyConfig, Probability};
    ///
    /// let faults = Buggify::new(42);
    /// let config = BuggifyConfig {
    ///     activation: Probability::ALWAYS,
    ///     firing: Probability::new(0.5)?,
    /// };
    /// faults.enable(config)?;
    /// let first: Vec<_> = (0..32).map(|_| faults.test("extra_yield")).collect();
    ///
    /// faults.enable(config)?;
    /// assert!(faults.snapshot().is_empty());
    /// let replay: Vec<_> = (0..32).map(|_| faults.test("extra_yield")).collect();
    /// assert_eq!(first, replay);
    /// # Ok::<(), Box<dyn std::error::Error>>(())
    /// ```
    pub fn enable(&self, config: BuggifyConfig) -> Result<(), ConfigError> {
        self.install(config).map(|_| ())
    }

    /// Start a fresh run and return a guard that disables only that run.
    ///
    /// Replacing a run never restores an older one. Keep the guard alive for
    /// the intended work; dropping it immediately disables its installation.
    /// The guard owns this installation rather than a stack of configurations:
    /// its eventual cleanup cannot disable a newer run. See [`BuggifyGuard`]
    /// for an example and retained diagnostic snapshots.
    pub fn scoped(&self, config: BuggifyConfig) -> Result<BuggifyGuard, ConfigError> {
        let run = self.install(config)?;
        Ok(BuggifyGuard {
            controller: self.clone(),
            run,
        })
    }

    fn install(&self, config: BuggifyConfig) -> Result<Arc<Run>, ConfigError> {
        if !enabled() {
            return Err(ConfigError::Disabled);
        }
        let run = Arc::new(Run {
            config,
            sites: Mutex::new(BTreeMap::new()),
        });
        *self.inner.current.lock().unwrap() = Some(run.clone());
        Ok(run)
    }

    /// Disable BUGGIFY and discard the current run's activation state.
    ///
    /// Subsequent tests return false without recording visits. Decisions
    /// already returned to application code cannot be undone; join workers
    /// when the test needs all selected perturbations to finish. A live
    /// [`BuggifyGuard`] retains its run's observations after disabling.
    pub fn disable(&self) {
        self.disable_if(None);
    }

    fn disable_if(&self, owner: Option<&Arc<Run>>) {
        let mut current = self.inner.current.lock().unwrap();
        if let Some(owner) = owner {
            if !current.as_ref().is_some_and(|run| Arc::ptr_eq(run, owner)) {
                return;
            }
        }
        *current = None;
    }

    /// Return current-run site observations sorted by name.
    ///
    /// A disabled controller has no sites. Inactive sites are included once
    /// visited; no site is registered by calls made while disabled.
    /// Capture the seed, configuration and these observations when diagnosing
    /// a run. [`BuggifyGuard::snapshot`] keeps the same history available after
    /// cleanup or replacement; see [`BuggifySite`] for the counters' meaning.
    pub fn snapshot(&self) -> Vec<BuggifySite> {
        let current = self.inner.current.lock().unwrap();
        let Some(run) = current.as_ref() else {
            return Vec::new();
        };
        run.snapshot()
    }

    /// Test a site using the run's configured firing probability.
    ///
    /// The activation decision is made once and retained even when false.
    /// Returns false without registering a site while BUGGIFY is disabled.
    ///
    /// Names identify shared state: repeated calls with the same name share
    /// activation, counters and the firing stream within this controller.
    /// Prefer [`crate::buggify!`] with an injector for automatically distinct
    /// source locations, or give it the same explicit name to use this site.
    /// This synchronous decision works inside both sync and async functions;
    /// it does not sleep, yield, or perform the selected perturbation itself.
    #[must_use]
    pub fn test(&self, name: &'static str) -> bool {
        self.test_probability(name, None)
    }

    /// Override the firing probability for this visit to an activated site.
    ///
    /// This never changes the site's activation decision. Even a probability
    /// of one returns false for an inactive site or a disabled controller.
    /// The override is not stored as the next visit's default. It uses the
    /// same firing stream as [`Self::test`], so replay also requires the same
    /// sequence of overrides. [`crate::buggify_with_prob!`] exposes this
    /// operation for an injector with optional automatic site naming.
    #[must_use]
    pub fn test_with_probability(&self, name: &'static str, probability: Probability) -> bool {
        self.test_probability(name, Some(probability))
    }

    /// Make one seeded decision for a site without a controller or a run.
    ///
    /// The decision is the first draw of the stream that a run seeded with
    /// `seed` uses for `name`, so it equals that site's activation decision
    /// for the same probability. It allocates nothing, takes no lock, and
    /// records no visit. Use it when the caller already identifies each
    /// decision, for example by folding a request ordinal into the seed,
    /// and a run's activation and counters would only get in the way.
    /// Instrumentation-disabled builds return false.
    ///
    /// ```
    /// use faultline::{Buggify, BuggifyConfig, Probability};
    ///
    /// let chance = Probability::new(0.5)?;
    /// let flaky = Buggify::decide(42, "worker.flaky", chance);
    /// assert_eq!(Buggify::decide(42, "worker.flaky", chance), flaky);
    /// assert!(Buggify::decide(42, "worker.flaky", Probability::ALWAYS));
    /// assert!(!Buggify::decide(42, "worker.flaky", Probability::NEVER));
    ///
    /// let faults = Buggify::new(42);
    /// faults.enable(BuggifyConfig {
    ///     activation: chance,
    ///     firing: Probability::NEVER,
    /// })?;
    /// let _ = faults.test("worker.flaky");
    /// assert_eq!(faults.snapshot()[0].activated, flaky);
    /// # Ok::<(), Box<dyn std::error::Error>>(())
    /// ```
    #[must_use]
    pub fn decide(seed: u64, name: &str, probability: Probability) -> bool {
        enabled() && site_stream(seed, name).random_bool(probability.value)
    }

    /// The first draw of a site's seeded stream, as an integer.
    ///
    /// [`Self::decide`] compares this same draw against its probability, so
    /// a caller can pair a decision under one name with a seeded value under
    /// another, such as where a truncated body ends. Instrumentation-disabled
    /// builds return zero.
    ///
    /// ```
    /// use faultline::Buggify;
    ///
    /// let cut = Buggify::sample(42, "body.cut") % 8;
    /// assert_eq!(Buggify::sample(42, "body.cut") % 8, cut);
    /// ```
    #[must_use]
    pub fn sample(seed: u64, name: &str) -> u64 {
        if !enabled() {
            return 0;
        }
        site_stream(seed, name).random()
    }

    fn test_probability(&self, name: &'static str, probability: Option<Probability>) -> bool {
        if !enabled() {
            return false;
        }
        // Serialize the complete decision with replacement and disable. Only
        // built-in data and the RNG are accessed while either lock is held.
        let current = self.inner.current.lock().unwrap();
        let Some(run) = current.as_ref() else {
            return false;
        };
        let mut sites = run.sites.lock().unwrap();
        let site = sites.entry(name).or_insert_with(|| {
            let mut rng = site_stream(self.inner.seed, name);
            let activated = rng.random_bool(run.config.activation.value);
            Site {
                observations: BuggifySite {
                    name,
                    activated,
                    hits: 0,
                    fired: 0,
                },
                rng,
            }
        });
        site.observations.hits = site.observations.hits.saturating_add(1);
        let fired = site.observations.activated
            && site
                .rng
                .random_bool(probability.unwrap_or(run.config.firing).value);
        if fired {
            site.observations.fired = site.observations.fired.saturating_add(1);
        }
        fired
    }
}

/// Owns one BUGGIFY run and disables it when dropped if it is still current.
///
/// A stale guard never disables a replacement or restores an older run.
/// Its observations remain available after cleanup, so a test can stop
/// perturbing the service before collecting diagnostics. Keep the guard in
/// a named binding: `let _ = controller.scoped(config)?` drops it immediately.
///
/// ```
/// use faultline::{Buggify, BuggifyConfig, Probability};
///
/// let faults = Buggify::new(42);
/// let config = BuggifyConfig {
///     activation: Probability::ALWAYS,
///     firing: Probability::ALWAYS,
/// };
/// let old = faults.scoped(config)?;
/// assert!(faults.test("small_batch"));
/// let current = faults.scoped(config)?;
/// old.release();
/// assert_eq!(old.snapshot()[0].hits, 1);
/// drop(old);
/// assert!(faults.test("small_batch")); // The replacement is still enabled.
///
/// current.release();
/// assert!(!faults.test("small_batch"));
/// assert!(faults.snapshot().is_empty());
/// assert_eq!(current.snapshot()[0].fired, 1); // Completed-run diagnostics.
/// # Ok::<(), faultline::ConfigError>(())
/// ```
#[derive(Debug)]
#[must_use = "dropping the guard immediately disables this BUGGIFY run"]
pub struct BuggifyGuard {
    controller: Buggify,
    run: Arc<Run>,
}

impl BuggifyGuard {
    /// Disable this run if it is still current. Repeated releases are harmless.
    ///
    /// After another run replaces it, release only leaves this guard's
    /// diagnostic history available; it does not change the controller.
    pub fn release(&self) {
        self.controller.disable_if(Some(&self.run));
    }

    /// Return this run's site observations, including after it was replaced.
    ///
    /// Names are sorted, and releasing the guard preserves these observations.
    /// Visits made after replacement belong only to the replacement run.
    pub fn snapshot(&self) -> Vec<BuggifySite> {
        self.run.snapshot()
    }
}

impl Drop for BuggifyGuard {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(all(test, feature = "failpoints"))]
mod tests {
    use super::*;

    const SITES: [&str; 16] = [
        "site-a", "site-b", "site-c", "site-d", "site-e", "site-f", "site-g", "site-h", "site-i",
        "site-j", "site-k", "site-l", "site-m", "site-n", "site-o", "site-p",
    ];

    fn always() -> BuggifyConfig {
        BuggifyConfig {
            activation: Probability::ALWAYS,
            firing: Probability::ALWAYS,
        }
    }

    #[test]
    fn defaults_match_foundationdb_but_do_not_enable_a_run() {
        let config = BuggifyConfig::default();
        assert_eq!(config.activation, Probability::new(0.25).unwrap());
        assert_eq!(config.firing, Probability::new(0.25).unwrap());
        let buggify = Buggify::new(1);
        assert!(!buggify.test("request"));
        assert!(!buggify.test_with_probability("request", Probability::ALWAYS));
        assert!(buggify.snapshot().is_empty());
    }

    #[test]
    fn activation_and_firing_are_separate_decisions() {
        let buggify = Buggify::new(2);
        buggify
            .enable(BuggifyConfig {
                activation: Probability::NEVER,
                firing: Probability::ALWAYS,
            })
            .unwrap();
        assert!(!buggify.test("inactive"));
        assert_eq!(
            buggify.snapshot(),
            [BuggifySite {
                name: "inactive",
                activated: false,
                hits: 1,
                fired: 0,
            }]
        );

        buggify
            .enable(BuggifyConfig {
                activation: Probability::ALWAYS,
                firing: Probability::new(0.5).unwrap(),
            })
            .unwrap();
        let fired = (0..256).filter(|_| buggify.test("active")).count();
        assert!(fired > 0 && fired < 256);
        assert_eq!(
            buggify.snapshot(),
            [BuggifySite {
                name: "active",
                activated: true,
                hits: 256,
                fired: fired as u64,
            }]
        );
    }

    #[test]
    fn activation_is_never_resampled_in_a_run() {
        let buggify = Buggify::new(3);
        buggify
            .enable(BuggifyConfig {
                activation: Probability::new(0.5).unwrap(),
                firing: Probability::ALWAYS,
            })
            .unwrap();
        for name in SITES {
            let activated = buggify.test(name);
            for _ in 0..128 {
                assert_eq!(buggify.test(name), activated, "{name}");
            }
        }
        let sites = buggify.snapshot();
        assert!(sites.iter().any(|site| site.activated));
        assert!(sites.iter().any(|site| !site.activated));
        for site in sites {
            assert_eq!(site.hits, 129);
            assert_eq!(site.fired, if site.activated { 129 } else { 0 });
        }
    }

    #[test]
    fn replay_is_independent_of_other_site_registration_and_traffic() {
        let first = Buggify::new(4);
        let second = Buggify::new(4);
        first.enable(BuggifyConfig::default()).unwrap();
        second.enable(BuggifyConfig::default()).unwrap();

        let expected: BTreeMap<_, Vec<_>> = SITES
            .into_iter()
            .map(|name| (name, (0..128).map(|_| first.test(name)).collect()))
            .collect();
        for name in SITES.into_iter().rev() {
            let actual: Vec<_> = (0..128)
                .map(|_| {
                    let _ = second.test("unrelated");
                    let _ = second.test("unrelated");
                    second.test(name)
                })
                .collect();
            assert_eq!(actual, expected[name], "{name}");
        }
        assert!(
            second
                .snapshot()
                .windows(2)
                .all(|sites| sites[0].name < sites[1].name)
        );
    }

    #[test]
    fn probability_override_only_changes_firing_for_active_sites() {
        let buggify = Buggify::new(5);
        buggify
            .enable(BuggifyConfig {
                activation: Probability::NEVER,
                firing: Probability::NEVER,
            })
            .unwrap();
        assert!(!buggify.test_with_probability("site", Probability::ALWAYS));
        assert!(!buggify.snapshot()[0].activated);

        buggify
            .enable(BuggifyConfig {
                activation: Probability::ALWAYS,
                firing: Probability::NEVER,
            })
            .unwrap();
        assert!(!buggify.test("site"));
        assert!(buggify.test_with_probability("site", Probability::ALWAYS));
        assert!(!buggify.test("site"));
        assert_eq!(buggify.snapshot()[0].hits, 3);
        assert_eq!(buggify.snapshot()[0].fired, 1);
    }

    #[test]
    fn clones_share_runs_and_stale_guards_cannot_disable_replacements() {
        let first = Buggify::new(6);
        let second = first.clone();
        let old = first.scoped(always()).unwrap();
        assert!(second.test("site"));
        assert_eq!(first.snapshot()[0].hits, 1);

        let current = second.scoped(always()).unwrap();
        old.release();
        assert_eq!(old.snapshot()[0].hits, 1);
        drop(old);
        assert!(first.test("site"));
        assert!(second.test("site"));
        assert_eq!(first.snapshot()[0].hits, 2);
        current.release();
        current.release();
        assert_eq!(current.snapshot()[0].hits, 2);
        assert!(!first.test("site"));
        assert!(second.snapshot().is_empty());

        let guard = first.scoped(always()).unwrap();
        assert!(second.test("site"));
        drop(guard);
        assert!(!second.test("site"));
    }

    #[test]
    fn enabling_resets_sites_counters_and_random_streams() {
        let buggify = Buggify::new(7);
        let config = BuggifyConfig {
            activation: Probability::ALWAYS,
            firing: Probability::new(0.5).unwrap(),
        };
        buggify.enable(config).unwrap();
        let expected: Vec<_> = (0..128).map(|_| buggify.test("site")).collect();
        assert_eq!(buggify.snapshot()[0].hits, 128);

        buggify.enable(config).unwrap();
        assert!(buggify.snapshot().is_empty());
        let actual: Vec<_> = (0..128).map(|_| buggify.test("site")).collect();
        assert_eq!(actual, expected);
        assert_eq!(buggify.snapshot()[0].hits, 128);
        buggify.disable();
        assert!(buggify.snapshot().is_empty());
        assert!(!buggify.test("site"));
    }

    #[test]
    fn stateless_decisions_replay_and_follow_seed_name_and_probability() {
        let half = Probability::new(0.5).unwrap();
        let mut outcomes = [0; 2];
        for seed in 0..8 {
            for name in SITES {
                let decision = Buggify::decide(seed, name, half);
                assert_eq!(Buggify::decide(seed, name, half), decision, "{seed} {name}");
                assert!(Buggify::decide(seed, name, Probability::ALWAYS));
                assert!(!Buggify::decide(seed, name, Probability::NEVER));
                outcomes[usize::from(decision)] += 1;
            }
        }
        assert!(outcomes.iter().all(|&count| count > 0));
        assert!(
            SITES
                .into_iter()
                .any(|name| { Buggify::decide(0, name, half) != Buggify::decide(1, name, half) })
        );
        assert!((0..8).any(|seed| {
            Buggify::decide(seed, "site-a", half) != Buggify::decide(seed, "site-b", half)
        }));
    }

    #[test]
    fn samples_are_the_draw_behind_decisions() {
        let half = Probability::new(0.5).unwrap();
        for seed in 0..8 {
            for name in SITES {
                let sample = Buggify::sample(seed, name);
                assert_eq!(Buggify::sample(seed, name), sample);
                // A one-half decision is the top bit of the same draw.
                assert_eq!(
                    Buggify::decide(seed, name, half),
                    sample >> 63 == 0,
                    "{seed} {name}"
                );
            }
        }
        assert_ne!(Buggify::sample(0, "site-a"), Buggify::sample(1, "site-a"));
        assert_ne!(Buggify::sample(0, "site-a"), Buggify::sample(0, "site-b"));
    }

    #[test]
    fn stateless_decisions_match_a_runs_activation() {
        let half = Probability::new(0.5).unwrap();
        let buggify = Buggify::new(8);
        buggify
            .enable(BuggifyConfig {
                activation: half,
                firing: Probability::ALWAYS,
            })
            .unwrap();
        for name in SITES {
            assert_eq!(buggify.test(name), Buggify::decide(8, name, half), "{name}");
        }
    }
}

#[cfg(all(test, not(feature = "failpoints")))]
mod disabled_tests {
    use super::*;

    #[test]
    fn disabled_build_rejects_runs_and_never_registers_sites() {
        let buggify = Buggify::new(1);
        assert_eq!(
            buggify.enable(BuggifyConfig::default()),
            Err(ConfigError::Disabled)
        );
        assert!(matches!(
            buggify.scoped(BuggifyConfig::default()),
            Err(ConfigError::Disabled)
        ));
        assert!(!buggify.test("site"));
        assert!(!buggify.test_with_probability("site", Probability::ALWAYS));
        assert!(!Buggify::decide(1, "site", Probability::ALWAYS));
        assert_eq!(Buggify::sample(1, "site"), 0);
        buggify.disable();
        assert!(buggify.snapshot().is_empty());
    }
}
