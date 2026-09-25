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
    resetsAt: reset === null ? null : Math.trunc(reset) * 1000,
  };
}

function credits(headers: Headers): CreditsSnapshot | null {
  const hasCredits = headerBool(headers, "x-codex-credits-has-credits");
  const unlimited = headerBool(headers, "x-codex-credits-unlimited");
  if (hasCredits === null || unlimited === null) return null;
  const balance = headers.get("x-codex-credits-balance")?.trim();
  return { hasCredits, unlimited, balance: balance ? balance : null };
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
  const name = headers.get(`${prefix}-limit-name`)?.trim();
  return {
    limitId,
    limitName: name ? name : null,
    primary,
    secondary,
    credits: credit,
    planType: null,
  };
}

/**
 * Every rate-limit family in the headers that carries data: the default
 * `codex` family first, then others in name order.
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
    if (id !== "codex") others.add(id);
  }
  for (const id of [...others].sort()) {
    const snapshot = snapshotFor(headers, id);
    // Credits belong to the plan and are reported once, on `codex`.
    if (snapshot !== null && (snapshot.primary || snapshot.secondary)) {
      out.push({ ...snapshot, credits: null });
    }
  }
  return out;
}

function eventWindow(value: unknown): RateLimitWindow | null {
  if (!isPlainObject(value) || typeof value.used_percent !== "number") {
    return null;
  }
  return {
    usedPercent: value.used_percent,
    windowMinutes: typeof value.window_minutes === "number"
      ? value.window_minutes
      : null,
    resetsAt: typeof value.reset_at === "number" ? value.reset_at * 1000 : null,
  };
}

/** Reads a `codex.rate_limits` event payload, or null for anything else. */
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
  return {
    limitId: normalizeLimitId(id),
    limitName: null,
    primary: eventWindow(limits.primary),
    secondary: eventWindow(limits.secondary),
    credits: credit,
    planType: typeof event.plan_type === "string" ? event.plan_type : null,
  };
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
