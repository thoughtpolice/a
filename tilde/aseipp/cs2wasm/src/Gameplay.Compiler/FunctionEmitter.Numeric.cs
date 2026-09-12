// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Globalization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Gameplay.Compiler;

// Scalars: constants, conversions, operators and the assignments built on
// them. Every scalar sits in an i32, i64, f32 or f64; narrow integers are
// kept canonical (sign- or zero-extended) so that reading one needs no work
// and every operation that could leave the range wraps it back.
internal sealed partial class FunctionEmitter
{
    private static bool IsNarrow(Scalar scalar) =>
        scalar is Scalar.I8 or Scalar.U8 or Scalar.I16 or Scalar.U16 or Scalar.Char;

    private static bool IsSigned(Scalar scalar) =>
        scalar is Scalar.I8 or Scalar.I16 or Scalar.I32 or Scalar.I64;

    private static bool IsFloating(Scalar scalar) => scalar is Scalar.F32 or Scalar.F64;

    // Brings an i32 into the canonical representation of a narrow integer or
    // bool: what an exported entry does to host arguments, an import call to
    // host results, and arithmetic to values that may have left the range.
    public static void Canonicalize(WasmWriter code, Scalar scalar)
    {
        switch (scalar)
        {
            case Scalar.Bool:
                code.Byte(0x45); // i32.eqz
                code.Byte(0x45); // i32.eqz
                break;
            case Scalar.I8:
                code.Byte(0xc0); // i32.extend8_s
                break;
            case Scalar.U8:
                code.I32(0xff);
                code.Byte(0x71); // i32.and
                break;
            case Scalar.I16:
                code.Byte(0xc1); // i32.extend16_s
                break;
            case Scalar.U16:
            case Scalar.Char:
                code.I32(0xffff);
                code.Byte(0x71); // i32.and
                break;
        }
    }

    private void Narrow(Scalar scalar)
    {
        if (IsNarrow(scalar))
        {
            Canonicalize(code, scalar);
        }
    }

    // MARK: Constants

    private void EmitConstant(ITypeSymbol type, object? value)
    {
        var wasmType = Map(type);
        if (value is null)
        {
            if (IsNullable(type))
            {
                PushDefault(wasmType);
                return;
            }

            if (!wasmType.IsRef)
            {
                throw new CompileError("Unsupported null constant.");
            }

            wasmType.Default(code);
            return;
        }

        // Enum constants carry their underlying value; every integer type is
        // stored as its sign- or zero-extended pattern.
        switch (value)
        {
            case bool boolean:
                code.I32(boolean ? 1 : 0);
                return;
            case sbyte or byte or short or ushort or char or int:
                code.I32(Convert.ToInt32(value, CultureInfo.InvariantCulture));
                return;
            case uint number:
                code.I32(unchecked((int)number));
                return;
            case long number:
                code.I64(number);
                return;
            case ulong number:
                code.I64(unchecked((long)number));
                return;
            case float number:
                code.F32Const(number);
                return;
            case double number:
                code.F64Const(number);
                return;
            case string text:
                EmitLiteral(text);
                return;
            case decimal number:
                // The runtime's Decimal, flattened: its flags, the high 32
                // bits and the low 64 (runtime/Decimal.cs). Roslyn makes a
                // whole number of an int's or long's size with Decimal.Zero
                // or decimal(long), so -0m is 0m, as in the CLR.
                int[] bits = decimal.GetBits(number == 0m && number.Scale == 0 ? 0m : number);
                code.I32(bits[3]);
                code.I32(bits[2]);
                code.I64((long)(uint)bits[0] | ((long)bits[1] << 32));
                return;
            default:
                throw new CompileError("Unsupported constant representation.");
        }
    }

    private static (double Minimum, double Maximum) Range(Scalar scalar) => scalar switch
    {
        Scalar.Bool => (0, 1),
        Scalar.I8 => (sbyte.MinValue, sbyte.MaxValue),
        Scalar.U8 => (byte.MinValue, byte.MaxValue),
        Scalar.I16 => (short.MinValue, short.MaxValue),
        Scalar.U16 or Scalar.Char => (ushort.MinValue, ushort.MaxValue),
        Scalar.I32 => (int.MinValue, int.MaxValue),
        Scalar.U32 => (uint.MinValue, uint.MaxValue),
        Scalar.I64 => (long.MinValue, long.MaxValue),
        Scalar.U64 => (ulong.MinValue, ulong.MaxValue),
        _ => (double.NegativeInfinity, double.PositiveInfinity),
    };

    private static bool Fits(Scalar source, Scalar destination)
    {
        var (sourceMinimum, sourceMaximum) = Range(source);
        var (destinationMinimum, destinationMaximum) = Range(destination);
        return sourceMinimum >= destinationMinimum && sourceMaximum <= destinationMaximum;
    }

    // Unchecked C# semantics: integers wrap, and floating-point to integer
    // conversions saturate to the destination's range with NaN becoming zero,
    // as .NET 9 and later define for every integer width.
    private void EmitScalarConversion(Scalar source, Scalar destination)
    {
        if (source == destination)
        {
            return;
        }

        if (source == Scalar.Bool || destination == Scalar.Bool)
        {
            throw new CompileError("There are no numeric conversions involving bool.");
        }

        byte sourceCode = Frontend.Represent(source).Code;
        if (sourceCode == 0x7f)
        {
            bool signed = IsSigned(source);
            switch (destination)
            {
                case Scalar.I8 or Scalar.U8 or Scalar.I16 or Scalar.U16 or Scalar.Char:
                    if (!Fits(source, destination))
                    {
                        Narrow(destination);
                    }

                    return;
                case Scalar.I32 or Scalar.U32:
                    return;
                case Scalar.I64 or Scalar.U64:
                    code.Byte(signed ? (byte)0xac : (byte)0xad); // i64.extend_i32_s/u
                    return;
                case Scalar.F32:
                    code.Byte(signed ? (byte)0xb2 : (byte)0xb3); // f32.convert_i32_s/u
                    return;
                case Scalar.F64:
                    code.Byte(signed ? (byte)0xb7 : (byte)0xb8); // f64.convert_i32_s/u
                    return;
            }
        }
        else if (sourceCode == 0x7e)
        {
            bool signed = source == Scalar.I64;
            switch (destination)
            {
                case Scalar.I64 or Scalar.U64:
                    return;
                case Scalar.F32:
                    code.Byte(signed ? (byte)0xb4 : (byte)0xb5); // f32.convert_i64_s/u
                    return;
                case Scalar.F64:
                    code.Byte(signed ? (byte)0xb9 : (byte)0xba); // f64.convert_i64_s/u
                    return;
                default:
                    code.Byte(0xa7); // i32.wrap_i64
                    Narrow(destination);
                    return;
            }
        }
        else
        {
            bool single = source == Scalar.F32;
            switch (destination)
            {
                case Scalar.F32:
                    code.Byte(0xb6); // f32.demote_f64
                    return;
                case Scalar.F64:
                    code.Byte(0xbb); // f64.promote_f32
                    return;
                case Scalar.I64:
                    code.Misc(single ? 4u : 6u); // i64.trunc_sat_f32/f64_s
                    return;
                case Scalar.U64:
                    code.Misc(single ? 5u : 7u); // i64.trunc_sat_f32/f64_u
                    return;
                case Scalar.U32:
                    code.Misc(single ? 1u : 3u); // i32.trunc_sat_f32/f64_u
                    return;
                case Scalar.I32:
                    code.Misc(single ? 0u : 2u); // i32.trunc_sat_f32/f64_s
                    return;
                default:
                    // The runtime saturates to the narrow type's own range:
                    // (byte)300.7 is 255 and (sbyte)-1e9 is -128.
                    code.Misc(single ? 0u : 2u); // i32.trunc_sat_f32/f64_s
                    SaturateNarrow(destination);
                    return;
            }
        }

        throw new CompileError("Unsupported scalar conversion.");
    }

    // Clamps the i32 on the stack to a narrow integer's range.
    private void SaturateNarrow(Scalar destination)
    {
        var (minimum, maximum) = Range(destination);
        int value = NewLocal(WType.I32);
        LocalSet(value);
        code.I32((int)minimum);
        LocalGet(value);
        LocalGet(value);
        code.I32((int)minimum);
        code.Byte(0x48); // i32.lt_s
        code.Byte(0x1b); // select: value < minimum ? minimum : value
        LocalSet(value);
        code.I32((int)maximum);
        LocalGet(value);
        LocalGet(value);
        code.I32((int)maximum);
        code.Byte(0x4a); // i32.gt_s
        code.Byte(0x1b); // select: value > maximum ? maximum : value
    }

    // Operands are already evaluated, left then right. Saving them here keeps
    // arithmetic fault handling identical for binary and compound operators.
    private void EmitNumericBinary(Scalar scalar, BinaryOperatorKind operatorKind, bool isChecked = false)
    {
        var type = Frontend.Represent(scalar);
        if (isChecked && !IsFloating(scalar) && IsCheckable(operatorKind))
        {
            EmitCheckedArithmetic(scalar, operatorKind);
            return;
        }

        if (IsFloating(scalar) && operatorKind == BinaryOperatorKind.Remainder)
        {
            // IEEE fmod, exactly (runtime/Math.cs).
            Call(frontend.MethodIndex(
                frontend.RuntimeMethod("Transcendental", scalar == Scalar.F32 ? "FmodF" : "Fmod", 2)));
            return;
        }

        if (!IsFloating(scalar) && operatorKind is BinaryOperatorKind.Divide or BinaryOperatorKind.Remainder)
        {
            bool wide = type == WType.I64;
            int right = NewLocal(type);
            LocalSet(right);
            int left = NewLocal(type);
            LocalSet(left);
            LocalGet(right);
            code.Byte(wide ? (byte)0x50 : (byte)0x45); // i64.eqz / i32.eqz
            FaultIf(FaultCode.DivisionByZero);

            if (IsSigned(scalar))
            {
                // Choose the throwing C# division-overflow behavior consistently
                // for both / and %. Wasm rem_s by itself returns zero for Min/-1.
                byte equals = BinaryOpcode(scalar, BinaryOperatorKind.Equals);
                LocalGet(left);
                code.Const(type, wide ? long.MinValue : int.MinValue);
                code.Byte(equals);
                LocalGet(right);
                code.Const(type, -1L);
                code.Byte(equals);
                code.Byte(0x71); // i32.and
                FaultIf(FaultCode.DivisionOverflow);
            }

            LocalGet(left);
            LocalGet(right);
        }

        code.Byte(BinaryOpcode(scalar, operatorKind));
    }

    private static byte BinaryOpcode(Scalar scalar, BinaryOperatorKind operatorKind)
    {
        var type = Frontend.Represent(scalar);
        bool signed = IsSigned(scalar);
        if (type == WType.I32)
        {
            return operatorKind switch
            {
                BinaryOperatorKind.Add => 0x6a,
                BinaryOperatorKind.Subtract => 0x6b,
                BinaryOperatorKind.Multiply => 0x6c,
                BinaryOperatorKind.Divide => signed ? (byte)0x6d : (byte)0x6e,
                BinaryOperatorKind.Remainder => signed ? (byte)0x6f : (byte)0x70,
                BinaryOperatorKind.And => 0x71,
                BinaryOperatorKind.Or => 0x72,
                BinaryOperatorKind.ExclusiveOr => 0x73,
                BinaryOperatorKind.LeftShift => 0x74,
                BinaryOperatorKind.RightShift => signed ? (byte)0x75 : (byte)0x76,
                BinaryOperatorKind.UnsignedRightShift => 0x76,
                BinaryOperatorKind.Equals => 0x46,
                BinaryOperatorKind.NotEquals => 0x47,
                BinaryOperatorKind.LessThan => signed ? (byte)0x48 : (byte)0x49,
                BinaryOperatorKind.GreaterThan => signed ? (byte)0x4a : (byte)0x4b,
                BinaryOperatorKind.LessThanOrEqual => signed ? (byte)0x4c : (byte)0x4d,
                BinaryOperatorKind.GreaterThanOrEqual => signed ? (byte)0x4e : (byte)0x4f,
                _ => throw new CompileError("Unsupported integer/Boolean operator.")
            };
        }

        if (type == WType.I64)
        {
            return operatorKind switch
            {
                BinaryOperatorKind.Add => 0x7c,
                BinaryOperatorKind.Subtract => 0x7d,
                BinaryOperatorKind.Multiply => 0x7e,
                BinaryOperatorKind.Divide => signed ? (byte)0x7f : (byte)0x80,
                BinaryOperatorKind.Remainder => signed ? (byte)0x81 : (byte)0x82,
                BinaryOperatorKind.And => 0x83,
                BinaryOperatorKind.Or => 0x84,
                BinaryOperatorKind.ExclusiveOr => 0x85,
                BinaryOperatorKind.LeftShift => 0x86,
                BinaryOperatorKind.RightShift => signed ? (byte)0x87 : (byte)0x88,
                BinaryOperatorKind.UnsignedRightShift => 0x88,
                BinaryOperatorKind.Equals => 0x51,
                BinaryOperatorKind.NotEquals => 0x52,
                BinaryOperatorKind.LessThan => signed ? (byte)0x53 : (byte)0x54,
                BinaryOperatorKind.GreaterThan => signed ? (byte)0x55 : (byte)0x56,
                BinaryOperatorKind.LessThanOrEqual => signed ? (byte)0x57 : (byte)0x58,
                BinaryOperatorKind.GreaterThanOrEqual => signed ? (byte)0x59 : (byte)0x5a,
                _ => throw new CompileError("Unsupported 64-bit integer operator.")
            };
        }

        if (type == WType.F32)
        {
            return operatorKind switch
            {
                BinaryOperatorKind.Add => 0x92,
                BinaryOperatorKind.Subtract => 0x93,
                BinaryOperatorKind.Multiply => 0x94,
                BinaryOperatorKind.Divide => 0x95,
                BinaryOperatorKind.Equals => 0x5b,
                BinaryOperatorKind.NotEquals => 0x5c,
                BinaryOperatorKind.LessThan => 0x5d,
                BinaryOperatorKind.GreaterThan => 0x5e,
                BinaryOperatorKind.LessThanOrEqual => 0x5f,
                BinaryOperatorKind.GreaterThanOrEqual => 0x60,
                _ => throw new CompileError("Unsupported float operator (floating remainder is not implemented).")
            };
        }

        if (type == WType.F64)
        {
            return operatorKind switch
            {
                BinaryOperatorKind.Add => 0xa0,
                BinaryOperatorKind.Subtract => 0xa1,
                BinaryOperatorKind.Multiply => 0xa2,
                BinaryOperatorKind.Divide => 0xa3,
                BinaryOperatorKind.Equals => 0x61,
                BinaryOperatorKind.NotEquals => 0x62,
                BinaryOperatorKind.LessThan => 0x63,
                BinaryOperatorKind.GreaterThan => 0x64,
                BinaryOperatorKind.LessThanOrEqual => 0x65,
                BinaryOperatorKind.GreaterThanOrEqual => 0x66,
                _ => throw new CompileError("Unsupported double operator (floating remainder is not implemented).")
            };
        }

        throw new CompileError("Unsupported operand type.");
    }
}
