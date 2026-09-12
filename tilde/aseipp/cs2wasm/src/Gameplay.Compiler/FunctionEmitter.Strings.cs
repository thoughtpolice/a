// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Strings (see Frontend.Strings): literals, Length and the indexer inline;
// equality, concatenation, interpolation, formatting and the other members
// through the runtime's string methods. A value formats as the CLR's
// ToString does: integers in decimal with the invariant culture's minus
// sign, bools as True and False, chars as themselves. Floating-point
// numbers and enums do not format here: the CLR's shortest round-trip text
// and enum names are not reproduced, and are rejected.
internal sealed partial class FunctionEmitter
{
    private static bool IsString(ITypeSymbol? type) => type?.SpecialType == SpecialType.System_String;

    private void CallString(string name, int parameters) =>
        Call(frontend.MethodIndex(frontend.StringHelper(name, parameters)));

    private void EmitLiteral(string text)
    {
        code.Byte(0x23); // global.get
        Relocations.Add(new(code.Length, RelocationKind.Literal, frontend.Literal(text)));
    }

    private WType EmitStringIntrinsic(Intrinsic intrinsic, int[] arguments)
    {
        var type = WType.Ref(frontend.StringHeap);
        switch (intrinsic)
        {
            case Intrinsic.StringAllocate:
                // Charged like an array; the maximum array length applies.
                LocalGet(arguments[0]);
                code.I32(frontend.Limits.ArrayLength);
                code.Byte(0x4b); // i32.gt_u
                TrapIf(FaultCode.InvalidArrayLength);
                LocalGet(arguments[0]);
                code.Byte(0xad); // i64.extend_i32_u
                code.I64(8);
                code.Byte(0x7e); // i64.mul
                code.I64(16);
                code.Byte(0x7c); // i64.add
                ChargeAllocation();
                LocalGet(arguments[0]);
                code.Gc(7, frontend.StringHeap); // array.new_default
                return type;
            case Intrinsic.StringSet:
                PushArguments(arguments);
                code.Gc(14, frontend.StringHeap); // array.set
                return WType.Void;
            default:
                PushArguments(arguments);
                code.Byte(0xd3); // ref.eq
                return WType.I32;
        }
    }

    // Formats the scalar on the stack.
    private void FormatScalar(ITypeSymbol? type, bool check = false)
    {
        static CompileError Error(string message) => new(message);
        if (type is INamedTypeSymbol { TypeKind: TypeKind.Enum } enumType)
        {
            if (!check)
            {
                code.I32(0);
                Call(frontend.EnumFormatter(enumType));
            }

            return;
        }

        string? helper = Frontend.ScalarOf(type) switch
        {
            Scalar.Bool => "FromBool",
            Scalar.Char => "FromChar",
            Scalar.I8 or Scalar.I16 or Scalar.I32 or Scalar.I64 => "FromInt64",
            Scalar.U8 or Scalar.U16 or Scalar.U32 or Scalar.U64 => "FromUInt64",
            Scalar.F32 => "FormatSingle",
            Scalar.F64 => "FormatDouble",
            _ => throw Error(
                $"Formatting '{type?.ToDisplayString()}' is unsupported: "
                + (type is null ? "it has no type." : Frontend.FormatProblem(type) ?? "it has no text here.")),
        };
        if (check)
        {
            return;
        }

        switch (Frontend.ScalarOf(type))
        {
            case Scalar.I8 or Scalar.I16 or Scalar.I32:
                code.Byte(0xac); // i64.extend_i32_s
                break;
            case Scalar.U8 or Scalar.U16 or Scalar.U32:
                code.Byte(0xad); // i64.extend_i32_u
                break;
            case Scalar.F32 or Scalar.F64:
                // The shortest digits that round-trip, as the CLR prints them.
                code.Byte(0xd0); // ref.null: no format
                code.Signed(frontend.StringHeap);
                Call(frontend.MethodIndex(frontend.RuntimeMethod("Number", helper, 2)));
                return;
        }

        CallString(helper, 1);
    }

    // An argument in a local formatted as interpolation formats a hole.
    private void EmitFormatItem(int local, ITypeSymbol? type, string? format, int? alignment)
    {
        if (type is null)
        {
            EmitLiteral("");
        }
        else if (format is not null && type is INamedTypeSymbol { TypeKind: TypeKind.Enum } enumType)
        {
            EmitEnumFormatted(() => LocalGet(local), enumType, format);
        }
        else if (format is not null && frontend.IsDecimalType(type))
        {
            PushLocal(local, frontend.MapType(type));
            EmitLiteral(format);
            Call(frontend.MethodIndex(frontend.RuntimeMethod("Number", "FormatDecimal", 2)));
        }
        else if (format is not null && IsNullable(type) && frontend.IsDecimalType(Underlying(type)))
        {
            // A nullable decimal formats its value, and is empty without one.
            var (has, underlying) = NullableParts(local, type);
            LocalGet(has);
            EmitChoice(Text, () =>
            {
                PushLocal(underlying, frontend.MapType(Underlying(type)));
                EmitLiteral(format);
                Call(frontend.MethodIndex(frontend.RuntimeMethod("Number", "FormatDecimal", 2)));
            }, () => EmitLiteral(""));
        }
        else if (format is not null && Frontend.ScalarOf(type) is { } scalar and not (Scalar.Bool or Scalar.Char))
        {
            LocalGet(local);
            EmitNumberFormat(scalar, () => EmitLiteral(format));
        }
        else if (IsString(type))
        {
            LocalGet(local);
        }
        else if (format is not null && Frontend.CoreLibFormattable(type) is { } toString)
        {
            // The CoreLib's own IFormattable structs (BigInteger, Complex,
            // DateTime, ...): their ToString(format, provider), as .NET's
            // interpolation handler calls it.
            EmitLiteral(format);
            int formatLocal = Save(Text);
            var providerType = frontend.MapType(toString.Parameters[1].Type);
            PushDefault(providerType);
            int provider = Save(providerType);
            CallOnPlace(new(LocationKind.Local, frontend.MapType(type), type, Local: local, ReadOnly: true), toString, [formatLocal, provider]);
        }
        else if (Frontend.ScalarOf(type) is not null && type.TypeKind != TypeKind.Enum)
        {
            LocalGet(local);
            FormatScalar(type);
        }
        else if (type.TypeKind == TypeKind.Enum)
        {
            LocalGet(local);
            FormatScalar(type);
        }
        else
        {
            EmitFormattedLocal(type, local);
        }

        if (alignment is { } width)
        {
            code.I32(width);
            Call(frontend.MethodIndex(frontend.RuntimeMethod("Number", "Align", 2)));
        }
    }

    // The number on the stack formatted with the format the action pushes.
    private void EmitNumberFormat(Scalar scalar, Action pushFormat)
    {
        var (helper, bits, unsigned) = scalar switch
        {
            Scalar.F32 => ("FormatSingle", 0, false),
            Scalar.F64 => ("FormatDouble", 0, false),
            Scalar.I8 => ("FormatInteger", 8, false),
            Scalar.U8 => ("FormatInteger", 8, true),
            Scalar.I16 => ("FormatInteger", 16, false),
            Scalar.U16 => ("FormatInteger", 16, true),
            Scalar.I32 => ("FormatInteger", 32, false),
            Scalar.U32 => ("FormatInteger", 32, true),
            Scalar.I64 => ("FormatInteger", 64, false),
            _ => ("FormatInteger", 64, true),
        };
        if (bits != 0)
        {
            if (Frontend.Represent(scalar) == WType.I32)
            {
                code.Byte(unsigned ? (byte)0xad : (byte)0xac); // i64.extend_i32_u / _s
            }

            code.I32(unsigned ? 1 : 0);
            code.I32(bits);
        }

        pushFormat();
        Call(frontend.MethodIndex(frontend.RuntimeMethod("Number", helper, bits != 0 ? 4 : 2)));
    }
}
