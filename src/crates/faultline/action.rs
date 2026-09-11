// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::error::Error;
use std::fmt::{self, Display};
use std::str::FromStr;
use std::time::Duration;

/// An action performed when a failpoint is selected.
///
/// The application defines what a return payload `T` means. It can represent
/// an error, a replacement value, or an instruction to exercise an unusual
/// code path. Keeping that choice in application code gives configuration a
/// checked vocabulary without storing application callbacks in the injector.
/// Other variants coordinate execution without needing a payload.
///
/// ```
/// use faultline::{Action, Injector};
/// use std::ops::ControlFlow;
/// use std::time::Duration;
///
/// #[derive(Clone, Debug, PartialEq)]
/// enum ReadFault {
///     Unavailable,
/// }
///
/// let read = Injector::<ReadFault>::new().point("storage.read");
/// read.set(Action::Sleep(Duration::from_millis(1))).unwrap();
/// assert_eq!(read.hit(), ControlFlow::Continue(()));
/// read.set(Action::Return(ReadFault::Unavailable)).unwrap();
/// assert_eq!(read.hit(), ControlFlow::Break(ReadFault::Unavailable));
/// ```
///
/// An action becomes an unconditional, unlimited [`Rule`] unless a builder
/// adds a probability or selection limit. Passing it to [`crate::Point::set`]
/// or [`crate::Point::scoped`] installs a one-rule [`Plan`].
///
/// Evaluation requires `T: Clone`: a selected return clones its payload
/// outside the engine's locks. User cloning and injected panics can unwind
/// normally; the engine does not catch them, and the selection remains
/// counted. Replacement does not cancel a selected sleep or return, while
/// a selected pause is released. Use [`crate::Point::hit_async`] for
/// cooperative sleep and pause in asynchronous services.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action<T> {
    /// Continue normally, without considering later fallback rules.
    ///
    /// A limited `Off` rule can reserve the first few hits for normal behavior
    /// before a later rule becomes eligible. See the [`Rule`] example.
    Off,
    /// Supply a typed value to the instrumented code.
    ///
    /// [`crate::Point::hit`] returns `ControlFlow::Break(value)`; it does not
    /// return from the caller. Match that result or use [`crate::fail_point!`]
    /// to map the value into an early return from the instrumented function.
    Return(T),
    /// Sleep for the specified duration.
    ///
    /// Synchronous hits block their thread. Asynchronous hits use Tokio's
    /// timer and require a running time driver. Replacement does not shorten
    /// an already selected sleep.
    Sleep(Duration),
    /// Wait until the selected configuration is removed or replaced.
    ///
    /// Observe [`crate::Guard::wait_for_pauses`] before inspecting shared
    /// state, then release the guard. A release is remembered even if the
    /// worker has not started waiting yet.
    Pause,
    /// Yield to another thread or asynchronous task.
    ///
    /// This creates a scheduling opportunity; it does not guarantee that any
    /// particular worker runs or establish an ordering between requests.
    Yield,
    /// Panic with the supplied message.
    ///
    /// The engine includes the point name and panics outside its locks.
    /// Unwinding or process termination follows the application's panic
    /// strategy; this action does not promise that execution can recover.
    Panic(String),
}

impl<T> Action<T> {
    /// Limit this action to at most `times` selections across all callers.
    ///
    /// The limit belongs to each installed plan, shared by its worker hits.
    /// Zero makes the rule ineligible. Use [`Rule::chance`] on the returned
    /// rule to combine a finite limit with a probability.
    pub fn times(self, times: u64) -> Rule<T> {
        Rule::from(self).times(times)
    }

    /// Consider this action with the given probability on each hit.
    ///
    /// A probability miss permits the next fallback rule to be considered.
    /// The resulting rule has no selection limit until [`Rule::times`] is
    /// called. [`Probability::new`] validates values before configuration.
    pub fn chance(self, probability: Probability) -> Rule<T> {
        Rule::from(self).chance(probability)
    }

    /// Try `fallback` when this action is not selected.
    ///
    /// A plain action is always eligible, so its fallback is unreachable.
    /// Usually first call [`Self::times`] or [`Self::chance`], then append a
    /// fallback with [`Rule::or_else`]. An action that completes normally,
    /// such as `Sleep` or `Off`, still stops evaluation for that hit.
    pub fn or_else(self, fallback: impl Into<Rule<T>>) -> Plan<T> {
        Plan::from(self).or_else(fallback)
    }
}

/// A finite probability between zero and one, inclusive.
///
/// Rust configuration uses fractions, while [`Plan`]'s text syntax uses
/// percentages. Validate probabilities when accepting input so invalid
/// values fail during setup, before any worker evaluates a point. The same
/// type configures [`crate::BuggifyConfig`] activation and firing decisions.
///
/// ```
/// use faultline::{Action, Plan, Probability};
///
/// let quarter = Probability::new(0.25).unwrap();
/// let typed: Plan<u16> = Action::Return(503).chance(quarter).into();
/// let text: Plan<u16> = "25%return(503)".parse().unwrap();
/// assert_eq!(typed, text);
/// assert!(Probability::new(25.0).is_err()); // Fractions here, not percentages.
/// assert!(Probability::new(f64::NAN).is_err());
/// assert!(Probability::new(f64::INFINITY).is_err());
/// ```
///
/// [`Default`] is [`Self::ALWAYS`]. Prefer [`Self::ALWAYS`] and [`Self::NEVER`]
/// over random sampling when a test needs a guaranteed outcome. A nonzero
/// probability below one does not guarantee selection within a finite test.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Probability {
    pub(crate) value: f64,
}

impl Probability {
    /// Select the rule whenever its remaining count permits it.
    pub const ALWAYS: Self = Self { value: 1.0 };

    /// Never select the rule.
    pub const NEVER: Self = Self { value: 0.0 };

    /// Validate a probability in the inclusive range `0.0..=1.0`.
    ///
    /// Returns [`ParseError`] for NaN, infinity, and out-of-range input. The
    /// error uses action index one because no containing plan is available.
    /// Both endpoints are valid and correspond to [`Self::NEVER`] and
    /// [`Self::ALWAYS`].
    pub fn new(value: f64) -> Result<Self, ParseError> {
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err(ParseError::new(
                1,
                "probability must be finite and between 0 and 1 inclusive",
            ));
        }
        Ok(Self { value })
    }
}

impl Default for Probability {
    fn default() -> Self {
        Self::ALWAYS
    }
}

/// An action with an optional selection limit and probability.
///
/// Limits count successful selections, not visits or probability misses. A
/// zero limit disables the rule. Builders replace the corresponding setting.
/// Rules created from an [`Action`] start with unlimited selections and
/// [`Probability::ALWAYS`].
///
/// A finite `Off` rule is useful when a test must allow some operations to
/// succeed before injecting a fault:
///
/// ```
/// use faultline::{Action, Injector};
/// use std::ops::ControlFlow;
///
/// let read = Injector::<u16>::new().point("storage.read");
/// let plan = Action::Off.times(2).or_else(Action::Return(503));
/// let guard = read.scoped(plan).unwrap();
/// assert_eq!(read.hit(), ControlFlow::Continue(()));
/// assert_eq!(read.hit(), ControlFlow::Continue(()));
/// assert_eq!(read.hit(), ControlFlow::Break(503));
/// assert_eq!(guard.snapshot().triggered, 3); // Off is also a selection.
/// ```
///
/// Only one rule is selected per hit. An earlier action must be exhausted or
/// miss its probability for evaluation to reach a fallback; simply finishing
/// a sleep or yielding does not advance to another rule. Concurrent workers
/// share exact selection limits, but which worker consumes a selection
/// depends on scheduling. Once selected, cancellation does not refund it.
#[derive(Clone, Debug, PartialEq)]
pub struct Rule<T> {
    pub(crate) action: Action<T>,
    pub(crate) probability: Probability,
    pub(crate) times: Option<u64>,
}

impl<T> Rule<T> {
    /// Limit this rule to at most `times` selections across all callers.
    ///
    /// Replaces any previous limit without changing the probability. For
    /// example, `.times(5).times(2)` permits two selections per installation.
    /// Probability misses do not consume this budget.
    pub fn times(mut self, times: u64) -> Self {
        self.times = Some(times);
        self
    }

    /// Consider this rule with the given probability on each hit.
    ///
    /// Replaces any previous probability without changing the selection
    /// limit. A miss leaves that limit intact and permits fallback evaluation.
    pub fn chance(mut self, probability: Probability) -> Self {
        self.probability = probability;
        self
    }

    /// Try `fallback` when this rule is exhausted or misses its probability.
    ///
    /// Accepts either a plain [`Action`] or another [`Rule`]. The result is a
    /// two-rule [`Plan`]; append additional rules with [`Plan::or_else`].
    pub fn or_else(self, fallback: impl Into<Rule<T>>) -> Plan<T> {
        Plan::from(self).or_else(fallback)
    }
}

impl<T> From<Action<T>> for Rule<T> {
    fn from(action: Action<T>) -> Self {
        Self {
            action,
            probability: Probability::ALWAYS,
            times: None,
        }
    }
}

/// A nonempty list of rules, evaluated in order until one is selected.
///
/// A selected rule stops evaluation, including [`Action::Off`]. This is a list
/// of fallbacks, not a sequence of actions performed during one hit.
///
/// Plans are reusable configuration values, not live execution state.
/// Convert an [`Action`] or [`Rule`] with [`Into::into`] to create a one-rule
/// plan, then append fallbacks with [`Self::or_else`]. There is no empty plan:
/// use [`crate::Point::clear`] to remove configuration.
///
/// Each installation starts fresh counters and a fresh random stream. Cloning
/// a plan does not capture the counters of an existing installation:
///
/// ```
/// use faultline::{Action, Injector, Plan};
/// use std::ops::ControlFlow;
///
/// let once: Plan<u16> = Action::Return(503).times(1).into();
/// let read = Injector::<u16>::with_seed(42).point("storage.read");
/// for _ in 0..2 {
///     read.set(once.clone()).unwrap();
///     assert_eq!(read.hit(), ControlFlow::Break(503));
///     assert_eq!(read.hit(), ControlFlow::Continue(()));
/// }
/// let continue_normally: Plan<u16> = Action::Off.into();
/// read.set(continue_normally).unwrap();
/// assert_eq!(read.hit(), ControlFlow::Continue(()));
/// ```
///
/// [`FromStr`] accepts `[percent%][count*]action[(payload)]` rules separated by
/// `->`. Percentages must be finite and within `0..=100`. Supported actions are
/// `off`, `return`, `sleep`, `pause`, `yield`, and `panic`. Sleep durations are
/// integer milliseconds. Return payloads are parsed using `T::from_str`; a
/// bare `return` parses the empty string. Balanced parentheses and arrows are
/// permitted inside payloads. No escaping syntax is provided for unmatched
/// parentheses; use the typed API for arbitrary payloads.
///
/// Parsing validates the complete plan before it can be installed. The
/// [`ParseError`] example shows how an application's [`FromStr`]
/// implementation can constrain return values accepted through a CLI or
/// configuration file. Parsing is explicit; this crate does not read process
/// arguments or environment variables.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan<T> {
    pub(crate) rules: Vec<Rule<T>>,
}

impl<T> Plan<T> {
    /// Append a fallback considered only when all preceding rules miss.
    ///
    /// Consumes and returns the plan, preserving rule order. Accepts one
    /// [`Action`] or [`Rule`] at a time, rather than another whole plan.
    pub fn or_else(mut self, fallback: impl Into<Rule<T>>) -> Self {
        self.rules.push(fallback.into());
        self
    }
}

impl<T> From<Action<T>> for Plan<T> {
    fn from(action: Action<T>) -> Self {
        Self::from(Rule::from(action))
    }
}

impl<T> From<Rule<T>> for Plan<T> {
    fn from(rule: Rule<T>) -> Self {
        Self { rules: vec![rule] }
    }
}

/// Invalid failpoint configuration, with the offending rule's location.
///
/// [`Plan::from_str`] reports syntax errors and failed payload conversion
/// with a one-based rule index. [`crate::Injector::configure_str`] wraps this
/// as [`crate::ConfigError::InvalidPlan`], preserving existing configuration
/// if input is rejected. An application's payload parser can make CLI input
/// meaningful and constrain the supported faults:
///
/// ```
/// use faultline::{ConfigError, Injector};
/// use std::ops::ControlFlow;
/// use std::str::FromStr;
///
/// #[derive(Clone, Debug, PartialEq)]
/// enum ReadFault { SlowDown }
///
/// impl FromStr for ReadFault {
///     type Err = &'static str;
///     fn from_str(value: &str) -> Result<Self, Self::Err> {
///         match value {
///             "slow-down" => Ok(Self::SlowDown),
///             _ => Err("expected slow-down"),
///         }
///     }
/// }
///
/// let faults = Injector::<ReadFault>::new();
/// let read = faults.point("storage.read");
/// faults.configure_str("storage.read", "1*return(slow-down)").unwrap();
/// // These strings could come from a --failpoint option after point binding.
/// let error = faults.configure_str("storage.read", "off -> return(typo)")
///     .unwrap_err();
/// let ConfigError::InvalidPlan(error) = error else { panic!("expected a parse error") };
/// assert_eq!(error.action_index, 2);
/// assert!(error.message.contains("expected slow-down"));
/// assert_eq!(read.hit(), ControlFlow::Break(ReadFault::SlowDown));
/// ```
///
/// [`Display`] includes both the rule index and diagnostic text, suitable for
/// a setup error message. Payload errors are rendered into [`Self::message`];
/// their original concrete error type is not retained. Direct validation by
/// [`Probability::new`] uses the same error type with index one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError {
    /// One-based rule index; direct probability validation uses index one.
    pub action_index: usize,
    /// A description of the invalid input.
    pub message: String,
}

impl ParseError {
    pub(crate) fn new(action_index: usize, message: impl Into<String>) -> Self {
        Self {
            action_index,
            message: message.into(),
        }
    }
}

impl Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "action {}: {}", self.action_index, self.message)
    }
}

impl Error for ParseError {}

impl<T> FromStr for Plan<T>
where
    T: FromStr,
    T::Err: Display,
{
    type Err = ParseError;

    fn from_str(input: &str) -> Result<Self, Self::Err> {
        let rules = split_rules(input)?
            .into_iter()
            .enumerate()
            .map(|(index, rule)| parse_rule(rule, index + 1))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { rules })
    }
}

fn split_rules(input: &str) -> Result<Vec<&str>, ParseError> {
    let mut rules = Vec::new();
    let mut chars = input.char_indices().peekable();
    let mut start = 0;
    let mut depth = 0usize;
    let mut payload_ended = false;

    while let Some((index, ch)) = chars.next() {
        let action_index = rules.len() + 1;
        if depth == 0 && ch == '-' && chars.peek().is_some_and(|(_, ch)| *ch == '>') {
            chars.next();
            rules.push(&input[start..index]);
            start = index + 2;
            payload_ended = false;
            continue;
        }
        if payload_ended && !ch.is_whitespace() {
            return Err(ParseError::new(
                action_index,
                "unexpected text after closing payload parenthesis",
            ));
        }
        match ch {
            '(' => depth += 1,
            ')' if depth == 0 => {
                return Err(ParseError::new(
                    action_index,
                    "unmatched closing parenthesis",
                ));
            }
            ')' => {
                depth -= 1;
                payload_ended = depth == 0;
            }
            _ => {}
        }
    }
    if depth != 0 {
        return Err(ParseError::new(
            rules.len() + 1,
            "unmatched opening parenthesis",
        ));
    }
    rules.push(&input[start..]);
    Ok(rules)
}

fn parse_rule<T>(input: &str, action_index: usize) -> Result<Rule<T>, ParseError>
where
    T: FromStr,
    T::Err: Display,
{
    let input = input.trim();
    if input.is_empty() {
        return Err(ParseError::new(action_index, "expected an action"));
    }
    let (mut head, payload) = match input.find('(') {
        Some(index) => (&input[..index], Some(&input[index + 1..input.len() - 1])),
        None => (input, None),
    };
    head = head.trim();

    let probability = match head.split_once('%') {
        Some((percent, rest)) => {
            head = rest.trim();
            let percent = percent.trim().parse::<f64>().map_err(|error| {
                ParseError::new(action_index, format!("invalid percentage: {error}"))
            })?;
            if !percent.is_finite() || !(0.0..=100.0).contains(&percent) {
                return Err(ParseError::new(
                    action_index,
                    "percentage must be finite and between 0 and 100 inclusive",
                ));
            }
            Probability {
                value: percent / 100.0,
            }
        }
        None => Probability::ALWAYS,
    };

    let times = match head.split_once('*') {
        Some((count, rest)) => {
            head = rest.trim();
            Some(count.trim().parse::<u64>().map_err(|error| {
                ParseError::new(action_index, format!("invalid selection count: {error}"))
            })?)
        }
        None => None,
    };

    let action = match head {
        "off" | "pause" | "yield" => {
            if payload.is_some() {
                return Err(ParseError::new(
                    action_index,
                    format!("{head} does not accept a payload"),
                ));
            }
            match head {
                "off" => Action::Off,
                "pause" => Action::Pause,
                _ => Action::Yield,
            }
        }
        "return" => Action::Return(payload.unwrap_or("").parse().map_err(|error| {
            ParseError::new(action_index, format!("invalid return payload: {error}"))
        })?),
        "sleep" => {
            let milliseconds = payload
                .ok_or_else(|| ParseError::new(action_index, "sleep requires milliseconds"))?
                .trim()
                .parse::<u64>()
                .map_err(|error| {
                    ParseError::new(action_index, format!("invalid sleep milliseconds: {error}"))
                })?;
            Action::Sleep(Duration::from_millis(milliseconds))
        }
        "panic" => Action::Panic(payload.unwrap_or("injected failpoint panic").to_owned()),
        "print" | "delay" => {
            return Err(ParseError::new(
                action_index,
                format!("{head} is unsupported; use a typed return hook and application logic"),
            ));
        }
        _ => {
            return Err(ParseError::new(
                action_index,
                format!("unknown action {head:?}"),
            ));
        }
    };

    Ok(Rule {
        action,
        probability,
        times,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builders_preserve_order_and_replace_settings() {
        let half = Probability::new(0.5).unwrap();
        let plan = Action::Return(7)
            .times(5)
            .times(2)
            .chance(Probability::NEVER)
            .chance(half)
            .or_else(Action::Off.times(1))
            .or_else(Action::Return(9));

        assert_eq!(plan.rules.len(), 3);
        assert_eq!(plan.rules[0].action, Action::Return(7));
        assert_eq!(plan.rules[0].times, Some(2));
        assert_eq!(plan.rules[0].probability, half);
        assert_eq!(plan.rules[1].action, Action::Off);
        assert_eq!(plan.rules[2].times, None);
        assert_eq!(plan.rules[2].probability, Probability::ALWAYS);
    }

    #[test]
    fn parses_typed_return_values_and_fallback_rules() {
        let parsed: Plan<u64> = "25%2*return(7) -> 1*off -> return(9)".parse().unwrap();
        let built = Action::Return(7)
            .chance(Probability::new(0.25).unwrap())
            .times(2)
            .or_else(Action::Off.times(1))
            .or_else(Action::Return(9));
        assert_eq!(parsed, built);
        assert!("return(not a number)".parse::<Plan<u64>>().is_err());
        assert!("return".parse::<Plan<u64>>().is_err());
    }

    #[test]
    fn return_payload_can_be_an_application_enum() {
        #[derive(Debug, PartialEq, Eq)]
        enum Fault {
            Retry,
        }
        impl FromStr for Fault {
            type Err = &'static str;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    "retry" => Ok(Self::Retry),
                    _ => Err("expected retry"),
                }
            }
        }

        let plan: Plan<Fault> = "return(retry)".parse().unwrap();
        assert_eq!(plan.rules[0].action, Action::Return(Fault::Retry));
        let error = "off -> return(other)".parse::<Plan<Fault>>().unwrap_err();
        assert_eq!(error.action_index, 2);
        assert_eq!(error.message, "invalid return payload: expected retry");
    }

    #[test]
    fn preserves_payload_contents_and_nested_arrows() {
        let plan: Plan<String> = "return( α -> (β -> γ) 50% * ) -> panic(done)"
            .parse()
            .unwrap();
        assert_eq!(
            plan.rules[0].action,
            Action::Return(" α -> (β -> γ) 50% * ".into())
        );
        assert_eq!(plan.rules[1].action, Action::Panic("done".into()));
        assert_eq!(
            "return".parse::<Plan<String>>().unwrap().rules[0].action,
            Action::Return(String::new())
        );
        assert_eq!(
            "return()".parse::<Plan<String>>().unwrap().rules[0].action,
            Action::Return(String::new())
        );
    }

    #[test]
    fn parses_non_return_actions_and_integer_boundaries() {
        let plan: Plan<String> = "sleep(18446744073709551615) -> pause -> yield -> panic"
            .parse()
            .unwrap();
        assert_eq!(
            plan.rules[0].action,
            Action::Sleep(Duration::from_millis(u64::MAX))
        );
        assert_eq!(plan.rules[1].action, Action::Pause);
        assert_eq!(plan.rules[2].action, Action::Yield);
        assert!(matches!(plan.rules[3].action, Action::Panic(_)));
        let plan: Plan<String> = "0%0*off -> 100%18446744073709551615*off".parse().unwrap();
        assert_eq!(plan.rules[0].probability, Probability::NEVER);
        assert_eq!(plan.rules[0].times, Some(0));
        assert_eq!(plan.rules[1].probability, Probability::ALWAYS);
        assert_eq!(plan.rules[1].times, Some(u64::MAX));
    }

    #[test]
    fn rejects_invalid_probabilities_before_execution() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.1, 1.1] {
            assert!(Probability::new(value).is_err());
        }
        assert_eq!(Probability::new(0.0).unwrap(), Probability::NEVER);
        assert_eq!(Probability::new(1.0).unwrap(), Probability::ALWAYS);
        for input in ["NaN%off", "inf%off", "-1%off", "100.0001%off", "1e999%off"] {
            assert!(input.parse::<Plan<String>>().is_err(), "accepted {input:?}");
        }
    }

    #[test]
    fn rejects_malformed_rules_with_action_indices() {
        for (input, index) in [
            ("", 1),
            ("  ", 1),
            ("->off", 1),
            ("off->", 2),
            ("off-> ->yield", 2),
            ("return(unclosed", 1),
            ("off->return(extra))", 2),
            ("return(a)(b)", 1),
            ("return(a)junk", 1),
            ("off(payload)", 1),
            ("pause()", 1),
            ("yield()", 1),
            ("sleep", 1),
            ("sleep(-1)", 1),
            ("sleep(18446744073709551616)", 1),
            ("18446744073709551616*off", 1),
            ("off->print(hello)", 2),
            ("delay(1)", 1),
            ("unknown", 1),
        ] {
            let error = input.parse::<Plan<String>>().unwrap_err();
            assert_eq!(error.action_index, index, "wrong location for {input:?}");
            assert!(error.to_string().starts_with(&format!("action {index}: ")));
        }
    }
}
