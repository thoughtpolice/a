// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import { CloudflareClient } from "@celld/api/cloudflare";
import {
  chooseCloudflareIntegration,
  cloudflareFromReflection,
  integrationOrigin,
} from "@celld/api/cloudflare/reflection";

Deno.test("reflection finds the Cloudflare HTTP proxy", async () => {
  const listed = [
    {
      name: "neon-serverless",
      type: "http-proxy",
      help: "curl https://neon-serverless.int.exe.xyz/",
      raw: {},
    },
    { name: "cloudflare", type: "wire", comment: "not a proxy", raw: {} },
    {
      name: "cloudflare",
      type: "http-proxy",
      help: "curl https://cloudflare.int.exe.xyz/",
      raw: {},
    },
  ];
  assertEquals(chooseCloudflareIntegration(listed)?.type, "http-proxy");
  assertEquals(
    chooseCloudflareIntegration(listed, "neon-serverless")?.name,
    "neon-serverless",
  );
  assertEquals(chooseCloudflareIntegration([listed[0], listed[1]]), null);
  assertEquals(
    chooseCloudflareIntegration([{
      name: "dns",
      type: "http-proxy",
      comment: "Cloudflare API (DNS and tunnels)",
      raw: {},
    }])?.name,
    "dns",
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
  const cf = await cloudflareFromReflection({
    discovery: { reflection: { integrations: () => Promise.resolve(listed) } },
  });
  assert(
    cf instanceof CloudflareClient &&
      cf.apiUrl === "https://cloudflare.int.exe.xyz/client/v4",
    cf.apiUrl,
  );
  await assertRejects(
    () =>
      cloudflareFromReflection({
        discovery: { reflection: { integrations: () => Promise.resolve([]) } },
      }),
    Error,
    "no Cloudflare",
  );
});
