// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  parseJsonBounded,
  readTextBounded,
  strictRecord,
  utf8Length,
} from "@celld/core/bounds";
import { Sandbox } from "@celld/box/sandbox/durable";
import { bridgeSockets } from "./bridge.ts";

const PORT = 9222;
const CLOSED = "browser:closed";
const STARTED = "browser:started";
const SOCKET = "browser:socket";

// celld cannot splice an outbound container socket into an inbound
// upgrade by returning it directly: their host writer registrations collide.
// An accepted WebSocketPair gives ingress a distinct server-side endpoint.
function bridge(upstream: WebSocket, signal: AbortSignal): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const close = bridgeSockets(server, upstream, signal);
  try {
    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    close();
    throw error;
  }
}

/** Disposable test browser. Bind ONLY to the package's trusted runsc image. */
export class BrowserSandbox extends Sandbox {
  override settings = {
    tier: "hostile" as const,
    execTimeout: "30s",
    maxExecTimeout: "1m",
  };
  override sleepAfter = "5m";
  // No Internet: fixture HTTP and Chromium's debugging socket are guest-local.
  override enableInternet = false;
  #opening?: Promise<string>;
  #closing = false;
  #lifetime = new AbortController();

  open(html: string): Promise<string> {
    if (typeof html !== "string" || utf8Length(html) > 65_536) {
      throw new TypeError("invalid browser fixture HTML");
    }
    if (
      this.#closing || this.ctx.storage.kv.get(CLOSED) ||
      this.ctx.storage.kv.get(STARTED)
    ) {
      throw new Error("browser fixture is single-use");
    }
    this.ctx.storage.kv.put(STARTED, true);
    this.#opening = this.#launch(html);
    return this.#opening;
  }

  #checkOpen(): void {
    if (this.#closing || this.ctx.storage.kv.get(CLOSED)) {
      throw new Error("browser fixture closed");
    }
  }

  async #launch(html: string): Promise<string> {
    // writeFile runs hostile-tier preparation before any browser code starts.
    await this.writeFile("site/index.html", html);
    this.#checkOpen();
    await this.startProcess(["/usr/local/bin/celld-browser"], {
      name: "browser",
      timeoutMs: 300_000,
    });
    this.#checkOpen();
    await this.waitForPort(PORT, { path: "/json/version", timeoutMs: 30_000 });
    this.#checkOpen();
    const discoveryDeadline = AbortSignal.any([
      this.#lifetime.signal,
      AbortSignal.timeout(5_000),
    ]);
    const response = await this.containerFetch(
      "http://127.0.0.1:9222/json/version",
      { signal: discoveryDeadline },
      PORT,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("browser CDP discovery failed");
    }
    const info = parseJsonBounded(
      await readTextBounded(response, {
        maxBytes: 16_384,
        signal: discoveryDeadline,
      }),
      {
        maxDepth: 3,
        maxKeys: 32,
        maxItems: 32,
        maxBytes: 16_384,
      },
    ) as Record<string, unknown>;
    if (typeof info.webSocketDebuggerUrl !== "string") {
      throw new Error("browser CDP endpoint missing");
    }
    const url = new URL(info.webSocketDebuggerUrl);
    if (
      url.protocol !== "ws:" ||
      !/^\/devtools\/browser\/[a-f0-9-]{36}$/.test(url.pathname) ||
      url.search || url.hash
    ) {
      throw new Error("invalid browser CDP endpoint");
    }
    this.#checkOpen();
    this.ctx.storage.kv.put(SOCKET, url.pathname);
    return url.pathname;
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (
      this.#closing || this.ctx.storage.kv.get(CLOSED) ||
      path !== this.ctx.storage.kv.get(SOCKET) ||
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.has("origin")
    ) {
      return new Response(null, { status: 404 });
    }
    // Exactly one upgrade attempt per fixture, including across isolate
    // restarts. A lost handshake is cleaned up by the owning host driver.
    this.ctx.storage.kv.delete(SOCKET);
    const headers = new Headers();
    for (
      const name of [
        "upgrade",
        "connection",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
      ]
    ) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const response = await this.containerFetch(
      new Request(`http://127.0.0.1:9222${path}`, {
        headers,
        signal: AbortSignal.any([
          this.#lifetime.signal,
          AbortSignal.timeout(10_000),
        ]),
      }),
      undefined,
      PORT,
    );
    if (response.status !== 101 || !response.webSocket) {
      await response.body?.cancel();
      return new Response(null, { status: 502 });
    }
    if (this.#closing || this.ctx.storage.kv.get(CLOSED)) {
      response.webSocket.close(1000, "fixture closed");
      return new Response(null, { status: 410 });
    }
    return bridge(response.webSocket, this.#lifetime.signal);
  }

  override async destroy(): Promise<void> {
    this.#closing = true;
    // Persist before the first await: an isolate restart must not reopen a
    // previously issued capability while destruction is still in progress.
    this.ctx.storage.kv.put(CLOSED, true);
    this.#lifetime.abort();
    try {
      await this.#opening?.catch(() => {});
      await super.destroy();
    } finally {
      // A DELETE racing ahead of POST permanently closes that random ID.
      this.ctx.storage.kv.put(CLOSED, true);
    }
  }

  fixtureState(): { closed: boolean; status: string } {
    return {
      closed: this.#closing || this.ctx.storage.kv.get(CLOSED) === true,
      status: this.getState().status,
    };
  }
}

function reply(status: number, data?: unknown): Response {
  return data === undefined
    ? new Response(null, {
      status,
      headers: { "cache-control": "private, no-store" },
    })
    : Response.json(data, {
      status,
      headers: { "cache-control": "private, no-store" },
    });
}

/**
 * LOCAL TEST CONTROL ONLY. Bind its Worker to loopback; token is a fresh random
 * secret supplied by the Buck runner. The websocket path is a 256-bit bearer
 * capability. No CORS, browser-origin clients, arbitrary ports or public routes.
 */
export async function handleBrowserFixture(
  request: Request,
  namespace: DurableObjectNamespace<BrowserSandbox>,
  token: string,
): Promise<Response> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    return reply(503);
  }
  if (request.headers.has("origin")) return reply(403);
  const url = new URL(request.url);
  const match =
    /^\/sessions\/([a-f0-9]{64})(\/devtools\/browser\/[a-f0-9-]{36})?$/.exec(
      url.pathname,
    );
  if (!match || url.search) return reply(404);
  const [, id, socketPath] = match;
  if (socketPath) {
    if (
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) return reply(404);
    const stub = namespace.getByName(id);
    return await stub.fetch(
      new Request(`http://browser.internal${socketPath}`, request),
    );
  }
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  let difference = supplied.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    difference |= expected.charCodeAt(i) ^ (supplied.charCodeAt(i) || 0);
  }
  if (difference !== 0) return reply(401);
  const stub = namespace.getByName(id);
  if (request.method === "DELETE") {
    await stub.destroy();
    return reply(204);
  }
  if (request.method === "GET") return reply(200, await stub.fixtureState());
  if (request.method !== "POST") return reply(405);
  let html: string;
  try {
    const body = parseJsonBounded(
      await readTextBounded(request, {
        maxBytes: 262_144,
        signal: AbortSignal.timeout(5_000),
      }),
      {
        maxDepth: 2,
        maxKeys: 1,
        maxItems: 1,
        maxBytes: 262_144,
      },
    );
    strictRecord(body, ["html"], "browser fixture request");
    if (typeof body.html !== "string" || utf8Length(body.html) > 65_536) {
      return reply(400);
    }
    html = body.html;
  } catch {
    return reply(400);
  }
  try {
    const path = await stub.open(html);
    return reply(201, {
      origin: "http://127.0.0.1:8080",
      webSocketPath: `/sessions/${id}${path}`,
    });
  } catch (error) {
    await stub.destroy();
    // Authenticated local test diagnostics only; no request URLs or credentials.
    return reply(500, {
      error: "browser_startup",
      detail: error instanceof Error
        ? error.message.slice(0, 2048)
        : "browser startup failed",
    });
  }
}
