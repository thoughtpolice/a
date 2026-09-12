// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs. The
// expected values are the CLR's (see tests/differential.mjs), digests of
// the text numbers, enums and objects format as.
import { checker } from "./checker.mjs";

export function checkFormatting(exports, assert) {
  const formatting = checker(exports, assert, "Tests.Formatting.Formatting.", {
    reset: ["Enums", [5], 88, "formatting fault reset"],
  });
  const { expect, trap } = formatting;

  expect("Doubles", [3], -403875840);
  expect("Singles", [5], -2052519254);
  expect("Integers", [7], -1805579932);
  expect("Special", [100], -1336916400);
  expect("Enums", [5], 88);
  expect("Enums", [15], -238574590);
  expect("Names", [10], 872311492);
  expect("Hashes", [-129], -1955623657);
  expect("Interpolation", [22], 449349324);
  expect("Concatenation", [7], 1482930809);
  // A bad format string throws FormatException.
  trap("BadFormat", [0], 17);
  // A thrown exception prints as the CLR's text without its stack trace.
  expect("ThrownText", [], 27);
  return formatting.checks;
}
