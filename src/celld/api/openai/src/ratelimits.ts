// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The ChatGPT subscription's usage windows, as the Codex backend reports them
 * in response headers (`codex-rs/codex-api/src/rate_limits.rs`):
 *
 * ```text
 * x-codex-primary-used-percent: 12.5
 * x-codex-primary-window-minutes: 300
 * x-codex-primary-reset-at: 1704069000        (epoch seconds)
 * x-codex-secondary-...                        (the weekly window)
 * x-codex-credits-has-credits / -unlimited / -balance
 * x-<limit>-primary-used-percent ...           (other metered limits)
 * x-<limit>-limit-name
 * ```
 *
 * and, on some transports, a `codex.rate_limits` event. Whether an exe.dev
 * integration passes these headers through is not documented; everything
 * here copes with their absence.
 *
 * @module
 */

import { isPlainObject } from "./json.ts";

/**
 * The most rate-limit families kept anywhere: parsed from one response's
 * headers, seen in one stream, or held by a pacer. Limit ids come from the
 * server (or over RPC), so an unbounded map would grow with whatever it
 * sends.
 */
export const MAX_RATE_LIMIT_FAMILIES = 16;

/** A limit id after normalisation: 1 to 64 of `a-z 0-9 _`. */
export const RATE_LIMIT_ID = /^[a-z0-9_]{1,64}$/;

/** The longest limit name, plan type or credit balance kept. */
const MAX_LABEL = 256;

/**
 * The latest reset time taken from a server, in epoch seconds: the end of
 * the year 9999. Anything later (or not finite, or negative) is not a
 * date and is dropped rather than turned into an endless hold.
 */
export const MAX_RESET_AT_SECONDS = 253_402_300_799;

/** Epoch seconds from a server as epoch milliseconds, or null. */
export function resetAtMs(seconds: unknown): number | null {
  if (
    typeof seconds !== "number" || !Number.isFinite(seconds) ||
    seconds < 0 || seconds > MAX_RESET_AT_SECONDS
  ) {
    return null;
  }
  return Math.trunc(seconds) * 1000;
}

function label(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.slice(0, MAX_LABEL)
    : null;
}

/** One usage window. */
export interface RateLimitWindow {
  /** How much of the window is used, 0 to 100 (it can exceed 100). */
  readonly usedPercent: number;
  /** The window's length, when reported. */
  readonly windowMinutes: number | null;
  /** When the window resets, in epoch milliseconds, when reported. */
  readonly resetsAt: number | null;
}

/** Credits attached to the plan, when reported. */
export interface CreditsSnapshot {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
}

/** One metered limit's windows. Plain data. */
export interface RateLimitSnapshot {
  /** `codex` for the default family, or the metered limit's id. */
  readonly limitId: string;
  readonly limitName: string | null;
  /** The short window (five hours on current plans). */
  readonly primary: RateLimitWindow | null;
  /** The long window (a week on current plans). */
  readonly secondary: RateLimitWindow | null;
  readonly credits: CreditsSnapshot | null;
  readonly planType: string | null;
}

function normalizeLimitId(name: string): string {
  return name.trim().toLowerCase().replaceAll("-", "_");
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

function headerBool(headers: Headers, name: string): boolean | null {
  const raw = headers.get(name)?.trim().toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

function window(
  headers: Headers,
  prefix: string,
  which: "primary" | "secondary",
): RateLimitWindow | null {
  const used = headerNumber(headers, `${prefix}-${which}-used-percent`);
  if (used === null) return null;
  const minutes = headerNumber(headers, `${prefix}-${which}-window-minutes`);
  const reset = headerNumber(headers, `${prefix}-${which}-reset-at`);
  // Codex drops an all-zero window as "no data".
  if (used === 0 && (minutes === null || minutes === 0) && reset === null) {
    return null;
  }
  return {
    usedPercent: used,
    windowMinutes: minutes === null ? null : Math.trunc(minutes),
    resetsAt: resetAtMs(reset),
  };
}

function credits(headers: Headers): CreditsSnapshot | null {
  const hasCredits = headerBool(headers, "x-codex-credits-has-credits");
  const unlimited = headerBool(headers, "x-codex-credits-unlimited");
  if (hasCredits === null || unlimited === null) return null;
  return {
    hasCredits,
    unlimited,
    balance: label(headers.get("x-codex-credits-balance")?.trim()),
  };
}

function snapshotFor(
  headers: Headers,
  limitId: string,
): RateLimitSnapshot | null {
  const prefix = `x-${limitId.replaceAll("_", "-")}`;
  const primary = window(headers, prefix, "primary");
  const secondary = window(headers, prefix, "secondary");
  const credit = credits(headers);
  if (primary === null && secondary === null && credit === null) return null;
  return {
    limitId,
    limitName: label(headers.get(`${prefix}-limit-name`)?.trim()),
    primary,
    secondary,
    credits: credit,
    planType: null,
  };
}

/**
 * Every rate-limit family in the headers that carries data: the default
 * `codex` family first, then others in name order, at most
 * {@link MAX_RATE_LIMIT_FAMILIES} in all. Ids that are not
 * {@link RATE_LIMIT_ID}s are skipped.
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot[] {
  const out: RateLimitSnapshot[] = [];
  const main = snapshotFor(headers, "codex");
  if (main !== null) out.push(main);
  const others = new Set<string>();
  for (const [name] of headers) {
    const match = /^x-(.+)-primary-used-percent$/.exec(name.toLowerCase());
    if (match === null) continue;
    const id = normalizeLimitId(match[1]);
    if (id !== "codex" && RATE_LIMIT_ID.test(id)) others.add(id);
  }
  for (const id of [...others].sort()) {
    if (out.length >= MAX_RATE_LIMIT_FAMILIES) break;
    const snapshot = snapshotFor(headers, id);
    // Credits belong to the plan and are reported once, on `codex`.
    if (snapshot !== null && (snapshot.primary || snapshot.secondary)) {
      out.push({ ...snapshot, credits: null });
    }
  }
  return out;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function eventWindow(value: unknown): RateLimitWindow | null {
  if (!isPlainObject(value)) return null;
  const used = finiteOrNull(value.used_percent);
  if (used === null) return null;
  const minutes = finiteOrNull(value.window_minutes);
  return {
    usedPercent: used,
    windowMinutes: minutes === null ? null : Math.trunc(minutes),
    resetsAt: resetAtMs(value.reset_at),
  };
}

/**
 * Reads a `codex.rate_limits` event payload, or null for anything else
 * (including a limit id that is not a {@link RATE_LIMIT_ID}).
 */
export function parseRateLimitEvent(event: unknown): RateLimitSnapshot | null {
  if (!isPlainObject(event) || event.type !== "codex.rate_limits") return null;
  const limits = isPlainObject(event.rate_limits) ? event.rate_limits : {};
  const credit = isPlainObject(event.credits) &&
      typeof event.credits.has_credits === "boolean" &&
      typeof event.credits.unlimited === "boolean"
    ? {
      hasCredits: event.credits.has_credits,
      unlimited: event.credits.unlimited,
      balance: typeof event.credits.balance === "string"
        ? event.credits.balance
        : null,
    }
    : null;
  const id = typeof event.metered_limit_name === "string"
    ? event.metered_limit_name
    : typeof event.limit_name === "string"
    ? event.limit_name
    : "codex";
  const limitId = normalizeLimitId(id);
  if (!RATE_LIMIT_ID.test(limitId)) return null;
  return {
    limitId,
    limitName: null,
    primary: eventWindow(limits.primary),
    secondary: eventWindow(limits.secondary),
    credits: credit === null
      ? null
      : { ...credit, balance: label(credit.balance) },
    planType: label(event.plan_type),
  };
}

function checkedWindow(value: unknown): RateLimitWindow | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  const used = finiteOrNull(value.usedPercent);
  if (used === null) return undefined;
  const minutes = finiteOrNull(value.windowMinutes);
  const resets = value.resetsAt === null ? null : finiteOrNull(value.resetsAt);
  if (value.resetsAt !== null && resets === null) return undefined;
  return {
    usedPercent: used,
    windowMinutes: minutes === null ? null : Math.trunc(minutes),
    resetsAt: resets === null || resets > MAX_RESET_AT_SECONDS * 1000
      ? null
      : resets,
  };
}

/**
 * A snapshot that arrived over RPC or from storage, copied field by field
 * with the checks the parsers apply, or null when it is not one.
 */
export function checkedRateLimitSnapshot(
  value: unknown,
): RateLimitSnapshot | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.limitId !== "string" || !RATE_LIMIT_ID.test(value.limitId)) {
    return null;
  }
  const primary = checkedWindow(value.primary ?? null);
  const secondary = checkedWindow(value.secondary ?? null);
  if (primary === undefined || secondary === undefined) return null;
  const credits = isPlainObject(value.credits) &&
      typeof value.credits.hasCredits === "boolean" &&
      typeof value.credits.unlimited === "boolean"
    ? {
      hasCredits: value.credits.hasCredits,
      unlimited: value.credits.unlimited,
      balance: label(value.credits.balance),
    }
    : null;
  return {
    limitId: value.limitId,
    limitName: label(value.limitName),
    primary,
    secondary,
    credits,
    planType: label(value.planType),
  };
}

/**
 * `snapshots` with `snapshot` as the newest of its family: an earlier one
 * of the same id is replaced, and past {@link MAX_RATE_LIMIT_FAMILIES} the
 * least recently reported families are dropped.
 */
export function mergeRateLimits(
  snapshots: readonly RateLimitSnapshot[],
  snapshot: RateLimitSnapshot,
): RateLimitSnapshot[] {
  const rest = snapshots.filter((item) => item.limitId !== snapshot.limitId);
  return [...rest.slice(-(MAX_RATE_LIMIT_FAMILIES - 1)), snapshot];
}

function windows(snapshot: RateLimitSnapshot): RateLimitWindow[] {
  return [snapshot.primary, snapshot.secondary].filter((
    item,
  ): item is RateLimitWindow => item !== null);
}

/**
 * When a spent usage limit resets, from the headers of a 429 that carried no
 * `resets_at`: the family `x-codex-active-limit` names (default `codex`),
 * its latest-resetting exhausted window, else its latest-resetting window.
 */
export function usageResetAt(
  snapshots: readonly RateLimitSnapshot[],
  activeLimit: string | null,
): number | null {
  const id = normalizeLimitId(activeLimit ?? "codex");
  const snapshot = snapshots.find((item) => item.limitId === id) ??
    snapshots[0];
  if (snapshot === undefined) return null;
  const timed = windows(snapshot).filter((item) => item.resetsAt !== null);
  const exhausted = timed.filter((item) => item.usedPercent >= 100);
  const pick = (exhausted.length > 0 ? exhausted : timed).map((item) =>
    item.resetsAt!
  );
  return pick.length > 0 ? Math.max(...pick) : null;
}

/**
 * Until when the reported windows say nothing will be admitted: the latest
 * reset of any window at or over 100% that resets after `now`; null if none.
 */
export function exhaustedUntil(
  snapshots: readonly RateLimitSnapshot[],
  now: number,
): number | null {
  let until: number | null = null;
  for (const snapshot of snapshots) {
    for (const item of windows(snapshot)) {
      if (
        item.usedPercent >= 100 && item.resetsAt !== null &&
        item.resetsAt > now
      ) {
        until = Math.max(until ?? 0, item.resetsAt);
      }
    }
  }
  return until;
}
