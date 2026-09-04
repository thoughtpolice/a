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
 * ```sh
 * buck2 run root//src/celld/assert/examples:drift-dev
 * curl -sS -X PUT localhost:9876/desired/api -d '{"replicas": 3, "regions": ["us", "eu"]}'
 * curl -sS -X POST localhost:9876/observed/api -d '{"regions": ["us", "eu"], "replicas": 2}'
 * ```
 *
 * @module
 */

import { equals, show } from "@celld/assert";

interface Env {
  readonly DESIRED: KVNamespace;
}

/** JSON with `{"$bytes": "<base64>"}` objects decoded to `Uint8Array`s. */
function revive(text: string): unknown {
  return JSON.parse(text, (_key, value) => {
    if (
      typeof value === "object" && value !== null &&
      Object.keys(value).length === 1 && typeof value.$bytes === "string"
    ) {
      return Uint8Array.from(atob(value.$bytes), (char) => char.charCodeAt(0));
    }
    return value;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !(value instanceof Uint8Array);
}

/** The top-level keys whose values differ, with both sides shown. */
function differences(desired: unknown, observed: unknown) {
  if (!isRecord(desired) || !isRecord(observed)) {
    return [{ key: "", desired: show(desired), observed: show(observed) }];
  }
  const keys = [...new Set([...Object.keys(desired), ...Object.keys(observed)])]
    .sort();
  return keys.filter((key) => !equals(desired[key], observed[key])).map((
    key,
  ) => ({
    key,
    desired: show(desired[key]),
    observed: show(observed[key]),
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
    const text = await request.text();
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
