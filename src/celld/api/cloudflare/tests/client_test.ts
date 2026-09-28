// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import {
  CloudflareClient,
  CloudflareError,
  endpointOrigin,
} from "@celld/api/cloudflare";
import type { FetchLike, Runtime } from "@celld/http";

/** Time that never waits, recording the waits it was asked for. */
function instant(): Runtime & { slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    now: () => 0,
    random: () => 0,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
    setTimer: () => () => {},
  };
}

interface Seen {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

/** A fetch answering from `answers` in turn, recording each request. */
function scripted(
  ...answers: (Response | (() => Response) | Error)[]
): FetchLike & { seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch = ((input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = answers.shift();
    if (next === undefined) {
      return Promise.reject(new Error("no answer scripted"));
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === "function" ? next() : next);
  }) as FetchLike & { seen: Seen[] };
  fetch.seen = seen;
  return fetch;
}

function envelope(result: unknown, extra: Record<string, unknown> = {}) {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...extra,
  });
}

function failure(status: number, errors: unknown[], headers?: HeadersInit) {
  return Response.json({ success: false, errors, messages: [], result: null }, {
    status,
    headers,
  });
}

Deno.test("endpoints: the integration by default, api.cloudflare.com with a token", () => {
  assertEquals(endpointOrigin({}), "https://cloudflare.int.exe.xyz");
  assertEquals(endpointOrigin({ integration: "cf" }), "https://cf.int.exe.xyz");
  assertEquals(endpointOrigin({ token: "t" }), "https://api.cloudflare.com");
  assertThrows(
    () => endpointOrigin({ baseUrl: "http://api.example.com" }),
    TypeError,
    "https",
  );
  assertThrows(
    () => endpointOrigin({ baseUrl: "https://api.example.com/client/v4" }),
    TypeError,
    "path",
  );
  assertThrows(
    () => endpointOrigin({ baseUrl: "https://u:p@api.example.com" }),
    TypeError,
    "credentials",
  );
  assertThrows(() => endpointOrigin({ integration: "Bad Name" }), TypeError);
  assertEquals(
    endpointOrigin({
      baseUrl: "http://127.0.0.1:8080",
      allowLoopbackForDevelopment: true,
    }),
    "http://127.0.0.1:8080",
  );
  assertThrows(
    () =>
      endpointOrigin({
        baseUrl: "http://example.com:8080",
        allowLoopbackForDevelopment: true,
      }),
    TypeError,
  );
});

Deno.test("fromEnv reads the token, integration and development switch", () => {
  const direct = CloudflareClient.fromEnv({ CLOUDFLARE_API_TOKEN: " tok " });
  assertEquals(direct.apiUrl, "https://api.cloudflare.com/client/v4");
  const proxied = CloudflareClient.fromEnv({
    CLOUDFLARE_INTEGRATION: "cf-dns",
  });
  assertEquals(proxied.apiUrl, "https://cf-dns.int.exe.xyz/client/v4");
  const local = CloudflareClient.fromEnv({
    CLOUDFLARE_BASE_URL: "http://127.0.0.1:9000",
    CLOUDFLARE_LOOPBACK_FOR_DEVELOPMENT: "true",
  });
  assertEquals(local.apiUrl, "http://127.0.0.1:9000/client/v4");
  assertThrows(
    () =>
      CloudflareClient.fromEnv({
        CLOUDFLARE_BASE_URL: "http://127.0.0.1:9000",
      }),
    TypeError,
  );
});

Deno.test("a token goes in Authorization; behind an integration nothing does", async () => {
  const fetch = scripted(envelope({ id: "a", status: "active" }), envelope([]));
  await new CloudflareClient({ token: "secret-token", fetch }).verifyToken();
  await new CloudflareClient({ fetch }).page("/zones");
  assertEquals(
    fetch.seen[0].headers.get("authorization"),
    "Bearer secret-token",
  );
  assertEquals(fetch.seen[0].url.pathname, "/client/v4/user/tokens/verify");
  assertEquals(fetch.seen[1].headers.get("authorization"), null);
  assertThrows(
    () => new CloudflareClient({ token: "has space" }),
    TypeError,
    "printable",
  );
});

Deno.test("query parameters: lists repeat the key, undefined and null drop out", async () => {
  const fetch = scripted(envelope([]));
  await new CloudflareClient({ fetch }).page("/zones", {
    name: "example.com",
    "account.id": undefined,
    paused: false,
    domain: ["a.example", "b.example"],
    gone: null,
  });
  const params = fetch.seen[0].url.searchParams;
  assertEquals(params.get("name"), "example.com");
  assertEquals(params.get("paused"), "false");
  assertEquals(params.getAll("domain"), ["a.example", "b.example"]);
  assert(!params.has("account.id") && !params.has("gone"), "dropped");
});

Deno.test("paths are checked before anything is sent", async () => {
  const fetch = scripted();
  const client = new CloudflareClient({ fetch });
  for (const path of ["zones", "/zones/../user", "/zones?x=1", "/a b"]) {
    await assertRejects(() => client.result("GET", path), TypeError, "path");
  }
  assertEquals(fetch.seen.length, 0);
});

Deno.test("an error envelope is an api error with its codes, status and ray", async () => {
  const fetch = scripted(
    failure(400, [{
      code: 81058,
      message: "An identical record already exists.",
    }], {
      "cf-ray": "8a1b2c3d4e5f-DFW",
    }),
  );
  const error = await assertRejects(
    () =>
      new CloudflareClient({ fetch }).result("POST", "/zones/x/dns_records", {
        body: {},
      }),
    CloudflareError,
    "81058",
  );
  assertEquals(error.kind, "api");
  assertEquals(error.status, 400);
  assertEquals(error.rayId, "8a1b2c3d4e5f-DFW");
  assert(error.hasCode(81058), "code");
});

Deno.test("success: false on a 200 is still an error", async () => {
  const fetch = scripted(
    Response.json({
      success: false,
      errors: [{ code: 1000, message: "nope" }],
      messages: [],
      result: null,
    }),
  );
  const error = await assertRejects(
    () => new CloudflareClient({ fetch }).result("GET", "/zones"),
    CloudflareError,
  );
  assertEquals(error.kind, "api");
  assert(error.hasCode(1000), "code");
});

Deno.test("a body without an envelope is a response error; HTML from a proxy is http", async () => {
  const fetch = scripted(
    Response.json({ hello: "world" }),
    new Response("<html>bad gateway</html>", { status: 502 }),
  );
  const client = new CloudflareClient({
    fetch,
    runtime: instant(),
    retry: { maxRetries: 0 },
  });
  assertEquals(
    (await assertRejects(() => client.result("GET", "/zones"), CloudflareError))
      .kind,
    "response",
  );
  const error = await assertRejects(
    () => client.result("GET", "/zones"),
    CloudflareError,
  );
  assertEquals(error.kind, "http");
  assertEquals(error.status, 502);
});

Deno.test("429 on a read waits as asked and tries again", async () => {
  const runtime = instant();
  const fetch = scripted(
    failure(429, [{ code: 10000, message: "Rate limited" }], {
      "retry-after": "7",
    }),
    envelope([{ id: "z" }]),
  );
  const page = await new CloudflareClient({ fetch, runtime }).page("/zones");
  assertEquals(page.items, [{ id: "z" }]);
  assertEquals(runtime.slept, [7000]);
});

Deno.test("a write is never sent twice, whatever failed", async () => {
  const runtime = instant();
  const fetch = scripted(
    failure(503, [{ code: 10001, message: "unavailable" }]),
    new Error("connection reset"),
  );
  const client = new CloudflareClient({ fetch, runtime });
  const unavailable = await assertRejects(
    () => client.result("POST", "/zones", { body: { name: "example.com" } }),
    CloudflareError,
  );
  assertEquals(unavailable.status, 503);
  const reset = await assertRejects(
    () => client.result("POST", "/zones", { body: { name: "example.com" } }),
    CloudflareError,
    "may have been made",
  );
  assertEquals(reset.kind, "network");
  assertEquals(fetch.seen.length, 2);
  assertEquals(runtime.slept, []);
});

Deno.test("a write declared idempotent is retried", async () => {
  const fetch = scripted(
    failure(502, []),
    envelope({ id: "purge" }),
  );
  const result = await new CloudflareClient({ fetch, runtime: instant() })
    .result("POST", "/zones/x/purge_cache", {
      body: { purge_everything: true },
      idempotent: true,
    });
  assertEquals(result, { id: "purge" });
  assertEquals(fetch.seen.length, 2);
});

Deno.test("pages: walks page numbers up to total_pages", async () => {
  const fetch = scripted(
    envelope([1, 2], { result_info: { page: 1, per_page: 2, total_pages: 3 } }),
    envelope([3, 4], { result_info: { page: 2, per_page: 2, total_pages: 3 } }),
    envelope([5], { result_info: { page: 3, per_page: 2, total_pages: 3 } }),
  );
  const client = new CloudflareClient({ fetch });
  assertEquals(await client.list("/zones", {}, { perPage: 2 }), [
    1,
    2,
    3,
    4,
    5,
  ]);
  assertEquals(
    fetch.seen.map((seen) => seen.url.searchParams.get("page")),
    ["1", "2", "3"],
  );
  assertEquals(fetch.seen[0].url.searchParams.get("per_page"), "2");
});

Deno.test("pages: without total_pages, total_count or a short page ends the list", async () => {
  const list = async (fetch: ReturnType<typeof scripted>) =>
    await new CloudflareClient({ fetch }).list<number>("/x");
  const byCount = scripted(
    envelope([1, 2], { result_info: { page: 1, per_page: 2, total_count: 5 } }),
    envelope([3, 4], { result_info: { page: 2, per_page: 2, total_count: 5 } }),
    envelope([5], { result_info: { page: 3, per_page: 2, total_count: 5 } }),
  );
  assertEquals(await list(byCount), [1, 2, 3, 4, 5]);
  assertEquals(byCount.seen.length, 3);

  const byShortPage = scripted(
    envelope([1, 2], { result_info: { page: 1, per_page: 2, count: 2 } }),
    envelope([3], { result_info: { page: 2, per_page: 2, count: 1 } }),
  );
  assertEquals(await list(byShortPage), [1, 2, 3]);
  assertEquals(byShortPage.seen.length, 2);

  // A full last page takes one more request, which comes back empty.
  const byEmptyPage = scripted(
    envelope([1, 2], { result_info: { page: 1, per_page: 2 } }),
    envelope([], { result_info: { page: 2, per_page: 2 } }),
  );
  assertEquals(await list(byEmptyPage), [1, 2]);
  assertEquals(byEmptyPage.seen.length, 2);

  // No per_page at all: a list that is not paged, asked for once.
  const unpaged = scripted(envelope([1, 2, 3]));
  assertEquals(await list(unpaged), [1, 2, 3]);
  assertEquals(unpaged.seen.length, 1);
});

Deno.test("pages: follows a cursor until there is none", async () => {
  const fetch = scripted(
    envelope(["a"], { result_info: { cursor: "c1" } }),
    envelope(["b"], { result_info: { cursors: { after: "c2" } } }),
    envelope(["c"], { result_info: {} }),
  );
  const all = await new CloudflareClient({ fetch }).list("/things", {}, {
    paging: "cursor",
  });
  assertEquals(all, ["a", "b", "c"]);
  assertEquals(
    fetch.seen.map((seen) => seen.url.searchParams.get("cursor")),
    [null, "c1", "c2"],
  );
});

Deno.test("list refuses to pass a partial list off as the whole", async () => {
  const pages = () =>
    scripted(
      envelope([1, 2], { result_info: { page: 1, total_pages: 2 } }),
      envelope([3, 4], { result_info: { page: 2, total_pages: 2 } }),
    );
  await assertRejects(
    () =>
      new CloudflareClient({ fetch: pages() }).list("/zones", {}, {
        maxItems: 3,
      }),
    RangeError,
    "more than 3",
  );
  assertEquals(
    await new CloudflareClient({ fetch: pages() }).list("/zones", {}, {
      maxItems: 3,
      truncate: true,
    }),
    [1, 2, 3],
  );
});

Deno.test("a response over maxResponseBytes is refused", async () => {
  const fetch = scripted(envelope("x".repeat(4096)));
  const error = await assertRejects(
    () =>
      new CloudflareClient({ fetch, maxResponseBytes: 1024 }).result(
        "GET",
        "/zones",
      ),
    CloudflareError,
  );
  assertEquals(error.kind, "too-large");
});

Deno.test("a caller's abort stops the request and is what rejects", async () => {
  const controller = new AbortController();
  const reason = new Error("caller gave up");
  const fetch: FetchLike = (_input, init) =>
    new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
    );
  const pending = new CloudflareClient({ fetch }).result("GET", "/zones", {
    signal: controller.signal,
  });
  controller.abort(reason);
  assertEquals(await pending.catch((error) => error), reason);
});

Deno.test("verifyToken: the user endpoint, or the account's for an account token", async () => {
  const fetch = scripted(
    envelope({ id: "tok", status: "active" }),
    envelope({ id: "tok", status: "active" }),
  );
  const client = new CloudflareClient({ fetch, token: "t" });
  assertEquals((await client.verifyToken()).status, "active");
  await client.verifyToken({ accountId: "0123456789abcdef0123456789abcdef" });
  assertEquals(
    fetch.seen[1].url.pathname,
    "/client/v4/accounts/0123456789abcdef0123456789abcdef/tokens/verify",
  );
  await assertRejects(
    () => client.verifyToken({ accountId: "not-an-id" }),
    TypeError,
    "32 lower-case hex",
  );
});
