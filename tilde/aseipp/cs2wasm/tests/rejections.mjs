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
  constructor_chaining: `
public sealed class Bad
{
    public int X;

    public Bad() : this(1)
    {
    }

    public Bad(int value)
    {
        X = value;
    }

    public static int F() => 1;
}
`,
  constructor_base_initializer: `
public sealed class Bad
{
    public Bad() : base() { }
    public static int F() => 1;
}
`,
  constructor_static: `
public sealed class Bad
{
    static Bad() { }
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
  constructor_readonly_field: `
public sealed class Bad
{
    public readonly int Value;
    public Bad(int value) { Value = value; }
    public static int F() => 1;
}
`,
  checked: `
public static class Bad
{
    public static int F(int x) => checked(x + 1);
}
`,
  property: `
public sealed class Bad
{
    public int X { get; set; }

    public static int F() => 1;
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
  readonly_initializer: `
public sealed class Bad
{
    public readonly int X = 2;

    public static int F() => 1;
}
`,
  staticfield: `
public static class Bad
{
    private static int X;

    public static int F() => X;
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
  foreach_narrowing: `
public static class Bad
{
    public static int F() { int sum = 0; foreach (int x in new float[] { 1 }) sum += x; return sum; }
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
  floatint: `
public static class Bad
{
    public static int F(float x) => (int)x;
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
};
