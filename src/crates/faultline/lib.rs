// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

#![doc = include_str!("README.md")]
#![forbid(unsafe_code)]
#![deny(missing_docs, missing_debug_implementations)]
#![deny(rustdoc::broken_intra_doc_links)]

mod action;
mod buggify;
mod engine;

pub use action::{Action, ParseError, Plan, Probability, Rule};
pub use buggify::{Buggify, BuggifyConfig, BuggifyGuard, BuggifySite};
pub use engine::{ConfigError, Guard, Injector, Point, Snapshot};

/// Whether this library was built with the `failpoints` feature.
pub const fn enabled() -> bool {
    cfg!(feature = "failpoints")
}

/// Evaluate a point, optionally returning from the enclosing function.
///
/// `fail_point!(point, |value| result)` constructs and invokes the mapper only
/// for a return action. The point expression is evaluated once and borrowed.
/// `fail_point!(point)` supports side effects; a return action panics because
/// there is no mapping to the enclosing return type. Use [`Point::hit`] and
/// ordinary `ControlFlow` matching when explicit control flow is clearer.
///
/// Disabled builds erase all arguments, including their evaluation and types.
/// Put request predicates in an ordinary `if` around the macro.
///
/// ```
/// use faultline::{Action, Injector, Point, fail_point};
///
/// fn read(point: &Point<&'static str>) -> Result<(), &'static str> {
///     fail_point!(point, |error| Err(error));
///     Ok(())
/// }
///
/// let point = Injector::new().point("read");
/// let _guard = point.scoped(Action::Return("retry").times(1)).unwrap();
/// assert_eq!(read(&point), Err("retry"));
/// assert_eq!(read(&point), Ok(()));
/// ```
///
/// Because the mapper expression is inside the selected-return branch, it can
/// capture and consume request-local values without moving them on healthy
/// calls. Returning from a macro invocation obeys ordinary Rust scope rules:
/// an invocation inside a closure returns from that closure.
#[cfg(feature = "failpoints")]
#[macro_export]
macro_rules! fail_point {
    ($point:expr, $map:expr $(,)?) => {{
        if let ::std::ops::ControlFlow::Break(value) = ($point).hit() {
            return ($map)(value);
        }
    }};
    ($point:expr $(,)?) => {{
        let point = &$point;
        if let ::std::ops::ControlFlow::Break(_) = point.hit() {
            panic!(
                "failpoint {:?} returned without a return mapper",
                point.name()
            );
        }
    }};
}

/// Disabled counterpart of [`fail_point!`], erasing all argument expressions.
#[cfg(not(feature = "failpoints"))]
#[macro_export]
macro_rules! fail_point {
    ($point:expr, $map:expr $(,)?) => {{}};
    ($point:expr $(,)?) => {{}};
}

/// Like [`fail_point!`], using [`Point::hit_async`] and awaiting internally.
///
/// Call this inside an async function without a trailing `.await`.
/// Pauses and sleeps cooperate with other tasks; the mapper itself is ordinary
/// synchronous code. Use [`Point::hit_async`] directly when interpreting the
/// payload requires its own awaits or should continue the enclosing function.
///
/// ```
/// # async fn example() -> Result<(), Box<dyn std::error::Error>> {
/// use faultline::{Action, Injector, Point, fail_point_async};
///
/// async fn read(point: &Point<u16>) -> Result<(), u16> {
///     fail_point_async!(point, |status| Err(status));
///     Ok(())
/// }
///
/// let point = Injector::new().point("read");
/// let _guard = point.scoped(Action::Return(503).times(1))?;
/// assert_eq!(read(&point).await, Err(503));
/// assert_eq!(read(&point).await, Ok(()));
/// # Ok(())
/// # }
/// # tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(example()).unwrap();
/// ```
#[cfg(feature = "failpoints")]
#[macro_export]
macro_rules! fail_point_async {
    ($point:expr, $map:expr $(,)?) => {{
        if let ::std::ops::ControlFlow::Break(value) = ($point).hit_async().await {
            return ($map)(value);
        }
    }};
    ($point:expr $(,)?) => {{
        let point = &$point;
        if let ::std::ops::ControlFlow::Break(_) = point.hit_async().await {
            panic!(
                "failpoint {:?} returned without a return mapper",
                point.name()
            );
        }
    }};
}

/// Disabled counterpart of [`fail_point_async!`], erasing even the await.
#[cfg(not(feature = "failpoints"))]
#[macro_export]
macro_rules! fail_point_async {
    ($point:expr, $map:expr $(,)?) => {{}};
    ($point:expr $(,)?) => {{}};
}

/// Test an instance-local probabilistic branch, inspired by FoundationDB.
///
/// `buggify!(injector)` identifies the site by module, file, line and column.
/// `buggify!(injector, "stable-name")` uses a name that survives code movement;
/// repeated uses of that name intentionally share activation and hit counts.
/// Each site's activation is chosen once per run, and active sites then fire
/// with the run's probability on each visit. Configure the run through
/// [`Injector::buggify`]. It is disabled by default.
///
/// This synchronous boolean works in both sync and async code. A disabled
/// build expands to `false` without evaluating or type-checking its arguments.
/// A body in `if buggify!(...) { body }` is still type-checked by Rust.
#[cfg(feature = "failpoints")]
#[macro_export]
macro_rules! buggify {
    ($injector:expr $(,)?) => {{
        ($injector).buggify().test(concat!(
            module_path!(),
            "@",
            file!(),
            ":",
            line!(),
            ":",
            column!()
        ))
    }};
    ($injector:expr, $name:expr $(,)?) => {{ ($injector).buggify().test($name) }};
}

/// Disabled counterpart of [`buggify!`], returning `false` and erasing inputs.
#[cfg(not(feature = "failpoints"))]
#[macro_export]
macro_rules! buggify {
    ($injector:expr $(,)?) => {{ false }};
    ($injector:expr, $name:expr $(,)?) => {{ false }};
}

/// Like [`buggify!`], overriding only the firing probability for this visit.
///
/// `buggify_with_prob!(injector, probability)` uses an automatic site name;
/// `buggify_with_prob!(injector, "stable-name", probability)` names it.
/// The probability is a validated [`Probability`]. This never overrides a
/// site's once-per-run activation decision.
///
/// ```
/// use faultline::{BuggifyConfig, Injector, Probability, buggify_with_prob};
///
/// let faults = Injector::<()>::with_seed(7);
/// let _run = faults.buggify().scoped(BuggifyConfig {
///     activation: Probability::ALWAYS,
///     firing: Probability::NEVER,
/// }).unwrap();
/// assert!(buggify_with_prob!(faults, "small_batch", Probability::ALWAYS));
/// assert!(!buggify_with_prob!(faults, "small_batch", Probability::NEVER));
/// ```
#[cfg(feature = "failpoints")]
#[macro_export]
macro_rules! buggify_with_prob {
    ($injector:expr, $probability:expr $(,)?) => {{
        ($injector).buggify().test_with_probability(
            concat!(module_path!(), "@", file!(), ":", line!(), ":", column!()),
            $probability,
        )
    }};
    ($injector:expr, $name:expr, $probability:expr $(,)?) => {{
        ($injector)
            .buggify()
            .test_with_probability($name, $probability)
    }};
}

/// Disabled counterpart of [`buggify_with_prob!`], erasing all inputs.
#[cfg(not(feature = "failpoints"))]
#[macro_export]
macro_rules! buggify_with_prob {
    ($injector:expr, $probability:expr $(,)?) => {{ false }};
    ($injector:expr, $name:expr, $probability:expr $(,)?) => {{ false }};
}
