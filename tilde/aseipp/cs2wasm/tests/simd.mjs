// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// tests/SimdPlatform.cs: what .NET leaves to the platform
// about vectors, as it is here.
import { checker } from "./checker.mjs";

export function checkSimd(exports, assert) {
  const simd = checker(exports, assert, "Tests.SimdPlatform.Platform.", {
    reset: ["Acceleration", [], 97, "simd fault reset"],
  });
  const { equal, expect, trap } = simd;

  // Vector128 is Wasm's v128; nothing else is accelerated, so framework code
  // takes its 128-bit or scalar paths.
  expect("Acceleration", [], 1 + 32 + 64);

  // MinNative and MaxNative are x64's minps and maxps (f32x4.pmin and pmax
  // with the operands swapped): the second operand where either is NaN or
  // both are zero. Min and Max propagate NaN and order -0 below +0.
  const call = (name, ...args) =>
    exports[`Tests.SimdPlatform.Platform.${name}`](...args);
  equal(call("MinNative", NaN, 1), 1, "MinNative(NaN, 1)");
  equal(Number.isNaN(call("MinNative", 1, NaN)), true, "MinNative(1, NaN)");
  equal(Object.is(call("MinNative", -0, 0), 0), true, "MinNative(-0, 0)");
  equal(Object.is(call("MinNative", 0, -0), -0), true, "MinNative(0, -0)");
  equal(call("MaxNative", NaN, 1), 1, "MaxNative(NaN, 1)");
  equal(Object.is(call("MaxNative", 0, -0), -0), true, "MaxNative(0, -0)");
  equal(call("MinNative", 2, 3), 2, "MinNative of ordered values");
  equal(call("MinNativeDouble", NaN, 1), 1, "MinNative of doubles");

  // A native conversion saturates, NaN to zero (arm64's, not x64's).
  expect("ConvertNative", [NaN], 0);
  expect("ConvertNative", [3e9], 2147483647);

  // (1 + 2^-12)^2 - 1: the estimate rounds the product first (2^-11), a
  // fused multiply-add once (2^-11 + 2^-24), exactly.
  const a = 1 + 2 ** -12;
  expect("Estimate", [a, a, -1], 2 ** -11);
  expect("Fused", [a, a, -1], 2 ** -11 + 2 ** -24);
  expect("ScalarFused", [a, a, -1], 2 ** -11 + 2 ** -24);
  const d = 1 + 2 ** -30;
  expect("FusedDouble", [d, d, -1], 2 ** -29 + 2 ** -60);
  // Lerp is an estimate of x * (1 - t) + y * t.
  expect("Lerp", [1, 3, 0.25], 1.5);

  // Unsafe.Add of a reference to a variable: nothing but itself.
  expect("MovedLocal", [0], 7);
  trap("MovedLocal", [1], 19);
  return simd.checks;
}
