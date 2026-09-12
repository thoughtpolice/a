// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Portable expectations shared by V8, SpiderMonkey and Binaryen output.
import { checker } from "./checker.mjs";

export function checkSyntax(exports, assert) {
  const syntax = checker(exports, assert, "Tests.Syntax.", {
    reset: ["AddAssignment", [20, 22], 42, "fault reset"],
  });
  const { expect, trap } = syntax;

  expect("Arithmetic", [10, 4], 1);
  expect("Arithmetic", [-10, -4], -7);
  expect("AddAssignment", [2147483647, 1], -2147483648);
  expect("DivideAssignment", [-7, 3], -2);
  expect("RemainderAssignment", [-7, 3], -1);
  expect("Bitwise", [0x37, 0x2f], 0x408);
  for (const count of [-1, 0, 1, 31, 32, 33]) {
    expect("LeftShiftAssignment", [-8, count], -8 << count);
    expect("RightShiftAssignment", [-8, count], -8 >> count);
    expect("UnsignedShiftAssignment", [-8, count], (-8 >>> count) | 0);
  }
  expect("AssignmentValue", [11, 3], 1414);
  expect("FloatArithmetic", [2.5, 1.25], 1.375);
  expect("DoubleArithmetic", [2.5, 1.25], 1.375);
  expect("MixedArithmetic", [1.25, 3], 4.25);
  expect("BooleanEager", [0], 3331);
  expect("BooleanEager", [1], 3330);
  expect("FieldEvaluationOrder", [], 13132);
  expect("ArrayEvaluationOrder", [], 123132);
  expect("NestedAssignment", [], 1412);
  expect("ForeachSum", [0], 0);
  expect("ForeachSum", [1], 1);
  expect("ForeachSum", [10], 55);
  expect("ForeachControl", [], 8);
  expect("ForeachNested", [], 88);
  expect("ForeachCollectionOnce", [], 106);
  expect("ForeachMutation", [], 51);
  expect("ForeachReferences", [], 18);
  expect("ForeachJagged", [], 10);
  expect("ForeachWidening", [], 3);
  expect("ForeachFloatConversion", [], 6.875);
  expect("ForeachBooleans", [], 2);
  expect("ForeachEarlyReturn", [7], 7);
  expect("ForeachEarlyReturn", [5], -1);
  trap("DivideAssignment", [1, 0], 7);
  trap("DivideAssignment", [-2147483648, -1], 8);
  trap("RemainderAssignment", [1, 0], 7);
  trap("RemainderAssignment", [-2147483648, -1], 8);
  trap("NullCompoundOrder", [0], 5);
  trap("NullArrayCompoundOrder", [0], 5);
  trap("BoundsCompoundOrder", [0], 6);
  trap("IndexFaultBeforeNull", [0], 7);
  trap("ForeachNull", [], 5);
  trap("ForeachFuel", [], 1);
  return syntax.checks;
}
