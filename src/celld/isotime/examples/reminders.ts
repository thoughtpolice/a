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
 * `@celld/isotime` only decides what text is acceptable: strict RFC 3339
 * (no `2023-02-29`, no leap seconds, no `[Europe/Paris]` annotations) and
 * ISO 8601 durations. `Temporal` does everything else. The answer gives
 * the due time in UTC and as `local`, in the zone (or offset) the caller
 * used.
 *
 * Reminders live in one `Reminders` Durable Object, keyed by a ULID minted
 * at the due time, so listing them in key order lists them by due time. The
 * object's alarm fires at the next due time (or in a day, whichever is
 * sooner) and marks what is due.
 *
 * - `GET /reminders` lists them with `local` and `fired`.
 * - `DELETE /reminders/<id>` removes one.
 *
 * ```sh
 * buck2 run root//src/celld/isotime/examples:reminders-dev
 * curl -sS -X POST localhost:9876/reminders -d '{"text": "stretch", "in": "PT15M"}'
 * curl -sS -X POST localhost:9876/reminders \
 *   -d '{"text": "call", "at": "2030-01-01T09:00:00", "zone": "Europe/Paris"}'
 * curl -sS localhost:9876/reminders
 * ```
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { parseDateTime, parseDuration } from "@celld/isotime";
import { decodeTime, encodeTime, isUlid, ulid } from "@celld/ulid";

const DAY_MS = 86_400_000;

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
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, text TEXT NOT NULL, zone TEXT NOT NULL, fired INTEGER NOT NULL DEFAULT 0)",
    );
  }

  async add(text: string, due: number, zone: string): Promise<string> {
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
      fired: fired === 1,
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
    const bound = encodeTime(Date.now() + 1);
    this.ctx.storage.sql.exec(
      "UPDATE reminders SET fired = 1 WHERE fired = 0 AND id < ?",
      bound,
    );
    await this.#schedule();
  }

  async #schedule(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM reminders WHERE fired = 0 ORDER BY id LIMIT 1",
    ).toArray()[0];
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // celld 0.5.1 panics on an alarm set years ahead ("invalid deadline"),
    // so a distant reminder is reached by waking once a day until it is due.
    await this.ctx.storage.setAlarm(
      Math.min(decodeTime(next.id), Date.now() + DAY_MS),
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

async function add(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (typeof body.text !== "string" || body.text === "") {
    return error("expected {text, in | at, from?, zone?}");
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
  const id = await env.REMINDERS.getByName("default").add(
    body.text,
    ms,
    due.timeZoneId,
  );
  return Response.json({
    id,
    text: body.text,
    due: utc(ms),
    local: local(ms, due.timeZoneId),
  }, { status: 201 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
  },
};
