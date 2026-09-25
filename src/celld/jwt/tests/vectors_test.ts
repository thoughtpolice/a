// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Examples from the RFCs, quoted as published (IETF Trust; code components
// under the Revised BSD License). Their `exp` is in 2011, so the clock is
// set before it.

import { assert, assertEquals } from "@celld/assert";
import {
  decode,
  fromBase64Url,
  type Jwk,
  sign,
  signBytes,
  toBase64Url,
  verify,
  verifyBytes,
} from "@celld/jwt";
import { rejects } from "./fixture.ts";

const BEFORE_2011 = Date.UTC(2011, 0, 1);

// RFC 7515 appendix A.1 (also RFC 7519 section 3.1): HS256.
const A1_KEY: Jwk = {
  kty: "oct",
  k: "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow",
};
const A1_TOKEN = "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9" +
  ".eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ" +
  ".dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

// RFC 7515 appendix A.3: ES256 (the signature is randomized; this one verifies).
const A3_KEY: Jwk = {
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
};
const A3_TOKEN = "eyJhbGciOiJFUzI1NiJ9" +
  ".eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ" +
  ".DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q";

// RFC 8037 appendix A.1 and A.4: Ed25519. Its payload is not JSON, so the
// raw JWS steps are checked; Ed25519 is deterministic, so signing matches.
const ED_KEY: Jwk = {
  kty: "OKP",
  crv: "Ed25519",
  d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
};
const ED_INPUT = "eyJhbGciOiJFZERTQSJ9.RXhhbXBsZSBvZiBFZDI1NTE5IHNpZ25pbmc";
const ED_SIGNATURE =
  "hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR6dWbhijcNR4ki4iylGjg5BhVsPt9g7sVvpAr_MuM0KAg";

Deno.test("RFC 7515 A.1: HS256", async () => {
  const verified = await verify(A1_TOKEN, A1_KEY, { now: BEFORE_2011 });
  assertEquals(verified.alg, "HS256");
  assertEquals(verified.header, { typ: "JWT", alg: "HS256" });
  assertEquals(verified.payload, {
    iss: "joe",
    exp: 1300819380,
    "http://example.com/is_root": true,
  });
  await rejects(() => verify(A1_TOKEN, A1_KEY), "expired");
  await rejects(
    () => verify(A1_TOKEN, { ...A1_KEY, k: A1_KEY.k!.replace("A", "B") }),
    "bad_signature",
  );
  const secret = fromBase64Url(A1_KEY.k!)!;
  const [header, payload, signature] = A1_TOKEN.split(".");
  const again = await signBytes(
    "HS256",
    secret,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assertEquals(toBase64Url(again), signature);
});

Deno.test("RFC 7515 A.3: ES256", async () => {
  const verified = await verify(A3_TOKEN, A3_KEY, {
    now: BEFORE_2011,
    algorithms: ["ES256"],
  });
  assertEquals(verified.payload.iss, "joe");
  await rejects(
    () => verify(A3_TOKEN, A3_KEY, { now: BEFORE_2011, algorithms: ["RS256"] }),
    "alg_not_allowed",
  );
  await rejects(
    () => verify(A3_TOKEN, A1_KEY, { now: BEFORE_2011 }),
    "key_mismatch",
  );
});

Deno.test("RFC 8037 A.4: Ed25519", async () => {
  const input = new TextEncoder().encode(ED_INPUT);
  const signature = await signBytes("EdDSA", ED_KEY, input);
  assertEquals(toBase64Url(signature), ED_SIGNATURE);
  assert(
    await verifyBytes("EdDSA", ED_KEY, input, fromBase64Url(ED_SIGNATURE)!),
    "verifies",
  );
  assert(
    await verifyBytes("Ed25519", ED_KEY, input, signature),
    "fully specified name",
  );
  await rejects(() => decode(`${ED_INPUT}.${ED_SIGNATURE}`), "malformed");
  const token = await sign({ sub: "rfc8037" }, ED_KEY, { alg: "EdDSA" });
  const { d: _d, ...publicKey } = ED_KEY;
  assertEquals((await verify(token, publicKey)).payload, { sub: "rfc8037" });
});
