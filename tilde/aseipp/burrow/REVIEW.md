<!--
SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
SPDX-License-Identifier: Apache-2.0
-->

# burrow code review

Review of `tilde//aseipp/burrow` as introduced by commit `11bff0f` (2026-08-26).
Files reviewed were `config.rs` (159 lines), `main.rs` (218), `tests.rs` (391)
and `tunnel.rs` (680), plus the `iroh-utils` and `iroh-boring` helper crates and
the iroh, noq, tokio, tempfile and signal-hook-registry sources they lean on.

Method. Ten independent finder angles (line-by-line, invariant audit,
cross-file tracing, Rust/tokio pitfalls, wrapper correctness, reuse,
simplification, efficiency, altitude, repo conventions) produced candidates,
which were deduplicated into 22 verifier tasks. Each verifier read the library
sources and, where possible, reproduced the behaviour empirically. The review
was stopped after all 22 verdicts landed and before the final gap sweep, so
this document is the verified list, not a claim of completeness.

Ground truth. `buck2 test tilde//aseipp/burrow:...` passed 8/8, every test
under 0.1 s. Nothing hangs and nothing looked flaky.

Tally. 16 correctness findings confirmed, 1 plausible, 3 refuted, 12 cleanup
items survived verification.

## Confirmed correctness findings

Line numbers refer to the sources as of `11bff0f`.

### C1. Unauthenticated Initials exhaust the accept loop

Severity high. `serve` in `tunnel.rs`, the `Allowlist` hook at `tunnel.rs:55`,
doc claims at `main.rs:35-36` and `tunnel.rs:51-53`.

iroh yields an `Incoming` on the first Initial packet, before any handshake.
`serve` takes one of its 64 connection slots before awaiting that `Incoming`,
and the allowlist hook only runs after the full TLS handshake, inside the task
burrow spawned for the connection. noq has no handshake timeout of its own,
only the 30 s `max_idle_timeout`, and any fresh Initial-space packet resets it.
The public relay is `AllowAll` by default and forwards by destination ID alone,
so no relationship with the server is needed.

Effect. 64 ClientHello Initials (about 77 KB) from anyone who knows the
server's endpoint ID park the accept loop indefinitely. An allowlisted laptop's
`ssh` then hangs, because `dial` has no timeout either (see C4). The module doc
saying the check happens "before the connection reaches the accept loop" is
wrong.

Fix direction. Do not count a connection against the slot budget until the
hook has accepted it, and wrap `incoming.await` in a handshake timeout so a
stalled Initial frees its slot.

### C2. Server never finds a home relay when UDP to the relay is blocked

Severity high. `tunnel.rs:99` (`NetReportConfig::minimal()`) and the bind doc
above it.

`minimal()` disables the HTTPS relay probes. iroh's own doc on that field says
disabling them "will completely prevent finding the home relay on networks
that do block QUIC". The bind doc claims the probes only rank relays. If QUIC
address discovery to the relay's UDP port 7842 fails (the home uplink blocks
UDP, or a custom `--relay` host has no QAD), iroh never selects a home relay,
never connects to it, and `burrow serve` keeps running unreachable after the
15 s warning.

The client side is unaffected. burrow dials without waiting for `online()`,
and iroh spawns a relay actor for the peer's relay URL without needing a home
relay, so a laptop on UDP-blocking guest Wi-Fi still gets through as long as
the server is reachable.

Fix direction. Keep the HTTPS probes on the server side, or at least fail
loudly instead of idling when no home relay appears.

### C3. A server restart mid-transfer looks like a clean close

Severity high. The `select!` Serve arm at `main.rs:162`, `is_normal_close` at
`tunnel.rs:468` (used at `tunnel.rs:204`, `516`, `600`), and the
`RESET_ABORTED` arms at `tunnel.rs:142` and `161`.

On SIGTERM the `select!` drops `serve`, which drops its `JoinSet` and aborts
every connection task mid-splice before the `RESET_ABORTED` arms can run.
`endpoint.close()` then sends code 0, which the client's `is_normal_close`
treats as a graceful end.

Effect. `--listen` users get a clean TCP FIN on a truncated body with only a
debug log. stdio mode exits 0. The server's `disconnected` line never prints.

Fix direction. Close each connection with a distinct shutdown code before
`endpoint.close()`. noq's `close_inner` is a no-op once a connection is
closed, so the explicit code survives iroh's later code-0 close.

### C4. `ConnectionManager::open` holds the mutex across the whole dial

Severity high. `ConnectionManager::open` and `forward_local` at
`tunnel.rs:590`, `dial` at `tunnel.rs:345`.

iroh's `connect` has no timeout. The "will time out after 10 seconds" comment
in iroh has no code behind it, so a dial to a down server is bounded only by
noq's 30 s idle timer. `open` holds the manager mutex for the entire dial.

Effect. With N local TCP connections queued on the mutex, the k-th one learns
the server is down after k × 30 s. At 256 queued the listener stops accepting,
with the last waiter about two hours out.

Fix direction. Dial with an explicit timeout, and share one in-flight dial
among waiters instead of serialising them behind the lock.

### C5. `nohup burrow serve &` dies on terminal hangup

Severity high. `shutdown_signal` at `tunnel.rs:413`, which registers SIGHUP.

tokio and signal-hook-registry never consult the inherited `SIG_IGN`
disposition when installing a handler, so nohup's ignore is overridden.
Reproduced empirically by running a nohup'd process that installs a SIGHUP
handler under a real pty and closing the terminal.

Effect. `nohup burrow serve &`, a plain `&`, and `tmux kill-session` all stop
the server. systemd and `setsid` deployments are unaffected.

Fix direction. Check the inherited disposition with `sigaction` before
registering SIGHUP, or drop SIGHUP from the shutdown set.

### C6. Post-close relay report hangs, and a second Ctrl-C is swallowed

Severity medium. The `serve` shutdown path, where it joins the relay-report
task after `endpoint.close()`, and the `iroh_utils::home_relay` doc.

`Endpoint::online()` stays pending after close. iroh documents and tests this
("closing does not disconnect the watcher"), so the `home_relay` doc claiming
it yields `None` on close is wrong.

Effect. A `burrow serve` whose relay is unreachable sits idle for up to 15 s
after SIGTERM. A second Ctrl-C does nothing, because tokio registers the
handler once for the process lifetime and signal-hook-registry skips a
previous `SIG_DFL` instead of re-raising.

Fix direction. Abort the report task on shutdown rather than joining it.

### C7. A bare key path fails the first run

Severity medium. Key persistence in `config.rs`, the `unwrap_or(".")` parent
handling and the trailing directory fsync.

With `--key mykey` or `BURROW_KEY=mykey`, `Path::parent()` returns `Some("")`
rather than `None`, so the `unwrap_or(".")` never fires and `File::open("")`
for the directory fsync fails with ENOENT after the key was already persisted.
Traced through std, clap's `PathBufValueParser` and tempfile's
`create_helper`.

Effect. The first run exits 1. The second run finds the key and works, which
hides the bug.

Fix. Treat an empty parent as `"."`.

### C8. `--key <directory>` gives a misleading chmod hint

Severity low. The key mode check in `config.rs`.

`File::open` succeeds on a directory (`open(O_RDONLY)` on a 0755 dir works),
so a `--key` pointing at a directory reports "mode 755 ... Run: chmod 600
<dir>". Check `is_file()` first.

### C9. HalfClose `try_join!` drops the healthy half

Severity medium. `tunnel.rs:167`, and the `splice` doc at `tunnel.rs:123`.

`try_join!` returns on the first `Err` and drops the other direction's future
mid-copy, discarding up to 8 KiB buffered inside `tokio::io::copy`. The
dropped `outbound` owns the noq `SendStream`; when it is dropped unfinished,
noq's `Drop` performs an implicit clean `finish()` rather than the reset the
`splice` doc promises for truncated transfers, so the peer cannot tell the
transfer was cut short.

Fix direction. On error, explicitly reset or stop the surviving half before
returning.

### C10. `MAX_FORWARDING_STREAMS` does double duty

Severity low. `tunnel.rs:42`, `216`, `269`, `281`, and `explain` at
`tunnel.rs:445`.

The constant is both the per-connection `JoinSet` bound and the global
semaphore size, so with a single client `streams.len() < 256` whenever
`try_acquire_owned` runs and `RESET_BUSY` can never fire. Separately, noq caps
a connection at 100 bidi streams by default, so live streams can never reach
the per-connection 256 gate either. A transport-parameter limit would be
per-connection only; the semaphore is the only global bound, so keep it and
give the two limits distinct values.

### C11. Dead peer costs one failed local connection (plausible)

Severity low. `ConnectionManager::open` (the `close_reason()` check followed
by `open_bi`).

The check-then-open race is only microseconds wide. The realistic dead-peer
case (server SIGKILLed, laptop woke from sleep) is not this race at all:
`open_bi` succeeds locally and the stream fails later inside `splice_tcp`
(`tunnel.rs:336`) with `ConnectionLost(Reset|TimedOut)`. Either way the first
local connection after a dead peer fails with a warning and only the next one
redials. There is no retry after the redial.

### C12. `RUST_LOG=info` drops the pacing mute

Severity low. The tracing filter setup in `main.rs`.

The default filter mutes `noq_proto::connection::pacing` (the target is
correct and the mute works). A user-supplied `RUST_LOG` replaces the whole
filter and the noise returns. Append the mute directive to the user's filter.

### C13. stdio mode downgrades an outbound `RESET_ABORTED`

Severity low. `tunnel.rs:516`, the `explain` arm at `tunnel.rs:456`.

When the client is still sending, an outbound failure carrying the server's
`RESET_ABORTED` lands in the `is_normal_close` debug arm and the process exits
0. Idle stdin never observes the stop code, because `poll_flush` on a noq
`SendStream` is a no-op, and the `explain` arm remains reachable through the
other direction. The practical cost is only the attribution line, since ssh
prints its own disconnect message and ignores the ProxyCommand exit status.

### C14. The server logs a client's `RESET_ABORTED` raw

Severity low. `report_stream_task` and the `warn!("stream failed ...")` path
in `tunnel.rs`.

In `--listen` mode a local client aborting mid-transfer (Ctrl-C on scp or
curl through the listener) produces `WARN stream failed: copying into the
tunnel: sending stopped by peer: error 3` on the server. Nothing server-side
maps peer codes. The stdio case is only a narrow race, since `conn.close()`
follows the stop with no await and noq then transmits nothing but
CONNECTION_CLOSE.

### C15. `dial`'s doc is wrong

Severity low. `tunnel.rs:345`.

The doc says `dial` "watches the connection's paths". Both callers spawn
`report_paths` themselves.

### C16. Doc-level group

Severity low, four items, all confirmed accurate.

- `main.rs:35-36` and `tunnel.rs:51-53` claim the allowlist runs before the
  accept loop. See C1.
- `config.rs:154-156` says linking rather than renaming makes the key creation
  exclusive. tempfile's `persist_noclobber` on Linux tries
  `renameat2(RENAME_NOREPLACE)` first, and both paths surface
  `AlreadyExists`, so the comment describes a distinction that does not
  matter. Prose only.
- A `Role::Client` endpoint handed to `serve` still yields `Incoming`s,
  because iroh always installs a server config even with no ALPNs. Each
  handshake then fails on ALPN and is logged only at debug.
- `iroh_utils::home_relay` claims `None` on close. See C6.

## Refuted candidates

Do not chase these.

- **LAN-only `--addr` fires the relay warning.** iroh runs `select_path()`
  inside `handle_msg_add_connection` before `Endpoint::connect` returns, and
  `PathListStream` yields the current snapshot on first poll, so the first
  item of `paths_stream()` already carries a selected path. In the LAN case
  that path is direct, `phase` moves to `Direct` immediately, and the deadline
  arm is disabled.
- **EndTunnel mode loses buffered stdin bytes.** The mechanics are accurate
  (the dropped `outbound` loses its 8 KiB buffer and gets a clean `finish()`),
  but the drop only fires after sshd has closed its send direction, which for
  OpenSSH means whole-session teardown. Any discarded bytes are ones sshd is
  no longer reading. `tests.rs:248` covers this mode.
- **The paths task lives for hours.** `paths_stream` ends on close regardless
  of live clones, and `manager.close()` cannot hang because iroh's path
  watcher ends on `on_closed`.

## Cleanup items that survived

All low value. Nine verifier-checked items plus the reuse angle's two.

- **Reap/drain duplication.** The `join_next().await` plus `task_output` or
  `report_stream_task` block repeats at `tunnel.rs` 222, 248, 254, 270, 296,
  302, 634, 668, 675, with the single-handle form at 563, 585 and
  `main.rs:167`. `JoinSet::join_all` is not a safe replacement, since it
  panics on a cancelled task and would fire right after `abort_all()`.
- **`Arc<BTreeSet<EndpointId>>` that nothing shares.** `tunnel.rs:55`, `78`,
  `main.rs:139-140` (the `allowed = allow.len()` copy exists only because the
  set is moved), `tests.rs:53`.
- **Hand-written stream gates.** The three gates in `serve` are `select!`
  preconditions written out by hand. Expressing them as preconditions also
  deletes the nested `select!` in the accept-error arm. Confirmed.
- **Accept backoff.** Folding the backoff into the accept future lets
  `join_next` cut the 100 ms sleep short. Plausible.
- **Three `shutdown_signal()` registrations.** `main.rs:162`, `tunnel.rs:499`,
  `tunnel.rs:627`. Serve mode stops by dropping the `serve` future and
  aborting connection tasks rather than cooperatively, which is also the root
  of C3.
- **`--relay` default pulled from iroh.** `main.rs:94` uses
  `iroh::defaults::prod::default_na_east_relay()`. Both sides must match, and
  an iroh bump can change it under one side.
- **`LocalEof::EndTunnel` and `process::exit`.** `tunnel.rs:116`, `501-508`
  and `main.rs:207` are two workarounds for one root cause, tokio's
  blocking-thread stdio.
- **Relay-timeout wrapper** duplicated with `iroh-test`.
- **Path-label logging** duplicated between the report paths.

## Verified non-findings

Useful ground truth for future changes.

- `accept`, `accept_bi`, `JoinSet::join_next` and `TcpListener::accept` are
  cancel-safe.
- `tokio::io::copy` flushes stdout on EOF.
- Hook rejection surfaces as `Err(LocallyRejected)` from `incoming.await`.
- Both SPDX headers are present, mimalloc is wired, tests run under
  `buck2 test`, and no tests were removed. The only convention oddity is in
  the repo's `CLAUDE.md`, which names `depot_VERSION` while the shims inject
  `DEPOT_VERSION`.

## Not done

The review was stopped before its last phase. A fresh reviewer with this list
was meant to hunt only for defects not already on it, with each new candidate
getting its own verifier. That sweep never ran, so this list is what ten
angles found, not proof that nothing else is there. No severity cut to a
top 15 was made either; the ordering above is by the reviewer's judgement of
impact.
