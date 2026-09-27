// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import { NeonClient } from "@celld/api/neon";
import {
  chooseNeonIntegration,
  integrationOrigin,
  neonFromReflection,
} from "@celld/api/neon/reflection";

Deno.test("reflection finds the Neon HTTP proxy", async () => {
  const listed = [
    {
      name: "typesafe",
      type: "http-proxy",
      help: "curl https://typesafe.int.exe.xyz/",
      raw: {},
    },
    { name: "neon", type: "wire", comment: "Managed SQL database", raw: {} },
    {
      name: "neon-serverless",
      type: "http-proxy",
      help: "curl https://neon-serverless.int.exe.xyz/",
      raw: {},
    },
  ];
  assertEquals(chooseNeonIntegration(listed)?.name, "neon-serverless");
  assertEquals(chooseNeonIntegration(listed, "typesafe")?.name, "typesafe");
  assertEquals(chooseNeonIntegration([listed[1]]), null);
  assertEquals(
    chooseNeonIntegration([{
      name: "db",
      type: "http-proxy",
      comment: "Neon (prod)",
      raw: {},
    }])?.name,
    "db",
  );
  assertEquals(
    integrationOrigin({
      name: "shared",
      type: "http-proxy",
      help: "curl https://shared.team.exe.xyz/",
      raw: {},
    }),
    "https://shared.team.exe.xyz",
  );
  assertEquals(
    integrationOrigin({
      name: "x",
      type: "http-proxy",
      help: "curl https://evil.team.exe.xyz/",
      raw: {},
    }),
    "https://x.int.exe.xyz",
  );
  const db = await neonFromReflection({
    discovery: { reflection: { integrations: () => Promise.resolve(listed) } },
  });
  assert(
    db instanceof NeonClient &&
      db.url === "https://neon-serverless.int.exe.xyz/sql",
    db.url,
  );
  await assertRejects(
    () =>
      neonFromReflection({
        discovery: { reflection: { integrations: () => Promise.resolve([]) } },
      }),
    Error,
    "no Neon",
  );
});
