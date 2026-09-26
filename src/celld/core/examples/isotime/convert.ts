// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Converting instants between zones with `Temporal`, and what strict
 * checking at the boundary adds to it.
 *
 * `POST /convert` with `{"at", "to"?, "precision"?}` reads a date-time with
 * a zone and writes it back in UTC and in `to`: `Z`, an RFC 3339 offset
 * (`±HH:MM`) or an IANA time zone. `precision` is the number of fractional
 * digits (-1 for minutes only, default 3). The instant keeps nanoseconds,
 * so `epochNanoseconds` has every digit the caller wrote.
 *
 * `POST /classify` with `{"values": [...]}` says what each string is under
 * `@celld/core/isotime`'s RFC 3339 profile: a `date`, a `time` (with or without
 * a zone), a `datetime` (zoned or local), a `duration`, or null. The
 * profile is strict: no lower-case `t` or `z`, no space for `T`, no
 * `24:00`, no leap seconds, no `+0200`.
 *
 * `POST /instants` with `{"values": [...]}` puts the same strings to
 * `Temporal.Instant.from` and to `parseDateTime`, showing what `Temporal`
 * alone would let through: annotations, six-digit years, missing colons.
 *
 * Bodies are read under a 16 KiB cap (413 above it), and a list holds at
 * most 100 values.
 *
 * ```sh
 * buck2 run root//src/celld/core/examples/isotime:convert-dev
 * curl -sS -X POST localhost:9876/convert \
 *   -d '{"at": "2026-09-25T10:15:30.25+02:00", "to": "Asia/Kolkata", "precision": 0}'
 * ```
 *
 * @module
 */

import {
  BoundsError,
  bytes,
  parseJsonBounded,
  readTextBounded,
} from "@celld/core/bounds";
import { isDate, isDuration, isTime, parseDateTime } from "@celld/core/isotime";

const MAX_BODY = bytes(16 * 1024);
const MAX_VALUES = 100;

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
      maxItems: 1_000,
    });
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch (cause) {
    if (cause instanceof BoundsError) return {};
    throw cause;
  }
}

function error(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * The time zone `to` names: UTC for `Z`, an offset only in RFC 3339's
 * `±HH:MM` form (Temporal also takes `+0530`), or an IANA name.
 */
function zoneOf(to: unknown): string | null {
  if (to === "Z") return "UTC";
  if (typeof to !== "string") return null;
  if (/^[+-]/.test(to) && !isTime(`00:00${to}`, { zone: "required" })) {
    return null;
  }
  try {
    return new Temporal.ZonedDateTime(0n, to).timeZoneId;
  } catch {
    return null;
  }
}

function convert(body: Record<string, unknown>): Response {
  const at = typeof body.at === "string"
    ? parseDateTime(body.at, { offset: true })
    : null;
  if (at === null) return error("at is not an RFC 3339 date-time with a zone");
  const zone = zoneOf(body.to ?? "Z");
  if (zone === null) return error("to is Z, ±HH:MM or an IANA time zone");
  const precision = body.precision ?? 3;
  if (
    typeof precision !== "number" || !Number.isInteger(precision) ||
    precision < -1 || precision > 9
  ) {
    return error("precision is -1 to 9");
  }
  const digits = precision < 0 ? { smallestUnit: "minute" as const } : {
    fractionalSecondDigits: precision as
      | 0
      | 1
      | 2
      | 3
      | 4
      | 5
      | 6
      | 7
      | 8
      | 9,
  };
  const there = at.toZonedDateTimeISO(zone);
  return Response.json({
    epochMs: at.epochMilliseconds,
    epochNanoseconds: String(at.epochNanoseconds),
    utc: at.toString(digits),
    converted: zone === "UTC" ? at.toString(digits) : there.toString({
      ...digits,
      timeZoneName: /^[+-]/.test(zone) ? "never" : "auto",
    }),
  });
}

function classify(text: string): string | null {
  if (isDate(text)) return "date";
  if (isTime(text, { zone: "any" })) return "time";
  const parsed = parseDateTime(text, { offset: true, local: true });
  if (parsed !== null) {
    return parsed instanceof Temporal.Instant ? "datetime" : "local datetime";
  }
  if (isDuration(text)) return "duration";
  return null;
}

function lenient(text: string): string | null {
  try {
    return Temporal.Instant.from(text).toString();
  } catch {
    return null;
  }
}

function strings(body: Record<string, unknown>): string[] | null {
  const values = body.values;
  return Array.isArray(values) && values.length <= MAX_VALUES &&
      values.every((v) => typeof v === "string")
    ? values
    : null;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    let body: Record<string, unknown>;
    try {
      body = await readObject(request);
    } catch (cause) {
      if (cause instanceof BoundsError && cause.code === "too_large") {
        return Response.json({ error: "too_large" }, { status: 413 });
      }
      throw cause;
    }
    if (pathname === "/convert") return convert(body);
    if (pathname === "/classify" || pathname === "/instants") {
      const values = strings(body);
      if (values === null) {
        return error(
          `expected {values: [string, ...]} with at most ${MAX_VALUES} values`,
        );
      }
      return Response.json(Object.fromEntries(values.map((value) => [
        value,
        pathname === "/classify" ? classify(value) : {
          strict: parseDateTime(value, { offset: true })?.toString() ?? null,
          temporal: lenient(value),
        },
      ])));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
