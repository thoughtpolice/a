// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs).
import { checker } from "./checker.mjs";

export function checkStrings(exports, assert) {
  const strings = checker(exports, assert, "Tests.StringTypes.Strings.", {
    reset: ["Indexer", [2], 99, "strings fault reset"],
  });
  const { expect, trap } = strings;

  expect("Literals", [2], -981235745);
  expect("Literals", [3], 792414708);
  expect("Literals", [5], -1);
  expect("Indexer", [2], 99);
  trap("Indexer", [6], 6);
  trap("NullLength", [], 5);
  expect("Equality", [1], 1100);
  expect("Equality", [2], 111111);
  expect("Concatenation", [-7], -1761778566);
  expect("Integers", [0], 1801706287);
  expect("Integers", [3], 1755167513);
  expect("Integers", [9], -717397370);
  expect("Interpolation", [3], -2133100110);
  expect("Interpolation", [6], -962534781);
  expect("Switches", [0], 10);
  expect("Switches", [2], 21);
  expect("Switches", [3], 30);
  expect("Switches", [9], 140);
  expect("Members", [3], 1759114655);
  trap("Members", [17], 16);
  expect("Collections", [12], -1366433115);
  expect("Fields", [9], -2108378802);
  expect("Exceptions", [0], -1);
  expect("Exceptions", [1], 101);
  expect("Exceptions", [5], -2);
  expect("Substrings", [3], 0);
  trap("Substrings", [2], 16);
  return strings.checks;
}
