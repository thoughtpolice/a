// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Affected-only manifest boundary regressions. Planning never requires a head
 * inventory, and an empty affected list says nothing about target deletion.
 * Existing prototype limits fail explicitly rather than truncate coverage.
 * @module
 */
import type { TargetManifest } from "../model.ts";
import { MAX_MANIFEST_TESTS, normalizeManifest } from "./planning.ts";
import { assert, assertEquals, plannedTest } from "./testing.ts";

/** Minimal affected-only interval; no repository inventory accompanies it. */
function manifest(): TargetManifest {
  return {
    version: 2,
    digest: "fixture",
    base_revision: "base",
    revision: "head",
    base_commit: "base",
    revision_commit: "head",
    universe: ["root//..."],
    tests: [],
  };
}

Deno.test("affected-only manifests accept empty and nonempty selections without inventory", () => {
  const input = manifest();
  assertEquals(normalizeManifest(input, "base", "head"), input);
  input.tests = [plannedTest()];
  const normalized = normalizeManifest(input, "base", "head");
  assertEquals(normalized.tests.length, 1);
  for (
    const key of Object.keys(input.tests[0]) as (keyof typeof input.tests[0])[]
  ) {
    assertEquals(normalized.tests[0][key], input.tests[0][key]);
  }
  assertEquals(
    Object.keys(normalized.tests[0]).length,
    Object.keys(input.tests[0]).length,
  );
  assert(!("inventory" in normalized));
});

Deno.test("unknown inventory metadata is neither consulted nor retained", () => {
  const input = manifest();
  // Old artifacts can contain extra fields. A poison getter proves the
  // normalizer does not scan or depend on the removed inventory protocol.
  Object.defineProperty(input, "inventory", {
    get() {
      throw new Error("must not read a whole-head inventory");
    },
  });
  const normalized = normalizeManifest(input, "base", "head");
  assert(!("inventory" in normalized));
  assertEquals(normalized.tests, []);
});

Deno.test("manifest bounds and membership fail closed without truncating affected tests", () => {
  const input = manifest();
  for (
    const tests of [null, new Array(MAX_MANIFEST_TESTS + 1), [
      plannedTest(),
      plannedTest(),
    ]]
  ) {
    let error: unknown;
    try {
      normalizeManifest({ ...input, tests }, "base", "head");
    } catch (caught) {
      error = caught;
    }
    assert(error instanceof TypeError);
  }
});
