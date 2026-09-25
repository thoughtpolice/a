<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sandbox

Per-id sandboxes on celld containers: run commands, read and write files,
keep background processes and expose ports, all inside one container per
sandbox id. It has the shape of Cloudflare's
[`@cloudflare/sandbox`](https://developers.cloudflare.com/sandbox/), cut to
what we use it for, and built on [`@celld/container`](../container):

- GPT coding agents: `@celld/api/openai`'s coding tools (apply_patch, exec,
  file reads and writes) working in a sandbox instead of memory;
- Blue Team work: analyzers run on untrusted binaries;
- test runs, streamed as they happen.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/sandbox:sandbox"],
)
```

| Import | What it has |
| --- | --- |
| `@celld/sandbox` | `getSandbox`, `SandboxClient`, `proxyToSandbox`, `SandboxCore`, `SandboxError`, the API types, `parseSSEStream` |
| `@celld/sandbox/durable` | the `Sandbox` Durable Object class, `errorResponse` |
| `@celld/sandbox/testing` | `localSandbox`: the real core over host processes |

## Why it exists

celld containers come with native `exec`, so a sandbox needs no agent
inside the container, unlike Cloudflare's, which talks HTTP to a server in
its `cloudflare/sandbox` image. Commands go straight through
`ctx.container.exec` as argv arrays. Files and background processes use a
handful of constant POSIX shell scripts ([`scripts.ts`](src/scripts.ts))
that take every value as a positional parameter, and that run on busybox
as well as on dash with GNU coreutils. Any image with a POSIX `sh`,
`realpath`, `find`, `stat`, `mkfifo` and `env` works, and busybox has all
of them.

## Quick start

```typescript
import { getSandbox } from "@celld/sandbox";
import { Sandbox } from "@celld/sandbox/durable";

export class Box extends Sandbox {
  override sleepAfter = "5m";
  override settings = { execTimeout: "20s" };
}

export default {
  async fetch(request: Request, env: { BOX: DurableObjectNamespace<Box> }) {
    const box = getSandbox(env.BOX, "user-42");
    await box.writeFile("hello.sh", "echo hello from $(id -u)\n");
    return Response.json(await box.exec(["sh", "hello.sh"]));
  },
};
```

```python
celld.project(
    name = "project",
    src = ":worker",
    script_name = "boxes",
    bindings = {"BOX": "Box"},
    container_context = "root//src/celld/container/image:image",
    containers = [{
        "class_name": "Box",
        "image": "container/Dockerfile",
        "runtime": "runsc",  # for untrusted code; see below
    }],
)
```

[`../container/image/Dockerfile`](../container/image/Dockerfile) is a
minimal image: busybox pinned by digest, with `/workspace` owned by uid
1000.

## The API

`getSandbox(namespace, id, options?)` answers a `SandboxClient`; every
method is an RPC call to the `Sandbox` object for `id`, and errors come
back as `SandboxError`s with a `code` (the `[code] ` message prefix
survives RPC). `SandboxCore` has the same methods without the Durable
Object, for tests and other hosts.

**Commands.** `exec(argv, options)` runs an argv with no shell;
`execShell(script, options)` runs `sh -c script`, and it is the only way a
shell sees anything. Options: `cwd` (workspace-relative), `env`,
`sessionId`, `timeoutMs`, `maxOutputBytes`, `stdin` (text or bytes) and
`combineOutput` (stderr into stdout, interleaved). The result is
`{success, exitCode, stdout, stderr, timedOut, truncated, durationMs}`;
`exitCode` is null after a timeout. `execStream` / `execShellStream`
answer the same run as server-sent events (`start`, `stdout`, `stderr`,
then `complete` or `error`), ready to hand to a browser or to read with
`client.events(stream)`. `gitCheckout(url, {branch, depth, targetDir})`
clones https URLs only (the image needs `git`, and the sandbox needs
`enableInternet`).

**Files.** All paths are workspace-relative (or absolute inside the
workspace). `readFile(path, {encoding: "utf-8" | "bytes", maxBytes})`,
`writeFile(path, text | bytes, {encoding: "utf-8" | "base64",
createParents, mode})` (atomic: a temporary file and a rename),
`mkdir(path, {recursive})`, `deleteFile(path)`, `remove(path,
{recursive})`, `renameFile` / `moveFile`, `exists`, `stat` and
`listFiles(dir, {recursive, includeHidden, limit})`. Contents move as raw
bytes through exec's stdin and stdout, not base64. Past `maxFileBytes`
(32 MiB), `readFileStream` and `writeFileStream` move up to 1 GiB as
streams.

**Processes.** `startProcess(argv, options)` and `startShellProcess` start
a command detached from the request (in its own session, when `setsid`
exists), with a ULID id; `listProcesses`, `getProcess`,
`killProcess(id, signal)` (the whole process group), `killAllProcesses`,
`waitForExit(id, {timeoutMs})`, `waitForLog(id, pattern)` (a regular
expression, for "listening on" lines), `getProcessLogs(id)` and
`streamProcessLogs(id, {fromStart})` (server-sent events: output, then one
`exit`). Statuses are `running`, `exited`, `killed`, `timed_out` (after its
`timeoutMs`) and `lost` (its container stopped underneath it). Output goes
to files in the container, at most 16 MiB per stream (rounded up to 512
bytes); when a process ends, the last 64 KiB of each stream are kept in
the object's storage, so its logs outlive the container.

**Ports.** `waitForPort(port, {path})` waits for a server;
`exposePort(port, {name})` gives the port a random 16-letter token, and
`proxyToSandbox(request, namespace, {hostname})` routes
`<port>-<id>-<token>.<hostname>` requests to it (null for anything else, so
a Worker falls through to its own routes). The client fills in the URL
when it knows the host name. A wrong token or an unexposed port is a 404.
Ports are only reached through celld's `getTcpPort`.

**Environment and sessions.** `setEnvVars({NAME: value | null})` changes
the variables every later command gets. `createSession({id, cwd, env})`
names a set of defaults, which `sessionId` (or `client.session(id)`)
applies. Precedence: base environment, then sandbox, then session, then the
call's own `env`.

**Lifecycle.** From `Container`: `getState()`, `stop()`, `destroy()`,
`sleepAfter` and the rest (see [`@celld/container`](../container)). The
first operation starts the container and prepares the workspace, once per
container start. Commands, waits and streams in flight keep it awake.

**Streams.** celld cannot carry a stream through Durable Object RPC (a
returned `ReadableStream`, or a streaming `Response`, arrives empty), but a
stub's `fetch` can. So a streamed operation is two steps: RPC
`openStream(request)` validates the request and answers a one-time ticket
(random, 60 s), and the client redeems it with `stub.fetch` at
`/.celld-sandbox/stream/<ticket>`. A Worker that forwards arbitrary
requests to the object exposes nothing: tickets cannot be guessed.

## Security defaults

- **No network.** `enableInternet` is false by default (from
  `Container`). `gitCheckout` and anything else that needs egress must turn
  it on.
- **Not root.** Commands and file operations run as `1000:1000`
  (`settings.user`). Only the workspace setup runs as root, and celld drops
  `CAP_CHOWN`, so the image should provide `/workspace` owned by the user
  (the example image does, with `USER` before `WORKDIR`); otherwise setup
  makes it world-writable (sticky) instead.
- **Clean environment.** Every command starts from `env -i` plus the
  sandbox's own variables (`PATH`, `HOME`, `LANG`, then `setEnvVars`,
  session and call variables), so nothing in the container's start
  environment, including celld's own `CLOUDFLARE_*` variables, reaches
  it. Names must be shell identifiers; values may not contain NUL. The
  Worker's own environment is never forwarded.
- **Limits on everything.** Every command has a deadline (default 30 s, at
  most `maxExecTimeout`, 10 minutes) after which it is killed with
  SIGKILL, and an output cap per stream (default 1 MiB, at most 16 MiB),
  past which output is dropped and `truncated` is set. Files are capped at
  32 MiB (1 GiB streamed), background processes at 32 running, each
  process's stored output at 16 MiB per stream, and log streams at 15
  minutes. All are `settings`.
- **No shell interpolation.** `exec` takes argv arrays, and the scripts
  take arguments as positional parameters. The command name may not
  contain `=` or start with `-` (it follows `env -i`).
- **Workspace-rooted paths.** Paths are checked lexically (no `..` above
  the root, no NUL or newlines, no absolute paths outside), then resolved
  again in the container with `realpath` before any read, write, list,
  stat, rename or delete: a symbolic link that leads outside the workspace
  is refused, and so is a dangling one. Deleting a link removes the link.
  Files that are not regular (FIFOs, devices) are not read.
- **Validated input.** Every RPC argument is checked with
  [`@celld/sieve`](../sieve); unknown options are errors.
- **Isolation.** One container per sandbox id. For untrusted code (Blue
  Team analyzers, agent-written code) use the `runsc` (gVisor) runtime:
  ordinary containers share the host kernel. The file guards protect the
  API's callers; they do not jail commands, which can do anything their
  user can in the container.

## Mapping from `@cloudflare/sandbox`

Kept, with the same names: `getSandbox`, `exec`, `execStream`,
`startProcess`, `listProcesses`, `getProcess`, `killProcess`,
`killAllProcesses`, `streamProcessLogs`, `getProcessLogs`, `writeFile`,
`readFile`, `mkdir`, `deleteFile`, `renameFile`, `moveFile`, `exists`,
`listFiles`, `gitCheckout`, `exposePort`, `unexposePort`,
`getExposedPorts`, `proxyToSandbox`, `setEnvVars`, `createSession`,
`destroy`, `parseSSEStream`; `waitForExit`, `waitForLog` and
`waitForPort` are sandbox methods taking a process id instead of
`Process` object methods.

Changed:

| Cloudflare | Here |
| --- | --- |
| `exec(command: string)` runs a shell line | `exec(argv)` runs an argv; a shell is `execShell(script)` |
| `exec` options `stream`, `onOutput` | `execStream` and `events()` |
| `readFile` auto-detects the encoding, base64 for binary | `encoding: "utf-8"` (refuses invalid UTF-8) or `"bytes"` (a `Uint8Array`) |
| `killProcess(id, "SIGTERM")` | `killProcess(id, "TERM")`, to the process group |
| `ExecResult` | adds `timedOut`, `truncated`, `durationMs`; `exitCode` null on timeout |
| process `status` values | `running`, `exited`, `killed`, `timed_out`, `lost` |
| preview URL `https://<port>-<id>-<token>.<hostname>` | the same form; the id must be a DNS label of at most 40 characters |
| internet on by default | off by default |
| commands run as root | as uid 1000, with a clean environment |

Added: `execShell`, `stat`, `remove`, stream reads and writes of big files,
`startShellProcess`, `waitForLog`, session views (`client.session(id)`),
`SandboxCore` and `localSandbox`.

Dropped: the in-container HTTP server and its image, the code interpreter
(`createCodeContext`, `runCode`), file watching, storage mounts, backups,
terminal access, and WebSocket transports. None of our uses need them, and
native exec replaces the server. A file watcher would need a helper
binary built in the repository; nothing here needs one yet.

## For `@celld/api/openai`'s coding tools

The adapters that make a sandbox the file system and shell of
`@celld/api/openai`'s coding tools, and the Blue Team helpers that run
analyzers in one, live above this library, in `@celld/api/openai/sandbox`.

## Testing

Unit tests use `@celld/sandbox/testing`'s `localSandbox`: the real
`SandboxCore` over `@celld/container/testing`'s `FakeContainer`, whose exec
runs host processes in a temporary directory, so every script runs for
real (with dash and GNU coreutils; busybox is the real-container tests'
job). `scripted` checks the exact argv, users and environment handed to
celld with a scripted fake. They need no container engine:

```console
$ buck2 test root//src/celld/sandbox/... root//src/celld/container/...
```

### Real-container tests

`:integration-test` (35 steps: users, environment, network, binary files,
symbolic-link escapes, deadlines, caps, processes, kills, timeouts, log and
command streams, file streams, a server and its port, destroy, generations
and idle sleep) and the [examples](examples) run a real busybox container
under `celld dev` with the shared [example harness](../examples). Each
takes 10-25 s once the image is built.

They are labelled `needs-docker`. Running them needs:

- a Docker engine, with `docker` on `PATH` (Podman through `CELLD_DOCKER`
  does not reach them: the harness strips `CELLD_*` variables);
- the first time, network access to pull
  `busybox:1.37.0-musl@sha256:5cec3fc1...` and the `alpine` base of celld's
  own fence image (`celld dev` builds it; it runs privileged once per start
  to install the nftables rules that keep containers off the node's
  networks);
- nothing else: `celld dev` builds the image for the host platform, and
  the `-deploy-test` dry runs build for the host as well (celld's
  `linux/amd64` default would need emulation on ARM64 hosts).

```console
$ buck2 test root//src/celld/sandbox:integration-test
$ buck2 test root//src/celld/sandbox/examples/... root//src/celld/container/examples/...
$ buck2 run root//src/celld/sandbox:integration-dev    # leave it up on :9876
```

Buck's default test filters exclude only `external-data`, so a sweep such
as `buck2 test root//src/celld/...` runs these too; add `needs-docker` to
`[test] default_exclude_labels` in `.buckconfig` for hosts without Docker.

**`runsc`.** The examples use the engine's default runtime (runc). The
`runsc` runtime is the recommendation for untrusted code, but on the
development host (ARM64, Linux 7.0) Docker's registered `runsc`
fails to create any container, with celld or with plain `docker run
--runtime=runsc`, so no test here selects it.
