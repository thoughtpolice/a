// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Statics, enums, switches, patterns, properties, partial classes, export
// naming and the wider numeric types. The module is instantiated here so the
// static-initialization retry can be driven through a host import.
import { checker } from "./checker.mjs";

export function checkFeatures(module, assert) {
  let hostValue = 0;
  const { exports } = new WebAssembly.Instance(module, {
    features: { read: () => hostValue },
  });
  const features = checker(exports, assert, "Tests.");
  const { equal, trap } = features;
  const call = (name, ...args) => exports["Tests." + name](...args);

  const exportNames = WebAssembly.Module.exports(module).map(({ name }) =>
    name
  );
  for (
    const name of [
      "tick",
      "Tests.Game.Inner.Chain",
      "Tests.Exposed.Visible",
      "Tests.Lazy.Inverse",
    ]
  ) {
    equal(exportNames.includes(name), true, `${name} is exported`);
  }
  for (
    const name of [
      "Tests.Game.Tick",
      "Tests.Hidden.NotExported",
      "Tests.Exposed.AlsoNotExported",
      "Tests.Exposed.NotScalar",
      "Tests.Host.Read",
    ]
  ) {
    equal(exportNames.includes(name), false, `${name} is not exported`);
  }

  // Static initialization runs on the first entry and is retried after a fault.
  trap("Lazy.Inverse", [], 7);
  trap("Numbers.Absolute", [1], 7);
  hostValue = 5;
  equal(
    call("Lazy.Inverse"),
    20,
    "initialization succeeds once the host cooperates",
  );
  equal(call("Counter.Next"), 7, "first call");
  equal(call("Counter.Next"), 14, "static state persists");
  equal(
    call("Counter.CallCount"),
    203,
    "static properties, bodied and automatic",
  );
  equal(
    call("InitOrder.Sum"),
    34,
    "initializer order, then the static constructor",
  );
  equal(
    call("StaticConstructorOrder.Get"),
    6,
    "static constructor after a later field initializer",
  );
  equal(
    call("StaticConstructorOrder.Log"),
    1312,
    "every field initializer, then the static constructor",
  );
  hostValue = 0;
  equal(call("Lazy.Inverse"), 20, "initialization does not run again");

  // Switch statements and expressions, patterns.
  for (
    const [input, expected] of [
      [0, 100],
      [1, 200],
      [2, 200],
      [3, 306],
      [150, 400],
      [250, 900],
      [-5, 500],
      [50, 900],
    ]
  ) {
    equal(call("Switches.Classify", input), expected, `Classify(${input})`);
  }
  equal(
    call("Switches.SwitchBreak", 6),
    422,
    "break and continue inside switch",
  );
  for (
    const [input, expected] of [
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 20],
    ]
  ) {
    equal(
      call("Switches.SharedDefault", input),
      expected,
      `SharedDefault(${input})`,
    );
  }
  equal(call("Switches.KindScore", 1), 1, "enum switch expression");
  equal(call("Switches.KindScore", 3), 2, "or pattern");
  equal(call("Switches.KindScore", 257), 1, "byte enum argument canonicalized");
  equal(call("Switches.LevelWeight", 2), 4, "exhaustive by hand");
  trap("Switches.LevelWeight", [4], 11);
  equal(call("Switches.IsPattern", 15), 1, "relational and pattern");
  equal(call("Switches.IsPattern", 6), 2, "constant or pattern");
  equal(call("Switches.IsPattern", 20), 0, "no pattern");
  equal(call("Switches.NotNull", 0), 1, "is not null");
  equal(call("Switches.NotNull", 1), 0, "is not null on null");
  equal(call("Switches.DoWhile", 4), 8, "do/while with continue");
  equal(call("Switches.DoWhile", 0), 1, "do/while body runs once");
  for (
    const [input, expected] of [
      [7, 8],
      [2, 50],
      [3, 30],
    ]
  ) {
    equal(
      call("Switches.DefaultDeclares", input),
      expected,
      `DefaultDeclares(${input})`,
    );
  }
  equal(call("Switches.NaNCase", NaN), 1, "NaN constant pattern");
  equal(call("Switches.NaNCase", -0), 2, "negative zero matches zero");
  equal(call("Switches.NaNCase", 1), 3, "default");

  // Flags and narrow enums.
  equal(call("Flags.Press", 1, 8), 9, "or");
  equal(call("Flags.Held", 9, 8), 1, "and");
  equal(call("Flags.Held", 9, 0), 0, "None is never held");
  equal(call("Flags.Toggle", 9, 1), 8, "xor");
  equal(call("Flags.Release", 31, 2), 29, "and not");
  equal(call("Flags.NextKind", 3), 4, "enum arithmetic");
  equal(call("Flags.NextKind", 255), 0, "byte enum arithmetic wraps");
  equal(call("Flags.Underlying", 2), 202, "enum conversions");

  // Properties, constructor chaining, ?? and discards.
  equal(
    call("Properties.Basic"),
    39042,
    "auto, bodied and get-only properties",
  );
  equal(
    call("Properties.Backed", -5),
    1,
    "field keyword with clamping setters",
  );
  equal(call("Properties.Backed", 7), 708, "field keyword");
  equal(call("Properties.Discard"), 1, "discarded expressions still evaluate");
  equal(call("Properties.Coalesce", 0), 1, "?? keeps a non-null value");
  equal(call("Properties.Coalesce", 1), 7, "?? evaluates the fallback");
  trap("Properties.NullProperty", [], 5);

  // Partial classes and methods, nested classes, export naming.
  equal(exports.tick(16), 16, "WasmExport name");
  equal(exports.tick(16), 32, "partial method body sees static state");
  equal(
    call("Game.Inner.Chain", 4),
    10,
    "nested class with nested sealed class",
  );
  equal(call("Exposed.Visible"), 3, "public method of a public class");

  // Wider numeric types cross the boundary as i32/i64.
  equal(call("Numbers.Wide", 3n, 4n), 10n, "i64 arithmetic");
  equal(call("Numbers.Wide", -8n, 4n), -35n, "signed i64 shift");
  equal(
    call("Numbers.Unsigned", 2n ** 64n - 1n, 10),
    1844674407370955166n,
    "unsigned 64-bit division",
  );
  equal(
    call("Numbers.UnsignedDivide", -1, 2),
    2147483647,
    "unsigned 32-bit division",
  );
  equal(call("Numbers.UnsignedLess", -1, 1), 0, "unsigned comparison");
  equal(call("Numbers.Saturate", 1e10), 2147483647, "double to int saturates");
  equal(
    call("Numbers.Saturate", -1e10),
    -2147483648,
    "double to int saturates below",
  );
  equal(call("Numbers.Saturate", NaN), 0, "NaN to int is zero");
  equal(call("Numbers.Saturate", -2.9), -2, "truncation toward zero");
  equal(
    call("Numbers.SaturateUnsigned", -5),
    0,
    "float to uint saturates at zero",
  );
  equal(
    call("Numbers.SaturateUnsigned", 4e9),
    -294967296,
    "float to uint above int range",
  );
  equal(
    call("Numbers.SaturateUnsigned", 5e9),
    -1,
    "float to uint saturates above",
  );
  equal(call("Numbers.ToByte", 300), 44, "int to byte wraps");
  equal(call("Numbers.ToByte", -1), 255, "negative int to byte wraps");
  equal(call("Numbers.ToSByte", 200), -56, "int to sbyte wraps");
  equal(call("Numbers.Shorten", 70000n), 4464, "long to short wraps");
  equal(call("Numbers.NextChar", 65), 66, "char arithmetic");
  equal(call("Numbers.NextChar", 65535), 0, "char wraps");
  equal(call("Numbers.CharCode", 65601), 65, "char argument canonicalized");
  equal(
    call("Numbers.ByteWrap", 10),
    5,
    "byte increment and compound assignment wrap",
  );
  equal(call("Numbers.Extend", -1), -1n, "int to long sign-extends");
  equal(
    call("Numbers.ExtendUnsigned", -1),
    4294967295n,
    "uint to ulong zero-extends",
  );
  equal(
    call("Numbers.ShiftWide", 1n, 40),
    1099511627776n,
    "long shifted by an int",
  );
  equal(call("Numbers.ShiftWide", 1n, 65), 2n, "shift count masked");
  equal(call("Numbers.Mixed", 0.5, 2n), 2.5, "float and long widen to double");
  equal(
    call("Numbers.FromUnsignedLong", -1n),
    18446744073709552000,
    "ulong to float is unsigned",
  );
  equal(call("Numbers.Absolute", -7), 7, "Math.Abs");
  trap("Numbers.Absolute", [-2147483648], 9);
  equal(call("Numbers.Clamp", 15, 0, 10), 10, "Math.Clamp");
  equal(call("Numbers.Clamp", -3, 0, 10), 0, "Math.Clamp below");
  trap("Numbers.Clamp", [1, 5, 0], 10);
  equal(call("Numbers.Round", 2.5), 2, "Math.Round rounds half to even");
  equal(call("Numbers.Round", -3.5), -4, "Math.Round negative half");
  equal(call("Numbers.Sqrt", 2.25), 1.5, "MathF.Sqrt");
  equal(call("Numbers.Max", -0, 0), 0, "Math.Max orders signed zeros");
  equal(
    Object.is(call("Numbers.Max", -0, 0), 0),
    true,
    "Math.Max returns positive zero",
  );
  equal(
    Number.isNaN(call("Numbers.Max", NaN, 1)),
    true,
    "Math.Max propagates NaN",
  );
  equal(call("Numbers.PopCount", 0xf0f0), 8, "BitOperations.PopCount");
  equal(call("Numbers.Rotate", 0x80000001, 1), 3, "BitOperations.RotateLeft");
  equal(call("Numbers.IsNaN", NaN), 1, "double.IsNaN");
  equal(call("Numbers.IsNaN", 1), 0, "double.IsNaN on a number");
  equal(call("Numbers.IsFinite", Infinity), 0, "float.IsFinite on infinity");
  equal(call("Numbers.IsFinite", 1.5), 1, "float.IsFinite");
  return features.checks;
}
