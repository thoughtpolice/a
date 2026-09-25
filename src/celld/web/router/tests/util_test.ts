// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import { IpError } from "@celld/core/ip";
import {
  clientIp,
  clientIpForAuthorization,
  type ClientIpOptions,
  formatChallenge,
  parseAuthorization,
  router,
  RouterError,
  secretEquals,
  serializeCookie,
  session,
  timingSafeEqual,
} from "@celld/web/router";
import { call } from "./fixture.ts";

const PROXIES = { trustedProxies: ["10.0.0.0/8", "fd00::/8"] };
/**
 * The peer source named explicitly, as a Cloudflare deployment does: only
 * then does `clientIpForAuthorization` answer (sweep DB-SWP-F6-13.R1).
 */
const EDGE = { peerHeader: "cf-connecting-ip" };
const EDGE_PROXIES = { ...EDGE, ...PROXIES };

interface Seen {
  /** `clientIp(c)`: informational. */
  readonly ip: string | null;
  /** `clientIpForAuthorization(c)`: complete, trusted chains only. */
  readonly auth: string | null;
}

/** What the two client-IP functions say for a request with `headers`. */
function probe(
  options: ClientIpOptions = {},
): (headers: Record<string, string>) => Promise<Seen> {
  const app = router({ auth: "none", clientIp: options });
  app.get("/", (c) =>
    c.json({
      ip: clientIp(c)?.toString() ?? null,
      auth: clientIpForAuthorization(c)?.toString() ?? null,
    }));
  return async (headers) =>
    (await call(app, "/", { headers })).json as unknown as Seen;
}

Deno.test("clientIp: the peer is the client unless it is a trusted proxy", async () => {
  const spoofed = {
    "cf-connecting-ip": "198.51.100.7",
    "x-forwarded-for": "1.2.3.4",
  };
  assertEquals(await probe(EDGE_PROXIES)(spoofed), {
    ip: "198.51.100.7",
    auth: "198.51.100.7",
  });
  assertEquals(
    await probe(EDGE)(spoofed),
    { ip: "198.51.100.7", auth: "198.51.100.7" },
    "no trusted proxies: XFF ignored",
  );
});

Deno.test("clientIp: through trusted proxies, X-Forwarded-For is read from the right", async () => {
  const lenient = probe(EDGE_PROXIES);
  assertEquals(
    await lenient({
      "cf-connecting-ip": "10.0.0.2",
      "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.1.2.3",
    }),
    { ip: "198.51.100.7", auth: "198.51.100.7" },
  );
  // DB-RTR-013: a chain of trusted hops only, or a trusted peer that
  // forwarded nothing, names no client. The informational answer is the
  // last hop (as before); the authorization answer and strict mode are null.
  const allTrusted = {
    "cf-connecting-ip": "10.0.0.2",
    "x-forwarded-for": "10.9.9.9",
  };
  assertEquals(await lenient(allTrusted), { ip: "10.9.9.9", auth: null });
  const noForward = { "cf-connecting-ip": "10.0.0.2" };
  assertEquals(await lenient(noForward), { ip: "10.0.0.2", auth: null });
  const strict = probe({ ...EDGE_PROXIES, strict: true });
  assertEquals(await strict(allTrusted), { ip: null, auth: null });
  assertEquals(await strict(noForward), { ip: null, auth: null });
  const garbage = {
    "cf-connecting-ip": "10.0.0.2",
    "x-forwarded-for": "junk, 10.1.1.1",
  };
  assertEquals(await lenient(garbage), { ip: null, auth: null });
});

Deno.test("clientIp: mapped addresses are unmapped; bad or missing peers are null", async () => {
  assertEquals(
    await probe(EDGE_PROXIES)({
      "cf-connecting-ip": "::ffff:10.0.0.2",
      "x-forwarded-for": "192.0.2.9",
    }),
    { ip: "192.0.2.9", auth: "192.0.2.9" },
  );
  assertEquals(await probe(EDGE)({ "cf-connecting-ip": "010.0.0.1" }), {
    ip: null,
    auth: null,
  });
  assertEquals(await probe(EDGE)({}), { ip: null, auth: null });
  assertEquals(
    await probe({ peerHeader: "x-real-ip" })({ "x-real-ip": "192.0.2.1" }),
    { ip: "192.0.2.1", auth: "192.0.2.1" },
  );
});

Deno.test("clientIpForAuthorization: the default peer header is no authority", async () => {
  // Sweep DB-SWP-F6-13.R1: without an explicit peer source the default
  // `CF-Connecting-IP` is a header any client can write off Cloudflare's
  // edge, so it may inform logs but never grant access.
  const spoofed = { "cf-connecting-ip": "198.51.100.7" };
  assertEquals(await probe()(spoofed), { ip: "198.51.100.7", auth: null });
  assertEquals(
    await probe(PROXIES)({
      "cf-connecting-ip": "10.0.0.2",
      "x-forwarded-for": "192.0.2.9",
    }),
    { ip: "192.0.2.9", auth: null },
  );
  assertEquals(await probe(EDGE)(spoofed), {
    ip: "198.51.100.7",
    auth: "198.51.100.7",
  });
});

Deno.test("clientIp: the peer comes from a platform adapter when given one", async () => {
  const adapter = probe({
    peer: (c) => c.unsafeRequest.headers.get("x-socket-peer"),
    ...PROXIES,
  });
  assertEquals(
    await adapter({
      "x-socket-peer": "10.0.0.3",
      "cf-connecting-ip": "203.0.113.1",
      "x-forwarded-for": "192.0.2.44",
    }),
    { ip: "192.0.2.44", auth: "192.0.2.44" },
  );
  assertEquals(await adapter({ "cf-connecting-ip": "203.0.113.1" }), {
    ip: null,
    auth: null,
  });
  assertThrows(
    () =>
      router({
        auth: "none",
        clientIp: { peer: () => null, peerHeader: "x-real-ip" },
      }),
    RouterError,
    "peer",
  );
  assertThrows(
    () =>
      router({
        auth: "none",
        clientIp: { strict: "yes" as unknown as boolean },
      }),
    RouterError,
    "strict",
  );
});

Deno.test("clientIp: a typo in the proxy list throws instead of trusting nothing", () => {
  assertThrows(
    () =>
      router({ auth: "none", clientIp: { trustedProxies: ["10.0.0.0/33"] } }),
    IpError,
    "",
  );
});

Deno.test("c.ip() uses the router's settings", async () => {
  const app = router({ auth: "none", clientIp: PROXIES });
  app.get("/", (c) => c.text(c.ip()?.toString() ?? "unknown"));
  assertEquals(
    (await call(app, "/", {
      headers: {
        "cf-connecting-ip": "10.0.0.1",
        "x-forwarded-for": "203.0.113.5",
      },
    })).text,
    "203.0.113.5",
  );
  assertEquals((await call(app, "/")).text, "unknown");
});

Deno.test("timingSafeEqual and secretEquals", async () => {
  assert(timingSafeEqual("abc", "abc"), "equal");
  assert(!timingSafeEqual("abc", "abd"), "different");
  assert(!timingSafeEqual("abc", "abcd"), "lengths");
  assert(timingSafeEqual(new Uint8Array([1, 2]), "\x01\x02"), "bytes and text");
  assert(await secretEquals("s3cret", "s3cret"), "equal");
  assert(!await secretEquals("s3cret", "s3cret!"), "different lengths");
});

Deno.test("Authorization parsing and challenge formatting", () => {
  assertEquals(parseAuthorization(null), null);
  assertEquals(parseAuthorization("Bearer  abc "), {
    scheme: "Bearer",
    credentials: "abc",
  });
  assertEquals(parseAuthorization("Negotiate"), {
    scheme: "Negotiate",
    credentials: "",
  });
  assertEquals(formatChallenge({ scheme: "Bearer" }), "Bearer");
  assertEquals(
    formatChallenge({ scheme: "Bearer", params: [["realm", 'a "b" \\c']] }),
    'Bearer realm="a \\"b\\" \\\\c"',
  );
});

Deno.test("durations: seconds or ISO 8601 without years or months", () => {
  const cookie = (maxAge: number | string) =>
    serializeCookie("a", "b", { maxAge }).split("; ")[1];
  assertEquals(cookie(90), "Max-Age=90");
  assertEquals(cookie("P1W1DT1H1M1.5S"), "Max-Age=694861");
  for (const bad of ["P1M", "P1Y", "-PT1S", "soon", -1]) {
    assertThrows(() => cookie(bad), RouterError, "maxAge must be");
  }
  assertThrows(
    () => router({ auth: "none", limits: { timeout: "P1M" } }),
    RouterError,
    "timeout",
  );
});

// DB-RTR-014: durations are checked after conversion, against the limits
// of what they feed.

Deno.test("timeouts are finite and at most the maximum timeout", async () => {
  for (const timeout of [3_000_000, "PT6M", 1e300, "P30D"]) {
    assertThrows(
      () => router({ auth: "none", limits: { timeout } }),
      RouterError,
      "timeout",
    );
  }
  const long = router({
    auth: "none",
    limits: { timeout: "PT6M", maxTimeout: "PT10M" },
  });
  long.get("/", (c) => c.text("x"));
  assertEquals((await call(long, "/")).text, "x");
  assertThrows(
    () =>
      long.get("/slow", { limits: { timeout: "PT11M" } }, (c) => c.text("x")),
    RouterError,
    "timeout",
  );
  for (const maxTimeout of [3_000_000, "P25D", -1, Infinity]) {
    assertThrows(
      () => router({ auth: "none", limits: { maxTimeout } }),
      RouterError,
      "maxTimeout",
    );
  }
  // A mounted router's route is held to the serving router's maximum.
  const child = router({ auth: "none", limits: { maxTimeout: "PT10M" } });
  child.get("/x", { limits: { timeout: "PT6M" } }, (c) => c.text("x"));
  assertThrows(
    () => router({ auth: "none" }).mount("/c", child),
    RouterError,
    "timeout",
  );
});

Deno.test("cookie lifetimes are bounded to 400 days and never Infinity", () => {
  const cookie = (options: Parameters<typeof serializeCookie>[2]) =>
    serializeCookie("a", "b", options);
  assert(cookie({ maxAge: "P400D" }).includes("Max-Age=34560000;"), "400 days");
  for (const maxAge of [1e300, Infinity, "P401D", 34_560_001]) {
    assertThrows(() => cookie({ maxAge }), RouterError, "maxAge");
  }
  assertThrows(
    () => cookie({ expires: new Date(Number.NaN) }),
    RouterError,
    "expires",
  );
  const far = cookie({ expires: new Date(Date.UTC(9999, 0, 1)) });
  const written = Date.parse(/Expires=([^;]+)/.exec(far)![1]);
  assert(
    written <= Date.now() + 400 * 86_400_000 + 1000,
    `clamped to 400 days: ${far}`,
  );
  assertThrows(
    () =>
      session({
        keys: [{ id: "k", secret: "x".repeat(32) }],
        maxAge: "P1000D",
      }),
    RouterError,
    "maxAge",
  );
});

// DB-REV-RTR-8: `timeout: false` on a route means "no timeout of its own",
// which still ends at the serving router's `maxTimeout`; nothing a route
// (a mounted third-party router's, say) sets escapes it.
Deno.test("a route's timeout: false still ends at the serving router's maxTimeout", async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const app = router({
    auth: "none",
    limits: { timeout: 0.02, maxTimeout: 0.06 },
  });
  app.get("/forever", { limits: { timeout: false } }, async (c) => {
    await sleep(200);
    return c.text("done");
  });
  app.get("/quick", { limits: { timeout: false } }, async (c) => {
    await sleep(30);
    return c.text("done");
  });
  const started = Date.now();
  assertEquals((await call(app, "/forever")).status, 504);
  assert(Date.now() - started < 190, "ended at maxTimeout");
  assertEquals((await call(app, "/quick")).text, "done");
  // A mounted router's route is held to the serving router's maximum.
  const child = router({ auth: "none" });
  child.get("/x", { limits: { timeout: false } }, async (c) => {
    await sleep(200);
    return c.text("x");
  });
  const parent = router({
    auth: "none",
    limits: { maxTimeout: 0.05, timeout: 0.05 },
  });
  parent.mount("/c", child);
  assertEquals((await call(parent, "/c/x")).status, 504);
  // And a mounted route's explicit timeout is checked against it at mount.
  const long = router({ auth: "none" });
  long.get("/x", { limits: { timeout: "PT2M" } }, (c) => c.text("x"));
  assertThrows(
    () =>
      router({ auth: "none", limits: { maxTimeout: "PT1M" } }).mount(
        "/c",
        long,
      ),
    RouterError,
    "timeout",
  );
});
