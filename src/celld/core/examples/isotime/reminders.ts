// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A reminders API: "remind me in PT15M", or at a date-time, in a real time
 * zone.
 *
 * `POST /reminders` takes `{"text"}` and either `"in"`, an ISO 8601
 * duration, or `"at"`, an RFC 3339 date-time. A duration counts from
 * `"from"` (a date-time, default now). An optional `"zone"` names an IANA
 * time zone (`"America/New_York"`):
 *
 * - With a zone, `at` and `from` may be local date-times, read in that
 *   zone. A wall-clock time the zone skips or repeats (a daylight-saving
 *   change) is refused rather than guessed.
 * - Durations are added with `Temporal.ZonedDateTime.add`, in the zone, or
 *   at the offset the caller wrote, or in UTC. So `P1D` keeps the
 *   wall-clock time across a daylight-saving change while `PT24H` is
 *   exactly 24 hours, and from 2024-01-31 `P1M` is 2024-02-29.
 * - Without a zone, a local date-time names no instant and is refused.
 *
 * `@celld/core/isotime` only decides what text is acceptable: strict RFC 3339
 * (no `2023-02-29`, no leap seconds, no `[Europe/Paris]` annotations) and
 * ISO 8601 durations. `Temporal` does everything else. The answer gives
 * the due time in UTC and as `local`, in the zone (or offset) the caller
 * used.
 *
 * Reminders live in one `Reminders` Durable Object, keyed by a ULID minted
 * at the due time, so listing them in key order lists them by due time. The
 * object's alarm fires at the next due time (or in a day, whichever is
 * sooner), marks what is due, and deletes reminders that fired more than a
 * week ago. A due time a ULID cannot hold (before 1970, or after 10889) is
 * refused.
 *
 * - `GET /reminders` lists them with `local` and `fired`.
 * - `DELETE /reminders/<id>` removes one.
 *
 * This is a local demo with no authentication: every caller shares the one
 * list, so anyone who can reach the Worker reads, adds and deletes everyone's
 * reminders. A deployment keys the object by an authenticated principal (see
 * the router examples). Bodies are read under a 16 KiB cap (413 above it),
 * `text` is at most 500 characters, and the list holds at most 1,000
 * reminders.
 *
 * ```sh
 * buck2 run root//src/celld/core/examples/isotime:reminders-dev
 * curl -sS -X POST localhost:9876/reminders -d '{"text": "stretch", "in": "PT15M"}'
 * curl -sS -X POST localhost:9876/reminders \
 *   -d '{"text": "call", "at": "2030-01-01T09:00:00", "zone": "Europe/Paris"}'
 * curl -sS localhost:9876/reminders
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { parseDateTime, parseDuration } from "@celld/core/isotime";
import {
  BoundsError,
  bytes,
  parseJsonBounded,
  readTextBounded,
} from "@celld/core/bounds";
import {
  decodeTime,
  encodeTime,
  isUlid,
  MAX_TIME,
  ulid,
} from "@celld/core/ulid";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MAX_BODY = bytes(16 * 1024);
const MAX_TEXT = 500;
const MAX_REMINDERS = 1_000;

interface Env {
  readonly REMINDERS: DurableObjectNamespace<Reminders>;
}

/** A stored reminder as the API shows it. */
export interface Reminder {
  readonly id: string;
  readonly text: string;
  readonly due: string;
  readonly local: string;
  readonly fired: boolean;
}

/** An instant in UTC, as `Z`. */
function utc(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString();
}

/**
 * An instant as the caller would read it: in UTC with `Z`, at a fixed
 * offset as `±HH:MM`, or in an IANA zone with the zone's name.
 */
function local(ms: number, zone: string): string {
  const at = Temporal.Instant.fromEpochMilliseconds(ms);
  if (zone === "UTC") return at.toString();
  const zoned = at.toZonedDateTimeISO(zone);
  return /^[+-]/.test(zone)
    ? zoned.toString({ timeZoneName: "never" })
    : zoned.toString();
}

/** Everyone's reminders, in due order. */
export class Reminders extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `fired` is when the alarm marked the reminder, or 0.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, text TEXT NOT NULL, zone TEXT NOT NULL, fired INTEGER NOT NULL DEFAULT 0)",
    );
  }

  /** The new reminder's id, or null when the list is full. */
  async add(text: string, due: number, zone: string): Promise<string | null> {
    const { n } = this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT count(*) AS n FROM reminders",
    ).one();
    if (n >= MAX_REMINDERS) return null;
    const id = ulid(due);
    this.ctx.storage.sql.exec(
      "INSERT INTO reminders (id, text, zone) VALUES (?, ?, ?)",
      id,
      text,
      zone,
    );
    await this.#schedule();
    return id;
  }

  list(): Reminder[] {
    return this.ctx.storage.sql.exec<
      { id: string; text: string; zone: string; fired: number }
    >(
      "SELECT id, text, zone, fired FROM reminders ORDER BY id",
    ).toArray().map(({ id, text, zone, fired }) => ({
      id,
      text,
      due: utc(decodeTime(id)),
      local: local(decodeTime(id), zone),
      fired: fired !== 0,
    }));
  }

  async remove(id: string): Promise<boolean> {
    const { rowsWritten } = this.ctx.storage.sql.exec(
      "DELETE FROM reminders WHERE id = ?",
      id,
    );
    await this.#schedule();
    return rowsWritten > 0;
  }

  async alarm(): Promise<void> {
    // Every ID minted at or before now sorts before the next millisecond's
    // time part.
    const now = Date.now();
    const bound = encodeTime(now + 1);
    this.ctx.storage.sql.exec(
      "UPDATE reminders SET fired = ? WHERE fired = 0 AND id < ?",
      now,
      bound,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM reminders WHERE fired != 0 AND fired < ?",
      now - WEEK_MS,
    );
    await this.#schedule();
  }

  async #schedule(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM reminders WHERE fired = 0 ORDER BY id LIMIT 1",
    ).toArray()[0];
    const fired = this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT count(*) AS n FROM reminders WHERE fired != 0",
    ).one().n;
    if (next === undefined && fired === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // celld panics on an alarm set years ahead ("invalid deadline"),
    // so a distant reminder is reached by waking once a day until it is due.
    // The daily wake-up also deletes what fired over a week ago.
    await this.ctx.storage.setAlarm(
      Math.min(next ? decodeTime(next.id) : Infinity, Date.now() + DAY_MS),
    );
  }
}

class BadInput extends Error {}

function error(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

/** The IANA time zone (or offset) `name` names, canonicalized. */
function timeZone(name: unknown): string {
  if (typeof name === "string") {
    try {
      return new Temporal.ZonedDateTime(0n, name).timeZoneId;
    } catch (cause) {
      if (!(cause instanceof RangeError)) throw cause;
    }
  }
  throw new BadInput(`zone is not a time zone: ${name}`);
}

/**
 * A date-time as a `ZonedDateTime`: in `zone` when there is one, else at
 * the offset the text was written with (UTC for `Z`).
 */
function dateTime(
  name: string,
  text: unknown,
  zone: string | undefined,
): Temporal.ZonedDateTime {
  if (typeof text !== "string") {
    throw new BadInput(`${name} is an RFC 3339 date-time`);
  }
  const parsed = parseDateTime(text, { offset: true, local: true });
  if (parsed === null) {
    throw new BadInput(`${name} is not an RFC 3339 date-time: ${text}`);
  }
  if (parsed instanceof Temporal.Instant) {
    const written = text.endsWith("Z") || text.endsWith("-00:00")
      ? "UTC"
      : text.slice(-6);
    return parsed.toZonedDateTimeISO(zone ?? written);
  }
  if (zone === undefined) {
    throw new BadInput(
      `${name} needs a zone (Z, ±HH:MM or a zone field): ${text}`,
    );
  }
  try {
    return parsed.toZonedDateTime(zone, { disambiguation: "reject" });
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    throw new BadInput(`${name} is skipped or repeated in ${zone}: ${text}`);
  }
}

/**
 * The body as a JSON object, read under {@link MAX_BODY}: `{}` when it is
 * not one.
 *
 * @throws {BoundsError} `too_large` over the cap.
 */
async function readObject(request: Request): Promise<Record<string, unknown>> {
  const text = await readTextBounded(request, { maxBytes: MAX_BODY });
  try {
    const body = parseJsonBounded(text, {
      maxDepth: 4,
      maxKeys: 16,
      maxItems: 16,
    });
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch (cause) {
    if (cause instanceof BoundsError) return {};
    throw cause;
  }
}

async function add(request: Request, env: Env): Promise<Response> {
  const body = await readObject(request);
  if (typeof body.text !== "string" || body.text === "") {
    return error("expected {text, in | at, from?, zone?}");
  }
  if (body.text.length > MAX_TEXT) {
    return error(`text is 1 to ${MAX_TEXT} characters`);
  }
  if ((body.in === undefined) === (body.at === undefined)) {
    return error("give exactly one of in (a duration) and at (a date-time)");
  }
  let due: Temporal.ZonedDateTime;
  try {
    const zone = body.zone === undefined ? undefined : timeZone(body.zone);
    if (body.at !== undefined) {
      due = dateTime("at", body.at, zone);
    } else {
      const duration = typeof body.in === "string"
        ? parseDuration(body.in)
        : null;
      if (duration === null) {
        throw new BadInput(
          `in is not an ISO 8601 duration: ${JSON.stringify(body.in)}`,
        );
      }
      const from = body.from === undefined
        ? Temporal.Now.zonedDateTimeISO(zone ?? "UTC")
        : dateTime("from", body.from, zone);
      due = from.add(duration);
    }
  } catch (cause) {
    if (cause instanceof BadInput) return error(cause.message);
    // Temporal's own RangeError: a due time past its range, such as P9999Y.
    if (cause instanceof RangeError) return error("due is out of range");
    throw cause;
  }
  const ms = due.epochMilliseconds;
  // A ULID's time part holds 0 to 2^48 - 1 ms, 1970 to 10889.
  if (ms < 0 || ms > MAX_TIME) return error("due is out of range");
  const id = await env.REMINDERS.getByName("default").add(
    body.text,
    ms,
    due.timeZoneId,
  );
  if (id === null) {
    return error(`at most ${MAX_REMINDERS} reminders`, 409);
  }
  return Response.json({
    id,
    text: body.text,
    due: utc(ms),
    local: local(ms, due.timeZoneId),
  }, { status: 201 });
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const reminders = env.REMINDERS.getByName("default");
  if (pathname === "/reminders") {
    if (request.method === "POST") return await add(request, env);
    if (request.method === "GET") {
      return Response.json({ reminders: await reminders.list() });
    }
  }
  const one = /^\/reminders\/([^/]+)$/.exec(pathname);
  if (one !== null && request.method === "DELETE") {
    if (!isUlid(one[1])) return error("not a reminder id");
    return await reminders.remove(one[1].toUpperCase())
      ? new Response(null, { status: 204 })
      : error("no such reminder", 404);
  }
  return error("not found", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (cause) {
      if (cause instanceof BoundsError && cause.code === "too_large") {
        return Response.json({ error: "too_large" }, { status: 413 });
      }
      throw cause;
    }
  },
};
