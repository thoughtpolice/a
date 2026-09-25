// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  API_CSP,
  bearer,
  HSTS,
  HTML_CSP,
  HttpError,
  router,
  RouterError,
} from "@celld/router";
import {
  assertHeader,
  assertMatch,
  assertStatus,
  call,
  recordingContext,
} from "./fixture.ts";

Deno.test("every response gets the security headers, 404s included", async () => {
  const app = router({ auth: "none" });
  app.get("/", (c) => c.json({ ok: true }));
  for (const path of ["/", "/missing"]) {
    const answer = await call(app, path);
    assertHeader(answer, "x-content-type-options", "nosniff");
    assertHeader(answer, "referrer-policy", "no-referrer");
    assertHeader(answer, "x-frame-options", "DENY");
    assertHeader(answer, "content-security-policy", API_CSP);
    assertHeader(answer, "strict-transport-security", HSTS);
  }
  assertEquals(API_CSP, "default-src 'none'; frame-ancestors 'none'");
  assertEquals(HSTS, "max-age=63072000; includeSubDomains");
});

Deno.test("HTML gets the conservative page CSP", async () => {
  const app = router({ auth: "none" });
  app.get("/", (c) => c.html("<p>hi</p>"));
  const answer = await call(app, "/");
  assertHeader(answer, "content-security-policy", HTML_CSP);
  assert(HTML_CSP.includes("frame-ancestors 'none'"), "no framing");
  assert(
    HTML_CSP.startsWith("default-src 'none'; script-src 'self'"),
    "self scripts only",
  );
});

Deno.test("HSTS only over https", async () => {
  const app = router({ auth: "none" });
  app.get("/", (c) => c.text("x"));
  assertHeader(
    await call(app, "/", { origin: "http://localhost:8080" }),
    "strict-transport-security",
    null,
  );
});

Deno.test("a handler's own headers win, and config can relax each default", async () => {
  const app = router({
    auth: "none",
    security: {
      frameOptions: "SAMEORIGIN",
      hsts: false,
      referrerPolicy: "strict-origin",
      csp: false,
    },
  });
  app.get(
    "/",
    (c) =>
      c.text("x", {
        headers: {
          "x-content-type-options": "custom",
          "content-security-policy": "own",
        },
      }),
  );
  app.get("/plain", (c) => c.text("x"));
  const answer = await call(app, "/");
  assertHeader(answer, "x-content-type-options", "custom");
  assertHeader(answer, "content-security-policy", "own");
  assertHeader(answer, "x-frame-options", "SAMEORIGIN");
  assertHeader(answer, "referrer-policy", "strict-origin");
  assertHeader(answer, "strict-transport-security", null);
  assertHeader(await call(app, "/plain"), "content-security-policy", null);
});

Deno.test("authenticated answers and 401/403 are no-store; anonymous ones are not", async () => {
  const app = router({
    auth: bearer({
      verify: ({ token }) => token === "t" ? { subject: "a" } : null,
    }),
  });
  app.get("/me", (c) => c.text(c.principal.subject));
  app.get(
    "/cached",
    (c) => c.text("x", { headers: { "cache-control": "private, max-age=60" } }),
  );
  app.get("/pub", { public: true }, (c) => c.text("pub"));
  const auth = { authorization: "Bearer t" };
  assertHeader(
    await call(app, "/me", { headers: auth }),
    "cache-control",
    "no-store",
  );
  assertHeader(await call(app, "/me"), "cache-control", "no-store");
  assertHeader(
    await call(app, "/cached", { headers: auth }),
    "cache-control",
    "private, max-age=60",
  );
  assertHeader(await call(app, "/pub"), "cache-control", null);
  assertHeader(
    await call(app, "/pub", { headers: auth }),
    "cache-control",
    "no-store",
  );
  const relaxed = router({
    auth: bearer({ verify: () => ({ subject: "a" }) }),
    security: { noStore: false },
  });
  relaxed.get("/", (c) => c.text("x"));
  assertHeader(
    await call(relaxed, "/", { headers: auth }),
    "cache-control",
    null,
  );
});

Deno.test("unhandled exceptions are opaque 500s with the request id, and are reported", async () => {
  const reported: [unknown, string][] = [];
  const ctx = recordingContext();
  const app = router({
    auth: "none",
    requestId: () => "01J8Z7Q3W5N4B6C0XKPM2R9T8V",
    onError: (error, c) => {
      reported.push([error, c.requestId]);
      return Promise.resolve();
    },
  });
  app.get("/boom", () => {
    throw new TypeError("secret connection string postgres://u:p@db");
  });
  const answer = await call(app, "/boom", { ctx });
  assertStatus(answer, 500);
  assertEquals(answer.json, {
    error: "internal_error",
    message: "internal error",
    requestId: "01J8Z7Q3W5N4B6C0XKPM2R9T8V",
  });
  assert(
    !answer.text.includes("postgres") && !answer.text.includes("TypeError"),
    "nothing leaks",
  );
  assertHeader(answer, "x-request-id", "01J8Z7Q3W5N4B6C0XKPM2R9T8V");
  assertEquals(reported.length, 1);
  assert(reported[0][0] instanceof TypeError, "the reporter gets the error");
  assertEquals(
    ctx.pending.length,
    1,
    "an async reporter is kept alive with waitUntil",
  );
});

Deno.test("a throwing reporter does not change the answer", async () => {
  const app = router({
    auth: "none",
    onError: () => {
      throw new Error("reporter broke");
    },
  });
  app.get("/", () => {
    throw new Error("x");
  });
  assertStatus(await call(app, "/"), 500);
});

Deno.test("HttpError answers with its status, message, code and headers", async () => {
  const reported: unknown[] = [];
  const app = router({ auth: "none", onError: (e) => void reported.push(e) });
  app.get("/limited", () => {
    throw new HttpError(429, "slow down", {
      headers: { "retry-after": "30" },
      details: { bucket: "b" },
    });
  });
  app.get("/hidden", () => {
    throw new HttpError(502, "upstream said: secret");
  });
  const limited = await call(app, "/limited");
  assertStatus(limited, 429);
  assertMatch(limited.json, {
    error: "too_many_requests",
    message: "slow down",
    bucket: "b",
  });
  assertHeader(limited, "retry-after", "30");
  const hidden = await call(app, "/hidden");
  assertStatus(hidden, 502);
  assertMatch(hidden.json, { error: "bad_gateway", message: "internal error" });
  assertEquals(reported.length, 1, "only the unexposed 5xx is reported");
});

Deno.test("request ids are ULIDs by default and differ per request", async () => {
  const app = router({ auth: "none" });
  app.get("/", (c) => c.text(c.requestId));
  const a = await call(app, "/");
  const b = await call(app, "/");
  assert(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(a.text), a.text);
  assert(a.text !== b.text, "unique");
  assertHeader(a, "x-request-id", a.text);
  const quiet = router({ auth: "none", requestIdHeader: false });
  quiet.get("/", (c) => c.text("x"));
  assertHeader(await call(quiet, "/"), "x-request-id", null);
});

Deno.test("oversized headers are a 431", async () => {
  const app = router({ auth: "none", limits: { headers: 256 } });
  app.get("/", (c) => c.text("x"));
  const answer = await call(app, "/", {
    headers: { "x-big": "a".repeat(300) },
  });
  assertStatus(answer, 431);
  assertMatch(answer.json, { error: "headers_too_large" });
});

Deno.test("the time budget answers 503 and aborts c.signal", async () => {
  const app = router({ auth: "none", limits: { timeout: 0.05 } });
  let aborted = false;
  app.get("/slow", (c) =>
    new Promise<Response>((resolve) => {
      c.signal.addEventListener("abort", () => {
        aborted = true;
        resolve(c.text("late"));
      });
    }));
  const answer = await call(app, "/slow");
  assertStatus(answer, 503);
  assertMatch(answer.json, { error: "timeout" });
  assert(aborted, "the signal fired");
});

function waitForAbort(c: { signal: AbortSignal; text(t: string): Response }) {
  return new Promise<Response>((resolve) => {
    c.signal.addEventListener("abort", () => {
      const reason = c.signal.reason as { name?: string; message?: string };
      resolve(c.text(`aborted: ${reason.name}: ${reason.message}`));
    });
  });
}

Deno.test("a route's timeout replaces the router's, and false turns it off", async () => {
  const strict = router({ auth: "none", limits: { timeout: 5 } });
  let routeAborted = false;
  strict.get(
    "/quick",
    { limits: { timeout: "PT0.02S" } },
    (c) =>
      new Promise<Response>((resolve) => {
        c.signal.addEventListener("abort", () => {
          routeAborted = true;
          resolve(c.text("late"));
        });
      }),
  );
  const started = Date.now();
  assertStatus(await call(strict, "/quick"), 503);
  assert(Date.now() - started < 2500, "the route's shorter budget applied");
  assert(routeAborted, "the signal fired");

  const app = router({ auth: "none", limits: { timeout: 0.05 } });
  const slow = async (
    c: { signal: AbortSignal; text(t: string): Response },
  ) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return c.text(`done, aborted ${c.signal.aborted}`);
  };
  app.get("/long", { limits: { timeout: 1 } }, slow);
  app.get("/forever", { limits: { timeout: false } }, slow);
  app.get("/default", slow);
  assertEquals((await call(app, "/long")).text, "done, aborted false");
  assertEquals((await call(app, "/forever")).text, "done, aborted false");
  assertStatus(await call(app, "/default"), 503);
});

Deno.test("a route's timeout counts from the start of the request", async () => {
  const app = router({ auth: "none" });
  app.use(async (_c, next) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return await next();
  });
  let ran = false;
  app.get("/", { limits: { timeout: 0.05 } }, (c) => {
    ran = true;
    return c.text("in time");
  });
  assertStatus(await call(app, "/"), 503);
  assert(!ran, "a route whose budget ran out before it matched does not run");
});

Deno.test("the router's timeout may be false", async () => {
  const app = router({ auth: "none", limits: { timeout: false } });
  app.get("/", async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return c.text("ok");
  });
  assertEquals((await call(app, "/")).text, "ok");
});

Deno.test("a returned stream is not cut off by the time budget", async () => {
  for (
    const app of [
      router({ auth: "none", limits: { timeout: 0.03 } }),
      router({ auth: "none" }),
    ]
  ) {
    let signal: AbortSignal | undefined;
    app.get("/events", { limits: { timeout: 0.03 } }, (c) => {
      signal = c.signal;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("one\n"));
          await new Promise((resolve) => setTimeout(resolve, 100));
          controller.enqueue(encoder.encode("two\n"));
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const answer = await call(app, "/events");
    assertStatus(answer, 200);
    assertEquals(answer.text, "one\ntwo\n");
    assertEquals(signal?.aborted, false);
  }
});

Deno.test("route timeouts are checked when the route is added", () => {
  const app = router({ auth: "none" });
  assertThrows(
    () => app.get("/", { limits: { timeout: "P1M" } }, (c) => c.text("x")),
    RouterError,
    "GET / limits.timeout",
  );
  assertThrows(
    () => app.get("/", { limits: { timeout: -1 } }, (c) => c.text("x")),
    RouterError,
    "timeout",
  );
});

Deno.test("c.signal aborts when the request's signal does, with its reason", async () => {
  const app = router({ auth: "none" });
  let started!: () => void;
  const running = new Promise<void>((resolve) => started = resolve);
  app.get("/wait", (c) => {
    started();
    return waitForAbort(c);
  });
  const controller = new AbortController();
  const pending = app.fetch(
    new Request("https://api.example.com/wait", { signal: controller.signal }),
  );
  await running;
  controller.abort(new DOMException("the client went away", "AbortError"));
  const answer = await pending;
  assertEquals(
    await answer.text(),
    "aborted: AbortError: the client went away",
  );
});

Deno.test("a request aborted before it is served has an aborted c.signal", async () => {
  const app = router({ auth: "none" });
  app.get("/", (c) => c.text(`aborted ${c.signal.aborted}`));
  const controller = new AbortController();
  controller.abort();
  const answer = await app.fetch(
    new Request("https://api.example.com/", { signal: controller.signal }),
  );
  assertEquals(await answer.text(), "aborted true");
});

Deno.test("with a request signal, the timeout still aborts c.signal with a TimeoutError", async () => {
  const app = router({ auth: "none", limits: { timeout: 0.03 } });
  let reason: unknown;
  app.get("/", (c) =>
    new Promise<Response>((resolve) => {
      c.signal.addEventListener("abort", () => {
        reason = c.signal.reason;
        resolve(c.text("late"));
      });
    }));
  const controller = new AbortController();
  const answer = await app.fetch(
    new Request("https://api.example.com/", { signal: controller.signal }),
  );
  assertEquals(answer.status, 503);
  assertEquals((reason as DOMException).name, "TimeoutError");
  assertEquals(controller.signal.aborted, false);
});

Deno.test("redirects stay on this origin unless asked", async () => {
  const app = router({ auth: "none" });
  app.get("/go", (c) => c.redirect(c.url.searchParams.get("next") ?? "/"));
  app.get(
    "/out",
    (c) => c.redirect("https://docs.example.org/x", 302, { external: true }),
  );
  const local = await call(app, "/go?next=/notes%3Fa%3D1");
  assertStatus(local, 302);
  assertHeader(local, "location", "/notes?a=1");
  assertStatus(await call(app, "/go?next=https://evil.example.com/"), 500);
  assertStatus(await call(app, "/go?next=//evil.example.com/"), 500);
  assertHeader(
    await call(app, "/out"),
    "location",
    "https://docs.example.org/x",
  );
});

Deno.test("c.setCookie uses safe defaults; c.header reaches error responses too", async () => {
  const app = router({ auth: "none", cookies: { sameSite: "Strict" } });
  app.get("/", (c) => {
    c.setCookie("theme", "dark");
    c.setCookie("lang", "en", { httpOnly: false, maxAge: "P1D" });
    c.header("x-trace", "t1");
    throw new HttpError(409, "conflict");
  });
  const answer = await call(app, "/");
  assertStatus(answer, 409);
  assertHeader(answer, "x-trace", "t1");
  assertEquals(
    answer.headers.getSetCookie(),
    [
      "theme=dark; Path=/; Secure; HttpOnly; SameSite=Strict",
      "lang=en; Max-Age=86400; Path=/; Secure; SameSite=Strict",
    ],
  );
});
