// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Duration arithmetic over HTTP with `Temporal.Duration`, and where a
 * duration needs a date.
 *
 * Days, hours, minutes and seconds have fixed lengths without a date (a
 * day is 24 hours), so `Duration.total` measures them alone. Years, months
 * and weeks are calendar units: they need the moment they start at, and
 * the same `P1M` is 29 days from January 31, 2024, and 30 from April 1.
 * `@celld/isotime` only checks the text; `Temporal` does the arithmetic.
 *
 * - `GET /durations/<text>` parses a duration and returns its non-zero
 *   components, its length when it has a fixed one, and the balanced text
 *   for that length; with calendar units, `?anchor=<date-time>` gives it
 *   one.
 * - `POST /add` with `{"start", "duration", "zone"?}` returns the end.
 * - `POST /between` with `{"start", "end"}` returns the duration between.
 * - `POST /series` with `{"start", "every", "count", "zone"?}` lists the
 *   dates of a repeating schedule. The n-th date is `start` plus `n` times
 *   `every`, not the previous date plus `every`: from January 31 monthly,
 *   that keeps March 31 after February 29, where chaining would drift to
 *   the 29th for good.
 *
 * Date-times must carry a zone and are answered in UTC. Arithmetic runs in
 * UTC unless `zone` names an IANA time zone, where a day is a calendar day
 * (23 or 25 hours across a daylight-saving change).
 *
 * ```sh
 * buck2 run root//src/celld/isotime/examples:durations-dev
 * curl -sS localhost:9876/durations/PT1H30M
 * curl -sS -X POST localhost:9876/series \
 *   -d '{"start": "2024-01-31T00:00:00Z", "every": "P1M", "count": 4}'
 * ```
 *
 * @module
 */

import { parseDateTime, parseDuration } from "@celld/isotime";

class BadInput extends Error {}

const UNITS = [
  "years",
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "seconds",
  "milliseconds",
  "microseconds",
  "nanoseconds",
] as const;

function instant(name: string, text: unknown): Temporal.Instant {
  const parsed = typeof text === "string"
    ? parseDateTime(text, { offset: true })
    : null;
  if (parsed === null) {
    throw new BadInput(`${name} is not an RFC 3339 date-time with a zone`);
  }
  return parsed;
}

function duration(name: string, text: unknown): Temporal.Duration {
  const parsed = typeof text === "string" ? parseDuration(text) : null;
  if (parsed === null) {
    throw new BadInput(`${name} is not an ISO 8601 duration`);
  }
  return parsed;
}

function zoned(
  at: Temporal.Instant,
  zone: unknown,
): Temporal.ZonedDateTime {
  if (zone === undefined) return at.toZonedDateTimeISO("UTC");
  try {
    if (typeof zone === "string") return at.toZonedDateTimeISO(zone);
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
  }
  throw new BadInput(`zone is not a time zone: ${zone}`);
}

/** The non-zero components, as numbers. */
function components(d: Temporal.Duration): Record<string, number> {
  return Object.fromEntries(
    UNITS.filter((unit) => d[unit] !== 0).map((unit) => [unit, d[unit]]),
  );
}

/** `n` times a duration, component by component. */
function times(d: Temporal.Duration, n: number): Temporal.Duration {
  return Temporal.Duration.from(
    Object.fromEntries(UNITS.map((unit) => [unit, d[unit] * n])),
  );
}

function describe(text: string, anchor: string | null): Response {
  const parsed = duration("the path", text);
  const calendar = parsed.years !== 0 || parsed.months !== 0 ||
    parsed.weeks !== 0;
  if (calendar && anchor === null) {
    return Response.json({
      components: components(parsed),
      ms: null,
      note: "years, months and weeks have no fixed length; give an anchor",
    });
  }
  const relativeTo = anchor === null
    ? undefined
    : zoned(instant("anchor", anchor), undefined);
  const ms = parsed.total({ unit: "milliseconds", relativeTo });
  return Response.json({
    components: components(parsed),
    ms,
    exact: parsed.round({ largestUnit: "days", relativeTo }).toString(),
  });
}

function route(method: string, path: string, body: Record<string, unknown>) {
  if (method === "POST" && path === "/add") {
    const start = zoned(instant("start", body.start), body.zone);
    const end = start.add(duration("duration", body.duration));
    return { end: end.toInstant().toString() };
  }
  if (method === "POST" && path === "/between") {
    const start = instant("start", body.start);
    const end = instant("end", body.end);
    if (Temporal.Instant.compare(end, start) < 0) {
      throw new BadInput("end is before start");
    }
    const between = zoned(start, undefined).until(zoned(end, undefined), {
      largestUnit: "days",
    });
    return {
      duration: between.toString(),
      ms: end.epochMilliseconds - start.epochMilliseconds,
    };
  }
  if (method === "POST" && path === "/series") {
    const start = zoned(instant("start", body.start), body.zone);
    const every = duration("every", body.every);
    const count = body.count;
    if (
      !Number.isInteger(count) || (count as number) < 1 ||
      (count as number) > 100
    ) {
      throw new BadInput("count is an integer from 1 to 100");
    }
    return {
      dates: Array.from(
        { length: count as number },
        (_, n) => start.add(times(every, n)).toInstant().toString(),
      ),
    };
  }
  return null;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname.startsWith("/durations/")) {
        return describe(
          decodeURIComponent(url.pathname.slice("/durations/".length)),
          url.searchParams.get("anchor"),
        );
      }
      const body = request.method === "POST"
        ? await request.json().catch(() => ({})) as Record<string, unknown>
        : {};
      const answer = route(request.method, url.pathname, body);
      return answer === null
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json(answer);
    } catch (error) {
      if (error instanceof BadInput) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      // Temporal's own RangeError: a result past its range.
      if (error instanceof RangeError) {
        return Response.json({ error: "out of range" }, { status: 400 });
      }
      throw error;
    }
  },
};
