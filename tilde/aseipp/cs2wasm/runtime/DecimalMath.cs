// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Generic math over decimal (`T : INumber<T>` and the rest of what
// System.Decimal implements): the interface members .NET's Decimal.cs
// implements explicitly, and the conversions to and from the other numeric
// types, ported from dotnet/runtime's Decimal.cs member for member over
// this struct's fields and DecCalc. The public statics generic math
// shares with decimal's own API (Abs, Max, Clamp, IsInteger, Round, ...)
// are in Decimal.cs. Gameplay code's System.Decimal is this struct, so a
// constrained call over decimal reaches these.

namespace Gameplay.Runtime
{
    using System;
    using System.Globalization;
    using System.Numerics;

    public readonly partial struct Decimal :
        IFloatingPoint<Decimal>,
        IMinMaxValue<Decimal>,
        IComparable,
        IEquatable<Decimal>,
        IUtf8SpanFormattable
    {
        // MARK: Constants

        private static Decimal ZeroValue => new Decimal(0, 0, 0);

        private static Decimal OneValue => new Decimal(0, 0, 1);

        static Decimal IAdditiveIdentity<Decimal, Decimal>.AdditiveIdentity => ZeroValue;

        static Decimal IMultiplicativeIdentity<Decimal, Decimal>.MultiplicativeIdentity => OneValue;

        static Decimal INumberBase<Decimal>.One => OneValue;

        static int INumberBase<Decimal>.Radix => 10;

        static Decimal INumberBase<Decimal>.Zero => ZeroValue;

        static Decimal ISignedNumber<Decimal>.NegativeOne => new Decimal(SignMask, 0, 1);

        static Decimal IMinMaxValue<Decimal>.MinValue => new Decimal(SignMask, uint.MaxValue, ulong.MaxValue);

        static Decimal IMinMaxValue<Decimal>.MaxValue => new Decimal(0, uint.MaxValue, ulong.MaxValue);

        // 2.7182818284590452353602874714m, 3.1415926535897932384626433833m
        // and 6.2831853071795864769252867666m, as their fields.
        static Decimal IFloatingPointConstants<Decimal>.E => new Decimal(28 << ScaleShift, 0x57D519AB, 0xEBECDE35_857AED5A);

        static Decimal IFloatingPointConstants<Decimal>.Pi => new Decimal(28 << ScaleShift, 0x6582A536, 0x0B143885_41B65F29);

        static Decimal IFloatingPointConstants<Decimal>.Tau => new Decimal(28 << ScaleShift, 0xCB054A6C, 0x1628710A_836CBE52);

        // MARK: Operators

        // Decimal's operators check for overflow already, so the checked
        // forms are the same ones.
        static Decimal IAdditionOperators<Decimal, Decimal, Decimal>.operator checked +(Decimal left, Decimal right) => left + right;

        static Decimal ISubtractionOperators<Decimal, Decimal, Decimal>.operator checked -(Decimal left, Decimal right) => left - right;

        static Decimal IMultiplyOperators<Decimal, Decimal, Decimal>.operator checked *(Decimal left, Decimal right) => left * right;

        static Decimal IDivisionOperators<Decimal, Decimal, Decimal>.operator checked /(Decimal left, Decimal right) => left / right;

        static Decimal IUnaryNegationOperators<Decimal, Decimal>.operator checked -(Decimal value) => -value;

        static Decimal IIncrementOperators<Decimal>.operator checked ++(Decimal value) => ++value;

        static Decimal IDecrementOperators<Decimal>.operator checked --(Decimal value) => --value;

        // MARK: INumber and INumberBase

        static Decimal INumber<Decimal>.MaxNumber(Decimal x, Decimal y) => Max(x, y);

        static Decimal INumber<Decimal>.MinNumber(Decimal x, Decimal y) => Min(x, y);

        static bool INumberBase<Decimal>.IsComplexNumber(Decimal value) => false;

        static bool INumberBase<Decimal>.IsFinite(Decimal value) => true;

        static bool INumberBase<Decimal>.IsImaginaryNumber(Decimal value) => false;

        static bool INumberBase<Decimal>.IsInfinity(Decimal value) => false;

        static bool INumberBase<Decimal>.IsNaN(Decimal value) => false;

        static bool INumberBase<Decimal>.IsNegativeInfinity(Decimal value) => false;

        static bool INumberBase<Decimal>.IsNormal(Decimal value) => (value.hi | value.lo) != 0;

        static bool INumberBase<Decimal>.IsPositiveInfinity(Decimal value) => false;

        static bool INumberBase<Decimal>.IsRealNumber(Decimal value) => true;

        static bool INumberBase<Decimal>.IsSubnormal(Decimal value) => false;

        static bool INumberBase<Decimal>.IsZero(Decimal value) => (value.hi | value.lo) == 0;

        static Decimal INumberBase<Decimal>.MaxMagnitudeNumber(Decimal x, Decimal y) => MaxMagnitude(x, y);

        static Decimal INumberBase<Decimal>.MinMagnitudeNumber(Decimal x, Decimal y) => MinMagnitude(x, y);

        static Decimal INumberBase<Decimal>.MultiplyAddEstimate(Decimal left, Decimal right, Decimal addend) => (left * right) + addend;

        public static Decimal CreateChecked<TOther>(TOther value)
            where TOther : INumberBase<TOther>
        {
            if (typeof(TOther) == typeof(Decimal))
            {
                return (Decimal)(object)value;
            }

            return TryConvertFromChecked(value, out Decimal result) || TOther.TryConvertToChecked(value, out result)
                ? result
                : Numbers.Unsupported<Decimal>();
        }

        public static Decimal CreateSaturating<TOther>(TOther value)
            where TOther : INumberBase<TOther>
        {
            if (typeof(TOther) == typeof(Decimal))
            {
                return (Decimal)(object)value;
            }

            return TryConvertFrom(value, out Decimal result) || TOther.TryConvertToSaturating(value, out result)
                ? result
                : Numbers.Unsupported<Decimal>();
        }

        public static Decimal CreateTruncating<TOther>(TOther value)
            where TOther : INumberBase<TOther>
        {
            if (typeof(TOther) == typeof(Decimal))
            {
                return (Decimal)(object)value;
            }

            return TryConvertFrom(value, out Decimal result) || TOther.TryConvertToTruncating(value, out result)
                ? result
                : Numbers.Unsupported<Decimal>();
        }

        // .NET's split: decimal's TryConvertFrom takes the unsigned types
        // (and a checked UInt128), its TryConvertTo gives the signed and
        // floating-point ones; the other type's own methods do the rest.
        static bool INumberBase<Decimal>.TryConvertFromChecked<TOther>(TOther value, out Decimal result) =>
            TryConvertFromChecked(value, out result);

        private static bool TryConvertFromChecked<TOther>(TOther value, out Decimal result)
            where TOther : INumberBase<TOther>
        {
            if (typeof(TOther) == typeof(UInt128))
            {
                UInt128 actualValue = (UInt128)(object)value;
                if ((ulong)(actualValue >> 64) > uint.MaxValue)
                {
                    throw Overflow("a Decimal");
                }

                result = new Decimal(0, (uint)(ulong)(actualValue >> 64), (ulong)actualValue);
                return true;
            }

            return TryConvertFrom(value, out result);
        }

        static bool INumberBase<Decimal>.TryConvertFromSaturating<TOther>(TOther value, out Decimal result) =>
            TryConvertFrom(value, out result);

        static bool INumberBase<Decimal>.TryConvertFromTruncating<TOther>(TOther value, out Decimal result) =>
            TryConvertFrom(value, out result);

        private static bool TryConvertFrom<TOther>(TOther value, out Decimal result)
            where TOther : INumberBase<TOther>
        {
            if (typeof(TOther) == typeof(byte))
            {
                result = (byte)(object)value;
                return true;
            }

            if (typeof(TOther) == typeof(char))
            {
                result = (char)(object)value;
                return true;
            }

            if (typeof(TOther) == typeof(ushort))
            {
                result = (ushort)(object)value;
                return true;
            }

            if (typeof(TOther) == typeof(uint))
            {
                result = (uint)(object)value;
                return true;
            }

            if (typeof(TOther) == typeof(ulong))
            {
                result = (ulong)(object)value;
                return true;
            }

            if (typeof(TOther) == typeof(UInt128))
            {
                UInt128 actualValue = (UInt128)(object)value;
                ulong upper = (ulong)(actualValue >> 64);
                result = upper > uint.MaxValue
                    ? new Decimal(0, uint.MaxValue, ulong.MaxValue)
                    : new Decimal(0, (uint)upper, (ulong)actualValue);
                return true;
            }

            if (typeof(TOther) == typeof(nuint))
            {
                result = (ulong)(nuint)(object)value;
                return true;
            }

            result = ZeroValue;
            return false;
        }

        static bool INumberBase<Decimal>.TryConvertToChecked<TOther>(Decimal value, out TOther result)
        {
            if (typeof(TOther) == typeof(double))
            {
                result = (TOther)(object)(double)value;
                return true;
            }

            if (typeof(TOther) == typeof(Half))
            {
                result = (TOther)(object)(Half)(double)value;
                return true;
            }

            if (typeof(TOther) == typeof(short))
            {
                result = (TOther)(object)ToInt16(value);
                return true;
            }

            if (typeof(TOther) == typeof(int))
            {
                result = (TOther)(object)ToInt32(value);
                return true;
            }

            if (typeof(TOther) == typeof(long))
            {
                result = (TOther)(object)ToInt64(value);
                return true;
            }

            if (typeof(TOther) == typeof(Int128))
            {
                result = (TOther)(object)ToInt128(value);
                return true;
            }

            if (typeof(TOther) == typeof(nint))
            {
                result = (TOther)(object)(nint)ToInt64(value);
                return true;
            }

            if (typeof(TOther) == typeof(sbyte))
            {
                result = (TOther)(object)ToSByte(value);
                return true;
            }

            if (typeof(TOther) == typeof(float))
            {
                result = (TOther)(object)(float)value;
                return true;
            }

            result = default!;
            return false;
        }

        static bool INumberBase<Decimal>.TryConvertToSaturating<TOther>(Decimal value, out TOther result) =>
            TryConvertTo(value, out result);

        static bool INumberBase<Decimal>.TryConvertToTruncating<TOther>(Decimal value, out TOther result) =>
            TryConvertTo(value, out result);

        private static bool TryConvertTo<TOther>(Decimal value, out TOther result)
            where TOther : INumberBase<TOther>
        {
            if (typeof(TOther) == typeof(double))
            {
                result = (TOther)(object)(double)value;
                return true;
            }

            // Half's conversion from decimal, through double, as .NET's is.
            if (typeof(TOther) == typeof(Half))
            {
                result = (TOther)(object)(Half)(double)value;
                return true;
            }

            if (typeof(TOther) == typeof(short))
            {
                short actualResult = (value >= short.MaxValue) ? short.MaxValue :
                                     (value <= short.MinValue) ? short.MinValue : ToInt16(value);
                result = (TOther)(object)actualResult;
                return true;
            }

            if (typeof(TOther) == typeof(int))
            {
                int actualResult = (value >= int.MaxValue) ? int.MaxValue :
                                   (value <= int.MinValue) ? int.MinValue : ToInt32(value);
                result = (TOther)(object)actualResult;
                return true;
            }

            if (typeof(TOther) == typeof(long))
            {
                long actualResult = (value >= long.MaxValue) ? long.MaxValue :
                                    (value <= long.MinValue) ? long.MinValue : ToInt64(value);
                result = (TOther)(object)actualResult;
                return true;
            }

            if (typeof(TOther) == typeof(Int128))
            {
                result = (TOther)(object)ToInt128(value);
                return true;
            }

            if (typeof(TOther) == typeof(nint))
            {
                long actualResult = (value >= long.MaxValue) ? long.MaxValue :
                                    (value <= long.MinValue) ? long.MinValue : ToInt64(value);
                result = (TOther)(object)(nint)actualResult;
                return true;
            }

            if (typeof(TOther) == typeof(sbyte))
            {
                sbyte actualResult = (value >= sbyte.MaxValue) ? sbyte.MaxValue :
                                     (value <= sbyte.MinValue) ? sbyte.MinValue : ToSByte(value);
                result = (TOther)(object)actualResult;
                return true;
            }

            if (typeof(TOther) == typeof(float))
            {
                result = (TOther)(object)(float)value;
                return true;
            }

            result = default!;
            return false;
        }

        // A decimal's integer part, which always fits.
        private static Int128 ToInt128(Decimal value)
        {
            Decimal truncated = Truncate(value);
            var magnitude = new Int128(truncated.hi, truncated.lo);
            return IsNegative(truncated) ? -magnitude : magnitude;
        }

        // MARK: IFloatingPoint

        public static TInteger ConvertToInteger<TInteger>(Decimal value)
            where TInteger : IBinaryInteger<TInteger> => TInteger.CreateSaturating(value);

        public static TInteger ConvertToIntegerNative<TInteger>(Decimal value)
            where TInteger : IBinaryInteger<TInteger> => TInteger.CreateSaturating(value);

        // The exponent, as IFloatingPoint has it: the significand's 96 bits
        // are read as 10^(1-p) * m, p = 96, so a value's exponent is
        // 95 - scale, 67 to 95.
        private sbyte Exponent => (sbyte)(95 - Scale);

        int IFloatingPoint<Decimal>.GetExponentByteCount() => sizeof(sbyte);

        int IFloatingPoint<Decimal>.GetExponentShortestBitLength()
        {
            // sbyte.LeadingZeroCount of a positive exponent.
            return 32 - BitOperations.LeadingZeroCount((uint)Exponent);
        }

        int IFloatingPoint<Decimal>.GetSignificandByteCount() => sizeof(ulong) + sizeof(uint);

        int IFloatingPoint<Decimal>.GetSignificandBitLength() => 96;

        bool IFloatingPoint<Decimal>.TryWriteExponentBigEndian(System.Span<byte> destination, out int bytesWritten) =>
            TryWriteExponent(destination, out bytesWritten);

        bool IFloatingPoint<Decimal>.TryWriteExponentLittleEndian(System.Span<byte> destination, out int bytesWritten) =>
            TryWriteExponent(destination, out bytesWritten);

        private bool TryWriteExponent(System.Span<byte> destination, out int bytesWritten)
        {
            if (destination.Length >= sizeof(sbyte))
            {
                destination[0] = (byte)Exponent;
                bytesWritten = sizeof(sbyte);
                return true;
            }

            bytesWritten = 0;
            return false;
        }

        bool IFloatingPoint<Decimal>.TryWriteSignificandBigEndian(System.Span<byte> destination, out int bytesWritten)
        {
            if (destination.Length >= sizeof(uint) + sizeof(ulong))
            {
                for (int index = 0; index < 4; index++)
                {
                    destination[index] = (byte)(hi >> (24 - (8 * index)));
                }

                for (int index = 0; index < 8; index++)
                {
                    destination[4 + index] = (byte)(lo >> (56 - (8 * index)));
                }

                bytesWritten = sizeof(uint) + sizeof(ulong);
                return true;
            }

            bytesWritten = 0;
            return false;
        }

        bool IFloatingPoint<Decimal>.TryWriteSignificandLittleEndian(System.Span<byte> destination, out int bytesWritten)
        {
            if (destination.Length >= sizeof(ulong) + sizeof(uint))
            {
                for (int index = 0; index < 8; index++)
                {
                    destination[index] = (byte)(lo >> (8 * index));
                }

                for (int index = 0; index < 4; index++)
                {
                    destination[8 + index] = (byte)(hi >> (8 * index));
                }

                bytesWritten = sizeof(ulong) + sizeof(uint);
                return true;
            }

            bytesWritten = 0;
            return false;
        }

        // MARK: UTF-8 text

        public bool TryFormat(System.Span<byte> utf8Destination, out int bytesWritten, System.ReadOnlySpan<char> format = default, IFormatProvider provider = null)
        {
            byte[] bytes = Utf8Text.Encode(Number.FormatDecimal(this, format.ToString()));
            if (bytes.Length > utf8Destination.Length)
            {
                bytesWritten = 0;
                return false;
            }

            for (int index = 0; index < bytes.Length; index++)
            {
                utf8Destination[index] = bytes[index];
            }

            bytesWritten = bytes.Length;
            return true;
        }

        public static Decimal Parse(System.ReadOnlySpan<byte> utf8Text, NumberStyles style = NumberStyles.Number, IFormatProvider provider = null)
        {
            DecimalParsing.Validate((int)style);
            return Utf8Text.TryDecode(utf8Text, out string text)
                ? ParseText(text, (int)style)
                : throw new FormatException("The input string was not in a correct format.");
        }

        public static Decimal Parse(System.ReadOnlySpan<byte> utf8Text, IFormatProvider provider) => Parse(utf8Text, NumberStyles.Number, provider);

        public static bool TryParse(System.ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider provider, out Decimal result)
        {
            DecimalParsing.Validate((int)style);
            if (Utf8Text.TryDecode(utf8Text, out string text))
            {
                return TryParseText(text, (int)style, out result);
            }

            result = ZeroValue;
            return false;
        }

        public static bool TryParse(System.ReadOnlySpan<byte> utf8Text, IFormatProvider provider, out Decimal result) =>
            TryParse(utf8Text, NumberStyles.Number, provider, out result);
    }
}
