// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Sources that must produce a policy or Roslyn error without writing Wasm.
export const rejectionCases = {
  attribute_value: `
public sealed class MarkAttribute : System.Attribute
{
    public int Order;
}
public static class Bad
{
    public static int F() => new MarkAttribute { Order = 3 }.Order;
}
`,
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
  stackalloc_pointer: `
public static class Bad
{
    public static unsafe int F()
    {
        int* values = stackalloc int[4];
        return values[0];
    }
}
`,
  interface_event_handler: `
public interface IBad
{
    event System.EventHandler Changed;
}
public static class Bad
{
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
  integer_format_provider: `
public static class Bad
{
    public static int F(int x) => x.ToString(System.Globalization.CultureInfo.InvariantCulture).Length;
}
`,
  string_export: `
public static class Bad
{
    public static string F() => "no";
}
`,
  string_formattable: `
public struct Money : System.IFormattable
{
    public int Cents;

    public string ToString(string format, System.IFormatProvider provider) => format ?? "none";
}

public static class Bad
{
    public static int F(int x) => $"{new Money { Cents = x }:F2}".Length;
}
`,
  string_enum_format: `
public enum Color { Red }

public static class Bad
{
    public static int F(string format) => Color.Red.ToString(format).Length;
}
`,
  string_format_alignment: `
public static class Bad
{
    public static int F(int x) => x.ToString(System.Globalization.CultureInfo.InvariantCulture).Length;
}
`,
  string_culture_member: `
public static class Bad
{
    public static int F() => "Abc".CompareTo("abc");
}
`,
  type_reflection: `
public static class Bad
{
    public static bool F()
    {
        object x = 1;
        return x.GetType().GetMethod("F") == null;
    }
}
`,
  versiondirective: `#error version
public static class Bad
{
    public static int F() => 1;
}
`,
  generic_virtual_recursion: `
public class Bad
{
    public virtual int Depth<T>(int n) => n == 0 ? 0 : 1 + Depth<T[]>(n - 1);
    public static int F() => new Bad().Depth<int>(3);
}
`,
  generic_polymorphic_recursion: `
public static class Bad
{
    private static int Depth<T>(int n) => n == 0 ? 0 : 1 + Depth<T[]>(n - 1);
    public static int F() => Depth<int>(3);
}
`,
  object_override: `
public sealed class Bad
{
    public override string ToString() => "<" + base.ToString() + ">";
    public static int F() => new Bad().ToString().Length;
}
`,
  lock_type: `
public static class Bad
{
    private static readonly System.Threading.Lock Gate = new System.Threading.Lock();
    public static int F()
    {
        lock (Gate)
        {
            return 1;
        }
    }
}
`,
  ref_struct: `
public ref struct Bad
{
    public int X;
}
public static class Entry
{
    public static int F() => 1;
}
`,
  ref_in_parameter: `
public static class Bad
{
    private static ref readonly int Same(in int value) => ref value;
    public static int F() => Same(1);
}
`,
  multidimensional_type_object: `
public static class Bad
{
    public static int F()
    {
        int[,] grid = new int[2, 2];
        return grid.GetType().Name.Length;
    }
}
`,
  memory_pin: `
public static class Bad
{
    public static int F()
    {
        System.Memory<int> memory = new int[3];
        using (var handle = memory.Pin())
        {
            return memory.Length;
        }
    }
}
`,
  memory_manager: `
public sealed class Bad : System.Buffers.MemoryManager<int>
{
    public override System.Span<int> GetSpan() => default;
    public override System.Buffers.MemoryHandle Pin(int elementIndex = 0) => default;
    public override void Unpin() { }
    protected override void Dispose(bool disposing) { }
    public static int F() => 1;
}
`,
  initializer_framework_call: `
public sealed class Bad
{
    public int X = System.Environment.TickCount;
    public static int F() => 1;
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
  dynamic_local: `
public static class Bad
{
    public static int F()
    {
        dynamic d = 1;
        return d + 1;
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
  ref_struct_field: `
public ref struct Bad
{
    public ref int Value;
    public static int F() => 1;
}
`,
  array_rank: `
public static class Bad
{
    public static int F() => new int[1, 1, 1, 1, 1, 1, 1, 1, 1].Length;
}
`,
  linq_string_order: `
using System.Linq;
public static class Bad
{
    public static int F() => new[] { "b", "a" }.OrderBy(s => s).Count();
}
`,
  interface_event_struct_field: `
public interface IBad
{
    event System.Action Changed;
}
public struct Bad : IBad
{
    public event System.Action Changed;
    public static int F() => 1;
}
`,
  interface_ref_member: `
public interface IBad
{
    ref int F();
}
public static class Bad
{
    public static int G() => 1;
}
`,
  ituple_pattern: `
public static class Bad
{
    public static int F(int x)
    {
        object pair = (x, 2);
        return pair is (1, _) ? 1 : 0;
    }
}
`,
  string_parameter: `
public static class Bad
{
    public static int F(string s) => s switch { "a" => 1, _ => 0 };
}
`,
  string_huge_literal: `
public static class Bad
{
    public const string Big = "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789";
    public const string Bigger = Big + Big + Big + Big + Big + Big + Big + Big + Big + Big;
    public const string Biggest = Bigger + Bigger + Bigger + Bigger + Bigger + Bigger + Bigger + Bigger + Bigger + Bigger + Bigger;
    public static int F() => Biggest.Length;
}
`,
  nullable_compare: `
public static class Bad
{
    public static int F()
    {
        int? a = 1;
        int? b = null;
        return System.Nullable.Compare(a, b);
    }
}
`,
  nullable_export: `
public static class Bad
{
    [Gameplay.WasmExport("f")]
    public static int F(int? value) => value ?? 0;
}
`,
  delegate_invocation_list: `
public static class Bad
{
    public static int F()
    {
        System.Action f = () => { };
        f += () => { };
        return f.GetInvocationList().Length;
    }
}
`,
  delegate_dynamic_invoke: `
public static class Bad
{
    public static int F()
    {
        System.Func<int> f = () => 1;
        f.DynamicInvoke();
        return 1;
    }
}
`,
  framework_delegate: `
public static class Bad
{
    public static int F()
    {
        System.EventHandler f = (sender, e) => { };
        f(null, null);
        return 1;
    }
}
`,
  enum_char: `
public enum E : char { A }
public static class Bad
{
    public static int F() => 1;
}
`,
  tuple_eight: `
public static class Bad
{
    public static int F(int x)
    {
        var t = (x, 2, 3, 4, 5, 6, 7, checked((byte)x));
        return t.Item8;
    }
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
  partial_unimplemented: `
public static partial class Bad
{
    public static partial int F();
}
`,
  union_property_pattern: `
public sealed class A { public int X; }
public sealed class B { }
public union AB(A, B);

public static class Bad
{
    public static int F() => ((AB)new A()) is { Value: var value } && value is System.Action ? 1 : 0;
}
`,
  boundary_memory: `
public static class Bad
{
    public static int F() => Gameplay.Runtime.Memory.Load32(0);
}
`,
  boundary_memory_canonical: `
public static class Bad
{
    public static int F() => Gameplay.Runtime.Canonical.StoreString("no", out int length) + length;
}
`,
  exception_actual_value: `
public static class Bad
{
    public static int F(int x)
    {
        try
        {
            throw new System.ArgumentOutOfRangeException("x", x, "out");
        }
        catch (System.ArgumentOutOfRangeException error)
        {
            return error.ActualValue == null ? 0 : 1;
        }
    }
}
`,
  exception_message_override: `
public sealed class Bad : System.Exception
{
    public override string Message => "custom";
    public static int F() => 1;
}
`,
  framework_base_class: `
public sealed class Bad : System.Collections.ObjectModel.Collection<int>
{
    public static int F() => 1;
}
`,
  sealed_runtime_base_class: `
public sealed class Bad : System.Collections.Generic.List<int>
{
    public static int F() => new Bad().Count;
}
`,
  sealed_random_base_class: `
public sealed class Bad : System.Random
{
    public static int F() => new Bad().Next(3);
}
`,
  tuple_rest: `
public static class Bad
{
    public static int F()
    {
        var t = (1, 2, 3, 4, 5, 6, 7, 8);
        return t.Item8 + t.Item1;
    }
}
`,
  exception_stack_trace: `
public static class Bad
{
    public static int F()
    {
        try
        {
            throw new System.InvalidOperationException("no stack");
        }
        catch (System.Exception e)
        {
            return e.StackTrace.Length;
        }
    }
}
`,
  exception_to_string: `
public static class Bad
{
    public static int F() => new System.Exception().HResult;
}
`,
  culture_current: `
public static class Bad
{
    public static int F(int x) => (x * 1.5m).ToString(System.Globalization.CultureInfo.CurrentCulture).Length;
}
`,
  culture_named: `
public static class Bad
{
    public static int F(int x) => decimal.Parse("1,5", new System.Globalization.CultureInfo("fr-FR")) > x ? 1 : 0;
}
`,
};

// Programs the retired IOperation frontend rejected that the compiler
// compiles, and why: it reads what C# compiled, so a rejection of how that
// frontend lowered syntax need not apply, and the gameplay CoreLib has more
// of the framework. Each must compile into a valid module;
// tests/IlAccepted.cs runs each against the CLR (the reasons marked "as far
// as the case goes" hold of the case's code, while what it would go on to do
// is still rejected).
export const acceptedCases = {
  constructor_caller_info: {
    why: "caller info is constants C# supplies",
    source: `
public sealed class Bad
{
    public Bad([System.Runtime.CompilerServices.CallerLineNumber] int line = 0) { }
    public static int F() => 1;
}
`,
  },
  parameter_attribute: {
    why: "attributes are metadata",
    source: `
public static class Bad
{
    private static int Read([System.Diagnostics.CodeAnalysis.NotNull] string value) => value.Length;
    public static int F() => Read("x");
}
`,
  },
  constructor_primary: {
    why: "C# lowers the captured parameter to a field",
    source: `
public struct Bad(int value)
{
    public int Get() => value;
    public static int F() => new Bad(1).Get();
}
`,
  },
  string_format_specifier: {
    why: "DateTime is the CoreLib's",
    source: `
public static class Bad
{
    public static int F(int x) => System.DateTime.Now.ToString("yyyy").Length + x;
}
`,
  },
  string_object_concat: {
    why: "an array prints as its CLR type name",
    source: `
public static class Bad
{
    public static int F() => ("a" + new object[1]).Length;
}
`,
  },
  objectcast: {
    why: "C# folds the cast of a null constant (as far as the case goes)",
    source: `
public static class Bad
{
    public static bool F()
    {
        object value = null;
        return (System.Action)value == null;
    }
}
`,
  },
  boxing: {
    why: "ValueType is object's representation (as far as the case goes)",
    source: `
public static class Bad
{
    public static bool F(int x)
    {
        System.ValueType boxed = x;
        return boxed == null;
    }
}
`,
  },
  array_covariance: {
    why: "arrays of references convert by covariance (one family of arrays)",
    source: `
public class Base
{
}
public sealed class Derived : Base
{
}
public static class Bad
{
    public static int F()
    {
        Base[] values = new Derived[1];
        return values.Length;
    }
}
`,
  },
  struct_boxing: {
    why: "a boxed int is an object (as far as the case goes)",
    source: `
public static class Bad
{
    public static int F()
    {
        System.IComparable comparable = 5;
        return comparable == null ? 0 : 1;
    }
}
`,
  },
  record_struct: {
    why: "a union field prints as C# lowers it",
    source: `
public union Either(int, string);
public record struct Bad(Either X);
public static class Entry
{
    public static int F() => new Bad(1).ToString().Length;
}
`,
  },
  thread_static: {
    why: "one thread: a thread-static is a static",
    source: `
public static class Bad
{
    [System.ThreadStatic]
    private static int counter;
    public static int F(int x)
    {
        checked { counter += x; }
        return counter;
    }
}
`,
  },
  compound_user_conversion: {
    why: "C# lowers the conversion and operator calls",
    source: `
public struct Meters
{
    public int Value;

    public static implicit operator Meters(int value) => new Meters { Value = value };

    public static int operator +(Meters left, int right) => left.Value + right;
}

public static class Bad
{
    public static int F(int x)
    {
        Meters distance = default;
        distance += x;
        return distance.Value;
    }
}
`,
  },
  caller_info: {
    why: "caller info is constants C# supplies",
    source: `
public static class Bad
{
    private static int Line([System.Runtime.CompilerServices.CallerLineNumber] int line = 0) => line;
    public static int F() => Line();
}
`,
  },
  delegate_combine_static: {
    why: "Delegate.Combine and Remove are supported (as far as the case goes)",
    source: `
public static class Bad
{
    public static bool F()
    {
        System.Action a = () => { };
        return System.Delegate.Combine(a, a) != null;
    }
}
`,
  },
  framework_collection_interface: {
    why: "the CoreLib's List<T> is an ICollection<T>",
    source: `
using System.Collections.Generic;
public static class Bad
{
    public static int F()
    {
        ICollection<int> values = new List<int>();
        return values == null ? 0 : 1;
    }
}
`,
  },
  generic_iterator_local_function: {
    why: "generic methods are monomorphized from IL",
    source: `
using System.Collections.Generic;
public static class Bad
{
    public static int F()
    {
        IEnumerable<T> Numbers<T>(T value) { yield return value; }
        int sum = 0;
        foreach (int n in Numbers(1)) sum += n;
        return sum;
    }
}
`,
  },
  async_lambda: {
    why:
      "an async lambda is C#'s state machine over the CoreLib's task library",
    source: `
public static class Bad
{
    public static int F()
    {
        System.Func<System.Threading.Tasks.Task> run = async () => { };
        return 1;
    }
}
`,
  },
  variant_interface: {
    why:
      "variant interfaces convert by variance (itables of the converted interfaces)",
    source: `
public interface IBad<out T>
{
    T F();
}
public static class Bad
{
    public static int G() => 1;
}
`,
  },
  framework_interface: {
    why: "IEquatable<T> is the CoreLib's interface",
    source: `
public sealed class Bad : System.IEquatable<Bad>
{
    public bool Equals(Bad other) => true;
    public int CompareTo(Bad other) => 0;
    public static int F() => 1;
}
`,
  },
  record_declaration: {
    why: "an array prints as its CLR type name",
    source: `
public sealed record Bad(object[] Items);
public static class Entry
{
    public static int F() => new Bad(null).ToString().Length;
}
`,
  },
  async_method: {
    why:
      "an async method is C#'s state machine over the CoreLib's task library",
    source: `
public static class Bad
{
    private static async System.Threading.Tasks.Task<int> G() => 1;
    public static int F() => 1;
}
`,
  },
  event_virtual: {
    why: "a virtual event is its virtual accessors",
    source: `
public class Bad
{
    public virtual event System.Action Changed;
    public static int F() => 1;
}
`,
  },
  interface_static_event: {
    why: "a static abstract event is its accessors",
    source: `
public interface IBad
{
    static abstract event System.Action Changed;
}
public static class Bad
{
    public static int F() => 1;
}
`,
  },
  delegate_variance: {
    why: "a delegate converts by variance (a new one forwarding to it)",
    source: `
public class Base
{
}
public sealed class Derived : Base
{
}
public static class Bad
{
    public static int F()
    {
        System.Func<Derived> f = () => new Derived();
        System.Func<Base> g = f;
        return g() == null ? 0 : 1;
    }
}
`,
  },
  capture_loop_condition: {
    why: "C# lowers the per-iteration capture",
    source: `
public sealed class Node
{
    public Node Next;
}
public static class Bad
{
    public static int F()
    {
        Node node = new Node();
        System.Func<Node> last = null;
        while (node is Node current)
        {
            last = () => current;
            node = node.Next;
        }
        return last == null ? 0 : 1;
    }
}
`,
  },
  generic_local_function_capture: {
    why: "generic methods are monomorphized from IL",
    source: `
public static class Bad
{
    public static int F()
    {
        int calls = 0;
        T Same<T>(T value) { calls++; return value; }
        return Same(1) + calls;
    }
}
`,
  },
  variant_delegate: {
    why: "a declaration only",
    source: `
public delegate T Maker<out T>();
public static class Bad
{
    public static int F() => 1;
}
`,
  },
  generic_type_parameter_boxing: {
    why: "a constrained call reaches int's CompareTo",
    source: `
public static class Bad
{
    private static int Compare<T>(T left, T right) where T : System.IComparable<T> => left.CompareTo(right);
    public static int F() => Compare(1, 2);
}
`,
  },
  volatile_field: {
    why: "one thread: a volatile field is a field",
    source: `
public sealed class Bad
{
    public volatile int X;
    public static int F() => 1;
}
`,
  },
  class_attribute: {
    why: "attributes are metadata",
    source: `
[System.Obsolete]
public static class Bad
{
    public static int F() => 1;
}
`,
  },
  enum_attribute: {
    why: "attributes are metadata",
    source: `
[System.Obsolete]
public enum E { A }
public static class Bad
{
    public static int F() => (int)E.A;
}
`,
  },
  float_remainder: {
    why: "Math.IEEERemainder is the CoreLib's, after .NET's",
    source: `
public static class Bad
{
    public static double F(double x) => System.Math.IEEERemainder(x, 2);
}
`,
  },
  math_pow: {
    why: "Math.FusedMultiplyAdd is the CoreLib's, rounded once",
    source: `
public static class Bad
{
    public static double F(double x) => System.Math.FusedMultiplyAdd(x, x, 1);
}
`,
  },
  export_other_attribute: {
    why: "attributes are metadata",
    source: `
public static class Bad
{
    [System.Obsolete]
    public static int F() => 1;
}
`,
  },
  filter_lambda: {
    why: "filters run two-pass over IL's filter blocks",
    source: `
public static class Bad
{
    public static int F(int x)
    {
        try
        {
            return 10 / x;
        }
        catch (System.DivideByZeroException) when (((System.Func<int>)(() => x))() == 0)
        {
            return 0;
        }
    }
}
`,
  },
  filter_variable_in_handler: {
    why: "filters run two-pass over IL's filter blocks",
    source: `
public sealed class Oops : System.Exception
{
    public Oops Inner;
}

public static class Bad
{
    public static int F(int x)
    {
        try
        {
            throw new Oops();
        }
        catch (Oops e) when (e.Inner is Oops inner)
        {
            return inner == null ? 1 : 2;
        }
        catch (Oops)
        {
            return 0;
        }
    }
}
`,
  },
  filter_assigns_catch_variable: {
    why: "filters run two-pass over IL's filter blocks",
    source: `
public static class Bad
{
    public static int F(int x)
    {
        try
        {
            return 10 / x;
        }
        catch (System.DivideByZeroException e) when ((e = null) == null)
        {
            return 0;
        }
    }
}
`,
  },
  union_value_case: {
    why: "a union is the struct C# lowers it to (as far as the case goes)",
    source: `
public union Callback(System.Action, string);

public static class Bad
{
    public static int F() => ((Callback)"x") is string ? 1 : 0;
}
`,
  },
  union_interface_case: {
    why: "a union is the struct C# lowers it to",
    source: `
public union Anything(object, string);

public static class Bad
{
    public static int F() => ((Anything)"x") is string ? 1 : 0;
}
`,
  },
  union_members: {
    why: "a union is the struct C# lowers it to",
    source: `
public sealed class A { }
public sealed class B { }
public union AB(A, B)
{
    public int Count() => 1;
}

public static class Bad
{
    public static int F() => 1;
}
`,
  },
  union_value: {
    why: "a union's ToString is the one C# generates",
    source: `
public sealed class A { }
public sealed class B { }
public union AB(A, B);

public static class Bad
{
    public static int F() => ((AB)new A()).ToString().Length;
}
`,
  },
  struct_method_group: {
    why: "the delegate is bound to the box C# makes of the struct",
    source: `
public struct Counter
{
    public int Count;
    public int Get() => Count;
}
public static class Bad
{
    public static int F()
    {
        var counter = new Counter();
        System.Func<int> get = counter.Get;
        return get();
    }
}
`,
  },
  generic_math_decimal: {
    why: "decimal implements generic math (runtime/DecimalMath.cs)",
    source: `
public static class Bad
{
    private static T Sum<T>(T a, T b) where T : System.Numerics.INumber<T> => a + b;
    public static int F(int x) => (int)Sum(1.5m, x);
}
`,
  },
  generic_math_int: {
    why: "generic math is the CoreLib's",
    source: `
public static class Bad
{
    private static T Zero<T>() where T : System.Numerics.INumberBase<T> => T.Zero;
    public static int F(int x) => Zero<int>() + x;
}
`,
  },
};
