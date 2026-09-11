<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# faultline

Typed fault injection for concurrent services. Each service instance owns its
faults, and each test can configure its own instance while other tests run.
This is a fresh implementation informed by
[`fail-parallel`](https://raw.githubusercontent.com/slatedb/fail-parallel/refs/heads/master/src/lib.rs),
intended for mems3 and the storage clients tested against it.

```rust
use faultline::{Action, Injector};
use std::ops::ControlFlow;

let faults = Injector::<u16>::new();
let put = faults.point("s3.put_object.before");
let guard = put.scoped(Action::Return(503).times(2)).unwrap();

assert_eq!(put.hit(), ControlFlow::Break(503));
assert_eq!(put.hit(), ControlFlow::Break(503));
assert_eq!(put.hit(), ControlFlow::Continue(()));
assert_eq!(guard.snapshot().triggered, 2);
```

Use `root//src/crates/faultline:faultline` for enabled instrumentation. The
`root//src/crates/faultline:disabled` target exports the same crate name and API
without the `failpoints` feature. Both synchronous and asynchronous macros
erase their arguments in that build, including evaluation and type checking.
Direct hit methods are inert too, but their argument expressions still run as
with any ordinary method. Configuration fails with `ConfigError::Disabled`
instead of reporting a successful test setup that cannot inject anything.

Build and test with:

```console
buck2 test //src/crates/faultline:
```

Runnable programs live in `examples/`, and each one also runs as a test.
Try them with `buck2 run //src/crates/faultline:example-<name>`:

| Example | Shows |
| --- | --- |
| `retry` | Text-configured plans, typed payloads, and a client retry loop |
| `ambiguous_write` | Pausing an async write after commit; failing a committed write |
| `deadline` | Injected async latency against a client timeout |
| `buggify` | Seeded BUGGIFY exploration; pass a seed to replay one run |

External-consumer tests for the enabled and disabled builds live in `tests/`.

This README is also the crate's rustdoc landing page. Its Rust examples and
the examples on individual API items run as doctests in the enabled build.
Build browsable API documentation with:

```console
buck2 build '//src/crates/faultline:faultline[doc]' --show-output
```

## Motivation

A storage client can pass every happy-path test and still mishandle the
second retry, a cancelled upload, or a write whose response is lost after
commit. Creating those conditions through real resource exhaustion or
unreliable networking makes a regression test difficult to control. An
instrumented boundary lets a test choose the condition directly and assert
the client's response to it.

For mems3, the distinction between a failed write and an uncertain write is
particularly useful. An error before modifying the store means the operation
did not commit. An error after modifying the store means the caller cannot
infer the final state from the response. The client must reconcile or retry
according to its own protocol. Both cases can use the same error type, but
need different injection points.

Fault injection complements ordinary mocks and integration tests. A mock can
define a collaborator's whole behavior; a point changes a particular moment
inside an otherwise real implementation. A real dependency failure can also
have effects that the chosen point does not model. State the property being
tested and choose the boundary that actually exercises it.

## Design principles

1. **Ownership defines isolation.** A service gets an [`Injector`]. Its workers
   share clones, while another service gets a new injector. State follows the
   service across threads and tasks; it does not depend on thread-local or
   process-global test setup.
2. **The application owns the fault's meaning.** A [`Point<T>`](Point) yields
   a typed value. The S3 layer decides which status to send, which body to
   truncate, or which invariant to perturb. The crate does not need to know
   about HTTP, buckets, or transaction semantics.
3. **Configuration should expose mistakes.** Named points are declared before
   configuration, text is parsed before replacement, and disabled builds
   reject setup. An unknown name or invalid error code should fail the test
   setup instead of silently weakening it.
4. **Observe events instead of guessing elapsed time.** A scoped pause and
   [`Guard::wait_for_pauses`] establish an explicit ordering. Sleeping in a
   test for an arbitrary interval does not establish that a worker arrived.
5. **Cleanup owns one installation.** A guard can remove its own configuration
   and wake its pauses. It cannot erase a later configuration or resurrect an
   earlier one. Assertions about required hits remain explicit in the test.
6. **Be precise about reproducibility.** Exact counts and explicit coordination
   make targeted scenarios repeatable. Seeds repeat probability streams;
   replaying task scheduling requires an additional simulation framework.

## Choosing an injection mechanism

| Test intention | Mechanism | Example |
| --- | --- | --- |
| Exercise a known retry path | A named point with a finite [`Rule`] | Fail exactly two GETs, then allow recovery |
| Inspect a specific concurrent state | [`Action::Pause`] with a [`Guard`] | Observe a committed PUT before releasing its response |
| Inject a known delay | [`Action::Sleep`] with [`Point::hit_async`] | Keep a request pending past the client's deadline |
| Explore many combinations of perturbations | [`buggify!`] | Sometimes use tiny chunks or yield between operations |
| Select requests by bucket, key, or operation | Ordinary Rust around a point | Only count matching object reads |

Use a named point when the test needs to force a condition. Use BUGGIFY when
the test should remain correct across many generated conditions. A BUGGIFY
site can be inactive for an entire run; an assertion that requires it to fire
should use explicit probabilities or a targeted point instead.

## Rust interface

`Injector<T>` owns a registry; clones share it and separate instances are
independent. `point(name)` declares a point and returns a cheap cloneable
handle. Bind these during service construction and put them in service fields.
Repeated binding of one name retrieves the same point. `configure` and
`configure_str` only accept declared names, so a typo is an error. `points()`
lists names in sorted order, including inactive points.

`Point<T>::hit()` and `hit_async().await` return `ControlFlow<T>`. The application
owns the meaning of `T`: an S3 error enum, a response code, a corruption mode,
or a replacement value. Payloads need `Clone` for evaluation and `Send + Sync`
to share across tasks. Use `Arc<T>` when cloning a large payload is undesirable.
One injector has one payload type; use an enum for several kinds of fault.

Here is a small service with a typed failure boundary. The first two matching
reads fail, an unrelated service remains healthy, and the next read recovers:

```rust
use faultline::{Action, Injector, Point};
use std::ops::ControlFlow;

#[derive(Clone, Debug, PartialEq, Eq)]
enum ReadError {
    SlowDown,
}

#[derive(Clone)]
struct Reader {
    before_read: Point<ReadError>,
}

impl Reader {
    fn new(faults: &Injector<ReadError>) -> Self {
        Self { before_read: faults.point("s3.get_object.before") }
    }

    fn read(&self, key: &str) -> Result<&'static str, ReadError> {
        // Only matching requests visit the point or consume a selection.
        if key.starts_with("manifests/") {
            if let ControlFlow::Break(error) = self.before_read.hit() {
                return Err(error);
            }
        }
        Ok("object contents")
    }
}

let faults = Injector::new();
let reader = Reader::new(&faults);
let healthy = Reader::new(&Injector::new());
let guard = reader.before_read.scoped(Action::Return(ReadError::SlowDown).times(2)).unwrap();

assert!(reader.read("data/block").is_ok());
assert_eq!(reader.read("manifests/latest"), Err(ReadError::SlowDown));
assert_eq!(reader.clone().read("manifests/latest"), Err(ReadError::SlowDown));
assert!(healthy.read("manifests/latest").is_ok());
assert!(reader.read("manifests/latest").is_ok());
assert_eq!(guard.snapshot().triggered, 2);
```

The point's shared limit belongs to the service, so worker clones consume the
same budget. The test owns the guard separately from the service. For an async
handler, replace `hit()` with `hit_async().await`; using a synchronous hit for
a pause or sleep blocks the executor thread.

Use ordinary matching, or the optional early-return macros:

```rust
async fn read(point: &faultline::Point<u16>) -> Result<(), u16> {
    faultline::fail_point_async!(point, |code| Err(code));
    Ok(())
}
```

The mapper is constructed only when a return action is selected. A point-only
macro invocation supports side effects and panics if configured to return
without a mapper. Predicates belong in ordinary Rust `if` expressions around
the hit; bucket/key selection stays in the S3 layer.

`point.set(plan)` installs persistent configuration. `point.scoped(plan)`
returns a guard that clears its own installation on drop. Replacing a plan
releases its paused hits; dropping a stale guard cannot erase the replacement.
Guards do **not** restore earlier plans, even when scopes are nested. This
avoids resurrecting an old fault after concurrent configuration changes.

## Deterministic pauses

```rust
# async fn example() -> Result<(), Box<dyn std::error::Error>> {
use faultline::{Action, Injector};
use std::time::Duration;

let faults = Injector::<u16>::new();
let put = faults.point("s3.put_object.after_commit");
let guard = put.scoped(Action::Pause)?;
let worker = tokio::spawn(async move { put.hit_async().await });

tokio::time::timeout(Duration::from_secs(5), guard.wait_for_pauses(1)).await?;
// The worker selected this installation's pause. Inspect application state.
drop(guard);
assert!(tokio::time::timeout(Duration::from_secs(5), worker).await??.is_continue());
# Ok(())
# }
# tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(example()).unwrap();
```

Observation is published **after action selection**. A release that happens
before the worker actually starts waiting is retained. Notifications store a
signal that observations changed; observations retain cumulative counters
without enqueueing an unbounded event per hit.
`hits`, `triggered`, and `paused` count visits, selected actions, and selected
pauses respectively; `paused` is not a count of currently blocked workers.
Point snapshots cover their lifetime. Guard snapshots cover one installation,
so earlier test traffic cannot satisfy a new pause expectation.

Waits also work when the target count was reached before subscribing. Give
them a deadline: an abandoned worker or a replaced plan may never reach it.
Cancellation after selection consumes a finite count, preserves observations,
and drops the waiter. No internal lock is held across user code or an await.

### What a pause proves

Observing a selected pause proves that the worker reached that instrumentation
boundary and reserved that installation's pause action. It does not prove that
an external write is durable or that another subsystem has caught up. Put the
point after the application event whose ordering you need to establish.

For a write test, the sequence might be: mutate the store, release its storage
lock, hit `s3.put_object.after_commit`, wait for the pause in the test, verify
the object through another request, then release the pause and join the
worker. Holding the storage lock across the pause would prevent the observing
request from making progress.

Observation records selection, not completion. A selected sleep may still be
pending, a return payload may still be cloning, and an async task may later be
cancelled. Use the worker's result or application-specific signals to assert
completion. Finite budgets are consumed on selection and are never refunded
by cancellation. This keeps counts precise even when clients time out.

## Plans and text input

Rust builders and explicit parsing represent the same plan:

```rust
use faultline::{Action, Plan, Probability};

let plan = Action::Return(503u16)
    .times(3)
    .chance(Probability::new(0.25).unwrap())
    .or_else(Action::Off);
let parsed: Plan<u16> = "25%3*return(503)->off".parse().unwrap();
assert_eq!(plan, parsed);
```

The grammar is `[percent%][count*]action[(payload)]`, separated by `->`.
Rules are ordered fallbacks: **one hit selects at most one action**. `off`
counts as selected and stops evaluation. `3*off->return(503)` skips the first
three requests, then fails subsequent requests. `sleep(100)->return(503)`
always sleeps; it does not sleep and return during the same hit. Put separate
points in the application if a request needs several independent effects.

| Action | Behavior |
| --- | --- |
| `off` | Continue, stopping fallback selection |
| `return(payload)` | Return a value parsed by `T::from_str` |
| `sleep(milliseconds)` | Thread sleep or cooperative Tokio timer |
| `pause` | Wait until this installation is removed or replaced |
| `yield` | Yield the thread or Tokio task |
| `panic(message)` | Panic outside internal locks |

Bare `return` parses an empty string; it works for `String` and application
types that explicitly accept it. Invalid typed payloads fail at configuration
time. Percentages must be finite and in `0..=100`; counts are unsigned and
zero disables that rule. Balanced parentheses and `->` are supported inside
payloads. Literal unmatched parentheses and escaping are not supported; use
the typed API for arbitrary payloads. Parse errors identify the rule index.
Parsing completes before replacing anything, so invalid input leaves the old
plan and its remaining counts intact.

`Injector::with_seed(seed)` supplies independent random streams per point,
derived from the seed and name. Registration order and hits on other points do
not perturb them. Replacement restarts the stream. Repeatability requires
the same plan, per-point hit ordering, and dependency versions; it does not
reproduce concurrent scheduling. Prefer exact counts and pause coordination
when a test needs a specific sequence of events.

## BUGGIFY branches

FoundationDB's
[Buggify](https://apple.github.io/foundationdb/client-testing.html)
chooses whether a code section is active once per run, then decides whether
to fire on each visit to an active section. `faultline` preserves these two
decisions with instance-local state. Both probabilities default to 25%, and
buggification is disabled until explicitly enabled, even in an instrumented
build. The branch body is ordinary Rust, so it can also await.

```rust
use faultline::{BuggifyConfig, Injector, buggify};

let faults = Injector::<()>::with_seed(42);
let _run = faults.buggify().scoped(BuggifyConfig::default()).unwrap();
let chunk_size = if buggify!(faults, "s3.small_chunks") { 1 } else { 65536 };
// Use chunk_size when streaming a response to stress the consumer.
assert!(chunk_size == 1 || chunk_size == 65536);
```

`buggify!(faults)` automatically identifies its site using module, file, line,
and column. `buggify!(faults, "name")` uses a stable name, so moving code does
not change its random stream. Names must be static strings; reusing a name
intentionally shares activation and counters. `buggify_with_prob!(faults,
probability)` and `buggify_with_prob!(faults, "name", probability)` override the
per-visit firing probability using a validated `Probability`. Even
`Probability::ALWAYS` cannot fire a site whose activation decision was false.

Set `BuggifyConfig { activation, firing }` to control the two probabilities.
`faults.buggify().enable(config)` starts a persistent run, and `scoped(config)`
starts one with an owning cleanup guard. Both reset previous site decisions
and random streams. `disable()`, guard cleanup, and `faults.clear()` end the
run. Stale guards cannot disable a newer run. A snapshot lists visited sites
in sorted order with their activation, visit count, and firing count. The
guard retains its run's snapshot after release or replacement for diagnostics.

Each site has one independent stream for its activation and firing draws,
separate from ordinary failpoint plans. Record `faults.seed()`, names, configuration, and
code/dependency versions when investigating a failing run. The seed replays
probability decisions for a site's visit sequence; it does not supply
FoundationDB's deterministic scheduler or simulated network and storage.
An injector's buggify decisions take a short shared lock; branch bodies run
after it is released. Disabling prevents future decisions, but a branch that
already received `true` can still execute.

`Buggify::decide(seed, name, probability)` makes one seeded decision without a
controller or a run. It is the first draw of the stream that a run with that
seed uses for `name`, so it equals the site's activation decision for the same
probability. It allocates nothing, takes no lock, and records no visit, which
suits callers that already identify each decision, such as a request ordinal
folded into the seed. A disabled build returns `false`.
`Buggify::sample(seed, name)` returns that first draw as an integer, for a
seeded value such as a cut position rather than a yes or no. A disabled build
returns zero.

In a disabled build both macros return `false` and erase their arguments.
Rust still type-checks the ordinary body of `if buggify!(...) { ... }`.
No special async macro is needed: only the decision is synchronous.

### Writing useful BUGGIFY branches

A useful branch makes an uncommon condition common enough to exercise while
leaving the test's expected property clear. Small batches and extra yields
stress scheduling and boundaries without changing the promised result. An
injected error tests a different property: that callers recover or report the
error correctly. A branch that silently corrupts data needs a test that
explicitly expects detection or recovery from corruption.

Keep the perturbation local and give a stable name to sites whose histories
you want to compare across edits. Avoid making important tests depend on the
default 25% probabilities producing one particular outcome. For example, set
activation and firing to `Probability::ALWAYS` for a regression that must
exercise one branch, then run broader seeded tests to explore combinations.

```rust
use faultline::{BuggifyConfig, Injector, Probability, buggify_with_prob};

let faults = Injector::<()>::with_seed(7);
let run = faults.buggify().scoped(BuggifyConfig {
    activation: Probability::ALWAYS,
    firing: Probability::NEVER,
}).unwrap();

// This named site is active; this call explicitly requests the perturbation.
let limit = if buggify_with_prob!(faults, "small_batch", Probability::ALWAYS) {
    1
} else {
    100
};
assert_eq!(limit, 1);
run.release();
assert_eq!(run.snapshot()[0].fired, 1);
```

## Configuration and test lifecycle

Bind all service points, install plans or start a BUGGIFY run, execute the
scenario, assert its result and relevant observations, then release guards
and join workers. Keep the guard in a named binding such as `let _guard = ...`:
`let _ = ...` drops it immediately. Choose an explicit test deadline for each
wait so an unreachable point produces a useful failure instead of a hang.

Use persistent `set`/`configure` for configuration that lives as long as the
service or is managed by an external controller. Use `scoped` for a test-owned
scenario. The same rule applies to persistent `Buggify::enable` and scoped
BUGGIFY runs. Replacing a plan resets its limits and random stream; starting
a new BUGGIFY run resets site activation decisions and counters.

| Operation | Effect on existing work |
| --- | --- |
| Drop or release the current point guard | Clear its plan and release selected pauses |
| Replace a point plan | Release old pauses; future hits select the new plan |
| Drop a stale guard | Preserve the newer installation |
| Cancel a selected async action | Consume its selection; preserve observations |
| Disable a BUGGIFY run | Future decisions return false; already chosen branch bodies can execute |
| Drop the injector while points remain | Bound worker handles remain usable |

Build-time disabling removes macro instrumentation. Runtime clearing removes
configuration and retains bound points and their lifetime observations. These
are different operations; an enabled but unconfigured point still records
visits. BUGGIFY has an additional explicit run switch and records no sites
while that run is disabled.

## Applying it to mems3

`mems3` uses this crate in its S3 handlers. Its `MemoryS3` backend binds points
during construction and shares the injector with service clones. The mems3
suite exercises the real HTTP adapter, including retryable failures, isolated
stores, async pauses, and committed writes with failed responses. This crate's
external-consumer tests also retain a smaller S3-shaped service example.

`MemoryS3` owns an `Injector<S3Fault>` through pre-bound fields such as
`s3.get_object.before`, `s3.put_object.before`, and
`s3.put_object.after_commit`, and a second `Injector<BodyFault>` for the
`s3.get_object.body` point that runs before each chunk of a streamed response.
It maps typed `S3Fault` values into `s3s` errors at the handler, and a body
fault into a response that ends short of its declared length. Entry points
precede storage locks and streaming object body consumption. Post-commit points
release the storage lock before awaiting, so another request can observe the
committed write while its original response is paused or fails.

Use named failpoints for targeted scenarios such as the first two PUTs
returning `SlowDown`, and the automatic campaign below for broad stress. Both
stay scoped to the same mems3 instance.

The repeatable `--failpoint NAME=PLAN` option validates names and typed
payloads before starting the server; `--list-failpoints` discovers the
available names. `--fault-seed` fixes the seed that plan probabilities and the
campaign draw from. Its Buck resource helpers forward these settings to private
server processes. For example:

```console
buck2 run tilde//aseipp/mems3:mems3 -- \
    --fault-seed 42 \
    --failpoint 's3.get_object.before=2*return(SlowDown)'
```

Runtime administration, request predicates, transport disconnects, and stream
truncation remain application concerns; generic fault actions alone cannot
simulate those HTTP effects.

For whole-service exploration, mems3 also provides `--chaos storage-v1`: that
policy combines throttling, bounded delays, yields, errors after committed
writes, and truncated response bodies. Request counts define optional warmup
and recovery phases. Each active request derives its own seed from the campaign
seed and its ordinal, and every boundary it reaches calls `Buggify::decide`
with that seed and a static site name, with `Buggify::sample` choosing where a
truncated body ends. The seed follows the request through commit, so completion
order cannot move one request's decisions into another request's stream.

```console
buck2 run tilde//aseipp/mems3:mems3 -- \
    --fault-seed 42 --chaos storage-v1 --chaos-requests 2000 --chaos-trace
```

The same admission sequence repeats selected faults, including delay lengths;
reproducing client scheduling still requires control outside faultline. See the
[mems3 campaign guide](../../../tilde/aseipp/mems3/README.md#automatic-adversarial-campaigns)
for the exact policy, counters, fixture configuration, and recovery assertions.

## Deliberate differences from fail-parallel

- Registry ownership is internal: callers borrow handles rather than passing
  `Arc<FailPointRegistry>` by value at every hit. Bound points avoid registry
  lookups on the request path.
- Typed payloads and `ControlFlow` replace nested optional strings. No implicit
  environment access, process-wide scenario cleanup, or silent unknown names.
- Guard cleanup uses installation identity. A stale guard never clears a newer
  configuration, and observer counts refer to the installation under test.
- Both disabled macros exist and erase their inputs. Failed setup in a
  disabled build is visible to callers.
- Callback, log, and busy-spin actions are omitted. Return a typed instruction
  and perform application logic explicitly. This keeps arbitrary callbacks
  and accidental CPU blocking out of the async action engine.
- Tokio is a dependency in this initial implementation, matching mems3. Sync
  hits need no running executor. A separate async adapter can be extracted if
  a non-Tokio consumer justifies it.

Selection serializes per point for exact shared limits, with short locks also
protecting observations. There is no global lock on hits, but an inactive
enabled point still locks to record its visit. No hot-path performance claim
is made without a benchmark. Disabled macros erase the hit entirely.
Removal releases pauses, but already selected sleeps, returns, and panics
still execute. Clearing an injector visits its points individually; it is
not a multi-point transaction. Dropping an injector does not revoke workers'
bound handles: retain scoped guards and join workers during teardown.
