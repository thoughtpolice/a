// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;
use std::fmt;
use std::ops::ControlFlow;
use std::str::FromStr;
use std::sync::{Arc, Condvar, Mutex};

use rand::{RngExt, SeedableRng, rngs::StdRng};
use tokio::sync::watch;

use crate::{Action, Buggify, ParseError, Plan, enabled};

/// Configuration failed without changing the existing plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfigError {
    /// This build has instrumentation disabled.
    Disabled,
    /// The service did not bind a point with this name.
    UnknownPoint(String),
    /// The action string could not be parsed.
    InvalidPlan(ParseError),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Disabled => f.write_str("faultline instrumentation is disabled in this build"),
            Self::UnknownPoint(name) => write!(
                f,
                "unknown failpoint {name:?}; bind it before configuration"
            ),
            Self::InvalidPlan(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ConfigError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidPlan(error) => Some(error),
            _ => None,
        }
    }
}

/// Cumulative observations, either for a point or one guard's configuration.
///
/// Counts saturate at `u64::MAX`. They record selection, before executing an
/// action, and are not rolled back if a hit future is cancelled.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// Hits observed, including hits with no eligible action.
    pub hits: u64,
    /// Actions selected, including `Off`.
    pub triggered: u64,
    /// Pause actions selected; this is cumulative, not the current waiter count.
    pub paused: u64,
}

impl Snapshot {
    fn record<T>(&mut self, action: Option<&Action<T>>) {
        self.hits = self.hits.saturating_add(1);
        if let Some(action) = action {
            self.triggered = self.triggered.saturating_add(1);
            if matches!(action, Action::Pause) {
                self.paused = self.paused.saturating_add(1);
            }
        }
    }
}

#[derive(Debug)]
struct Observations {
    snapshot: Mutex<Snapshot>,
    notifications: watch::Sender<()>,
}

impl Observations {
    fn new() -> Self {
        Self {
            snapshot: Mutex::new(Snapshot::default()),
            notifications: watch::channel(()).0,
        }
    }

    fn snapshot(&self) -> Snapshot {
        *self.snapshot.lock().unwrap()
    }

    fn record<T>(&self, action: Option<&Action<T>>) {
        self.snapshot.lock().unwrap().record(action);
    }

    fn notify(&self) {
        self.notifications.send_replace(());
    }

    async fn wait(&self, predicate: impl Fn(&Snapshot) -> bool) -> Snapshot {
        // Subscribe before checking the authoritative counters. A notification
        // between checking them and awaiting changed() remains observable.
        let mut receiver = self.notifications.subscribe();
        loop {
            let snapshot = self.snapshot();
            if predicate(&snapshot) {
                return snapshot;
            }
            receiver
                .changed()
                .await
                .expect("observation sender is alive");
        }
    }
}

/// An isolated collection of named points with a common return payload type.
///
/// Clones share configuration. New instances are independent, even when their
/// names and seeds match. Store points in service fields to avoid name lookup
/// on every request. A payload enum can represent several application faults.
///
/// # Ownership and setup
///
/// Construct one injector per independently controlled service instance, bind
/// its points with [`point`](Self::point), then configure the scenario. Workers
/// can receive either an injector clone or just the points they need. An extra
/// `Arc<Injector<T>>` is unnecessary: sharing is already internal.
///
/// ```
/// use faultline::{Action, Injector};
/// use std::ops::ControlFlow;
///
/// let service = Injector::<u16>::with_seed(42);
/// let worker = service.clone();
/// let read = service.point("s3.get_object.before");
/// worker.configure("s3.get_object.before", Action::Return(503)).unwrap();
/// assert_eq!(read.hit(), ControlFlow::Break(503));
///
/// let another_service = Injector::<u16>::with_seed(42);
/// assert!(another_service.point("s3.get_object.before").hit().is_continue());
/// ```
///
/// # Naming and payloads
///
/// Names describe an operation and boundary, such as `s3.put.before` and
/// `s3.put.after_commit`. Keep request-specific values such as object keys out
/// of names; use ordinary predicates around the hit instead. Names remain
/// bound for the injector's lifetime, including after [`clear`](Self::clear).
///
/// Every point shares `T`. A small enum works well for different application
/// faults. Typed configuration does not require `FromStr`; only
/// [`configure_str`](Self::configure_str) does. [`Point::hit`] requires
/// `T: Clone`, and sharing across threads additionally requires `Send + Sync`.
/// Handle cloning never clones a payload.
pub struct Injector<T = String> {
    inner: Arc<Registry<T>>,
}

impl<T> fmt::Debug for Injector<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Injector")
            .field("seed", &self.inner.seed)
            .field("points", &self.points())
            .finish()
    }
}

#[derive(Debug)]
struct Registry<T> {
    seed: u64,
    points: Mutex<BTreeMap<String, Point<T>>>,
    buggify: Buggify,
}

impl<T> Clone for Injector<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<T> Default for Injector<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Injector<T> {
    /// Create an empty injector with a random seed.
    pub fn new() -> Self {
        Self::with_seed(rand::random())
    }

    /// Seed shared by this injector's independently derived random streams.
    /// Record it alongside a failing test to replay its probability decisions.
    pub fn seed(&self) -> u64 {
        self.inner.seed
    }

    /// Create an injector with reproducible per-point probability streams.
    ///
    /// Streams depend on this seed and the point name, not registration order
    /// or hits on other points. Each replacement restarts the point's stream.
    /// Reproduction assumes the same plan, per-point hit order, and library
    /// versions; a seed cannot reproduce thread scheduling.
    pub fn with_seed(seed: u64) -> Self {
        Self {
            inner: Arc::new(Registry {
                seed,
                points: Mutex::new(BTreeMap::new()),
                buggify: Buggify::new(seed),
            }),
        }
    }

    /// This injector's probabilistic branch controller, initially disabled.
    ///
    /// Enable or scope a run here, then use [`crate::buggify!`] at branch sites.
    /// Clones share the run; separate injectors and ordinary point plans are
    /// independent. [`Self::clear`] also disables this controller.
    pub fn buggify(&self) -> &Buggify {
        &self.inner.buggify
    }

    /// Bind a point, or retrieve the existing point with this name.
    ///
    /// This declares instrumentation. Bind all points before accepting
    /// configuration through [`Self::configure`] or [`Self::configure_str`].
    pub fn point(&self, name: &str) -> Point<T> {
        let mut points = self.inner.points.lock().unwrap();
        points
            .entry(name.to_owned())
            .or_insert_with(|| {
                // FNV-1a gives registration-order-independent seed derivation;
                // StdRng, rather than this hash, supplies the random stream.
                let name_hash = name.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
                    (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
                });
                Point {
                    inner: Arc::new(PointInner {
                        name: name.to_owned(),
                        seed: self.inner.seed ^ name_hash,
                        current: Mutex::new(None),
                        observations: Observations::new(),
                    }),
                }
            })
            .clone()
    }

    /// Return all bound point names in sorted order, including inactive points.
    pub fn points(&self) -> Vec<String> {
        self.inner.points.lock().unwrap().keys().cloned().collect()
    }

    fn find(&self, name: &str) -> Result<Point<T>, ConfigError> {
        if !enabled() {
            return Err(ConfigError::Disabled);
        }
        self.inner
            .points
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| ConfigError::UnknownPoint(name.to_owned()))
    }

    /// Replace a declared point's plan. Unknown names are errors.
    ///
    /// A controller accepting names as input can use this method. Code already
    /// holding the point can use [`Point::set`]. Successful replacement resets
    /// the selection limits and random stream. Configuration persists until
    /// cleared or replaced; use [`Point::scoped`] for an owned test scope.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError::UnknownPoint`] for undeclared names and
    /// [`ConfigError::Disabled`] when instrumentation was compiled out.
    pub fn configure(&self, name: &str, plan: impl Into<Plan<T>>) -> Result<(), ConfigError> {
        self.find(name)?.set(plan)
    }

    /// Parse a plan, including its typed return values, before replacing it.
    ///
    /// Payload parsing and validation happen outside locks. Failed parsing
    /// leaves the existing configuration and counters intact.
    ///
    /// ```
    /// use faultline::{ConfigError, Injector};
    /// use std::ops::ControlFlow;
    ///
    /// let faults = Injector::<u16>::new();
    /// let read = faults.point("read");
    /// faults.configure_str("read", "2*return(503)").unwrap();
    /// assert_eq!(read.hit(), ControlFlow::Break(503));
    /// assert!(matches!(
    ///     faults.configure_str("read", "return(not-a-status)"),
    ///     Err(ConfigError::InvalidPlan(_))
    /// ));
    /// assert_eq!(read.hit(), ControlFlow::Break(503));
    /// assert!(read.hit().is_continue());
    /// ```
    ///
    /// See [`Plan`] for the grammar. This configures one point; it does not
    /// read an environment variable or split a `NAME=PLAN` assignment. An
    /// application CLI owns that layer.
    pub fn configure_str(&self, name: &str, plan: &str) -> Result<(), ConfigError>
    where
        T: FromStr,
        T::Err: fmt::Display,
    {
        let point = self.find(name)?;
        let plan = plan.parse::<Plan<T>>().map_err(ConfigError::InvalidPlan)?;
        point.set(plan)
    }

    /// Disable buggification, then clear every bound point and release pauses.
    ///
    /// Names and lifetime observations are retained. Clearing is atomic per
    /// point, not a transaction across points. Join workers before teardown if
    /// the service must be quiescent. Dropping an injector alone does not clear
    /// points held by workers; prefer scoped guards for tests.
    pub fn clear(&self) {
        self.inner.buggify.disable();
        let points: Vec<_> = self
            .inner
            .points
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for point in points {
            point.clear();
        }
    }
}

/// A bound failpoint, cheaply cloneable across threads and tasks.
///
/// Obtain a point with [`Injector::point`] and store it beside the operation
/// it instruments. Every clone shares the configuration and finite selection
/// budgets. Another injector's point with the same name is independent.
///
/// # Application control flow
///
/// A hit yields `ControlFlow::Break(payload)` or `ControlFlow::Continue(())`.
/// A break does not return from your function by itself: application code
/// decides how to use the payload. This supports replacement values as well
/// as errors.
///
/// ```
/// use faultline::{Action, Injector, Point};
/// use std::ops::ControlFlow;
///
/// fn batch_limit(point: &Point<usize>) -> usize {
///     match point.hit() {
///         ControlFlow::Break(limit) => limit,
///         ControlFlow::Continue(()) => 100,
///     }
/// }
///
/// let point = Injector::new().point("small_batch");
/// let _guard = point.scoped(Action::Return(1).times(1)).unwrap();
/// assert_eq!(batch_limit(&point), 1);
/// assert_eq!(batch_limit(&point), 100);
/// ```
///
/// Use [`hit_async`](Self::hit_async) in async services so sleeps and pauses
/// yield to other tasks. [`crate::fail_point!`] and [`crate::fail_point_async!`]
/// offer optional early-return syntax and call-site erasure in disabled builds.
pub struct Point<T = String> {
    inner: Arc<PointInner<T>>,
}

impl<T> fmt::Debug for Point<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Point")
            .field("name", &self.name())
            .field("snapshot", &self.snapshot())
            .finish()
    }
}

#[derive(Debug)]
struct PointInner<T> {
    name: String,
    seed: u64,
    current: Mutex<Option<Arc<Generation<T>>>>,
    observations: Observations,
}

impl<T> Clone for Point<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<T> Point<T> {
    /// The name used when this point was bound.
    pub fn name(&self) -> &str {
        &self.inner.name
    }

    /// Replace the plan until explicitly cleared or replaced again.
    ///
    /// Accepts an [`Action`], a [`crate::Rule`], or a [`Plan`]. Installation
    /// starts with fresh counts even if a clone of the same plan was used
    /// before. Returns [`ConfigError::Disabled`] in an uninstrumented build.
    pub fn set(&self, plan: impl Into<Plan<T>>) -> Result<(), ConfigError> {
        self.install(plan.into()).map(|_| ())
    }

    /// Replace the plan and return an owning cleanup/observation guard.
    ///
    /// Dropping the guard clears only this installation. It never erases a
    /// replacement and never restores an older plan. Keep it alive until the
    /// intended worker hits; `let _ = point.scoped(...)` drops it immediately.
    ///
    /// The test can retain the guard while a point clone moves into a worker.
    /// Observations refer to this installation, independent of earlier traffic.
    /// See [`Guard`] for replacement behavior and [`Guard::wait_for_pauses`]
    /// for a complete coordination example.
    pub fn scoped(&self, plan: impl Into<Plan<T>>) -> Result<Guard<T>, ConfigError> {
        let generation = self.install(plan.into())?;
        Ok(Guard {
            point: self.clone(),
            generation,
        })
    }

    fn install(&self, plan: Plan<T>) -> Result<Arc<Generation<T>>, ConfigError> {
        if !enabled() {
            return Err(ConfigError::Disabled);
        }
        let generation = Arc::new(Generation::new(plan, self.inner.seed));
        let previous = self
            .inner
            .current
            .lock()
            .unwrap()
            .replace(generation.clone());
        if let Some(previous) = previous {
            previous.release.open();
        }
        // Payload destructors run only after the point lock has been released.
        Ok(generation)
    }

    /// Remove the current plan and release all its paused hits.
    ///
    /// Already selected returns, sleeps, yields and panics still execute.
    /// Configuration changes release pauses without evaluating the new plan
    /// for that same hit.
    pub fn clear(&self) {
        self.clear_if(None);
    }

    fn clear_if(&self, owner: Option<&Arc<Generation<T>>>) {
        let previous = {
            let mut current = self.inner.current.lock().unwrap();
            if let Some(owner) = owner {
                if !current
                    .as_ref()
                    .is_some_and(|value| Arc::ptr_eq(value, owner))
                {
                    return;
                }
            }
            current.take()
        };
        if let Some(previous) = previous {
            previous.release.open();
        }
    }

    /// Lifetime observations, including hits while unconfigured.
    ///
    /// Prefer [`Guard::snapshot`] for assertions about a particular plan.
    /// A selected `Off` counts as triggered; an exhausted plan still records
    /// hits. Observations describe selection, not action completion.
    pub fn snapshot(&self) -> Snapshot {
        self.inner.observations.snapshot()
    }

    /// Wait for at least this many lifetime hits. Use an external deadline.
    ///
    /// The target is absolute: `wait_for_hits(1)` may already be satisfied by
    /// traffic before a plan was installed. Use [`Guard::wait_for_hits`] when
    /// coordinating one test configuration.
    pub async fn wait_for_hits(&self, target: u64) -> Snapshot {
        self.inner
            .observations
            .wait(|snapshot| snapshot.hits >= target)
            .await
    }

    /// Wait for at least this many lifetime pause selections.
    pub async fn wait_for_pauses(&self, target: u64) -> Snapshot {
        self.inner
            .observations
            .wait(|snapshot| snapshot.paused >= target)
            .await
    }

    fn select(&self) -> Option<Selected<T>> {
        if !enabled() {
            return None;
        }
        // Selection and observations serialize with replacement. Notifications
        // run afterward because an observer's Waker can reenter the point.
        let (generation, action) = {
            let current = self.inner.current.lock().unwrap();
            let generation = current.as_ref().cloned();
            let action = generation
                .as_ref()
                .and_then(|generation| generation.select());
            self.inner.observations.record(action.as_deref());
            (generation, action)
        };
        if let Some(generation) = &generation {
            generation.observations.notify();
        }
        self.inner.observations.notify();
        action.map(|action| Selected {
            action,
            generation: generation.expect("selected actions belong to a generation"),
        })
    }
}

impl<T: Clone> Point<T> {
    /// Select at most one action and execute it on the current thread.
    ///
    /// Return payloads become `ControlFlow::Break`; every other completed
    /// action continues. Sleep and pause block the thread: async services must
    /// use [`Self::hit_async`]. Payload cloning and actions run outside locks.
    #[must_use = "handle injected return values, or use fail_point! for side effects"]
    pub fn hit(&self) -> ControlFlow<T> {
        let Some(selected) = self.select() else {
            return ControlFlow::Continue(());
        };
        match &*selected.action {
            Action::Return(value) => return ControlFlow::Break(value.clone()),
            Action::Sleep(duration) => std::thread::sleep(*duration),
            Action::Pause => selected.generation.release.wait(),
            Action::Yield => std::thread::yield_now(),
            Action::Panic(message) => panic!("failpoint {:?}: {message}", self.name()),
            Action::Off => {}
        }
        ControlFlow::Continue(())
    }

    /// Select an action and execute it cooperatively on Tokio.
    ///
    /// No lock is held across an await. Counts are reserved on the first poll;
    /// cancelling a selected action consumes its count and preserves its hit
    /// observations. Sleep requires a Tokio time driver; pause itself can be
    /// awaited on any executor. Return payload cloning is synchronous.
    #[must_use = "futures do nothing unless awaited"]
    pub async fn hit_async(&self) -> ControlFlow<T> {
        let Some(selected) = self.select() else {
            return ControlFlow::Continue(());
        };
        match &*selected.action {
            Action::Return(value) => return ControlFlow::Break(value.clone()),
            Action::Sleep(duration) => tokio::time::sleep(*duration).await,
            Action::Pause => selected.generation.release.wait_async().await,
            Action::Yield => tokio::task::yield_now().await,
            Action::Panic(message) => panic!("failpoint {:?}: {message}", self.name()),
            Action::Off => {}
        }
        ControlFlow::Continue(())
    }
}

/// Owns one installation, including its observation history and paused hits.
///
/// Dropping or releasing the guard clears only its own current installation.
/// Replacing it releases its pauses immediately; a stale guard remains useful
/// for reading its final counters. Cleanup does not panic on unmet hit counts.
///
/// # Replacement is not a stack
///
/// Scoped guards represent ownership of installations, not nested overrides.
/// This keeps cleanup well-defined when several threads reconfigure a point.
/// Dropping the newer guard clears the point instead of reviving an old plan.
///
/// ```
/// use faultline::{Action, Injector};
/// use std::ops::ControlFlow;
///
/// let point = Injector::new().point("request");
/// let old = point.scoped(Action::Return(500)).unwrap();
/// let current = point.scoped(Action::Return(503)).unwrap();
/// drop(old);
/// assert_eq!(point.hit(), ControlFlow::Break(503));
/// current.release();
/// assert!(point.hit().is_continue());
/// assert_eq!(current.snapshot().triggered, 1);
/// ```
///
/// Assert required hits explicitly through [`snapshot`](Self::snapshot).
/// Automatic assertions during drop could cause a second panic during test
/// unwinding. Cleanup releases pauses but does not join workers or roll back
/// application state; the test remains responsible for those steps.
#[must_use = "dropping the guard immediately clears this installation"]
pub struct Guard<T = String> {
    point: Point<T>,
    generation: Arc<Generation<T>>,
}

impl<T> fmt::Debug for Guard<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Guard")
            .field("point", &self.point.name())
            .field("snapshot", &self.snapshot())
            .finish()
    }
}

impl<T> Guard<T> {
    /// Clear this installation if still current, releasing its paused hits.
    /// Idempotent. No previously installed plan is restored.
    pub fn release(&self) {
        self.point.clear_if(Some(&self.generation));
    }

    /// Observations for only this installation.
    pub fn snapshot(&self) -> Snapshot {
        self.generation.observations.snapshot()
    }

    /// Wait for this installation to observe at least `target` hits.
    ///
    /// Use an external deadline: replacement, release, or worker cancellation
    /// may mean the requested count is never reached.
    pub async fn wait_for_hits(&self, target: u64) -> Snapshot {
        self.generation
            .observations
            .wait(|snapshot| snapshot.hits >= target)
            .await
    }

    /// Wait for this installation to select at least `target` pause actions.
    ///
    /// Selection has reserved the action and its release mechanism before
    /// observers are notified, so releasing immediately is safe even if the
    /// worker has not started waiting yet. Use an external deadline.
    ///
    /// ```
    /// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
    /// use faultline::{Action, Injector};
    /// use std::time::Duration;
    ///
    /// let point = Injector::<()>::new().point("after_commit");
    /// let guard = point.scoped(Action::Pause)?;
    /// let worker = tokio::spawn(async move { point.hit_async().await });
    /// tokio::time::timeout(Duration::from_secs(5), guard.wait_for_pauses(1)).await?;
    /// // Inspect the application state established before the point.
    /// guard.release();
    /// assert!(tokio::time::timeout(Duration::from_secs(5), worker).await??.is_continue());
    /// assert_eq!(guard.snapshot().paused, 1);
    /// # Ok(())
    /// # }
    /// # tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(example()).unwrap();
    /// ```
    pub async fn wait_for_pauses(&self, target: u64) -> Snapshot {
        self.generation
            .observations
            .wait(|snapshot| snapshot.paused >= target)
            .await
    }
}

impl<T> Drop for Guard<T> {
    fn drop(&mut self) {
        self.release();
    }
}

#[derive(Debug)]
struct Selected<T> {
    action: Arc<Action<T>>,
    generation: Arc<Generation<T>>,
}

#[derive(Debug)]
struct Generation<T> {
    state: Mutex<Selection<T>>,
    observations: Observations,
    release: Release,
}

#[derive(Debug)]
struct Selection<T> {
    rules: Vec<RuntimeRule<T>>,
    rng: StdRng,
}

#[derive(Debug)]
struct RuntimeRule<T> {
    action: Arc<Action<T>>,
    probability: f64,
    remaining: Option<u64>,
}

impl<T> Generation<T> {
    fn new(plan: Plan<T>, seed: u64) -> Self {
        Self {
            state: Mutex::new(Selection {
                rules: plan
                    .rules
                    .into_iter()
                    .map(|rule| RuntimeRule {
                        action: Arc::new(rule.action),
                        probability: rule.probability.value,
                        remaining: rule.times,
                    })
                    .collect(),
                rng: StdRng::seed_from_u64(seed),
            }),
            observations: Observations::new(),
            release: Release::new(),
        }
    }

    fn select(&self) -> Option<Arc<Action<T>>> {
        let mut state = self.state.lock().unwrap();
        let Selection { rules, rng } = &mut *state;
        let action = rules.iter_mut().find_map(|rule| {
            if rule.remaining == Some(0) || rule.probability == 0.0 {
                return None;
            }
            if rule.probability < 1.0 && !rng.random_bool(rule.probability) {
                return None;
            }
            if let Some(remaining) = &mut rule.remaining {
                *remaining -= 1;
            }
            Some(rule.action.clone())
        });
        self.observations.record(action.as_deref());
        action
    }
}

#[derive(Debug)]
struct Release {
    open: Mutex<bool>,
    sync: Condvar,
    asynchronous: watch::Sender<bool>,
}

impl Release {
    fn new() -> Self {
        Self {
            open: Mutex::new(false),
            sync: Condvar::new(),
            asynchronous: watch::channel(false).0,
        }
    }

    fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.asynchronous.send_replace(true);
        self.sync.notify_all();
    }

    fn wait(&self) {
        drop(
            self.sync
                .wait_while(self.open.lock().unwrap(), |open| !*open)
                .unwrap(),
        );
    }

    async fn wait_async(&self) {
        let mut receiver = self.asynchronous.subscribe();
        drop(
            receiver
                .wait_for(|open| *open)
                .await
                .expect("release sender is alive"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Probability;

    #[test]
    fn invalid_configuration_preserves_the_plan_and_remaining_count() {
        let faults = Injector::<u16>::new();
        let point = faults.point("put");
        faults.configure_str("put", "2*return(503)").unwrap();
        assert_eq!(point.hit(), ControlFlow::Break(503));
        let error = faults.configure_str("put", "NaN%return(500)").unwrap_err();
        assert!(matches!(error, ConfigError::InvalidPlan(_)));
        assert_eq!(point.hit(), ControlFlow::Break(503));
        assert_eq!(point.hit(), ControlFlow::Continue(()));
        assert!(matches!(
            faults.configure_str("ptu", "return(500)"),
            Err(ConfigError::UnknownPoint(name)) if name == "ptu"
        ));
        assert_eq!(faults.points(), ["put"]);
    }

    #[test]
    fn off_counts_as_a_selection_and_fallbacks_are_not_sequences() {
        let point = Injector::<u16>::new().point("put");
        let guard = point
            .scoped(Action::Off.times(2).or_else(Action::Return(503).times(1)))
            .unwrap();
        assert_eq!(point.hit(), ControlFlow::Continue(()));
        assert_eq!(point.hit(), ControlFlow::Continue(()));
        assert_eq!(point.hit(), ControlFlow::Break(503));
        assert_eq!(point.hit(), ControlFlow::Continue(()));
        assert_eq!(
            guard.snapshot(),
            Snapshot {
                hits: 4,
                triggered: 3,
                paused: 0
            }
        );
    }

    #[test]
    fn seeded_streams_ignore_other_points_and_registration_order() {
        fn run(extra: bool) -> Vec<ControlFlow<u16>> {
            let faults = Injector::with_seed(42);
            if extra {
                let _ = faults.point("registered-first");
            }
            let point = faults.point("put");
            let noisy = faults.point("get");
            let plan = Action::Return(503).chance(Probability::new(0.5).unwrap());
            point.set(plan.clone()).unwrap();
            noisy.set(plan).unwrap();
            (0..256)
                .map(|_| {
                    if extra {
                        let _ = noisy.hit();
                    }
                    point.hit()
                })
                .collect()
        }
        let stream = run(false);
        assert_eq!(stream, run(true));
        assert!(stream.contains(&ControlFlow::Break(503)));
        assert!(stream.contains(&ControlFlow::Continue(())));
    }

    #[test]
    fn probability_misses_do_not_consume_the_selection_limit() {
        let point = Injector::with_seed(42).point("put");
        point
            .set(
                Action::Return(503)
                    .chance(Probability::new(0.25).unwrap())
                    .times(7),
            )
            .unwrap();
        let failures = (0..1024)
            .filter(|_| point.hit() == ControlFlow::Break(503))
            .count();
        assert_eq!(failures, 7);
        point
            .set(
                Action::Return(500)
                    .chance(Probability::NEVER)
                    .or_else(Action::Return(503)),
            )
            .unwrap();
        assert_eq!(point.hit(), ControlFlow::Break(503));
    }

    #[tokio::test]
    async fn release_between_selection_and_wait_is_remembered() {
        let point = Injector::<u16>::new().point("put");
        let guard = point.scoped(Action::Pause).unwrap();
        // Exercise the precise boundary independently of scheduler luck.
        let selected = point.select().unwrap();
        assert_eq!(guard.snapshot().paused, 1);
        drop(guard);
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            selected.generation.release.wait_async(),
        )
        .await
        .unwrap();
        selected.generation.release.wait();
    }

    #[test]
    fn injected_panics_do_not_poison_configuration_locks() {
        let point = Injector::<u16>::new().point("put");
        let guard = point.scoped(Action::Panic("injected".into())).unwrap();
        let worker = point.clone();
        assert!(std::thread::spawn(move || worker.hit()).join().is_err());
        drop(guard);
        point.set(Action::Return(503)).unwrap();
        assert_eq!(point.hit(), ControlFlow::Break(503));
    }

    #[test]
    fn payload_clone_and_drop_run_outside_internal_locks() {
        struct Payload(Arc<dyn Fn() + Send + Sync>);
        impl Clone for Payload {
            fn clone(&self) -> Self {
                (self.0)();
                Self(self.0.clone())
            }
        }
        impl Drop for Payload {
            fn drop(&mut self) {
                (self.0)();
            }
        }
        let point = Injector::<Payload>::new().point("put");
        let weak = Arc::downgrade(&point.inner);
        let payload = Payload(Arc::new(move || {
            let inner = weak.upgrade().unwrap();
            let current = inner
                .current
                .try_lock()
                .expect("payload code must not hold point lock");
            if let Some(generation) = current.as_ref() {
                drop(
                    generation
                        .state
                        .try_lock()
                        .expect("payload code must not hold selection lock"),
                );
            }
        }));
        point.set(Action::Return(payload)).unwrap();
        drop(point.hit());
        point.set(Action::Off).unwrap();
        point.clear();
    }

    #[test]
    fn observer_wakers_run_after_selection_locks_are_released() {
        use std::future::Future;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::task::{Context, Wake, Waker};

        struct AssertUnlocked {
            point: Point<u16>,
            generation: Arc<Generation<u16>>,
            wakes: AtomicUsize,
        }

        impl Wake for AssertUnlocked {
            fn wake(self: Arc<Self>) {
                self.wake_by_ref();
            }

            fn wake_by_ref(self: &Arc<Self>) {
                let _current = self
                    .point
                    .inner
                    .current
                    .try_lock()
                    .expect("observer woke while point lock was held");
                let _state = self
                    .generation
                    .state
                    .try_lock()
                    .expect("observer woke while selection lock was held");
                let _snapshot = self
                    .generation
                    .observations
                    .snapshot
                    .try_lock()
                    .expect("observer woke while observation lock was held");
                self.wakes.fetch_add(1, Ordering::Relaxed);
            }
        }

        let point = Injector::<u16>::new().point("put");
        let guard = point.scoped(Action::Off.times(1)).unwrap();
        let observer = Arc::new(AssertUnlocked {
            point: point.clone(),
            generation: guard.generation.clone(),
            wakes: AtomicUsize::new(0),
        });
        let waker = Waker::from(observer.clone());
        let mut context = Context::from_waker(&waker);

        for target in 1..=2 {
            let mut guard_wait = std::pin::pin!(guard.wait_for_hits(target));
            let mut point_wait = std::pin::pin!(point.wait_for_hits(target));
            assert!(guard_wait.as_mut().poll(&mut context).is_pending());
            assert!(point_wait.as_mut().poll(&mut context).is_pending());

            // The second hit exhausts the plan but must still notify both
            // observers about the visit to the installed generation.
            assert_eq!(point.hit(), ControlFlow::Continue(()));
            assert!(guard_wait.as_mut().poll(&mut context).is_ready());
            assert!(point_wait.as_mut().poll(&mut context).is_ready());
        }
        assert!(observer.wakes.load(Ordering::Relaxed) >= 2);
        assert_eq!(guard.snapshot().hits, 2);
        assert_eq!(guard.snapshot().triggered, 1);
    }

    #[test]
    fn handle_debug_does_not_format_payloads_or_require_payload_debug() {
        struct Payload;

        impl fmt::Debug for Payload {
            fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
                panic!("handle diagnostics must not format user payloads");
            }
        }

        let faults = Injector::<Payload>::with_seed(7);
        let point = faults.point("put");
        let guard = point.scoped(Action::Return(Payload)).unwrap();
        assert!(format!("{faults:?}").contains("put"));
        assert!(format!("{point:?}").contains("put"));
        assert!(format!("{guard:?}").contains("put"));

        struct WithoutDebug;
        fn assert_debug<T: fmt::Debug>() {}
        assert_debug::<Injector<WithoutDebug>>();
        assert_debug::<Point<WithoutDebug>>();
        assert_debug::<Guard<WithoutDebug>>();
    }
}
