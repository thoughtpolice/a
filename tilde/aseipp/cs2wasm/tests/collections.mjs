// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs).
import { checker } from "./checker.mjs";

export function checkCollections(exports, assert) {
  const collections = checker(
    exports,
    assert,
    "Tests.CollectionTypes.Collections.",
    {
      reset: ["ListForeach", [4], 1803, "collections fault reset"],
    },
  );
  const { expect, trap } = collections;

  expect("ListBasics", [5], -662275450);
  expect("ListForeach", [4], 1803);
  expect("ListGrowth", [9], -1138881986);
  expect("ListPredicates", [3], 14901671);
  expect("ListOfStructs", [5], 923873130);
  expect("ListOfReferences", [4], 12560);
  expect("FloatEquality", [0], 1);
  expect("FloatEquality", [1], 2);
  expect("FloatEquality", [3], 0);
  // Enumeration order after a seeded run of adds and removes.
  expect("DictionaryOrder", [7], 1185246536);
  expect("HashSetOrder", [7], -2080437306);
  expect("DictionaryBasics", [3], -479243316);
  expect("ReferenceKeys", [6], -1707846820);
  expect("InterfaceKeys", [5], 143537220);
  expect("StructKeys", [9], 528147599);
  expect("NullElements", [0], 1);
  expect("NullElements", [1], 1);
  expect("Queues", [10], 1716378263);
  expect("Stacks", [9], 1976350169);
  expect("Nested", [7], 13049887);
  expect("Indexers", [4], 10005094);
  expect("Indexers", [-9], 10004977);
  trap("NullIndexer", [], 5);
  // Adding while enumerating faults; removing from a Dictionary does not.
  trap("ListModifiedWhileEnumerating", [0], 14);
  trap("ListModifiedWhileEnumerating", [1], 14);
  expect("ListModifiedWhileEnumerating", [4], 9);
  trap("DictionaryModifiedWhileEnumerating", [0], 14);
  expect("DictionaryModifiedWhileEnumerating", [3], 6);
  trap("KeysModifiedWhileEnumerating", [0], 14);
  expect("KeysModifiedWhileEnumerating", [1], 6);
  trap("HashSetModifiedWhileEnumerating", [0], 14);
  trap("QueueModifiedWhileEnumerating", [0], 14);
  trap("ListForEachModified", [], 14);
  trap("ListFaults", [0], 16);
  trap("ListFaults", [4], 16);
  trap("DictionaryFaults", [0], 15);
  trap("DictionaryFaults", [1], 10);
  trap("DictionaryFaults", [2], 10);
  trap("EmptyFaults", [2], 14);
  return collections.checks;
}
