// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Webhook dispatch on a discriminated union.
 *
 * `POST /events` takes one event or a list of them: the body is
 * `v.union([Event, Batch])`, and each event is one option of `Event`, a
 * `v.discriminatedUnion` on `type`:
 * the tag picks the option to check, so an order event with a bad total
 * reports the total (not "matched none of four shapes"), and an unknown
 * `type` reports the tags there are, even through the outer union: the
 * union reports the option that got furthest. Once parsed, `switch (event.type)`
 * narrows the value to that option's type, so each handler sees exactly
 * its own fields.
 *
 * A batch is all or nothing: if any event is invalid, none is handled, and
 * the 400 lists every issue with its path into the batch
 * (`[1].total.amount`, from `formatPath`). `Accept: text/plain` gets
 * `SieveError.format()` instead, one `path: message` line per issue.
 *
 * A few schema features along the way: currency codes are upper-cased
 * before their length check, an unknown refund `reason` falls back to
 * `other` with `.catch()`, and `ping` and `test` share one option through a
 * `v.enum` tag.
 *
 * ```sh
 * buck2 run root//src/celld/sieve/examples:webhooks-dev
 * curl -sS -X POST localhost:9876/events -d '{"type": "ping"}'
 * curl -sS -X POST localhost:9876/events -d '[{"type": "ping"}, {"type": "test"}]'
 * ```
 *
 * @module
 */

import { formatPath, type Infer, SieveError, v } from "@celld/sieve";

const At = v.iso.datetime({ offset: true });

const Money = v.strictObject({
  amount: v.int().nonnegative(),
  currency: v.string().toUpperCase().length(3),
});

const Event = v.discriminatedUnion("type", [
  v.object({
    type: v.literal("order.created"),
    order: v.ulid(),
    at: At,
    items: v.array(v.object({
      sku: v.string().regex(/^[A-Z]{3}-\d{4}$/, "expected a SKU like ABC-1234"),
      quantity: v.int().positive(),
    })).nonempty(),
    total: Money,
  }),
  v.object({
    type: v.literal("order.refunded"),
    order: v.ulid(),
    at: At,
    amount: Money,
    reason: v.enum(["damaged", "late", "duplicate", "other"]).catch("other"),
  }),
  v.object({
    type: v.literal("customer.deleted"),
    customer: v.uuid(),
    at: At,
  }),
  v.object({ type: v.enum(["ping", "test"]) }),
]);

type Event = Infer<typeof Event>;

const Batch = v.array(Event).min(1).max(100);

const Body = v.union([Event, Batch], "expected an event or a list of events");

function money({ amount, currency }: Infer<typeof Money>): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/** Each case sees only its option's fields. */
function handle(event: Event): string {
  switch (event.type) {
    case "order.created":
      return `order ${event.order}: ${event.items.length} line(s), ${
        money(event.total)
      }`;
    case "order.refunded":
      return `refund on ${event.order}: ${
        money(event.amount)
      } (${event.reason})`;
    case "customer.deleted":
      return `erase customer ${event.customer}`;
    case "ping":
    case "test":
      return event.type === "ping" ? "pong" : "test received";
  }
}

function invalid(error: SieveError, request: Request): Response {
  if (request.headers.get("accept") === "text/plain") {
    return new Response(error.format(), { status: 400 });
  }
  return Response.json({
    issues: error.issues.map((issue) => ({
      path: formatPath(issue.path),
      code: issue.code,
      message: issue.message,
      ...(issue.code === "invalid_union" && issue.options !== undefined
        ? { options: issue.options }
        : {}),
    })),
  }, { status: 400 });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/events") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const parsed = Body.safeParse(
      await request.json().catch(() => undefined),
    );
    if (!parsed.success) return invalid(parsed.error, request);
    const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    return Response.json({ handled: events.map(handle) });
  },
};
