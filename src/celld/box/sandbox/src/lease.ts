// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { MAX_TIMER_MS, safeInt } from "@celld/core/bounds";
import { strictRecord } from "./core.ts";
import { SandboxError } from "./errors.ts";
import type { SandboxApi } from "./types.ts";
type SandboxLeases = Pick<
  SandboxApi,
  "acquireLease" | "renewLease" | "releaseLease"
>;

/** The lease every mutation of the workspace holds. */
export const WORKSPACE_LEASE = "workspace";
/** How long a lease lasts between renewals. */
export const LEASE_TTL_MS = 30_000;
/** How long a mutation waits for the lease without a signal. */
export const LEASE_WAIT_MS = 60_000;
/**
 * The default {@link WorkspaceLeaseOptions.maxHoldMs}: ten minutes, the
 * sandbox's longest lease.
 */
export const DEFAULT_MAX_HOLD_MS = 600_000;
/**
 * How long past a command's own deadline its shell call keeps the lease:
 * the sandbox kills the command's process group at the deadline (and
 * destroys the container when that kill fails), so by then it has stopped.
 */
export const LEASE_KILL_GRACE_MS = 30_000;
/** The longest lease the sandbox grants. */
const MAX_LEASE_TTL_MS = 600_000;

/** The lease could not be had in time, or was lost while held. */
export class WorkspaceLeaseError extends Error {
  override readonly name = "WorkspaceLeaseError";
}

/** Options for {@link withWorkspaceLease}. */
export interface WorkspaceLeaseOptions {
  /**
   * The lease's lifetime from each grant; default {@link LEASE_TTL_MS},
   * at most 10 minutes. It is renewed every third of that.
   */
  readonly ttlMs?: number;
  /**
   * The longest the lease is held, from when it was granted; default
   * {@link DEFAULT_MAX_HOLD_MS}. Past it the work is aborted and the lease
   * is no longer renewed, so a mutation stuck on a call that never settles
   * fences other Workers for at most this long plus one `ttlMs`.
   */
  readonly maxHoldMs?: number;
}

const pause = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", stop, { once: true });
  });

/**
 * Runs `work` holding the sandbox's {@link WORKSPACE_LEASE}: waits for it
 * (until `signal` aborts, or {@link LEASE_WAIT_MS} without one), renews it
 * while `work` runs, and releases it after. `work` gets a signal that
 * aborts with `signal` and when the lease may be lost, so no mutation goes
 * on after another holder may have started:
 *
 * - a renewal answers that the lease is gone, or fails;
 * - no renewal has succeeded by one sixth of `ttlMs` before the last grant
 *   would run out, counted from when that grant was asked for (so a stalled
 *   renewal is given up before the sandbox lets anyone else in);
 * - `maxHoldMs` has passed; renewals then stop too.
 *
 * `work` also gets the lease's token, which it passes as `lease` to every
 * mutating sandbox call (`exec`/`execShell` unless `mutates: false`,
 * `writeFile`, `renameFile`, `deleteFile`, `remove`, `mkdir`,
 * `gitCheckout`, `startProcess`): the sandbox refuses a mutation without
 * it while the lease is held (`lease_held`), and one whose lease was lost
 * (`lease_lost`). This low-level callback API is for trusted code; prefer the
 * client's scoped file facade to inject tokens automatically. A sandbox
 * refusal of the lease that reaches `withWorkspaceLease` is a
 * {@link WorkspaceLeaseError}; nothing is tried again.
 *
 * @throws {WorkspaceLeaseError} when the lease was not free in time or was
 * lost (the work is aborted first), or the sandbox refused a call made
 * under it (`lease_held`, `lease_lost`).
 * @throws {RangeError} for a `ttlMs` or `maxHoldMs` out of range.
 */
export async function withWorkspaceLease<T>(
  sandbox: SandboxLeases,
  signal: AbortSignal | undefined,
  work: (signal: AbortSignal, lease: string) => Promise<T>,
  options: WorkspaceLeaseOptions = {},
): Promise<T> {
  strictRecord(options, ["ttlMs", "maxHoldMs"], "workspace lease options");
  const ttlMs = safeInt(options.ttlMs ?? LEASE_TTL_MS, {
    name: "ttlMs",
    min: 1,
    max: MAX_LEASE_TTL_MS,
  });
  const maxHoldMs = safeInt(options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS, {
    name: "maxHoldMs",
    min: 1,
    max: MAX_TIMER_MS,
  });
  const deadline = Date.now() + LEASE_WAIT_MS;
  let lease = null;
  let asked = 0;
  for (let wait = 20;; wait = Math.min(wait * 2, 500)) {
    signal?.throwIfAborted();
    asked = Date.now();
    lease = await sandbox.acquireLease(WORKSPACE_LEASE, { ttlMs });
    if (lease !== null) break;
    if (signal === undefined && Date.now() >= deadline) {
      throw new WorkspaceLeaseError(
        `the sandbox workspace stayed busy for ${LEASE_WAIT_MS} ms`,
      );
    }
    await pause(wait, signal);
  }
  const held = lease;
  const fence = new AbortController();
  const onAbort = () => fence.abort(signal!.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const lost = (why: string) =>
    fence.abort(
      new WorkspaceLeaseError(
        `the sandbox workspace lease ${why} while a change was running`,
      ),
    );
  let finished = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let latest = asked;
  // A grant asked for at `at` lasts at least until `at + ttlMs` on the
  // sandbox's clock, whatever the skew: give it up a margin before that.
  const granted = (at: number) => {
    if (finished || at < latest) return;
    latest = at;
    clearTimeout(expiry);
    expiry = setTimeout(
      () => lost("could not be renewed in time"),
      Math.max(0, at + ttlMs - Math.ceil(ttlMs / 6) - Date.now()),
    );
  };
  granted(asked);
  let renewing = false;
  const renewal = setInterval(() => {
    if (renewing || finished || fence.signal.aborted) return;
    renewing = true;
    const at = Date.now();
    sandbox.renewLease(WORKSPACE_LEASE, held.token, { ttlMs })
      .then((renewed) => {
        if (renewed === null) lost("was lost");
        else granted(at);
      }, () => lost("could not be renewed")).finally(() => {
        renewing = false;
      });
  }, Math.max(1, Math.floor(ttlMs / 3)));
  const hold = setTimeout(() => {
    clearInterval(renewal);
    lost(`was held for its longest, ${maxHoldMs} ms,`);
  }, maxHoldMs);
  try {
    let result: T;
    try {
      fence.signal.throwIfAborted();
      result = await work(fence.signal, held.token);
    } catch (error) {
      throw leaseRefusal(error) ?? error;
    }
    fence.signal.throwIfAborted();
    return result;
  } finally {
    finished = true;
    clearInterval(renewal);
    clearTimeout(expiry);
    clearTimeout(hold);
    signal?.removeEventListener("abort", onAbort);
    // A release that fails leaves the lease to expire within `ttlMs`.
    await sandbox.releaseLease(WORKSPACE_LEASE, held.token).catch(() => {});
  }
}

// The sandbox's refusal of a lease as a WorkspaceLeaseError, else null.
function leaseRefusal(error: unknown): WorkspaceLeaseError | null {
  const refused = SandboxError.from(error);
  if (refused?.code === "lease_lost") {
    return new WorkspaceLeaseError(
      `the sandbox workspace lease was lost, and the sandbox refused the change: ${refused.detail}`,
      { cause: error },
    );
  }
  if (refused?.code === "lease_held") {
    return new WorkspaceLeaseError(
      `another caller holds the sandbox workspace lease, and the sandbox refused the change: ${refused.detail}`,
      { cause: error },
    );
  }
  return null;
}
