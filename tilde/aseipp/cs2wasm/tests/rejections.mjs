// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Sources that must produce a policy or Roslyn error without writing Wasm.
export const rejectionCases = {
  unsafe: `
public static unsafe class Bad
{
    public static int F(int* p) => *p;
}
`,
  framework: `
public static class Bad
{
    public static int F()
    {
        System.Environment.Exit(0);
        return 0;
    }
}
`,
  byref: `
public static class Bad
{
    public static int F()
    {
        int x = 0;
        ref int y = ref x;
        return y;
    }
}
`,
  constructor_base_initializer: `
public sealed class Bad
{
    public Bad() : base() { }
    public static int F() => 1;
}
`,
  constructor_optional: `
public sealed class Bad
{
    public Bad(int value = 1) { }
    public static int F() => 1;
}
`,
  constructor_byref: `
public sealed class Bad
{
    public Bad(ref int value) { }
    public static int F() => 1;
}
`,
  constructor_framework_call: `
public sealed class Bad
{
    public Bad() { System.Environment.Exit(0); }
    public static int F() => 1;
}
`,
  constructor_primary: `
public sealed class Bad(int value)
{
    public static int F() => 1;
}
`,
  checked: `
public static class Bad
{
    public static int F(int x) => checked(x + 1);
}
`,
  string: `
public static class Bad
{
    public static string F() => "no";
}
`,
  objectlocal: `
public static class Bad
{
    public static bool F()
    {
        object x = null;
        return x == null;
    }
}
`,
  objectcast: `
public sealed class Node
{
}

public static class Bad
{
    public static bool F() => (object)new Node() == null;
}
`,
  boxing: `
public static class Bad
{
    public static bool F(int x) => (object)x == null;
}
`,
  versiondirective: `#error version
public static class Bad
{
    public static int F() => 1;
}
`,
  generic: `
public static class Bad
{
    public static T F<T>(T x) => x;
}
`,
  inheritance: `
public class Bad
{
    public static int F() => 1;
}
`,
  struct: `
public struct Bad
{
    public static int F() => 1;
}
`,
  checked_compound: `
public static class Bad
{
    public static int F(int x)
    {
        checked { x += 1; }
        return x;
    }
}
`,
  initializer_framework_call: `
public sealed class Bad
{
    public int X = System.Environment.TickCount;
    public static int F() => 1;
}
`,
  floating_remainder_compound: `
public static class Bad
{
    public static float F(float x) { x %= 2; return x; }
}
`,
  foreach_ref: `
public static class Bad
{
    public static int F() { foreach (ref int x in new int[1]) x++; return 0; }
}
`,
  import_instance: `
public sealed class Bad
{
    [Gameplay.WasmImport("game", "bad")]
    public extern int Imported();
    public static int F() => 1;
}
`,
  import_body: `
public static class Bad
{
    [Gameplay.WasmImport("game", "bad")]
    public static int Imported() => 1;
    public static int F() => Imported();
}
`,
  import_reference: `
public static class Bad
{
    [Gameplay.WasmImport("game", "bad")]
    public static extern int Imported(int[] values);
    public static int F() => 1;
}
`,
  import_duplicate: `
public static class Bad
{
    [Gameplay.WasmImport("game", "same")]
    public static extern int First(int x);
    [Gameplay.WasmImport("game", "same")]
    public static extern float Second(float x);
    public static int F() => 1;
}
`,
  import_empty_name: `
public static class Bad
{
    [Gameplay.WasmImport("game", "")]
    public static extern int Imported();
    public static int F() => 1;
}
`,
  import_high_surrogate: String.raw`
public static class Bad
{
    [Gameplay.WasmImport("game", "\ud800")]
    public static extern int Imported();
    public static int F() => 1;
}
`,
  import_low_surrogate: String.raw`
public static class Bad
{
    [Gameplay.WasmImport("\udc00", "name")]
    public static extern int Imported();
    public static int F() => 1;
}
`,
  import_return_attribute: `
public static class Bad
{
    [Gameplay.WasmImport("game", "name")]
    [return: System.Diagnostics.CodeAnalysis.NotNull]
    public static extern int Imported();
    public static int F() => 1;
}
`,
  optional: `
public static class Bad
{
    public static int F(int x = 1) => x;
}
`,
  goto: `
public static class Bad
{
    public static int F()
    {
    L:
        goto L;
    }
}
`,
  unused: `
public static class Bad
{
    private static int G()
    {
        System.Environment.Exit(0);
        return 0;
    }

    public static int F() => 1;
}
`,
  indexer: `
public sealed class Bad
{
    public int this[int index] => index;
    public static int F() => 1;
}
`,
  interface_declaration: `
public interface IBad
{
    int F();
}
public static class Bad
{
    public static int F() => 1;
}
`,
  record_declaration: `
public sealed record Bad(int X);
public static class Entry
{
    public static int F() => 1;
}
`,
  goto_case: `
public static class Bad
{
    public static int F(int x)
    {
        switch (x)
        {
            case 1: goto case 2;
            case 2: return 2;
        }
        return 0;
    }
}
`,
  declaration_pattern: `
public static class Bad
{
    public static int F(int x) => x switch { int y when y > 0 => y, _ => 0 };
}
`,
  string_switch: `
public static class Bad
{
    public static int F(string s) => s switch { "a" => 1, _ => 0 };
}
`,
  nullable_value: `
public static class Bad
{
    public static int F(int? x) => x ?? 0;
}
`,
  coalesce_assignment: `
public sealed class Node
{
}
public static class Bad
{
    public static int F()
    {
        Node node = null;
        node ??= new Node();
        return 1;
    }
}
`,
  lambda: `
public static class Bad
{
    public static int F()
    {
        System.Func<int> f = () => 1;
        return f();
    }
}
`,
  volatile_field: `
public sealed class Bad
{
    public volatile int X;
    public static int F() => 1;
}
`,
  class_attribute: `
[System.Obsolete]
public static class Bad
{
    public static int F() => 1;
}
`,
  enum_attribute: `
[System.Obsolete]
public enum E { A }
public static class Bad
{
    public static int F() => (int)E.A;
}
`,
  enum_char: `
public enum E : char { A }
public static class Bad
{
    public static int F() => 1;
}
`,
  checked_conversion: `
public static class Bad
{
    public static byte F(int x) => checked((byte)x);
}
`,
  float_remainder: `
public static class Bad
{
    public static float F(float x) => x % 2;
}
`,
  math_pow: `
public static class Bad
{
    public static double F(double x) => System.Math.Pow(x, 2);
}
`,
  math_abs_short: `
public static class Bad
{
    public static short F(short x) => System.Math.Abs(x);
}
`,
  export_reference_signature: `
public static class Bad
{
    [Gameplay.WasmExport("f")]
    public static int[] F() => null;
}
`,
  export_instance: `
public sealed class Bad
{
    [Gameplay.WasmExport("f")]
    public int F() => 1;
    public static int G() => 1;
}
`,
  export_empty_name: `
public static class Bad
{
    [Gameplay.WasmExport("")]
    public static int F() => 1;
}
`,
  export_duplicate: `
public static class Bad
{
    [Gameplay.WasmExport("same")]
    public static int F() => 1;
    [Gameplay.WasmExport("same")]
    public static int G() => 1;
}
`,
  export_reserved_fault: `
public static class Bad
{
    [Gameplay.WasmExport("__fault")]
    public static int F() => 1;
}
`,
  export_other_attribute: `
public static class Bad
{
    [System.Obsolete]
    public static int F() => 1;
}
`,
  partial_unimplemented: `
public static partial class Bad
{
    public static partial int F();
}
`,
  base_initializer_property: `
public sealed class Bad
{
    public int X { get; set; }
    public Bad() : base() { }
    public static int F() => 1;
}
`,
};
