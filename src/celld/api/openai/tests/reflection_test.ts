// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import type { AttachedIntegration } from "@celld/api/exedev/vm";
import {
  chooseLlmIntegration,
  clientFromReflection,
  describeIntegration,
  discoverLlmIntegration,
} from "@celld/api/openai/reflection";

function integration(
  name: string,
  type: string,
  help = "",
  comment = "",
): AttachedIntegration {
  return { name, type, help, comment, raw: { name, type, help, comment } };
}

const LISTING = {
  integrations: [
    {
      name: "reflection",
      type: "reflection",
      help: "curl https://reflection.int.exe.xyz/",
      comment: "",
    },
    {
      name: "llm",
      type: "llm",
      help: "curl https://llm.int.exe.xyz/v1/models",
      comment: "",
    },
    {
      name: "gpt-sub",
      type: "llm",
      help: "curl https://gpt-sub.team.exe.xyz/v1/models",
      comment: "ChatGPT Pro account",
    },
  ],
};

function reflectionFetch(body: unknown) {
  const urls: string[] = [];
  const fetch = (url: string | URL | Request) => {
    urls.push(url instanceof Request ? url.url : String(url));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch, urls };
}

Deno.test("choosing: by name, else ChatGPT-looking, else llm, else first", () => {
  const list = LISTING.integrations.map((item) =>
    integration(item.name, item.type, item.help, item.comment)
  );
  assertEquals(chooseLlmIntegration(list, "llm")?.name, "llm");
  assertEquals(chooseLlmIntegration(list)?.name, "gpt-sub");
  assertEquals(chooseLlmIntegration(list.slice(0, 2))?.name, "llm");
  assertEquals(
    chooseLlmIntegration([integration("other", "llm")])?.name,
    "other",
  );
  assertEquals(chooseLlmIntegration(list, "missing"), null);
  assertEquals(chooseLlmIntegration([integration("gh", "github")]), null);
});

Deno.test("the help line's host decides personal or team", () => {
  assertEquals(
    describeIntegration(
      integration(
        "gpt-sub",
        "llm",
        "curl https://gpt-sub.team.exe.xyz/v1/models",
      ),
    ).baseUrl,
    "https://gpt-sub.team.exe.xyz/openai/v1",
  );
  assertEquals(
    describeIntegration(
      integration("llm", "llm", "curl https://llm.int.exe.xyz/v1/models"),
      { route: "auto" },
    ).baseUrl,
    "https://llm.int.exe.xyz/v1",
  );
  // A help line naming some other host is not trusted.
  const mismatched = describeIntegration(
    integration("llm", "llm", "curl https://other.team.exe.xyz/v1/models"),
  );
  assertEquals([mismatched.team, mismatched.baseUrl], [
    false,
    "https://llm.int.exe.xyz/openai/v1",
  ]);
});

Deno.test("discovery reads reflection's integration list", async () => {
  const { fetch, urls } = reflectionFetch(LISTING);
  const found = await discoverLlmIntegration({
    fetch,
    reflectionUrl: "http://reflection.test",
  });
  assertEquals([found?.name, found?.team, found?.baseUrl], [
    "gpt-sub",
    true,
    "https://gpt-sub.team.exe.xyz/openai/v1",
  ]);
  assertEquals(urls, ["http://reflection.test/integrations"]);
  assertEquals(
    await discoverLlmIntegration({
      reflection: { integrations: () => Promise.resolve([]) },
    }),
    null,
  );
});

Deno.test("clientFromReflection builds a client, or says why it cannot", async () => {
  const { fetch } = reflectionFetch(LISTING);
  const gpt = await clientFromReflection({
    model: "gpt-6-sol",
    discovery: { fetch, reflectionUrl: "http://reflection.test", name: "llm" },
  });
  assertEquals([gpt.baseUrl, gpt.model], [
    "https://llm.int.exe.xyz/openai/v1",
    "gpt-6-sol",
  ]);
  let message = "";
  try {
    await clientFromReflection({
      discovery: {
        fetch,
        reflectionUrl: "http://reflection.test",
        name: "nope",
      },
    });
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, "no LLM integration named nope is attached to this VM");
  const none = reflectionFetch({ integrations: [] });
  let other = "";
  try {
    await clientFromReflection({
      discovery: { fetch: none.fetch, reflectionUrl: "http://reflection.test" },
    });
  } catch (error) {
    other = (error as Error).message;
  }
  assert(other === "no LLM integration is attached to this VM", other);
});
