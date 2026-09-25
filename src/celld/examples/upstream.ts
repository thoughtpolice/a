// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/examples/upstream`: the host for an example's fake upstream.
 *
 * An example Worker talks to a real service (TypeSafe, exe.dev, a Codex
 * backend). Its test points it at a fake instead: a small Deno program on
 * loopback that wraps the library's own test double (`FakeExe`,
 * `FakeResponses`, ...) in {@link serveUpstream}. The host adds what the
 * harness needs around it:
 *
 * - it listens on a kernel-chosen loopback port and prints one JSON line,
 *   `{"upstream": origin, "vars": {...}}`, where `vars` are the Worker
 *   variables that point the library at the fake (`OPENAI_BASE_URL`, a key
 *   the fake accepts, ...); the harness writes them into `.dev.vars`;
 * - it records every request (method, path, host, headers, body) and serves
 *   them from `GET /__upstream/requests?since=N`, so a spec can check what
 *   the Worker actually sent;
 * - it hands `POST /__upstream/script` bodies to {@link Upstream.script}, so a
 *   spec can queue the next answers or inject a fault before a request.
 *
 * ```ts
 * import { serveUpstream } from "@celld/examples/upstream";
 *
 * const fake = new FakeResponses();
 * serveUpstream({
 *   fetch: (request) => fake.fetch(request.url, { method: request.method, body: ... }),
 *   script: (step) => void fake.push(step as TurnSpec),
 *   vars: (origin) => ({ OPENAI_BASE_URL: `${origin}/openai/v1` }),
 * });
 * ```
 *
 * The harness starts the program built by `celld_example_upstream` (see
 * `src/celld/examples/defs.bzl`) with a scratch directory it owns as the
 * only argument ({@link scratchDirectory}), and stops it after the test.
 *
 * @module
 */

/** A fake service the harness can drive. */
export interface Upstream {
  /** Answers one request from the Worker. */
  fetch(request: Request): Response | Promise<Response>;
  /** Applies one `script` entry from the spec, such as queueing an answer. */
  script?(instruction: unknown): void | Promise<void>;
  /** The Worker variables that point the library at `origin`. */
  vars?(origin: string): Record<string, string>;
}

/** One request the Worker made, as `GET /__upstream/requests` returns it. */
export interface RecordedRequest {
  readonly method: string;
  /** The path and query. */
  readonly path: string;
  /** The `Host` header, which tells integration hosts on `*.localhost` apart. */
  readonly host: string;
  /** Lower-cased names. */
  readonly headers: Record<string, string>;
  /** The body as text, `""` for none. */
  readonly text: string;
  /** The body parsed as JSON; absent when it is not JSON. */
  readonly json?: unknown;
}

const CONTROL = "/__upstream/";

/** The directory the harness gave this fake for its own files. */
export function scratchDirectory(): string {
  const directory = Deno.args[0];
  if (directory === undefined || directory === "") {
    throw new Error("the harness passes a scratch directory as argument 1");
  }
  return directory;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function record(request: Request): Promise<RecordedRequest> {
  const url = new URL(request.url);
  const text = await request.clone().text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => headers[name] = value);
  let parsed: { json?: unknown } = {};
  if (text !== "") {
    try {
      parsed = { json: JSON.parse(text) };
    } catch {
      // Not JSON: the text is all there is.
    }
  }
  return {
    method: request.method,
    path: url.pathname + url.search,
    host: headers.host ?? url.host,
    headers,
    text,
    ...parsed,
  };
}

async function control(
  upstream: Upstream,
  requests: readonly RecordedRequest[],
  request: Request,
  url: URL,
): Promise<Response> {
  const route = `${request.method} ${url.pathname.slice(CONTROL.length)}`;
  if (route === "GET requests") {
    return json(requests.slice(Number(url.searchParams.get("since") ?? 0)));
  }
  if (route === "POST script") {
    if (upstream.script === undefined) {
      return json({ error: "this upstream takes no script" }, 400);
    }
    try {
      await upstream.script(await request.json());
    } catch (error) {
      return json({ error: String(error) }, 400);
    }
    return json({ ok: true });
  }
  return json({ error: `no control route ${route}` }, 404);
}

/**
 * Serves `upstream` on `127.0.0.1` until the process is killed, printing
 * the ready line described in the module notes once it listens.
 */
export function serveUpstream(upstream: Upstream): void {
  const requests: RecordedRequest[] = [];
  Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen({ port }) {
      const origin = `http://127.0.0.1:${port}`;
      console.log(
        JSON.stringify({
          upstream: origin,
          vars: upstream.vars?.(origin) ?? {},
        }),
      );
    },
  }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith(CONTROL)) {
      return await control(upstream, requests, request, url);
    }
    requests.push(await record(request));
    try {
      return await upstream.fetch(request);
    } catch (error) {
      console.error(`upstream: ${request.method} ${url.pathname}:`, error);
      return json({ error: `the fake upstream threw: ${error}` }, 500);
    }
  });
}
