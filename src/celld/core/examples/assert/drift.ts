// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration drift, found with `equals` and reported with `show`.
 *
 * `PUT /desired/<name>` stores the configuration a service should have, and
 * `POST /observed/<name>` reports what it actually has. The answer says
 * whether the two are equal and, when they are not, which top-level keys
 * differ, each side rendered by `show`.
 *
 * `equals` is structural: key order does not matter, list order does, and
 * byte arrays are compared byte by byte. Configurations here may carry
 * bytes, such as a pinned certificate hash, written as
 * `{"$bytes": "<base64>"}` and decoded before comparing; `show` writes them
 * back as lists of bytes.
 *
 * This is a local demo and is deliberately unauthenticated: any caller can
 * read the drift report for any name and overwrite (or create) the desired
 * state it is compared with, and every name adds a KV entry. A deployment
 * puts both routes behind authentication (see `@celld/web/router`) and would
 * let only the owner of a service write its desired state. Bodies are read
 * up to 64 KiB (413 beyond) and parsed with depth and size caps.
 *
 * ```sh
 * buck2 run root//src/celld/core/examples/assert:drift-dev
 * curl -sS -X PUT localhost:9876/desired/api -d '{"replicas": 3, "regions": ["us", "eu"]}'
 * curl -sS -X POST localhost:9876/observed/api -d '{"regions": ["us", "eu"], "replicas": 2}'
 * ```
 *
 * @module
 */

import { equals, show } from "@celld/core/assert";
import {
  BoundsError,
  bytes,
  parseJsonBounded,
  readTextBounded,
} from "@celld/core/bounds";

interface Env {
  readonly DESIRED: KVNamespace;
}

const MAX_BODY_BYTES = 64 * 1024;

/** `{"$bytes": "<base64>"}` objects in parsed JSON, decoded to `Uint8Array`s. */
function decodeBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeBytes);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && typeof record.$bytes === "string") {
    return Uint8Array.from(atob(record.$bytes), (char) => char.charCodeAt(0));
  }
  return Object.fromEntries(keys.map((key) => [key, decodeBytes(record[key])]));
}

/**
 * JSON text, parsed under caps (at most 64 KiB, 16 levels deep, 256 keys per
 * object and 1000 items per list), with `$bytes` objects decoded.
 */
function revive(text: string): unknown {
  return decodeBytes(parseJsonBounded(text, {
    maxBytes: MAX_BODY_BYTES,
    maxDepth: 16,
    maxKeys: 256,
    maxItems: 1000,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !(value instanceof Uint8Array);
}

/**
 * A key's own value, or `undefined` when the object lacks it. A plain
 * `record[key]` would find `toString` or `valueOf` on the prototype.
 */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The top-level keys whose values differ, with both sides shown. */
function differences(desired: unknown, observed: unknown) {
  if (!isRecord(desired) || !isRecord(observed)) {
    return [{ key: "", desired: show(desired), observed: show(observed) }];
  }
  const keys = [...new Set([...Object.keys(desired), ...Object.keys(observed)])]
    .sort();
  return keys.filter((key) => !equals(own(desired, key), own(observed, key)))
    .map((key) => ({
      key,
      desired: show(own(desired, key)),
      observed: show(own(observed, key)),
    }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/(desired|observed)\/([\w-]+)$/.exec(
      new URL(request.url).pathname,
    );
    if (match === null) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const [, kind, name] = match;
    let text: string;
    try {
      text = await readTextBounded(request, {
        maxBytes: bytes(MAX_BODY_BYTES),
      });
    } catch (error) {
      if (error instanceof BoundsError && error.code === "too_large") {
        return Response.json({ error: "too_large" }, { status: 413 });
      }
      throw error;
    }
    let value: unknown;
    try {
      value = revive(text);
    } catch {
      return Response.json({ error: "expected JSON" }, { status: 400 });
    }
    if (kind === "desired" && request.method === "PUT") {
      await env.DESIRED.put(name, text);
      return new Response(null, { status: 204 });
    }
    if (kind === "observed" && request.method === "POST") {
      const stored = await env.DESIRED.get(name);
      if (stored === null) {
        return Response.json({ error: `no desired state for ${name}` }, {
          status: 404,
        });
      }
      const desired = revive(stored);
      return equals(desired, value)
        ? Response.json({ drift: false })
        : Response.json({
          drift: true,
          differences: differences(desired, value),
        });
    }
    return Response.json({ error: "method not allowed" }, { status: 405 });
  },
};
