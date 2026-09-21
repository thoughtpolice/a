// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Worker entry point: one JSON route per journal method.
 *
 * Dispatch is a closed switch over decoded calls, never a lookup of a method
 * name taken from the request, so no path can reach anything but the eight
 * documented operations. No route reaches a segment: they are the journal
 * cell's storage, reachable only through it. Each reply is the transition's
 * own result object, with the status code derived from it.
 *
 * @module
 */

import { Segment } from "@wormspace/segment";
import * as http from "@journal/http";
import { Journal } from "./journal.ts";
import { type AnyResult, type JournalAPI, LIMITS } from "@journal/types";

// The journal's links are wormspace segments, served by this same script
// under its own `SEGMENTS` binding: the journal's segment cells are a
// namespace of the journal deployment, never the wormspace one.
export { Journal, Segment };

export interface Env {
  JOURNAL: DurableObjectNamespace<JournalAPI>;
}

function json(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function invoke(
  stub: DurableObjectStub<JournalAPI>,
  call: http.Call,
): Promise<AnyResult> {
  switch (call.op) {
    case "status":
      return stub.status();
    case "acquireLease":
      return stub.acquireLease(call.request);
    case "renewLease":
      return stub.renewLease(call.request);
    case "releaseLease":
      return stub.releaseLease(call.request);
    case "append":
      return stub.append(call.request);
    case "read":
      return stub.read(call.request);
    case "recordSnapshot":
      return stub.recordSnapshot(call.request);
    case "trim":
      return stub.trim(call.request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = http.parseRoute(
      request.method,
      new URL(request.url).pathname,
    );
    if (!route.ok) {
      return json(
        { ok: false, code: route.code, message: route.message },
        route.status,
      );
    }

    let body: unknown = {};
    if (route.op !== "status") {
      // Refuse an oversized body on its declared length before reading it.
      const declared = Number(request.headers.get("content-length"));
      if (declared > LIMITS.bodyBytes) {
        return json({
          ok: false,
          code: "TOO_LARGE",
          message: `body exceeds ${LIMITS.bodyBytes} bytes`,
        }, 413);
      }
      const parsed = http.parseBody(await request.text());
      if (!parsed.ok) return json(parsed, http.httpStatus(parsed));
      body = parsed.body;
    }

    const decoded = http.decodeRequest(route.op, body);
    if (!decoded.ok) return json(decoded, http.httpStatus(decoded));

    try {
      const result = await invoke(
        env.JOURNAL.getByName(route.name),
        decoded.call,
      );
      return json(http.encodeResult(result), http.httpStatus(result));
    } catch (error) {
      // A cell whose owner is changing, or a write the fleet could not prove
      // durable, is celld telling the client to ask again; anything else
      // thrown here is a bug and must not be dressed up as retryable.
      const cause = http.retryableCause(error);
      if (cause !== null) {
        return json(
          { ok: false, code: "UNAVAILABLE", message: cause },
          503,
          { "retry-after": "1" },
        );
      }
      console.error("journal request failed", error);
      return json(
        { ok: false, code: "INTERNAL", message: "internal error" },
        500,
      );
    }
  },
};
