// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Generic math for the primitive numeric types (`T : INumber<T>`): the
// interface members .NET's numeric types implement explicitly, and the
// conversions between them, as C# over the types' own operators, which is
// what dotnet/runtime's sources write too. The importer compiles these where
// a constrained call reaches them; the types themselves stay the module
// layer's scalars. Written by a script from the generated surface's
// declarations (the native integers' from long's and ulong's, which they are
// here); Parse and the byte-order members are not here, and decimal, Half
// and the 128-bit integers implement theirs themselves (runtime/DecimalMath.cs,
// dotnet/runtime's Half.cs, Int128.cs and UInt128.cs).

using System.Numerics;
using Gameplay.Runtime;

namespace System
{
    [Surface]
    public readonly partial struct SByte
    {
        static sbyte System.Numerics.IAdditiveIdentity<System.SByte, System.SByte>.AdditiveIdentity => (sbyte)0;

        static sbyte System.Numerics.IBinaryNumber<System.SByte>.AllBitsSet => unchecked((sbyte)~0);

        static sbyte System.Numerics.IMinMaxValue<System.SByte>.MaxValue => MaxValue;

        static sbyte System.Numerics.IMinMaxValue<System.SByte>.MinValue => MinValue;

        static sbyte System.Numerics.IMultiplicativeIdentity<System.SByte, System.SByte>.MultiplicativeIdentity => (sbyte)1;

        static sbyte System.Numerics.INumberBase<System.SByte>.One => (sbyte)1;

        static int System.Numerics.INumberBase<System.SByte>.Radix => 2;

        static sbyte System.Numerics.INumberBase<System.SByte>.Zero => (sbyte)0;

        static sbyte System.Numerics.ISignedNumber<System.SByte>.NegativeOne => (sbyte)-1;

        public static sbyte CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out sbyte result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<sbyte>();

        public static sbyte CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out sbyte result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<sbyte>();

        public static sbyte CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out sbyte result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<sbyte>();

        static sbyte System.Numerics.IAdditionOperators<sbyte, sbyte, sbyte>.operator +(sbyte left, sbyte right) => unchecked((sbyte)(left + right));

        static sbyte System.Numerics.IAdditionOperators<sbyte, sbyte, sbyte>.operator checked +(sbyte left, sbyte right) => checked((sbyte)(left + right));

        static sbyte System.Numerics.IBitwiseOperators<sbyte, sbyte, sbyte>.operator &(sbyte left, sbyte right) => unchecked((sbyte)(left & right));

        static sbyte System.Numerics.IBitwiseOperators<sbyte, sbyte, sbyte>.operator |(sbyte left, sbyte right) => unchecked((sbyte)(left | right));

        static sbyte System.Numerics.IBitwiseOperators<sbyte, sbyte, sbyte>.operator ^(sbyte left, sbyte right) => unchecked((sbyte)(left ^ right));

        static sbyte System.Numerics.IBitwiseOperators<sbyte, sbyte, sbyte>.operator ~(sbyte value) => unchecked((sbyte)(~value));

        static bool System.Numerics.IComparisonOperators<sbyte, sbyte, bool>.operator >(sbyte left, sbyte right) => left > right;

        static bool System.Numerics.IComparisonOperators<sbyte, sbyte, bool>.operator >=(sbyte left, sbyte right) => left >= right;

        static bool System.Numerics.IComparisonOperators<sbyte, sbyte, bool>.operator <(sbyte left, sbyte right) => left < right;

        static bool System.Numerics.IComparisonOperators<sbyte, sbyte, bool>.operator <=(sbyte left, sbyte right) => left <= right;

        static sbyte System.Numerics.IDecrementOperators<sbyte>.operator checked --(sbyte value) => checked((sbyte)(value - 1));

        static sbyte System.Numerics.IDecrementOperators<sbyte>.operator --(sbyte value) => unchecked((sbyte)(value - 1));

        static sbyte System.Numerics.IDivisionOperators<sbyte, sbyte, sbyte>.operator /(sbyte left, sbyte right) => unchecked((sbyte)(left / right));

        static bool System.Numerics.IEqualityOperators<sbyte, sbyte, bool>.operator ==(sbyte left, sbyte right) => left == right;

        static bool System.Numerics.IEqualityOperators<sbyte, sbyte, bool>.operator !=(sbyte left, sbyte right) => left != right;

        static sbyte System.Numerics.IIncrementOperators<sbyte>.operator checked ++(sbyte value) => checked((sbyte)(value + 1));

        static sbyte System.Numerics.IIncrementOperators<sbyte>.operator ++(sbyte value) => unchecked((sbyte)(value + 1));

        static sbyte System.Numerics.IModulusOperators<sbyte, sbyte, sbyte>.operator %(sbyte left, sbyte right) => unchecked((sbyte)(left % right));

        static sbyte System.Numerics.IMultiplyOperators<sbyte, sbyte, sbyte>.operator checked *(sbyte left, sbyte right) => checked((sbyte)(left * right));

        static sbyte System.Numerics.IMultiplyOperators<sbyte, sbyte, sbyte>.operator *(sbyte left, sbyte right) => unchecked((sbyte)(left * right));

        static bool System.Numerics.INumberBase<sbyte>.IsCanonical(sbyte value) => true;

        static bool System.Numerics.INumberBase<sbyte>.IsComplexNumber(sbyte value) => false;

        static bool System.Numerics.INumberBase<sbyte>.IsFinite(sbyte value) => true;

        static bool System.Numerics.INumberBase<sbyte>.IsImaginaryNumber(sbyte value) => false;

        static bool System.Numerics.INumberBase<sbyte>.IsInfinity(sbyte value) => false;

        static bool System.Numerics.INumberBase<sbyte>.IsInteger(sbyte value) => true;

        static bool System.Numerics.INumberBase<sbyte>.IsNaN(sbyte value) => false;

        static bool System.Numerics.INumberBase<sbyte>.IsNegativeInfinity(sbyte value) => false;

        static bool System.Numerics.INumberBase<sbyte>.IsNormal(sbyte value) => value != 0;

        static bool System.Numerics.INumberBase<sbyte>.IsPositiveInfinity(sbyte value) => false;

        static bool System.Numerics.INumberBase<sbyte>.IsRealNumber(sbyte value) => true;

        static bool System.Numerics.INumberBase<sbyte>.IsSubnormal(sbyte value) => false;

        static bool System.Numerics.INumberBase<sbyte>.IsZero(sbyte value) => value == 0;

        static sbyte System.Numerics.INumberBase<sbyte>.MaxMagnitudeNumber(sbyte x, sbyte y) => MaxMagnitude(x, y);

        static sbyte System.Numerics.INumberBase<sbyte>.MinMagnitudeNumber(sbyte x, sbyte y) => MinMagnitude(x, y);

        static sbyte System.Numerics.INumberBase<sbyte>.MultiplyAddEstimate(sbyte left, sbyte right, sbyte addend) => unchecked((sbyte)((left * right) + addend));

        static bool System.Numerics.INumberBase<sbyte>.TryConvertFromChecked<TOther>(TOther value, out sbyte result) => Numbers.TryConvert<TOther, sbyte>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<sbyte>.TryConvertFromSaturating<TOther>(TOther value, out sbyte result) => Numbers.TryConvert<TOther, sbyte>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<sbyte>.TryConvertFromTruncating<TOther>(TOther value, out sbyte result) => Numbers.TryConvert<TOther, sbyte>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<sbyte>.TryConvertToChecked<TOther>(sbyte value, out TOther result) => Numbers.TryConvert<sbyte, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<sbyte>.TryConvertToSaturating<TOther>(sbyte value, out TOther result) => Numbers.TryConvert<sbyte, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<sbyte>.TryConvertToTruncating<TOther>(sbyte value, out TOther result) => Numbers.TryConvert<sbyte, TOther>(value, out result, Numbers.Truncating);

        static sbyte System.Numerics.INumber<sbyte>.MaxNumber(sbyte x, sbyte y) => x >= y ? x : y;

        static sbyte System.Numerics.INumber<sbyte>.MinNumber(sbyte x, sbyte y) => x <= y ? x : y;

        static sbyte System.Numerics.IShiftOperators<sbyte, int, sbyte>.operator <<(sbyte value, int shiftAmount) => (sbyte)(value << (shiftAmount & 7));

        static sbyte System.Numerics.IShiftOperators<sbyte, int, sbyte>.operator >>(sbyte value, int shiftAmount) => (sbyte)(value >> (shiftAmount & 7));

        static sbyte System.Numerics.IShiftOperators<sbyte, int, sbyte>.operator >>>(sbyte value, int shiftAmount) => (sbyte)((byte)value >>> (shiftAmount & 7));

        static sbyte System.Numerics.ISubtractionOperators<sbyte, sbyte, sbyte>.operator checked -(sbyte left, sbyte right) => checked((sbyte)(left - right));

        static sbyte System.Numerics.ISubtractionOperators<sbyte, sbyte, sbyte>.operator -(sbyte left, sbyte right) => unchecked((sbyte)(left - right));

        static sbyte System.Numerics.IUnaryNegationOperators<sbyte, sbyte>.operator checked -(sbyte value) => checked((sbyte)(-value));

        static sbyte System.Numerics.IUnaryNegationOperators<sbyte, sbyte>.operator -(sbyte value) => unchecked((sbyte)(-value));

        static sbyte System.Numerics.IUnaryPlusOperators<sbyte, sbyte>.operator +(sbyte value) => value;
    }

    [Surface]
    public readonly partial struct Byte
    {
        static byte System.Numerics.IAdditiveIdentity<System.Byte, System.Byte>.AdditiveIdentity => (byte)0;

        static byte System.Numerics.IBinaryNumber<System.Byte>.AllBitsSet => unchecked((byte)~0);

        static byte System.Numerics.IMinMaxValue<System.Byte>.MaxValue => MaxValue;

        static byte System.Numerics.IMinMaxValue<System.Byte>.MinValue => MinValue;

        static byte System.Numerics.IMultiplicativeIdentity<System.Byte, System.Byte>.MultiplicativeIdentity => (byte)1;

        static byte System.Numerics.INumberBase<System.Byte>.One => (byte)1;

        static int System.Numerics.INumberBase<System.Byte>.Radix => 2;

        static byte System.Numerics.INumberBase<System.Byte>.Zero => (byte)0;

        public static byte CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out byte result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<byte>();

        public static byte CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out byte result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<byte>();

        public static byte CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out byte result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<byte>();

        static byte System.Numerics.IAdditionOperators<byte, byte, byte>.operator +(byte left, byte right) => unchecked((byte)(left + right));

        static byte System.Numerics.IAdditionOperators<byte, byte, byte>.operator checked +(byte left, byte right) => checked((byte)(left + right));

        static byte System.Numerics.IBitwiseOperators<byte, byte, byte>.operator &(byte left, byte right) => unchecked((byte)(left & right));

        static byte System.Numerics.IBitwiseOperators<byte, byte, byte>.operator |(byte left, byte right) => unchecked((byte)(left | right));

        static byte System.Numerics.IBitwiseOperators<byte, byte, byte>.operator ^(byte left, byte right) => unchecked((byte)(left ^ right));

        static byte System.Numerics.IBitwiseOperators<byte, byte, byte>.operator ~(byte value) => unchecked((byte)(~value));

        static bool System.Numerics.IComparisonOperators<byte, byte, bool>.operator >(byte left, byte right) => left > right;

        static bool System.Numerics.IComparisonOperators<byte, byte, bool>.operator >=(byte left, byte right) => left >= right;

        static bool System.Numerics.IComparisonOperators<byte, byte, bool>.operator <(byte left, byte right) => left < right;

        static bool System.Numerics.IComparisonOperators<byte, byte, bool>.operator <=(byte left, byte right) => left <= right;

        static byte System.Numerics.IDecrementOperators<byte>.operator checked --(byte value) => checked((byte)(value - 1));

        static byte System.Numerics.IDecrementOperators<byte>.operator --(byte value) => unchecked((byte)(value - 1));

        static byte System.Numerics.IDivisionOperators<byte, byte, byte>.operator /(byte left, byte right) => unchecked((byte)(left / right));

        static bool System.Numerics.IEqualityOperators<byte, byte, bool>.operator ==(byte left, byte right) => left == right;

        static bool System.Numerics.IEqualityOperators<byte, byte, bool>.operator !=(byte left, byte right) => left != right;

        static byte System.Numerics.IIncrementOperators<byte>.operator checked ++(byte value) => checked((byte)(value + 1));

        static byte System.Numerics.IIncrementOperators<byte>.operator ++(byte value) => unchecked((byte)(value + 1));

        static byte System.Numerics.IModulusOperators<byte, byte, byte>.operator %(byte left, byte right) => unchecked((byte)(left % right));

        static byte System.Numerics.IMultiplyOperators<byte, byte, byte>.operator checked *(byte left, byte right) => checked((byte)(left * right));

        static byte System.Numerics.IMultiplyOperators<byte, byte, byte>.operator *(byte left, byte right) => unchecked((byte)(left * right));

        static byte System.Numerics.INumberBase<byte>.Abs(byte value) => value;

        static bool System.Numerics.INumberBase<byte>.IsCanonical(byte value) => true;

        static bool System.Numerics.INumberBase<byte>.IsComplexNumber(byte value) => false;

        static bool System.Numerics.INumberBase<byte>.IsFinite(byte value) => true;

        static bool System.Numerics.INumberBase<byte>.IsImaginaryNumber(byte value) => false;

        static bool System.Numerics.INumberBase<byte>.IsInfinity(byte value) => false;

        static bool System.Numerics.INumberBase<byte>.IsInteger(byte value) => true;

        static bool System.Numerics.INumberBase<byte>.IsNaN(byte value) => false;

        static bool System.Numerics.INumberBase<byte>.IsNegative(byte value) => false;

        static bool System.Numerics.INumberBase<byte>.IsNegativeInfinity(byte value) => false;

        static bool System.Numerics.INumberBase<byte>.IsNormal(byte value) => value != 0;

        static bool System.Numerics.INumberBase<byte>.IsPositive(byte value) => true;

        static bool System.Numerics.INumberBase<byte>.IsPositiveInfinity(byte value) => false;

        static bool System.Numerics.INumberBase<byte>.IsRealNumber(byte value) => true;

        static bool System.Numerics.INumberBase<byte>.IsSubnormal(byte value) => false;

        static bool System.Numerics.INumberBase<byte>.IsZero(byte value) => value == 0;

        static byte System.Numerics.INumberBase<byte>.MaxMagnitude(byte x, byte y) => x >= y ? x : y;

        static byte System.Numerics.INumberBase<byte>.MaxMagnitudeNumber(byte x, byte y) => x >= y ? x : y;

        static byte System.Numerics.INumberBase<byte>.MinMagnitude(byte x, byte y) => x <= y ? x : y;

        static byte System.Numerics.INumberBase<byte>.MinMagnitudeNumber(byte x, byte y) => x <= y ? x : y;

        static byte System.Numerics.INumberBase<byte>.MultiplyAddEstimate(byte left, byte right, byte addend) => unchecked((byte)((left * right) + addend));

        static bool System.Numerics.INumberBase<byte>.TryConvertFromChecked<TOther>(TOther value, out byte result) => Numbers.TryConvert<TOther, byte>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<byte>.TryConvertFromSaturating<TOther>(TOther value, out byte result) => Numbers.TryConvert<TOther, byte>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<byte>.TryConvertFromTruncating<TOther>(TOther value, out byte result) => Numbers.TryConvert<TOther, byte>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<byte>.TryConvertToChecked<TOther>(byte value, out TOther result) => Numbers.TryConvert<byte, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<byte>.TryConvertToSaturating<TOther>(byte value, out TOther result) => Numbers.TryConvert<byte, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<byte>.TryConvertToTruncating<TOther>(byte value, out TOther result) => Numbers.TryConvert<byte, TOther>(value, out result, Numbers.Truncating);

        static byte System.Numerics.INumber<byte>.MaxNumber(byte x, byte y) => x >= y ? x : y;

        static byte System.Numerics.INumber<byte>.MinNumber(byte x, byte y) => x <= y ? x : y;

        static byte System.Numerics.IShiftOperators<byte, int, byte>.operator <<(byte value, int shiftAmount) => (byte)(value << (shiftAmount & 7));

        static byte System.Numerics.IShiftOperators<byte, int, byte>.operator >>(byte value, int shiftAmount) => (byte)(value >> (shiftAmount & 7));

        static byte System.Numerics.IShiftOperators<byte, int, byte>.operator >>>(byte value, int shiftAmount) => (byte)(value >>> (shiftAmount & 7));

        static byte System.Numerics.ISubtractionOperators<byte, byte, byte>.operator checked -(byte left, byte right) => checked((byte)(left - right));

        static byte System.Numerics.ISubtractionOperators<byte, byte, byte>.operator -(byte left, byte right) => unchecked((byte)(left - right));

        static byte System.Numerics.IUnaryNegationOperators<byte, byte>.operator checked -(byte value) => checked((byte)(0 - value));

        static byte System.Numerics.IUnaryNegationOperators<byte, byte>.operator -(byte value) => unchecked((byte)(0 - value));

        static byte System.Numerics.IUnaryPlusOperators<byte, byte>.operator +(byte value) => value;
    }

    [Surface]
    public readonly partial struct Int16
    {
        static short System.Numerics.IAdditiveIdentity<System.Int16, System.Int16>.AdditiveIdentity => (short)0;

        static short System.Numerics.IBinaryNumber<System.Int16>.AllBitsSet => unchecked((short)~0);

        static short System.Numerics.IMinMaxValue<System.Int16>.MaxValue => MaxValue;

        static short System.Numerics.IMinMaxValue<System.Int16>.MinValue => MinValue;

        static short System.Numerics.IMultiplicativeIdentity<System.Int16, System.Int16>.MultiplicativeIdentity => (short)1;

        static short System.Numerics.INumberBase<System.Int16>.One => (short)1;

        static int System.Numerics.INumberBase<System.Int16>.Radix => 2;

        static short System.Numerics.INumberBase<System.Int16>.Zero => (short)0;

        static short System.Numerics.ISignedNumber<System.Int16>.NegativeOne => (short)-1;

        public static short CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out short result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<short>();

        public static short CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out short result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<short>();

        public static short CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out short result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<short>();

        static short System.Numerics.IAdditionOperators<short, short, short>.operator +(short left, short right) => unchecked((short)(left + right));

        static short System.Numerics.IAdditionOperators<short, short, short>.operator checked +(short left, short right) => checked((short)(left + right));

        static short System.Numerics.IBitwiseOperators<short, short, short>.operator &(short left, short right) => unchecked((short)(left & right));

        static short System.Numerics.IBitwiseOperators<short, short, short>.operator |(short left, short right) => unchecked((short)(left | right));

        static short System.Numerics.IBitwiseOperators<short, short, short>.operator ^(short left, short right) => unchecked((short)(left ^ right));

        static short System.Numerics.IBitwiseOperators<short, short, short>.operator ~(short value) => unchecked((short)(~value));

        static bool System.Numerics.IComparisonOperators<short, short, bool>.operator >(short left, short right) => left > right;

        static bool System.Numerics.IComparisonOperators<short, short, bool>.operator >=(short left, short right) => left >= right;

        static bool System.Numerics.IComparisonOperators<short, short, bool>.operator <(short left, short right) => left < right;

        static bool System.Numerics.IComparisonOperators<short, short, bool>.operator <=(short left, short right) => left <= right;

        static short System.Numerics.IDecrementOperators<short>.operator checked --(short value) => checked((short)(value - 1));

        static short System.Numerics.IDecrementOperators<short>.operator --(short value) => unchecked((short)(value - 1));

        static short System.Numerics.IDivisionOperators<short, short, short>.operator /(short left, short right) => unchecked((short)(left / right));

        static bool System.Numerics.IEqualityOperators<short, short, bool>.operator ==(short left, short right) => left == right;

        static bool System.Numerics.IEqualityOperators<short, short, bool>.operator !=(short left, short right) => left != right;

        static short System.Numerics.IIncrementOperators<short>.operator checked ++(short value) => checked((short)(value + 1));

        static short System.Numerics.IIncrementOperators<short>.operator ++(short value) => unchecked((short)(value + 1));

        static short System.Numerics.IModulusOperators<short, short, short>.operator %(short left, short right) => unchecked((short)(left % right));

        static short System.Numerics.IMultiplyOperators<short, short, short>.operator checked *(short left, short right) => checked((short)(left * right));

        static short System.Numerics.IMultiplyOperators<short, short, short>.operator *(short left, short right) => unchecked((short)(left * right));

        static bool System.Numerics.INumberBase<short>.IsCanonical(short value) => true;

        static bool System.Numerics.INumberBase<short>.IsComplexNumber(short value) => false;

        static bool System.Numerics.INumberBase<short>.IsFinite(short value) => true;

        static bool System.Numerics.INumberBase<short>.IsImaginaryNumber(short value) => false;

        static bool System.Numerics.INumberBase<short>.IsInfinity(short value) => false;

        static bool System.Numerics.INumberBase<short>.IsInteger(short value) => true;

        static bool System.Numerics.INumberBase<short>.IsNaN(short value) => false;

        static bool System.Numerics.INumberBase<short>.IsNegativeInfinity(short value) => false;

        static bool System.Numerics.INumberBase<short>.IsNormal(short value) => value != 0;

        static bool System.Numerics.INumberBase<short>.IsPositiveInfinity(short value) => false;

        static bool System.Numerics.INumberBase<short>.IsRealNumber(short value) => true;

        static bool System.Numerics.INumberBase<short>.IsSubnormal(short value) => false;

        static bool System.Numerics.INumberBase<short>.IsZero(short value) => value == 0;

        static short System.Numerics.INumberBase<short>.MaxMagnitudeNumber(short x, short y) => MaxMagnitude(x, y);

        static short System.Numerics.INumberBase<short>.MinMagnitudeNumber(short x, short y) => MinMagnitude(x, y);

        static short System.Numerics.INumberBase<short>.MultiplyAddEstimate(short left, short right, short addend) => unchecked((short)((left * right) + addend));

        static bool System.Numerics.INumberBase<short>.TryConvertFromChecked<TOther>(TOther value, out short result) => Numbers.TryConvert<TOther, short>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<short>.TryConvertFromSaturating<TOther>(TOther value, out short result) => Numbers.TryConvert<TOther, short>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<short>.TryConvertFromTruncating<TOther>(TOther value, out short result) => Numbers.TryConvert<TOther, short>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<short>.TryConvertToChecked<TOther>(short value, out TOther result) => Numbers.TryConvert<short, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<short>.TryConvertToSaturating<TOther>(short value, out TOther result) => Numbers.TryConvert<short, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<short>.TryConvertToTruncating<TOther>(short value, out TOther result) => Numbers.TryConvert<short, TOther>(value, out result, Numbers.Truncating);

        static short System.Numerics.INumber<short>.MaxNumber(short x, short y) => x >= y ? x : y;

        static short System.Numerics.INumber<short>.MinNumber(short x, short y) => x <= y ? x : y;

        static short System.Numerics.IShiftOperators<short, int, short>.operator <<(short value, int shiftAmount) => (short)(value << (shiftAmount & 15));

        static short System.Numerics.IShiftOperators<short, int, short>.operator >>(short value, int shiftAmount) => (short)(value >> (shiftAmount & 15));

        static short System.Numerics.IShiftOperators<short, int, short>.operator >>>(short value, int shiftAmount) => (short)((ushort)value >>> (shiftAmount & 15));

        static short System.Numerics.ISubtractionOperators<short, short, short>.operator checked -(short left, short right) => checked((short)(left - right));

        static short System.Numerics.ISubtractionOperators<short, short, short>.operator -(short left, short right) => unchecked((short)(left - right));

        static short System.Numerics.IUnaryNegationOperators<short, short>.operator checked -(short value) => checked((short)(-value));

        static short System.Numerics.IUnaryNegationOperators<short, short>.operator -(short value) => unchecked((short)(-value));

        static short System.Numerics.IUnaryPlusOperators<short, short>.operator +(short value) => value;
    }

    [Surface]
    public readonly partial struct UInt16
    {
        static ushort System.Numerics.IAdditiveIdentity<System.UInt16, System.UInt16>.AdditiveIdentity => (ushort)0;

        static ushort System.Numerics.IBinaryNumber<System.UInt16>.AllBitsSet => unchecked((ushort)~0);

        static ushort System.Numerics.IMinMaxValue<System.UInt16>.MaxValue => MaxValue;

        static ushort System.Numerics.IMinMaxValue<System.UInt16>.MinValue => MinValue;

        static ushort System.Numerics.IMultiplicativeIdentity<System.UInt16, System.UInt16>.MultiplicativeIdentity => (ushort)1;

        static ushort System.Numerics.INumberBase<System.UInt16>.One => (ushort)1;

        static int System.Numerics.INumberBase<System.UInt16>.Radix => 2;

        static ushort System.Numerics.INumberBase<System.UInt16>.Zero => (ushort)0;

        public static ushort CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out ushort result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<ushort>();

        public static ushort CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out ushort result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<ushort>();

        public static ushort CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out ushort result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<ushort>();

        static ushort System.Numerics.IAdditionOperators<ushort, ushort, ushort>.operator +(ushort left, ushort right) => unchecked((ushort)(left + right));

        static ushort System.Numerics.IAdditionOperators<ushort, ushort, ushort>.operator checked +(ushort left, ushort right) => checked((ushort)(left + right));

        static ushort System.Numerics.IBitwiseOperators<ushort, ushort, ushort>.operator &(ushort left, ushort right) => unchecked((ushort)(left & right));

        static ushort System.Numerics.IBitwiseOperators<ushort, ushort, ushort>.operator |(ushort left, ushort right) => unchecked((ushort)(left | right));

        static ushort System.Numerics.IBitwiseOperators<ushort, ushort, ushort>.operator ^(ushort left, ushort right) => unchecked((ushort)(left ^ right));

        static ushort System.Numerics.IBitwiseOperators<ushort, ushort, ushort>.operator ~(ushort value) => unchecked((ushort)(~value));

        static bool System.Numerics.IComparisonOperators<ushort, ushort, bool>.operator >(ushort left, ushort right) => left > right;

        static bool System.Numerics.IComparisonOperators<ushort, ushort, bool>.operator >=(ushort left, ushort right) => left >= right;

        static bool System.Numerics.IComparisonOperators<ushort, ushort, bool>.operator <(ushort left, ushort right) => left < right;

        static bool System.Numerics.IComparisonOperators<ushort, ushort, bool>.operator <=(ushort left, ushort right) => left <= right;

        static ushort System.Numerics.IDecrementOperators<ushort>.operator checked --(ushort value) => checked((ushort)(value - 1));

        static ushort System.Numerics.IDecrementOperators<ushort>.operator --(ushort value) => unchecked((ushort)(value - 1));

        static ushort System.Numerics.IDivisionOperators<ushort, ushort, ushort>.operator /(ushort left, ushort right) => unchecked((ushort)(left / right));

        static bool System.Numerics.IEqualityOperators<ushort, ushort, bool>.operator ==(ushort left, ushort right) => left == right;

        static bool System.Numerics.IEqualityOperators<ushort, ushort, bool>.operator !=(ushort left, ushort right) => left != right;

        static ushort System.Numerics.IIncrementOperators<ushort>.operator checked ++(ushort value) => checked((ushort)(value + 1));

        static ushort System.Numerics.IIncrementOperators<ushort>.operator ++(ushort value) => unchecked((ushort)(value + 1));

        static ushort System.Numerics.IModulusOperators<ushort, ushort, ushort>.operator %(ushort left, ushort right) => unchecked((ushort)(left % right));

        static ushort System.Numerics.IMultiplyOperators<ushort, ushort, ushort>.operator checked *(ushort left, ushort right) => checked((ushort)(left * right));

        static ushort System.Numerics.IMultiplyOperators<ushort, ushort, ushort>.operator *(ushort left, ushort right) => unchecked((ushort)(left * right));

        static ushort System.Numerics.INumberBase<ushort>.Abs(ushort value) => value;

        static bool System.Numerics.INumberBase<ushort>.IsCanonical(ushort value) => true;

        static bool System.Numerics.INumberBase<ushort>.IsComplexNumber(ushort value) => false;

        static bool System.Numerics.INumberBase<ushort>.IsFinite(ushort value) => true;

        static bool System.Numerics.INumberBase<ushort>.IsImaginaryNumber(ushort value) => false;

        static bool System.Numerics.INumberBase<ushort>.IsInfinity(ushort value) => false;

        static bool System.Numerics.INumberBase<ushort>.IsInteger(ushort value) => true;

        static bool System.Numerics.INumberBase<ushort>.IsNaN(ushort value) => false;

        static bool System.Numerics.INumberBase<ushort>.IsNegative(ushort value) => false;

        static bool System.Numerics.INumberBase<ushort>.IsNegativeInfinity(ushort value) => false;

        static bool System.Numerics.INumberBase<ushort>.IsNormal(ushort value) => value != 0;

        static bool System.Numerics.INumberBase<ushort>.IsPositive(ushort value) => true;

        static bool System.Numerics.INumberBase<ushort>.IsPositiveInfinity(ushort value) => false;

        static bool System.Numerics.INumberBase<ushort>.IsRealNumber(ushort value) => true;

        static bool System.Numerics.INumberBase<ushort>.IsSubnormal(ushort value) => false;

        static bool System.Numerics.INumberBase<ushort>.IsZero(ushort value) => value == 0;

        static ushort System.Numerics.INumberBase<ushort>.MaxMagnitude(ushort x, ushort y) => x >= y ? x : y;

        static ushort System.Numerics.INumberBase<ushort>.MaxMagnitudeNumber(ushort x, ushort y) => x >= y ? x : y;

        static ushort System.Numerics.INumberBase<ushort>.MinMagnitude(ushort x, ushort y) => x <= y ? x : y;

        static ushort System.Numerics.INumberBase<ushort>.MinMagnitudeNumber(ushort x, ushort y) => x <= y ? x : y;

        static ushort System.Numerics.INumberBase<ushort>.MultiplyAddEstimate(ushort left, ushort right, ushort addend) => unchecked((ushort)((left * right) + addend));

        static bool System.Numerics.INumberBase<ushort>.TryConvertFromChecked<TOther>(TOther value, out ushort result) => Numbers.TryConvert<TOther, ushort>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<ushort>.TryConvertFromSaturating<TOther>(TOther value, out ushort result) => Numbers.TryConvert<TOther, ushort>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<ushort>.TryConvertFromTruncating<TOther>(TOther value, out ushort result) => Numbers.TryConvert<TOther, ushort>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<ushort>.TryConvertToChecked<TOther>(ushort value, out TOther result) => Numbers.TryConvert<ushort, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<ushort>.TryConvertToSaturating<TOther>(ushort value, out TOther result) => Numbers.TryConvert<ushort, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<ushort>.TryConvertToTruncating<TOther>(ushort value, out TOther result) => Numbers.TryConvert<ushort, TOther>(value, out result, Numbers.Truncating);

        static ushort System.Numerics.INumber<ushort>.MaxNumber(ushort x, ushort y) => x >= y ? x : y;

        static ushort System.Numerics.INumber<ushort>.MinNumber(ushort x, ushort y) => x <= y ? x : y;

        static ushort System.Numerics.IShiftOperators<ushort, int, ushort>.operator <<(ushort value, int shiftAmount) => (ushort)(value << (shiftAmount & 15));

        static ushort System.Numerics.IShiftOperators<ushort, int, ushort>.operator >>(ushort value, int shiftAmount) => (ushort)(value >> (shiftAmount & 15));

        static ushort System.Numerics.IShiftOperators<ushort, int, ushort>.operator >>>(ushort value, int shiftAmount) => (ushort)(value >>> (shiftAmount & 15));

        static ushort System.Numerics.ISubtractionOperators<ushort, ushort, ushort>.operator checked -(ushort left, ushort right) => checked((ushort)(left - right));

        static ushort System.Numerics.ISubtractionOperators<ushort, ushort, ushort>.operator -(ushort left, ushort right) => unchecked((ushort)(left - right));

        static ushort System.Numerics.IUnaryNegationOperators<ushort, ushort>.operator checked -(ushort value) => checked((ushort)(0 - value));

        static ushort System.Numerics.IUnaryNegationOperators<ushort, ushort>.operator -(ushort value) => unchecked((ushort)(0 - value));

        static ushort System.Numerics.IUnaryPlusOperators<ushort, ushort>.operator +(ushort value) => value;
    }

    [Surface]
    public readonly partial struct Char
    {
        static char System.Numerics.IAdditiveIdentity<System.Char, System.Char>.AdditiveIdentity => (char)0;

        static char System.Numerics.IBinaryNumber<System.Char>.AllBitsSet => unchecked((char)~0);

        static char System.Numerics.IMinMaxValue<System.Char>.MaxValue => MaxValue;

        static char System.Numerics.IMinMaxValue<System.Char>.MinValue => MinValue;

        static char System.Numerics.IMultiplicativeIdentity<System.Char, System.Char>.MultiplicativeIdentity => (char)1;

        static char System.Numerics.INumberBase<System.Char>.One => (char)1;

        static int System.Numerics.INumberBase<System.Char>.Radix => 2;

        static char System.Numerics.INumberBase<System.Char>.Zero => (char)0;

        static char System.Numerics.IAdditionOperators<char, char, char>.operator +(char left, char right) => unchecked((char)(left + right));

        static char System.Numerics.IAdditionOperators<char, char, char>.operator checked +(char left, char right) => checked((char)(left + right));

        static bool System.Numerics.IBinaryNumber<char>.IsPow2(char value) => value != 0 && (value & (value - 1)) == 0;

        static char System.Numerics.IBitwiseOperators<char, char, char>.operator &(char left, char right) => unchecked((char)(left & right));

        static char System.Numerics.IBitwiseOperators<char, char, char>.operator |(char left, char right) => unchecked((char)(left | right));

        static char System.Numerics.IBitwiseOperators<char, char, char>.operator ^(char left, char right) => unchecked((char)(left ^ right));

        static char System.Numerics.IBitwiseOperators<char, char, char>.operator ~(char value) => unchecked((char)(~value));

        static bool System.Numerics.IComparisonOperators<char, char, bool>.operator >(char left, char right) => left > right;

        static bool System.Numerics.IComparisonOperators<char, char, bool>.operator >=(char left, char right) => left >= right;

        static bool System.Numerics.IComparisonOperators<char, char, bool>.operator <(char left, char right) => left < right;

        static bool System.Numerics.IComparisonOperators<char, char, bool>.operator <=(char left, char right) => left <= right;

        static char System.Numerics.IDecrementOperators<char>.operator checked --(char value) => checked((char)(value - 1));

        static char System.Numerics.IDecrementOperators<char>.operator --(char value) => unchecked((char)(value - 1));

        static char System.Numerics.IDivisionOperators<char, char, char>.operator /(char left, char right) => unchecked((char)(left / right));

        static bool System.Numerics.IEqualityOperators<char, char, bool>.operator ==(char left, char right) => left == right;

        static bool System.Numerics.IEqualityOperators<char, char, bool>.operator !=(char left, char right) => left != right;

        static char System.Numerics.IIncrementOperators<char>.operator checked ++(char value) => checked((char)(value + 1));

        static char System.Numerics.IIncrementOperators<char>.operator ++(char value) => unchecked((char)(value + 1));

        static char System.Numerics.IModulusOperators<char, char, char>.operator %(char left, char right) => unchecked((char)(left % right));

        static char System.Numerics.IMultiplyOperators<char, char, char>.operator checked *(char left, char right) => checked((char)(left * right));

        static char System.Numerics.IMultiplyOperators<char, char, char>.operator *(char left, char right) => unchecked((char)(left * right));

        static char System.Numerics.INumberBase<char>.Abs(char value) => value;

        static bool System.Numerics.INumberBase<char>.IsCanonical(char value) => true;

        static bool System.Numerics.INumberBase<char>.IsComplexNumber(char value) => false;

        static bool System.Numerics.INumberBase<char>.IsEvenInteger(char value) => (value & 1) == 0;

        static bool System.Numerics.INumberBase<char>.IsFinite(char value) => true;

        static bool System.Numerics.INumberBase<char>.IsImaginaryNumber(char value) => false;

        static bool System.Numerics.INumberBase<char>.IsInfinity(char value) => false;

        static bool System.Numerics.INumberBase<char>.IsInteger(char value) => true;

        static bool System.Numerics.INumberBase<char>.IsNaN(char value) => false;

        static bool System.Numerics.INumberBase<char>.IsNegative(char value) => false;

        static bool System.Numerics.INumberBase<char>.IsNegativeInfinity(char value) => false;

        static bool System.Numerics.INumberBase<char>.IsNormal(char value) => value != 0;

        static bool System.Numerics.INumberBase<char>.IsOddInteger(char value) => (value & 1) != 0;

        static bool System.Numerics.INumberBase<char>.IsPositive(char value) => true;

        static bool System.Numerics.INumberBase<char>.IsPositiveInfinity(char value) => false;

        static bool System.Numerics.INumberBase<char>.IsRealNumber(char value) => true;

        static bool System.Numerics.INumberBase<char>.IsSubnormal(char value) => false;

        static bool System.Numerics.INumberBase<char>.IsZero(char value) => value == 0;

        static char System.Numerics.INumberBase<char>.MaxMagnitude(char x, char y) => x >= y ? x : y;

        static char System.Numerics.INumberBase<char>.MaxMagnitudeNumber(char x, char y) => x >= y ? x : y;

        static char System.Numerics.INumberBase<char>.MinMagnitude(char x, char y) => x <= y ? x : y;

        static char System.Numerics.INumberBase<char>.MinMagnitudeNumber(char x, char y) => x <= y ? x : y;

        static char System.Numerics.INumberBase<char>.MultiplyAddEstimate(char left, char right, char addend) => unchecked((char)((left * right) + addend));

        static bool System.Numerics.INumberBase<char>.TryConvertFromChecked<TOther>(TOther value, out char result) => Numbers.TryConvert<TOther, char>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<char>.TryConvertFromSaturating<TOther>(TOther value, out char result) => Numbers.TryConvert<TOther, char>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<char>.TryConvertFromTruncating<TOther>(TOther value, out char result) => Numbers.TryConvert<TOther, char>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<char>.TryConvertToChecked<TOther>(char value, out TOther result) => Numbers.TryConvert<char, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<char>.TryConvertToSaturating<TOther>(char value, out TOther result) => Numbers.TryConvert<char, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<char>.TryConvertToTruncating<TOther>(char value, out TOther result) => Numbers.TryConvert<char, TOther>(value, out result, Numbers.Truncating);

        static char System.Numerics.IShiftOperators<char, int, char>.operator <<(char value, int shiftAmount) => (char)(value << (shiftAmount & 15));

        static char System.Numerics.IShiftOperators<char, int, char>.operator >>(char value, int shiftAmount) => (char)(value >> (shiftAmount & 15));

        static char System.Numerics.IShiftOperators<char, int, char>.operator >>>(char value, int shiftAmount) => (char)(value >>> (shiftAmount & 15));

        static char System.Numerics.ISubtractionOperators<char, char, char>.operator checked -(char left, char right) => checked((char)(left - right));

        static char System.Numerics.ISubtractionOperators<char, char, char>.operator -(char left, char right) => unchecked((char)(left - right));

        static char System.Numerics.IUnaryNegationOperators<char, char>.operator checked -(char value) => checked((char)(0 - value));

        static char System.Numerics.IUnaryNegationOperators<char, char>.operator -(char value) => unchecked((char)(0 - value));

        static char System.Numerics.IUnaryPlusOperators<char, char>.operator +(char value) => value;
    }

    [Surface]
    public readonly partial struct Int32
    {
        static int System.Numerics.IAdditiveIdentity<System.Int32, System.Int32>.AdditiveIdentity => (int)0;

        static int System.Numerics.IBinaryNumber<System.Int32>.AllBitsSet => unchecked((int)~0);

        static int System.Numerics.IMinMaxValue<System.Int32>.MaxValue => MaxValue;

        static int System.Numerics.IMinMaxValue<System.Int32>.MinValue => MinValue;

        static int System.Numerics.IMultiplicativeIdentity<System.Int32, System.Int32>.MultiplicativeIdentity => (int)1;

        static int System.Numerics.INumberBase<System.Int32>.One => (int)1;

        static int System.Numerics.INumberBase<System.Int32>.Radix => 2;

        static int System.Numerics.INumberBase<System.Int32>.Zero => (int)0;

        static int System.Numerics.ISignedNumber<System.Int32>.NegativeOne => (int)-1;

        public static int CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out int result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<int>();

        public static int CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out int result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<int>();

        public static int CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out int result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<int>();

        static int System.Numerics.IAdditionOperators<int, int, int>.operator +(int left, int right) => unchecked(left + right);

        static int System.Numerics.IAdditionOperators<int, int, int>.operator checked +(int left, int right) => checked(left + right);

        static int System.Numerics.IBitwiseOperators<int, int, int>.operator &(int left, int right) => unchecked(left & right);

        static int System.Numerics.IBitwiseOperators<int, int, int>.operator |(int left, int right) => unchecked(left | right);

        static int System.Numerics.IBitwiseOperators<int, int, int>.operator ^(int left, int right) => unchecked(left ^ right);

        static int System.Numerics.IBitwiseOperators<int, int, int>.operator ~(int value) => unchecked(~value);

        static bool System.Numerics.IComparisonOperators<int, int, bool>.operator >(int left, int right) => left > right;

        static bool System.Numerics.IComparisonOperators<int, int, bool>.operator >=(int left, int right) => left >= right;

        static bool System.Numerics.IComparisonOperators<int, int, bool>.operator <(int left, int right) => left < right;

        static bool System.Numerics.IComparisonOperators<int, int, bool>.operator <=(int left, int right) => left <= right;

        static int System.Numerics.IDecrementOperators<int>.operator checked --(int value) => checked(value - 1);

        static int System.Numerics.IDecrementOperators<int>.operator --(int value) => unchecked(value - 1);

        static int System.Numerics.IDivisionOperators<int, int, int>.operator /(int left, int right) => unchecked(left / right);

        static bool System.Numerics.IEqualityOperators<int, int, bool>.operator ==(int left, int right) => left == right;

        static bool System.Numerics.IEqualityOperators<int, int, bool>.operator !=(int left, int right) => left != right;

        static int System.Numerics.IIncrementOperators<int>.operator checked ++(int value) => checked(value + 1);

        static int System.Numerics.IIncrementOperators<int>.operator ++(int value) => unchecked(value + 1);

        static int System.Numerics.IModulusOperators<int, int, int>.operator %(int left, int right) => unchecked(left % right);

        static int System.Numerics.IMultiplyOperators<int, int, int>.operator checked *(int left, int right) => checked(left * right);

        static int System.Numerics.IMultiplyOperators<int, int, int>.operator *(int left, int right) => unchecked(left * right);

        static bool System.Numerics.INumberBase<int>.IsCanonical(int value) => true;

        static bool System.Numerics.INumberBase<int>.IsComplexNumber(int value) => false;

        static bool System.Numerics.INumberBase<int>.IsFinite(int value) => true;

        static bool System.Numerics.INumberBase<int>.IsImaginaryNumber(int value) => false;

        static bool System.Numerics.INumberBase<int>.IsInfinity(int value) => false;

        static bool System.Numerics.INumberBase<int>.IsInteger(int value) => true;

        static bool System.Numerics.INumberBase<int>.IsNaN(int value) => false;

        static bool System.Numerics.INumberBase<int>.IsNegativeInfinity(int value) => false;

        static bool System.Numerics.INumberBase<int>.IsNormal(int value) => value != 0;

        static bool System.Numerics.INumberBase<int>.IsPositiveInfinity(int value) => false;

        static bool System.Numerics.INumberBase<int>.IsRealNumber(int value) => true;

        static bool System.Numerics.INumberBase<int>.IsSubnormal(int value) => false;

        static bool System.Numerics.INumberBase<int>.IsZero(int value) => value == 0;

        static int System.Numerics.INumberBase<int>.MaxMagnitudeNumber(int x, int y) => MaxMagnitude(x, y);

        static int System.Numerics.INumberBase<int>.MinMagnitudeNumber(int x, int y) => MinMagnitude(x, y);

        static int System.Numerics.INumberBase<int>.MultiplyAddEstimate(int left, int right, int addend) => unchecked((left * right) + addend);

        static bool System.Numerics.INumberBase<int>.TryConvertFromChecked<TOther>(TOther value, out int result) => Numbers.TryConvert<TOther, int>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<int>.TryConvertFromSaturating<TOther>(TOther value, out int result) => Numbers.TryConvert<TOther, int>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<int>.TryConvertFromTruncating<TOther>(TOther value, out int result) => Numbers.TryConvert<TOther, int>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<int>.TryConvertToChecked<TOther>(int value, out TOther result) => Numbers.TryConvert<int, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<int>.TryConvertToSaturating<TOther>(int value, out TOther result) => Numbers.TryConvert<int, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<int>.TryConvertToTruncating<TOther>(int value, out TOther result) => Numbers.TryConvert<int, TOther>(value, out result, Numbers.Truncating);

        static int System.Numerics.INumber<int>.MaxNumber(int x, int y) => x >= y ? x : y;

        static int System.Numerics.INumber<int>.MinNumber(int x, int y) => x <= y ? x : y;

        static int System.Numerics.IShiftOperators<int, int, int>.operator <<(int value, int shiftAmount) => value << shiftAmount;

        static int System.Numerics.IShiftOperators<int, int, int>.operator >>(int value, int shiftAmount) => value >> shiftAmount;

        static int System.Numerics.IShiftOperators<int, int, int>.operator >>>(int value, int shiftAmount) => value >>> shiftAmount;

        static int System.Numerics.ISubtractionOperators<int, int, int>.operator checked -(int left, int right) => checked(left - right);

        static int System.Numerics.ISubtractionOperators<int, int, int>.operator -(int left, int right) => unchecked(left - right);

        static int System.Numerics.IUnaryNegationOperators<int, int>.operator checked -(int value) => checked(-value);

        static int System.Numerics.IUnaryNegationOperators<int, int>.operator -(int value) => unchecked(-value);

        static int System.Numerics.IUnaryPlusOperators<int, int>.operator +(int value) => value;
    }

    [Surface]
    public readonly partial struct UInt32
    {
        static uint System.Numerics.IAdditiveIdentity<System.UInt32, System.UInt32>.AdditiveIdentity => (uint)0;

        static uint System.Numerics.IBinaryNumber<System.UInt32>.AllBitsSet => unchecked((uint)~0);

        static uint System.Numerics.IMinMaxValue<System.UInt32>.MaxValue => MaxValue;

        static uint System.Numerics.IMinMaxValue<System.UInt32>.MinValue => MinValue;

        static uint System.Numerics.IMultiplicativeIdentity<System.UInt32, System.UInt32>.MultiplicativeIdentity => (uint)1;

        static uint System.Numerics.INumberBase<System.UInt32>.One => (uint)1;

        static int System.Numerics.INumberBase<System.UInt32>.Radix => 2;

        static uint System.Numerics.INumberBase<System.UInt32>.Zero => (uint)0;

        public static uint CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out uint result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<uint>();

        public static uint CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out uint result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<uint>();

        public static uint CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out uint result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<uint>();

        static uint System.Numerics.IAdditionOperators<uint, uint, uint>.operator +(uint left, uint right) => unchecked(left + right);

        static uint System.Numerics.IAdditionOperators<uint, uint, uint>.operator checked +(uint left, uint right) => checked(left + right);

        static uint System.Numerics.IBitwiseOperators<uint, uint, uint>.operator &(uint left, uint right) => unchecked(left & right);

        static uint System.Numerics.IBitwiseOperators<uint, uint, uint>.operator |(uint left, uint right) => unchecked(left | right);

        static uint System.Numerics.IBitwiseOperators<uint, uint, uint>.operator ^(uint left, uint right) => unchecked(left ^ right);

        static uint System.Numerics.IBitwiseOperators<uint, uint, uint>.operator ~(uint value) => unchecked(~value);

        static bool System.Numerics.IComparisonOperators<uint, uint, bool>.operator >(uint left, uint right) => left > right;

        static bool System.Numerics.IComparisonOperators<uint, uint, bool>.operator >=(uint left, uint right) => left >= right;

        static bool System.Numerics.IComparisonOperators<uint, uint, bool>.operator <(uint left, uint right) => left < right;

        static bool System.Numerics.IComparisonOperators<uint, uint, bool>.operator <=(uint left, uint right) => left <= right;

        static uint System.Numerics.IDecrementOperators<uint>.operator checked --(uint value) => checked(value - 1);

        static uint System.Numerics.IDecrementOperators<uint>.operator --(uint value) => unchecked(value - 1);

        static uint System.Numerics.IDivisionOperators<uint, uint, uint>.operator /(uint left, uint right) => unchecked(left / right);

        static bool System.Numerics.IEqualityOperators<uint, uint, bool>.operator ==(uint left, uint right) => left == right;

        static bool System.Numerics.IEqualityOperators<uint, uint, bool>.operator !=(uint left, uint right) => left != right;

        static uint System.Numerics.IIncrementOperators<uint>.operator checked ++(uint value) => checked(value + 1);

        static uint System.Numerics.IIncrementOperators<uint>.operator ++(uint value) => unchecked(value + 1);

        static uint System.Numerics.IModulusOperators<uint, uint, uint>.operator %(uint left, uint right) => unchecked(left % right);

        static uint System.Numerics.IMultiplyOperators<uint, uint, uint>.operator checked *(uint left, uint right) => checked(left * right);

        static uint System.Numerics.IMultiplyOperators<uint, uint, uint>.operator *(uint left, uint right) => unchecked(left * right);

        static uint System.Numerics.INumberBase<uint>.Abs(uint value) => value;

        static bool System.Numerics.INumberBase<uint>.IsCanonical(uint value) => true;

        static bool System.Numerics.INumberBase<uint>.IsComplexNumber(uint value) => false;

        static bool System.Numerics.INumberBase<uint>.IsFinite(uint value) => true;

        static bool System.Numerics.INumberBase<uint>.IsImaginaryNumber(uint value) => false;

        static bool System.Numerics.INumberBase<uint>.IsInfinity(uint value) => false;

        static bool System.Numerics.INumberBase<uint>.IsInteger(uint value) => true;

        static bool System.Numerics.INumberBase<uint>.IsNaN(uint value) => false;

        static bool System.Numerics.INumberBase<uint>.IsNegative(uint value) => false;

        static bool System.Numerics.INumberBase<uint>.IsNegativeInfinity(uint value) => false;

        static bool System.Numerics.INumberBase<uint>.IsNormal(uint value) => value != 0;

        static bool System.Numerics.INumberBase<uint>.IsPositive(uint value) => true;

        static bool System.Numerics.INumberBase<uint>.IsPositiveInfinity(uint value) => false;

        static bool System.Numerics.INumberBase<uint>.IsRealNumber(uint value) => true;

        static bool System.Numerics.INumberBase<uint>.IsSubnormal(uint value) => false;

        static bool System.Numerics.INumberBase<uint>.IsZero(uint value) => value == 0;

        static uint System.Numerics.INumberBase<uint>.MaxMagnitude(uint x, uint y) => x >= y ? x : y;

        static uint System.Numerics.INumberBase<uint>.MaxMagnitudeNumber(uint x, uint y) => x >= y ? x : y;

        static uint System.Numerics.INumberBase<uint>.MinMagnitude(uint x, uint y) => x <= y ? x : y;

        static uint System.Numerics.INumberBase<uint>.MinMagnitudeNumber(uint x, uint y) => x <= y ? x : y;

        static uint System.Numerics.INumberBase<uint>.MultiplyAddEstimate(uint left, uint right, uint addend) => unchecked((left * right) + addend);

        static bool System.Numerics.INumberBase<uint>.TryConvertFromChecked<TOther>(TOther value, out uint result) => Numbers.TryConvert<TOther, uint>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<uint>.TryConvertFromSaturating<TOther>(TOther value, out uint result) => Numbers.TryConvert<TOther, uint>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<uint>.TryConvertFromTruncating<TOther>(TOther value, out uint result) => Numbers.TryConvert<TOther, uint>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<uint>.TryConvertToChecked<TOther>(uint value, out TOther result) => Numbers.TryConvert<uint, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<uint>.TryConvertToSaturating<TOther>(uint value, out TOther result) => Numbers.TryConvert<uint, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<uint>.TryConvertToTruncating<TOther>(uint value, out TOther result) => Numbers.TryConvert<uint, TOther>(value, out result, Numbers.Truncating);

        static uint System.Numerics.INumber<uint>.MaxNumber(uint x, uint y) => x >= y ? x : y;

        static uint System.Numerics.INumber<uint>.MinNumber(uint x, uint y) => x <= y ? x : y;

        static uint System.Numerics.IShiftOperators<uint, int, uint>.operator <<(uint value, int shiftAmount) => value << shiftAmount;

        static uint System.Numerics.IShiftOperators<uint, int, uint>.operator >>(uint value, int shiftAmount) => value >> shiftAmount;

        static uint System.Numerics.IShiftOperators<uint, int, uint>.operator >>>(uint value, int shiftAmount) => value >>> shiftAmount;

        static uint System.Numerics.ISubtractionOperators<uint, uint, uint>.operator checked -(uint left, uint right) => checked(left - right);

        static uint System.Numerics.ISubtractionOperators<uint, uint, uint>.operator -(uint left, uint right) => unchecked(left - right);

        static uint System.Numerics.IUnaryNegationOperators<uint, uint>.operator checked -(uint value) => checked(0 - value);

        static uint System.Numerics.IUnaryNegationOperators<uint, uint>.operator -(uint value) => unchecked(0 - value);

        static uint System.Numerics.IUnaryPlusOperators<uint, uint>.operator +(uint value) => value;
    }

    [Surface]
    public readonly partial struct Int64
    {
        static long System.Numerics.IAdditiveIdentity<System.Int64, System.Int64>.AdditiveIdentity => (long)0;

        static long System.Numerics.IBinaryNumber<System.Int64>.AllBitsSet => unchecked((long)~0);

        static long System.Numerics.IMinMaxValue<System.Int64>.MaxValue => MaxValue;

        static long System.Numerics.IMinMaxValue<System.Int64>.MinValue => MinValue;

        static long System.Numerics.IMultiplicativeIdentity<System.Int64, System.Int64>.MultiplicativeIdentity => (long)1;

        static long System.Numerics.INumberBase<System.Int64>.One => (long)1;

        static int System.Numerics.INumberBase<System.Int64>.Radix => 2;

        static long System.Numerics.INumberBase<System.Int64>.Zero => (long)0;

        static long System.Numerics.ISignedNumber<System.Int64>.NegativeOne => (long)-1;

        public static long CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out long result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<long>();

        public static long CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out long result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<long>();

        public static long CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out long result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<long>();

        static long System.Numerics.IAdditionOperators<long, long, long>.operator +(long left, long right) => unchecked(left + right);

        static long System.Numerics.IAdditionOperators<long, long, long>.operator checked +(long left, long right) => checked(left + right);

        static long System.Numerics.IBitwiseOperators<long, long, long>.operator &(long left, long right) => unchecked(left & right);

        static long System.Numerics.IBitwiseOperators<long, long, long>.operator |(long left, long right) => unchecked(left | right);

        static long System.Numerics.IBitwiseOperators<long, long, long>.operator ^(long left, long right) => unchecked(left ^ right);

        static long System.Numerics.IBitwiseOperators<long, long, long>.operator ~(long value) => unchecked(~value);

        static bool System.Numerics.IComparisonOperators<long, long, bool>.operator >(long left, long right) => left > right;

        static bool System.Numerics.IComparisonOperators<long, long, bool>.operator >=(long left, long right) => left >= right;

        static bool System.Numerics.IComparisonOperators<long, long, bool>.operator <(long left, long right) => left < right;

        static bool System.Numerics.IComparisonOperators<long, long, bool>.operator <=(long left, long right) => left <= right;

        static long System.Numerics.IDecrementOperators<long>.operator checked --(long value) => checked(value - 1);

        static long System.Numerics.IDecrementOperators<long>.operator --(long value) => unchecked(value - 1);

        static long System.Numerics.IDivisionOperators<long, long, long>.operator /(long left, long right) => unchecked(left / right);

        static bool System.Numerics.IEqualityOperators<long, long, bool>.operator ==(long left, long right) => left == right;

        static bool System.Numerics.IEqualityOperators<long, long, bool>.operator !=(long left, long right) => left != right;

        static long System.Numerics.IIncrementOperators<long>.operator checked ++(long value) => checked(value + 1);

        static long System.Numerics.IIncrementOperators<long>.operator ++(long value) => unchecked(value + 1);

        static long System.Numerics.IModulusOperators<long, long, long>.operator %(long left, long right) => unchecked(left % right);

        static long System.Numerics.IMultiplyOperators<long, long, long>.operator checked *(long left, long right) => checked(left * right);

        static long System.Numerics.IMultiplyOperators<long, long, long>.operator *(long left, long right) => unchecked(left * right);

        static bool System.Numerics.INumberBase<long>.IsCanonical(long value) => true;

        static bool System.Numerics.INumberBase<long>.IsComplexNumber(long value) => false;

        static bool System.Numerics.INumberBase<long>.IsFinite(long value) => true;

        static bool System.Numerics.INumberBase<long>.IsImaginaryNumber(long value) => false;

        static bool System.Numerics.INumberBase<long>.IsInfinity(long value) => false;

        static bool System.Numerics.INumberBase<long>.IsInteger(long value) => true;

        static bool System.Numerics.INumberBase<long>.IsNaN(long value) => false;

        static bool System.Numerics.INumberBase<long>.IsNegativeInfinity(long value) => false;

        static bool System.Numerics.INumberBase<long>.IsNormal(long value) => value != 0;

        static bool System.Numerics.INumberBase<long>.IsPositiveInfinity(long value) => false;

        static bool System.Numerics.INumberBase<long>.IsRealNumber(long value) => true;

        static bool System.Numerics.INumberBase<long>.IsSubnormal(long value) => false;

        static bool System.Numerics.INumberBase<long>.IsZero(long value) => value == 0;

        static long System.Numerics.INumberBase<long>.MaxMagnitudeNumber(long x, long y) => MaxMagnitude(x, y);

        static long System.Numerics.INumberBase<long>.MinMagnitudeNumber(long x, long y) => MinMagnitude(x, y);

        static long System.Numerics.INumberBase<long>.MultiplyAddEstimate(long left, long right, long addend) => unchecked((left * right) + addend);

        static bool System.Numerics.INumberBase<long>.TryConvertFromChecked<TOther>(TOther value, out long result) => Numbers.TryConvert<TOther, long>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<long>.TryConvertFromSaturating<TOther>(TOther value, out long result) => Numbers.TryConvert<TOther, long>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<long>.TryConvertFromTruncating<TOther>(TOther value, out long result) => Numbers.TryConvert<TOther, long>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<long>.TryConvertToChecked<TOther>(long value, out TOther result) => Numbers.TryConvert<long, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<long>.TryConvertToSaturating<TOther>(long value, out TOther result) => Numbers.TryConvert<long, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<long>.TryConvertToTruncating<TOther>(long value, out TOther result) => Numbers.TryConvert<long, TOther>(value, out result, Numbers.Truncating);

        static long System.Numerics.INumber<long>.MaxNumber(long x, long y) => x >= y ? x : y;

        static long System.Numerics.INumber<long>.MinNumber(long x, long y) => x <= y ? x : y;

        static long System.Numerics.IShiftOperators<long, int, long>.operator <<(long value, int shiftAmount) => value << shiftAmount;

        static long System.Numerics.IShiftOperators<long, int, long>.operator >>(long value, int shiftAmount) => value >> shiftAmount;

        static long System.Numerics.IShiftOperators<long, int, long>.operator >>>(long value, int shiftAmount) => value >>> shiftAmount;

        static long System.Numerics.ISubtractionOperators<long, long, long>.operator checked -(long left, long right) => checked(left - right);

        static long System.Numerics.ISubtractionOperators<long, long, long>.operator -(long left, long right) => unchecked(left - right);

        static long System.Numerics.IUnaryNegationOperators<long, long>.operator checked -(long value) => checked(-value);

        static long System.Numerics.IUnaryNegationOperators<long, long>.operator -(long value) => unchecked(-value);

        static long System.Numerics.IUnaryPlusOperators<long, long>.operator +(long value) => value;
    }

    [Surface]
    public readonly partial struct UInt64
    {
        static ulong System.Numerics.IAdditiveIdentity<System.UInt64, System.UInt64>.AdditiveIdentity => (ulong)0;

        static ulong System.Numerics.IBinaryNumber<System.UInt64>.AllBitsSet => ulong.MaxValue;

        static ulong System.Numerics.IMinMaxValue<System.UInt64>.MaxValue => MaxValue;

        static ulong System.Numerics.IMinMaxValue<System.UInt64>.MinValue => MinValue;

        static ulong System.Numerics.IMultiplicativeIdentity<System.UInt64, System.UInt64>.MultiplicativeIdentity => (ulong)1;

        static ulong System.Numerics.INumberBase<System.UInt64>.One => (ulong)1;

        static int System.Numerics.INumberBase<System.UInt64>.Radix => 2;

        static ulong System.Numerics.INumberBase<System.UInt64>.Zero => (ulong)0;

        public static ulong CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out ulong result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<ulong>();

        public static ulong CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out ulong result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<ulong>();

        public static ulong CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out ulong result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<ulong>();

        static ulong System.Numerics.IAdditionOperators<ulong, ulong, ulong>.operator +(ulong left, ulong right) => unchecked(left + right);

        static ulong System.Numerics.IAdditionOperators<ulong, ulong, ulong>.operator checked +(ulong left, ulong right) => checked(left + right);

        static ulong System.Numerics.IBitwiseOperators<ulong, ulong, ulong>.operator &(ulong left, ulong right) => unchecked(left & right);

        static ulong System.Numerics.IBitwiseOperators<ulong, ulong, ulong>.operator |(ulong left, ulong right) => unchecked(left | right);

        static ulong System.Numerics.IBitwiseOperators<ulong, ulong, ulong>.operator ^(ulong left, ulong right) => unchecked(left ^ right);

        static ulong System.Numerics.IBitwiseOperators<ulong, ulong, ulong>.operator ~(ulong value) => unchecked(~value);

        static bool System.Numerics.IComparisonOperators<ulong, ulong, bool>.operator >(ulong left, ulong right) => left > right;

        static bool System.Numerics.IComparisonOperators<ulong, ulong, bool>.operator >=(ulong left, ulong right) => left >= right;

        static bool System.Numerics.IComparisonOperators<ulong, ulong, bool>.operator <(ulong left, ulong right) => left < right;

        static bool System.Numerics.IComparisonOperators<ulong, ulong, bool>.operator <=(ulong left, ulong right) => left <= right;

        static ulong System.Numerics.IDecrementOperators<ulong>.operator checked --(ulong value) => checked(value - 1);

        static ulong System.Numerics.IDecrementOperators<ulong>.operator --(ulong value) => unchecked(value - 1);

        static ulong System.Numerics.IDivisionOperators<ulong, ulong, ulong>.operator /(ulong left, ulong right) => unchecked(left / right);

        static bool System.Numerics.IEqualityOperators<ulong, ulong, bool>.operator ==(ulong left, ulong right) => left == right;

        static bool System.Numerics.IEqualityOperators<ulong, ulong, bool>.operator !=(ulong left, ulong right) => left != right;

        static ulong System.Numerics.IIncrementOperators<ulong>.operator checked ++(ulong value) => checked(value + 1);

        static ulong System.Numerics.IIncrementOperators<ulong>.operator ++(ulong value) => unchecked(value + 1);

        static ulong System.Numerics.IModulusOperators<ulong, ulong, ulong>.operator %(ulong left, ulong right) => unchecked(left % right);

        static ulong System.Numerics.IMultiplyOperators<ulong, ulong, ulong>.operator checked *(ulong left, ulong right) => checked(left * right);

        static ulong System.Numerics.IMultiplyOperators<ulong, ulong, ulong>.operator *(ulong left, ulong right) => unchecked(left * right);

        static ulong System.Numerics.INumberBase<ulong>.Abs(ulong value) => value;

        static bool System.Numerics.INumberBase<ulong>.IsCanonical(ulong value) => true;

        static bool System.Numerics.INumberBase<ulong>.IsComplexNumber(ulong value) => false;

        static bool System.Numerics.INumberBase<ulong>.IsFinite(ulong value) => true;

        static bool System.Numerics.INumberBase<ulong>.IsImaginaryNumber(ulong value) => false;

        static bool System.Numerics.INumberBase<ulong>.IsInfinity(ulong value) => false;

        static bool System.Numerics.INumberBase<ulong>.IsInteger(ulong value) => true;

        static bool System.Numerics.INumberBase<ulong>.IsNaN(ulong value) => false;

        static bool System.Numerics.INumberBase<ulong>.IsNegative(ulong value) => false;

        static bool System.Numerics.INumberBase<ulong>.IsNegativeInfinity(ulong value) => false;

        static bool System.Numerics.INumberBase<ulong>.IsNormal(ulong value) => value != 0;

        static bool System.Numerics.INumberBase<ulong>.IsPositive(ulong value) => true;

        static bool System.Numerics.INumberBase<ulong>.IsPositiveInfinity(ulong value) => false;

        static bool System.Numerics.INumberBase<ulong>.IsRealNumber(ulong value) => true;

        static bool System.Numerics.INumberBase<ulong>.IsSubnormal(ulong value) => false;

        static bool System.Numerics.INumberBase<ulong>.IsZero(ulong value) => value == 0;

        static ulong System.Numerics.INumberBase<ulong>.MaxMagnitude(ulong x, ulong y) => x >= y ? x : y;

        static ulong System.Numerics.INumberBase<ulong>.MaxMagnitudeNumber(ulong x, ulong y) => x >= y ? x : y;

        static ulong System.Numerics.INumberBase<ulong>.MinMagnitude(ulong x, ulong y) => x <= y ? x : y;

        static ulong System.Numerics.INumberBase<ulong>.MinMagnitudeNumber(ulong x, ulong y) => x <= y ? x : y;

        static ulong System.Numerics.INumberBase<ulong>.MultiplyAddEstimate(ulong left, ulong right, ulong addend) => unchecked((left * right) + addend);

        static bool System.Numerics.INumberBase<ulong>.TryConvertFromChecked<TOther>(TOther value, out ulong result) => Numbers.TryConvert<TOther, ulong>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<ulong>.TryConvertFromSaturating<TOther>(TOther value, out ulong result) => Numbers.TryConvert<TOther, ulong>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<ulong>.TryConvertFromTruncating<TOther>(TOther value, out ulong result) => Numbers.TryConvert<TOther, ulong>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<ulong>.TryConvertToChecked<TOther>(ulong value, out TOther result) => Numbers.TryConvert<ulong, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<ulong>.TryConvertToSaturating<TOther>(ulong value, out TOther result) => Numbers.TryConvert<ulong, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<ulong>.TryConvertToTruncating<TOther>(ulong value, out TOther result) => Numbers.TryConvert<ulong, TOther>(value, out result, Numbers.Truncating);

        static ulong System.Numerics.INumber<ulong>.MaxNumber(ulong x, ulong y) => x >= y ? x : y;

        static ulong System.Numerics.INumber<ulong>.MinNumber(ulong x, ulong y) => x <= y ? x : y;

        static ulong System.Numerics.IShiftOperators<ulong, int, ulong>.operator <<(ulong value, int shiftAmount) => value << shiftAmount;

        static ulong System.Numerics.IShiftOperators<ulong, int, ulong>.operator >>(ulong value, int shiftAmount) => value >> shiftAmount;

        static ulong System.Numerics.IShiftOperators<ulong, int, ulong>.operator >>>(ulong value, int shiftAmount) => value >>> shiftAmount;

        static ulong System.Numerics.ISubtractionOperators<ulong, ulong, ulong>.operator checked -(ulong left, ulong right) => checked(left - right);

        static ulong System.Numerics.ISubtractionOperators<ulong, ulong, ulong>.operator -(ulong left, ulong right) => unchecked(left - right);

        static ulong System.Numerics.IUnaryNegationOperators<ulong, ulong>.operator checked -(ulong value) => checked(0 - value);

        static ulong System.Numerics.IUnaryNegationOperators<ulong, ulong>.operator -(ulong value) => unchecked(0 - value);

        static ulong System.Numerics.IUnaryPlusOperators<ulong, ulong>.operator +(ulong value) => value;
    }

    [Surface]
    public readonly partial struct IntPtr
    {
        static nint System.Numerics.IAdditiveIdentity<System.IntPtr, System.IntPtr>.AdditiveIdentity => (nint)0;

        static nint System.Numerics.IBinaryNumber<System.IntPtr>.AllBitsSet => unchecked((nint)~0);

        static nint System.Numerics.IMinMaxValue<System.IntPtr>.MaxValue => MaxValue;

        static nint System.Numerics.IMinMaxValue<System.IntPtr>.MinValue => MinValue;

        static nint System.Numerics.IMultiplicativeIdentity<System.IntPtr, System.IntPtr>.MultiplicativeIdentity => (nint)1;

        static nint System.Numerics.INumberBase<System.IntPtr>.One => (nint)1;

        static int System.Numerics.INumberBase<System.IntPtr>.Radix => 2;

        static nint System.Numerics.INumberBase<System.IntPtr>.Zero => (nint)0;

        static nint System.Numerics.ISignedNumber<System.IntPtr>.NegativeOne => (nint)(-1);

        public static nint CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out nint result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<nint>();

        public static nint CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out nint result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<nint>();

        public static nint CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out nint result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<nint>();

        static nint System.Numerics.IAdditionOperators<nint, nint, nint>.operator +(nint left, nint right) => unchecked(left + right);

        static nint System.Numerics.IAdditionOperators<nint, nint, nint>.operator checked +(nint left, nint right) => checked(left + right);

        static nint System.Numerics.IBitwiseOperators<nint, nint, nint>.operator &(nint left, nint right) => unchecked(left & right);

        static nint System.Numerics.IBitwiseOperators<nint, nint, nint>.operator |(nint left, nint right) => unchecked(left | right);

        static nint System.Numerics.IBitwiseOperators<nint, nint, nint>.operator ^(nint left, nint right) => unchecked(left ^ right);

        static nint System.Numerics.IBitwiseOperators<nint, nint, nint>.operator ~(nint value) => unchecked(~value);

        static bool System.Numerics.IComparisonOperators<nint, nint, bool>.operator >(nint left, nint right) => left > right;

        static bool System.Numerics.IComparisonOperators<nint, nint, bool>.operator >=(nint left, nint right) => left >= right;

        static bool System.Numerics.IComparisonOperators<nint, nint, bool>.operator <(nint left, nint right) => left < right;

        static bool System.Numerics.IComparisonOperators<nint, nint, bool>.operator <=(nint left, nint right) => left <= right;

        static nint System.Numerics.IDecrementOperators<nint>.operator checked --(nint value) => checked(value - 1);

        static nint System.Numerics.IDecrementOperators<nint>.operator --(nint value) => unchecked(value - 1);

        static nint System.Numerics.IDivisionOperators<nint, nint, nint>.operator /(nint left, nint right) => unchecked(left / right);

        static bool System.Numerics.IEqualityOperators<nint, nint, bool>.operator ==(nint left, nint right) => left == right;

        static bool System.Numerics.IEqualityOperators<nint, nint, bool>.operator !=(nint left, nint right) => left != right;

        static nint System.Numerics.IIncrementOperators<nint>.operator checked ++(nint value) => checked(value + 1);

        static nint System.Numerics.IIncrementOperators<nint>.operator ++(nint value) => unchecked(value + 1);

        static nint System.Numerics.IModulusOperators<nint, nint, nint>.operator %(nint left, nint right) => unchecked(left % right);

        static nint System.Numerics.IMultiplyOperators<nint, nint, nint>.operator checked *(nint left, nint right) => checked(left * right);

        static nint System.Numerics.IMultiplyOperators<nint, nint, nint>.operator *(nint left, nint right) => unchecked(left * right);

        static bool System.Numerics.INumberBase<nint>.IsCanonical(nint value) => true;

        static bool System.Numerics.INumberBase<nint>.IsComplexNumber(nint value) => false;

        static bool System.Numerics.INumberBase<nint>.IsFinite(nint value) => true;

        static bool System.Numerics.INumberBase<nint>.IsImaginaryNumber(nint value) => false;

        static bool System.Numerics.INumberBase<nint>.IsInfinity(nint value) => false;

        static bool System.Numerics.INumberBase<nint>.IsInteger(nint value) => true;

        static bool System.Numerics.INumberBase<nint>.IsNaN(nint value) => false;

        static bool System.Numerics.INumberBase<nint>.IsNegativeInfinity(nint value) => false;

        static bool System.Numerics.INumberBase<nint>.IsNormal(nint value) => value != 0;

        static bool System.Numerics.INumberBase<nint>.IsPositiveInfinity(nint value) => false;

        static bool System.Numerics.INumberBase<nint>.IsRealNumber(nint value) => true;

        static bool System.Numerics.INumberBase<nint>.IsSubnormal(nint value) => false;

        static bool System.Numerics.INumberBase<nint>.IsZero(nint value) => value == 0;

        static nint System.Numerics.INumberBase<nint>.MaxMagnitudeNumber(nint x, nint y) => MaxMagnitude(x, y);

        static nint System.Numerics.INumberBase<nint>.MinMagnitudeNumber(nint x, nint y) => MinMagnitude(x, y);

        static nint System.Numerics.INumberBase<nint>.MultiplyAddEstimate(nint left, nint right, nint addend) => unchecked((left * right) + addend);

        static bool System.Numerics.INumberBase<nint>.TryConvertFromChecked<TOther>(TOther value, out nint result) => Numbers.TryConvert<TOther, nint>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<nint>.TryConvertFromSaturating<TOther>(TOther value, out nint result) => Numbers.TryConvert<TOther, nint>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<nint>.TryConvertFromTruncating<TOther>(TOther value, out nint result) => Numbers.TryConvert<TOther, nint>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<nint>.TryConvertToChecked<TOther>(nint value, out TOther result) => Numbers.TryConvert<nint, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<nint>.TryConvertToSaturating<TOther>(nint value, out TOther result) => Numbers.TryConvert<nint, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<nint>.TryConvertToTruncating<TOther>(nint value, out TOther result) => Numbers.TryConvert<nint, TOther>(value, out result, Numbers.Truncating);

        static nint System.Numerics.INumber<nint>.MaxNumber(nint x, nint y) => x >= y ? x : y;

        static nint System.Numerics.INumber<nint>.MinNumber(nint x, nint y) => x <= y ? x : y;

        static nint System.Numerics.IShiftOperators<nint, int, nint>.operator <<(nint value, int shiftAmount) => value << shiftAmount;

        static nint System.Numerics.IShiftOperators<nint, int, nint>.operator >>(nint value, int shiftAmount) => value >> shiftAmount;

        static nint System.Numerics.IShiftOperators<nint, int, nint>.operator >>>(nint value, int shiftAmount) => value >>> shiftAmount;

        static nint System.Numerics.ISubtractionOperators<nint, nint, nint>.operator checked -(nint left, nint right) => checked(left - right);

        static nint System.Numerics.ISubtractionOperators<nint, nint, nint>.operator -(nint left, nint right) => unchecked(left - right);

        static nint System.Numerics.IUnaryNegationOperators<nint, nint>.operator checked -(nint value) => checked(-value);

        static nint System.Numerics.IUnaryNegationOperators<nint, nint>.operator -(nint value) => unchecked(-value);

        static nint System.Numerics.IUnaryPlusOperators<nint, nint>.operator +(nint value) => value;
    }

    [Surface]
    public readonly partial struct UIntPtr
    {
        static nuint System.Numerics.IAdditiveIdentity<System.UIntPtr, System.UIntPtr>.AdditiveIdentity => (nuint)0;

        static nuint System.Numerics.IBinaryNumber<System.UIntPtr>.AllBitsSet => nuint.MaxValue;

        static nuint System.Numerics.IMinMaxValue<System.UIntPtr>.MaxValue => MaxValue;

        static nuint System.Numerics.IMinMaxValue<System.UIntPtr>.MinValue => MinValue;

        static nuint System.Numerics.IMultiplicativeIdentity<System.UIntPtr, System.UIntPtr>.MultiplicativeIdentity => (nuint)1;

        static nuint System.Numerics.INumberBase<System.UIntPtr>.One => (nuint)1;

        static int System.Numerics.INumberBase<System.UIntPtr>.Radix => 2;

        static nuint System.Numerics.INumberBase<System.UIntPtr>.Zero => (nuint)0;

        public static nuint CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out nuint result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<nuint>();

        public static nuint CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out nuint result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<nuint>();

        public static nuint CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out nuint result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<nuint>();

        static nuint System.Numerics.IAdditionOperators<nuint, nuint, nuint>.operator +(nuint left, nuint right) => unchecked(left + right);

        static nuint System.Numerics.IAdditionOperators<nuint, nuint, nuint>.operator checked +(nuint left, nuint right) => checked(left + right);

        static nuint System.Numerics.IBitwiseOperators<nuint, nuint, nuint>.operator &(nuint left, nuint right) => unchecked(left & right);

        static nuint System.Numerics.IBitwiseOperators<nuint, nuint, nuint>.operator |(nuint left, nuint right) => unchecked(left | right);

        static nuint System.Numerics.IBitwiseOperators<nuint, nuint, nuint>.operator ^(nuint left, nuint right) => unchecked(left ^ right);

        static nuint System.Numerics.IBitwiseOperators<nuint, nuint, nuint>.operator ~(nuint value) => unchecked(~value);

        static bool System.Numerics.IComparisonOperators<nuint, nuint, bool>.operator >(nuint left, nuint right) => left > right;

        static bool System.Numerics.IComparisonOperators<nuint, nuint, bool>.operator >=(nuint left, nuint right) => left >= right;

        static bool System.Numerics.IComparisonOperators<nuint, nuint, bool>.operator <(nuint left, nuint right) => left < right;

        static bool System.Numerics.IComparisonOperators<nuint, nuint, bool>.operator <=(nuint left, nuint right) => left <= right;

        static nuint System.Numerics.IDecrementOperators<nuint>.operator checked --(nuint value) => checked(value - 1);

        static nuint System.Numerics.IDecrementOperators<nuint>.operator --(nuint value) => unchecked(value - 1);

        static nuint System.Numerics.IDivisionOperators<nuint, nuint, nuint>.operator /(nuint left, nuint right) => unchecked(left / right);

        static bool System.Numerics.IEqualityOperators<nuint, nuint, bool>.operator ==(nuint left, nuint right) => left == right;

        static bool System.Numerics.IEqualityOperators<nuint, nuint, bool>.operator !=(nuint left, nuint right) => left != right;

        static nuint System.Numerics.IIncrementOperators<nuint>.operator checked ++(nuint value) => checked(value + 1);

        static nuint System.Numerics.IIncrementOperators<nuint>.operator ++(nuint value) => unchecked(value + 1);

        static nuint System.Numerics.IModulusOperators<nuint, nuint, nuint>.operator %(nuint left, nuint right) => unchecked(left % right);

        static nuint System.Numerics.IMultiplyOperators<nuint, nuint, nuint>.operator checked *(nuint left, nuint right) => checked(left * right);

        static nuint System.Numerics.IMultiplyOperators<nuint, nuint, nuint>.operator *(nuint left, nuint right) => unchecked(left * right);

        static nuint System.Numerics.INumberBase<nuint>.Abs(nuint value) => value;

        static bool System.Numerics.INumberBase<nuint>.IsCanonical(nuint value) => true;

        static bool System.Numerics.INumberBase<nuint>.IsComplexNumber(nuint value) => false;

        static bool System.Numerics.INumberBase<nuint>.IsFinite(nuint value) => true;

        static bool System.Numerics.INumberBase<nuint>.IsImaginaryNumber(nuint value) => false;

        static bool System.Numerics.INumberBase<nuint>.IsInfinity(nuint value) => false;

        static bool System.Numerics.INumberBase<nuint>.IsInteger(nuint value) => true;

        static bool System.Numerics.INumberBase<nuint>.IsNaN(nuint value) => false;

        static bool System.Numerics.INumberBase<nuint>.IsNegative(nuint value) => false;

        static bool System.Numerics.INumberBase<nuint>.IsNegativeInfinity(nuint value) => false;

        static bool System.Numerics.INumberBase<nuint>.IsNormal(nuint value) => value != 0;

        static bool System.Numerics.INumberBase<nuint>.IsPositive(nuint value) => true;

        static bool System.Numerics.INumberBase<nuint>.IsPositiveInfinity(nuint value) => false;

        static bool System.Numerics.INumberBase<nuint>.IsRealNumber(nuint value) => true;

        static bool System.Numerics.INumberBase<nuint>.IsSubnormal(nuint value) => false;

        static bool System.Numerics.INumberBase<nuint>.IsZero(nuint value) => value == 0;

        static nuint System.Numerics.INumberBase<nuint>.MaxMagnitude(nuint x, nuint y) => x >= y ? x : y;

        static nuint System.Numerics.INumberBase<nuint>.MaxMagnitudeNumber(nuint x, nuint y) => x >= y ? x : y;

        static nuint System.Numerics.INumberBase<nuint>.MinMagnitude(nuint x, nuint y) => x <= y ? x : y;

        static nuint System.Numerics.INumberBase<nuint>.MinMagnitudeNumber(nuint x, nuint y) => x <= y ? x : y;

        static nuint System.Numerics.INumberBase<nuint>.MultiplyAddEstimate(nuint left, nuint right, nuint addend) => unchecked((left * right) + addend);

        static bool System.Numerics.INumberBase<nuint>.TryConvertFromChecked<TOther>(TOther value, out nuint result) => Numbers.TryConvert<TOther, nuint>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<nuint>.TryConvertFromSaturating<TOther>(TOther value, out nuint result) => Numbers.TryConvert<TOther, nuint>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<nuint>.TryConvertFromTruncating<TOther>(TOther value, out nuint result) => Numbers.TryConvert<TOther, nuint>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<nuint>.TryConvertToChecked<TOther>(nuint value, out TOther result) => Numbers.TryConvert<nuint, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<nuint>.TryConvertToSaturating<TOther>(nuint value, out TOther result) => Numbers.TryConvert<nuint, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<nuint>.TryConvertToTruncating<TOther>(nuint value, out TOther result) => Numbers.TryConvert<nuint, TOther>(value, out result, Numbers.Truncating);

        static nuint System.Numerics.INumber<nuint>.MaxNumber(nuint x, nuint y) => x >= y ? x : y;

        static nuint System.Numerics.INumber<nuint>.MinNumber(nuint x, nuint y) => x <= y ? x : y;

        static nuint System.Numerics.IShiftOperators<nuint, int, nuint>.operator <<(nuint value, int shiftAmount) => value << shiftAmount;

        static nuint System.Numerics.IShiftOperators<nuint, int, nuint>.operator >>(nuint value, int shiftAmount) => value >> shiftAmount;

        static nuint System.Numerics.IShiftOperators<nuint, int, nuint>.operator >>>(nuint value, int shiftAmount) => value >>> shiftAmount;

        static nuint System.Numerics.ISubtractionOperators<nuint, nuint, nuint>.operator checked -(nuint left, nuint right) => checked(left - right);

        static nuint System.Numerics.ISubtractionOperators<nuint, nuint, nuint>.operator -(nuint left, nuint right) => unchecked(left - right);

        static nuint System.Numerics.IUnaryNegationOperators<nuint, nuint>.operator checked -(nuint value) => checked(0 - value);

        static nuint System.Numerics.IUnaryNegationOperators<nuint, nuint>.operator -(nuint value) => unchecked(0 - value);

        static nuint System.Numerics.IUnaryPlusOperators<nuint, nuint>.operator +(nuint value) => value;
    }

    [Surface]
    public readonly partial struct Single
    {
        static float System.Numerics.IAdditiveIdentity<System.Single, System.Single>.AdditiveIdentity => (float)0;

        static float System.Numerics.IBinaryNumber<System.Single>.AllBitsSet => BitConverter.Int32BitsToSingle(-1);

        static float System.Numerics.IFloatingPointConstants<System.Single>.E => E;

        static float System.Numerics.IFloatingPointConstants<System.Single>.Pi => Pi;

        static float System.Numerics.IFloatingPointConstants<System.Single>.Tau => Tau;

        static float System.Numerics.IFloatingPointIeee754<System.Single>.Epsilon => Epsilon;

        static float System.Numerics.IFloatingPointIeee754<System.Single>.NaN => NaN;

        static float System.Numerics.IFloatingPointIeee754<System.Single>.NegativeInfinity => NegativeInfinity;

        static float System.Numerics.IFloatingPointIeee754<System.Single>.NegativeZero => NegativeZero;

        static float System.Numerics.IFloatingPointIeee754<System.Single>.PositiveInfinity => PositiveInfinity;

        static float System.Numerics.IMinMaxValue<System.Single>.MaxValue => MaxValue;

        static float System.Numerics.IMinMaxValue<System.Single>.MinValue => MinValue;

        static float System.Numerics.IMultiplicativeIdentity<System.Single, System.Single>.MultiplicativeIdentity => (float)1;

        static float System.Numerics.INumberBase<System.Single>.One => (float)1;

        static int System.Numerics.INumberBase<System.Single>.Radix => 2;

        static float System.Numerics.INumberBase<System.Single>.Zero => (float)0;

        static float System.Numerics.ISignedNumber<System.Single>.NegativeOne => (float)-1;

        public static float CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out float result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<float>();

        public static float CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out float result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<float>();

        public static float CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out float result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<float>();

        public static bool operator ==(float left, float right) => left == right;

        public static bool operator >(float left, float right) => left > right;

        public static bool operator >=(float left, float right) => left >= right;

        public static bool operator !=(float left, float right) => left != right;

        public static bool operator <(float left, float right) => left < right;

        public static bool operator <=(float left, float right) => left <= right;

        static float System.Numerics.IAdditionOperators<float, float, float>.operator +(float left, float right) => left + right;

        static float System.Numerics.IBitwiseOperators<float, float, float>.operator &(float left, float right) => BitConverter.Int32BitsToSingle(BitConverter.SingleToInt32Bits(left) & BitConverter.SingleToInt32Bits(right));

        static float System.Numerics.IBitwiseOperators<float, float, float>.operator |(float left, float right) => BitConverter.Int32BitsToSingle(BitConverter.SingleToInt32Bits(left) | BitConverter.SingleToInt32Bits(right));

        static float System.Numerics.IBitwiseOperators<float, float, float>.operator ^(float left, float right) => BitConverter.Int32BitsToSingle(BitConverter.SingleToInt32Bits(left) ^ BitConverter.SingleToInt32Bits(right));

        static float System.Numerics.IBitwiseOperators<float, float, float>.operator ~(float value) => BitConverter.Int32BitsToSingle(~BitConverter.SingleToInt32Bits(value));

        static float System.Numerics.IDecrementOperators<float>.operator --(float value) => value - 1;

        static float System.Numerics.IDivisionOperators<float, float, float>.operator /(float left, float right) => left / right;

        static float System.Numerics.IIncrementOperators<float>.operator ++(float value) => value + 1;

        static float System.Numerics.IModulusOperators<float, float, float>.operator %(float left, float right) => left % right;

        static float System.Numerics.IMultiplyOperators<float, float, float>.operator *(float left, float right) => left * right;

        static bool System.Numerics.INumberBase<float>.IsCanonical(float value) => true;

        static bool System.Numerics.INumberBase<float>.IsComplexNumber(float value) => false;

        static bool System.Numerics.INumberBase<float>.IsImaginaryNumber(float value) => false;

        static bool System.Numerics.INumberBase<float>.IsZero(float value) => value == 0;

        static bool System.Numerics.INumberBase<float>.TryConvertFromChecked<TOther>(TOther value, out float result) => Numbers.TryConvert<TOther, float>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<float>.TryConvertFromSaturating<TOther>(TOther value, out float result) => Numbers.TryConvert<TOther, float>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<float>.TryConvertFromTruncating<TOther>(TOther value, out float result) => Numbers.TryConvert<TOther, float>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<float>.TryConvertToChecked<TOther>(float value, out TOther result) => Numbers.TryConvert<float, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<float>.TryConvertToSaturating<TOther>(float value, out TOther result) => Numbers.TryConvert<float, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<float>.TryConvertToTruncating<TOther>(float value, out TOther result) => Numbers.TryConvert<float, TOther>(value, out result, Numbers.Truncating);

        static float System.Numerics.ISubtractionOperators<float, float, float>.operator -(float left, float right) => left - right;

        static float System.Numerics.IUnaryNegationOperators<float, float>.operator -(float value) => -value;

        static float System.Numerics.IUnaryPlusOperators<float, float>.operator +(float value) => value;
    }

    [Surface]
    public readonly partial struct Double
    {
        static double System.Numerics.IAdditiveIdentity<System.Double, System.Double>.AdditiveIdentity => (double)0;

        static double System.Numerics.IBinaryNumber<System.Double>.AllBitsSet => BitConverter.Int64BitsToDouble(-1);

        static double System.Numerics.IFloatingPointConstants<System.Double>.E => E;

        static double System.Numerics.IFloatingPointConstants<System.Double>.Pi => Pi;

        static double System.Numerics.IFloatingPointConstants<System.Double>.Tau => Tau;

        static double System.Numerics.IFloatingPointIeee754<System.Double>.Epsilon => Epsilon;

        static double System.Numerics.IFloatingPointIeee754<System.Double>.NaN => NaN;

        static double System.Numerics.IFloatingPointIeee754<System.Double>.NegativeInfinity => NegativeInfinity;

        static double System.Numerics.IFloatingPointIeee754<System.Double>.NegativeZero => NegativeZero;

        static double System.Numerics.IFloatingPointIeee754<System.Double>.PositiveInfinity => PositiveInfinity;

        static double System.Numerics.IMinMaxValue<System.Double>.MaxValue => MaxValue;

        static double System.Numerics.IMinMaxValue<System.Double>.MinValue => MinValue;

        static double System.Numerics.IMultiplicativeIdentity<System.Double, System.Double>.MultiplicativeIdentity => (double)1;

        static double System.Numerics.INumberBase<System.Double>.One => (double)1;

        static int System.Numerics.INumberBase<System.Double>.Radix => 2;

        static double System.Numerics.INumberBase<System.Double>.Zero => (double)0;

        static double System.Numerics.ISignedNumber<System.Double>.NegativeOne => (double)-1;

        public static double CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out double result, Numbers.Checked) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToChecked(value, out result)) ? result : Numbers.Unsupported<double>();

        public static double CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out double result, Numbers.Saturating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToSaturating(value, out result)) ? result : Numbers.Unsupported<double>();

        public static double CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther> => Numbers.TryConvert(value, out double result, Numbers.Truncating) || (!typeof(TOther).IsPrimitive && TOther.TryConvertToTruncating(value, out result)) ? result : Numbers.Unsupported<double>();

        public static bool operator ==(double left, double right) => left == right;

        public static bool operator >(double left, double right) => left > right;

        public static bool operator >=(double left, double right) => left >= right;

        public static bool operator !=(double left, double right) => left != right;

        public static bool operator <(double left, double right) => left < right;

        public static bool operator <=(double left, double right) => left <= right;

        static double System.Numerics.IAdditionOperators<double, double, double>.operator +(double left, double right) => left + right;

        static double System.Numerics.IBitwiseOperators<double, double, double>.operator &(double left, double right) => BitConverter.Int64BitsToDouble(BitConverter.DoubleToInt64Bits(left) & BitConverter.DoubleToInt64Bits(right));

        static double System.Numerics.IBitwiseOperators<double, double, double>.operator |(double left, double right) => BitConverter.Int64BitsToDouble(BitConverter.DoubleToInt64Bits(left) | BitConverter.DoubleToInt64Bits(right));

        static double System.Numerics.IBitwiseOperators<double, double, double>.operator ^(double left, double right) => BitConverter.Int64BitsToDouble(BitConverter.DoubleToInt64Bits(left) ^ BitConverter.DoubleToInt64Bits(right));

        static double System.Numerics.IBitwiseOperators<double, double, double>.operator ~(double value) => BitConverter.Int64BitsToDouble(~BitConverter.DoubleToInt64Bits(value));

        static double System.Numerics.IDecrementOperators<double>.operator --(double value) => value - 1;

        static double System.Numerics.IDivisionOperators<double, double, double>.operator /(double left, double right) => left / right;

        static double System.Numerics.IIncrementOperators<double>.operator ++(double value) => value + 1;

        static double System.Numerics.IModulusOperators<double, double, double>.operator %(double left, double right) => left % right;

        static double System.Numerics.IMultiplyOperators<double, double, double>.operator *(double left, double right) => left * right;

        static bool System.Numerics.INumberBase<double>.IsCanonical(double value) => true;

        static bool System.Numerics.INumberBase<double>.IsComplexNumber(double value) => false;

        static bool System.Numerics.INumberBase<double>.IsImaginaryNumber(double value) => false;

        static bool System.Numerics.INumberBase<double>.IsZero(double value) => value == 0;

        static bool System.Numerics.INumberBase<double>.TryConvertFromChecked<TOther>(TOther value, out double result) => Numbers.TryConvert<TOther, double>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<double>.TryConvertFromSaturating<TOther>(TOther value, out double result) => Numbers.TryConvert<TOther, double>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<double>.TryConvertFromTruncating<TOther>(TOther value, out double result) => Numbers.TryConvert<TOther, double>(value, out result, Numbers.Truncating);

        static bool System.Numerics.INumberBase<double>.TryConvertToChecked<TOther>(double value, out TOther result) => Numbers.TryConvert<double, TOther>(value, out result, Numbers.Checked);

        static bool System.Numerics.INumberBase<double>.TryConvertToSaturating<TOther>(double value, out TOther result) => Numbers.TryConvert<double, TOther>(value, out result, Numbers.Saturating);

        static bool System.Numerics.INumberBase<double>.TryConvertToTruncating<TOther>(double value, out TOther result) => Numbers.TryConvert<double, TOther>(value, out result, Numbers.Truncating);

        static double System.Numerics.ISubtractionOperators<double, double, double>.operator -(double left, double right) => left - right;

        static double System.Numerics.IUnaryNegationOperators<double, double>.operator -(double value) => -value;

        static double System.Numerics.IUnaryPlusOperators<double, double>.operator +(double value) => value;
    }
}
