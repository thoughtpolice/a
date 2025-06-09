// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert";
import {
  buck2TargetProvidersResource,
  buck2TargetsResource,
} from "../resources/buck2.ts";

Deno.test("buck2TargetsResource - structure", () => {
  assertEquals(buck2TargetsResource.name, "buck2_targets");
  assertEquals(
    buck2TargetsResource.description,
    "List Buck2 targets matching a pattern",
  );
  assertEquals(buck2TargetsResource.uriTemplate, "buck2://targets/{target}");
  assertEquals(buck2TargetsResource.mimeType, "application/json");
});

Deno.test("buck2TargetProvidersResource - structure", () => {
  assertEquals(buck2TargetProvidersResource.name, "buck2_target_providers");
  assertEquals(
    buck2TargetProvidersResource.description,
    "List Buck2 providers for a specific target",
  );
  assertEquals(
    buck2TargetProvidersResource.uriTemplate,
    "buck2://providers/{target}",
  );
  assertEquals(buck2TargetProvidersResource.mimeType, "application/json");
});

Deno.test("buck2TargetsResource - error handling with invalid target", async () => {
  const uri = new URL("buck2://targets/invalid-target");
  const params = { target: "invalid-target" };

  const result = await buck2TargetsResource.handler(uri, params);

  assertEquals(result.contents.length, 1);
  assertEquals(result.contents[0].mimeType, "application/json");

  const content = JSON.parse(result.contents[0].text as string);
  // Should contain error information
  assertEquals(typeof content.error, "string");
  assertEquals(content.target_pattern, "invalid-target");
});

Deno.test("buck2TargetProvidersResource - error handling with invalid target", async () => {
  const uri = new URL("buck2://providers/invalid-target");
  const params = { target: "invalid-target" };

  const result = await buck2TargetProvidersResource.handler(uri, params);

  assertEquals(result.contents.length, 1);
  assertEquals(result.contents[0].mimeType, "application/json");

  const content = JSON.parse(result.contents[0].text as string);
  // Should contain error information
  assertEquals(typeof content.error, "string");
  assertEquals(content.target, "invalid-target");
});
