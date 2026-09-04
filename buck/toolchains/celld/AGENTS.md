<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# celld bugs, quirks and release notes

This is the one place that ties celld behaviour to celld versions. The
pinned release is `CELLD_VERSION` in [BUILD](BUILD). Everywhere else (the
toolchain README, `types/celld.d.ts`, the `src/celld` libraries, journal,
wormspace, Orchestra), code and docs describe the platform without version
numbers and link here for its bugs.

When the pin moves:

1. Re-run `buck2 test toolchains//celld/...`. The runtime tests named below
   reproduce each fixed bug, so a release that regresses one fails there.
2. Re-check every open entry against the new release (most have a
   one-file reproduction below or in the named test), and move the fixed
   ones to [Fixed](#fixed), with the release that fixed them.
3. Remove the workarounds the fix makes unnecessary, and say so in the
   entry.
4. Check `types/celld.d.ts` against the release's `crates/celld/js/`
   source, and add the release's upgrade notes to
   [Release notes](#release-notes).

`types/celld.d.ts` was last checked against the source of v0.6.1.

## Open

Present in the pinned release. "Since" is the first release we saw it in,
not necessarily the first that had it.

### Symmetric JWKs cannot be imported or exported

Since 0.5.1; no upstream issue. A `kty: "oct"` JWK is refused, while the
same key imported as `raw` bytes works. Exporting an HMAC key as `jwk`
fails the same way.

```javascript
await crypto.subtle.importKey("jwk", { kty: "oct", k: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LXNlY3I", alg: "HS256" },
  { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
// NotSupportedError: unsupported key import
```

Decode `k` with base64url and import the bytes as `raw`. `@celld/sec/jwt`
reports the refusal as `runtime_unsupported` with the runtime's error as
the `cause`, and its examples pass HMAC keys as bytes.

### EC raw keys and off-curve points

Since 0.6.0; no upstream issue. `exportKey("raw")` of an EC public key
returns the SPKI DER (91 bytes for P-256, identical to `spki`), and
`importKey("raw")` of any EC public key is `NotSupportedError`. An
off-curve point is refused as a `jwk`, with a plain `Error` rather than a
`DataError`, but accepted as `spki`; `deriveBits` with it then fails, so it
does not enable invalid-curve key recovery. Use `spki` or `jwk` for EC
public keys.

### An alarm more than about 2.18 years ahead kills the node

Since 0.5.1; no upstream issue. A deadline past 2^36 ms (68,719,476,736 ms)
from now panics celld's core thread and aborts the whole node, every
Worker on it included, and the request gets no answer. 68,000,000,000 ms
still works. The alarm is not stored, so the node starts again cleanly.

```javascript
// in a Durable Object method
await this.ctx.storage.setAlarm(Date.now() + 69_000_000_000);
// v0.6.1: thread 'celld-core' panicked at crates/celld/actor/effects.rs:252:26:
// invalid deadline; err=Invalid
// Error: the local celld node exited with signal: 6 (SIGABRT)
```

Clamp alarm times well inside that bound (a year is plenty) and
reschedule. The `@celld/core` isotime examples (`ttl.ts`, `reminders.ts`)
wake at least daily for this reason.

### `.dev.vars` reads no escapes

Since 0.6.0; no upstream issue (#243 is the related `.env` gap). `celld
dev` splits each line at the first `=`, trims both sides and removes one
pair of matching `'` or `"` around the value, and nothing more: `"a\"b"`
arrives as `a\"b`, `#` does not start a comment, `$NAME` is not expanded, a
quoted value cannot span lines, lines without `=` are ignored, and `export
NAME=...` is an invalid binding name. A value between single quotes arrives
verbatim, JSON included, which is how the
[example harness](../../../src/celld/examples/harness.py) writes them; its
`harness_test.py` models this parser.

### Returning an outbound WebSocket from a Durable Object breaks it

Since 0.6.0; not yet filed upstream. A Durable Object `fetch()` that returns
`await fetch(url, { headers: { Upgrade: "websocket" } })` hands the client
a socket that fails with an unexpected EOF or a reset before the first
echo. The outbound connection and the ingress registration share one
socket ID in celld's WebSocket registry (`ws_register(id, …)` in
`crates/celld/main/websocket.rs`), and the second registration replaces
the first writer. A standalone reproduction (repro.ts, worker.js,
wrangler.jsonc) is in the work-in-progress change `ylxlxznn`, under
`src/celld/box/browser/repro/websocket-passthrough/`. `@celld/box/browser`
relays through an accepted `WebSocketPair` instead.

### WebSockets have no `bufferedAmount`

Since 0.6.0. celld queues outgoing frames on the host, so a sender cannot
see how much is waiting. `@celld/box/browser`'s bridge bounds the total
forwarded bytes and each frame itself.

### Errors from a crash failover carry no `code`

Since 0.5.1. Only `DurableObjectRoutingError` (`owner_unreachable`) has a
`code`. A request for a cell whose owner just died throws a plain `Error`
whose message starts with `remote RPC transport failed` (the survivor
dialled the dead owner's peer tunnel); a write the fleet could not prove
durable throws `route failed: DurabilityUnproven`; a cell whose state the
bucket cannot restore yet throws `route RPC <scope>: RestoreFailed`. All
three are safe to repeat. journal's and wormspace's `retryableCause`
(`src/http.ts`) recognise them by message, and their fleet failover tests
assert that a crash failover reaches clients as 503s, so a reworded
message fails there.

### Node ids must survive restarts; restarting one node alone can lose writes

[#244](https://github.com/denoland/celld/issues/244) and
[#245](https://github.com/denoland/celld/issues/245), open, seen on 0.6.0
and 0.6.1. In a fleet with `fleet` durability:

- A node that restarts under a new `CELLD_NODE` at its old address answers
  a seal request aimed at its old id with `409 peer request targets a
  different node session`. celld counts that member as undecided and
  retries every 30 s forever: recovery of a dead peer's log the old id
  witnessed logs `no complete true witness among {…} and 1 member(s)
  undecided; refusing to seal while member state remains unverified` and
  its cells never come back. The default `CELLD_NODE` is random per start,
  as are restart policies that mint an id per restart.
- With stable ids, a node restarted alone after the witness grace
  (max(3 × TTL, 20 s)), while its follower stays down, declares a bounded
  loss of acknowledged writes (`declared bounded loss: no complete true
  witness for an active log`). New writes then reuse the sequence numbers
  of the lost acknowledged ones (#245, point 1), so an acknowledged result
  can later name a different row.
- A three-node fleet keeps a one-follower ensemble (#245, point 2), so a
  third node does not protect the acknowledged tail.

Keep `CELLD_NODE`, the peer address and `CELLD_WATCH` stable per machine,
and restart a whole fleet together. The journal does not detect a declared
loss: a two-node fleet reproduction (owner restarted alone with its own
disk, follower down past the grace) lost the acknowledged tail in 4 of 4
runs, and new appends took the lost seqs. The same scenario with
`CELLD_DURABILITY=bucket` lost nothing, since every commit waits for the
bucket rather than a follower.

**For now, every fleet here runs with `CELLD_DURABILITY=bucket`.** The fleet
harness (journal and wormspace) and Orchestra's E2E set it, the journal README
requires it of deployments, and journal's `:fleet-loss-test` replays the
restart above and fails if anything acknowledged is lost or reused. The cost
is a bucket round trip per commit instead of a follower's. Revisit once
#245 is fixed: `fleet` durability is safe again only when a declared loss can
no longer silently reuse acknowledged seqs. The fleet harness
(`tilde/aseipp/wormspace/tests/celld_fleet.py`) restarts each node under
its own name; when it minted `<name>-<start>` instead, journal's
`fleet-failover-test` survivor-fence case stalled on the first of these.

### S3 conditional-write conflicts self-fence a node

[#239](https://github.com/denoland/celld/issues/239), open, seen on 0.4.1
and 0.6.0. AWS S3 can answer a lease renewal's `If-Match` PUT with `409
ConditionalRequestConflict` for several seconds; celld treats it like a
lost compare-and-swap (`412`), retries with a readback each time, runs out
the TTL and self-fences (exit 3). It does not affect the chaos3 or mems3
buckets the tests here use. Run fleets on AWS S3 under a supervisor that
restarts a fenced node.

### `celld deploy` does not retry its own conditional writes

Since 0.5.1. One `SlowDown` from the bucket ends a deploy with "may have
committed". The command is idempotent, so retry it whole; the fleet
harness does, and counts the attempts.

### Smaller gaps

- Durable Object RPC cannot carry a stream: a returned `ReadableStream`
  or streaming `Response` arrives empty, while a stub's `fetch` streams.
  `@celld/box/sandbox` hands out a one-time ticket over RPC and streams
  through `fetch`.
- `ContainerStartOptions.hardTimeout` is validated as positive but not
  enforced, and container `onStop` gets no exit code.
- Containers get no cgroup controls inside the guest, so per-command CPU,
  memory or disk quotas are not possible (`@celld/box/sandbox`).
- `celld dev` refuses `--port 0`. The runtime tests reserve a free port
  and release it just before starting.

## Fixed

Each is reproduced by a toolchain test that fails on the release before the
fix; the workaround it needed is gone.

| Issue | Fixed in | What was wrong | Pinned by | Workaround removed |
| --- | --- | --- | --- | --- |
| [#233](https://github.com/denoland/celld/issues/233) | 0.6.1 | A `kv.list()` iterator left unfinished (as Workflows' `waitForEvent` leaves one) held a SQLite read; after a checkpoint every later write failed with `database is locked`. Seen from 0.4.0. | `:runtime-test` `test_an_unfinished_kv_list_iterator_does_not_block_writes` | Orchestra polled the broker ledger with durable sleeps instead of waiting on Workflow events |
| [#236](https://github.com/denoland/celld/issues/236) | 0.6.1 | On a hibernatable socket, an RPC's frame could overtake a frame sent earlier from `webSocketMessage()`. | `:runtime-test` `test_message_frames_keep_send_order_with_rpc_frames` | `@celld/web/realtime`'s client held and reordered messages along `prev`, and presence events carried a version |
| [#242](https://github.com/denoland/celld/issues/242) | 0.6.1 | A `webSocketMessage()` handler blocked later messages on the same socket until it finished. Handlers now overlap: code that assumed one at a time per socket must guard its own critical sections. | `:runtime-test` `test_a_message_runs_while_an_earlier_handler_waits` | none (rooms' handlers are synchronous) |
| [#237](https://github.com/denoland/celld/issues/237) | 0.6.1 | A facet's `ctx.id` lost the name of a named `DurableObjectId`. | `:runtime-test` `test_facet_ids_keep_their_kind_and_name_and_classes_take_props` | none |
| [#226](https://github.com/denoland/celld/issues/226) | 0.6.0 | A nested `transactionSync()` through the root storage handle failed. | `:runtime-test` `test_transaction_sync_takes_no_argument_and_nests_through_the_root` | none |
| [#221](https://github.com/denoland/celld/issues/221) | 0.6.0 | `crypto.subtle` had no Ed25519 or X25519. | `:runtime-test` `test_ed25519_and_x25519` | `@celld/sec/oauth` and `@celld/sec/oidc` left EdDSA out of their defaults |
| none | 0.5.0 | Cross-request async work was discarded with the request that finished first: a promise-tail serializer could start the next request's native operation in the finishing request's microtask checkpoint, and celld dropped it with the wrong request. Orchestra's `storage.sync()` stalled on it. Seen on 0.4.0 and 0.4.1. | `:runtime-test` `PromiseTailTest` | none |

## Release notes

What each upgrade meant for this repo, newest first. Application-visible
changes are reflected in `types/celld.d.ts`.

### 0.6.1

- **Rolling update** from 0.6.0. Do not set `CELLD_LTX_RETENTION_SECS`
  (epoch GC), deploy a Python Worker, or raise `CELLD_MAX_ASSET_FILE_BYTES`
  above 25 MiB until every node runs 0.6.1. Epoch GC also needs
  list-after-write consistency from the bucket, which a multi-region
  Tigris bucket gives only in the writing region.
- Fixed #233, #236, #237, #242 (see [Fixed](#fixed)).
- A facet started with a string `id` sees that string as `ctx.id`, not a
  `DurableObjectId` (the `Id` type parameter of `DurableObjectState` and
  `DurableObject`).
- `ctx.exports.Name` for an unbound class is callable:
  `ctx.exports.Name({ props })` copies `props` into a class handle
  (`LoopbackDurableObjectClass`). An uncalled one gives the facet `{}` as
  `ctx.props` instead of `undefined`.
- A loaded Dynamic Worker lives while any stub, entrypoint, class or
  running facet of its load does. `get(name)` holds it weakly and runs
  `getCode` again after it goes; `dispose()` releases it for every stub of
  the load.

### 0.6.0

- **Stopped-fleet upgrade** from 0.5.1 for `fleet` durability: stop every
  0.5.1 node, then start the 0.6.0 nodes. A 0.6.0 node recovers its log
  session only from a follower that returns the ranged tail format, which
  0.5.1 followers do not, so a mixed fleet refuses to start. A fleet with
  `bucket` durability has no followers and can take a rolling update.
  Facet databases from 0.5.1 migrate to their own files on first open.
- Fixed #221, #226.
- `transactionSync()` hands its callback nothing; write through
  `ctx.storage`. A nested call, through any handle, is a savepoint.
- Facet writes commit in the facet's own database: a rollback of a root
  transaction does not undo a facet call inside it.
- `WorkerCode.compatibilityDate` is required, and a wasm module must be
  `{ wasm: bytes }`.
- A main module that exports anything other than a handler object or
  class (`export const X = "..."`) fails the Worker's start.
- R2 keeps empty key segments: `a/b`, `/a/b`, `a//b` and `a/b/` are four
  objects. An object 0.5.1 wrote as `photos/` stays at `photos`.
- Invalid UTF-8 in SQLite `TEXT` decodes as U+FFFD in Durable Object SQL
  and D1 instead of failing.

### 0.5.1

- **Rolling update** from 0.5.0: replace one node, wait for its
  replacement to report healthy, then continue to the next.

### 0.5.0

- **Stopped-fleet upgrade** from 0.4.1. Stop application traffic,
  deployment writers, every old node and their supervisors; wait for the
  old node leases to expire. Back up both the fleet bucket and node data
  directories (a follower disk can hold acknowledged writes not yet in the
  bucket). Prevent old binaries from returning, then start 0.5.0 with the
  same node identities, addresses, configuration and data directories.
  Startup migrates the wake format before serving. Never start 0.4.1
  against the upgraded bucket; rollback needs a complete stopped-fleet
  backup. See upstream's
  [wake-format upgrade contract](https://github.com/denoland/celld/blob/v0.5.0/docs/guarantees.md#start-a-fleet-with-this-format).
- Fixed the cross-request promise-tail bug (see [Fixed](#fixed)).
- Workers AI was removed: celld rejects `CELLD_AI_URL`, `CELLD_AI_BINDING`
  and an `ai` deployment declaration, and the declarations have no `Ai`
  binding. Call an AI provider from application code.
