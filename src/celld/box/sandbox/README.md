<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/box/sandbox

Per-id sandboxes on celld containers: run commands, read and write files,
keep background processes and expose ports, all inside one container per
sandbox id. It has the shape of Cloudflare's
[`@cloudflare/sandbox`](https://developers.cloudflare.com/sandbox/), cut to
what we use it for, and built on [`@celld/box/container`](../container):

- GPT coding agents: `@celld/api/openai`'s coding tools (apply_patch, exec,
  file reads and writes) working in a sandbox instead of memory;
- Blue Team work: analyzers run on untrusted binaries;
- test runs, streamed as they happen.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/box/sandbox:sandbox"],
)
```

| Import | What it has |
| --- | --- |
| `@celld/box/sandbox` | `getSandbox`, `SandboxClient`, `proxyToSandbox`, `SandboxCore`, `SandboxError`, the API types, `parseSSEStream`, `isSandboxEvent`, `SETTING_LIMITS`, `WORKSPACE_LEASE` |
| `@celld/box/sandbox/durable` | the `Sandbox` Durable Object class, `errorResponse` |
| `@celld/box/sandbox/testing` | `localSandbox`: the real core over host processes |

## Why it exists

celld containers come with native `exec`, so a sandbox needs no agent
inside the container, unlike Cloudflare's, which talks HTTP to a server in
its `cloudflare/sandbox` image. Commands go straight through
`ctx.container.exec` as argv arrays. Files and background processes use a
handful of constant POSIX shell scripts ([`scripts.ts`](src/scripts.ts))
that take every value as a positional parameter, and that run on busybox
as well as on dash with GNU coreutils. Any image with a POSIX `sh` (with
`cd -P`), `/proc`, `realpath`, `readlink`, `find` (with `-exec {} +`),
`stat`, `mv -T`, `mkfifo`, `setsid`, `grep -E -m` and `env` works, and
busybox has all of them. `setsid` is checked when the workspace is
prepared: without it no command could get its own process group, so every
call fails with `unsupported_image` instead of running commands whose
kills would reach their first process only.

## Quick start

```typescript
import { getSandbox } from "@celld/box/sandbox";
import { Sandbox } from "@celld/box/sandbox/durable";

export class Box extends Sandbox {
  override sleepAfter = "5m";
  override settings = { tier: "hostile" as const, execTimeout: "20s" };
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
    container_context = "root//src/celld/box/container/image:image",
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

Use `getPrincipalSandbox(namespace, secret, purpose, principal.key)` for authenticated
callers. The secret is at least 32 random bytes (or an HMAC-SHA256 key), the purpose
names the application/trust domain, and `principal.key` includes scheme, issuer,
tenant, client and subject. The returned name is a domain-separated 130-bit opaque
DNS label. `deriveSandboxId` exposes the same derivation when a caller needs the
name separately. `getSandbox(namespace, id)` is the low-level **trusted-name API**:
never put a subject, email, or request-selected name into it across trust domains.
Mutually hostile callers require separate identities and containers.

`errorResponse(error)` (from `@celld/box/sandbox/durable`) answers a
`SandboxError` as JSON `{error: code, message}` with a status for the code
(`lease_held`, `lease_lost`, `is_symlink` and `listing_changed` are
409s).
For a 4xx the message is the error's detail, which describes the caller's
own request (a bad argument, a missing path). For a 5xx (a helper command
that failed or ran out of time, the container, the runtime) it is a fixed
text, because the detail can be a helper's stderr (workspace paths,
whatever the guest wrote); `errorResponse(error, {unsafeDetail: true})`
puts the detail in every answer, for the sandbox's owner only. A Worker
that answers anonymous or untrusted callers can send them the code only
(as the [examples](examples) do).

A `SandboxClient` is the capability: hand it (or a narrower wrapper) to
code that should use the sandbox. The raw stub is `client.unsafeStub`,
named so because it bypasses the client: it offers `fetch` (tickets,
preview forwarding) and every RPC method of the class, `fetchPort` to any
container port included, without error mapping.

**Commands.** `exec(argv, options)` runs an argv with no shell;
`execShell(script, options)` runs `sh -c script`, and it is the only way a
shell sees anything. Options: `cwd` (workspace-relative), `env`,
`sessionId`, `timeoutMs`, `maxOutputBytes`, `stdin` (text or bytes),
`combineOutput` (stderr into stdout, interleaved), `lease` and `mutates`
(see **Leases**) and `signal`: aborting it kills the command and the call
rejects with the signal's reason (over RPC the client sends a random
`cancelToken` and calls the object's `cancel(token)` on abort). An abort
that arrives while the engine is still starting the command is not lost:
the command is killed as soon as it exists. The result is
`{success, exitCode, stdout, stderr, timedOut, truncated, durationMs}`;
`exitCode` is null after a timeout. `execStream` / `execShellStream`
answer the same run as server-sent events (`start`, `stdout`, `stderr`,
then `complete` or `error`), ready to hand to a browser or to read with
`client.events(stream)`. `gitCheckout(url, {branch, depth, targetDir,
timeoutMs, signal, lease, unsafeSymlinks})` clones an https URL of a
public host (not an IP literal in a private, loopback, link-local or
similar range, not `localhost`; the image needs `git`, and the sandbox
needs `enableInternet`) into a directory it creates: an existing target, a
symbolic link included, is `exists`. Git runs with the base environment
only (no `setEnvVars` or session variables), `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, https as its only transport, no hooks,
templates, credential helpers or redirects, so no configuration a caller
can plant changes what it does. Symbolic links in the repository are
checked out as plain files holding the link's text (`core.symlinks=false`,
also written to the new repository's configuration), so no path of the
checkout leads out of it: a view of the checkout scoped by path (a review
of an untrusted repository) cannot follow a committed `up -> ..` into the
rest of the workspace. `unsafeSymlinks: true` checks links out as links,
for a build that needs them. Its `timeoutMs` defaults to the smaller of 5
minutes and `maxExecTimeout`, and its `signal` works as `exec`'s: aborting
it kills the clone's process group and the call fails with `cancelled`. A
clone that fails, runs out of time or is cancelled leaves no directory
behind (the directory it made is removed, and only that one: another
caller's directory at the target stays). Host names are resolved by the
container; a name that resolves to a private address is not caught here
(the network fence is what keeps the container off private networks).

`searchFiles(pattern, {path, regex, ignoreCase, includeHidden, noFollow,
maxMatches, timeoutMs, signal})` answers `{matches: [{path, line, text}],
truncated}`: the lines of the regular files under `path` (a directory,
default the workspace) that contain `pattern`, a fixed string, or with
`regex: true` a POSIX extended regular expression of at most 256 bytes.
The expression is checked by its own `grep -E`, which the deadline
kills, and again by the search before it walks; one grep refuses is
`invalid`, never "no matches". Both checks give grep one line to match,
since busybox compiles a pattern only when it has a line (an empty input
such as `/dev/null` passes any pattern). With `noFollow: true`, `path`
is reached as for `readFile` (below): a symbolic link at it or on its
way is `is_symlink`, checked in the same exec as the walk, so a
directory swapped for a link is never searched. It runs in the container as a command does (its own process
group, the deadline, `signal`), with `find . -type f` from the checked,
entered directory and `grep -n -H` on what it finds, so it never follows a
symbolic link, to a file or into a directory, and nothing is named on a
command line that grep could follow: it reads nothing outside the
workspace however the tree is linked. Past its deadline it fails with
`timeout`. It only reads, so it runs whoever holds the workspace lease. A
path that holds `:<digits>:` is split at the first such run. Code that
searches with its own `exec` instead must do the same: enter the directory
with `cd -P` and check `pwd -P` is inside the workspace, then walk with
`find . -type f -exec grep ... {} +` (never `grep -r DIR`, which follows a
link named as DIR), check a regular expression on one line first
(`grep -E -e PATTERN` with one line on stdin; its greps under `-s` exit
2 for a bad pattern, which `find` reports as a plain failure), and pass
`mutates: false`.

**Files.** All paths are workspace-relative (or absolute inside the
workspace). `readFile(path, {encoding: "utf-8" | "bytes", maxBytes})`,
`writeFile(path, text | bytes, {encoding: "utf-8" | "base64",
createParents, mode})` (atomic: a temporary file and a rename),
`mkdir(path, {recursive})`, `deleteFile(path)`, `remove(path,
{recursive})`, `renameFile(from, to)` / `moveFile`, `exists`, `stat` and
`listFiles(dir, {recursive, includeHidden, limit, cursor, sort})`. The
calls that change files take `lease` too: `writeFile`'s options,
`mkdir`'s and `remove`'s options, and a last `{lease}` argument of
`deleteFile`, `renameFile` and `moveFile` (see **Leases**).

`readFile`, `stat`, `exists` and `listFiles` take `noFollow: true` for a
view of part of the workspace scoped by path (a checkout under review):
the path is then walked from the workspace one directory at a time, and a
symbolic link at the path or on its way fails with `is_symlink` instead of
being followed, even to somewhere inside the workspace. Each step is
checked where it landed (`pwd -P`, and for the last name the kernel's
name for what was opened), so the check and the read are one step: a
directory swapped for a link meanwhile is caught, not read through.
(`listFiles` lists links as links either way; `noFollow` is about the
directory's own path.)
Contents move as raw bytes through exec's stdin and stdout, not base64.
Past `maxFileBytes` (32 MiB), `readFileStream` and `writeFileStream` move
up to 1 GiB as streams.

`readFile` opens the file once, checks its size on that descriptor, and
reads at most `maxBytes + 1` bytes from it. A streamed read does the same:
its `x-celld-sandbox-size` header is the size of the file it opened, and
it sends at most that many bytes of that descriptor (fewer if the file
shrinks meanwhile). A streamed write answers `{path, size}` with the bytes
it wrote, not a later look at the path. A file already past the limit
is `too_large`; one that grows past it during the read comes back cut at
`maxBytes` with `truncated: true` (a result always has `truncated`).

`listFiles` walks the directory once and stops once it has more than
`limit` entries (default 10,000, at most 100,000): the walk's output goes
through `head`, which ends it early, so a small limit on a huge tree costs
little. The answer is `{entries, truncated, cursor?}`: `truncated` says
there are more, and `cursor` (set only then) asks for the next page with
the same path and options. Pages follow the walk's order, and each page is
sorted by path unless `sort: false`. The cursor names the last entry of
its page, and the next page starts only where that entry still ends the
walk so far: when the directory changed between pages so that the next
page would skip or repeat entries, it fails with `listing_changed` (list
again from the start) instead of answering a skewed page. A later page
re-walks the entries before it, so reading page n costs the entries of
pages 1 to n.

**Processes.** `startProcess(argv, options)` and `startShellProcess` start
a command detached from the request (in its own session), with a ULID
id (options: `cwd`, `env`, `sessionId`, `name`, `timeoutMs`, `lease`, `mutates`); `listProcesses({cursor, limit})` (a page of
at most `limit`, default 100, and the `cursor` of the next page or null),
`getProcess`, `deleteProcess(id)` (an ended one),
`killProcess(id, signal)` (the whole process group), `killAllProcesses`,
`waitForExit(id, {timeoutMs})`, `waitForLog(id, pattern, {regex})` (for
"listening on" lines: a line containing `pattern`, a literal string of at
most 4 KiB; with `regex: true` a POSIX extended regular expression of at
most 256 bytes, matched by `grep -E` inside the container under the call's
deadline, never in the object; the grep that checks the pattern and the
grep that searches are each the process the deadline kills, so a pattern
that is slow to compile or backtracks forever only costs the container
that time), `getProcessLogs(id)` and
`streamProcessLogs(id, {fromStart})` (server-sent events: output, then one
`exit`). Statuses are `running`, `exited`, `killed`, `timed_out` (after its
`timeoutMs`) and `lost` (its container stopped underneath it). Output goes
to files in the container, at most 16 MiB per stream (rounded up to 512
bytes); when a process ends, the last 64 KiB of each stream are kept in
the object's storage, so its logs outlive the container, and its files
in the container are removed. From then on `getProcessLogs` answers that
tail.

**Ports.** `waitForPort(port, {path})` waits for a server;
`exposePort(port, {name, ttlMs})` gives the port a random token of 26
base32 letters (130 bits) that expires after `ttlMs` (default
`previewTokenTtlMs`, 15 minutes; at most 30 days), and
`proxyToSandbox(request, namespace, {hostname})` routes
`<port>-<id>-<token>.<hostname>` requests to it (null for anything else, so
a Worker falls through to its own routes). The sandbox id of a preview URL
is at most 30 characters, so the label stays within DNS's 63. The client
fills in the URL when it knows the host name (`getSandbox(ns, id,
{hostname, port})`, checked and copied when the client is made). Preview
URLs are `https:`, since they carry the token; `httpForDevelopment: true`
builds `http:` ones for a local `celld dev` and is refused unless the host
name is `localhost` or ends in `.localhost` (the old `protocol: "http"` is
refused). At most 64 ports (`MAX_EXPOSED_PORTS`) hold a live token at
once; another fails with `too_many_ports`. A wrong or expired token or
an unexposed port is a 404, and never starts the container. Exposing a
port again keeps its unexpired token and original expiry; `rotatePort(port, {expectedToken, ttlMs})` replaces
it (the old one stops working at once), `unexposePort` revokes it,
`destroy()` revokes them all, and the alarm forgets expired ones. Each
exposed port reports `createdAt`, `rotatedAt` and `expiresAt`. Ports are
only reached through celld's `getTcpPort`.

`expectedToken` is the token from the preceding expose/rotation result. If a
rotation response is lost, retry with the same `expectedToken`: it returns the
same committed generation. If another rotation intervened, the stale request is
refused; reconcile with `getExposedPorts()`. Never retry a lost rotation by reading
the new token and blindly issuing another rotation. Expose is idempotent while its
token remains live. Client-known ID/hostname/port errors are rejected before RPC.

Preview hostname options accept canonical ASCII DNS names only: no IDN Unicode,
trailing dot, embedded port, credentials, path, query, fragment or backslash.
Production proxying requires the expected hostname and HTTPS; URL/Host mismatch
is refused. `createPreviewProxy(namespace, options)` validates once and returns a
request handler. Explicit cleartext development options require `.localhost` and
the configured port on both the client and the proxy.

**Preview active content must be trusted.** This API uses hostname bearer tokens:
page JavaScript can read and exfiltrate its own URL. It does not support hostile
HTML/JavaScript previews. Hostile code needs a separate design using a one-time
bootstrap, a tokenless isolated origin, and a host-only Secure HttpOnly credential.
Use a dedicated preview registrable domain with no application cookies, force
HTTPS/HSTS at its parent, and redact token hostnames in edge logs, metrics,
traces, crash reports and support screenshots. DNS resolvers, TLS SNI (unless
effective ECH is deployed), and browser history/history sync can still observe
hostname credentials. Application redaction cannot prevent those exposures.

The proxy and core rewrite upstream authority to `sandbox.internal` and remove
token-bearing Host/forwarding/referrer/origin headers. Replies authoritatively use
`Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, legacy cache
prevention, and no `Set-Cookie` headers. This deliberately disables preview cookies.
CDNs must honor the policy; token revocation cannot retract content a browser/user
has already saved. Do not log the URL before this proxy receives it.

**Environment and sessions.** `setEnvVars({NAME: value | null})` changes
the variables every later command gets. `createSession({id, cwd, env})`
names a set of defaults, which `sessionId` (or `client.session(id)`)
applies; an id that exists is refused with `exists`, and
`updateSession(id, {cwd, env})` changes one (a given field replaces the
session's). Precedence: base environment, then sandbox, then session, then
the call's own `env`.

**Lifecycle.** From `Container`: `getState()`, `stop()`, `sleepAfter` and
the rest (see [`@celld/box/container`](../container)). The first operation
starts the container and prepares the workspace, once per container start.
Preparation, including guest-runtime verification, keeps it awake even when
startup exceeds `sleepAfter`. Idle time restarts when preparation finishes.
Commands, waits and streams in flight also keep it awake.

`destroy()` ends the sandbox: it forgets everything the object stores for
it (environment, sessions, exposed ports and their preview tokens, stream
tickets, process records and their indexes) in one synchronous step, then
destroys the container. From that moment no old token or ticket is
honoured, and a preview request with one is a 404 that starts nothing; the
next call starts a new, empty sandbox. A call that was already on its way
when `destroy()` ran (waiting for the container, or past its token or
ticket check) never reaches the next container generation: a preview
request is a 404, anything else fails with `cancelled`, and a preview's
token is checked again once the container is ready. `destroyContainer()` is the narrow
operation (what `destroy()` did before): it kills the container and keeps
the stored state, so sessions, variables and tokens carry over to the next
container generation, and processes of the old one read as `lost`.

**Leases.** Several Workers can use one sandbox at once (the object is
one instance per id, the Workers are not). `acquireLease(name, {ttlMs})`
takes a named lease (default 30 s, at most 10 minutes) and answers
`{name, token, expiresAt}`, or null while someone else holds it;
`renewLease(name, token, {ttlMs})` extends it (null once it is lost) and
`releaseLease(name, token)` gives it up. A serialized pending handoff prevents
competing acquisition and unleased mutation, so a lease has one holder whatever
isolate asks, which is what a read-modify-write of several calls (a
patch planned from reads, then written) needs. An expired lease is free
again, so a holder that dies stops blocking after its `ttlMs`. At most 64
leases are held at once (`too_many_leases`), and `destroy()` drops them.

The lease `workspace` (`WORKSPACE_LEASE`) is enforced by the sandbox, not
only honoured by the callers that take it. While it is held:

- every mutating call must pass its token as `lease`, or fails with
  `lease_held` and changes nothing: `writeFile`, `writeFileStream`,
  `mkdir`, `deleteFile`, `remove`, `renameFile`, `moveFile`,
  `gitCheckout`, `startProcess` / `startShellProcess`, and `exec`,
  `execShell`, `execStream` and `execShellStream`, which count as
  mutating unless `mutates: false`;
- the other calls go ahead: reads (`readFile`, `readFileStream`,
  `listFiles`, `stat`, `exists`, `searchFiles`), process listings, logs,
  waits and kills, sessions, `setEnvVars`, ports, and commands with
  `mutates: false`. `mutates: false` is a declaration the sandbox cannot
  check: a command declared so that writes defeats the lease, as any
  holder of the client could;
- a mutating call that names a lease no longer held (it expired, or was
  released) fails with `lease_lost`, whether another caller holds the
  lease now or nobody does: its holder must not go on as if it still
  did.

With the lease free, a call without `lease` goes ahead. Taking the lease
fences what runs without it: every mutating command still running then
(one started with no lease, or under a lease that expired) is killed, as
a cancellation kills it, and fails with `lease_held` or `lease_lost`. A
file operation (a write, a rename, a removal, a directory, a streamed
write) receives the same cancellation and process-group containment. Input bodies
are cancelled, and nonce-owned temporary writes are removed after termination.
The handoff awaits every registered old mutation and kills/awaits every old
background process whose `mutates` is not explicitly false. Only then does it
install the new token and begin its full TTL. A handoff whose 15-second drain or
containment fails returns no lease and leaves the sandbox unavailable until an
explicit `destroy()` succeeds; it never restores the old generation. Long uploads
and recursive removal can take substantial time; helper calls are not assumed
instantaneous. A stream ticket is
checked when it is opened and again when it is redeemed. `destroy()`
stops every command and mutation in flight, leased or not (see
**Lifecycle**). Other lease names are
only honoured by the callers that use them. `@celld/api/openai/sandbox`
holds the lease `workspace` around every mutating coding tool call and
passes its token.

`client.withWorkspaceLease(async (workspace, signal) => { ... })` is the safe file
capability: it renews automatically and injects the token into every writer. The
frozen facade cannot omit/replace the token, run arbitrary commands, change shared
environment, access the raw stub, or be used after the callback finishes. Use it
for read-modify-write operations. The package-level `withWorkspaceLease` provides
the lower-level `(signal, token)` callback for trusted adapters such as OpenAI's
bridge. Arbitrary commands can tamper with guest supervision state; neither that
lower-level helper nor workspace leases isolate mutually malicious guest code.
`mutates: false` on a full client is a trusted declaration, never an authorization
boundary. Dev servers that should survive handoff must select it explicitly.

**Streams.** celld cannot carry a stream through Durable Object RPC (a
returned `ReadableStream`, or a streaming `Response`, arrives empty), but a
stub's `fetch` can. So a streamed operation is two steps: RPC
`openStream(request)` validates the request and answers a one-time ticket
(random, 60 s), and the client redeems it with `stub.fetch` at
`/.celld-sandbox/stream/<ticket>`.

`parseSSEStream(stream, {maxEventBytes, validate})` (and `client.events`)
reads a stream back. It scans producer bytes incrementally, without decoding a
whole producer chunk, and holds `O(maxEventBytes)` parser-added memory (default
1 MiB). Total memory also includes the current producer chunk; bound chunks at
the transport producer. LF, CRLF split across chunks, lone CR, and split UTF-8 are
handled; malformed UTF-8 fails closed. It checks each event's JSON against the sandbox's event
shapes (`isSandboxEvent`, or your own `validate`): a longer event fails
the iteration with `too_large`, and data that is not a valid event with
`invalid`.

A stream holds little for its reader: 64 KiB of events, or 1 MiB of a
file, after which the command waits (backpressure) instead of the object
buffering. Nothing is collected on the side, so a 1 GiB file read holds
about a megabyte. The command's deadline runs from the moment it starts,
whatever the reader does; a reader that cancels or disconnects kills the
command at once; and one that takes nothing for the command's whole
deadline is dropped (the stream fails), so an abandoned stream never holds
the object awake. `execStream(argv, {signal})` cancels the stream, and so
the command, when the signal aborts. `readFileStream(path, {signal})` and
`writeFileStream(path, body, {signal, ...options})` do too. Already-aborted calls
create no ticket; abort during ticket creation revokes the ticket before any fetch.
`cancelStream(ticket)` revokes an unused low-level ticket. The redeeming request
signal reaches startup and helper work. A stream that fails ends with an
`error` event `{code, message}` under `errorResponse`'s rule: for a 4xx
code the message is the error's detail, for a 5xx code (or an error that
is not a `SandboxError`, code `internal`) it is a fixed text, since
streams go to browsers and the detail can be a helper's stderr or the
engine's own error.

**What the object's `fetch` serves.** Only two kinds of request, in this
order: a preview request carrying `x-celld-sandbox-preview: <port>:<token>`
(whatever its path), which reaches that port only when it is exposed and
the token matches and has not expired; and, for a request without that
header, a stream ticket under the reserved path `/.celld-sandbox/stream/`.
So an app behind a preview URL may serve paths under
`/.celld-sandbox/stream/` like any other; only requests that reach the
object without the preview header (a Worker's own ticket redemption) are
read as tickets. Anything else is a 404 and never reaches a container
port; `x-celld-container-port` is removed, not obeyed.
So a Worker that forwards requests to the object unchanged hands out
exactly this: every exposed port to whoever knows its token, and each
open ticket (single use, 60 s) to whoever knows it. Tickets and tokens are
bearer secrets; keep them out of logs and URLs you share. A Worker that
should reach some other port does so in code with the RPC method
`fetchPort(request, port)`.

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
  sandbox's own variables (`PATH`, `HOME` (`<stateDir>/home`, outside the
  workspace, so no file the file API writes is a dotfile a tool reads),
  `LANG`, then `setEnvVars`,
  session and call variables), so nothing in the container's start
  environment, including celld's own `CLOUDFLARE_*` variables, reaches
  it. Names must be shell identifiers; values may not contain NUL. The
  Worker's own environment is never forwarded.
- **Settings have ranges and units.** The unit rule of
  [`@celld/box/container`](../container#using-it) holds here too: a setting
  whose name ends in `Ms` is milliseconds, and every other duration
  (`execTimeout`, `maxExecTimeout`, `logPollInterval`, `maxStream`, and the
  container's `sleepAfter` and the rest) is a string with its unit, such as
  `"30s"`; a number there is refused. Every numeric setting has a range
  (`SETTING_LIMITS`), checked after conversion, so none can be `Infinity`,
  a fraction or a size no host could serve:

  | Setting | Default | Range |
  | --- | --- | --- |
  | `execTimeout` | `"30s"` (or `maxExecTimeout` when less) | 1 ms to `maxExecTimeout` |
  | `maxExecTimeout` | `"10m"` | 1 ms to 6 h |
  | `maxOutputBytes` | 1 MiB | 1 B to `outputLimitBytes` |
  | `outputLimitBytes` | 16 MiB | 1 B to 256 MiB |
  | `maxFileBytes` | 32 MiB | 1 B to 256 MiB |
  | `maxStreamFileBytes` | 1 GiB | 1 B to 16 GiB |
  | `maxProcesses` | 32 | 1 to 1,024 |
  | `processLogBytes` | 16 MiB | 1 B to 1 GiB |
  | `keptLogBytes` | 64 KiB | 1 B to 1 MiB |
  | `maxArgvBytes`, `maxEnvBytes` | 256 KiB each | 1 B to 1 MiB, together at most 1 MiB; `baseEnv` at most `maxEnvBytes` |
  | `maxStdinBytes` | 8 MiB | 1 B to 256 MiB |
  | `maxTicketBytes` | 1 MiB | 1 B to 16 MiB |
  | `maxFinishedRecords` | 200 | 1 to 10,000 |
  | `recordTtlMs` | 24 h | 1 ms to 30 days |
  | `maxSessions` | 64 | 1 to 4,096 |
  | `maxOpenTickets` | 32 | 1 to 4,096 |
  | `previewTokenTtlMs` | 15 min | 1 ms to 30 days |
  | `logPollInterval` | `"250ms"` | 10 ms to 1 minute |
  | `maxStream` | `"15m"` | 1 s to 1 day |

  Per-call `timeoutMs` values are capped by the class, and larger than a
  timer's range (about 24.8 days) is `invalid`.
- **Limits on everything.** Every command has a deadline (default 30 s, at
  most `maxExecTimeout`, 10 minutes) after which it is killed with
  SIGKILL, and an output cap per stream (default 1 MiB, at most 16 MiB),
  past which output is dropped and `truncated` is set. Files are capped at
  32 MiB (1 GiB streamed), commands running at once (foreground and
  background together) at 32, each process's stored output at 16 MiB per
  stream, and log streams at 15 minutes. All are `settings`. The command
  limit is a slot taken atomically before the command starts and given
  back if it fails to, so concurrent calls cannot overshoot it.
- **Sizes in bytes, checked first.** Every size is checked in UTF-8 bytes
  before anything is decoded, copied into storage or handed to the engine,
  and a refusal is `too_large` (or `invalid` for one argument): one
  argument, script or environment value at most 120 KiB (Linux refuses an
  argument of 128 KiB, `MAX_ARG_STRLEN`); a command's argv at most
  `maxArgvBytes` (256 KiB) and its environment, each layer (`baseEnv`
  included, checked when the sandbox is built) and the merged whole, at
  most `maxEnvBytes` (256 KiB), the two together at most 1 MiB, which
  with the wrapper around every command (its script and the base `PATH`,
  the only part of `baseEnv` it repeats) stays below `ARG_MAX`; stdin at most `maxStdinBytes` (8 MiB); file content
  at most `maxFileBytes`, measured on the base64 or UTF-8 text before it
  is decoded; and a stream ticket's stored request at most
  `maxTicketBytes` (1 MiB). Larger stdin for a streamed command goes as
  the request body instead (`execStream(argv, {stdin: stream})`), capped
  at `maxStdinBytes` as it flows.
- **Process groups.** A foreground command runs in its own session and
  process group (a small wrapper, `RUN` in [`scripts.ts`](src/scripts.ts),
  starts it with `setsid`, which the image must have: without it the
  sandbox refuses to run anything, `unsupported_image`). The group's first
  process writes its id to the wrapper's file and only then execs the
  command, so the id is on disk before anything of the command runs; a
  kill that arrives earlier waits for it (about a second at most), and
  when the id cannot be written the command does not run at all
  (`command_failed`). Its deadline, a cancellation, and its own exit kill
  the whole group: children and double-forked grandchildren die with it,
  and nothing it left in its group outlives the call. The group kill is
  confirmed, not assumed: the kill looks through `/proc` until no live
  process is left in the group, and when some process is still there
  after about a second, or the kill fails or takes longer than 10 s (a
  container too loaded, or out of processes, to run it), the container is
  destroyed before the call answers, since that is the one kill that
  cannot miss. Background processes get their own group the same way
  (their first process also writes its pid before the command runs),
  which `killProcess` kills; a background start that fails after its
  command may have begun kills that group and removes its files, so no
  process runs that no record counts. A process that calls `setsid`
  itself leaves the group; see "Threat tiers".
- **No shell interpolation.** `exec` takes argv arrays, and the scripts
  take arguments as positional parameters. The command name may not
  contain `=` or start with `-` (it follows `env -i`).
- **Workspace-rooted paths.** Paths are checked lexically (no `..` above
  the root, no NUL or newlines, no absolute paths outside), then resolved
  again in the container with `realpath` before any read, write, list,
  stat, rename or delete: a symbolic link that leads outside the workspace
  is refused, and so is a dangling one. Deleting a link removes the link.
  Files that are not regular (FIFOs, devices) are not read. What is used
  is pinned, not looked up again by name: reads and stats open the file
  and check the kernel's name for what is open (`/proc/self/fd`), and
  writes, deletes, renames, directory creation and listings change into
  the resolved parent directory, check where they landed, and work on the
  last name there (writes and renames never through a link: `mv -T`, and
  a new temporary file). Missing parents (`createParents`, a clone's
  target) are created only below the deepest existing directory, entered
  first. A rename pins both directories: it enters the source's and holds
  the target's open, and moves by those. `stat` of a FIFO or socket
  describes the entry in its entered directory without following it again.
  A path component swapped while one of these runs cannot lead outside.
  What stays racy, for a process in the sandbox that swaps components on
  purpose: the directories below the pinned one that `mkdir -p` creates,
  and the inside of a tree `rm -r` removes. These run as the sandbox's
  user, so they reach only what that user could reach with a command
  anyway.
- **Validated input.** Every RPC argument is checked with
  [`@celld/sieve`](../../sieve); unknown options are errors.
- **Supervision state is guest-writable.** A background process's state
  directory (`<stateDir>/proc/<id>`: its pid, exit status, timeout marker
  and output files) and a foreground command's group-id file
  (`<stateDir>/run`) belong to the sandbox's user, the same user its
  commands run as, so a command can rewrite them. Moving them out of that
  user's reach would need a supervisor running as another user that is the
  command's parent (to learn its exit status) and still starts it as the
  sandbox's user; celld's exec switches users per exec only, and celld drops
  capabilities in the guest, so that supervisor cannot be built here.
  What the object does instead: it treats `POLL`'s output as untrusted input
  (a header that is not exactly what `POLL` writes makes the record `lost`,
  never a made-up exit status) and bounds every read of it. A malicious command
  can nevertheless falsify valid-looking supervision data or hide its own
  descendants, undermining process-control/lease assurances within that guest.
  **Do not share a container between mutually hostile lease holders.** The
  isolation boundary is the container, not a workspace lease or guest uid.
- **Isolation.** One container per sandbox id. For untrusted code (Blue
  Team analyzers, agent-written code) use the `hostile` tier, which
  requires the `runsc` (gVisor) runtime: ordinary containers share the
  host kernel. The file guards protect the API's callers; they do not jail
  commands, which can do anything their user can in the container.

## Retention

Everything the object stores is bounded, and nothing on a hot path reads
all of it:

| What | Bound | Setting |
| --- | --- | --- |
| finished process records (with their 64 KiB tails) | the newest 200, each for at most 24 h | `maxFinishedRecords`, `recordTtlMs` |
| running process records | the command limit, 32 | `maxProcesses` |
| a process's files in the container | removed once its tail is kept | |
| sessions | 64 | `maxSessions` |
| stream tickets not yet redeemed | 32, each for 60 s | `maxOpenTickets` |
| exposed ports' preview tokens | 64 ports (`MAX_EXPOSED_PORTS`), one token each until its expiry (15 min), plus one revoked predecessor for rotation recovery | `previewTokenTtlMs` |

Two small indexes (the running ids, and the finished ids in the order they
ended) make the running count and the purges cheap: starting a command
never lists the process records. Expired tickets, records and tokens are purged
on the object's alarm, which `Sandbox.alarm()` shares with the container's
idle checks (the controller keeps the earlier of the two times, and stopping
the container keeps the purge time). `deleteProcess` forgets one record
early.

## Threat tiers

`settings.tier` says whom the sandbox runs code for.

**Threat intent is required.** Omitted `tier`, unknown settings, accessors,
prototype-bearing records, non-boolean switches and invalid numeric values fail
with `SandboxError("invalid")`. Settings arrays/records are copied and frozen.
Workspace and state directories must be disjoint; clean HOME and trusted helper
paths/PATH must not point into the workspace. `.celld-*` path components are
reserved. Hostile settings require a non-root numeric uid, clean environment,
escape sweeping and pinned `/bin/sh` and `/usr/bin/env`; disabling those requires
the explicitly trusted tier. Only `localSandbox` selects trusted automatically,
because it is a test harness running trusted host programs, not a container.
Code that may attack the sandbox must set `tier: "hostile"`, and then every call fails with
`unsafe_runtime` unless the container is on gVisor. What `hostile`
refuses: running any caller command in a container whose runtime is not
gVisor (checked before the first command in each new container), and
leaving a process that escaped its command's session alive (the escape
sweep kills it, or destroys the container).

**`trusted`** is for code you would run yourself: your own
tools and tests, an agent you trust not to attack its sandbox. Limits are
conveniences and cancellation is cooperative: the deadline kills the
command's process group, and a process that calls `setsid` (a daemon, a
double fork with `setsid`) leaves the group and keeps running until the
container stops. The container runtime is whatever the project declares.

**`hostile`** is for code that may attack the sandbox: analyzers run on
untrusted binaries, code an agent wrote from untrusted input. It adds:

- **gVisor or nothing.** Before any command of the caller's runs in a new
  container, the sandbox checks that the container runs on gVisor (the
  first line of its kernel log is exactly gVisor's boot line,
  `[   0.000000] Starting gVisor...`; `dmesg` is refused under runc, and a
  host log readable under runc starts with the host's boot, so a message
  that mentions gVisor elsewhere does not pass) and otherwise fails every
  call with `unsafe_runtime`. The runtime cannot be chosen
  from code: the operator declares it per container class and installs
  it on every node that serves the class:

  ```python
  containers = [{"class_name": "Box", "image": "container/Dockerfile", "runtime": "runsc"}],
  ```

  with Docker's `runsc` runtime registered (`/etc/docker/daemon.json`
  `"runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}`) and working
  on that node (`docker run --rm --runtime=runsc busybox dmesg` prints
  `Starting gVisor...`).
- **The escape sweep** (`sweepEscapes`, on by default here): after every
  foreground command and every `killProcess`, processes in a session the
  sandbox did not start (anything a command moved to a new session) are
  killed, and when one survives that, the container is destroyed. Running
  background processes and the image's own entrypoint are kept. A running
  background process's sessions are kept only while the pid that names
  each is gone or still the process that was recorded (its start time is
  recorded too): a process that gets a recorded pid again after that
  process ended cannot pass its own session off as the record's.
- **All public entry points attest.** The container calls `Sandbox` inherits
  from `Container` go through the same preparation: `start` and
  `startAndWaitForPorts` prepare the sandbox (and so run the check) before
  they return, and refuse every per-start override, including `envVars`,
  which could execute startup code before it. Refusal destroys the container;
  caller-requested ports are waited for only after attestation. The image,
  immutable absolute runtime-probe tools, deployment settings and operator must
  be trusted; this guest probe is not hardware/host attestation. `fetchPort` and `containerFetch` reach a
  port only once the sandbox is ready (`fetchPort` answers 503
  `unsafe_runtime` otherwise).

**Verification:** the refusal path is tested on runc (`:integration-test`
and `exec-test`), and the escape sweep is tested through a `trusted` class
with `sweepEscapes: true`. `review-test` checks PATH spoofing and executes the
production marker parser against positive and negative kernel-log fixtures.
The pinned BusyBox image provides `/bin/dmesg`, `/bin/head` and `/bin/grep`;
absolute paths avoid guest-controlled PATH lookups.

The positive `:integration-runsc-test` passed on 2026-09-26 after correcting
the probe's former `/usr/bin/head` assumption. It verifies a successful
guest-runtime check as uid 1000, nonroot execution and a file write/read round
trip. Earlier OCI startup failures are historical, not the current receipt.
Run this acceptance lane on each supported deployment configuration; one
passing host does not establish another host's runtime or image integrity.
Missing probe tools or an unreadable kernel log still fail closed as
`unsafe_runtime`; that code means gVisor could not be verified, not proof that
the container runs on a different runtime.

What `hostile` does not claim: the escape sweep, the process groups and the
path guards run inside the guest, as the guest's user, so they are not a
security boundary on their own; a process can race them. The boundary is
gVisor, the container's limits (celld's process limit, instance CPU and
memory, no capabilities, `no-new-privileges`) and the network fence, plus
the object's own limits on what it stores. Resource
quotas per command (CPU, memory, disk) would need cgroups in the guest,
which celld does not give it.

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
| `listProcesses()` answers every process | a page `{processes, cursor}` of the running and newest finished ones |
| `waitForLog` takes a regular expression | a literal string; `{regex: true}` for `grep -E` in the container |
| preview URL `https://<port>-<id>-<token>.<hostname>` | the same form; the id must be a DNS label of at most 30 characters, the token is 26 base32 letters and expires |
| `destroy()` stops the container | `destroy()` also forgets every stored thing and revokes tokens; `destroyContainer()` is the container-only kill |
| `createSession` with an existing id replaces it | refused with `exists`; `updateSession` changes one |
| internet on by default | off by default |
| commands run as root | as uid 1000, with a clean environment |

Added: `execShell`, `stat`, `remove`, stream reads and writes of big files,
`startShellProcess`, `waitForLog`, session views (`client.session(id)`),
`signal` and `cancel(token)`, `deleteProcess`, the `hostile` tier,
`rotatePort`, `updateSession`, `destroyContainer`, listing cursors, leases
(the `workspace` lease enforced), `searchFiles`, `SandboxCore` and
`localSandbox`.

Dropped: the in-container HTTP server and its image, the code interpreter
(`createCodeContext`, `runCode`), file watching, storage mounts, backups,
terminal access, and WebSocket transports. None of our uses need them, and
native exec replaces the server. A file watcher would need a helper
binary built in the repository; nothing here needs one yet.

## For `@celld/api/openai`'s coding tools

The adapters that make a sandbox the file system and shell of
`@celld/api/openai`'s coding tools, and the Blue Team helpers that run
analyzers in one, live above this library, in `@celld/api/openai/sandbox`.

Those tools run one mutation at a time per sandbox by keying a lane on the
client object, in memory, and hold the lease `workspace` around each
mutation, passing its token as `lease`. The sandbox enforces that lease
(see **Leases**): while one caller holds it, another caller's mutation
fails with `lease_held` instead of interleaving, whichever client object
or isolate it comes from, and a mutation still running without the lease
is killed when the lease is taken. What the lease cannot see is a command
declared `mutates: false` that writes. For searching, use `searchFiles`
(or an `exec` that walks as it does); for reviewing an untrusted
repository, `gitCheckout`'s default checks symbolic links out as plain
files. See
[Mutation serialization](../../api/openai/README.md#mutation-serialization)
in the `@celld/api/openai` README.

## Testing

Unit tests use `@celld/box/sandbox/testing`'s `localSandbox`: the real
`SandboxCore` over `@celld/box/container/testing`'s `FakeContainer`, whose exec
runs host processes in a temporary directory, so every script runs for
real (with dash and GNU coreutils; busybox is the real-container tests'
job). `scripted` checks the exact argv, users and environment handed to
celld with a scripted fake. They need no container engine:

```console
$ buck2 test root//src/celld/box/sandbox/... root//src/celld/box/container/...
```

Filesystem race tests stop their swapping loops gracefully and await the
active utility before removing temporary directories.

### Real-container tests

`:integration-test` (90 steps: users, environment, network, binary
files, symbolic-link escapes, searches, the workspace lease, listing
pages, deadlines, caps, processes,
kills, timeouts, log and command streams, file streams, a server and its
port, destroyContainer and destroy, generations and idle sleep) and the [examples](examples) run a real busybox container
under `celld dev` with the shared [example harness](../../examples). Each
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
$ buck2 test root//src/celld/box/sandbox:integration-test
$ buck2 test root//src/celld/box/sandbox/examples/... root//src/celld/box/container/examples/...
$ buck2 run root//src/celld/box/sandbox:integration-dev    # leave it up on :9876
```

Buck's default test filters exclude only `external-data`, so a sweep such
as `buck2 test root//src/celld/...` runs these too; add `needs-docker` to
`[test] default_exclude_labels` in `.buckconfig` for hosts without Docker.

**`runsc`.** The ordinary examples and `:integration-test` use the engine's
default runtime (runc). That integration suite verifies hostile refusal and
the escape sweep through an explicitly trusted test class. A separate
`:integration-runsc-test` target declares only the hostile binding and explicitly
selects `runtime: "runsc"`; it must pass on the actual deployed image/runtime
before hostile workloads roll out. It has both `needs-docker` and `needs-runsc`
labels. Run it on every supported deployment architecture:

```console
buck2 test root//src/celld/box/sandbox:integration-runsc-test
```

Merely registering `runsc` with Docker, or passing the runc refusal test, does
not prove this lane works. A host whose runsc cannot create a container has an
unmet deployment gate; do not fall back to the trusted class in production.

## Trust boundaries

| Actor or surface | Required trust / actual boundary |
| --- | --- |
| Host operator and deployment | Trusted to install/select runsc, enforce ingress/network policy, and isolate tenants. |
| Container image and helper binaries | Trusted, pinned, immutable to the guest user; guest runtime attestation depends on them. |
| Hostile command/input | Allowed only in an explicitly hostile, positively tested runsc deployment; cannot share a guest with another hostile principal. |
| Preview active content | Trusted not to disclose its own URL. Hostname bearer previews do not protect against malicious preview JavaScript. |
| Full `SandboxClient` holder | Trusted capability; can execute arbitrary guest commands and lie with `mutates: false`. |
| Raw `unsafeStub` holder | Fully trusted: also has subclass methods, startup and raw port-forwarding surfaces. |
| Scoped workspace facade | File operations only, fixed lease token, no raw stub/settings/arbitrary code; expires with its callback. |

## Migration notes

- Every durable class must select `tier: "trusted"` or `tier: "hostile"`.
  `Sandbox` is now abstract and its `settings` property is required, so omitting
  threat intent is both a type error and a runtime configuration error.
  Unknown settings, non-boolean switches, accessor properties, overlapping paths,
  and unsafe clean-environment helper/PATH arrangements now fail at construction.
  Only the host-only `localSandbox` test utility supplies trusted defaults.
  Hostile helpers are pinned to `/bin/sh -c` and `/usr/bin/env`; PATH may contain
  only the conventional `/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`,
  `/usr/local/bin`, and `/usr/local/sbin` directories of the trusted image.
- Production preview proxies require an expected canonical ASCII hostname and
  HTTPS; use `createPreviewProxy` to validate it once. HTTP requires the explicit
  localhost-only development option. Preview-configured clients require DNS-safe
  IDs. Responses strip cookies and override cache/referrer policy. The default
  bearer lifetime is now 15 minutes, not 24 hours.
- Rotation requires the current `expectedToken`. Retry the same expectation to
  recover the same committed successor; a stale expectation after another
  rotation is rejected. Re-exposing a still-live port no longer extends its TTL.
- Background processes default to mutating and are killed/awaited at workspace
  handoff. Only a trusted, genuinely read-only server may opt into `mutates: false`.
  Prefer the client's scoped file facade for higher-level callers.
- File streams accept `signal`; cancellation during setup revokes unused stream
  tickets. Output transport failures reject instead of returning partial success.
- `deriveSandboxId`/`getPrincipalSandbox` require a full canonical principal and
  application purpose. Migrated examples use a new keyed namespace, so their old
  transient sandbox names are intentionally not reused. Persisted deployments
  must plan data migration before changing an established identity derivation.
- Runner/jobs legacy non-expiring tokens require `UNSAFE_DEMO_AUTH=1`; outside
  local specs use expiring credentials and production JWT/OIDC authentication.
  The unauthenticated workspace/devserver demos require `UNSAFE_LOCAL_DEMO=1`
  plus loopback-only ingress. Their URL-host check is defense in depth, not peer
  authentication; a remote client can forge a localhost Host header.
