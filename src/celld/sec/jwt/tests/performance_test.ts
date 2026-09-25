// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** Repeatable operation-count gates plus non-thresholded local timing samples. */
import { assertEquals } from "@celld/core/assert";
import {
  createVerifier,
  generateKeyPair,
  RemoteJwks,
  sign,
} from "@celld/sec/jwt";

Deno.test("DB-JWT-007/011: prepared/local/remote-hit/rotation operation benchmark", async () => {
  const pair = await generateKeyPair("ES256", { kid: "first" });
  const replacement = await generateKeyPair("ES256", { kid: "second" });
  const token = await sign({ sub: "benchmark", exp: 3600 }, pair.privateKey, {
    alg: "ES256",
    kid: "first",
  });
  const rotated = await sign(
    { sub: "benchmark", exp: 3600 },
    replacement.privateKey,
    { alg: "ES256", kid: "second" },
  );
  let now = 0, fetches = 0, current = pair.publicJwk;
  const remote = new RemoteJwks("https://keys.test/jwks", {
    now: () => now,
    fetch: () => {
      fetches++;
      return Promise.resolve(
        Response.json({ keys: [current] }, {
          headers: { "cache-control": "max-age=60" },
        }),
      );
    },
  });
  const local = createVerifier({
    keys: pair.publicJwk,
    algorithms: ["ES256"],
    now: 0,
  });
  const network = createVerifier({
    keys: remote,
    algorithms: ["ES256"],
    now: 0,
  });
  await Promise.all([local.ready(), network.ready()]);
  await network.verify(token);
  const subtle = crypto.subtle as unknown as Record<string, unknown>;
  const original = crypto.subtle.importKey;
  let imports = 0;
  subtle.importKey = (...args: unknown[]) => {
    imports++;
    return (original as (...a: unknown[]) => unknown).apply(
      crypto.subtle,
      args,
    );
  };
  try {
    const times: Record<string, number> = {};
    let start = performance.now();
    for (let i = 0; i < 200; i++) await local.verify(token);
    times.local200ms = performance.now() - start;
    start = performance.now();
    for (let i = 0; i < 200; i++) await network.verify(token);
    times.remoteHit200ms = performance.now() - start;
    assertEquals(imports, 0, "steady-state keys never re-import");
    assertEquals(fetches, 1, "remote hits never refetch");
    current = replacement.publicJwk;
    now = 60001;
    start = performance.now();
    await Promise.all(
      Array.from({ length: 100 }, () => network.verify(rotated)),
    );
    times.rotation100ConcurrentMs = performance.now() - start;
    assertEquals(fetches, 2, "concurrent rotation shares one fetch");
    assertEquals(imports, 1, "concurrent rotation shares one import");
    console.info(
      "JWT benchmark (diagnostic, not a hardware-specific threshold)",
      times,
    );
  } finally {
    subtle.importKey = original;
  }
});
