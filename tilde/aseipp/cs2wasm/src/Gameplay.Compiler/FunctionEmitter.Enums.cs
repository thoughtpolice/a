// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Enums as text (see Frontend.Enums), and the Enum members code calls.
internal sealed partial class FunctionEmitter
{

    private WType EmitEnumIntrinsic(Intrinsic intrinsic, IMethodSymbol method, int[] arguments)
    {
        var type = Sub(method.TypeArguments[0]);
        if (type is not INamedTypeSymbol { TypeKind: TypeKind.Enum } enumType)
        {
            throw new CompileError($"'{type.ToDisplayString()}' is not an enum.");
        }

        var scalar = Frontend.ScalarOf(enumType)!.Value;
        var members = Frontend.EnumMembers(enumType);
        var result = Map(method.ReturnType);
        switch (intrinsic)
        {
            case Intrinsic.EnumNames:
                code.I64(16 + 8L * members.Count);
                ChargeAllocation();
                foreach (var (name, _) in members)
                {
                    EmitLiteral(name);
                }

                code.Gc(8, frontend.CovariantArrays ? frontend.ArrayAllocationHeap(frontend.ArrayOf(frontend.SpecialTypeOf(SpecialType.System_String))) : result.Heap, members.Count); // array.new_fixed
                return result;
            case Intrinsic.EnumValues:
                code.I64(16 + 8L * members.Count);
                ChargeAllocation();
                foreach (var (_, value) in members)
                {
                    code.I64(unchecked((long)value));
                }

                code.Gc(8, result.Heap, members.Count); // array.new_fixed
                return result;
            case Intrinsic.EnumFromBits:
                LocalGet(arguments[0]);
                EmitScalarConversion(Scalar.U64, scalar);
                return result;
            case Intrinsic.EnumToBits:
                LocalGet(arguments[0]);
                EmitScalarConversion(scalar, IsSigned(scalar) ? Scalar.I64 : Scalar.U64);
                return result;
            default:
                int bits = scalar switch
                {
                    Scalar.I8 or Scalar.U8 => 8,
                    Scalar.I16 or Scalar.U16 or Scalar.Char => 16,
                    Scalar.I32 or Scalar.U32 => 32,
                    _ => 64,
                };
                code.I32(bits * 2 + (IsSigned(scalar) ? 1 : 0));
                return WType.I32;
        }
    }

    private WasmFunction EmitEnumFormat()
    {
        var type = plan.ContainingType!;
        var scalar = Frontend.ScalarOf(type)!.Value;
        bool unsigned = scalar is Scalar.U8 or Scalar.U16 or Scalar.U32 or Scalar.U64;
        var members = Frontend.EnumMembers(type);
        int value = NewLocal(WType.I64);
        LocalGet(0);
        if (Frontend.Represent(scalar) == WType.I32)
        {
            code.Byte(unsigned ? (byte)0xad : (byte)0xac); // i64.extend_i32_u / _s
        }

        LocalSet(value);
        void Return() => code.Byte(0x0f); // return
        void Numeric()
        {
            LocalGet(value);
            CallString(unsigned ? "FromUInt64" : "FromInt64", 1);
        }

        ulong? previous = null;
        foreach (var (name, constant) in members)
        {
            if (previous == constant)
            {
                continue;
            }

            previous = constant;
            LocalGet(value);
            code.I64((long)constant);
            code.Byte(0x51); // i64.eq
            OpenBlock(0x04, WType.Void, new object());
            EmitLiteral(name);
            Return();
            CloseBlock();
        }

        if (!frontend.IsFlags(type))
        {
            // Only the F format combines the names of an enum without
            // [Flags].
            LocalGet(1);
            code.Byte(0x45); // i32.eqz
            OpenBlock(0x04, WType.Void, new object());
            Numeric();
            Return();
            CloseBlock();
        }

        LocalGet(value);
        code.Byte(0x50); // i64.eqz
        OpenBlock(0x04, WType.Void, new object());
        Numeric();
        Return();
        CloseBlock();

        // Largest first, each whose bits remain; named lowest first.
        int rest = NewLocal(WType.I64);
        int text = NewLocal(Text);
        LocalGet(value);
        LocalSet(rest);
        for (int index = members.Count - 1; index >= 0; index--)
        {
            ulong constant = members[index].Value;
            if (index == 0 && constant == 0)
            {
                break;
            }

            LocalGet(rest);
            code.I64((long)constant);
            code.Byte(0x83); // i64.and
            code.I64((long)constant);
            code.Byte(0x51); // i64.eq
            OpenBlock(0x04, WType.Void, new object());
            LocalGet(rest);
            code.I64((long)constant);
            code.Byte(0x7d); // i64.sub
            LocalSet(rest);
            LocalGet(text);
            code.Byte(0xd1); // ref.is_null
            OpenBlock(0x04, Text, new object());
            EmitLiteral(members[index].Name);
            code.Byte(0x05); // else
            EmitLiteral(members[index].Name + ", ");
            LocalGet(text);
            CallString("Concat", 2);
            CloseBlock();
            LocalSet(text);
            CloseBlock();
        }

        LocalGet(rest);
        code.Byte(0x50); // i64.eqz
        OpenBlock(0x04, Text, new object());
        LocalGet(text);
        code.Byte(0x05); // else
        Numeric();
        CloseBlock();
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // An enum value with a G, F, D or X format.
    private void EmitEnumFormatted(Action pushValue, INamedTypeSymbol type, string? format)
    {
        var scalar = Frontend.ScalarOf(type)!.Value;
        bool unsigned = scalar is Scalar.U8 or Scalar.U16 or Scalar.U32 or Scalar.U64;
        int bits = scalar switch
        {
            Scalar.I8 or Scalar.U8 => 8,
            Scalar.I16 or Scalar.U16 => 16,
            Scalar.I32 or Scalar.U32 => 32,
            _ => 64,
        };
        switch (format)
        {
            case null or "" or "G" or "g" or "F" or "f":
                pushValue();
                code.I32(format is "F" or "f" ? 1 : 0);
                Call(frontend.EnumFormatter(type));
                return;
            case "D" or "d" or "X" or "x":
                pushValue();
                if (Frontend.Represent(scalar) == WType.I32)
                {
                    code.Byte(unsigned ? (byte)0xad : (byte)0xac); // i64.extend_i32_u / _s
                }

                code.I32(unsigned ? 1 : 0);
                code.I32(bits);
                EmitLiteral(format is "D" or "d" ? "D" : format + (bits / 4));
                Call(frontend.MethodIndex(frontend.RuntimeMethod("Number", "FormatInteger", 4)));
                return;
            default:
                throw new CompileError($"'{format}' is no enum format: G, F, D or X.");
        }
    }
}
