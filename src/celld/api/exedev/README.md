<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/exedev

A typed client for [exe.dev](https://exe.dev), written for celld Workers,
Durable Objects and Workflows. It covers the control plane
(`POST https://exe.dev/exec`), exe0/exe1 tokens (including local minting),
code running on a VM (reflection, integrations, email), the server side of the
HTTPS proxy, and desired-state fleet management on top of all of it. It has no
npm dependency; it is built on the celld platform libraries (see
[Dependencies](#dependencies)). exe.dev's docs (<https://exe.dev/docs.md>) are
the spec; where they are silent this README says what was decided and why.

```python
celld.worker(
    name = "worker",
    main = "src/index.ts",
    deps = ["root//src/celld/api/exedev:exedev"],
)
```

| Import                    | What it has                                                                            | Runtime imports      |
| ------------------------- | -------------------------------------------------------------------------------------- | -------------------- |
| `@celld/api/exedev`           | `ExeClient` and its command groups, catalog, quoting, errors, retry, tokens, SSHSIG, response schemas, value types | none |
| `@celld/api/exedev/vm`        | `VmIntegrations`, `ReflectionClient`, reflection schemas, email helpers: for code running on a VM | none      |
| `@celld/api/exedev/proxy`     | `exeIdentity`, `exeAuth` (an `@celld/router` scheme), `VmEndpointClient`, suggest/new/integration links | none |
| `@celld/api/exedev/fleet`     | `FleetSpec` (type and schema), `planFleet`, `FleetReconciler`, `memoryFleetStore`      | none                 |
| `@celld/api/exedev/limiter`   | `TokenBucket`, `memoryLimiter`, `durableLimiter`                                       | none                 |
| `@celld/api/exedev/durable`   | the `ExeFleet` and `ExeKeyLimiter` Durable Objects                                     | `cloudflare:workers` |
| `@celld/api/exedev/workflow`  | `provisionVm`, `waitForVm`, `bootstrapVm`, `verifyVm`                                  | none                 |
| `@celld/api/exedev/testing`   | `FakeExe` (a stateful in-memory lobby), `fakeFetch`, and `@celld/http/testing`'s `virtualRuntime` and `fakeStep` | none |

Only `./durable` imports `cloudflare:workers`, so everything else loads in a
plain `celld.test`.

## The control plane

```typescript
import { ExeClient, outcome } from "@celld/api/exedev";

const client = ExeClient.fromEnv(env); // EXE_API_TOKEN, or EXE_SSH_PRIVATE_KEY
const { vms } = await client.ls();
const vm = await client.new({ name: "web-0", tags: ["web"], cpu: 2, memory: "8GB" });
await client.share.port("web-0", 8080);
await client.integrations.attach("llm", "vm:web-0");

const run = await client.runOnVm("web-0", ["systemctl", "is-active", "celld"]);
run.exitCode; // 0
run.text; // "active\n"

const listed = await outcome(client.ls()); // {ok, value} or {ok: false, error}, plain data
```

The HTTPS API is the SSH CLI in a POST body: every request is `POST /exec`
with the command line as the body and `Authorization: Bearer <token>`, and the
response is the command's JSON. There is one typed method per documented
command and subcommand:

- VMs: `ls`, `lsGrouped`, `getVm`, `new`, `rm`, `restart`, `rename`, `tag`,
  `untag`, `cp`, `resize`, `comment`, `stat`, `vmLogs`, `grantSupportRoot`,
  `setRegion`, `browser`, `whoami`, `exe0ToExe1`.
- On VMs: `runOnVm`, `startDetached` (see below).
- Introspection: `help`, `helpAll`, `commandHelp` (`<cmd> --help`), `doc`,
  `catalogDrift`.
- `client.share`: `show`, `port`, `setPublic`, `setPrivate`, `add`, `remove`,
  `addLink`, `removeLink`, `receiveEmail`.
- `client.sshKey`: `list`, `add`, `remove`, `rename`, `generateApiKey`.
- `client.integrations`: `list`, `add` (typed for `http-proxy` incl. `--peer`,
  `github`, `llm`, `slack`, `discord`, `s3`, `reflection`, `wif`, and catalog
  handles), `remove`, `test`, `edit`, `attach`, `detach`, `rename`, `catalog`,
  `setupGithub`, `setupChatgpt`, `setupWebhook`.
- `client.domain`: `add`, `rm`, `ls`.
- `client.team`: `show`, `members`, `usage`, `add`, `remove`, `role`, `rename`,
  `transfer`, `disable`, and `billing.*`, `auth.*`, `settings.*`, `vm.*`.
- `client.pool`: `new`, `hosts`, `list`, `adopt`, `detach`, `resize`, `delete`.
- `client.billing`: `show`, `plan`, `usage`, `credits.*`, `rewards`,
  `capacity`, `payment.*`, `manage`, `update`, `invoices`, `receipts`,
  `statement`, `providerLink`.
- `client.invite`, `client.shelley`, `client.defaults`.
- `client.exec(input)`: anything else, as a catalog-checked `CommandInput` or a
  line you quoted yourself.

`COMMANDS` in `catalog.ts` lists every command path with its documented flags
and whether it is read-only. `client.catalogDrift()` compares it with the live
`help all` and reports commands exe.dev has that this library does not
(`unknown`) and documented ones that are gone (`missing`).

### Typed results

Only a few JSON shapes are documented, and only those are decoded into types:

| Command                                  | Source of the shape                                       | Required fields          |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------ |
| `ls`                                     | the API page's example                                    | `vms[].vm_name`, `status`|
| `new`, `cp`                              | exe.dev's Flue connector (`vm_name`, `ssh_host`, ...)     | `vm_name` (or `name`)    |
| `whoami`                                 | exe.dev's `which_keys.sh` (`ssh_keys[].fingerprint`)      | fingerprints, if keys    |
| `integrations list`                      | the GCP guide (`.[] \| .name`, `.config.issuer_id`)       | `[].name`                |
| `ssh-key list`                           | not documented; array, or under `ssh_keys`/`keys`         | `fingerprint`            |
| `ssh-key generate-api-key`, `exe0-to-exe1` | not documented; the first `exe0.`/`exe1.` string found  | the token                |

Each shape is a named `@celld/sieve` schema, exported so other code can parse
or describe the same JSON: `VmSummary`, `LsResponse`, `CreatedVm`,
`SshKeyInfo`, `WhoamiResponse` and `IntegrationInfo`. They are loose
objects whose transform builds the typed value and sets `raw` to the object
as received (the transform's `input`), so unknown fields are kept in `raw`
and nowhere else; absent and `null` optional fields are both left out. A
missing required field or a wrong type is an `ExeDecodeError` listing every
path, with sieve's messages (`vms[1].region: expected string, received
number`, `vms[0].status: missing required key`). `decodeWith(schema,
value, path?)` does the same for any schema. Everything else (`share show`,
`team members`, `billing ...`, `stat`, `pool list`, ...) returns the JSON as
received (`JsonValue`), since a guessed type would turn a server change into a
silent misread. Field names stay as the server sends them (`vm_name`,
`ssh_dest`).

### Command lines, quoting and injection

The lobby splits the body with a shell lexer: whitespace separates words,
single quotes are literal, double quotes allow `\"` `\\` `` \` `` `\$`, and
nothing is expanded (`${X}` stays as written). `quoteArg` is the exact function
exe.dev's docs page uses for its interactive quoter, `splitCommandLine` is the
lexer it targets, and the runtime test checks both against Python's `shlex`.
`buildCommand` is the only place caller data becomes a command line:

- every value is quoted into exactly one word;
- flag values are attached (`--name=value`), so a value can never become a flag;
- positional arguments starting with `-` are refused (the lobby parses flags
  anywhere on the line, and the docs mention no `--` separator);
- flags must be ones the catalog documents for that command, unless passed
  deliberately through `extraFlags`;
- NUL, CR and LF are refused anywhere (see "judgment calls");
- the body must be at most 64 KiB;
- credential flags may not be `-`, because `/exec` has no stdin.

Credentials in flags (`--bearer`, `--bot-token`, `--registry-auth`,
`--client-secret`, `--env`, ...) and `exe0-to-exe1`'s token are redacted to
`***` in error messages and `error.command`, though of course sent.

### Commands on VMs

`runOnVm(vm, command)` sends `ssh <vm> <command>`. The command passes two
parsers, the lobby's and then the VM's shell, so the VM's command line is built
first and then quoted as one lobby word, exactly as the docs' quoter does:

- an argv array: each element arrives as one argument;
- `{script, interpreter?, args?}`: any text, newlines included. It travels
  base64-encoded (`sh -c "$(printf %s <b64> | base64 -d)" name args...`), so it
  crosses both parsers as safe characters;
- `{shell}`: a VM shell line you quoted yourself.

The response body is stdout and stderr combined. The docs put the exit code in
an `X-Exe-Exit` HTTP **trailer**, and `fetch` does not expose trailers (not in
Deno, Workers or browsers). So by default the command is wrapped as

```sh
( <command> ) </dev/null; rc=$?; printf '\n<marker>%s\n' "$rc"; exit "$rc"
```

with a random marker; the client strips the marker line and reads the status
from it (`exitSource: "marker"`). The wrapper exits with the command's status,
so when a server does send `X-Exe-Exit` as a header it must agree, or the
result is a decode error. `exit: "header"` skips the wrapper and reads only a
header (`exitCode: null` when there is none). A non-zero exit is a result, not
an error; a 422 whose body carries the marker is also treated as the command's
result. Commands get EOF on stdin.

`startDetached(vm, command, {log, statusFile})` starts the command with
`setsid nohup ... &`, as the docs suggest, returns its pid, and with
`statusFile` writes the exit status there (atomically) when it finishes: the
way to run anything longer than the 30-second request limit.

### Errors

Every failure is an `ExeError` subclass with a `kind`:

| kind                  | When                                                         | Transient | Ambiguous |
| --------------------- | ------------------------------------------------------------ | --------- | --------- |
| `invalid_request`     | refused before sending; `issues` has the paths               | no        | no        |
| `bad_request`         | 400: empty body or unparseable command line                  | no        | no        |
| `authentication`      | 401: token malformed, expired, unknown key, bad signature    | no        | no        |
| `permission`          | 403: the token's `cmds` do not allow the command             | no        | no        |
| `not_found`           | 404: no such command                                         | no        | no        |
| `method_not_allowed`  | 405                                                          | no        | no        |
| `too_large`           | 413: body over 64 KiB                                        | no        | no        |
| `command_failed`      | 422: the command ran and failed; `detail` has its message    | no        | no        |
| `rate_limited`        | 429: too many requests from this SSH key                     | yes       | no        |
| `command_timeout`     | 504: the command ran over 30 s                               | yes       | yes       |
| `server`              | 500 and other 5xx                                            | yes       | yes       |
| `http`                | any other status                                             | no        | no        |
| `connection`          | no response, or a body cut short                             | yes       | yes       |
| `timeout`             | an attempt (default 40 s) or the retry budget ran out        | yes       | yes (after sending) |
| `aborted`             | the caller's signal fired                                    | no        | no        |
| `decode`              | a 2xx without the documented shape                           | no        | no        |

`ambiguous: true` means the command may have run although no answer came
back. That is what makes retrying `new` or `cp` dangerous, and why the fleet
code lists VMs again after such a failure. Errors carry `status`,
`retryAfterMs`, `command` (redacted), `body` (JSON, or text cut to 4 KiB),
`detail`, `issues`, `attempts`, `retryable` and `ambiguous`; `toJSON()` and
`outcome()` give plain data that survives Durable Object RPC and Workflow
steps, and `exeErrorFromData` rebuilds the class.

### Checking values

Typed methods check what they put on a command line before sending, and
collect every problem into one `ExeInvalidRequestError`. `Checks` holds the
issues (`add(path, message)`, `done()`), and `checks.schema(schema, path,
value, message?)` parses a value with any sieve schema, adding its issues
under `path` (or `message` in their place) and returning the parsed value.
The value types are sieve schemas, usable in routes and specs too:

| Schema     | Accepts                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `VmName`   | a lowercase DNS label of 1 to 63 characters                              |
| `Word`     | a tag, integration, key or pool name: no whitespace, commas or leading `-`; `word(what)` names it in the message |
| `Size`     | a positive number, or `8G`, `8GB`, `16GiB`, `512M`, ...                  |
| `Month`    | `YYYY-MM`, a real month (`@celld/isotime`'s `isYearMonth`)               |
| `Port`     | an integer from 1 to 65535                                               |
| `Region`   | three lowercase letters (`REGIONS` lists the documented codes)          |
| `HttpsUrl` | an absolute `https:` URL                                                 |

Dates (`billing receipts --from`) are checked with `@celld/isotime`'s strict
`isDate`, so `2026-02-30` is refused. Durations in exe's CLI syntax (`30d`,
`45m`) stay a regex, since they are not ISO 8601. The token permission rules
and the strict JSON reader stay hand-written, because they must see duplicate
keys and how numbers were written.

`integrations.attach(name, spec, {until})` takes a `Temporal.Instant` or RFC
3339 text with `Z` or an offset (checked with `@celld/isotime`'s
`parseDateTime`, so `2026-08-03 20:00Z` is refused), and sends it as UTC
(`instant.toString()`).

### Retries and rate limits

Only read-only commands (catalog `idempotent: true`) are retried: two retries,
exponential backoff from 500 ms to 8 s with a quarter jitter, `retry-after`
honoured up to 60 s, 120 s budget per call, on 429/500/502/503/504,
connection failures and client timeouts. `new`, `rm`, `cp`, `tag`, `ssh`, ...
are sent exactly once whatever the policy says; `runOnVm(..., {idempotent:
true})` and `billing credits buy` with an `idempotencyKey` opt back in. The
per-attempt timeout is 40 s, the server's 30 s plus slack.

The policy (`RetryPolicy`, `RetryOptions`, `backoffDelay`,
`parseRetryAfter`) is `@celld/http`'s `HttpRetryPolicy`; this library keeps
its own `DEFAULT_RETRY_POLICY`, and `resolveRetryPolicy(options, base?)`
resolves overrides against it. An option set to `undefined` means the
default, and a non-boolean for a boolean field or a non-iterable for
`statuses` is a `RangeError`. `Runtime`, `defaultRuntime`, `FetchLike`,
`globalFetch` and `rejectOnAbort` are re-exported from `@celld/http`, and
error bodies are kept with its `truncatedBody` (JSON, or text cut to 4 KiB
without splitting a surrogate pair).

exe.dev rate-limits per SSH key and does not publish the numbers. Every
client using tokens from one key should share one `ExeKeyLimiter` Durable
Object (name it by the key's fingerprint):

```typescript
import { durableLimiter } from "@celld/api/exedev/limiter";
export { ExeKeyLimiter } from "@celld/api/exedev/durable";

const client = ExeClient.fromEnv(env, {
  limiter: durableLimiter(env.EXE_LIMITER, "SHA256:..."),
});
```

The default of 5 requests a second with a burst of 10 is a guess;
`configure({requestsPerSecond, burst})` changes and stores it. A 429's
`retry-after` is fed back to the limiter so every caller pauses. If the
limiter throws, requests go ahead (`onLimiterError` hears about it).

When the token is a static exe0 token, the client also checks its `cmds`,
`exp` and `nbf` before sending (`checkPermissions: false` turns that off).

## Tokens

```typescript
import { mintExe0, permissions, signerFromOpenSsh, verifyExe0 } from "@celld/api/exedev";

const signer = await signerFromOpenSsh(env.EXE_SSH_PRIVATE_KEY); // unencrypted OpenSSH ed25519
const token = await mintExe0({
  signer,
  permissions: permissions({ expiresInSeconds: 3600, cmds: ["ls", "ssh web-0"] }),
});
const vmToken = await mintExe0({ signer, vm: "web-0", permissions: { ctx: { role: "deploy" } } });
```

An exe0 token is `exe0.<payload>.<signature>`, both base64url without
padding: the permissions JSON, and the OpenSSH SSHSIG blob of exactly those
bytes (namespace `v0@exe.dev`, or `v0@<vm>.exe.xyz` for a token that
authenticates to one VM's HTTPS endpoints; hash `sha512`). Minting uses Web
Crypto Ed25519, which celld has, and since Ed25519 is deterministic the result
is byte-for-byte what `ssh-keygen -Y sign` makes; the tests prove this against
a committed fixture both in Deno and inside `celld dev`. Only Ed25519 keys are
supported; a custom `SshSigner` (an agent, an HSM) may return either an SSH
signature blob or a bare 64-byte signature.

Every documented permission rule is enforced before signing:
`permissionsIssues`, `checkPermissionsText` (for text you sign byte for byte)
and `permissions()` refuse unknown top-level fields, non-integer or
out-of-range `exp`/`nbf` (946684800 to 4102444800; `2e9` and `2000000000.0`
are refused by looking at the literal), duplicate keys at any depth (a strict
JSON reader, since `JSON.parse` keeps the last one), leading/trailing
whitespace, newlines, NUL, and tokens over 8192 bytes. `cmdsAllow` implements
the `cmds` semantics: exact command paths, no parent grants a subcommand,
`"ssh"` allows any VM and `"ssh <vm>"` one VM, and an absent `cmds` means
`DEFAULT_CMDS`. `ctx` must be plain JSON (sieve's `v.json()`): `NaN`, a
`Date`, `undefined` or a cycle is an issue at its own path.
`permissions({expiresAt, notBefore})` take a `Temporal.Instant` or Unix
seconds. Payloads and signatures are canonical, unpadded base64url
(`@celld/jwt`'s codec); anything else is an `SshFormatError`.

`parseToken` decodes exe0 tokens (payload, permissions, signer key,
namespace) and recognises exe1 handles, which are opaque. `verifyExe0` checks
the rules, the signature, the namespace, the signing key (public keys,
`authorized_keys` lines or `SHA256:` fingerprints) and `exp`/`nbf`: what the
server does short of knowing which keys are on the account.
`mintingTokenSource` mints short-lived tokens and reuses each until shortly
before expiry; `ExeClient.fromEnv` uses it when `EXE_SSH_PRIVATE_KEY` is bound
instead of `EXE_API_TOKEN` (`EXE_TOKEN_CMDS`, `EXE_TOKEN_TTL_SECONDS`).
`client.sshKey.generateApiKey` and `client.exe0ToExe1` wrap the server-side
alternatives.

## On a VM

```typescript
import { VmIntegrations } from "@celld/api/exedev/vm";

const vm = new VmIntegrations();
const me = await vm.reflection.index(); // { name, emoji, paths }
const llm = await vm.reflection.findIntegration({ type: "llm" });
await vm.llmMessages({ model: "claude-sonnet-4-6", max_tokens: 256, messages }, llm?.name);
await vm.slackPost("slack-hook", { text: "deploy done" });
const { access_token } = await vm.mintToken("gsa", "googlesa");
await vm.sendEmail({ to: "me@example.com", subject: "done", body: "ok" });
```

Integrations live at `https://<name>.int.exe.xyz` (team ones at
`.team.exe.xyz`), reachable only from VMs they are attached to; exe.dev injects
the credential at the edge. Typed helpers cover what the docs describe:

- **Reflection**: `index`, `integrations`, `findIntegration`, `email`, `tags`,
  `comment`, `defaultPort`. The index and `/integrations` entries are the
  sieve schemas `ReflectionIndex`, `ReflectionPath` and `AttachedIntegration`
  (with `raw`); optional fields of the wrong type and `paths` entries without
  a string `path` are skipped, not refused.
- **LLM**: `llmModels`, `llmResponses`, `llmChatCompletions`, `llmMessages`
  (with `anthropic-version`), `llmProviderBase`.
- **GitHub**: `githubCloneUrl`, `githubHost` (the docs' aggregate host
  `github.int.exe.xyz`, for `GH_HOST`).
- **Slack**: `slackPost` (webhook), `slackCall` (bot, `/api/<method>`),
  `slackSocketUrl` (`apps.connections.open`), `slackFileUrl`.
- **Discord**: `discordPost` (webhook; refuses `username`/`avatar_url`, 256 KiB
  cap, `wait`, `thread_id`), `discordBot` (`/api/v10/...`).
- **VM-to-VM** and **HTTP proxy**: `fetch(name, path, init)`; the target reads
  `X-Exedev-Source-Vm` through `exeIdentity`.
- **Token mint**: `mintToken` for `googlesa`, `twitch`, `reddit-ads`, and
  Keycloak via `VmIntegrations.keycloakTokenPath(realm)`; the answer is the
  `MintedToken` schema.
- **Container registries**: `registryToken` for `quay`, `ghcr`, `atcr`, `gar`
  (or any realm), `VmIntegrations.dockerConfig`.
- **Workload identity**: `wifToken`, `wifMetadata`, `awsWebIdentity`,
  `gcpWifMetadata`, `gcpCredentialConfig` (an `external_account` config that
  fetches from `/token`).
- **Object storage**: `objectUrl`.
- **Email**: `sendEmail` (the `169.254.169.254` gateway), `deliveredTo` and
  `parseEmailHeaders` for mail in `~/Maildir/new`.

Everything else (the hundred-odd catalog services, database brokers) goes
through `fetch`. Reads are retried like lobby reads; every helper takes
`fetch`, `runtime`, `domain`, `scheme`, `reflectionUrl` and `emailUrl`
overrides.

## Behind the proxy

```typescript
import { exeAuth, exeIdentity } from "@celld/api/exedev/proxy";
import { router } from "@celld/router";

const app = router({ auth: exeAuth() });
app.get("/health", { public: true }, (c) => c.json({ ok: true }));
app.get("/me", (c) => c.json({ user: c.principal.subject, email: c.principal.claims.email }));
export default { fetch: app.fetch };
```

`exeIdentity` reads `X-ExeDev-UserID`, `X-ExeDev-Email`, `X-ExeDev-Token-Ctx`
(kept verbatim in `tokenCtxRaw` and parsed strictly into `tokenCtx`),
`X-Exedev-Source-Vm` and the `X-Forwarded-*` headers. Each hop of
`X-Forwarded-For` is checked with `@celld/ip` and written canonically; hops
that are not IP addresses are dropped.

`exeAuth(options?)` is an `@celld/router` `AuthScheme` named `exe` over
`exeIdentity`:

- The principal's `subject` is the user id, and `claims` holds `email`,
  `tokenCtx`, `tokenCtxRaw` and `sourceVm`. A request without a user id is
  anonymous (`null`), so public routes serve it and every other route needs
  a login.
- On a route that needs one, an anonymous `GET` or `HEAD` that accepts
  `text/html` gets a 302 to `/__exe.dev/login?redirect=<path and query>`
  (the router's `unauthenticated` hook); any other anonymous request gets
  the router's 401. `loginRedirect: false` always answers 401.
- It is `ambient`: the proxy's login is a cookie the browser sends by
  itself, so the router's CSRF check applies to state-changing requests. The
  Worker sees the VM's port rather than `https://<vm>.exe.xyz`, so for
  browsers that send `Origin` but not `Sec-Fetch-Site`, list that origin in
  `csrf.trustedOrigins`.
- In OpenAPI it is an API key in the `X-ExeDev-UserID` header.

**Security: the scheme trusts the headers, and only the proxy makes them
trustworthy.** The proxy strips these headers from what the client sends and
sets its own, so they mean something only for requests that came through it.
A Worker also reachable another way (localhost, a tunnel, another port the
proxy does not front) lets anyone be any user by sending the headers
themselves; serve such a Worker with another scheme, or not at all, on those
paths. `devIdentityHeaders` stands in for the proxy in local development.

`VmEndpointClient` calls a VM's HTTPS endpoints with a VM token in
`X-Exedev-Authorization` (the preferred form), and `basicAuthorization` builds
the Basic form `git` uses. `suggestLink`, `newVmLink` and `integrationAddLink`
build the links that hand an action to a person.

## Fleets

```typescript
export { ExeFleet, ExeKeyLimiter } from "@celld/api/exedev/durable";

const fleet = env.FLEET.getByName("web");
await fleet.configure({
  prefix: "web",
  size: 3,
  image: "ghcr.io/me/node:latest",
  cpu: 2,
  tags: ["prod"],
  comment: "web tier",
  integrations: ["llm"],
  share: { port: 8080 },
  prune: true,
}, { intervalMs: 60_000 });
const report = await fleet.reconcile();
```

```python
celld.project(..., bindings = {"FLEET": "ExeFleet", "EXE_LIMITER": "ExeKeyLimiter"})
```

`FleetSpec` is both the type and its sieve schema, a strict object:
`ExeFleet.configure`, `planFleet` and `reconcile` parse the spec with it, so
a misspelled key is an error instead of a setting silently ignored, and
`fleetSpecIssues(spec)` lists what it reports. The cross-field rules (`size`
with `names`, repeated names) are checked once every field is valid. A route
can take it as its body (`app.put("/fleets/:name", { body: FleetSpec }, ...)`).

A `FleetSpec` names VMs deterministically (`<prefix>-0` ... or explicit
`names`) and says what each should look like. `planFleet` compares it with
`ls` and the fleet's ledger and returns actions (`create`, `adopt`, `await`,
`tag`, `untag`, `comment`, `resize`, `attach`, `detach`, `share-port`,
`share-visibility`, `delete`, `forget`) plus drift it will not fix (`region`,
`status`, `disk-shrink`, unowned look-alikes, surplus VMs without `prune`).
`FleetReconciler` runs a plan against a client and a store. How it stays
correct under retries and partial failure:

1. **Names are the idempotency keys.** `new` is not idempotent, but names
   are unique, so a repeated `new --name=web-0` fails rather than making a
   second VM. After any failed or ambiguous `new` the reconciler lists again
   and adopts the VM if it is there.
2. **Intent before action.** Before `new` or `rm` the ledger records
   `creating`/`deleting` and waits for `storage.sync()`. A crash in between
   leaves a record the next run resolves by listing. A `creating` record
   younger than `creatingGraceMs` (2 minutes) is waited on, not retried,
   which also backs off definite failures such as quota errors.
3. **Only touch what is ours.** Tags are removed only if the fleet applied
   them; VMs are deleted only with `prune`, only when the ledger has them or
   they carry the owner tag (`fleet-<prefix>`), and never when desired.
4. **Every change is convergent.** Each setting action sets a target value,
   so repeating one after an ambiguous failure is harmless, and the ledger
   records what was applied so the next run only sends what differs.
5. **One run at a time.** `ExeFleet.reconcile()` never overlaps itself:
   callers arriving during a run share the one queued run after it. A run
   also takes a durable lease (90 s, renewed before every mutation and
   checked through `beforeMutation`), so a run on an earlier instance of the
   object during a handoff is not overlapped; a lease left by a crashed
   instance blocks runs until it expires.

Runs are capped at 50 mutations (`maxMutations`); the rest wait for the next
run. `plan()` is a dry run, `status()` returns spec, ledger, last report,
lease and alarm, and `requestReconcile()` schedules a run on the alarm without
waiting. `ExeFleet` builds its client with `ExeClient.fromEnv(env)`, paced by
`EXE_LIMITER` when bound; subclass it and override `createClient` to change
that.

What `ls` reports decides what can be observed. The documented listing has no
tags, comment or sizes, so for those the ledger's record of what was applied
stands in, and changes made outside the fleet to them go unnoticed; when `ls`
reports `tags` or `comment` they are used. Disk only grows, and is not resized
when its current size is unknown. Region follows the account (`set-region`),
so it is checked and reported, never enforced.

### Workflows

```typescript
import { bootstrapVm, provisionVm, verifyVm, waitForVm } from "@celld/api/exedev/workflow";

const vm = await provisionVm(step, "provision", client, { name: "web-0", tags: ["web"] });
await waitForVm(step, "wait", client, "web-0");
await bootstrapVm(step, "bootstrap", client, "web-0", installScript); // detached, runs once
await verifyVm(step, "verify", client, "web-0", { command: ["curl", "-fsS", "localhost:8000/healthz"] });
```

Each helper is one or more `step.do` calls with stable names, and each is safe
to repeat even when a step's side effect landed but its result was not stored:
`provisionVm` requires a name, lists before creating and adopts what exists;
`bootstrapVm` guards the script with a marker file on the VM (default key: a
hash of the script) and, in the default detached mode, starts it with
`setsid nohup` and polls a status file, which also avoids the 30-second limit;
`waitForVm` and `verifyVm` only read. Results are plain data; transient
failures throw so the step's durable retries take over, permanent ones are
returned as `{ok: false, error}`.

## Testing code that uses it

```typescript
import { ExeClient } from "@celld/api/exedev";
import { FakeExe } from "@celld/api/exedev/testing";

const fake = new FakeExe({ vmExec: (vm, command) => ({ output: "ok\n", exitCode: 0 }) });
const client = new ExeClient({ token: fake.issueAdminToken(), fetch: fake.fetch });
await client.new({ name: "web-0" });
fake.failNext("new", { status: 504, execute: true }); // it ran, but the answer was lost
```

`FakeExe` is a stateful lobby behind a `fetch`: it lexes bodies, resolves
commands and flags against the catalog (an undocumented flag is a 422), answers
the documented 400/401/403/404/405/413/422 cases, checks exe1 tokens it issued
and exe0 tokens signed by keys you register (`addSshKey`), including `cmds`,
`exp` and `nbf`, and keeps VMs, tags, comments, sizes, shares, links,
integrations, attachments, domains and SSH keys across calls. `ssh` runs your
`vmExec` handler and speaks the exit-marker protocol. `failNext` injects any
status, a connection reset, and either after running the command (an
ambiguous failure). `bootPolls` keeps new VMs `starting` for a few listings;
`listDetails: false` hides tags and comments like the documented listing.
The fake's JSON for undocumented commands is its own choice.

`virtualRuntime` and `fakeStep` come from `@celld/http/testing`. `fakeStep()`
replays a stored `do` result as a structured clone (the first run returns a
clone too), retries a throwing callback up to `retries.limit` (five without
`retries`), passes the effective config to the callback, logs `threw <name>:
<message>` (or `threw <value>` for a non-Error), and records `sleep <name>
<duration>` and `sleepUntil <name> <epoch ms>` once per name; sleeps are not
in `stored`.

## Judgment calls

Where the docs are silent or ambiguous:

- **Exit codes.** The docs put `X-Exe-Exit` in a trailer, which `fetch`
  cannot read, so the exit marker is the default (see above). What status the
  lobby returns for a non-zero `ssh` command is not documented: the example
  shows a 200 with the trailer, while "422: the command ran but returned a
  non-zero exit code" describes lobby commands. Both are handled.
- **Line breaks.** The API reads one command line and the docs do not say how
  the lobby treats a newline inside quotes, so NUL, CR and LF are refused in
  every word. Scripts travel base64-encoded; `new --setup-script` "supports
  `\n` for newlines", so real newlines become `\n` there, and a script that
  already contains a literal `\n` is refused as ambiguous.
- **`--` and leading dashes.** Nothing documents a `--` separator, so
  positional arguments starting with `-` are refused (a comment like
  `-draft` cannot be set), and a VM command starting with `-` gets a leading
  space.
- **Name syntax.** VM names are checked as lowercase DNS labels (they become
  `<name>.exe.xyz`); tags, integration, pool and key names may not contain
  whitespace or commas (the CLI splits `--tag` and `--integration` on commas)
  or start with `-`. Sizes are `N`, `NG`, `NGB`, `NGiB`, `NM`, `NT`.
- **"64KB" and "8KB"** are read as 65536 and 8192 bytes.
- **Idempotency** is this library's reading of each command's name and
  description; `browser`, `invite request` and anything creating a link or
  sending mail count as mutations. `share port`, `share receive-email` and
  `billing capacity` without a value are reads.
- **Rate limits** are undocumented; the limiter's 5/s burst 10 is a guess.
- **Timeouts.** 40 s per attempt (server: 30 s), 120 s budget per call.
- **Retries on 5xx for reads only.** A 504 or 500 on a mutation leaves it
  unknown whether it ran (`ambiguous`), so it is never retried automatically.
- **Result shapes.** Only the documented ones are typed (table above).
  `ssh-key list` accepts three plausible shapes; `generate-api-key` and
  `exe0-to-exe1` responses are searched for the token.
- **`help all` shape** is undocumented; `catalogDrift` reads `path`,
  `command` or `name` strings anywhere in it and skips flag and example lists.
- **Undocumented but mentioned commands** are included and marked
  `documented: false`: `vm-logs` (exe.dev's agent skill), `exe0-to-exe1`
  (HTTPS API pages), `defaults read|write|delete` (customization page;
  `write` takes the value as an argument since `/exec` has no stdin, which
  the docs do not show), `integrations setup slack|discord`. `exit` (REPL
  only) and bare `ssh <vm>` (interactive) are not offered.
- **Interactive commands** (`integrations setup chatgpt` waiting for a
  device code, `billing ... --yes` prompts) cannot prompt over HTTPS: `--yes`
  is always sent where the CLI takes it; OAuth and device-code flows return
  their links for a person and may hit the 30 s limit while waiting.
- **Credentials over `/exec`.** The CLI's `-` (read from stdin) is impossible
  over HTTPS, so secrets travel in the command line. They are redacted from
  this library's errors, but reach exe.dev like any other argument.
- **Reflection** documents only the index and `/integrations`; `/email`,
  `/tags`, `/comment` and `/default_port` accept `{field: value}`, a bare JSON
  value, or text.
- **Integration hostnames** use `https://` (the docs mix `http://` and
  `https://`); `scheme: "http"` switches.
- **The GitHub integration** is reached at `github.int.exe.xyz` whatever its
  name, as every doc example shows.
- **Token verification** checks what can be checked offline; whether a key
  is on the account is the server's to know.
- **Fleet region** is reported, not enforced; there is no per-VM region flag.

Not covered: the web UI's JSON endpoints, `execonnect` (exe.dev's WireGuard
connector), SSH itself (celld has no SSH client; `runOnVm` uses the HTTPS
API), non-Ed25519 keys, and typed results for undocumented command output.

## Dependencies

| Library          | What this library uses it for                                                  |
| ---------------- | ------------------------------------------------------------------------------ |
| `@celld/http`    | retry policy and backoff, `Runtime`, `FetchLike`, `truncatedBody`, test doubles |
| `@celld/sieve`   | response, reflection and fleet schemas; value types; `v.json()` for `ctx`       |
| `@celld/router`  | the `AuthScheme` type `exeAuth` implements (a type import only)                 |
| `@celld/isotime` | strict dates and `until` instants                                               |
| `@celld/ulid`    | `ExeFleet` lease holders                                                        |
| `@celld/ip`      | `X-Forwarded-For` hops                                                          |
| `@celld/jwt`     | the base64url codec of exe0 tokens                                              |

### Changes when moving onto them

- **Removed**: `requireLogin` (use `exeAuth()`), `Reader` and
  `readVmSummary` (use the schemas and `decodeWith`), `jsonIssues` (use
  `v.json()`), `errorBody` (use `@celld/http`'s `truncatedBody`).
- **Changed**: `integrations.attach`'s `until` is `Temporal.Instant |
  string`; `permissions()`'s `expiresAt` and `notBefore` are
  `Temporal.Instant | number`; `fleetSpecIssues` takes `unknown`, and a
  `FleetSpec` with unknown keys is refused; decode and fleet issue messages
  are sieve's; `base64UrlDecode` refuses padded or non-canonical text;
  `setRegion` checks with `Region`; `fakeStep` has `@celld/http`'s
  semantics above.
- **Added**: `exeAuth`, `ExeAuthOptions`, `Checks.schema`, the value types,
  `word`, the response, reflection, `MintedToken` and `FleetSpec` schemas,
  `decodeWith` and `issuesFrom`.
- **Unchanged**: `ReflectionClient`, `AttachedIntegration`,
  `VmHttpOptions`, `ExeClient` and the error classes.

## Test fixture

`tests/fixtures.ts` holds a throwaway Ed25519 key made with
`ssh-keygen -t ed25519 -N ''` for these tests only, the permissions it
signed, the `ssh-keygen -Y sign` signatures (API and VM namespaces), and the
tokens assembled from them as the docs do. The key is on no exe.dev account.

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev` against a fake upstream
(`buck2 test root//src/celld/api/exedev/examples/...`) and runnable with
`buck2 run root//src/celld/api/exedev/examples:<name>-dev`.

## This package's tests

`buck2 test root//src/celld/api/exedev/...` runs one Deno suite per concern
(tokens, quoting, command building and catalog, errors and retry, client,
command groups, decoding, the fake, fleet, VM side, proxy side, workflows) and
`:runtime-test`. That test starts `tests/runtime/` under `celld dev` against a
Python fake lobby that lexes bodies with `shlex` and runs VM commands through
a real `/bin/sh`: real `fetch`, both quoting layers, trailers versus headers,
exe0 minting in celld matching `ssh-keygen`, the key limiter, the fleet
object's reconcile loop (serialized concurrent callers, a lost `new` adopted,
the ledger surviving a supervisor restart, pruning, alarm-driven runs), and a
provisioning Workflow run twice without repeating work.
