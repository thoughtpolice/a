// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import {
  boundedFetch,
  classifyHost,
  CROSS_ORIGIN_HEADERS,
  type EgressCode,
  EgressError,
  type EgressPolicy,
} from "@celld/http/egress";
import { bytes, millis } from "@celld/core/bounds";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly redirect: RequestRedirect | undefined;
  readonly signal: AbortSignal | undefined;
}

/** A `fetch` that answers from `handler` and records every call. */
function fake(
  handler: (url: string, call: Call) => Response | Promise<Response> = () =>
    new Response("ok"),
) {
  const calls: Call[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
      redirect: init?.redirect,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return Promise.resolve(handler(call.url, call));
  };
  return { fetch, calls };
}

function policy(overrides: Partial<EgressPolicy> = {}): EgressPolicy {
  return {
    allow: () => true,
    redirects: 5,
    timeoutMs: millis(1000),
    maxBytes: bytes(1024),
    network: "public",
    ...overrides,
  };
}

Deno.test("Daybreak egress configuration rejects typos and accessors before fetch", () => {
  for (
    const extra of [{ redirets: 1 }, {
      json: { maxDepth: 2, maxKeys: 4, maxItems: 4, maxByte: 8 },
    }, { budget: { fetches: 1, extra: true } }]
  ) {
    assertThrows(
      () => boundedFetch({ ...policy(), ...extra } as EgressPolicy),
      TypeError,
    );
  }
  let reads = 0;
  const options = {
    ...policy(),
    get network() {
      reads++;
      return "any" as const;
    },
  };
  assertThrows(() => boundedFetch(options), TypeError);
  assertEquals(reads, 0);
});

Deno.test("Daybreak a late response from a non-cooperative fetch is cancelled", async () => {
  const deferred = Promise.withResolvers<Response>();
  const abort = new AbortController();
  const get = boundedFetch(policy(), () => deferred.promise);
  const pending = get("https://example.com", { signal: abort.signal });
  abort.abort();
  await code(pending, "aborted");
  const cancelled = Promise.withResolvers<void>();
  deferred.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled.resolve();
        },
      }),
    ),
  );
  await cancelled.promise;
});

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

async function code(work: Promise<unknown>, expected: EgressCode) {
  const error = await assertRejects(() => work, EgressError);
  assertEquals(error.code, expected, error.message);
  return error;
}

Deno.test("literal hosts under each network mode", async () => {
  type Outcome = EgressCode | "ok";
  const table: [string, Outcome, Outcome, Outcome][] = [
    // url, public, loopback, any
    ["https://example.com/", "ok", "ok", "ok"],
    ["https://93.184.215.14/", "ok", "ok", "ok"],
    ["https://[2606:4700::1111]/", "ok", "ok", "ok"],
    ["https://127.0.0.1/", "network", "ok", "ok"],
    ["https://127.8.9.10/", "network", "ok", "ok"],
    ["https://0x7f.1/", "network", "ok", "ok"],
    ["https://[::1]/", "network", "ok", "ok"],
    ["https://[::ffff:127.0.0.1]/", "network", "ok", "ok"],
    ["https://localhost/", "network", "ok", "ok"],
    ["https://api.localhost./", "network", "ok", "ok"],
    // DB-REV-JWT-9: loopback aliases the host resolves locally, and any number
    // of trailing dots.
    ["https://localhost../", "network", "ok", "ok"],
    ["https://LOCALHOST.LOCALDOMAIN/", "network", "ok", "ok"],
    ["https://localhost6/", "network", "ok", "ok"],
    ["https://localhost6.localdomain6./", "network", "ok", "ok"],
    ["https://ip6-localhost/", "network", "ok", "ok"],
    ["https://ip6-loopback/", "network", "ok", "ok"],
    ["https://printer.local/", "network", "network", "ok"],
    ["https://db.internal/", "network", "network", "ok"],
    ["https://nas.home.arpa./", "network", "network", "ok"],
    ["https://box.localdomain/", "network", "network", "ok"],
    ["https://local.example.com/", "ok", "ok", "ok"],
    ["https://10.0.0.1/", "network", "network", "ok"],
    ["https://172.16.5.4/", "network", "network", "ok"],
    ["https://192.168.1.1/", "network", "network", "ok"],
    ["https://100.64.0.1/", "network", "network", "ok"],
    ["https://169.254.169.254/", "network", "network", "ok"],
    ["https://0.0.0.0/", "network", "network", "ok"],
    ["https://224.0.0.1/", "network", "network", "ok"],
    ["https://255.255.255.255/", "network", "network", "ok"],
    ["https://[::]/", "network", "network", "ok"],
    ["https://[fe80::1]/", "network", "network", "ok"],
    ["https://[fd00::1]/", "network", "network", "ok"],
    ["https://[ff02::1]/", "network", "network", "ok"],
    ["https://[::ffff:10.0.0.1]/", "network", "network", "ok"],
    ["https://[::ffff:169.254.169.254]/", "network", "network", "ok"],
    ["https://[64:ff9b::a00:1]/", "network", "network", "ok"],
    ["https://[2002:a00:1::]/", "network", "network", "ok"],
    // Cleartext needs allowCleartextLoopbackForDevelopment besides the
    // network (DB-SWP-F16-13.4); see the test below.
    ["http://127.0.0.1:8080/", "scheme", "scheme", "scheme"],
    ["http://[::1]:8080/", "scheme", "scheme", "scheme"],
    ["http://localhost:8080/", "scheme", "scheme", "scheme"],
    ["http://10.0.0.1/", "scheme", "scheme", "scheme"],
    ["http://example.com/", "scheme", "scheme", "scheme"],
  ];
  const modes = ["public", "loopback", "any"] as const;
  for (const [url, ...outcomes] of table) {
    for (const [index, network] of modes.entries()) {
      const { fetch, calls } = fake();
      const get = boundedFetch(policy({ network }), fetch);
      const expected = outcomes[index];
      const label = `${url} under ${network}`;
      if (expected === "ok") {
        const response = await get(url);
        assertEquals(await response.text(), "ok", label);
        assertEquals(calls.length, 1, label);
      } else {
        const error = await assertRejects(() => get(url), EgressError);
        assertEquals(error.code, expected, `${label}: ${error.message}`);
        assertEquals(calls.length, 0, `${label} reached fetch`);
      }
    }
  }
});

Deno.test("classifyHost", () => {
  assertEquals(classifyHost("example.com"), "name");
  assertEquals(classifyHost("8.8.8.8"), "public");
  assertEquals(classifyHost("[::1]"), "loopback");
  assertEquals(classifyHost("localhost"), "loopback");
  assertEquals(classifyHost("10.1.2.3"), "local");
  assertEquals(classifyHost("[fe80::1]"), "local");
  assertEquals(classifyHost("localhost..."), "loopback");
  assertEquals(classifyHost("localhost.localdomain"), "loopback");
  assertEquals(classifyHost("svc.cluster.internal"), "local");
  assertEquals(classifyHost("internal.example"), "name");
});

Deno.test("credentials, fragments and other schemes are refused", async () => {
  const { fetch, calls } = fake();
  const get = boundedFetch(policy({ network: "any" }), fetch);
  for (
    const url of [
      "https://user:pass@example.com/",
      "https://user@example.com/",
      "https://:pass@example.com/",
      "https://example.com/#top",
      "https://example.com/#",
      "not a url",
    ]
  ) {
    await code(get(url), "url");
  }
  for (
    const url of [
      "ftp://example.com/",
      "file:///etc/passwd",
      "data:text/plain,hi",
      "ws://127.0.0.1/",
    ]
  ) {
    await code(get(url), "scheme");
  }
  assertEquals(calls.length, 0);
});

Deno.test("allow must say yes, at every hop", async () => {
  const hops: [string, number][] = [];
  const { fetch, calls } = fake((url) =>
    url.endsWith("/a") ? redirect("https://example.com/b") : new Response("b")
  );
  const get = boundedFetch(
    policy({
      allow: (url, hop) => {
        hops.push([url.href, hop]);
        return url.pathname !== "/denied";
      },
    }),
    fetch,
  );
  assertEquals(await (await get("https://example.com/a")).text(), "b");
  assertEquals(hops, [["https://example.com/a", 0], [
    "https://example.com/b",
    1,
  ]]);
  await code(get("https://example.com/denied"), "denied");
  assertEquals(calls.length, 2);
  // Only `true` allows; a truthy value does not.
  const loose = boundedFetch(
    policy({ allow: (() => 1) as unknown as EgressPolicy["allow"] }),
    fetch,
  );
  await code(loose("https://example.com/b"), "denied");
});

Deno.test("a public URL redirecting to a private one is refused", async () => {
  for (
    const [target, expected] of [
      ["http://169.254.169.254/latest/meta-data/", "scheme"],
      ["https://169.254.169.254/latest/meta-data/", "network"],
      ["https://10.0.0.1/admin", "network"],
      ["https://[::ffff:127.0.0.1]/", "network"],
      ["https://localhost/", "network"],
      ["https://user:pw@example.org/", "url"],
    ] as const
  ) {
    const { fetch, calls } = fake(() => redirect(target));
    const get = boundedFetch(policy(), fetch);
    await code(get("https://example.com/"), expected);
    assertEquals(calls.length, 1, target);
  }
});

Deno.test("requests always go out with redirect: manual", async () => {
  const { fetch, calls } = fake();
  const get = boundedFetch(policy(), fetch);
  await (await get("https://example.com/", { redirect: "follow" })).discard();
  assertEquals(calls[0].redirect, "manual");
});

Deno.test("redirects: 0 refuses any redirect", async () => {
  const { fetch, calls } = fake(() => redirect("https://example.com/next"));
  const get = boundedFetch(policy({ redirects: 0 }), fetch);
  await code(get("https://example.com/"), "redirect");
  assertEquals(calls.length, 1);
  // A 3xx without Location is just a response.
  const plain = fake(() => new Response(null, { status: 304 }));
  const response = await boundedFetch(policy({ redirects: 0 }), plain.fetch)(
    "https://example.com/",
  );
  assertEquals(response.status, 304);
  await response.discard();
});

Deno.test("a redirect loop is refused", async () => {
  const { fetch, calls } = fake((url) =>
    redirect(url.endsWith("/a") ? "/b" : "/a")
  );
  const get = boundedFetch(policy({ redirects: 10 }), fetch);
  const error = await code(get("https://example.com/a"), "redirect");
  assert(error.message.includes("loop"), error.message);
  assertEquals(calls.length, 2);
});

Deno.test("the hop count is capped", async () => {
  let n = 0;
  const { fetch, calls } = fake(() => redirect(`/hop${++n}`, 307));
  const get = boundedFetch(policy({ redirects: 3 }), fetch);
  await code(get("https://example.com/"), "redirect");
  assertEquals(calls.length, 4);
  assertEquals(calls.map((call) => new URL(call.url).pathname), [
    "/",
    "/hop1",
    "/hop2",
    "/hop3",
  ]);
});

Deno.test("credentials are stripped on a cross-origin hop", async () => {
  const sensitive = {
    authorization: "Bearer secret",
    cookie: "session=1",
    "proxy-authorization": "Basic eA==",
    accept: "application/json",
  };
  const { fetch, calls } = fake((url) => {
    if (url === "https://a.example/start") {
      return redirect("https://a.example/same");
    }
    if (url === "https://a.example/same") {
      return redirect("https://b.example/other");
    }
    if (url === "https://b.example/other") {
      return redirect("https://a.example/back");
    }
    return new Response("done");
  });
  const get = boundedFetch(policy(), fetch);
  const response = await get("https://a.example/start", { headers: sensitive });
  assertEquals(await response.text(), "done");
  assertEquals(response.url, "https://a.example/back");
  assertEquals(response.redirected, true);
  const seen = calls.map((call) => [
    call.headers.get("authorization"),
    call.headers.get("cookie"),
    call.headers.get("proxy-authorization"),
    call.headers.get("accept"),
  ]);
  assertEquals(seen, [
    ["Bearer secret", "session=1", "Basic eA==", "application/json"],
    ["Bearer secret", "session=1", "Basic eA==", "application/json"],
    [null, null, null, "application/json"],
    // Once stripped they stay stripped, even back on the first origin.
    [null, null, null, "application/json"],
  ]);
});

Deno.test("303 becomes GET without a body; 307 keeps both", async () => {
  const { fetch, calls } = fake((url) => {
    if (url.endsWith("/see-other")) return redirect("/done", 303);
    if (url.endsWith("/temporary")) return redirect("/done", 307);
    return new Response("done");
  });
  const get = boundedFetch(policy(), fetch);
  const init = {
    method: "POST",
    body: "payload",
    headers: { "content-type": "text/plain" },
  };
  await (await get("https://example.com/see-other", init)).discard();
  assertEquals([calls[1].method, calls[1].body ?? null], ["GET", null]);
  assertEquals(calls[1].headers.get("content-type"), null);
  await (await get("https://example.com/temporary", init)).discard();
  assertEquals([calls[3].method, calls[3].body], ["POST", "payload"]);
  // A streamed body cannot be sent twice.
  const stream = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  await code(
    get("https://example.com/temporary", { method: "POST", body: stream }),
    "redirect",
  );
});

Deno.test("an endless body is aborted at the deadline", async () => {
  let cancelled = false;
  const { fetch } = fake(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x61]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    )
  );
  const get = boundedFetch(policy({ timeoutMs: millis(50) }), fetch);
  const started = Date.now();
  const response = await get("https://example.com/");
  await code(response.text(), "timeout");
  assert(Date.now() - started < 1000, "stopped near the deadline");
  assert(cancelled, "the body is cancelled");
});

Deno.test("a fetch that never answers times out", async () => {
  const get = boundedFetch(
    policy({ timeoutMs: millis(30) }),
    () => new Promise<Response>(() => {}),
  );
  await code(get("https://example.com/"), "timeout");
});

Deno.test("a chunked oversized body stops at the cap", async () => {
  let pulled = 0;
  let cancelled = false;
  const { fetch } = fake(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(256));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 }),
    )
  );
  const get = boundedFetch(policy({ maxBytes: bytes(1000) }), fetch);
  const response = await get("https://example.com/");
  assertEquals(response.headers.get("content-length"), null);
  await code(response.bytes(), "too_large");
  assertEquals(pulled, 4);
  assert(cancelled, "cancelled");
});

Deno.test("a body within the cap reads fully, once", async () => {
  const { fetch } = fake(() => new Response("x".repeat(1024)));
  const response = await boundedFetch(policy(), fetch)("https://example.com/");
  assertEquals((await response.bytes()).length, 1024);
  await code(response.text(), "used");
  assert(!("body" in response), "no raw body stream");
});

Deno.test("json applies the policy's limits", async () => {
  const body = (text: string) => fake(() => new Response(text)).fetch;
  const limits = { maxDepth: 3, maxKeys: 2, maxItems: 3 };
  const get = (text: string) =>
    boundedFetch(policy({ json: limits }), body(text))("https://example.com/");
  assertEquals(await (await get('{"a":[1,2,3]}')).json(), { a: [1, 2, 3] });
  await code((await get("[[[[1]]]]")).json(), "json");
  await code((await get('{"a":1,"b":2,"c":3}')).json(), "json");
  await code((await get("[1,2,3,4]")).json(), "json");
  await code((await get('{"__proto__":{}}')).json(), "json");
  await code((await get("{not json")).json(), "json");
  // Without `json`, conservative defaults still apply.
  const deep = "[".repeat(200) + "]".repeat(200);
  await code(
    (await boundedFetch(policy({ maxBytes: bytes(4096) }), body(deep))(
      "https://example.com/",
    )).json(),
    "json",
  );
});

Deno.test("the fetch budget counts every attempt, redirects included", async () => {
  const budget = { fetches: 3 };
  const { fetch, calls } = fake((url) =>
    url.endsWith("/r") ? redirect("/done") : new Response("ok")
  );
  const get = boundedFetch(policy({ budget }), fetch);
  await (await get("https://example.com/r")).discard();
  assertEquals(budget.fetches, 1);
  await (await get("https://example.com/")).discard();
  assertEquals(budget.fetches, 0);
  await code(get("https://example.com/"), "budget");
  assertEquals(calls.length, 3);
  // A redirect that would need one more fetch than is left fails.
  const small = { fetches: 1 };
  await code(
    boundedFetch(policy({ budget: small }), fetch)("https://example.com/r"),
    "budget",
  );
});

Deno.test("the caller's signal is merged with the deadline", async () => {
  // Already aborted: nothing is fetched.
  const { fetch, calls } = fake();
  const get = boundedFetch(policy(), fetch);
  const early = new AbortController();
  early.abort(new Error("stop"));
  await code(get("https://example.com/", { signal: early.signal }), "aborted");
  assertEquals(calls.length, 0);

  // Aborted while waiting for the response.
  const hanging = boundedFetch(policy(), () => new Promise<Response>(() => {}));
  const mid = new AbortController();
  setTimeout(() => mid.abort(new Error("user")), 10);
  const error = await code(
    hanging("https://example.com/", { signal: mid.signal }),
    "aborted",
  );
  assertEquals((error.cause as Error).message, "user");

  // Aborted while reading the body, and the fetch saw a merged signal.
  const endless = fake(() =>
    new Response(new ReadableStream<Uint8Array>({ start() {} }))
  );
  const late = new AbortController();
  const response = await boundedFetch(policy(), endless.fetch)(
    "https://example.com/",
    { signal: late.signal },
  );
  const seen = endless.calls[0].signal;
  assert(seen !== undefined && seen !== late.signal, "a merged signal");
  setTimeout(() => late.abort(new Error("later")), 10);
  await code(response.text(), "aborted");
  assert(seen.aborted, "the fetch's signal aborted too");
});

Deno.test("a failing fetch is an EgressError", async () => {
  const get = boundedFetch(
    policy(),
    () => Promise.reject(new TypeError("connection refused")),
  );
  const error = await code(get("https://example.com/"), "fetch");
  assert(error.cause instanceof TypeError, "keeps the cause");
});

Deno.test("Request inputs are checked like URLs", async () => {
  const { fetch, calls } = fake();
  const get = boundedFetch(policy(), fetch);
  await code(get(new Request("https://10.0.0.1/")), "network");
  const response = await get(
    new Request("https://example.com/", {
      method: "PUT",
      headers: { "x-a": "1" },
    }),
  );
  await response.discard();
  assertEquals([calls[0].method, calls[0].headers.get("x-a")], ["PUT", "1"]);
});

Deno.test("policies are validated when the fetch is made", () => {
  const bad: Partial<Record<keyof EgressPolicy, unknown>>[] = [
    { timeoutMs: Number.NaN },
    { timeoutMs: 0 },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { maxBytes: -1 },
    { maxBytes: 1.5 },
    { redirects: -1 },
    { redirects: 2.5 },
    { redirects: 1000 },
    { network: "internet" },
    { allow: undefined },
    { json: { maxDepth: Number.NaN, maxKeys: 1, maxItems: 1 } },
    { budget: { fetches: -1 } },
  ];
  for (const overrides of bad) {
    assertThrows(
      () => boundedFetch(policy(overrides as Partial<EgressPolicy>)),
      Error,
    );
  }
});

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of stream) total += chunk.length;
  return total;
}

// For streamed answers (server-sent events): the same byte cap and
// deadline as the buffered readers, applied while the consumer reads.
Deno.test("stream() passes the body through under the cap", async () => {
  const { fetch } = fake(() => new Response("x".repeat(1024)));
  const response = await boundedFetch(policy(), fetch)("https://example.com/");
  assertEquals(await drain(response.stream()), 1024);
  assertThrows(() => response.stream(), EgressError, "already been read");
  await code(response.text(), "used");
});

Deno.test("stream() errors past the cap and cancels the body", async () => {
  let pulled = 0;
  let cancelled = false;
  const { fetch } = fake(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(256));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 }),
    )
  );
  const response = await boundedFetch(policy({ maxBytes: bytes(1000) }), fetch)(
    "https://example.com/",
  );
  await code(drain(response.stream()), "too_large");
  assert(pulled <= 5, `pulled ${pulled}`);
  assert(cancelled, "cancelled");
});

Deno.test("stream() stops at the deadline", async () => {
  let cancelled = false;
  const { fetch } = fake(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x61]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    )
  );
  const response = await boundedFetch(policy({ timeoutMs: millis(50) }), fetch)(
    "https://example.com/",
  );
  const started = Date.now();
  await code(drain(response.stream()), "timeout");
  assert(Date.now() - started < 1000, "stopped near the deadline");
  assert(cancelled, "the body is cancelled");
});

// DB-SWP-F11-13.1: only authorization, cookie and proxy-authorization were
// dropped on a cross-origin hop, so DPoP proofs, API keys and any custom
// credential header followed the redirect to the other origin.
Deno.test("a cross-origin hop keeps only the listed headers", async () => {
  const headers = {
    authorization: "Bearer secret",
    dpop: "eyJ.proof",
    "x-api-key": "key",
    "api-key": "key",
    "x-exedev-authorization": "Bearer vm",
    "x-auth-token": "token",
    "private-token": "token",
    "x-trace": "trace-id",
    accept: "application/json",
    "accept-language": "en",
    "user-agent": "celld",
    "cache-control": "no-cache",
    "content-type": "application/json",
  };
  const { fetch, calls } = fake((url) => {
    if (url === "https://a.example/start") {
      return redirect("https://a.example/same", 307);
    }
    if (url === "https://a.example/same") {
      return redirect("https://b.example/other", 307);
    }
    return new Response("done");
  });
  // A body crosses origins only under the unsafe switch (DB-REV-JWT-1);
  // this test is about the headers that go with it.
  const get = boundedFetch(
    policy({ unsafeResendBodyCrossOrigin: true }),
    fetch,
  );
  const response = await get("https://a.example/start", {
    method: "POST",
    headers,
    body: "{}",
  });
  assertEquals(await response.text(), "done");
  const names = (call: Call) => [...call.headers.keys()].sort();
  assertEquals(names(calls[1]), Object.keys(headers).sort());
  assertEquals(names(calls[2]), [
    "accept",
    "accept-language",
    "cache-control",
    "content-type",
    "user-agent",
  ]);
  assertEquals(calls[2].body, "{}");
  assertEquals(CROSS_ORIGIN_HEADERS, [
    "accept",
    "accept-language",
    "cache-control",
    "content-encoding",
    "content-language",
    "content-type",
    "pragma",
    "user-agent",
  ]);
});

// DB-SWP-F16-13.4: `network: "loopback"` (or "any") switched cleartext on,
// with no development name on the switch.
Deno.test("cleartext needs allowCleartextLoopbackForDevelopment", async () => {
  for (const network of ["loopback", "any"] as const) {
    const { fetch, calls } = fake();
    const off = boundedFetch(policy({ network }), fetch);
    await code(off("http://127.0.0.1:8080/"), "scheme");
    const on = boundedFetch(
      policy({ network, allowCleartextLoopbackForDevelopment: true }),
      fetch,
    );
    assertEquals(await (await on("http://127.0.0.1:8080/")).text(), "ok");
    assertEquals(await (await on("http://[::1]:8080/")).text(), "ok");
    await code(on("http://localhost:8080/"), "scheme");
    await code(on("http://10.0.0.1/"), "scheme");
    await code(on("http://example.com/"), "scheme");
    assertEquals(calls.length, 2);
  }
  // Under "public" loopback is unreachable, so the switch is a mistake.
  assertThrows(
    () =>
      boundedFetch(
        policy({
          network: "public",
          allowCleartextLoopbackForDevelopment: true,
        }),
      ),
    RangeError,
  );
  assertThrows(
    () =>
      boundedFetch(
        policy({
          network: "loopback",
          allowCleartextLoopbackForDevelopment: "yes" as unknown as boolean,
        }),
      ),
    TypeError,
  );
});

// DB-REV-JWT-1: a cross-origin 307/308 (or a 301/302 after anything but an
// exact "POST") re-sent the request body, with a client secret in it, to the
// redirect target.
Deno.test("a cross-origin 307/308 with a body is refused and the target is never fetched", async () => {
  for (const status of [307, 308]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const { fetch, calls } = fake((url) =>
        url.startsWith("https://a.example/")
          ? redirect("https://evil.example/x", status)
          : new Response("ok")
      );
      const get = boundedFetch(policy(), fetch);
      const error = await code(
        get("https://a.example/token", {
          method,
          body: "client_secret=TOPSECRET",
        }),
        "redirect",
      );
      assert(error.message.includes("resend the request body"), error.message);
      assertEquals(calls.map((call) => call.url), ["https://a.example/token"]);
    }
  }
  // A 301/302 keeps the body for methods other than POST.
  for (const status of [301, 302]) {
    const { fetch, calls } = fake((url) =>
      url.startsWith("https://a.example/")
        ? redirect("https://evil.example/x", status)
        : new Response("ok")
    );
    const get = boundedFetch(policy(), fetch);
    await code(
      get("https://a.example/put", { method: "PUT", body: "secret-put" }),
      "redirect",
    );
    assertEquals(calls.length, 1);
  }
  // Leaving the origin and coming back still counts: the body went nowhere
  // else, but the hop in between would have carried it.
  const { fetch, calls } = fake((url) => {
    if (url === "https://a.example/start") {
      return redirect("https://b.example/x", 307);
    }
    return new Response("ok");
  });
  await code(
    boundedFetch(policy(), fetch)("https://a.example/start", {
      method: "POST",
      body: "x",
    }),
    "redirect",
  );
  assertEquals(calls.length, 1);
});

Deno.test("a cross-origin body resend needs unsafeResendBodyCrossOrigin", async () => {
  const { fetch, calls } = fake((url) =>
    url.startsWith("https://a.example/")
      ? redirect("https://b.example/x", 307)
      : new Response("ok")
  );
  const get = boundedFetch(
    policy({ unsafeResendBodyCrossOrigin: true }),
    fetch,
  );
  const response = await get("https://a.example/t", {
    method: "POST",
    body: "payload",
  });
  assertEquals(await response.text(), "ok");
  assertEquals([calls[1].url, calls[1].method, calls[1].body], [
    "https://b.example/x",
    "POST",
    "payload",
  ]);
  assertThrows(
    () =>
      boundedFetch(
        policy({
          unsafeResendBodyCrossOrigin: "yes" as unknown as boolean,
        }),
      ),
    TypeError,
  );
});

Deno.test("a lowercase post is normalized: 302 becomes GET without a body", async () => {
  for (const method of ["post", "Post", "POST"]) {
    const { fetch, calls } = fake((url) =>
      url.startsWith("https://a.example/")
        ? redirect("https://evil.example/x", 302)
        : new Response("ok")
    );
    const get = boundedFetch(policy(), fetch);
    await (await get("https://a.example/t", {
      method,
      body: "client_secret=S",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })).discard();
    assertEquals(calls[0].method, "POST", method);
    assertEquals(
      [calls[1].url, calls[1].method, calls[1].body ?? null],
      ["https://evil.example/x", "GET", null],
      method,
    );
    assertEquals(calls[1].headers.get("content-type"), null);
  }
  // The fetch-normalized set is upper-cased; other methods stay as given.
  const { fetch, calls } = fake();
  const get = boundedFetch(policy(), fetch);
  for (const method of ["get", "head", "options", "put", "delete", "patch"]) {
    await (await get("https://example.com/", { method })).discard();
  }
  assertEquals(calls.map((call) => call.method), [
    "GET",
    "HEAD",
    "OPTIONS",
    "PUT",
    "DELETE",
    "patch",
  ]);
});

Deno.test("a same-origin 307 still resends the body", async () => {
  const { fetch, calls } = fake((url) =>
    url === "https://a.example/start"
      ? redirect("https://a.example/next", 307)
      : new Response("ok")
  );
  const get = boundedFetch(policy(), fetch);
  await (await get("https://a.example/start", {
    method: "POST",
    body: "payload",
    headers: { authorization: "Bearer s" },
  })).discard();
  assertEquals([calls[1].url, calls[1].method, calls[1].body], [
    "https://a.example/next",
    "POST",
    "payload",
  ]);
  assertEquals(calls[1].headers.get("authorization"), "Bearer s");
});

// DB-REV-JWT-8: discard() after stream() ended the deadline without
// cancelling the stream, so a silent peer held the reader forever.
Deno.test("discard() after stream() cancels the stream", async () => {
  let cancelled = false;
  const { fetch } = fake(() =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise(() => {}),
        cancel() {
          cancelled = true;
        },
      }),
    )
  );
  const response = await boundedFetch(
    policy({ timeoutMs: millis(5_000) }),
    fetch,
  )(
    "https://example.com/",
  );
  const reader = response.stream().getReader();
  await response.discard();
  const outcome = await Promise.race([
    reader.read().then(
      () => "read",
      (error) => error instanceof EgressError ? error.code : String(error),
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 500)),
  ]);
  assertEquals(outcome, "aborted");
  assert(cancelled, "the body is cancelled");
  // A pending read settles too.
  const again = await boundedFetch(policy(), fetch)("https://example.com/");
  const second = again.stream().getReader();
  const pending = second.read();
  await again.discard();
  await code(pending, "aborted");
});
