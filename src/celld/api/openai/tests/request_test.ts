// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  buildRequest,
  DEFAULT_INSTRUCTIONS,
  encodingFor,
  functionOutput,
  type GptRequest,
  image,
  type Item,
  requestIssues,
  strictSchema,
  user,
} from "@celld/api/openai";
import { v } from "@celld/sieve";

const defaults = { model: "gpt-5.5", instructions: DEFAULT_INSTRUCTIONS };

function messages(request: unknown): string[] {
  return requestIssues(request).map((issue) =>
    `${issue.path.join(".")}: ${issue.message}`
  );
}

const call: Item = {
  type: "function_call",
  call_id: "c1",
  name: "f",
  arguments: "{}",
};

Deno.test("a string input becomes one user message; every Codex invariant is set", async () => {
  const { body, encoding, promptCacheKey } = await buildRequest(
    { input: "hi" },
    defaults,
  );
  assertEquals(encoding, "standard");
  assertEquals(body.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hi" }],
  }]);
  assertEquals(
    [
      body.stream,
      body.store,
      body.include,
      body.instructions,
      body.tool_choice,
      body.parallel_tool_calls,
    ],
    [
      true,
      false,
      ["reasoning.encrypted_content"],
      DEFAULT_INSTRUCTIONS,
      "auto",
      false,
    ],
  );
  assertEquals(body.reasoning, { effort: "medium", summary: "auto" });
  assertEquals(body.prompt_cache_key, promptCacheKey);
  assert(promptCacheKey.startsWith("celld-openai-"), promptCacheKey);
  for (
    const banned of [
      "previous_response_id",
      "max_output_tokens",
      "temperature",
      "tools",
      "text",
    ]
  ) {
    assert(!(banned in body), `${banned} is not sent`);
  }
});

Deno.test("the default cache key is stable for the same prefix and differs otherwise", async () => {
  const a = await buildRequest({ input: "one" }, defaults);
  const b = await buildRequest({ input: "two" }, defaults);
  const c = await buildRequest(
    { input: "one", instructions: "other" },
    defaults,
  );
  assertEquals(a.promptCacheKey, b.promptCacheKey);
  assert(a.promptCacheKey !== c.promptCacheKey, "instructions change the key");
  assertEquals(
    (await buildRequest({ input: "x", promptCacheKey: "conv-1" }, defaults))
      .promptCacheKey,
    "conv-1",
  );
});

Deno.test("tools, verbosity, format and service tier are passed as Codex sends them", async () => {
  const schema = strictSchema(v.object({ ok: v.boolean() }));
  const { body } = await buildRequest({
    input: "x",
    tools: [{
      type: "function",
      name: "f",
      description: "d",
      parameters: schema,
      strict: true,
    }],
    verbosity: "low",
    format: { name: "answer", schema },
    serviceTier: "priority",
    reasoning: { effort: "high", summary: "none" },
  }, defaults);
  assertEquals(body.parallel_tool_calls, true);
  assertEquals((body.tools as unknown[]).length, 1);
  assertEquals(body.text, {
    verbosity: "low",
    format: {
      type: "json_schema",
      name: "answer",
      schema,
      strict: true,
    },
  });
  assertEquals(body.service_tier, "priority");
  assertEquals(body.reasoning, { effort: "high" });
});

Deno.test("GPT-6 models get Codex's lite encoding", async () => {
  assertEquals([
    encodingFor("gpt-6-astra"),
    encodingFor("gpt-5.5"),
    encodingFor("unknown"),
  ], [
    "lite",
    "standard",
    "standard",
  ]);
  const tools = [{
    type: "custom" as const,
    name: "apply_patch",
    description: "d",
  }];
  const first = await buildRequest({
    input: [user("look", image("https://x/y.png", "high"))],
    tools,
    promptCacheKey: "k",
  }, { ...defaults, model: "gpt-6-astra" });
  const body = first.body;
  assertEquals([
    first.encoding,
    "instructions" in body,
    "tools" in body,
    body.parallel_tool_calls,
  ], [
    "lite",
    false,
    false,
    false,
  ]);
  const input = body.input as Record<string, unknown>[];
  assertEquals(input[0].type, "additional_tools");
  assertEquals([input[0].role, input[0].tools], ["developer", tools]);
  assertEquals(input[1].role, "developer");
  assertEquals(
    (input[1].content as { text: string }[])[0].text,
    DEFAULT_INSTRUCTIONS,
  );
  assertEquals((input[2].content as Record<string, unknown>[])[1], {
    type: "input_image",
    image_url: "https://x/y.png",
  });
  assertEquals(
    (body.reasoning as Record<string, unknown>).context,
    "all_turns",
  );
  assertEquals((body.reasoning as Record<string, unknown>).effort, "low");
  const again = await buildRequest({
    input: "other",
    tools,
    promptCacheKey: "k",
  }, { ...defaults, model: "gpt-6-astra" });
  const prefix = (again.body.input as Record<string, unknown>[]).slice(0, 2)
    .map((item) => item.id);
  assertEquals(prefix, input.slice(0, 2).map((item) => item.id));
});

Deno.test("an explicit encoding wins over the catalog", async () => {
  const { encoding, body } = await buildRequest({
    input: "x",
    encoding: "standard",
  }, { ...defaults, model: "gpt-6-sol" });
  assertEquals([encoding, body.instructions], [
    "standard",
    DEFAULT_INSTRUCTIONS,
  ]);
});

Deno.test("unsupported parameters are refused by name", () => {
  assertEquals(
    messages({
      input: "x",
      previousResponseId: "r",
      maxOutputTokens: 5,
      temperature: 1,
      colour: 1,
    }),
    [
      "previousResponseId: not supported by the ChatGPT backend; see the README",
      "maxOutputTokens: not supported by the ChatGPT backend; see the README",
      "temperature: not supported by the ChatGPT backend; see the README",
      "colour: unknown field",
    ],
  );
});

Deno.test("input must be non-blank text or items", () => {
  assertEquals(messages({ input: "  " }), ["input: input must not be blank"]);
  assertEquals(messages({ input: [] }), [
    "input: input needs at least one item",
  ]);
  assertEquals(messages({ input: 5 }), [
    "input: input must be a string or a list of items",
  ]);
  assertEquals(messages({ input: [{ type: "web_search_call" }] }), [
    "input.0.type: items of type web_search_call are not sent by this client",
  ]);
  assertEquals(
    messages({ input: [{ type: "message", role: "boss", content: "x" }] }),
    [
      "input.0.role: role must be user, assistant, developer or system",
    ],
  );
});

Deno.test("tool calls must be answered and outputs must follow a call", () => {
  assertEquals(messages({ input: [call] }), [
    "input.0: tool call c1 has no output; the backend refuses unanswered calls",
  ]);
  assertEquals(messages({ input: [functionOutput("c9", "x")] }), [
    "input.0.call_id: no earlier tool call has call_id c9",
  ]);
  assertEquals(messages({ input: [call, functionOutput("c1", "ok")] }), []);
});

Deno.test("values JSON would change are refused", () => {
  const bad = {
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "x", extra: undefined }],
    }],
  };
  assertEquals(messages(bad), [
    "input.0.content.0.extra: undefined is not JSON; omit the key or use null",
  ]);
});

Deno.test("tool definitions are checked", () => {
  const request = {
    input: "x",
    tools: [
      {
        type: "function",
        name: "a b",
        description: "d",
        parameters: { type: "object" },
        strict: false,
      },
      {
        type: "function",
        name: "f",
        description: "d",
        parameters: { type: "string" },
        strict: false,
      },
      {
        type: "custom",
        name: "g",
        description: "d",
        format: { type: "grammar", syntax: "ebnf", definition: "" },
      },
      { type: "web_search", name: "h", description: "d" },
      { type: "custom", name: "g", description: "d" },
    ],
  };
  assertEquals(messages(request), [
    "tools.0.name: a tool name is 1 to 64 letters, digits, _ or -",
    "tools.1.parameters: function parameters must be an object schema",
    "tools.2.format.syntax: grammar syntax must be lark or regex",
    "tools.2.format.definition: a grammar needs a definition",
    "tools.3.type: only function and custom tools reach this backend",
    "tools.4.name: duplicate tool g",
  ]);
});

Deno.test("strict function parameters must be strict schemas", () => {
  assertEquals(
    messages({
      input: "x",
      tools: [{
        type: "function",
        name: "f",
        description: "d",
        strict: true,
        parameters: { type: "object", properties: { a: { type: "string" } } },
      }],
    }),
    [
      "tools.0.parameters: strict mode needs additionalProperties: false",
      "tools.0.parameters.properties.a: strict mode needs every property in required; use a nullable type instead",
    ],
  );
});

Deno.test("tool choice must name a tool that exists", () => {
  const tools = [{ type: "custom", name: "g", description: "d" }];
  assertEquals(messages({ input: "x", toolChoice: "required" }), [
    "toolChoice: required needs at least one tool",
  ]);
  assertEquals(
    messages({
      input: "x",
      tools,
      toolChoice: { type: "custom", name: "nope" },
    }),
    ["toolChoice.name: no tool named nope"],
  );
  assertEquals(messages({ input: "x", tools, toolChoice: "sometimes" }), [
    "toolChoice: toolChoice must be auto, none, required or a named tool",
  ]);
  assertEquals(
    messages({ input: "x", tools, toolChoice: { type: "custom", name: "g" } }),
    [],
  );
});

Deno.test("reasoning effort is checked against the model's list", () => {
  assertEquals(
    messages({ input: "x", model: "gpt-5.5", reasoning: { effort: "max" } }),
    [
      "reasoning.effort: gpt-5.5 accepts low, medium, high, xhigh",
    ],
  );
  assertEquals(messages({ input: "x", reasoning: { effort: "ultra" } }), [
    "reasoning.effort: effort must be one of none, minimal, low, medium, high, xhigh, max",
  ]);
  assertEquals(
    messages({
      input: "x",
      model: "some-new-model",
      reasoning: { effort: "max", summary: "detailed" },
    }),
    [],
  );
  assertEquals(
    messages({ input: "x", reasoning: { effort: "low", budget: 5 } }),
    ["reasoning.budget: unknown field"],
  );
});

Deno.test("formats need a good name and a strict schema unless strict is off", () => {
  assertEquals(
    messages({
      input: "x",
      format: { name: "has space", schema: strictSchema(v.object({})) },
    }),
    [
      "format.name: a format name is 1 to 64 letters, digits, _ or -",
    ],
  );
  assertEquals(
    messages({ input: "x", format: { name: "a", schema: { type: "array" } } }),
    [
      "format.schema: the root of a strict schema must be an object schema",
    ],
  );
  assertEquals(
    messages({
      input: "x",
      format: { name: "a", strict: false, schema: { type: "array" } },
    }),
    [],
  );
});

Deno.test("instructions, model, cache key and encoding must be sensible", () => {
  const request: Record<string, unknown> = {
    input: "x",
    instructions: " ",
    model: "",
    promptCacheKey: "",
    verbosity: "loud",
    encoding: "fast",
  };
  assertEquals(messages(request as unknown as GptRequest), [
    "instructions: instructions must be non-blank text",
    "model: model must be a non-blank string",
    "verbosity: verbosity must be low, medium or high",
    "promptCacheKey: must be a non-blank string",
    "encoding: encoding must be standard or lite",
  ]);
});
