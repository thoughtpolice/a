// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What dotnet/runtime's Half (dotnet-runtime/Half.cs) needs of the CoreLib
// beside its own arithmetic, conversions and generic math, which are its
// C# over the 16 bits: its text, whose own is .NET's generic FormatFloat and
// TryParseFloat over pointers into stack buffers (here the CoreLib's Dragon4
// over its 11-bit significand, runtime/Number.cs, and .NET's number parser
// with an exactly rounded conversion, HalfText); its comparisons without
// the hardware paths it takes on x64 and arm64 (comparing as floats, which
// its conversion makes exact), whose tests name intrinsic classes the
// CoreLib does not have; and BitConverter's Half members and the byte-order
// writes of its IFloatingPoint members. With them, the rest of Half.cs
// compiles, so Half implements IBinaryFloatingPointIeee754<Half> as .NET's
// does.

namespace System
{
    using System.Globalization;
    using Gameplay.Runtime;

    public readonly partial struct Half
    {
        public static bool operator <(Half left, Half right) => (float)left < (float)right;

        public static bool operator <=(Half left, Half right) => (float)left <= (float)right;

        public int CompareTo(Half other) => ((float)this).CompareTo((float)other);

        public override string ToString() => Number.FormatHalf(_value, null);

        public string ToString(string? format) => Number.FormatHalf(_value, format);

        public string ToString(IFormatProvider? provider) => Number.FormatHalf(_value, null);

        public string ToString(string? format, IFormatProvider? provider) => Number.FormatHalf(_value, format);

        public bool TryFormat(Span<char> destination, out int charsWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            BigIntegerText.TryCopy(Number.FormatHalf(_value, format.ToString()), destination, out charsWritten);

        public bool TryFormat(Span<byte> utf8Destination, out int bytesWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            BigIntegerText.TryCopyUtf8(Number.FormatHalf(_value, format.ToString()), utf8Destination, out bytesWritten);

        public static Half Parse(ReadOnlySpan<char> s, NumberStyles style = DefaultParseStyle, IFormatProvider? provider = null) =>
            HalfText.Parse(s.ToString(), style);

        public static Half Parse(ReadOnlySpan<byte> utf8Text, NumberStyles style = NumberStyles.Float | NumberStyles.AllowThousands, IFormatProvider? provider = null)
        {
            HalfText.Validate(style);
            return Utf8Text.TryDecode(utf8Text, out string text) ? HalfText.Parse(text, style) : throw new FormatException(SR.Format_InvalidString);
        }

        public static bool TryParse(string? s, NumberStyles style, IFormatProvider? provider, out Half result)
        {
            HalfText.Validate(style);
            return HalfText.TryParse(s, style, false, out result, out _);
        }

        public static bool TryParse(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out Half result)
        {
            HalfText.Validate(style);
            return HalfText.TryParse(s.ToString(), style, false, out result, out _);
        }

        public static bool TryParse(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out Half result)
        {
            HalfText.Validate(style);
            return HalfText.TryParse(Utf8Text.TryDecode(utf8Text, out string text) ? text : null, style, false, out result, out _);
        }

        public static bool TryParsePartial(string? s, NumberStyles style, IFormatProvider? provider, out Half result, out int charsConsumed)
        {
            HalfText.Validate(style);
            return HalfText.TryParse(s, style, true, out result, out charsConsumed);
        }

        public static bool TryParsePartial(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out Half result, out int charsConsumed)
        {
            HalfText.Validate(style);
            return HalfText.TryParse(s.ToString(), style, true, out result, out charsConsumed);
        }

        public static bool TryParsePartial(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out Half result, out int bytesConsumed)
        {
            HalfText.Validate(style);
            return HalfText.TryParse(Int128Text.AsciiPrefix(utf8Text), style, true, out result, out bytesConsumed);
        }
    }

    // The bit layout constants Half's conversions name, as .NET's
    // System.Private.CoreLib declares them.
    public readonly partial struct Double
    {
        internal const ulong SignMask = 0x8000_0000_0000_0000;
        internal const int SignShift = 63;
        internal const ulong BiasedExponentMask = 0x7FF0_0000_0000_0000;
        internal const int BiasedExponentShift = 52;
        internal const ulong TrailingSignificandMask = 0x000F_FFFF_FFFF_FFFF;

        internal static double CreateDouble(bool sign, ushort exp, ulong sig) =>
            BitConverter.UInt64BitsToDouble(((sign ? 1UL : 0UL) << SignShift) + ((ulong)exp << BiasedExponentShift) + sig);
    }

    public readonly partial struct Single
    {
        internal const uint SignMask = 0x8000_0000;
        internal const int SignShift = 31;
        internal const uint BiasedExponentMask = 0x7F80_0000;
        internal const int BiasedExponentShift = 23;
        internal const uint TrailingSignificandMask = 0x007F_FFFF;
    }

    [Surface]
    public static partial class BitConverter
    {
        public static short HalfToInt16Bits(Half value) => (short)value._value;

        public static ushort HalfToUInt16Bits(Half value) => value._value;

        public static Half Int16BitsToHalf(short value) => new Half((ushort)value);

        public static Half UInt16BitsToHalf(ushort value) => new Half(value);
    }
}

namespace System.Buffers.Binary
{
    internal static partial class BinaryPrimitives
    {
        internal static bool TryWriteUInt16BigEndian(Span<byte> destination, ushort value)
        {
            if (destination.Length < 2)
            {
                return false;
            }

            destination[0] = (byte)(value >> 8);
            destination[1] = (byte)value;
            return true;
        }

        internal static bool TryWriteUInt16LittleEndian(Span<byte> destination, ushort value)
        {
            if (destination.Length < 2)
            {
                return false;
            }

            destination[0] = (byte)value;
            destination[1] = (byte)(value >> 8);
            return true;
        }
    }
}

namespace Gameplay.Runtime
{
    using System;
    using System.Globalization;

    // .NET's TryParseFloat for Half and the invariant culture: the number's
    // digits (NumberText.Scan) rounded once, exactly, to Half's 11 bits, or
    // the special values' symbols.
    internal sealed class HalfText
    {
        private const NumberStyles InvalidNumberStyles = ~(NumberStyles.AllowLeadingWhite | NumberStyles.AllowTrailingWhite
                                                           | NumberStyles.AllowLeadingSign | NumberStyles.AllowTrailingSign
                                                           | NumberStyles.AllowParentheses | NumberStyles.AllowDecimalPoint
                                                           | NumberStyles.AllowThousands | NumberStyles.AllowExponent
                                                           | NumberStyles.AllowCurrencySymbol | NumberStyles.AllowHexSpecifier
                                                           | NumberStyles.AllowBinarySpecifier);

        // .NET's ValidateParseStyleFloatingPoint; hexadecimal floating point
        // (NumberStyles.HexFloat), which .NET 11 reads, is not read here.
        internal static void Validate(NumberStyles style)
        {
            if ((style & (InvalidNumberStyles | NumberStyles.AllowBinarySpecifier | NumberStyles.AllowHexSpecifier)) != 0
                && ((style & ~NumberStyles.HexFloat) != 0
                    || ((style & NumberStyles.AllowHexSpecifier) != 0 && (style & NumberStyles.AllowExponent) == 0)))
            {
                throw new ArgumentException(
                    (style & InvalidNumberStyles) != 0 ? SR.Argument_InvalidNumberStyles
                    : (style & NumberStyles.AllowBinarySpecifier) != 0 ? SR.Arg_BinaryStyleNotSupported
                    : SR.Arg_InvalidHexFloatStyle,
                    nameof(style));
            }

            if ((style & NumberStyles.AllowHexSpecifier) != 0)
            {
                throw new NotSupportedException("Parsing hexadecimal floating point (NumberStyles.HexFloat) is not supported.");
            }
        }

        internal static Half Parse(string text, NumberStyles style)
        {
            Validate(style);
            return TryParse(text, style, false, out Half result, out _)
                ? result
                : throw new FormatException(SR.Format(SR.Format_InvalidStringWithValue, text));
        }

        internal static bool TryParse(string? text, NumberStyles style, bool partial, out Half result, out int consumed)
        {
            result = default;
            consumed = 0;
            if (text is null)
            {
                return false;
            }

            if (NumberText.Scan(text, style, partial, false, out char[] digits, out int digEnd, out int scale, out bool negative, out consumed))
            {
                double magnitude = Magnitude(digits, digEnd, scale);
                result = (Half)(negative ? -magnitude : magnitude);
                return true;
            }

            // The special values, whitespace around them allowed whatever the
            // style.
            int start = 0;
            while (start < text.Length && char.IsWhiteSpace(text[start]))
            {
                start++;
            }

            if (Special(text, start, "Infinity", partial, out consumed))
            {
                result = Half.PositiveInfinity;
                return true;
            }

            if (Special(text, start, "-Infinity", partial, out consumed))
            {
                result = Half.NegativeInfinity;
                return true;
            }

            if (Special(text, start, "NaN", partial, out consumed))
            {
                result = Half.NaN;
                return true;
            }

            if (start < text.Length && text[start] == '+')
            {
                if (Special(text, start + 1, "Infinity", partial, out consumed))
                {
                    result = Half.PositiveInfinity;
                    return true;
                }

                if (Special(text, start + 1, "NaN", partial, out consumed))
                {
                    result = Half.NaN;
                    return true;
                }
            }
            else if (start < text.Length && text[start] == '-' && Special(text, start + 1, "NaN", partial, out consumed))
            {
                result = Half.NaN;
                return true;
            }

            consumed = 0;
            return false;
        }

        // .NET's TryMatchSpecialValueSymbol: the symbol, ignoring case, then
        // whitespace, then the end (or, for a partial parse, anything).
        private static bool Special(string text, int start, string symbol, bool partial, out int consumed)
        {
            consumed = 0;
            if (text.Length - start < symbol.Length)
            {
                return false;
            }

            for (int index = 0; index < symbol.Length; index++)
            {
                if (char.ToUpperInvariant(text[start + index]) != char.ToUpperInvariant(symbol[index]))
                {
                    return false;
                }
            }

            int end = start + symbol.Length;
            while (end < text.Length && char.IsWhiteSpace(text[end]))
            {
                end++;
            }

            if (end != text.Length && !partial)
            {
                return false;
            }

            consumed = end;
            return true;
        }

        // 0.d1d2... * 10^scale rounded to Half's precision, as a double that
        // converts to the Half exactly (or, past Half's range, overflows to
        // its infinity).
        private static double Magnitude(char[] digits, int digEnd, int scale)
        {
            if (digEnd == 0 || scale < -10)
            {
                return 0;
            }

            if (scale > 6)
            {
                return double.PositiveInfinity;
            }

            var value = new Big();
            for (int index = 0; index < digEnd; index++)
            {
                value.MultiplySmall(10);
                value.AddSmall((uint)(digits[index] - '0'));
            }

            int exponent = scale - digEnd;
            if (exponent >= 0)
            {
                value.MultiplyPow10(exponent);
                var one = new Big();
                one.Set(1);
                return DecimalRounding.Nearest(value, one, 11, -24);
            }

            return DecimalRounding.Nearest(value, -exponent, 11, -24);
        }
    }
}
