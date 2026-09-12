// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared by the ordinary, optimized, and alternate-engine Wasm runs.
import { checker } from "./checker.mjs";

export function checkDelegates(exports, assert) {
  const delegates = checker(exports, assert, "Tests.Delegates.", {
    reset: ["StaticMethodGroup", [4], 9, "delegate fault reset"],
  });
  const { expect, trap } = delegates;

  expect("StaticMethodGroup", [4], 9);
  expect("Lambdas", [4], 9006);
  expect("InstanceMethodGroup", [4], 7);
  expect("VirtualMethodGroup", [1], 22011);
  expect("InterfaceMethodGroup", [6], -6);
  trap("NullInvoke", [0], 5);
  expect("NullInvoke", [1], 5);
  trap("NullInstanceTarget", [0], 10);
  expect("NullInstanceTarget", [1], 0);
  trap("NullVirtualTarget", [0], 5);
  expect("NullVirtualTarget", [1], 11);
  expect("ConditionalInvoke", [0], 0);
  expect("ConditionalInvoke", [1], 15);
  expect("NullChecks", [0], 101);
  expect("NullChecks", [1], 1010);
  expect("Fields", [5], 604);
  expect("Arrays", [5], 9);
  expect("HigherOrder", [5], 115);
  expect("Folding", [4], 11);
  expect("ClosureMutation", [5], 17017);
  expect("ParameterCapture", [1], 16);
  expect("AnonymousMethodCapture", [], 4);
  expect("LoopCaptureFor", [], 333);
  expect("LoopCaptureForeach", [], 123);
  expect("LoopCaptureBodyLocal", [], 24);
  expect("NestedClosures", [0], 111122);
  expect("CaptureThis", [], 16025);
  expect("PatternCapture", [0], 10);
  expect("PatternCapture", [1], 22);
  expect("SwitchCapture", [20], 40);
  expect("SwitchCapture", [3], -3);
  expect("LocalFunctions", [5], 5032);
  expect("LocalFunctionDelegates", [7], 101 * 1000 - 7);
  expect("ConstructorCapture", [3], 1104);
  expect("LocalFunctionThis", [3], 23);
  expect("ArmCapture", [0], 10);
  expect("ArmCapture", [4], 28);
  return delegates.checks;
}
