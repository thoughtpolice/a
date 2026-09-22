// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Worker entry point: one JSON route per segment method, and the WormLog
 * and WormPaxos routes over them.
 *
 * Dispatch is a closed switch over decoded calls, never a lookup of a method
 * name taken from the request, so no path can reach anything but the
 * documented operations. Each reply is the operation's own result object,
 * with the status code derived from it.
 *
 * WormLog runs here, in the Worker: `wormlog.ts` over the log's `Sequencer`
 * cell and its segments. WormPaxos runs in the `Replica` cell the route names,
 * which calls the segments itself.
 *
 * @module
 */

import * as http from "@wormspace/segment/http";
import * as layers from "@wormspace/layers/layers_http";
import { Replica } from "./replica.ts";
import type { ReplicaAPI } from "@wormspace/layers/replica_core";
import { Segment } from "@wormspace/segment";
import { Sequencer } from "./sequencer.ts";
import type { SequencerAPI } from "@wormspace/layers/sequencer_core";
import {
  type AnyResult,
  LIMITS,
  type SegmentAPI,
} from "@wormspace/segment/types";
import { WormLog } from "@wormspace/layers/wormlog";

export { Replica, Segment, Sequencer };

export interface Env {
  SEGMENTS: DurableObjectNamespace<SegmentAPI>;
  SEQUENCERS: DurableObjectNamespace<SequencerAPI>;
  REPLICAS: DurableObjectNamespace<ReplicaAPI>;
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

/** Reads a JSON body under the cap, or the response refusing it. */
async function readBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  // Refuse an oversized body on its declared length before reading it.
  const declared = Number(request.headers.get("content-length"));
  if (declared > LIMITS.bodyBytes) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "TOO_LARGE",
        message: `body exceeds ${LIMITS.bodyBytes} bytes`,
      }, 413),
    };
  }
  const parsed = http.parseBody(await request.text());
  if (!parsed.ok) {
    return { ok: false, response: json(parsed, http.httpStatus(parsed)) };
  }
  return { ok: true, body: parsed.body };
}

/**
 * A thrown error. A cell whose owner is changing, or a write the fleet could
 * not prove durable, is celld telling the client to ask again (503); anything
 * else thrown here is a bug and must not be dressed up as retryable (500).
 */
function failure(error: unknown, what: string): Response {
  const cause = http.retryableCause(error);
  if (cause !== null) {
    return json(
      { ok: false, code: "UNAVAILABLE", message: cause },
      503,
      { "retry-after": "1" },
    );
  }
  console.error(`${what} request failed`, error);
  return json({ ok: false, code: "INTERNAL", message: "internal error" }, 500);
}

function invoke(
  stub: DurableObjectStub<SegmentAPI>,
  call: http.Call,
): Promise<AnyResult> {
  switch (call.op) {
    case "status":
      return stub.status();
    case "alloc":
      return stub.alloc(call.request);
    case "capture":
      return stub.capture(call.request);
    case "write":
      return stub.write(call.request);
    case "read":
      return stub.read(call.request);
    case "trim":
      return stub.trim(call.request);
    case "listen":
      return stub.listen(call.request);
  }
}

function invokeLog(env: Env, log: string, call: layers.LogCall) {
  const wormlog = new WormLog(
    env.SEQUENCERS.getByName(log),
    (name) => env.SEGMENTS.getByName(name),
    log,
  );
  switch (call.op) {
    case "init":
      return wormlog.init(call.size);
    case "append":
      return wormlog.append(call.value);
    case "read":
      return wormlog.read(call.request);
    case "tail":
      return wormlog.tail();
    case "fill":
      return wormlog.fill(call.slot);
    case "trim":
      return wormlog.trim(call.through);
    case "listen":
      return wormlog.listen(call.request);
  }
}

function invokePaxos(
  env: Env,
  smr: string,
  replica: string,
  call: layers.PaxosCall,
) {
  const stub = env.REPLICAS.getByName(`${smr}.${replica}`);
  // The route names the replica; the body cannot redirect it.
  const request = { ...call.fields, smr, replica };
  switch (call.op) {
    case "init":
      return stub.init(request as Parameters<ReplicaAPI["init"]>[0]);
    case "propose":
      return stub.propose(request as Parameters<ReplicaAPI["propose"]>[0]);
    case "learn":
      return stub.learn(request);
    case "get":
      return stub.lookup(request as Parameters<ReplicaAPI["lookup"]>[0]);
    case "state":
      return stub.state(request);
  }
}

async function layer(
  route: Extract<layers.LayerRoute, { ok: true }>,
  request: Request,
  env: Env,
): Promise<Response> {
  const read = await readBody(request);
  if (!read.ok) return read.response;
  try {
    let result: { ok: boolean; code?: string };
    if (route.layer === "wormlog") {
      const decoded = layers.decodeLogRequest(route.op, read.body);
      if (!decoded.ok) return json(decoded, layers.layerStatus(decoded));
      result = await invokeLog(env, route.log, decoded.call);
    } else {
      const decoded = layers.decodePaxosRequest(route.op, read.body);
      if (!decoded.ok) return json(decoded, layers.layerStatus(decoded));
      result = await invokePaxos(env, route.smr, route.replica, decoded.call);
    }
    const status = layers.layerStatus(result);
    return json(
      layers.encodeLayerResult(result),
      status,
      status === 503 ? { "retry-after": "1" } : {},
    );
  } catch (error) {
    return failure(error, route.layer);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const routed = layers.parseLayerRoute(request.method, pathname);
    if (routed !== null) {
      if (!routed.ok) {
        return json(
          { ok: false, code: routed.code, message: routed.message },
          routed.status,
        );
      }
      return layer(routed, request, env);
    }

    const route = http.parseRoute(request.method, pathname);
    if (!route.ok) {
      return json(
        { ok: false, code: route.code, message: route.message },
        route.status,
      );
    }

    let body: unknown = {};
    if (route.op !== "status") {
      const read = await readBody(request);
      if (!read.ok) return read.response;
      body = read.body;
    }

    const decoded = http.decodeRequest(route.op, body);
    if (!decoded.ok) return json(decoded, http.httpStatus(decoded));

    try {
      const result = await invoke(
        env.SEGMENTS.getByName(route.name),
        decoded.call,
      );
      return json(http.encodeResult(result), http.httpStatus(result));
    } catch (error) {
      return failure(error, "segment");
    }
  },
};
