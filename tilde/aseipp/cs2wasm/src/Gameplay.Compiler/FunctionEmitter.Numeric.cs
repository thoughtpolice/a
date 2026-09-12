// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Globalization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
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

    // Small-integer arithmetic happens in int, as C# defines it.
    private static Scalar Promote(Scalar scalar) => IsNarrow(scalar) ? Scalar.I32 : scalar;

    private static Scalar ScalarOf(IOperation operation) => Frontend.ScalarOf(operation.Type)
        ?? throw CompileError.At(operation, $"Type '{operation.Type?.ToDisplayString()}' is not a scalar.");

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

    private void EmitConstant(ITypeSymbol type, object? value, IOperation site)
    {
        var wasmType = frontend.MapType(type);
        if (value is null)
        {
            if (!wasmType.IsRef)
            {
                throw CompileError.At(site, "Unsupported null constant.");
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
            default:
                throw CompileError.At(site, "Unsupported constant representation.");
        }
    }

    private void EmitOne(Scalar scalar) => code.Const(Frontend.Represent(scalar), 1L);

    // MARK: Conversions

    private WType EmitConversion(IConversionOperation conversion)
    {
        var target = frontend.MapType(conversion.Type);
        if (conversion.OperatorMethod is not null || conversion.IsTryCast || conversion.IsChecked)
        {
            throw CompileError.At(conversion, "User-defined, checked and 'as' conversions are unsupported.");
        }

        if (conversion.Operand.ConstantValue is { HasValue: true, Value: null } && target.IsRef)
        {
            target.Default(code);
            return target;
        }

        // The C#-specific classification tells enum conversions apart from
        // the boxing and nullable conversions that are rejected.
        var kind = conversion.GetConversion();
        if (kind.IsIdentity)
        {
            EmitExpression(conversion.Operand);
            return target;
        }

        if (target.IsRef)
        {
            if (kind.IsReference && SymbolEqualityComparer.Default.Equals(conversion.Type, conversion.Operand.Type))
            {
                EmitExpression(conversion.Operand);
                return target;
            }

            throw CompileError.At(conversion, "Reference conversions other than identity are unsupported.");
        }

        var source = Frontend.ScalarOf(conversion.Operand.Type);
        var destination = Frontend.ScalarOf(conversion.Type);
        if ((kind.IsNumeric || kind.IsEnumeration) && source is not null && destination is not null)
        {
            EmitExpression(conversion.Operand);
            EmitScalarConversion(source.Value, destination.Value, conversion);
            return target;
        }

        throw CompileError.At(conversion, "Conversion is outside the supported scalar and reference subset.");
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
    private void EmitScalarConversion(Scalar source, Scalar destination, IOperation site)
    {
        if (source == destination)
        {
            return;
        }

        if (source == Scalar.Bool || destination == Scalar.Bool)
        {
            throw CompileError.At(site, "There are no numeric conversions involving bool.");
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

        throw CompileError.At(site, "Unsupported scalar conversion.");
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

    private void ApplyConversion(Conversion conversion, Scalar source, Scalar destination, IOperation site)
    {
        if (conversion.IsIdentity)
        {
            return;
        }

        if (conversion.IsUserDefined || !(conversion.IsNumeric || conversion.IsEnumeration))
        {
            throw CompileError.At(site, "Unsupported conversion in a compound assignment.");
        }

        EmitScalarConversion(source, destination, site);
    }

    // MARK: Operators

    private WType EmitUnary(IUnaryOperation unary)
    {
        if (unary.OperatorMethod is not null || unary.IsLifted || unary.IsChecked)
        {
            throw CompileError.At(unary, "User-defined, lifted and checked unary operations are unsupported.");
        }

        var scalar = ScalarOf(unary);
        var type = Frontend.Represent(scalar);
        switch (unary.OperatorKind)
        {
            case UnaryOperatorKind.Plus:
                EmitExpression(unary.Operand);
                return type;
            case UnaryOperatorKind.Minus when type == WType.I32:
                code.I32(0);
                EmitExpression(unary.Operand);
                code.Byte(0x6b); // i32.sub
                Narrow(scalar);
                return type;
            case UnaryOperatorKind.Minus when type == WType.I64:
                code.I64(0);
                EmitExpression(unary.Operand);
                code.Byte(0x7d); // i64.sub
                return type;
        }

        EmitExpression(unary.Operand);
        switch (unary.OperatorKind)
        {
            case UnaryOperatorKind.Minus when type == WType.F32:
                code.Byte(0x8c); // f32.neg
                break;
            case UnaryOperatorKind.Minus when type == WType.F64:
                code.Byte(0x9a); // f64.neg
                break;
            case UnaryOperatorKind.Not when scalar == Scalar.Bool:
                code.Byte(0x45); // i32.eqz
                break;
            case UnaryOperatorKind.BitwiseNegation when type == WType.I32:
                code.I32(-1);
                code.Byte(0x73); // i32.xor
                Narrow(scalar);
                break;
            case UnaryOperatorKind.BitwiseNegation when type == WType.I64:
                code.I64(-1);
                code.Byte(0x85); // i64.xor
                break;
            default:
                throw CompileError.At(unary, "Unsupported unary operator.");
        }

        return type;
    }

    private static bool IsShift(BinaryOperatorKind kind) =>
        kind is BinaryOperatorKind.LeftShift or BinaryOperatorKind.RightShift or BinaryOperatorKind.UnsignedRightShift;

    private WType EmitBinary(IBinaryOperation binary)
    {
        if (binary.OperatorMethod is not null || binary.IsLifted || binary.IsChecked)
        {
            throw CompileError.At(binary, "User-defined, lifted and checked binary operations are unsupported.");
        }

        var leftOperand = Frontend.ReferenceEqualityOperand(binary.LeftOperand);
        var rightOperand = Frontend.ReferenceEqualityOperand(binary.RightOperand);
        var resultType = frontend.MapType(binary.Type);
        var operatorKind = binary.OperatorKind;
        if (operatorKind is BinaryOperatorKind.ConditionalAnd or BinaryOperatorKind.ConditionalOr)
        {
            EmitExpression(binary.LeftOperand);
            OpenBlock(0x04, WType.I32, new object());
            if (operatorKind == BinaryOperatorKind.ConditionalAnd)
            {
                EmitExpression(binary.RightOperand);
                code.Byte(0x05); // else
                code.I32(0);
            }
            else
            {
                code.I32(1);
                code.Byte(0x05); // else
                EmitExpression(binary.RightOperand);
            }

            CloseBlock();
            return WType.I32;
        }

        var operandType = frontend.MapType(leftOperand.Type ?? rightOperand.Type);
        if (operandType.IsRef && operatorKind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals)
        {
            if (leftOperand.ConstantValue is { HasValue: true, Value: null })
            {
                operandType.Default(code);
            }
            else
            {
                EmitExpression(leftOperand);
            }

            if (rightOperand.ConstantValue is { HasValue: true, Value: null })
            {
                operandType.Default(code);
            }
            else
            {
                EmitExpression(rightOperand);
            }

            code.Byte(0xd3); // ref.eq
            if (operatorKind == BinaryOperatorKind.NotEquals)
            {
                code.Byte(0x45); // i32.eqz
            }

            return WType.I32;
        }

        var scalar = ScalarOf(leftOperand);
        EmitExpression(binary.LeftOperand);
        EmitExpression(binary.RightOperand);
        if (IsShift(operatorKind) && Frontend.Represent(scalar) == WType.I64)
        {
            code.Byte(0xac); // i64.extend_i32_s: the count is an int
        }

        EmitNumericBinary(scalar, operatorKind, binary);
        if (Frontend.ScalarOf(binary.Type) is { } result)
        {
            // Enum arithmetic with a narrow underlying type wraps to it.
            Narrow(result);
        }

        return resultType;
    }

    // Operands are already evaluated, left then right. Saving them here keeps
    // arithmetic fault handling identical for binary and compound operators.
    private void EmitNumericBinary(Scalar scalar, BinaryOperatorKind operatorKind, IOperation site)
    {
        var type = Frontend.Represent(scalar);
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
                byte equals = BinaryOpcode(scalar, BinaryOperatorKind.Equals, site);
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

        code.Byte(BinaryOpcode(scalar, operatorKind, site));
    }

    private static byte BinaryOpcode(Scalar scalar, BinaryOperatorKind operatorKind, IOperation site)
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
                _ => throw CompileError.At(site, "Unsupported integer/Boolean operator.")
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
                _ => throw CompileError.At(site, "Unsupported 64-bit integer operator.")
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
                _ => throw CompileError.At(site, "Unsupported float operator (floating remainder is not implemented).")
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
                _ => throw CompileError.At(site, "Unsupported double operator (floating remainder is not implemented).")
            };
        }

        throw CompileError.At(site, "Unsupported operand type.");
    }

    // MARK: Compound assignment and increments

    private WType EmitCompoundAssignment(ICompoundAssignmentOperation assignment)
    {
        if (assignment.OperatorMethod is not null || assignment.IsChecked || assignment.IsLifted)
        {
            throw CompileError.At(assignment, "User-defined, checked and lifted compound assignments are unsupported.");
        }

        var location = PrepareLocation(assignment.Target);
        if (location.Type.IsRef)
        {
            throw CompileError.At(assignment, "Compound assignment needs a scalar target.");
        }

        var target = ScalarOf(assignment.Target);
        // Roslyn converts the target to the operator's left operand type
        // (InConversion) and the result back (OutConversion). The operator
        // works in the right operand's type, or the promoted target type for
        // shifts, whose count stays an int.
        var operatorKind = assignment.OperatorKind;
        bool shift = IsShift(operatorKind);
        var operand = shift ? Promote(target) : ScalarOf(assignment.Value);
        if (target == Scalar.Bool
            && operatorKind is not (BinaryOperatorKind.And or BinaryOperatorKind.Or or BinaryOperatorKind.ExclusiveOr))
        {
            throw CompileError.At(assignment, "Unsupported compound assignment operand types.");
        }

        // Unlike simple assignment, compound assignment reads (and therefore
        // checks) its location before evaluating the right-hand side. Retain
        // that old value even if the right-hand side changes the same location.
        Load(location);
        ApplyConversion(assignment.GetInConversion(), target, operand, assignment);
        EmitExpression(assignment.Value);
        if (shift && Frontend.Represent(operand) == WType.I64)
        {
            code.Byte(0xac); // i64.extend_i32_s
        }

        EmitNumericBinary(operand, operatorKind, assignment);
        Narrow(operand);
        ApplyConversion(assignment.GetOutConversion(), operand, target, assignment);
        int value = NewLocal(location.Type);
        LocalSet(value);
        Store(location, value);
        LocalGet(value);
        return location.Type;
    }

    private WType EmitIncrement(IIncrementOrDecrementOperation increment)
    {
        if (increment.OperatorMethod is not null || increment.IsChecked || increment.IsLifted)
        {
            throw CompileError.At(increment, "User-defined, checked and lifted increments are unsupported.");
        }

        var location = PrepareLocation(increment.Target);
        if (location.Type.IsRef || ScalarOf(increment.Target) == Scalar.Bool)
        {
            throw CompileError.At(increment, "Increment/decrement needs a numeric target.");
        }

        var scalar = ScalarOf(increment.Target);
        var type = Frontend.Represent(scalar);
        Load(location);
        int before = NewLocal(type);
        LocalSet(before);
        LocalGet(before);
        EmitOne(scalar);
        var operatorKind = increment.Kind == OperationKind.Increment ? BinaryOperatorKind.Add : BinaryOperatorKind.Subtract;
        code.Byte(BinaryOpcode(scalar, operatorKind, increment));
        Narrow(scalar);
        int after = NewLocal(type);
        LocalSet(after);
        Store(location, after);
        LocalGet(increment.IsPostfix ? before : after);
        return type;
    }
}
