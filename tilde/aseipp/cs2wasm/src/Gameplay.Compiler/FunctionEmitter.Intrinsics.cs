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

    private static readonly (string Name, Intrinsic Intrinsic)[] BitIntrinsics =
    [
        ("PopCount", Intrinsic.PopCount),
        ("LeadingZeroCount", Intrinsic.LeadingZeroCount),
        ("TrailingZeroCount", Intrinsic.TrailingZeroCount),
        ("RotateLeft", Intrinsic.RotateLeft),
        ("RotateRight", Intrinsic.RotateRight),
    ];

    private readonly Dictionary<INamedTypeSymbol, Dictionary<string, Intrinsic>> intrinsics;

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
        return table;
    }

    public Intrinsic? IntrinsicOf(IMethodSymbol method)
    {
        if (!method.IsStatic || method.ContainingType is null || method.IsGenericMethod)
        {
            return null;
        }

        return intrinsics.TryGetValue(method.ContainingType, out var methods)
            && methods.TryGetValue(method.Name, out var intrinsic)
            ? intrinsic
            : null;
    }
}

internal sealed partial class FunctionEmitter
{
    private WType EmitIntrinsic(Intrinsic intrinsic, IInvocationOperation invocation)
    {
        var method = invocation.TargetMethod;
        var parameters = method.Parameters.Select(parameter => Frontend.ScalarOf(parameter.Type)).ToArray();
        if (parameters.Any(parameter => parameter is null) || parameters.Length == 0)
        {
            throw CompileError.At(invocation, $"'{method.ToDisplayString()}' has no Wasm lowering.");
        }

        var scalars = parameters.Select(parameter => parameter!.Value).ToArray();
        var first = scalars[0];
        var type = Frontend.Represent(first);
        bool wide = type == WType.I64;
        int[] arguments = EvaluateArguments(method, invocation.Arguments, invocation);

        CompileError Unsupported() => CompileError.At(invocation,
            $"'{method.ToDisplayString()}' has no Wasm lowering; use the int, long, uint, ulong, float or double overloads.");

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
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.Equals, invocation));
                FaultIf(FaultCode.ArithmeticOverflow);
                int mask = NewLocal(type);
                LocalGet(arguments[0]);
                code.Const(type, wide ? 63 : 31);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.RightShift, invocation));
                LocalSet(mask);
                LocalGet(arguments[0]);
                LocalGet(mask);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.ExclusiveOr, invocation));
                LocalGet(mask);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.Subtract, invocation));
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
                    intrinsic == Intrinsic.Min ? BinaryOperatorKind.LessThan : BinaryOperatorKind.GreaterThan,
                    invocation));
                code.Byte(0x1b); // select
                return type;

            case Intrinsic.Clamp when scalars.Length == 3 && (IsInteger(first) || IsFloating(first)):
                // Math.Clamp rejects min > max, then compares as written, so
                // NaN and signed zeros come out exactly as the CLR's do.
                LocalGet(arguments[1]);
                LocalGet(arguments[2]);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.GreaterThan, invocation));
                FaultIf(FaultCode.InvalidArgument);
                int clamped = NewLocal(type);
                LocalGet(arguments[1]);
                LocalGet(arguments[0]);
                LocalGet(arguments[0]);
                LocalGet(arguments[1]);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.LessThan, invocation));
                code.Byte(0x1b); // select: value < min ? min : value
                LocalSet(clamped);
                LocalGet(arguments[2]);
                LocalGet(clamped);
                LocalGet(clamped);
                LocalGet(arguments[2]);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.GreaterThan, invocation));
                code.Byte(0x1b); // select: clamped > max ? max : clamped
                return type;

            case Intrinsic.CopySign when scalars.Length == 2 && IsFloating(first):
                LocalGet(arguments[0]);
                LocalGet(arguments[1]);
                code.Byte(first == Scalar.F32 ? (byte)0x98 : (byte)0xa6);
                return type;

            case Intrinsic.IsNaN when scalars.Length == 1 && IsFloating(first):
                LocalGet(arguments[0]);
                LocalGet(arguments[0]);
                code.Byte(BinaryOpcode(first, BinaryOperatorKind.NotEquals, invocation));
                return WType.I32;

            case Intrinsic.IsInfinity or Intrinsic.IsFinite when scalars.Length == 1 && IsFloating(first):
                LocalGet(arguments[0]);
                code.Byte(first == Scalar.F32 ? (byte)0x8b : (byte)0x99); // abs
                code.Const(type, double.PositiveInfinity);
                code.Byte(BinaryOpcode(first,
                    intrinsic == Intrinsic.IsInfinity ? BinaryOperatorKind.Equals : BinaryOperatorKind.LessThan,
                    invocation));
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
