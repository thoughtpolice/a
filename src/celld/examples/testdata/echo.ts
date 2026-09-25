// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The harness's own example. `POST /relay` forwards its body to the
 * upstream named by `ECHO_URL` and returns the answer with the upstream's
 * status; `PUT /notes/<key>` and `GET /notes/<key>` use a KV namespace, so a
 * restart step can show state surviving. `GET /stream` answers with
 * server-sent events. `GET /vars` returns the spec's variables as the Worker
 * got them, `ECHO_JWK` parsed, so a spec can check they arrive byte for
 * byte; `GET /cookies` sets two cookies.
 *
 * Run it: `buck2 run root//src/celld/examples:echo-dev`.
 *
 * @module
 */

interface Env {
  readonly ECHO_URL: string;
  readonly ECHO_JWK: string;
  readonly ECHO_TEXT: string;
  readonly NOTES: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/relay") {
      const answer = await fetch(env.ECHO_URL, {
        method: "POST",
        headers: { "x-relayed-by": "echo-example" },
        body: await request.text(),
      });
      return new Response(answer.body, {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }
    const note = url.pathname.match(/^\/notes\/([a-z0-9-]+)$/);
    if (note !== null && request.method === "PUT") {
      await env.NOTES.put(note[1], await request.text());
      return new Response(null, { status: 204 });
    }
    if (note !== null && request.method === "GET") {
      const value = await env.NOTES.get(note[1]);
      return value === null
        ? Response.json({ error: "no such note" }, { status: 404 })
        : Response.json({ key: note[1], value });
    }
    if (url.pathname === "/vars") {
      return Response.json({
        jwk: JSON.parse(env.ECHO_JWK),
        jwkText: env.ECHO_JWK,
        text: env.ECHO_TEXT,
      });
    }
    if (url.pathname === "/cookies") {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "first=1; Path=/; HttpOnly");
      headers.append("set-cookie", "second=2; Path=/; Secure");
      return new Response("two cookies", { headers });
    }
    if (url.pathname === "/stream") {
      const events = ["one", "two"].map((word, index) =>
        `event: word\ndata: ${JSON.stringify({ index, word })}\n\n`
      );
      return new Response(events.join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
