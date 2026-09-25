// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Test-only fixture signer: short-lived deliveries, independent of calendar date. */
import { serveUpstream } from "@celld/examples/upstream";
import { decode, fromBase64Url, sign, verifyBytes } from "@celld/sec/jwt";

// Public test secrets shared only with webhook.json. Never a production endpoint.
const secrets = [
  "C7EfiVkxsx5vkzQw7wuWB1cFhTY5EWHXgbSO4YRYlmQ",
  "k3vQrDwxfrH4XmiAjKRpsve25YEeny1dV7YtaBIleb0",
].map((value) => fromBase64Url(value)!);
serveUpstream({
  async fetch(request) {
    const input = await request.json() as { tokens: string[] };
    const tokens = await Promise.all(input.tokens.map(async (fixture) => {
      const parsed = decode(fixture);
      let key = secrets[0];
      for (const candidate of secrets) {
        if (
          await verifyBytes(
            "HS256",
            candidate,
            parsed.signingInput,
            parsed.signature,
          )
        ) key = candidate;
      }
      const now = Math.floor(Date.now() / 1000);
      const expired = Number(parsed.payload.exp) < 2000000000;
      return await sign(
        {
          ...parsed.payload,
          iat: now - (expired ? 300 : 0),
          exp: now + (expired ? -60 : 240),
        },
        key,
        { alg: "HS256", kid: parsed.header.kid as string, typ: "JWT" },
      );
    }));
    return Response.json({ tokens });
  },
  vars: () => ({}),
});
