<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/box/container

A Durable Object base class that owns one celld container: start and
readiness, idle sleep, crash detection and restarts, and fetches to its
ports. It has the shape of Cloudflare's
[`@cloudflare/containers`](https://developers.cloudflare.com/containers/container-class/),
written from scratch over celld's `ctx.container`.
[`@celld/box/sandbox`](../sandbox) builds on it.

Configuration, start overrides, hooks, restart policy and port-wait options are
strict: unknown keys, accessors and non-boolean security flags are
`ContainerError("invalid")` before any start. Environment/label records and
entrypoint arrays are bounded and copied. Resolved options and exported limits
are deeply immutable; mutating them cannot enable networking or change a later
start. Custom clocks must return finite epoch milliseconds.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/box/container:container"],
)
```

| Import | What it has |
| --- | --- |
| `@celld/box/container` | `ContainerController`, the option, state and hook types, `ContainerError`, `durationMs`, `OPTION_LIMITS`, `uniformIndex` |
| `@celld/box/container/durable` | the `Container` class, `getContainer`, `getRandom`, `PORT_HEADER` |
| `@celld/box/container/testing` | `FakeContainer`, `FakeState`, `FakeKv`, `ManualClock` |

Only `./durable` imports `cloudflare:workers`; the rest loads in plain Deno
tests.

## Why it exists

celld already gives a Durable Object `ctx.container` (see
[celld.d.ts](../../../../buck/toolchains/celld/types/celld.d.ts), `Container`):
`start`, `running`, `monitor`, `destroy`, `signal`, `getTcpPort`, `exec`.
What it leaves to the application is the lifecycle around them, and two
celld facts make that less obvious than it looks:

- `monitor()` and `exec()` settle only within the event that called them.
  A crash between requests is not delivered to anyone, so it is noticed by
  the next call or alarm (the engine's `running` flag is live).
- A container outlives its object's idle eviction. Stopping an idle
  container is the application's alarm, not celld's.

Cloudflare's SDK is an npm package; celld code has no npm dependencies, and
this is the subset our own sandboxes need.

## Using it

```typescript
import { Container, getContainer } from "@celld/box/container/durable";

export class Api extends Container {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "5m";
  override envVars = { MODE: "production" };

  override onStop(event: StopEvent) {
    console.log("stopped:", event.reason);
  }
}

export default {
  fetch: (request: Request, env: { API: DurableObjectNamespace<Api> }) =>
    getContainer(env.API, "main").fetch(request),
};
```

Forwarding public requests unchanged like this exposes `defaultPort` and
nothing else: `fetch` removes an `x-celld-container-port` header instead of
obeying it. To reach another port the Worker decides in code, with the RPC
method `fetchPort`, and must itself check that the caller may reach it:

```typescript
const api = getContainer(env.API, "main");
if (url.pathname.startsWith("/metrics/") && isOperator(request)) {
  return await api.fetchPort(request, 9090);
}
return await api.fetch(request);
```

`fetch` and `fetchPort` hand the container the request as the Worker
received it: every header (`Authorization`, `Cookie` and any other
credential) and the body, unbounded. So the service in the container
authenticates its callers by itself, and a Worker that adds or holds its
own credentials, or that must bound what reaches the container, strips
those headers and caps the body before it forwards.

```python
celld.project(
    name = "project",
    src = ":worker",
    script_name = "api",
    bindings = {"API": "Api"},
    container_context = ":image",  # a directory with the Dockerfile
    containers = [{"class_name": "Api", "image": "container/Dockerfile"}],
)
```

Configuration is class fields, read when the object first needs its
controller: `defaultPort`, `requiredPorts`, `pingPath`, `sleepAfter`,
`envVars`, `entrypoint`, `enableInternet`, `labels`, `restartPolicy`,
`startTimeout`, `portTimeout`, `stopGrace`.

**The unit rule** (shared with [`@celld/box/sandbox`](../sandbox)): a field
whose name ends in `Ms` is a number of milliseconds; every other duration
is a string that writes its unit, a short form (`"500ms"`, `"30s"`,
`"10m"`, `"1h30m"`) or ISO 8601 (`"PT10M"`, through `Temporal.Duration`).
A bare number is refused: Cloudflare reads `sleepAfter = 60` as seconds,
our `*Ms` fields read numbers as milliseconds, and nothing at the call site
says which. Every duration is checked after conversion (finite, a safe
integer, within its range), so none can become `Infinity` or outlast a
timer. The ranges are `OPTION_LIMITS`:

| Option | Default | Range |
| --- | --- | --- |
| `sleepAfter` | `"10m"` | up to 7 days |
| `startTimeout` | `"30s"` | 1 ms to 10 minutes |
| `portTimeout`, `waitForPort({timeoutMs})` | `"30s"` | up to 10 minutes |
| `stopGrace` | `"5s"` | up to 5 minutes |
| `healthCheckInterval` | `"30s"` | 1 s to 1 day |
| `restartPolicy.window` | `"10m"` | up to 7 days |
| `restartPolicy.maxRestarts` | 3 | 0 to 1,000 |
| `requiredPorts` | none | at most 64 |
| `waitForPort({intervalMs})` | 100 | 1 to 60,000 |

A value outside its range, a whitespace-only string or a number throws
`invalid` when the controller is built.

RPC methods: `start(overrides?)`, `startAndWaitForPorts(overrides?, ports?)`,
`waitForPort(port, options?)`, `stop(signal?)`, `destroy()`, `getState()`,
`renewActivityTimeout()`, `containerFetch(request, init?, port?)`,
`fetch(request)`, which forwards to `defaultPort`, and
`fetchPort(request, port)`, which forwards to `port`. Hooks: `onStart()`,
`onStop({reason, exitCode, error?})`, `onError(error)`, and
`onActivityExpired()`, whose default stops the container.

A subclass that defines `alarm()` must call `super.alarm()`: there is one
alarm per Durable Object and idle sleep runs on it. Code that needs the
alarm for something else registers `controller.addWakeSource(() => time)`
(the controller then keeps the earliest time whenever it sets or clears the
alarm, stops included) or calls `controller.wakeBy(time)`, and its own
`alarm()` override does its work and calls `super.alarm()`.

## Lifecycle

The controller keeps one record in the object's synchronous KV storage
(`celld.container/state`): status, desired state, generation, last activity
and recent crashes. `getState()` answers it with the engine's live
`running` flag:

| Status | Meaning |
| --- | --- |
| `stopped` | not running and not wanted: never started, stopped or slept |
| `starting` | `start()` was called; the engine has not reported it running |
| `running` | the engine runs it; required ports not yet checked |
| `healthy` | running, and every required port accepted a connection |
| `unhealthy` | running, but a required port did not answer in time; not served |
| `stopping` | a stop signal was sent |
| `failed` | it crashed more often than the restart policy allows |

- **Start.** Every operation that needs the container (`fetch`, and all of
  `@celld/box/sandbox`) calls `ensureRunning()`, which starts it when it is
  stopped and waits for `running` (and the required ports) up to
  `startTimeout`. A start the engine refuses, or that never reports running,
  throws `start_failed` or `start_timeout` and runs `onStop` with reason
  `start_failed` and `onError`. Concurrent callers share one start.
  A start increments the *generation*: whatever lived in the previous
  container (its disk, its processes) is gone.
- **Readiness.** A port is ready when a TCP connection through
  `getTcpPort(port).connect()` opens, or, with `pingPath`, when an HTTP
  request gets any answer. Each attempt gets 2 s; one that runs out is
  ended (its request aborted, its socket closed), so retries never pile up
  connections. When a required port does not answer within
  `portTimeout`, the start throws `port_timeout` and the container becomes
  `unhealthy`: it keeps running, but nothing is served from it. Every later
  call (`fetch`, `tcpPort`, `ensureRunning`) probes the required ports
  again before serving and fails with `unhealthy` while they still do not
  answer; the alarm is set either way and retries every
  `healthCheckInterval`, and idle sleep still stops the container. A
  container started with `waitForPorts: false` is probed the same way
  before its first call is served, including a call made while that start
  was still in flight.
- **Idle sleep.** Every operation records activity. The alarm stops the
  container (SIGTERM, then a forced destroy after `stopGrace`) once
  `sleepAfter` passes with none, and `onStop` hears `sleep`. Work wrapped in
  `controller.busy(...)` (a long command, a log stream) holds it awake.
- **Crashes.** A container found dead while it should run (by the next call
  or the alarm) is a crash: `onStop` hears `crash`, `onError` gets
  `not_running`, and the restart policy decides:

  | `restartPolicy.mode` | What happens |
  | --- | --- |
  | `on-demand` (default) | the next call that needs it starts it again |
  | `always` | the alarm also checks every `healthCheckInterval` (30 s) and restarts it |
  | `never` | it becomes `failed` |

  Either restarting mode gives up (`failed`) after `maxRestarts` (3)
  crashes within `window` (10 minutes). A `failed` container refuses calls
  with `failed` until something calls `start()` explicitly.
- **Adoption.** An object that was reset while its container kept running
  adopts the running container instead of starting another.

Errors are `ContainerError`s whose code is also a `[code] ` prefix of the
message, because Durable Object RPC keeps only messages:
`ContainerError.from(error)` recovers the code on the caller's side.
`Container.fetch` and `fetchPort` answer them as JSON `{error, message}`:
`400` for `invalid` (the port the Worker passed), with the error's detail,
and `503` for the rest, with the code and a fixed message. A 503's detail
is the engine's start error, the last error, ports and timing, which is for
the container's owner, not for whoever sends a request a Worker forwards;
a class sets `unsafeDetail = true` to put it in the answer.

## Security defaults

- **One port through `fetch`.** `fetch` reaches `defaultPort` only and
  removes the `x-celld-container-port` control header; other ports are an
  explicit `fetchPort` call.
- **No Internet.** `enableInternet` is false unless a class or a start asks
  for it. celld then attaches the container to an internal bridge; with it,
  egress is fenced away from the node's own and private networks.
- **Runtime.** Ordinary containers run on runc and share the host kernel:
  runc is not a boundary against hostile code. For untrusted code set
  `"runtime": "runsc"` (gVisor) in the project's container declaration and
  make sure every serving node has it; see the
  [toolchain README](../../../../buck/toolchains/celld/README.md#project-attributes).
  `Container` does not independently check which runtime it got. Omitting
  the runtime declaration can select the default runc; explicitly selecting
  an unavailable runsc fails startup rather than falling back to runc.
  `@celld/box/sandbox`'s `hostile` tier additionally requires a successful
  trusted-image gVisor probe and refuses when it cannot verify gVisor
  ([threat tiers](../sandbox/README.md#threat-tiers)).
  Require `root//src/celld/box/sandbox:integration-runsc-test` to pass on the
  intended image/runtime before admitting hostile workloads. Ordinary runc
  integration tests and hostile-tier refusal tests do not replace that
  positive acceptance lane.
- **Forwarding.** `fetch` and `fetchPort` pass headers and bodies through
  untouched (see [Using it](#using-it)); the container's service is the
  authenticator.
- celld drops Linux capabilities (including `CAP_CHOWN`), sets
  `no-new-privileges`, the default seccomp profile and a process limit.

## Mapping from `@cloudflare/containers`

| Cloudflare | Here |
| --- | --- |
| `Container` class, fields `defaultPort`, `requiredPorts`, `sleepAfter`, `envVars`, `entrypoint`, `enableInternet` | same names |
| `pingEndpoint` | `pingPath` (TCP connect when unset) |
| `start`, `startAndWaitForPorts`, `waitForPort`, `stop`, `destroy`, `getState`, `renewActivityTimeout`, `containerFetch`, `fetch` | same |
| `onStart`, `onStop({exitCode, reason})`, `onError`, `onActivityExpired` | same; `reason` is `stop`, `sleep`, `destroy`, `crash` or `start_failed`; `exitCode` is null (celld does not report it) |
| `getContainer`, `getRandom` | same; `getRandom` picks without modulo bias and takes at most 1,024 instances |
| `sleepAfter = 60` (a number of seconds) | refused: write `"60s"` (see the unit rule) |
| `switchPort(request, port)` (a header `fetch` obeys) | dropped: `stub.fetchPort(request, port)`; `fetch` removes the header |
| `enableInternet` default `true` | default **false** |
| `schedule()` task scheduler | dropped: use the object's own storage and `super.alarm()` |
| outbound interception, `inspect`, snapshots | dropped: celld rejects them |
| restart policy | added (`restartPolicy`) |
| a container whose ports never answered stays `running` | `unhealthy`, re-probed before serving |

## Testing

`@celld/box/container/testing` has what the tests here use:

- `FakeContainer` implements celld's `Container`. Its `exec` runs real host
  processes with `Deno.Command` (so container scripts really run, in a
  temporary directory), or answers from a scripted `ExecHandler`. Starts can
  fail (`failNextStart`) or be slow (`startDelayReads`), `crash()` kills it,
  and `ports.set(port, handler)` makes a port answer; a port in
  `stalledPorts` never opens a TCP connection, and `closedSockets` records
  the sockets callers closed.
- `FakeState` is the `DurableObjectState` subset the controller needs (a
  structured-clone KV map and one alarm); `ManualClock` moves time by hand.

The process-backed exec needs `--allow-run` and runs as the test's user: it
is not a sandbox.

```console
$ buck2 test root//src/celld/box/container/...
```

The [examples](examples) run a real container under `celld dev`; their
tests are labelled `needs-docker` (see
[`@celld/box/sandbox`'s README](../sandbox/README.md#real-container-tests)).
The image they use is [`image/Dockerfile`](image/Dockerfile), busybox
pinned by digest.
