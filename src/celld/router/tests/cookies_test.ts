// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/assert";
import {
  cookieKeys,
  parseCookies,
  RouterError,
  serializeCookie,
} from "@celld/router";

const K1 = { id: "k1", secret: "0123456789abcdef0123456789abcdef" };
const K2 = { id: "k2", secret: new Uint8Array(32).fill(7) };

Deno.test("serializeCookie defaults to HttpOnly; Secure; SameSite=Lax; Path=/", () => {
  assertEquals(
    serializeCookie("a", "b"),
    "a=b; Path=/; Secure; HttpOnly; SameSite=Lax",
  );
  assertEquals(
    serializeCookie("a", "b", {
      httpOnly: false,
      sameSite: "Strict",
      path: "/app",
      domain: "example.com",
      maxAge: 60,
      expires: new Date(0),
      partitioned: true,
    }),
    "a=b; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=example.com; Path=/app; Secure; SameSite=Strict; Partitioned",
  );
  assertEquals(
    serializeCookie("a", "b", { maxAge: "PT2H" }).split("; ")[1],
    "Max-Age=7200",
  );
});

Deno.test("serializeCookie enforces the prefixes and SameSite=None", () => {
  assertEquals(
    serializeCookie("__Host-s", "v"),
    "__Host-s=v; Path=/; Secure; HttpOnly; SameSite=Lax",
  );
  assertThrows(
    () => serializeCookie("__Host-s", "v", { path: "/x" }),
    RouterError,
    "__Host-",
  );
  assertThrows(
    () => serializeCookie("__Host-s", "v", { domain: "a.com" }),
    RouterError,
    "__Host-",
  );
  assertThrows(
    () => serializeCookie("__Host-s", "v", { secure: false }),
    RouterError,
    "Secure",
  );
  assertThrows(
    () => serializeCookie("__Secure-s", "v", { secure: false }),
    RouterError,
    "Secure",
  );
  assertThrows(
    () => serializeCookie("s", "v", { sameSite: "None", secure: false }),
    RouterError,
    "SameSite=None",
  );
  assertEquals(
    serializeCookie("s", "v", { secure: false }),
    "s=v; Path=/; HttpOnly; SameSite=Lax",
  );
});

Deno.test("serializeCookie refuses names and values that would inject attributes", () => {
  assertThrows(
    () => serializeCookie("a b", "v"),
    RouterError,
    "not a cookie name",
  );
  assertThrows(
    () => serializeCookie("a", "v; Domain=evil"),
    RouterError,
    "encode it",
  );
  assertThrows(
    () => serializeCookie("a", "v", { path: "/;x" }),
    RouterError,
    "bad path",
  );
});

Deno.test("parseCookies: first of a name wins, quotes are removed", () => {
  const cookies = parseCookies('a=1; b="two"; a=3; bad; =x; c=');
  assertEquals([...cookies], [["a", "1"], ["b", "two"], ["c", ""]]);
  assertEquals(parseCookies(null).size, 0);
});

Deno.test("signed cookies verify, bind the name, and refuse tampering", async () => {
  const ring = cookieKeys([K1]);
  const signed = await ring.sign("prefs", "dark mode ✓");
  assert(signed.startsWith("s1.k1."), signed);
  assertEquals(await ring.verify("prefs", signed), {
    value: "dark mode ✓",
    key: "k1",
    stale: false,
  });
  assertEquals(await ring.verify("other", signed), null);
  const parts = signed.split(".");
  const forged = [
    parts[0],
    parts[1],
    btoa("admin").replace(/=+$/, ""),
    parts[3],
  ].join(".");
  assertEquals(await ring.verify("prefs", forged), null);
  assertEquals(await ring.verify("prefs", "s1.k9.YQ.YQ"), null);
  assertEquals(await ring.verify("prefs", "garbage"), null);
});

Deno.test("sealed cookies are unreadable and authenticated", async () => {
  const ring = cookieKeys([K1]);
  const sealed = await ring.seal("sid", "user=ada");
  assert(sealed.startsWith("e1.k1.") && !sealed.includes("ada"), sealed);
  assert(sealed !== await ring.seal("sid", "user=ada"), "a fresh IV each time");
  assertEquals(await ring.unseal("sid", sealed), {
    value: "user=ada",
    key: "k1",
    stale: false,
  });
  assertEquals(await ring.unseal("other", sealed), null);
  assertEquals(
    await ring.verify("sid", sealed),
    null,
    "a sealed value is not a signed one",
  );
  const parts = sealed.split(".");
  const last = parts[3];
  parts[3] = (last[0] === "A" ? "B" : "A") + last.slice(1);
  assertEquals(await ring.unseal("sid", parts.join(".")), null);
});

Deno.test("rotation: new keys sign, old keys still verify and report stale", async () => {
  const old = cookieKeys([K1]);
  const signed = await old.sign("c", "v");
  const sealed = await old.seal("c", "v");
  const rotated = cookieKeys([K2, K1]);
  assertEquals(rotated.current, "k2");
  assertEquals(await rotated.verify("c", signed), {
    value: "v",
    key: "k1",
    stale: true,
  });
  assertEquals(await rotated.unseal("c", sealed), {
    value: "v",
    key: "k1",
    stale: true,
  });
  assert(
    (await rotated.sign("c", "v")).startsWith("s1.k2."),
    "new values use the new key",
  );
  const retired = cookieKeys([K2]);
  assertEquals(await retired.verify("c", signed), null);
});

Deno.test("keyrings refuse short secrets, bad and repeated ids", () => {
  assertThrows(() => cookieKeys([]), RouterError, "needs a key");
  assertThrows(
    () => cookieKeys([{ id: "k", secret: "short" }]),
    RouterError,
    "32 bytes",
  );
  assertThrows(
    () => cookieKeys([{ id: "a.b", secret: K1.secret }]),
    RouterError,
    "bad cookie key id",
  );
  assertThrows(() => cookieKeys([K1, K1]), RouterError, "repeats");
});
