// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// BigInteger's text and hash (docs/IMPORTER.md, "System.Runtime.Numerics as
// built"): its arithmetic is dotnet/runtime's (dotnet-runtime/BigInteger.cs
// and BigIntegerCalculator.*.cs), but .NET's formatting and parsing
// (Number.BigInteger.cs) write through pointers into pinned buffers and
// reinterpret spans of chars as spans of its UTF-16 and UTF-8 character
// structs, and its hash reads the limbs as bytes, none of which a GC heap
// has. These are .NET's algorithms over the limbs instead: the decimal
// digits by division by 10^9, hexadecimal and binary from the two's
// complement bytes, the other formats through the CoreLib's number
// formatting (runtime/Number.cs), and .NET's number parser
// (Number.Parsing.Common.cs's TryParseNumber) for the invariant culture.

namespace System.Numerics
{
    using System.Globalization;
    using BigIntegerText = Gameplay.Runtime.BigIntegerText;
    using Utf8Text = Gameplay.Runtime.Utf8Text;

    public readonly partial struct BigInteger
    {
        // The CLR's is HashCode's over the limbs' bytes (seeded per
        // process); this is HashCode's over the limbs.
        public override int GetHashCode()
        {
            if (_bits is null)
            {
                return _sign;
            }

            HashCode hash = default;
            foreach (nuint limb in _bits)
            {
                hash.Add((ulong)limb);
            }

            hash.Add(_sign);
            return hash.ToHashCode();
        }

        public override string ToString() => BigIntegerText.Format(this, null);

        public string ToString(IFormatProvider? provider) => BigIntegerText.Format(this, null);

        public string ToString(string? format) => BigIntegerText.Format(this, format);

        public string ToString(string? format, IFormatProvider? provider) => BigIntegerText.Format(this, format);

        public bool TryFormat(Span<char> destination, out int charsWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            BigIntegerText.TryCopy(BigIntegerText.Format(this, format.ToString()), destination, out charsWritten);

        public bool TryFormat(Span<byte> utf8Destination, out int bytesWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            BigIntegerText.TryCopyUtf8(BigIntegerText.Format(this, format.ToString()), utf8Destination, out bytesWritten);

        public static BigInteger Parse(string value) => Parse(value, NumberStyles.Integer, null);

        public static BigInteger Parse(string value, NumberStyles style) => Parse(value, style, null);

        public static BigInteger Parse(string value, IFormatProvider? provider) => Parse(value, NumberStyles.Integer, provider);

        public static BigInteger Parse(string value, NumberStyles style, IFormatProvider? provider)
        {
            ArgumentNullException.ThrowIfNull(value);
            return BigIntegerText.Parse(value, style);
        }

        public static BigInteger Parse(ReadOnlySpan<char> value, NumberStyles style = NumberStyles.Integer, IFormatProvider? provider = null) =>
            BigIntegerText.Parse(value.ToString(), style);

        public static BigInteger Parse(ReadOnlySpan<char> s, IFormatProvider? provider) => Parse(s, NumberStyles.Integer, provider);

        public static BigInteger Parse(ReadOnlySpan<byte> utf8Text, NumberStyles style = NumberStyles.Integer, IFormatProvider? provider = null) =>
            BigIntegerText.Parse(Utf8Text.Decode(utf8Text), style);

        public static BigInteger Parse(ReadOnlySpan<byte> utf8Text, IFormatProvider? provider) => Parse(utf8Text, NumberStyles.Integer, provider);

        public static bool TryParse(string? value, out BigInteger result) => TryParse(value, NumberStyles.Integer, null, out result);

        public static bool TryParse(string? s, IFormatProvider? provider, out BigInteger result) => TryParse(s, NumberStyles.Integer, provider, out result);

        public static bool TryParse(string? value, NumberStyles style, IFormatProvider? provider, out BigInteger result)
        {
            if (value is null)
            {
                BigIntegerText.Validate(style);
                result = default;
                return false;
            }

            return BigIntegerText.TryParse(value, style, false, out result, out _) == BigIntegerText.Parsed;
        }

        public static bool TryParse(ReadOnlySpan<char> value, out BigInteger result) => TryParse(value, NumberStyles.Integer, null, out result);

        public static bool TryParse(ReadOnlySpan<char> s, IFormatProvider? provider, out BigInteger result) => TryParse(s, NumberStyles.Integer, provider, out result);

        public static bool TryParse(ReadOnlySpan<char> value, NumberStyles style, IFormatProvider? provider, out BigInteger result) =>
            BigIntegerText.TryParse(value.ToString(), style, false, out result, out _) == BigIntegerText.Parsed;

        public static bool TryParse(ReadOnlySpan<byte> utf8Text, out BigInteger result) => TryParse(utf8Text, NumberStyles.Integer, null, out result);

        public static bool TryParse(ReadOnlySpan<byte> utf8Text, IFormatProvider? provider, out BigInteger result) =>
            TryParse(utf8Text, NumberStyles.Integer, provider, out result);

        public static bool TryParse(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out BigInteger result)
        {
            BigIntegerText.Validate(style);
            if (!Utf8Text.TryDecode(utf8Text, out string text))
            {
                result = default;
                return false;
            }

            return BigIntegerText.TryParse(text, style, false, out result, out _) == BigIntegerText.Parsed;
        }

        public static bool TryParsePartial(string? s, NumberStyles style, IFormatProvider? provider, out BigInteger result, out int charsConsumed)
        {
            BigIntegerText.Validate(style);
            return BigIntegerText.TryParse(s ?? "", style, true, out result, out charsConsumed) == BigIntegerText.Parsed;
        }

        public static bool TryParsePartial(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out BigInteger result, out int charsConsumed) =>
            BigIntegerText.TryParse(s.ToString(), style, true, out result, out charsConsumed) == BigIntegerText.Parsed;

        public static bool TryParsePartial(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out BigInteger result, out int bytesConsumed)
        {
            BigIntegerText.Validate(style);

            // What is consumed of ASCII text is what is consumed of its
            // chars; a partial parse stops at the first byte beyond it.
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

            return BigIntegerText.TryParse(new string(chars), style, true, out result, out bytesConsumed) == BigIntegerText.Parsed;
        }
    }
}

namespace Gameplay.Runtime
{
    using System;
    using System.Globalization;
    using System.Numerics;

    internal sealed class BigIntegerText
    {
        internal const int Parsed = 0;
        private const int Failed = 1;
        private const int Overflowed = 2;

        private const NumberStyles InvalidNumberStyles = ~(NumberStyles.AllowLeadingWhite | NumberStyles.AllowTrailingWhite
                                                           | NumberStyles.AllowLeadingSign | NumberStyles.AllowTrailingSign
                                                           | NumberStyles.AllowParentheses | NumberStyles.AllowDecimalPoint
                                                           | NumberStyles.AllowThousands | NumberStyles.AllowExponent
                                                           | NumberStyles.AllowCurrencySymbol | NumberStyles.AllowHexSpecifier
                                                           | NumberStyles.AllowBinarySpecifier);

        private const uint TenToTheNinth = 1000000000;

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

        internal static string Format(BigInteger value, string? format)
        {
            char letter = Specifier(format, out int digits);
            if (letter is 'x' or 'X')
            {
                return Hexadecimal(value, letter, digits);
            }

            if (letter is 'b' or 'B')
            {
                return Binary(value, digits);
            }

            if (value._bits is null)
            {
                if (letter is 'g' or 'G' or 'r' or 'R')
                {
                    format = digits > 0 ? "D" + digits.ToString() : "D";
                }

                return value._sign.ToString(format);
            }

            string decimals = Decimal(value._bits);
            bool negative = value._sign < 0;
            if (letter is 'g' or 'G' or 'd' or 'D' or 'r' or 'R')
            {
                int zeros = digits - decimals.Length;
                if (zeros <= 0)
                {
                    return negative ? "-" + decimals : decimals;
                }

                var padded = new char[(negative ? 1 : 0) + digits];
                int at = 0;
                if (negative)
                {
                    padded[at++] = '-';
                }

                while (zeros-- > 0)
                {
                    padded[at++] = '0';
                }

                for (int index = 0; index < decimals.Length; index++)
                {
                    padded[at++] = decimals[index];
                }

                return new string(padded);
            }

            return Number.FormatDigits(decimals, negative, format!);
        }

        // The magnitude's decimal digits: its limbs divided by 10^9 until
        // nothing is left, in 32-bit halves so that each step divides a
        // 64-bit number.
        private static string Decimal(nuint[] bits)
        {
            var work = new ulong[bits.Length];
            for (int index = 0; index < bits.Length; index++)
            {
                work[index] = bits[index];
            }

            // Each 64-bit limb is at most 20 decimal digits: three chunks.
            var chunks = new uint[bits.Length * 3 + 1];
            int count = 0;
            int length = work.Length;
            while (length > 0)
            {
                ulong remainder = 0;
                for (int index = length - 1; index >= 0; index--)
                {
                    ulong limb = work[index];
                    ulong high = (remainder << 32) | (limb >> 32);
                    ulong highQuotient = high / TenToTheNinth;
                    remainder = high - highQuotient * TenToTheNinth;
                    ulong low = (remainder << 32) | (limb & 0xFFFFFFFF);
                    ulong lowQuotient = low / TenToTheNinth;
                    remainder = low - lowQuotient * TenToTheNinth;
                    work[index] = (highQuotient << 32) | lowQuotient;
                }

                chunks[count++] = (uint)remainder;
                while (length > 0 && work[length - 1] == 0)
                {
                    length--;
                }
            }

            string top = chunks[count - 1].ToString();
            var text = new char[top.Length + (count - 1) * 9];
            int at = 0;
            for (int index = 0; index < top.Length; index++)
            {
                text[at++] = top[index];
            }

            for (int chunk = count - 2; chunk >= 0; chunk--)
            {
                uint part = chunks[chunk];
                for (int digit = 8; digit >= 0; digit--)
                {
                    text[at + digit] = (char)('0' + (int)(part % 10));
                    part /= 10;
                }

                at += 9;
            }

            return new string(text);
        }

        // .NET's FormatBigIntegerToHex: the two's complement bytes, most
        // significant first, the top nibble dropped where it only repeats
        // the sign.
        private static string Hexadecimal(BigInteger value, char format, int digits)
        {
            byte[] bytes = value.ToByteArray();
            var text = new System.Text.StringBuilder();
            int current = bytes.Length - 1;
            string hexValues = format == 'x' ? "0123456789abcdef" : "0123456789ABCDEF";
            if (current > -1)
            {
                bool clearHighF = false;
                byte head = bytes[current];
                if (head > 0xF7)
                {
                    head -= 0xF0;
                    clearHighF = true;
                }

                if (head < 0x08 || clearHighF)
                {
                    text.Append(hexValues[head & 0xF]);
                    current--;
                }
            }

            while (current > -1)
            {
                byte b = bytes[current--];
                text.Append(hexValues[b >> 4]);
                text.Append(hexValues[b & 0xF]);
            }

            if (digits > text.Length)
            {
                text.Insert(0, new string(value._sign >= 0 ? '0' : format == 'x' ? 'f' : 'F', digits - text.Length));
            }

            return text.ToString();
        }

        // .NET's FormatBigIntegerToBinary: the two's complement bits, from
        // the highest that differs from the sign's, one more for the sign.
        private static string Binary(BigInteger value, int digits)
        {
            byte[] bytes = value.ToByteArray();
            byte highByte = bytes[^1];
            int charsInHighByte = 9 - byte.LeadingZeroCount(value._sign >= 0 ? highByte : (byte)~highByte);
            long charCount = charsInHighByte + ((long)(bytes.Length - 1) << 3);
            if (charCount > Array.MaxLength)
            {
                throw new FormatException(SR.Format_TooLarge);
            }

            int charsForBits = (int)charCount;
            var text = new char[Math.Max(digits, charsForBits)];
            int at = 0;
            for (int index = charsForBits; index < digits; index++)
            {
                text[at++] = value._sign >= 0 ? '0' : '1';
            }

            for (int bit = charsInHighByte - 1; bit >= 0; bit--)
            {
                text[at++] = (char)('0' + ((highByte >> bit) & 1));
            }

            for (int index = bytes.Length - 2; index >= 0; index--)
            {
                for (int bit = 7; bit >= 0; bit--)
                {
                    text[at++] = (char)('0' + ((bytes[index] >> bit) & 1));
                }
            }

            return new string(text);
        }

        internal static bool TryCopy(string text, System.Span<char> destination, out int charsWritten)
        {
            if (text.Length > destination.Length)
            {
                charsWritten = 0;
                return false;
            }

            for (int index = 0; index < text.Length; index++)
            {
                destination[index] = text[index];
            }

            charsWritten = text.Length;
            return true;
        }

        internal static bool TryCopyUtf8(string text, System.Span<byte> destination, out int bytesWritten)
        {
            byte[] bytes = Utf8Text.Encode(text);
            if (bytes.Length > destination.Length)
            {
                bytesWritten = 0;
                return false;
            }

            for (int index = 0; index < bytes.Length; index++)
            {
                destination[index] = bytes[index];
            }

            bytesWritten = bytes.Length;
            return true;
        }

        // .NET's TryValidateParseStyleInteger.
        internal static void Validate(NumberStyles style)
        {
            if ((style & (InvalidNumberStyles | NumberStyles.AllowHexSpecifier | NumberStyles.AllowBinarySpecifier)) != 0
                && (style & ~NumberStyles.HexNumber) != 0
                && (style & ~NumberStyles.BinaryNumber) != 0)
            {
                throw new ArgumentException(
                    (style & InvalidNumberStyles) != 0 ? SR.Argument_InvalidNumberStyles : SR.Argument_InvalidHexBinaryStyle,
                    nameof(style));
            }
        }

        internal static BigInteger Parse(string text, NumberStyles style)
        {
            int status = TryParse(text, style, false, out BigInteger result, out _);
            if (status == Failed)
            {
                throw new FormatException(SR.Overflow_ParseBigInteger);
            }

            if (status == Overflowed)
            {
                throw new OverflowException(SR.Overflow_ParseBigInteger);
            }

            return result;
        }

        internal static int TryParse(string text, NumberStyles style, bool partial, out BigInteger result, out int consumed)
        {
            Validate(style);
            if ((style & NumberStyles.AllowHexSpecifier) != 0)
            {
                return TryParseBits(text, style, partial, 4, out result, out consumed);
            }

            if ((style & NumberStyles.AllowBinarySpecifier) != 0)
            {
                return TryParseBits(text, style, partial, 1, out result, out consumed);
            }

            return TryParseNumber(text, style, partial, out result, out consumed);
        }

        private static bool IsWhite(char ch) => ch == 0x20 || (uint)(ch - 0x09) <= 0x0D - 0x09;

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

        // .NET's TryParseBigIntegerHexOrBinaryNumberStyle: the digits are the
        // two's complement bits, the first digit's top bit the sign.
        private static int TryParseBits(string text, NumberStyles style, bool partial, int bitsPerDigit, out BigInteger result, out int consumed)
        {
            result = default;
            consumed = 0;
            int index = 0;
            if ((style & NumberStyles.AllowLeadingWhite) != 0)
            {
                while (index < text.Length && IsWhite(text[index]))
                {
                    index++;
                }
            }

            int start = index;
            int end = start;
            while (end < text.Length && DigitValue(text[end], bitsPerDigit) >= 0)
            {
                end++;
            }

            int trailing = end;
            if ((style & NumberStyles.AllowTrailingWhite) != 0)
            {
                while (trailing < text.Length && IsWhite(text[trailing]))
                {
                    trailing++;
                }
            }

            if ((trailing != text.Length && !partial) || end == start)
            {
                return Failed;
            }

            // The magnitude of the digits, then, for a negative number, its
            // value less 2^bits.
            BigInteger value = BigInteger.Zero;
            for (int at = start; at < end; at++)
            {
                value = (value << bitsPerDigit) + DigitValue(text[at], bitsPerDigit);
            }

            bool negative = (DigitValue(text[start], bitsPerDigit) >> (bitsPerDigit - 1)) != 0;
            if (negative)
            {
                value -= BigInteger.One << ((end - start) * bitsPerDigit);
            }

            result = value;
            consumed = trailing;
            return Parsed;
        }

        // .NET's TryParseNumber (NumberText.Scan), then NumberToBigInteger:
        // digits after a decimal point or an exponent's must be zeros.
        private static int TryParseNumber(string text, NumberStyles styles, bool partial, out BigInteger result, out int consumed)
        {
            result = default;
            if (!NumberText.Scan(text, styles, partial, true, out char[] digits, out int digEnd, out int scale, out bool negative, out consumed))
            {
                consumed = 0;
                return Failed;
            }

            // NumberToBigInteger.
            if (scale == int.MaxValue)
            {
                consumed = 0;
                return Overflowed;
            }

            if (scale < 0 || digEnd > scale)
            {
                consumed = 0;
                return Failed;
            }

            BigInteger value = BigInteger.Zero;
            int at = 0;
            while (at < digEnd)
            {
                int take = Math.Min(18, digEnd - at);
                long chunk = 0;
                long power = 1;
                for (int index = 0; index < take; index++)
                {
                    chunk = chunk * 10 + (digits[at + index] - '0');
                    power *= 10;
                }

                value = value * power + chunk;
                at += take;
            }

            if (scale > digEnd && !value.IsZero)
            {
                value *= BigInteger.Pow(10, scale - digEnd);
            }

            result = negative ? -value : value;
            return Parsed;
        }
    }

    // UTF-8 for the IUtf8SpanFormattable and IUtf8SpanParsable members:
    // what number text holds, which is never a lone surrogate.
    internal sealed class Utf8Text
    {
        internal static byte[] Encode(string text)
        {
            int length = 0;
            for (int index = 0; index < text.Length; index++)
            {
                char c = text[index];
                length += c < 0x80 ? 1 : c < 0x800 ? 2 : char.IsHighSurrogate(c) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]) ? 2 : 3;
            }

            var bytes = new byte[length];
            int at = 0;
            for (int index = 0; index < text.Length; index++)
            {
                int c = text[index];
                if (char.IsHighSurrogate((char)c) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
                {
                    c = char.ConvertToUtf32((char)c, text[++index]);
                }
                else if ((uint)(c - 0xD800) < 0x800)
                {
                    c = 0xFFFD;
                }

                if (c < 0x80)
                {
                    bytes[at++] = (byte)c;
                }
                else if (c < 0x800)
                {
                    bytes[at++] = (byte)(0xC0 | (c >> 6));
                    bytes[at++] = (byte)(0x80 | (c & 0x3F));
                }
                else if (c < 0x10000)
                {
                    bytes[at++] = (byte)(0xE0 | (c >> 12));
                    bytes[at++] = (byte)(0x80 | ((c >> 6) & 0x3F));
                    bytes[at++] = (byte)(0x80 | (c & 0x3F));
                }
                else
                {
                    bytes[at++] = (byte)(0xF0 | (c >> 18));
                    bytes[at++] = (byte)(0x80 | ((c >> 12) & 0x3F));
                    bytes[at++] = (byte)(0x80 | ((c >> 6) & 0x3F));
                    bytes[at++] = (byte)(0x80 | (c & 0x3F));
                }
            }

            return bytes;
        }

        internal static bool TryDecode(System.ReadOnlySpan<byte> bytes, out string text)
        {
            var chars = new char[bytes.Length];
            int count = 0;
            int index = 0;
            while (index < bytes.Length)
            {
                int b = bytes[index];
                int length = b < 0x80 ? 1 : (b & 0xE0) == 0xC0 ? 2 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xF8) == 0xF0 ? 4 : 0;
                if (length == 0 || index + length > bytes.Length)
                {
                    text = "";
                    return false;
                }

                int c = length == 1 ? b : b & (0x7F >> length);
                for (int more = 1; more < length; more++)
                {
                    int next = bytes[index + more];
                    if ((next & 0xC0) != 0x80)
                    {
                        text = "";
                        return false;
                    }

                    c = (c << 6) | (next & 0x3F);
                }

                if (c >= 0x10000)
                {
                    chars[count++] = (char)(0xD800 + ((c - 0x10000) >> 10));
                    chars[count++] = (char)(0xDC00 + ((c - 0x10000) & 0x3FF));
                }
                else
                {
                    chars[count++] = (char)c;
                }

                index += length;
            }

            text = new string(chars, 0, count);
            return true;
        }

        internal static string Decode(System.ReadOnlySpan<byte> bytes) =>
            TryDecode(bytes, out string text) ? text : throw new FormatException(SR.Overflow_ParseBigInteger);
    }
}

namespace System.Numerics
{
    internal static partial class BigIntegerCalculator
    {
        // SwapUpperAndLower over the first wordCount 32-bit words of the
        // limbs, least significant first (dotnet/runtime's reinterprets the
        // limbs as words; BigInteger.cs.patch calls this instead).
        internal static void SwapUpperAndLowerWords(Span<nuint> limbs, int wordCount, int lowerLength)
        {
            var words = new uint[wordCount];
            for (int index = 0; index < wordCount; index++)
            {
                words[index] = (uint)((ulong)limbs[index >> 1] >> ((index & 1) * 32));
            }

            SwapUpperAndLower(words, lowerLength);
            for (int index = 0; index < wordCount; index++)
            {
                int shift = (index & 1) * 32;
                limbs[index >> 1] = (nuint)(((ulong)limbs[index >> 1] & ~(0xFFFFFFFFUL << shift)) | ((ulong)words[index] << shift));
            }
        }
    }
}

namespace System.Buffers.Binary
{
    // What dotnet/runtime's BigInteger writes with (the CoreLib's own, not
    // .NET's API).
    internal static partial class BinaryPrimitives
    {
        internal static void WriteUIntPtrLittleEndian(Span<byte> destination, nuint value)
        {
            if (destination.Length < 8)
            {
                throw new ArgumentOutOfRangeException(nameof(destination));
            }

            for (int index = 0; index < 8; index++)
            {
                destination[index] = (byte)((ulong)value >> (index * 8));
            }
        }

        internal static void WriteUIntPtrBigEndian(Span<byte> destination, nuint value)
        {
            if (destination.Length < 8)
            {
                throw new ArgumentOutOfRangeException(nameof(destination));
            }

            for (int index = 0; index < 8; index++)
            {
                destination[7 - index] = (byte)((ulong)value >> (index * 8));
            }
        }

        internal static void WriteIntPtrLittleEndian(Span<byte> destination, nint value) => WriteUIntPtrLittleEndian(destination, (nuint)value);

        internal static void WriteIntPtrBigEndian(Span<byte> destination, nint value) => WriteUIntPtrBigEndian(destination, (nuint)value);

        internal static nuint ReverseEndianness(nuint value)
        {
            ulong bits = value;
            ulong reversed = 0;
            for (int index = 0; index < 8; index++)
            {
                reversed = (reversed << 8) | ((bits >> (index * 8)) & 0xFF);
            }

            return (nuint)reversed;
        }

        internal static void ReverseEndianness(ReadOnlySpan<nuint> source, Span<nuint> destination)
        {
            for (int index = 0; index < source.Length; index++)
            {
                destination[index] = ReverseEndianness(source[index]);
            }
        }
    }
}
