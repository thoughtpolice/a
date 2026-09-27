// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  CEDAR_WASM,
  CedarEngine,
  CedarEngineError,
  sharedEngine,
} from "@celld/sec/cedar";
import cedarWasm from "@celld/sec/cedar/wasm";

const CALL = {
  principal: { type: "User", id: "a" },
  action: { type: "Action", id: "read" },
  resource: { type: "Doc", id: "d" },
  context: {},
  policies: { staticPolicies: { p: "permit(principal, action, resource);" } },
  entities: [],
};

Deno.test("the wasm specifier is the compiled module the engine binds", () => {
  assert(cedarWasm instanceof WebAssembly.Module, "a WebAssembly.Module");
  assert(CEDAR_WASM === cedarWasm, "the same module");
  const engine = new CedarEngine(cedarWasm);
  assertEquals(engine.sdkVersion(), "4.13.0");
  assertEquals(engine.langVersion(), "4.5");
});

Deno.test("strings cross in both directions, UTF-8 included", () => {
  const engine = sharedEngine();
  const text =
    'permit(principal, action, resource) when { context.name == "Zoë 🦀" };';
  const parts = engine.policySetTextToParts(text);
  assertEquals(parts, {
    type: "success",
    policies: [text],
    policy_templates: [],
  });
  const answer = engine.isAuthorized({
    ...CALL,
    context: { name: "Zoë 🦀" },
    policies: { staticPolicies: text },
  });
  assert(
    answer.type === "success" && answer.response.decision === "allow",
    JSON.stringify(answer),
  );
});

Deno.test("an argument the FFI cannot read is rejected and retires the instance", () => {
  const engine = new CedarEngine(CEDAR_WASM);
  const before = engine.generation;
  const error = assertThrows(
    () => engine.isAuthorized({} as never),
    CedarEngineError,
    "missing field `principal`",
  );
  assertEquals(error.code, "rejected");
  assertEquals(engine.generation, before + 1);
  // The next call runs on a fresh instance.
  const answer = engine.isAuthorized(CALL);
  assert(answer.type === "success", JSON.stringify(answer));
});

Deno.test("a value JSON.stringify refuses reaches Rust as an error, not a crash", () => {
  const engine = new CedarEngine(CEDAR_WASM);
  const error = assertThrows(
    () => engine.isAuthorized({ ...CALL, context: { n: 1n } as never }),
    CedarEngineError,
  );
  assertEquals(error.code, "rejected");
  assertEquals(engine.sdkVersion(), "4.13.0");
});

Deno.test("nesting past serde's recursion limit is rejected", () => {
  const engine = new CedarEngine(CEDAR_WASM);
  let value: unknown = 1;
  for (let i = 0; i < 1000; i++) value = [value];
  assertThrows(
    () => engine.isAuthorized({ ...CALL, context: { value } as never }),
    CedarEngineError,
    "recursion limit",
  );
});

Deno.test("an instance past maxMemoryBytes is retired after the call", () => {
  const engine = new CedarEngine(CEDAR_WASM, {
    maxMemoryBytes: 4 * 1024 * 1024,
  });
  const small = engine.memoryBytes;
  assert(small <= 4 * 1024 * 1024, `starts at ${small}`);
  const parts = engine.policySetTextToParts(
    "permit(principal, action, resource);\n".repeat(20_000),
  );
  assert(
    parts.type === "success" && parts.policies.length === 20_000,
    "answered",
  );
  assertEquals(engine.generation, 1);
  assertEquals(engine.memoryBytes, small);
});

Deno.test("preparsed sets are per instance", () => {
  const engine = new CedarEngine(CEDAR_WASM);
  assertEquals(engine.preparsePolicySet("x", CALL.policies), {
    type: "success",
  });
  const call = { ...CALL, policies: undefined, preparsedPolicySetId: "x" };
  assert(engine.statefulIsAuthorized(call).type === "success", "found");
  engine.reset();
  const missing = engine.statefulIsAuthorized(call);
  assert(
    missing.type === "failure" && /not found/.test(missing.errors[0].message),
    JSON.stringify(missing),
  );
});

Deno.test("a module that is not cedar-wasm does not load", () => {
  const empty = new WebAssembly.Module(
    new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
  );
  const error = assertThrows(
    () => new CedarEngine(empty),
    CedarEngineError,
    "does not export",
  );
  assertEquals(error.code, "load");
});
