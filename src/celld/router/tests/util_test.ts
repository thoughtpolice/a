// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import { IpError } from "@celld/ip";
import {
  clientIp,
  formatChallenge,
  parseAuthorization,
  router,
  RouterError,
  secretEquals,
  serializeCookie,
  timingSafeEqual,
} from "@celld/router";
import { call } from "./fixture.ts";

function req(headers: Record<string, string>): Request {
  return new Request("https://api.example.com/", { headers });
}

const PROXIES = { trustedProxies: ["10.0.0.0/8", "fd00::/8"] };

Deno.test("clientIp: the peer is the client unless it is a trusted proxy", () => {
  const spoofed = req({
    "cf-connecting-ip": "198.51.100.7",
    "x-forwarded-for": "1.2.3.4",
  });
  assertEquals(clientIp(spoofed, PROXIES)?.toString(), "198.51.100.7");
  assertEquals(
    clientIp(spoofed)?.toString(),
    "198.51.100.7",
    "no trusted proxies: XFF ignored",
  );
});

Deno.test("clientIp: through trusted proxies, X-Forwarded-For is read from the right", () => {
  const chain = req({
    "cf-connecting-ip": "10.0.0.2",
    "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.1.2.3",
  });
  assertEquals(clientIp(chain, PROXIES)?.toString(), "198.51.100.7");
  const allTrusted = req({
    "cf-connecting-ip": "10.0.0.2",
    "x-forwarded-for": "10.9.9.9",
  });
  assertEquals(clientIp(allTrusted, PROXIES)?.toString(), "10.9.9.9");
  const noForward = req({ "cf-connecting-ip": "10.0.0.2" });
  assertEquals(clientIp(noForward, PROXIES)?.toString(), "10.0.0.2");
  const garbage = req({
    "cf-connecting-ip": "10.0.0.2",
    "x-forwarded-for": "junk, 10.1.1.1",
  });
  assertEquals(clientIp(garbage, PROXIES), null);
});

Deno.test("clientIp: mapped addresses are unmapped; bad or missing peers are null", () => {
  assertEquals(
    clientIp(
      req({
        "cf-connecting-ip": "::ffff:10.0.0.2",
        "x-forwarded-for": "192.0.2.9",
      }),
      PROXIES,
    )
      ?.toString(),
    "192.0.2.9",
  );
  assertEquals(clientIp(req({ "cf-connecting-ip": "010.0.0.1" })), null);
  assertEquals(clientIp(req({})), null);
  assertEquals(
    clientIp(req({ "x-real-ip": "192.0.2.1" }), { peerHeader: "x-real-ip" })
      ?.toString(),
    "192.0.2.1",
  );
});

Deno.test("clientIp: a typo in the proxy list throws instead of trusting nothing", () => {
  assertThrows(
    () =>
      clientIp(req({ "cf-connecting-ip": "10.0.0.1" }), {
        trustedProxies: ["10.0.0.0/33"],
      }),
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
