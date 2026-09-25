<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/container

A Durable Object base class that owns one celld container: start and
readiness, idle sleep, crash detection and restarts, and fetches to its
ports. It has the shape of Cloudflare's
[`@cloudflare/containers`](https://developers.cloudflare.com/containers/container-class/),
written from scratch over celld's `ctx.container`.
[`@celld/sandbox`](../sandbox) builds on it.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/container:container"],
)
```

| Import | What it has |
| --- | --- |
| `@celld/container` | `ContainerController`, the option, state and hook types, `ContainerError`, `durationMs` |
| `@celld/container/durable` | the `Container` class, `getContainer`, `getRandom`, `switchPort` |
| `@celld/container/testing` | `FakeContainer`, `FakeState`, `FakeKv`, `ManualClock` |

Only `./durable` imports `cloudflare:workers`; the rest loads in plain Deno
tests.

## Why it exists

celld already gives a Durable Object `ctx.container` (see
[celld.d.ts](../../../buck/toolchains/celld/types/celld.d.ts), `Container`):
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
import { Container, getContainer } from "@celld/container/durable";

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
`startTimeout`, `portTimeout`, `stopGrace`. Durations are seconds (a number,
as Cloudflare takes them), short forms (`"500ms"`, `"30s"`, `"10m"`,
`"1h30m"`) or ISO 8601 (`"PT10M"`, through `Temporal.Duration`).

RPC methods: `start(overrides?)`, `startAndWaitForPorts(overrides?, ports?)`,
`waitForPort(port, options?)`, `stop(signal?)`, `destroy()`, `getState()`,
`renewActivityTimeout()`, `containerFetch(request, init?, port?)`, and
`fetch(request)`, which forwards to `defaultPort` (or the port a
`switchPort(request, port)` header names). Hooks: `onStart()`,
`onStop({reason, exitCode, error?})`, `onError(error)`, and
`onActivityExpired()`, whose default stops the container.

A subclass that defines `alarm()` must call `super.alarm()`: there is one
alarm per Durable Object and idle sleep runs on it.

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
| `stopping` | a stop signal was sent |
| `failed` | it crashed more often than the restart policy allows |

- **Start.** Every operation that needs the container (`fetch`, and all of
  `@celld/sandbox`) calls `ensureRunning()`, which starts it when it is
  stopped and waits for `running` (and the required ports) up to
  `startTimeout`. A start the engine refuses, or that never reports running,
  throws `start_failed` or `start_timeout` and runs `onStop` with reason
  `start_failed` and `onError`. Concurrent callers share one start.
  A start increments the *generation*: whatever lived in the previous
  container (its disk, its processes) is gone.
- **Readiness.** A port is ready when a TCP connection through
  `getTcpPort(port).connect()` opens, or, with `pingPath`, when an HTTP
  request gets any answer.
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
`Container.fetch` answers them as JSON (`400` for `invalid`, `503` for the
rest).

## Security defaults

- **No Internet.** `enableInternet` is false unless a class or a start asks
  for it. celld then attaches the container to an internal bridge; with it,
  egress is fenced away from the node's own and private networks.
- **Runtime.** Ordinary containers share the host kernel. For untrusted code
  set `"runtime": "runsc"` (gVisor) in the project's container declaration
  and make sure every serving node has it; see the
  [toolchain README](../../../buck/toolchains/celld/README.md#project-attributes).
- celld drops Linux capabilities (including `CAP_CHOWN`), sets
  `no-new-privileges`, the default seccomp profile and a process limit.

## Mapping from `@cloudflare/containers`

| Cloudflare | Here |
| --- | --- |
| `Container` class, fields `defaultPort`, `requiredPorts`, `sleepAfter`, `envVars`, `entrypoint`, `enableInternet` | same names |
| `pingEndpoint` | `pingPath` (TCP connect when unset) |
| `start`, `startAndWaitForPorts`, `waitForPort`, `stop`, `destroy`, `getState`, `renewActivityTimeout`, `containerFetch`, `fetch` | same |
| `onStart`, `onStop({exitCode, reason})`, `onError`, `onActivityExpired` | same; `reason` is `stop`, `sleep`, `destroy`, `crash` or `start_failed`; `exitCode` is null (celld does not report it) |
| `getContainer`, `getRandom`, `switchPort` | same |
| `enableInternet` default `true` | default **false** |
| `schedule()` task scheduler | dropped: use the object's own storage and `super.alarm()` |
| outbound interception, `inspect`, snapshots | dropped: celld rejects them |
| restart policy | added (`restartPolicy`) |

## Testing

`@celld/container/testing` has what the tests here use:

- `FakeContainer` implements celld's `Container`. Its `exec` runs real host
  processes with `Deno.Command` (so container scripts really run, in a
  temporary directory), or answers from a scripted `ExecHandler`. Starts can
  fail (`failNextStart`) or be slow (`startDelayReads`), `crash()` kills it,
  and `ports.set(port, handler)` makes a port answer.
- `FakeState` is the `DurableObjectState` subset the controller needs (a
  structured-clone KV map and one alarm); `ManualClock` moves time by hand.

The process-backed exec needs `--allow-run` and runs as the test's user: it
is not a sandbox.

```console
$ buck2 test root//src/celld/container/...
```

The [examples](examples) run a real container under `celld dev`; their
tests are labelled `needs-docker` (see
[`@celld/sandbox`'s README](../sandbox/README.md#real-container-tests)).
The image they use is [`image/Dockerfile`](image/Dockerfile), busybox
pinned by digest.
