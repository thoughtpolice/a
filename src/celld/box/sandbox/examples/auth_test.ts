// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/core/assert";
import { authenticate } from "./auth.ts";

const secret = "example-only-secret-with-more-than-32-bytes";
async function request(subject: string, expiry?: number) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(
        expiry === undefined
          ? `subject:${subject}`
          : `subject-exp:${subject}:${expiry}`,
      ),
    ),
  );
  const mac = btoa(String.fromCharCode(...signature)).replaceAll("+", "-")
    .replaceAll("/", "_").replaceAll("=", "");
  return new Request("https://example.test/", {
    headers: {
      authorization: `Bearer ${subject}${
        expiry === undefined ? "" : `.${expiry}`
      }.${mac}`,
    },
  });
}

Deno.test("DB-SBX-017: examples require short expiry; legacy tokens require explicit unsafe flag", async () => {
  const now = Math.floor(Date.now() / 1000);
  const valid = await authenticate(await request("alice", now + 300), secret);
  assert(valid !== null, "short-lived token accepted");
  assertEquals(
    await authenticate(await request("alice", now - 1), secret),
    null,
  );
  assertEquals(
    await authenticate(await request("alice", now + 3601), secret),
    null,
  );
  assertEquals(await authenticate(await request("alice"), secret), null);
  const legacy = await authenticate(await request("alice"), secret, true);
  assertEquals(legacy?.tenant, valid.tenant);
  const other = await authenticate(await request("bob", now + 300), secret);
  assert(
    other !== null && other.tenant !== valid.tenant,
    "verified subjects select disjoint opaque names",
  );
  assertEquals(
    await authenticate(await request("alice", now + 300), `${secret}other`),
    null,
  );
});

Deno.test("DB-SBX-017: missing or weak secret fails closed", async () => {
  for (const value of [undefined, "short"]) {
    let rejected = false;
    try {
      await authenticate(
        await request("alice", Math.floor(Date.now() / 1000) + 300),
        value,
      );
    } catch {
      rejected = true;
    }
    assert(rejected, "invalid secret rejected");
  }
});
