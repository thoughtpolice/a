// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The text of dotnet/runtime's Int128 and UInt128 (dotnet-runtime/Int128.cs,
// UInt128.cs), whose own is .NET's Number formatting and parsing over
// pointers into stack buffers: the decimal digits by long division by ten of
// the two halves, a digit at a time, the other formats as .NET's
// FormatInt128 and FormatUInt128 choose them (hexadecimal and binary of the
// 128 bits, the rest through the CoreLib's number formatting), and .NET's
// TryParseBinaryInteger for the invariant culture (Int128Text). With them,
// and their byte-order reads and writes (BinaryPrimitives below), the rest
// of those files compiles, so they implement IBinaryInteger<T> and the rest
// of generic math as .NET's do. And their conversions to and from decimal,
// whose own read System.Decimal's internal fields: the same through
// decimal's public bits.

namespace System
{
    using System.Globalization;
    using Gameplay.Runtime;

    public readonly partial struct UInt128
    {
        internal static string Decimal(ulong upper, ulong lower)
        {
            if (upper == 0)
            {
                return lower.ToString();
            }

            Span<char> digits = stackalloc char[39];
            int start = digits.Length;
            while (upper != 0 || lower != 0)
            {
                // (upper * 2^64 + lower) / 10, in 32-bit pieces.
                ulong remainder = 0;
                ulong part = (remainder << 32) | (upper >> 32);
                ulong upperHigh = part / 10;
                remainder = part % 10;
                part = (remainder << 32) | (uint)upper;
                ulong upperLow = part / 10;
                remainder = part % 10;
                part = (remainder << 32) | (lower >> 32);
                ulong lowerHigh = part / 10;
                remainder = part % 10;
                part = (remainder << 32) | (uint)lower;
                ulong lowerLow = part / 10;
                remainder = part % 10;
                upper = (upperHigh << 32) | upperLow;
                lower = (lowerHigh << 32) | lowerLow;
                digits[--start] = (char)('0' + (int)remainder);
            }

            return new string(digits.Slice(start));
        }

        public override string ToString() => Decimal(_upper, _lower);

        public string ToString(IFormatProvider? provider) => Int128Text.Format(_upper, _lower, false, null);

        public string ToString(string? format) => Int128Text.Format(_upper, _lower, false, format);

        public string ToString(string? format, IFormatProvider? provider) => Int128Text.Format(_upper, _lower, false, format);

        public bool TryFormat(Span<char> destination, out int charsWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            BigIntegerText.TryCopy(Int128Text.Format(_upper, _lower, false, format.ToString()), destination, out charsWritten);

        public bool TryFormat(Span<byte> utf8Destination, out int bytesWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            BigIntegerText.TryCopyUtf8(Int128Text.Format(_upper, _lower, false, format.ToString()), utf8Destination, out bytesWritten);

        public static UInt128 Parse(string s, NumberStyles style, IFormatProvider? provider)
        {
            ArgumentNullException.ThrowIfNull(s);
            return Int128Text.Parse(s, style, false, out ulong upper, out ulong lower) ? new UInt128(upper, lower) : default;
        }

        public static UInt128 Parse(ReadOnlySpan<char> s, NumberStyles style = NumberStyles.Integer, IFormatProvider? provider = null) =>
            Int128Text.Parse(s.ToString(), style, false, out ulong upper, out ulong lower) ? new UInt128(upper, lower) : default;

        public static UInt128 Parse(ReadOnlySpan<byte> utf8Text, NumberStyles style = NumberStyles.Integer, IFormatProvider? provider = null) =>
            Int128Text.ParseUtf8(utf8Text, style, false, out ulong upper, out ulong lower) ? new UInt128(upper, lower) : default;

        public static bool TryParse(string? s, NumberStyles style, IFormatProvider? provider, out UInt128 result)
        {
            BigIntegerText.Validate(style);
            return TryRead(s is null ? null : s, style, false, out result, out _);
        }

        public static bool TryParse(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out UInt128 result)
        {
            BigIntegerText.Validate(style);
            return TryRead(s.ToString(), style, false, out result, out _);
        }

        public static bool TryParse(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out UInt128 result)
        {
            BigIntegerText.Validate(style);
            return TryRead(Utf8Text.TryDecode(utf8Text, out string text) ? text : null, style, false, out result, out _);
        }

        public static bool TryParsePartial(string? s, NumberStyles style, IFormatProvider? provider, out UInt128 result, out int charsConsumed)
        {
            BigIntegerText.Validate(style);
            return TryRead(s, style, true, out result, out charsConsumed);
        }

        public static bool TryParsePartial(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out UInt128 result, out int charsConsumed)
        {
            BigIntegerText.Validate(style);
            return TryRead(s.ToString(), style, true, out result, out charsConsumed);
        }

        public static bool TryParsePartial(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out UInt128 result, out int bytesConsumed)
        {
            BigIntegerText.Validate(style);
            return TryRead(Int128Text.AsciiPrefix(utf8Text), style, true, out result, out bytesConsumed);
        }

        private static bool TryRead(string? text, NumberStyles style, bool partial, out UInt128 result, out int consumed)
        {
            if (text is null)
            {
                result = default;
                consumed = 0;
                return false;
            }

            bool parsed = Int128Text.TryParse(text, style, partial, false, out ulong upper, out ulong lower, out consumed) == Int128Text.Parsed;
            result = new UInt128(upper, lower);
            return parsed;
        }

        public static explicit operator decimal(UInt128 value)
        {
            if (value._upper > uint.MaxValue)
            {
                throw new OverflowException(SR.Overflow_Decimal);
            }

            return new decimal((int)value._lower, (int)(value._lower >> 32), (int)(uint)value._upper, false, 0);
        }

        public static explicit operator UInt128(decimal value)
        {
            value = decimal.Truncate(value);
            if (value < 0.0m)
            {
                ThrowHelper.ThrowOverflowException();
            }

            int[] bits = decimal.GetBits(value);
            return new UInt128((uint)bits[2], ((ulong)(uint)bits[1] << 32) | (uint)bits[0]);
        }
    }

    public readonly partial struct Int128
    {
        public string ToString(IFormatProvider? provider) => Int128Text.Format(_upper, _lower, true, null);

        public string ToString(string? format) => Int128Text.Format(_upper, _lower, true, format);

        public string ToString(string? format, IFormatProvider? provider) => Int128Text.Format(_upper, _lower, true, format);

        public bool TryFormat(Span<char> destination, out int charsWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            BigIntegerText.TryCopy(Int128Text.Format(_upper, _lower, true, format.ToString()), destination, out charsWritten);

        public bool TryFormat(Span<byte> utf8Destination, out int bytesWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            BigIntegerText.TryCopyUtf8(Int128Text.Format(_upper, _lower, true, format.ToString()), utf8Destination, out bytesWritten);

        public static Int128 Parse(string s, NumberStyles style, IFormatProvider? provider)
        {
            ArgumentNullException.ThrowIfNull(s);
            return Int128Text.Parse(s, style, true, out ulong upper, out ulong lower) ? new Int128(upper, lower) : default;
        }

        public static Int128 Parse(ReadOnlySpan<char> s, NumberStyles style = NumberStyles.Integer, IFormatProvider? provider = null) =>
            Int128Text.Parse(s.ToString(), style, true, out ulong upper, out ulong lower) ? new Int128(upper, lower) : default;

        public static Int128 Parse(ReadOnlySpan<byte> utf8Text, NumberStyles style = NumberStyles.Integer, IFormatProvider? provider = null) =>
            Int128Text.ParseUtf8(utf8Text, style, true, out ulong upper, out ulong lower) ? new Int128(upper, lower) : default;

        public static bool TryParse(string? s, NumberStyles style, IFormatProvider? provider, out Int128 result)
        {
            BigIntegerText.Validate(style);
            return TryRead(s, style, false, out result, out _);
        }

        public static bool TryParse(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out Int128 result)
        {
            BigIntegerText.Validate(style);
            return TryRead(s.ToString(), style, false, out result, out _);
        }

        public static bool TryParse(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out Int128 result)
        {
            BigIntegerText.Validate(style);
            return TryRead(Utf8Text.TryDecode(utf8Text, out string text) ? text : null, style, false, out result, out _);
        }

        public static bool TryParsePartial(string? s, NumberStyles style, IFormatProvider? provider, out Int128 result, out int charsConsumed)
        {
            BigIntegerText.Validate(style);
            return TryRead(s, style, true, out result, out charsConsumed);
        }

        public static bool TryParsePartial(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out Int128 result, out int charsConsumed)
        {
            BigIntegerText.Validate(style);
            return TryRead(s.ToString(), style, true, out result, out charsConsumed);
        }

        public static bool TryParsePartial(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out Int128 result, out int bytesConsumed)
        {
            BigIntegerText.Validate(style);
            return TryRead(Int128Text.AsciiPrefix(utf8Text), style, true, out result, out bytesConsumed);
        }

        private static bool TryRead(string? text, NumberStyles style, bool partial, out Int128 result, out int consumed)
        {
            if (text is null)
            {
                result = default;
                consumed = 0;
                return false;
            }

            bool parsed = Int128Text.TryParse(text, style, partial, true, out ulong upper, out ulong lower, out consumed) == Int128Text.Parsed;
            result = new Int128(upper, lower);
            return parsed;
        }

        public override string ToString()
        {
            if ((long)_upper >= 0)
            {
                return UInt128.Decimal(_upper, _lower);
            }

            // The magnitude: the two's complement of both halves.
            ulong lower = ~_lower + 1;
            ulong upper = ~_upper + (lower == 0 ? 1UL : 0UL);
            return "-" + UInt128.Decimal(upper, lower);
        }

        public static explicit operator decimal(Int128 value)
        {
            if (IsNegative(value))
            {
                value = -value;
                return -(decimal)new UInt128(value._upper, value._lower);
            }

            return (decimal)new UInt128(value._upper, value._lower);
        }

        public static explicit operator Int128(decimal value)
        {
            value = decimal.Truncate(value);
            int[] bits = decimal.GetBits(value);
            var result = new Int128((uint)bits[2], ((ulong)(uint)bits[1] << 32) | (uint)bits[0]);
            return decimal.IsNegative(value) ? -result : result;
        }
    }
}

namespace System.Buffers.Binary
{
    // What dotnet/runtime's Int128 and UInt128 read and write their bytes
    // with (IBinaryInteger's TryRead... and TryWrite...).
    internal static partial class BinaryPrimitives
    {
        private static ulong ReadUInt64(ReadOnlySpan<byte> source, int offset, bool bigEndian)
        {
            ulong value = 0;
            for (int index = 0; index < 8; index++)
            {
                value |= (ulong)source[offset + (bigEndian ? 7 - index : index)] << (index * 8);
            }

            return value;
        }

        private static void WriteUInt64(Span<byte> destination, int offset, ulong value, bool bigEndian)
        {
            for (int index = 0; index < 8; index++)
            {
                destination[offset + (bigEndian ? 7 - index : index)] = (byte)(value >> (index * 8));
            }
        }

        private static UInt128 ReadUInt128(ReadOnlySpan<byte> source, bool bigEndian)
        {
            if (source.Length < 16)
            {
                throw new ArgumentOutOfRangeException(nameof(source));
            }

            ulong first = ReadUInt64(source, 0, bigEndian);
            ulong second = ReadUInt64(source, 8, bigEndian);
            return bigEndian ? new UInt128(first, second) : new UInt128(second, first);
        }

        private static bool TryWriteUInt128(Span<byte> destination, UInt128 value, bool bigEndian)
        {
            if (destination.Length < 16)
            {
                return false;
            }

            ulong upper = (ulong)(value >> 64);
            ulong lower = (ulong)value;
            WriteUInt64(destination, 0, bigEndian ? upper : lower, bigEndian);
            WriteUInt64(destination, 8, bigEndian ? lower : upper, bigEndian);
            return true;
        }

        internal static UInt128 ReadUInt128BigEndian(ReadOnlySpan<byte> source) => ReadUInt128(source, true);

        internal static UInt128 ReadUInt128LittleEndian(ReadOnlySpan<byte> source) => ReadUInt128(source, false);

        internal static Int128 ReadInt128BigEndian(ReadOnlySpan<byte> source) => (Int128)ReadUInt128(source, true);

        internal static Int128 ReadInt128LittleEndian(ReadOnlySpan<byte> source) => (Int128)ReadUInt128(source, false);

        internal static bool TryWriteUInt128BigEndian(Span<byte> destination, UInt128 value) => TryWriteUInt128(destination, value, true);

        internal static bool TryWriteUInt128LittleEndian(Span<byte> destination, UInt128 value) => TryWriteUInt128(destination, value, false);

        internal static bool TryWriteInt128BigEndian(Span<byte> destination, Int128 value) => TryWriteUInt128(destination, (UInt128)value, true);

        internal static bool TryWriteInt128LittleEndian(Span<byte> destination, Int128 value) => TryWriteUInt128(destination, (UInt128)value, false);

        internal static Int128 ReverseEndianness(Int128 value)
        {
            UInt128 bits = (UInt128)value;
            ulong upper = (ulong)(bits >> 64);
            ulong lower = (ulong)bits;
            return (Int128)new UInt128(ReverseEndianness(lower), ReverseEndianness(upper));
        }

        internal static UInt128 ReverseEndianness(UInt128 value) => (UInt128)ReverseEndianness((Int128)value);

        private static ulong ReverseEndianness(ulong value)
        {
            ulong reversed = 0;
            for (int index = 0; index < 8; index++)
            {
                reversed = (reversed << 8) | ((value >> (index * 8)) & 0xFF);
            }

            return reversed;
        }
    }
}

namespace Gameplay.Runtime
{
    using System;
    using System.Globalization;

    // .NET's FormatInt128 and FormatUInt128, and TryParseBinaryInteger over
    // 128 bits, for the invariant culture.
    internal sealed class Int128Text
    {
        internal const int Parsed = 0;
        private const int Failed = 1;
        private const int Overflowed = 2;

        // .NET's ParseFormatSpecifier: a letter and at most nine digits, or
        // a custom format ('\0'); 'G' for none.
        private static char Specifier(string? format, out int digits)
        {
            char c = default;
            if (format is not null && format.Length > 0)
            {
                c = format[0];
                if ((uint)((c | 0x20) - 'a') <= 'z' - 'a')
                {
                    int index = 1;
                    int n = 0;
                    while (index < format.Length && (uint)(format[index] - '0') <= 9)
                    {
                        if (n >= 100_000_000)
                        {
                            throw new FormatException(SR.Argument_BadFormatSpecifier);
                        }

                        n = n * 10 + format[index++] - '0';
                    }

                    if (index == format.Length || format[index] == '\0')
                    {
                        digits = index == 1 ? -1 : n;
                        return c;
                    }
                }
            }

            digits = -1;
            return format is null || format.Length == 0 || c == '\0' ? 'G' : '\0';
        }

        // The bits (a signed value's two's complement) in a format.
        internal static string Format(ulong upper, ulong lower, bool signed, string? format)
        {
            bool negative = signed && (long)upper < 0;
            ulong magnitudeUpper = upper;
            ulong magnitudeLower = lower;
            if (negative)
            {
                magnitudeLower = ~lower + 1;
                magnitudeUpper = ~upper + (magnitudeLower == 0 ? 1UL : 0UL);
            }

            if (string.IsNullOrEmpty(format))
            {
                string text = UInt128.Decimal(magnitudeUpper, magnitudeLower);
                return negative ? "-" + text : text;
            }

            char letter = Specifier(format, out int digits);
            char upperLetter = (char)(letter & 0xFFDF);
            // R without a precision is G of every digit, which for an
            // integer is D (.NET's NumberToString).
            if (upperLetter == 'G' || upperLetter == 'R' ? digits < 1 : upperLetter == 'D')
            {
                string text = UInt128.Decimal(magnitudeUpper, magnitudeLower);
                if (digits > text.Length)
                {
                    text = new string('0', digits - text.Length) + text;
                }

                return negative ? "-" + text : text;
            }

            if (upperLetter == 'X')
            {
                return Bits(upper, lower, 4, letter == 'x' ? "0123456789abcdef" : "0123456789ABCDEF", digits);
            }

            if (upperLetter == 'B')
            {
                return Bits(upper, lower, 1, "01", digits);
            }

            string decimals = magnitudeUpper == 0 && magnitudeLower == 0 ? "" : UInt128.Decimal(magnitudeUpper, magnitudeLower);
            return Number.FormatDigits(decimals, negative, format!);
        }

        // Hexadecimal or binary: the significant digits of the 128 bits (at
        // least one), padded with zeros to `digits`.
        private static string Bits(ulong upper, ulong lower, int bitsPerDigit, string symbols, int digits)
        {
            int count = 128 / bitsPerDigit;
            int mask = (1 << bitsPerDigit) - 1;
            int significant = count;
            while (significant > 1 && Digit(upper, lower, significant - 1, bitsPerDigit, mask) == 0)
            {
                significant--;
            }

            int length = Math.Max(digits, significant);
            var text = new char[length];
            for (int index = 0; index < length; index++)
            {
                int position = length - 1 - index;
                text[index] = position >= count ? '0' : symbols[Digit(upper, lower, position, bitsPerDigit, mask)];
            }

            return new string(text);
        }

        private static int Digit(ulong upper, ulong lower, int position, int bitsPerDigit, int mask)
        {
            int shift = position * bitsPerDigit;
            return (int)((shift >= 64 ? upper >> (shift - 64) : lower >> shift) & (ulong)mask);
        }

        // The ASCII text a UTF-8 span starts with: what a partial parse can
        // read of it.
        internal static string AsciiPrefix(System.ReadOnlySpan<byte> utf8Text)
        {
            int ascii = 0;
            while (ascii < utf8Text.Length && utf8Text[ascii] < 0x80)
            {
                ascii++;
            }

            var chars = new char[ascii];
            for (int index = 0; index < ascii; index++)
            {
                chars[index] = (char)utf8Text[index];
            }

            return new string(chars);
        }

        // .NET's ParseBinaryInteger: the value, or its FormatException or
        // OverflowException.
        internal static bool Parse(string text, NumberStyles style, bool signed, out ulong upper, out ulong lower)
        {
            BigIntegerText.Validate(style);
            int status = TryParse(text, style, false, signed, out upper, out lower, out _);
            if (status == Failed)
            {
                throw new FormatException(SR.Format(SR.Format_InvalidStringWithValue, text));
            }

            if (status == Overflowed)
            {
                throw new OverflowException(signed ? SR.Overflow_Int128 : SR.Overflow_UInt128);
            }

            return true;
        }

        internal static bool ParseUtf8(System.ReadOnlySpan<byte> utf8Text, NumberStyles style, bool signed, out ulong upper, out ulong lower)
        {
            BigIntegerText.Validate(style);
            if (!Utf8Text.TryDecode(utf8Text, out string text))
            {
                throw new FormatException(SR.Format_InvalidString);
            }

            return Parse(text, style, signed, out upper, out lower);
        }

        // .NET's TryParseBinaryInteger over 128 bits, signed or not.
        internal static int TryParse(string text, NumberStyles style, bool partial, bool signed, out ulong upper, out ulong lower, out int consumed)
        {
            upper = 0;
            lower = 0;
            consumed = 0;
            int status;
            UInt128 value;
            if ((style & ~NumberStyles.Integer) == 0)
            {
                status = TryParseIntegerStyle(text, style, partial, signed, out value, out consumed);
            }
            else if ((style & NumberStyles.AllowHexSpecifier) != 0)
            {
                status = TryParseBits(text, style, partial, 4, out value, out consumed);
            }
            else if ((style & NumberStyles.AllowBinarySpecifier) != 0)
            {
                status = TryParseBits(text, style, partial, 1, out value, out consumed);
            }
            else
            {
                status = TryParseNumber(text, style, partial, signed, out value, out consumed);
            }

            if (status == Parsed)
            {
                upper = (ulong)(value >> 64);
                lower = (ulong)value;
            }
            else
            {
                consumed = 0;
            }

            return status;
        }

        private static bool IsDigit(char ch) => (uint)(ch - '0') <= 9;

        private static UInt128 MaxValueDiv10(bool signed) =>
            signed ? new UInt128(0x0CCC_CCCC_CCCC_CCCC, 0xCCCC_CCCC_CCCC_CCCC) : new UInt128(0x1999_9999_9999_9999, 0x9999_9999_9999_9999);

        // What .NET's parsers do once the number's characters end: trailing
        // whitespace where the style allows it, then trailing nulls; anything
        // else fails, but for a partial parse, which stops there. The index
        // past what was read, or -1.
        private static int Trailing(string text, int index, NumberStyles style, bool partial)
        {
            if (index < text.Length && NumberText.IsWhite(text[index]) && (style & NumberStyles.AllowTrailingWhite) != 0)
            {
                index++;
                while (index < text.Length && NumberText.IsWhite(text[index]))
                {
                    index++;
                }

                if (index == text.Length)
                {
                    return index;
                }
            }

            while (index < text.Length && text[index] == '\0')
            {
                index++;
            }

            return index == text.Length || partial ? index : -1;
        }

        // .NET's TryParseBinaryIntegerStyle: whitespace, a sign, digits.
        private static int TryParseIntegerStyle(string text, NumberStyles style, bool partial, bool signed, out UInt128 result, out int consumed)
        {
            result = default;
            consumed = 0;
            int index = 0;
            if (text.Length == 0)
            {
                return Failed;
            }

            if ((style & NumberStyles.AllowLeadingWhite) != 0)
            {
                while (index < text.Length && NumberText.IsWhite(text[index]))
                {
                    index++;
                }

                if (index == text.Length)
                {
                    return Failed;
                }
            }

            bool negative = false;
            if ((style & NumberStyles.AllowLeadingSign) != 0 && (text[index] == '-' || text[index] == '+'))
            {
                negative = text[index] == '-';
                index++;
                if (index == text.Length)
                {
                    return Failed;
                }
            }

            if (!IsDigit(text[index]))
            {
                return Failed;
            }

            bool overflow = !signed && negative;
            while (index < text.Length && text[index] == '0')
            {
                index++;
            }

            UInt128 answer = UInt128.Zero;
            int count = 0;
            UInt128 limit = MaxValueDiv10(signed);
            while (index < text.Length && IsDigit(text[index]))
            {
                uint digit = (uint)(text[index] - '0');
                count++;
                if (count == 39)
                {
                    // The digit that may overflow.
                    overflow |= signed ? answer > limit : answer > limit || (answer == limit && digit > 5);
                    answer = answer * 10 + digit;
                    if (signed)
                    {
                        overflow |= answer > (UInt128)Int128.MaxValue + (negative ? 1u : 0u);
                    }
                }
                else if (count > 39)
                {
                    overflow = true;
                }
                else
                {
                    answer = answer * 10 + digit;
                }

                index++;
            }

            if (count == 0 && !signed)
            {
                // Only zeros: -0 is zero.
                overflow = false;
            }

            int end = Trailing(text, index, style, partial);
            if (end < 0)
            {
                return Failed;
            }

            if (overflow)
            {
                return Overflowed;
            }

            result = signed && negative ? (UInt128)(-(Int128)answer) : answer;
            consumed = end;
            return Parsed;
        }

        // .NET's TryParseBinaryIntegerHexOrBinaryNumberStyle: whitespace and
        // the digits of the bits.
        private static int TryParseBits(string text, NumberStyles style, bool partial, int bitsPerDigit, out UInt128 result, out int consumed)
        {
            result = default;
            consumed = 0;
            int index = 0;
            if (text.Length == 0)
            {
                return Failed;
            }

            if ((style & NumberStyles.AllowLeadingWhite) != 0)
            {
                while (index < text.Length && NumberText.IsWhite(text[index]))
                {
                    index++;
                }

                if (index == text.Length)
                {
                    return Failed;
                }
            }

            if (DigitValue(text[index], bitsPerDigit) < 0)
            {
                return Failed;
            }

            while (index < text.Length && text[index] == '0')
            {
                index++;
            }

            UInt128 answer = UInt128.Zero;
            int count = 0;
            bool overflow = false;
            while (index < text.Length && DigitValue(text[index], bitsPerDigit) is int digit and >= 0)
            {
                if (++count > 128 / bitsPerDigit)
                {
                    overflow = true;
                }
                else
                {
                    answer = (answer << bitsPerDigit) | (uint)digit;
                }

                index++;
            }

            int end = Trailing(text, index, style, partial);
            if (end < 0)
            {
                return Failed;
            }

            if (overflow)
            {
                return Overflowed;
            }

            result = answer;
            consumed = end;
            return Parsed;
        }

        private static int DigitValue(char ch, int bitsPerDigit)
        {
            if ((uint)(ch - '0') <= (bitsPerDigit == 1 ? 1u : 9u))
            {
                return ch - '0';
            }

            if (bitsPerDigit == 4 && (uint)((ch | 0x20) - 'a') <= 'f' - 'a')
            {
                return (ch | 0x20) - 'a' + 10;
            }

            return -1;
        }

        // .NET's TryParseBinaryIntegerNumber: the number's digits, then
        // TryNumberBufferToBinaryInteger, which overflows where they are not
        // a whole number of the type's range.
        private static int TryParseNumber(string text, NumberStyles style, bool partial, bool signed, out UInt128 result, out int consumed)
        {
            result = default;
            if (!NumberText.Scan(text, style, partial, true, out char[] digits, out int digEnd, out int scale, out bool negative, out consumed))
            {
                return Failed;
            }

            if (scale > 39 || scale < digEnd || (!signed && negative))
            {
                return Overflowed;
            }

            UInt128 limit = MaxValueDiv10(signed);
            UInt128 n = UInt128.Zero;
            for (int index = 0; index < scale; index++)
            {
                if (n > limit)
                {
                    return Overflowed;
                }

                n *= 10;
                if (index < digEnd)
                {
                    UInt128 next = n + (uint)(digits[index] - '0');
                    if (!signed && next < n)
                    {
                        return Overflowed;
                    }

                    n = next;
                }
            }

            if (signed)
            {
                Int128 value = (Int128)n;
                if (negative)
                {
                    value = -value;
                    if (value > Int128.Zero)
                    {
                        return Overflowed;
                    }
                }
                else if (value < Int128.Zero)
                {
                    return Overflowed;
                }

                n = (UInt128)value;
            }

            result = n;
            return Parsed;
        }
    }
}
