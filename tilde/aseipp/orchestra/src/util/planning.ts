// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Target-manifest validation and deterministic Buck invocation partitioning.
 *
 * Planner agents return untrusted JSON, so this module converts it into the
 * persisted domain model before an Epoch changes state. It also groups tests
 * by Buck execution platform and splits each group into stable coarse batches.
 * The deliberately small prototype batch size makes the two-stage scheduling
 * behavior visible in tests; production policy can replace it independently.
 *
 * @module
 */

import type { JsonObject, PlannedTest, TargetManifest } from "../model.ts";
import { TARGET_MANIFEST_VERSION } from "./constants.ts";
import { requireInteger, requireName, requireString } from "./http.ts";

/** Maximum number of selected tests accepted in one epoch plan. */
export const MAX_MANIFEST_TESTS = 10_000;

/** Prototype maximum number of targets placed in one Buck invocation. */
export const TESTS_PER_BATCH = 2;

/** Requires an untyped value to be a JSON object. */
function object(value: unknown, field: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${field} must be an object`);
  }
  return value as JsonObject;
}

/** Validates one planner-selected test and supplies no implicit routing data. */
function plannedTest(value: unknown, index: number): PlannedTest {
  const input = object(value, `manifest.tests[${index}]`);
  if (typeof input.changed !== "boolean") {
    throw new TypeError(`manifest.tests[${index}].changed must be a boolean`);
  }
  const selectionDepth = requireInteger(
    input.selection_depth,
    `manifest.tests[${index}].selection_depth`,
  );
  if (input.changed !== (selectionDepth === 0)) {
    throw new TypeError(
      `manifest.tests[${index}].changed must be true exactly when selection_depth is zero`,
    );
  }
  const affectedDependency = input.affected_dependency === null
    ? null
    : requireString(
      input.affected_dependency,
      `manifest.tests[${index}].affected_dependency`,
    );
  if ((selectionDepth === 0) !== (affectedDependency === null)) {
    throw new TypeError(
      `manifest.tests[${index}].affected_dependency must be null exactly when selection_depth is zero`,
    );
  }
  return {
    id: requireName(input.id, `manifest.tests[${index}].id`),
    test_key: requireString(
      input.test_key,
      `manifest.tests[${index}].test_key`,
    ),
    label: requireString(input.label, `manifest.tests[${index}].label`),
    rule_type: requireString(
      input.rule_type,
      `manifest.tests[${index}].rule_type`,
    ),
    platform: requireString(
      input.platform,
      `manifest.tests[${index}].platform`,
    ),
    changed: input.changed,
    selection_depth: selectionDepth,
    selection_reason: requireString(
      input.selection_reason,
      `manifest.tests[${index}].selection_reason`,
    ),
    affected_dependency: affectedDependency,
  };
}

/**
 * Validates an inline tdutil manifest against the immutable epoch endpoints.
 *
 * Test IDs must be unique and order is preserved because it feeds stable batch
 * construction. The digest is treated as an opaque content identity here; the
 * planner owns hashing the serialized artifact and agents will eventually
 * exchange only a digest-backed artifact reference.
 */
export function normalizeManifest(
  value: unknown,
  baseRevision: string | null,
  revision: string,
): TargetManifest {
  const input = object(value, "manifest");
  const inputBase = input.base_revision === null
    ? null
    : requireString(input.base_revision, "manifest.base_revision");
  const inputRevision = requireString(input.revision, "manifest.revision");
  if (inputBase !== baseRevision || inputRevision !== revision) {
    throw new TypeError("manifest endpoints do not match the epoch");
  }
  if (!Array.isArray(input.tests) || input.tests.length > MAX_MANIFEST_TESTS) {
    throw new TypeError(
      `manifest.tests must be an array with at most ${MAX_MANIFEST_TESTS} entries`,
    );
  }
  const ids = new Set<string>();
  const testKeys = new Set<string>();
  const tests = input.tests.map((entry, index) => {
    const test = plannedTest(entry, index);
    if (ids.has(test.id)) throw new TypeError(`duplicate test id ${test.id}`);
    if (testKeys.has(test.test_key)) {
      throw new TypeError(`duplicate test key ${test.test_key}`);
    }
    ids.add(test.id);
    testKeys.add(test.test_key);
    return test;
  });
  if (
    !Array.isArray(input.universe) || input.universe.length === 0 ||
    input.universe.length > 1_000
  ) {
    throw new TypeError(
      "manifest.universe must contain between 1 and 1000 patterns",
    );
  }
  const universe = input.universe.map((pattern, index) =>
    requireString(pattern, `manifest.universe[${index}]`)
  );
  const version = requireInteger(
    input.version,
    "manifest.version",
    TARGET_MANIFEST_VERSION,
  );
  if (version !== TARGET_MANIFEST_VERSION) {
    throw new TypeError(`manifest.version must be ${TARGET_MANIFEST_VERSION}`);
  }
  return {
    version,
    digest: requireString(input.digest, "manifest.digest"),
    base_revision: inputBase,
    revision: inputRevision,
    base_commit: requireString(input.base_commit, "manifest.base_commit"),
    revision_commit: requireString(
      input.revision_commit,
      "manifest.revision_commit",
    ),
    universe,
    tests,
  };
}
