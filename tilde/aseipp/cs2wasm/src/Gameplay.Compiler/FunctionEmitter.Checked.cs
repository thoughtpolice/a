// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis.Operations;

namespace Gameplay.Compiler;

// Checked arithmetic and conversions: integer +, -, * (binary, compound,
// ++ and --), unary minus, and explicit numeric conversions in a checked
// context fault with 9 (OverflowException where the module handles
// exceptions) where the exact result does not fit, as the CLR's throw.
// Floating-point operations never overflow; conversions from floating
// point to an integer fail for NaN and for values whose truncation is out
// of range.
internal sealed partial class FunctionEmitter
{

    private static bool IsCheckable(BinaryOperatorKind kind) =>
        kind is BinaryOperatorKind.Add or BinaryOperatorKind.Subtract or BinaryOperatorKind.Multiply;

    // Two operands of `scalar` (int or wider) on the stack, left then right:
    // leaves their exact sum, difference or product, faulting if it does
    // not fit.
    private void EmitCheckedArithmetic(Scalar scalar, BinaryOperatorKind kind)
    {
        var type = Frontend.Represent(scalar);
        bool signed = IsSigned(scalar);
        if (type == WType.I32)
        {
            // Exactly, in 64 bits: a 32-bit product fits there.
            int right = Save(WType.I32);
            code.Byte(signed ? (byte)0xac : (byte)0xad); // i64.extend_i32_s/u
            LocalGet(right);
            code.Byte(signed ? (byte)0xac : (byte)0xad);
            code.Byte(BinaryOpcode(Scalar.I64, kind));
            int exact = Save(WType.I64);
            LocalGet(exact);
            if (signed)
            {
                LocalGet(exact);
                code.Byte(0xa7); // i32.wrap_i64
                code.Byte(0xac); // i64.extend_i32_s
                code.Byte(0x52); // i64.ne
            }
            else
            {
                code.I64(32);
                code.Byte(0x88); // i64.shr_u
                code.Byte(0x50); // i64.eqz
                code.Byte(0x45); // i32.eqz
            }

            FaultIf(FaultCode.ArithmeticOverflow);
            LocalGet(exact);
            code.Byte(0xa7); // i32.wrap_i64
            return;
        }

        if (type != WType.I64)
        {
            throw new CompileError("Checked arithmetic needs integer operands.");
        }

        int b = Save(WType.I64);
        int a = Save(WType.I64);
        LocalGet(a);
        LocalGet(b);
        code.Byte(BinaryOpcode(scalar, kind));
        int result = Save(WType.I64);
        switch (kind)
        {
            case BinaryOperatorKind.Add when signed:
                // The operands agree in sign and the result does not.
                LocalGet(a);
                LocalGet(result);
                code.Byte(0x85); // i64.xor
                LocalGet(b);
                LocalGet(result);
                code.Byte(0x85);
                code.Byte(0x83); // i64.and
                code.I64(0);
                code.Byte(0x53); // i64.lt_s
                break;
            case BinaryOperatorKind.Add:
                LocalGet(result);
                LocalGet(a);
                code.Byte(0x54); // i64.lt_u
                break;
            case BinaryOperatorKind.Subtract when signed:
                // The operands differ in sign and the result's is b's.
                LocalGet(a);
                LocalGet(b);
                code.Byte(0x85); // i64.xor
                LocalGet(a);
                LocalGet(result);
                code.Byte(0x85);
                code.Byte(0x83); // i64.and
                code.I64(0);
                code.Byte(0x53); // i64.lt_s
                break;
            case BinaryOperatorKind.Subtract:
                LocalGet(a);
                LocalGet(b);
                code.Byte(0x54); // i64.lt_u
                break;
            default:
                // a * b overflowed unless a is 0 or the product divided by
                // a gives b back; -1 * MinValue, whose division would
                // itself overflow, is the one case that check misses.
                LocalGet(a);
                code.Byte(0x50); // i64.eqz
                EmitChoice(WType.I32, () => code.I32(0), () =>
                {
                    if (signed)
                    {
                        LocalGet(a);
                        code.I64(-1);
                        code.Byte(0x51); // i64.eq
                        EmitChoice(WType.I32, () =>
                        {
                            LocalGet(b);
                            code.I64(long.MinValue);
                            code.Byte(0x51); // i64.eq
                        }, () => DividesBack(true));
                    }
                    else
                    {
                        DividesBack(false);
                    }
                });
                break;
        }

        FaultIf(FaultCode.ArithmeticOverflow);
        LocalGet(result);

        void DividesBack(bool signedDivision)
        {
            LocalGet(result);
            LocalGet(a);
            code.Byte(signedDivision ? (byte)0x7f : (byte)0x80); // i64.div_s/u
            LocalGet(b);
            code.Byte(0x52); // i64.ne
        }
    }

    // An integer type's range, exactly.
    private static (long Minimum, ulong Maximum) IntegerRange(Scalar scalar) => scalar switch
    {
        Scalar.I8 => (sbyte.MinValue, (ulong)sbyte.MaxValue),
        Scalar.U8 => (0, byte.MaxValue),
        Scalar.I16 => (short.MinValue, (ulong)short.MaxValue),
        Scalar.U16 or Scalar.Char => (0, ushort.MaxValue),
        Scalar.I32 => (int.MinValue, int.MaxValue),
        Scalar.U32 => (0, uint.MaxValue),
        Scalar.I64 => (long.MinValue, long.MaxValue),
        Scalar.U64 => (0, ulong.MaxValue),
        _ => throw new InternalCompilerError($"'{scalar}' is not an integer type."),
    };

    // The value of `source` on the stack stays; faults if it is out of
    // `destination`'s range (for floating point, if its truncation is).
    private void CheckConversion(Scalar source, Scalar destination, FaultCode overflow = FaultCode.ArithmeticOverflow)
    {
        if (IsFloating(destination) || source == destination || (!IsFloating(source) && Fits(source, destination)))
        {
            return;
        }

        var type = Frontend.Represent(source);
        int value = Save(type);
        if (IsFloating(source))
        {
            // In range when minimum - 1 < v < maximum + 1, which NaN is not.
            // Past 32 bits those bounds round to the powers of two that
            // are the exact limits.
            LocalGet(value);
            if (source == Scalar.F32)
            {
                code.Byte(0xbb); // f64.promote_f32
            }

            int wide = Save(WType.F64);
            var (lowOk, highOk) = destination switch
            {
                Scalar.I64 => (-9223372036854775808.0, 9223372036854775808.0),
                Scalar.U64 => (-1.0, 18446744073709551616.0),
                _ => (Range(destination).Minimum - 1, Range(destination).Maximum + 1),
            };
            LocalGet(wide);
            code.F64Const(lowOk);
            code.Byte(destination == Scalar.I64 ? (byte)0x66 : (byte)0x64); // f64.ge / f64.gt
            LocalGet(wide);
            code.F64Const(highOk);
            code.Byte(0x63); // f64.lt
            code.Byte(0x71); // i32.and
            code.Byte(0x45); // i32.eqz
            FaultIf(overflow);
            LocalGet(value);
            return;
        }

        var (minimum, maximum) = IntegerRange(destination);
        LocalGet(value);
        if (source == Scalar.U64)
        {
            // Too big as an unsigned number (every destination but ulong
            // has a maximum below 2^63).
            code.I64((long)maximum);
            code.Byte(0x56); // i64.gt_u
        }
        else
        {
            if (type == WType.I32)
            {
                code.Byte(IsSigned(source) ? (byte)0xac : (byte)0xad); // i64.extend_i32_s/u
            }

            int wide = Save(WType.I64);
            LocalGet(wide);
            code.I64(minimum);
            code.Byte(0x53); // i64.lt_s
            if (destination != Scalar.U64)
            {
                LocalGet(wide);
                code.I64((long)maximum);
                code.Byte(0x55); // i64.gt_s
                code.Byte(0x72); // i32.or
            }
        }

        FaultIf(overflow);
        LocalGet(value);
    }
}
