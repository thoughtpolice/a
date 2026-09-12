// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Operations;

namespace Gameplay.Compiler;

// Framework methods with a direct Wasm lowering: System.Math and MathF where
// an instruction exists, the floating-point classification tests, and
// System.Numerics.BitOperations. Nothing here calls into a runtime.
internal enum Intrinsic
{
    Abs,
    Sqrt,
    Floor,
    Ceiling,
    Truncate,
    Round,
    Min,
    Max,
    Clamp,
    CopySign,
    IsNaN,
    IsInfinity,
    IsFinite,
    PopCount,
    LeadingZeroCount,
    TrailingZeroCount,
    RotateLeft,
    RotateRight,
    // BitConverter's reinterpretations between floats and integers.
    Reinterpret,
    // The runtime's (see runtime/Collections.cs and runtime/Strings.cs).
    Equal,
    Hash,
    LessThan,
    GreaterThan,
    IsNaNOf,
    Compare,
    SortsByComparer,
    EnumNames,
    EnumValues,
    EnumFromBits,
    EnumToBits,
    EnumKind,
    StringAllocate,
    StringSet,
    StringSame,
    // Gameplay.Runtime.Memory's, by name (see FunctionEmitter.Memory).
    Memory,
    // A fault nothing catches, of a code the runtime passes.
    Trap,
    // The active call depth, which the budget counts.
    CallDepth,
    // The budget itself (Limits.CallDepth).
    CallDepthLimit,
    // Whether the task library flows ExecutionContext (folded in IL:
    // Frontend.FoldedCall).
    FlowsExecutionContext,
    // Whether the task library has schedulers but the default (folded too).
    HasTaskSchedulers,
}

internal sealed partial class Frontend
{
    // The containing types are resolved once per compilation, then compared
    // by identity; the method name selects the lowering.
    private static readonly (string Name, Intrinsic Intrinsic)[] MathIntrinsics =
    [
        ("Abs", Intrinsic.Abs),
        ("Sqrt", Intrinsic.Sqrt),
        ("Floor", Intrinsic.Floor),
        ("Ceiling", Intrinsic.Ceiling),
        ("Truncate", Intrinsic.Truncate),
        ("Round", Intrinsic.Round),
        ("Min", Intrinsic.Min),
        ("Max", Intrinsic.Max),
        ("Clamp", Intrinsic.Clamp),
        ("CopySign", Intrinsic.CopySign),
    ];

    private static readonly (string Name, Intrinsic Intrinsic)[] ClassificationIntrinsics =
    [
        ("IsNaN", Intrinsic.IsNaN),
        ("IsInfinity", Intrinsic.IsInfinity),
        ("IsFinite", Intrinsic.IsFinite),
    ];

    private static readonly (string Name, Intrinsic Intrinsic)[] ConverterIntrinsics =
    [
        ("DoubleToInt64Bits", Intrinsic.Reinterpret),
        ("DoubleToUInt64Bits", Intrinsic.Reinterpret),
        ("Int64BitsToDouble", Intrinsic.Reinterpret),
        ("UInt64BitsToDouble", Intrinsic.Reinterpret),
        ("SingleToInt32Bits", Intrinsic.Reinterpret),
        ("SingleToUInt32Bits", Intrinsic.Reinterpret),
        ("Int32BitsToSingle", Intrinsic.Reinterpret),
        ("UInt32BitsToSingle", Intrinsic.Reinterpret),
    ];

    private static readonly (string Name, Intrinsic Intrinsic)[] BitIntrinsics =
    [
        ("PopCount", Intrinsic.PopCount),
        ("LeadingZeroCount", Intrinsic.LeadingZeroCount),
        ("TrailingZeroCount", Intrinsic.TrailingZeroCount),
        ("RotateLeft", Intrinsic.RotateLeft),
        ("RotateRight", Intrinsic.RotateRight),
    ];

    private readonly Dictionary<INamedTypeSymbol, Dictionary<string, Intrinsic>> intrinsics;

    public static bool IsRuntimeIntrinsic(IMethodSymbol method) =>
        method.ContainingType is
        {
            Name: "Intrinsics" or "StringIntrinsics" or "Memory", Arity: 0, ContainingType: null,
            ContainingNamespace: { Name: "Runtime", ContainingNamespace: { Name: "Gameplay", ContainingNamespace.IsGlobalNamespace: true } },
        } type
        && IsRuntimeType(type);

    private static Dictionary<INamedTypeSymbol, Dictionary<string, Intrinsic>> ResolveIntrinsics(
        CSharpCompilation compilation)
    {
        var table = new Dictionary<INamedTypeSymbol, Dictionary<string, Intrinsic>>(SymbolEqualityComparer.Default);
        void Add(INamedTypeSymbol? type, IEnumerable<(string Name, Intrinsic Intrinsic)> methods)
        {
            if (type is not null)
            {
                table[type] = methods.ToDictionary(method => method.Name, method => method.Intrinsic, StringComparer.Ordinal);
            }
        }

        Add(compilation.GetTypeByMetadataName("System.Math"), MathIntrinsics);
        // MathF has no Clamp.
        Add(compilation.GetTypeByMetadataName("System.MathF"),
            MathIntrinsics.Where(method => method.Intrinsic != Intrinsic.Clamp));
        Add(compilation.GetSpecialType(SpecialType.System_Single), ClassificationIntrinsics);
        Add(compilation.GetSpecialType(SpecialType.System_Double), ClassificationIntrinsics);
        Add(compilation.GetTypeByMetadataName("System.Numerics.BitOperations"), BitIntrinsics);
        Add(compilation.GetTypeByMetadataName("System.BitConverter"), ConverterIntrinsics);
        return table;
    }

    public Intrinsic? IntrinsicOf(IMethodSymbol method)
    {
        if (IsRuntimeIntrinsic(method) && method.ContainingType.Name == "Memory")
        {
            return Intrinsic.Memory;
        }

        if (IsRuntimeIntrinsic(method))
        {
            return method.Name switch
            {
                "Equal" => Intrinsic.Equal,
                "Hash" => Intrinsic.Hash,
                "LessThan" => Intrinsic.LessThan,
                "GreaterThan" => Intrinsic.GreaterThan,
                "IsNaN" => Intrinsic.IsNaNOf,
                "Compare" => Intrinsic.Compare,
                "SortsByComparer" => Intrinsic.SortsByComparer,
                "EnumNames" => Intrinsic.EnumNames,
                "EnumValues" => Intrinsic.EnumValues,
                "EnumFromBits" => Intrinsic.EnumFromBits,
                "EnumToBits" => Intrinsic.EnumToBits,
                "EnumKind" => Intrinsic.EnumKind,
                "Trap" => Intrinsic.Trap,
                "CallDepth" => Intrinsic.CallDepth,
                "CallDepthLimit" => Intrinsic.CallDepthLimit,
                "FlowsExecutionContext" => Intrinsic.FlowsExecutionContext,
                "HasTaskSchedulers" => Intrinsic.HasTaskSchedulers,
                "Allocate" => Intrinsic.StringAllocate,
                "Set" => Intrinsic.StringSet,
                _ => Intrinsic.StringSame,
            };
        }

        if (!method.IsStatic || method.ContainingType is null || method.IsGenericMethod)
        {
            return null;
        }

        // Math.Round's other overloads, and the decimal ones, are runtime C#
        // (see runtime/Shims.cs).
        return intrinsics.TryGetValue(method.ContainingType, out var methods)
            && methods.TryGetValue(method.Name, out var intrinsic)
            && (intrinsic != Intrinsic.Round || method.Parameters.Length == 1)
            && !method.Parameters.Any(parameter => DecimalOperators.IsDecimal(parameter.Type))
            ? intrinsic
            : null;
    }
}

internal sealed partial class FunctionEmitter
{

    // Math, MathF, BitOperations and BitConverter members, with their
    // arguments in locals.
    private WType EmitMathIntrinsic(Intrinsic intrinsic, IMethodSymbol method, int[] arguments)
    {
        var parameters = method.Parameters.Select(parameter => ScalarOfType(parameter.Type)).ToArray();
        if (parameters.Any(parameter => parameter is null) || parameters.Length == 0)
        {
            throw new CompileError($"'{method.ToDisplayString()}' has no Wasm lowering.");
        }

        var scalars = parameters.Select(parameter => parameter!.Value).ToArray();
        var first = scalars[0];
        var type = Frontend.Represent(first);
        bool wide = type == WType.I64;

        CompileError Unsupported() => new CompileError($"'{method.ToDisplayString()}' has no Wasm lowering; use the int, long, uint, ulong, float or double overloads.");

        switch (intrinsic)
        {
            case Intrinsic.Sqrt or Intrinsic.Floor or Intrinsic.Ceiling or Intrinsic.Truncate or Intrinsic.Round
                when scalars.Length == 1 && IsFloating(first):
                LocalGet(arguments[0]);
                code.Byte((first == Scalar.F32, intrinsic) switch
                {
                    (true, Intrinsic.Sqrt) => 0x91,
                    (true, Intrinsic.Floor) => 0x8e,
                    (true, Intrinsic.Ceiling) => 0x8d,
                    (true, Intrinsic.Truncate) => 0x8f,
                    (true, _) => 0x90, // f32.nearest: round half to even, as Math.Round does
                    (false, Intrinsic.Sqrt) => 0x9f,
                    (false, Intrinsic.Floor) => 0x9c,
                    (false, Intrinsic.Ceiling) => 0x9b,
                    (false, Intrinsic.Truncate) => 0x9d,
                    (false, _) => 0x9e,
                });
                return type;

            case Intrinsic.Abs when scalars.Length == 1 && IsFloating(first):
                LocalGet(arguments[0]);
                code.Byte(first == Scalar.F32 ? (byte)0x8b : (byte)0x99);
                return type;

            case Intrinsic.Abs when scalars.Length == 1 && first is Scalar.I32 or Scalar.I64:
                // Math.Abs throws for the minimum value; otherwise
                // (x ^ (x >> 31)) - (x >> 31) is the branch-free magnitude.
                LocalGet(arguments[0]);
                code.Const(type, wide ? long.MinValue : int.MinValue);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.Equals));
                FaultIf(FaultCode.ArithmeticOverflow);
                int mask = NewLocal(type);
                LocalGet(arguments[0]);
                code.Const(type, wide ? 63 : 31);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.RightShift));
                LocalSet(mask);
                LocalGet(arguments[0]);
                LocalGet(mask);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.ExclusiveOr));
                LocalGet(mask);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.Subtract));
                return type;

            case Intrinsic.Min or Intrinsic.Max when scalars.Length == 2 && IsFloating(first):
                LocalGet(arguments[0]);
                LocalGet(arguments[1]);
                code.Byte((first == Scalar.F32, intrinsic == Intrinsic.Min) switch
                {
                    (true, true) => 0x96,
                    (true, false) => 0x97,
                    (false, true) => 0xa4,
                    (false, false) => 0xa5,
                });
                return type;

            case Intrinsic.Min or Intrinsic.Max when scalars.Length == 2 && IsInteger(first):
                // select(a, b, a < b) is min; a > b picks max.
                LocalGet(arguments[0]);
                LocalGet(arguments[1]);
                LocalGet(arguments[0]);
                LocalGet(arguments[1]);
                code.Byte(BinaryOpcode(first,
                    intrinsic == Intrinsic.Min ? BinaryOperatorKind.LessThan : BinaryOperatorKind.GreaterThan));
                code.Byte(0x1b); // select
                return type;

            case Intrinsic.Clamp when scalars.Length == 3 && (IsInteger(first) || IsFloating(first)):
                // Math.Clamp rejects min > max, then compares as written, so
                // NaN and signed zeros come out exactly as the CLR's do.
                LocalGet(arguments[1]);
                LocalGet(arguments[2]);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.GreaterThan));
                FaultIf(FaultCode.InvalidArgument);
                int clamped = NewLocal(type);
                LocalGet(arguments[1]);
                LocalGet(arguments[0]);
                LocalGet(arguments[0]);
                LocalGet(arguments[1]);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.LessThan));
                code.Byte(0x1b); // select: value < min ? min : value
                LocalSet(clamped);
                LocalGet(arguments[2]);
                LocalGet(clamped);
                LocalGet(clamped);
                LocalGet(arguments[2]);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.GreaterThan));
                code.Byte(0x1b); // select: clamped > max ? max : clamped
                return type;

            case Intrinsic.Reinterpret when scalars.Length == 1:
                LocalGet(arguments[0]);
                code.Byte(first switch
                {
                    Scalar.F64 => 0xbd, // i64.reinterpret_f64
                    Scalar.F32 => 0xbc, // i32.reinterpret_f32
                    Scalar.I64 or Scalar.U64 => 0xbf, // f64.reinterpret_i64
                    _ => 0xbe, // f32.reinterpret_i32
                });
                return Map(method.ReturnType);

            case Intrinsic.CopySign when scalars.Length == 2 && IsFloating(first):
                LocalGet(arguments[0]);
                LocalGet(arguments[1]);
                code.Byte(first == Scalar.F32 ? (byte)0x98 : (byte)0xa6);
                return type;

            case Intrinsic.IsNaN when scalars.Length == 1 && IsFloating(first):
                LocalGet(arguments[0]);
                LocalGet(arguments[0]);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.NotEquals));
                return WType.I32;

            case Intrinsic.IsInfinity or Intrinsic.IsFinite when scalars.Length == 1 && IsFloating(first):
                LocalGet(arguments[0]);
                code.Byte(first == Scalar.F32 ? (byte)0x8b : (byte)0x99); // abs
                code.Const(type, double.PositiveInfinity);
                code.Byte(BinaryOpcode(first,
                    intrinsic == Intrinsic.IsInfinity ? BinaryOperatorKind.Equals : BinaryOperatorKind.LessThan));
                return WType.I32;

            case Intrinsic.PopCount or Intrinsic.LeadingZeroCount or Intrinsic.TrailingZeroCount
                when scalars.Length == 1 && IsInteger(first) && !IsNarrow(first):
                LocalGet(arguments[0]);
                code.Byte((wide, intrinsic) switch
                {
                    (false, Intrinsic.PopCount) => 0x69,
                    (false, Intrinsic.LeadingZeroCount) => 0x67,
                    (false, _) => 0x68,
                    (true, Intrinsic.PopCount) => 0x7b,
                    (true, Intrinsic.LeadingZeroCount) => 0x79,
                    (true, _) => 0x7a,
                });
                if (wide)
                {
                    code.Byte(0xa7); // i32.wrap_i64: the count is an int
                }

                return WType.I32;

            case Intrinsic.RotateLeft or Intrinsic.RotateRight
                when scalars.Length == 2 && first is Scalar.U32 or Scalar.U64 && scalars[1] == Scalar.I32:
                LocalGet(arguments[0]);
                LocalGet(arguments[1]);
                if (wide)
                {
                    code.Byte(0xac); // i64.extend_i32_s
                }

                code.Byte((wide, intrinsic == Intrinsic.RotateLeft) switch
                {
                    (false, true) => 0x77,
                    (false, false) => 0x78,
                    (true, true) => 0x89,
                    (true, false) => 0x8a,
                });
                return type;

            default:
                throw Unsupported();
        }
    }

    private static bool IsInteger(Scalar scalar) => scalar is not (Scalar.Bool or Scalar.F32 or Scalar.F64);
}
