// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Number formatting, as the CLR's does it with the invariant culture:
// ToString with no format, standard formats (C, D, E, F, G, N, P, R, X)
// and custom formats ("0.00", "#,##0", "0.###E+0", sections), for the
// integer types, float and double. Floating-point values print the CLR's
// digits exactly: the shortest that round-trip for the default and R
// formats, and the exactly rounded digits for a precision, from the same
// Dragon4 algorithm .NET falls back on (its Grisu fast path yields the same
// digits whenever it succeeds). Compiled into a module only where code
// formats numbers.

namespace Gameplay.Runtime
{
    // A string being built.
    internal sealed class TextBuilder
    {
        private char[] chars = new char[16];
        private int length;

        public int Length => length;

        public void Append(char value)
        {
            if (length == chars.Length)
            {
                var larger = new char[chars.Length * 2];
                for (int index = 0; index < length; index++)
                {
                    larger[index] = chars[index];
                }

                chars = larger;
            }

            chars[length] = value;
            length++;
        }

        public void Append(char value, int count)
        {
            for (int index = 0; index < count; index++)
            {
                Append(value);
            }
        }

        public void Append(string text)
        {
            if (text is null)
            {
                return;
            }

            for (int index = 0; index < text.Length; index++)
            {
                Append(text[index]);
            }
        }

        public void InsertFront(string text)
        {
            var old = chars;
            int oldLength = length;
            chars = new char[oldLength + text.Length + 16];
            length = 0;
            Append(text);
            for (int index = 0; index < oldLength; index++)
            {
                Append(old[index]);
            }
        }

        public string Text()
        {
            var result = StringIntrinsics.Allocate(length);
            for (int index = 0; index < length; index++)
            {
                StringIntrinsics.Set(result, index, chars[index]);
            }

            return result;
        }
    }

    // An unsigned integer of 32-bit limbs, least significant first.
    internal sealed class Big
    {
        private uint[] limbs = new uint[4];
        private int length;

        public bool IsZero => length == 0;

        private void Reserve(int count)
        {
            if (count <= limbs.Length)
            {
                return;
            }

            int size = limbs.Length;
            while (size < count)
            {
                size *= 2;
            }

            var larger = new uint[size];
            for (int index = 0; index < length; index++)
            {
                larger[index] = limbs[index];
            }

            limbs = larger;
        }

        public void Set(ulong value)
        {
            length = 0;
            Reserve(2);
            while (value != 0)
            {
                limbs[length] = (uint)value;
                length++;
                value >>= 32;
            }
        }

        public void CopyFrom(Big other)
        {
            Reserve(other.length);
            for (int index = 0; index < other.length; index++)
            {
                limbs[index] = other.limbs[index];
            }

            length = other.length;
        }

        public void MultiplySmall(uint factor)
        {
            ulong carry = 0;
            for (int index = 0; index < length; index++)
            {
                ulong product = (ulong)limbs[index] * factor + carry;
                limbs[index] = (uint)product;
                carry = product >> 32;
            }

            if (carry != 0)
            {
                Reserve(length + 1);
                limbs[length] = (uint)carry;
                length++;
            }
        }

        public void MultiplyPow10(int power)
        {
            while (power >= 9)
            {
                MultiplySmall(1000000000);
                power -= 9;
            }

            uint factor = 1;
            while (power > 0)
            {
                factor *= 10;
                power--;
            }

            if (factor != 1)
            {
                MultiplySmall(factor);
            }
        }

        public void ShiftLeft(int bits)
        {
            if (length == 0 || bits == 0)
            {
                return;
            }

            int words = bits / 32;
            int shift = bits % 32;
            Reserve(length + words + 1);
            if (shift == 0)
            {
                for (int index = length - 1; index >= 0; index--)
                {
                    limbs[index + words] = limbs[index];
                }
            }
            else
            {
                limbs[length + words] = 0;
                for (int index = length - 1; index >= 0; index--)
                {
                    limbs[index + words + 1] |= limbs[index] >> (32 - shift);
                    limbs[index + words] = limbs[index] << shift;
                }
            }

            for (int index = 0; index < words; index++)
            {
                limbs[index] = 0;
            }

            length += words + 1;
            Trim();
        }

        private void Trim()
        {
            while (length > 0 && limbs[length - 1] == 0)
            {
                length--;
            }
        }

        // this += other.
        public void Add(Big other)
        {
            int longer = length > other.length ? length : other.length;
            Reserve(longer + 1);
            for (int index = length; index <= longer; index++)
            {
                limbs[index] = 0;
            }

            ulong carry = 0;
            for (int index = 0; index < longer; index++)
            {
                ulong sum = (ulong)limbs[index] + (index < other.length ? other.limbs[index] : 0u) + carry;
                limbs[index] = (uint)sum;
                carry = sum >> 32;
            }

            limbs[longer] = (uint)carry;
            length = longer + 1;
            Trim();
        }

        // this -= other, which is no larger.
        public void Subtract(Big other)
        {
            long borrow = 0;
            for (int index = 0; index < length; index++)
            {
                long difference = (long)limbs[index] - (index < other.length ? other.limbs[index] : 0u) - borrow;
                borrow = difference < 0 ? 1 : 0;
                limbs[index] = (uint)(difference + (borrow << 32));
            }

            Trim();
        }

        public static int Compare(Big left, Big right)
        {
            if (left.length != right.length)
            {
                return left.length > right.length ? 1 : -1;
            }

            for (int index = left.length - 1; index >= 0; index--)
            {
                if (left.limbs[index] != right.limbs[index])
                {
                    return left.limbs[index] > right.limbs[index] ? 1 : -1;
                }
            }

            return 0;
        }

        public int BitLength
        {
            get
            {
                if (length == 0)
                {
                    return 0;
                }

                int bits = 32 * (length - 1);
                uint top = limbs[length - 1];
                while (top != 0)
                {
                    bits++;
                    top >>= 1;
                }

                return bits;
            }
        }

        public bool Bit(int index) =>
            index / 32 < length && ((limbs[index / 32] >> (index % 32)) & 1) != 0;

        // Whether any bit beneath index is set.
        public bool AnyBelow(int index)
        {
            for (int word = 0; word < length && 32 * word < index; word++)
            {
                uint mask = index - 32 * word >= 32 ? 0xFFFFFFFFu : (1u << (index - 32 * word)) - 1;
                if ((limbs[word] & mask) != 0)
                {
                    return true;
                }
            }

            return false;
        }

        public void ShiftRight(int bits)
        {
            int words = bits / 32;
            int shift = bits % 32;
            if (words >= length)
            {
                length = 0;
                return;
            }

            for (int index = 0; index < length - words; index++)
            {
                uint word = limbs[index + words] >> shift;
                if (shift != 0 && index + words + 1 < length)
                {
                    word |= limbs[index + words + 1] << (32 - shift);
                }

                limbs[index] = word;
            }

            length -= words;
            Trim();
        }

        public void AddSmall(uint value)
        {
            var small = new Big();
            small.Set(value);
            Add(small);
        }

        public void Increment()
        {
            var one = new Big();
            one.Set(1);
            Add(one);
        }

        // The value, when it fits 64 bits.
        public bool TryGetUInt64(out ulong value)
        {
            value = 0;
            if (length > 2)
            {
                return false;
            }

            for (int index = length - 1; index >= 0; index--)
            {
                value = (value << 32) | limbs[index];
            }

            return true;
        }

        // The quotient, at most 9, of this by divisor; this keeps the rest.
        public uint DivideSmallQuotient(Big divisor)
        {
            uint quotient = 0;
            while (Compare(this, divisor) >= 0)
            {
                Subtract(divisor);
                quotient++;
            }

            return quotient;
        }
    }

    // A number's decimal digits (0 to 9), value 0.d1d2... * 10^Scale.
    internal sealed class NumberBuffer
    {
        public byte[] Digits = new byte[32];
        public int Count;
        public int Scale;
        public bool Negative;
        public bool Floating;

        public void Add(int digit)
        {
            if (Count == Digits.Length)
            {
                var larger = new byte[Digits.Length * 2];
                for (int index = 0; index < Count; index++)
                {
                    larger[index] = Digits[index];
                }

                Digits = larger;
            }

            Digits[Count] = (byte)digit;
            Count++;
        }

        // The digit at a position, '\0' as in the CLR's buffer past the end.
        public char At(int index) => index < Count ? (char)('0' + Digits[index]) : '\0';
    }

    internal static class Number
    {
        private const double Log10V2 = 0.30102999566398119521373889472449;

        // Dragon4, as .NET's: the digits of mantissa * 2^exponent, the
        // shortest that distinguish it (cutoff -1), or cut off at a number
        // of significant or fractional digits, correctly rounded (to even
        // on a tie).
        private static void Dragon4(
            ulong mantissa, int exponent, int highBit, bool unequalMargins, int cutoff, bool significant, NumberBuffer number)
        {
            var scale = new Big();
            var value = new Big();
            var marginLow = new Big();
            var marginHigh = new Big();
            if (unequalMargins)
            {
                if (exponent > 0)
                {
                    value.Set(4 * mantissa);
                    value.ShiftLeft(exponent);
                    scale.Set(4);
                    marginLow.Set(1);
                    marginLow.ShiftLeft(exponent);
                    marginHigh.Set(1);
                    marginHigh.ShiftLeft(exponent + 1);
                }
                else
                {
                    value.Set(4 * mantissa);
                    scale.Set(1);
                    scale.ShiftLeft(-exponent + 2);
                    marginLow.Set(1);
                    marginHigh.Set(2);
                }
            }
            else
            {
                if (exponent > 0)
                {
                    value.Set(2 * mantissa);
                    value.ShiftLeft(exponent);
                    scale.Set(2);
                    marginLow.Set(1);
                    marginLow.ShiftLeft(exponent);
                }
                else
                {
                    value.Set(2 * mantissa);
                    scale.Set(1);
                    scale.ShiftLeft(-exponent + 1);
                    marginLow.Set(1);
                }

                marginHigh.CopyFrom(marginLow);
            }

            int digitExponent = (int)Ceiling((highBit + exponent) * Log10V2 - 0.69);
            if (digitExponent > 0)
            {
                scale.MultiplyPow10(digitExponent);
            }
            else if (digitExponent < 0)
            {
                value.MultiplyPow10(-digitExponent);
                marginLow.MultiplyPow10(-digitExponent);
                if (unequalMargins)
                {
                    marginHigh.CopyFrom(marginLow);
                    marginHigh.ShiftLeft(1);
                }
                else
                {
                    marginHigh.CopyFrom(marginLow);
                }
            }

            bool even = (mantissa & 1) == 0;
            bool tooLow;
            var high = new Big();
            if (cutoff == -1)
            {
                high.CopyFrom(value);
                high.Add(marginHigh);
                int compareHigh = Big.Compare(high, scale);
                tooLow = even ? compareHigh >= 0 : compareHigh > 0;
            }
            else
            {
                tooLow = Big.Compare(value, scale) >= 0;
            }

            if (tooLow)
            {
                digitExponent++;
            }
            else
            {
                value.MultiplySmall(10);
                marginLow.MultiplySmall(10);
                marginHigh.CopyFrom(marginLow);
                if (unequalMargins)
                {
                    marginHigh.ShiftLeft(1);
                }
            }

            int cutoffExponent = digitExponent - 1000;
            if (cutoff != -1)
            {
                int desired = significant ? digitExponent - cutoff : -cutoff;
                if (desired > cutoffExponent)
                {
                    cutoffExponent = desired;
                }
            }

            int decimalExponent = --digitExponent;
            bool low = false;
            bool highOk = false;
            uint digit;
            if (cutoff == -1)
            {
                while (true)
                {
                    digit = value.DivideSmallQuotient(scale);
                    high.CopyFrom(value);
                    high.Add(marginHigh);
                    int compareLow = Big.Compare(value, marginLow);
                    int compareHigh = Big.Compare(high, scale);
                    if (even)
                    {
                        low = compareLow <= 0;
                        highOk = compareHigh >= 0;
                    }
                    else
                    {
                        low = compareLow < 0;
                        highOk = compareHigh > 0;
                    }

                    if (low || highOk || digitExponent == cutoffExponent)
                    {
                        break;
                    }

                    number.Add((int)digit);
                    value.MultiplySmall(10);
                    marginLow.MultiplySmall(10);
                    marginHigh.CopyFrom(marginLow);
                    if (unequalMargins)
                    {
                        marginHigh.ShiftLeft(1);
                    }

                    digitExponent--;
                }
            }
            else if (digitExponent >= cutoffExponent)
            {
                while (true)
                {
                    digit = value.DivideSmallQuotient(scale);
                    if (value.IsZero || digitExponent <= cutoffExponent)
                    {
                        break;
                    }

                    number.Add((int)digit);
                    value.MultiplySmall(10);
                    digitExponent--;
                }
            }
            else
            {
                // The first significant digit is past the cutoff: it rounds.
                digit = value.DivideSmallQuotient(scale);
                if (digit > 5 || (digit == 5 && !value.IsZero))
                {
                    decimalExponent++;
                    digit = 1;
                }

                number.Add((int)digit);
                number.Scale = decimalExponent + 1;
                return;
            }

            bool roundDown = low;
            if (low == highOk)
            {
                value.ShiftLeft(1);
                int compare = Big.Compare(value, scale);
                roundDown = compare < 0;
                if (compare == 0)
                {
                    roundDown = (digit & 1) == 0;
                }
            }

            if (roundDown)
            {
                number.Add((int)digit);
            }
            else if (digit == 9)
            {
                while (true)
                {
                    if (number.Count == 0)
                    {
                        number.Add(1);
                        decimalExponent++;
                        break;
                    }

                    number.Count--;
                    if (number.Digits[number.Count] != 9)
                    {
                        number.Digits[number.Count]++;
                        number.Count++;
                        break;
                    }
                }
            }
            else
            {
                number.Add((int)digit + 1);
            }

            number.Scale = decimalExponent + 1;
        }

        private static double Ceiling(double value)
        {
            long truncated = (long)value;
            return truncated < value ? truncated + 1 : truncated;
        }

        private static int HighBit(ulong value)
        {
            int bit = 63;
            while (bit > 0 && (value >> bit) == 0)
            {
                bit--;
            }

            return bit;
        }

        private static void DoubleDigits(double value, int precision, bool significant, NumberBuffer number)
        {
            long bits = System.BitConverter.DoubleToInt64Bits(value);
            ulong mantissa = (ulong)bits & 0xFFFFFFFFFFFFFUL;
            int biased = (int)((bits >> 52) & 0x7FF);
            int exponent;
            if (biased != 0)
            {
                mantissa |= 1UL << 52;
                exponent = biased - 1075;
            }
            else
            {
                exponent = -1074;
            }

            bool unequal = mantissa == 1UL << 52;
            Dragon4(mantissa, exponent, HighBit(mantissa), unequal, precision, significant, number);
        }

        private static void SingleDigits(float value, int precision, bool significant, NumberBuffer number)
        {
            int bits = System.BitConverter.SingleToInt32Bits(value);
            ulong mantissa = (ulong)(bits & 0x7FFFFF);
            int biased = (bits >> 23) & 0xFF;
            int exponent;
            if (biased != 0)
            {
                mantissa |= 1UL << 23;
                exponent = biased - 150;
            }
            else
            {
                exponent = -149;
            }

            bool unequal = mantissa == 1UL << 23;
            Dragon4(mantissa, exponent, HighBit(mantissa), unequal, precision, significant, number);
        }

        private static void HalfDigits(ushort bits, int precision, bool significant, NumberBuffer number)
        {
            ulong mantissa = (ulong)(bits & 0x3FF);
            int biased = (bits >> 10) & 0x1F;
            int exponent;
            if (biased != 0)
            {
                mantissa |= 1UL << 10;
                exponent = biased - 25;
            }
            else
            {
                exponent = -24;
            }

            bool unequal = mantissa == 1UL << 10;
            Dragon4(mantissa, exponent, HighBit(mantissa), unequal, precision, significant, number);
        }

        // The standard format's letter and precision (-1 for none), or 0 for
        // a custom format.
        private static char ParseFormat(string format, out int precision)
        {
            precision = -1;
            if (format is null || format.Length == 0)
            {
                return 'G';
            }

            char letter = format[0];
            if (!((letter >= 'a' && letter <= 'z') || (letter >= 'A' && letter <= 'Z')))
            {
                return '\0';
            }

            if (format.Length == 1)
            {
                return letter;
            }

            int value = 0;
            for (int index = 1; index < format.Length; index++)
            {
                char c = format[index];
                if (c < '0' || c > '9' || value > 99999999)
                {
                    return '\0';
                }

                value = value * 10 + (c - '0');
            }

            precision = value;
            return letter;
        }

        private static void BadFormat() => throw new System.FormatException();

        public static string FormatDouble(double value, string format)
        {
            char letter = ParseFormat(format, out int precision);
            bool isDefault = format is null || format.Length == 0;
            if (value != value)
            {
                return "NaN";
            }

            if (value == double.PositiveInfinity)
            {
                return "Infinity";
            }

            if (value == double.NegativeInfinity)
            {
                return "-Infinity";
            }

            if ((letter | 0x20) == 'x')
            {
                long bits = System.BitConverter.DoubleToInt64Bits(value);
                return FormatHexFloat((ulong)bits & 0xFFFFFFFFFFFFFUL, (int)((bits >> 52) & 0x7FF), 52, 1023, bits < 0, letter, precision);
            }

            var number = new NumberBuffer();
            number.Floating = true;
            number.Negative = System.BitConverter.DoubleToInt64Bits(value) < 0;
            int maxDigits = FloatingPrecision(letter, ref precision, out bool significant, 15);
            if (value != 0)
            {
                DoubleDigits(value, precision, significant, number);
            }

            if (letter == '\0')
            {
                return FormatCustom(number, format);
            }

            if (precision == -1)
            {
                maxDigits = number.Count > 17 ? number.Count : 17;
            }

            return FormatStandard(number, isDefault ? 'G' : letter, maxDigits);
        }

        public static string FormatSingle(float value, string format)
        {
            char letter = ParseFormat(format, out int precision);
            bool isDefault = format is null || format.Length == 0;
            if (value != value)
            {
                return "NaN";
            }

            if (value == float.PositiveInfinity)
            {
                return "Infinity";
            }

            if (value == float.NegativeInfinity)
            {
                return "-Infinity";
            }

            if ((letter | 0x20) == 'x')
            {
                int bits = System.BitConverter.SingleToInt32Bits(value);
                return FormatHexFloat((ulong)(bits & 0x7FFFFF), (bits >> 23) & 0xFF, 23, 127, bits < 0, letter, precision);
            }

            var number = new NumberBuffer();
            number.Floating = true;
            number.Negative = System.BitConverter.SingleToInt32Bits(value) < 0;
            int maxDigits = FloatingPrecision(letter, ref precision, out bool significant, 7);
            if (value != 0)
            {
                SingleDigits(value, precision, significant, number);
            }

            if (letter == '\0')
            {
                return FormatCustom(number, format);
            }

            if (precision == -1)
            {
                maxDigits = number.Count > 9 ? number.Count : 9;
            }

            return FormatStandard(number, isDefault ? 'G' : letter, maxDigits);
        }

        // .NET 11's X format of a finite binary floating-point value
        // (FormatFloatingPointAsHex): [-]0x1.hhhp+e, the significand's
        // hexadecimal digits after the leading 1 (a subnormal's normalized),
        // all of them trimmed of trailing zeros without a precision, else
        // rounded to it (to even) or padded; 0x0p+0 for a zero.
        private static string FormatHexFloat(ulong trailing, int biased, int mantissaBits, int bias, bool negative, char format, int precision)
        {
            var text = new TextBuilder();
            if (negative)
            {
                text.Append('-');
            }

            text.Append('0');
            text.Append(format);
            char exponentLetter = format == 'X' ? 'P' : 'p';
            string digits = format == 'X' ? "0123456789ABCDEF" : "0123456789abcdef";
            if (biased == 0 && trailing == 0)
            {
                text.Append('0');
                if (precision > 0)
                {
                    text.Append('.');
                    text.Append('0', precision);
                }

                text.Append(exponentLetter);
                text.Append('+');
                text.Append('0');
                return text.Text();
            }

            ulong fraction = biased == 0 ? trailing : trailing | (1UL << mantissaBits);
            int exponent = biased == 0 ? 1 - bias - mantissaBits : biased - bias - mantissaBits;
            if (fraction < (1UL << mantissaBits))
            {
                // A subnormal: the leading 1 moved up to the implicit bit.
                int shift = 0;
                while ((fraction << shift) < (1UL << mantissaBits))
                {
                    shift++;
                }

                fraction <<= shift;
                exponent -= shift;
            }

            int actualExponent = exponent + mantissaBits;
            ulong significandBits = fraction & ((1UL << mantissaBits) - 1);
            int leadingDigit = 1;
            int defaultHexDigits = (mantissaBits + 3) / 4;
            if (precision == 0)
            {
                ulong half = 1UL << (mantissaBits - 1);
                if (significandBits > half || (significandBits == half && (leadingDigit & 1) != 0))
                {
                    leadingDigit++;
                }

                significandBits = 0;
            }

            text.Append((char)('0' + leadingDigit));
            if (precision > 0)
            {
                ulong shifted;
                if (precision < defaultHexDigits)
                {
                    int bitsToKeep = precision * 4;
                    int bitsToDiscard = mantissaBits - bitsToKeep;
                    ulong roundBit = 1UL << (bitsToDiscard - 1);
                    ulong discardedBits = significandBits & ((1UL << bitsToDiscard) - 1);
                    bool roundUp = discardedBits > roundBit || (discardedBits == roundBit && ((significandBits >> bitsToDiscard) & 1) != 0);
                    if (roundUp)
                    {
                        significandBits = (significandBits >> bitsToDiscard) + 1;
                        if (significandBits >= (1UL << bitsToKeep))
                        {
                            significandBits = 0;
                            actualExponent++;
                        }
                    }
                    else
                    {
                        significandBits >>= bitsToDiscard;
                    }

                    shifted = significandBits << (64 - bitsToKeep);
                }
                else
                {
                    shifted = significandBits << (64 - mantissaBits);
                }

                text.Append('.');
                int realDigits = precision < defaultHexDigits ? precision : defaultHexDigits;
                for (int index = 0; index < realDigits; index++)
                {
                    text.Append(digits[(int)(shifted >> 60)]);
                    shifted <<= 4;
                }

                text.Append('0', precision - realDigits);
            }
            else if (precision < 0 && significandBits != 0)
            {
                ulong nibbleAligned = significandBits << (defaultHexDigits * 4 - mantissaBits);
                int trailingZeroBits = 0;
                while (((nibbleAligned >> trailingZeroBits) & 1) == 0)
                {
                    trailingZeroBits++;
                }

                int trimmedDigits = defaultHexDigits - (trailingZeroBits / 4);
                if (trimmedDigits > 0)
                {
                    text.Append('.');
                    ulong shifted = significandBits << (64 - mantissaBits);
                    for (int index = 0; index < trimmedDigits; index++)
                    {
                        text.Append(digits[(int)(shifted >> 60)]);
                        shifted <<= 4;
                    }
                }
            }

            text.Append(exponentLetter);
            text.Append(actualExponent >= 0 ? '+' : '-');
            text.Append(Strings.FromUInt64((ulong)(actualExponent >= 0 ? actualExponent : -actualExponent)));
            return text.Text();
        }

        // A Half, given by its bits (dotnet/runtime's Half.cs, whose text is
        // .NET's FormatFloat over it): as FormatSingle, with Half's precision
        // for custom formats and its shortest round-trip digits (5).
        public static string FormatHalf(ushort bits, string format)
        {
            char letter = ParseFormat(format, out int precision);
            bool isDefault = format is null || format.Length == 0;
            if ((bits & 0x7FFF) > 0x7C00)
            {
                return "NaN";
            }

            if ((bits & 0x7FFF) == 0x7C00)
            {
                return (bits & 0x8000) != 0 ? "-Infinity" : "Infinity";
            }

            if ((letter | 0x20) == 'x')
            {
                return FormatHexFloat((ulong)(bits & 0x3FF), (bits >> 10) & 0x1F, 10, 15, (bits & 0x8000) != 0, letter, precision);
            }

            var number = new NumberBuffer();
            number.Floating = true;
            number.Negative = (bits & 0x8000) != 0;
            int maxDigits = FloatingPrecision(letter, ref precision, out bool significant, 5);
            if ((bits & 0x7FFF) != 0)
            {
                HalfDigits(bits, precision, significant, number);
            }

            if (letter == '\0')
            {
                return FormatCustom(number, format);
            }

            if (precision == -1)
            {
                maxDigits = number.Count > 5 ? number.Count : 5;
            }

            return FormatStandard(number, isDefault ? 'G' : letter, maxDigits);
        }

        // A decimal: its digits as .NET's DecimalToNumber has them, the
        // trailing zeros of its scale included, which the G format without
        // a precision (and R) prints unrounded, never in scientific
        // notation, as ECMA has it.
        public static string FormatDecimal(Decimal value, string format)
        {
            char letter = ParseFormat(format, out int precision);
            var number = new NumberBuffer();
            number.Negative = Decimal.IsNegative(value);
            uint high = value.High;
            uint mid = value.Mid;
            uint low = value.Low;
            var buffer = new byte[29];
            int start = 29;
            while ((mid | high) != 0)
            {
                uint chunk = DecCalc.DecDivMod1E9(ref high, ref mid, ref low);
                for (int digit = 0; digit < 9; digit++)
                {
                    buffer[--start] = (byte)(chunk % 10);
                    chunk /= 10;
                }
            }

            for (; low != 0; low /= 10)
            {
                buffer[--start] = (byte)(low % 10);
            }

            for (int index = start; index < 29; index++)
            {
                number.Add(buffer[index]);
            }

            number.Scale = number.Count - value.Scale;
            if (letter == '\0')
            {
                return FormatCustom(number, format);
            }

            if (letter == 'R' || letter == 'r')
            {
                letter = (char)(letter - ('R' - 'G'));
            }

            if (letter != 'G' && letter != 'g')
            {
                return FormatStandard(number, letter, precision);
            }

            var text = new TextBuilder();
            if (precision == -1)
            {
                if (number.Negative && number.Count != 0)
                {
                    text.Append('-');
                }

                FormatGeneral(text, number, precision, letter == 'G' ? 'E' : 'e', true);
                return text.Text();
            }

            int maxDigits = precision == 0 ? number.Count : precision;
            Round(number, maxDigits, false);
            if (number.Negative)
            {
                text.Append('-');
            }

            FormatGeneral(text, number, maxDigits, letter == 'G' ? 'E' : 'e', false);
            return text.Text();
        }

        // .NET's GetFloatingPointMaxDigitsAndPrecision.
        private static int FloatingPrecision(char letter, ref int precision, out bool significant, int customPrecision)
        {
            significant = true;
            if (letter == '\0')
            {
                precision = customPrecision;
                return precision;
            }

            int maxDigits = precision;
            switch (letter)
            {
                case 'C':
                case 'c':
                    if (precision == -1)
                    {
                        precision = 2;
                    }

                    significant = false;
                    break;
                case 'E':
                case 'e':
                    if (precision == -1)
                    {
                        precision = 6;
                    }

                    precision++;
                    break;
                case 'F':
                case 'f':
                case 'N':
                case 'n':
                    if (precision == -1)
                    {
                        precision = 2;
                    }

                    significant = false;
                    break;
                case 'G':
                case 'g':
                    if (precision == 0)
                    {
                        precision = -1;
                    }

                    break;
                case 'P':
                case 'p':
                    if (precision == -1)
                    {
                        precision = 2;
                    }

                    precision += 2;
                    significant = false;
                    break;
                case 'R':
                case 'r':
                    precision = -1;
                    break;
                default:
                    BadFormat();
                    break;
            }

            return maxDigits;
        }

        // An integer: its bits' value (signed or not) and, for hexadecimal,
        // its width in bits.
        public static string FormatInteger(long value, bool unsigned, int bits, string format)
        {
            ulong magnitude = unsigned || value >= 0 ? (ulong)value : (ulong)(-(value + 1)) + 1;
            bool negative = !unsigned && value < 0;
            if (format is null || format.Length == 0)
            {
                return negative ? Strings.Concat("-", Strings.FromUInt64(magnitude)) : Strings.FromUInt64(magnitude);
            }

            char letter = ParseFormat(format, out int precision);
            char upper = (char)(letter & 0xFFDF);

            // R without a precision is G of every digit, which for an
            // integer is D.
            if (upper == 'G' || upper == 'R' ? precision < 1 : upper == 'D')
            {
                var text = new TextBuilder();
                if (negative)
                {
                    text.Append('-');
                }

                string digits = Strings.FromUInt64(magnitude);
                text.Append('0', precision - digits.Length);
                text.Append(digits);
                return text.Text();
            }

            if (upper == 'X')
            {
                ulong raw = bits == 64 ? (ulong)value : (ulong)value & ((1UL << bits) - 1);
                char ten = letter == 'X' ? 'A' : 'a';
                var hex = new TextBuilder();
                int count = 1;
                for (ulong rest = raw >> 4; rest != 0; rest >>= 4)
                {
                    count++;
                }

                hex.Append('0', precision - count);
                for (int shift = (count - 1) * 4; shift >= 0; shift -= 4)
                {
                    int nibble = (int)((raw >> shift) & 15);
                    hex.Append(nibble < 10 ? (char)('0' + nibble) : (char)(ten + nibble - 10));
                }

                return hex.Text();
            }

            var number = new NumberBuffer();
            number.Negative = negative;
            string decimals = Strings.FromUInt64(magnitude);
            if (magnitude != 0)
            {
                for (int index = 0; index < decimals.Length; index++)
                {
                    number.Add(decimals[index] - '0');
                }

                number.Scale = decimals.Length;
                while (number.Count > 0 && number.Digits[number.Count - 1] == 0)
                {
                    number.Count--;
                }
            }

            if (letter == '\0')
            {
                return FormatCustom(number, format);
            }

            // R formats an integer as G does.
            return FormatStandard(number, upper == 'R' ? 'G' : letter, precision);
        }

        // An integer of any size, given by its decimal digits (most
        // significant first, no leading zeros, "" for zero), in a format
        // other than D and X: BigInteger's (corelib/BigInteger.cs), as
        // FormatInteger formats those of the primitive integers.
        public static string FormatDigits(string decimals, bool negative, string format)
        {
            char letter = ParseFormat(format, out int precision);
            var number = new NumberBuffer();
            number.Negative = negative;
            if (decimals.Length != 0)
            {
                for (int index = 0; index < decimals.Length; index++)
                {
                    number.Add(decimals[index] - '0');
                }

                number.Scale = decimals.Length;
                while (number.Count > 0 && number.Digits[number.Count - 1] == 0)
                {
                    number.Count--;
                }
            }

            if (letter == '\0')
            {
                return FormatCustom(number, format);
            }

            // R formats an integer as G does.
            return FormatStandard(number, (char)(letter & 0xFFDF) == 'R' ? 'G' : letter, precision);
        }

        // .NET's RoundNumber: to `position` digits, half up unless the
        // digits are exactly rounded already.
        private static void Round(NumberBuffer number, int position, bool correctlyRounded)
        {
            int index = 0;
            while (index < position && index < number.Count)
            {
                index++;
            }

            if (index == position && index < number.Count && !correctlyRounded && number.Digits[index] >= 5)
            {
                while (index > 0 && number.Digits[index - 1] == 9)
                {
                    index--;
                }

                if (index > 0)
                {
                    number.Digits[index - 1]++;
                }
                else
                {
                    number.Scale++;
                    number.Digits[0] = 1;
                    index = 1;
                }
            }
            else
            {
                while (index > 0 && number.Digits[index - 1] == 0)
                {
                    index--;
                }
            }

            if (index == 0)
            {
                if (!number.Floating)
                {
                    number.Negative = false;
                }

                number.Scale = 0;
            }

            number.Count = index;
        }

        private static string FormatStandard(NumberBuffer number, char letter, int maxDigits)
        {
            bool correct = number.Floating;
            var text = new TextBuilder();
            switch (letter)
            {
                case 'C':
                case 'c':
                    if (maxDigits < 0)
                    {
                        maxDigits = 2;
                    }

                    Round(number, number.Scale + maxDigits, correct);
                    if (number.Negative)
                    {
                        text.Append('(');
                    }

                    text.Append('¤');
                    FormatFixed(text, number, maxDigits, true);
                    if (number.Negative)
                    {
                        text.Append(')');
                    }

                    break;
                case 'F':
                case 'f':
                    if (maxDigits < 0)
                    {
                        maxDigits = 2;
                    }

                    Round(number, number.Scale + maxDigits, correct);
                    if (number.Negative)
                    {
                        text.Append('-');
                    }

                    FormatFixed(text, number, maxDigits, false);
                    break;
                case 'N':
                case 'n':
                    if (maxDigits < 0)
                    {
                        maxDigits = 2;
                    }

                    Round(number, number.Scale + maxDigits, correct);
                    if (number.Negative)
                    {
                        text.Append('-');
                    }

                    FormatFixed(text, number, maxDigits, true);
                    break;
                case 'E':
                case 'e':
                    if (maxDigits < 0)
                    {
                        maxDigits = 6;
                    }

                    maxDigits++;
                    Round(number, maxDigits, correct);
                    if (number.Negative)
                    {
                        text.Append('-');
                    }

                    FormatScientific(text, number, maxDigits, letter == 'E' ? 'E' : 'e');
                    break;
                case 'G':
                case 'g':
                    if (maxDigits < 1)
                    {
                        maxDigits = number.Count;
                    }

                    Round(number, maxDigits, correct);
                    if (number.Negative)
                    {
                        text.Append('-');
                    }

                    FormatGeneral(text, number, maxDigits, letter == 'G' ? 'E' : 'e', false);
                    break;
                case 'P':
                case 'p':
                    if (maxDigits < 0)
                    {
                        maxDigits = 2;
                    }

                    number.Scale += 2;
                    Round(number, number.Scale + maxDigits, correct);
                    if (number.Negative)
                    {
                        text.Append('-');
                    }

                    FormatFixed(text, number, maxDigits, true);
                    text.Append(' ');
                    text.Append('%');
                    break;
                case 'R':
                case 'r':
                    if (number.Negative)
                    {
                        text.Append('-');
                    }

                    FormatGeneral(text, number, maxDigits, 'E', false);
                    break;
                default:
                    BadFormat();
                    break;
            }

            return text.Text();
        }

        private static void FormatFixed(TextBuilder text, NumberBuffer number, int decimals, bool groups)
        {
            int position = number.Scale;
            int digit = 0;
            if (position > 0)
            {
                for (int index = 0; index < position; index++)
                {
                    if (groups && index > 0 && (position - index) % 3 == 0)
                    {
                        text.Append(',');
                    }

                    text.Append(digit < number.Count ? (char)('0' + number.Digits[digit++]) : '0');
                }
            }
            else
            {
                text.Append('0');
            }

            if (decimals > 0)
            {
                text.Append('.');
                if (position < 0)
                {
                    int zeroes = -position < decimals ? -position : decimals;
                    text.Append('0', zeroes);
                    decimals -= zeroes;
                }

                while (decimals > 0)
                {
                    text.Append(digit < number.Count ? (char)('0' + number.Digits[digit++]) : '0');
                    decimals--;
                }
            }
        }

        private static void FormatScientific(TextBuilder text, NumberBuffer number, int maxDigits, char exponentChar)
        {
            int digit = 0;
            text.Append(digit < number.Count ? (char)('0' + number.Digits[digit++]) : '0');
            if (maxDigits != 1)
            {
                text.Append('.');
            }

            while (--maxDigits > 0)
            {
                text.Append(digit < number.Count ? (char)('0' + number.Digits[digit++]) : '0');
            }

            int exponent = number.Count == 0 ? 0 : number.Scale - 1;
            FormatExponent(text, exponent, exponentChar, 3, true);
        }

        private static void FormatExponent(TextBuilder text, int exponent, char exponentChar, int minDigits, bool positiveSign)
        {
            text.Append(exponentChar);
            if (exponent < 0)
            {
                text.Append('-');
                exponent = -exponent;
            }
            else if (positiveSign)
            {
                text.Append('+');
            }

            string digits = Strings.FromUInt64((ulong)exponent);
            text.Append('0', minDigits - digits.Length);
            text.Append(digits);
        }

        private static void FormatGeneral(TextBuilder text, NumberBuffer number, int maxDigits, char exponentChar, bool suppressScientific)
        {
            int position = number.Scale;
            bool scientific = false;
            if (!suppressScientific && (position > maxDigits || position < -3))
            {
                position = 1;
                scientific = true;
            }

            int digit = 0;
            if (position > 0)
            {
                do
                {
                    text.Append(digit < number.Count ? (char)('0' + number.Digits[digit++]) : '0');
                }
                while (--position > 0);
            }
            else
            {
                text.Append('0');
            }

            if (digit < number.Count || position < 0)
            {
                text.Append('.');
                while (position < 0)
                {
                    text.Append('0');
                    position++;
                }

                while (digit < number.Count)
                {
                    text.Append((char)('0' + number.Digits[digit++]));
                }
            }

            if (scientific)
            {
                FormatExponent(text, number.Scale - 1, exponentChar, 2, true);
            }
        }

        // The start of a custom format's section: 0 for positive values, 1
        // negative, 2 zero; the first when there is no such section.
        private static int FindSection(string format, int section)
        {
            if (section == 0)
            {
                return 0;
            }

            int source = 0;
            while (true)
            {
                if (source >= format.Length)
                {
                    return 0;
                }

                char c = format[source++];
                if (c == '\'' || c == '"')
                {
                    while (source < format.Length && format[source++] != c)
                    {
                    }
                }
                else if (c == '\\')
                {
                    if (source < format.Length)
                    {
                        source++;
                    }
                }
                else if (c == ';')
                {
                    if (--section != 0)
                    {
                        continue;
                    }

                    if (source < format.Length && format[source] != ';')
                    {
                        return source;
                    }

                    return 0;
                }
            }
        }

        // .NET's NumberToStringFormat.
        private static string FormatCustom(NumberBuffer number, string format)
        {
            int section = FindSection(format, number.Count == 0 ? 2 : number.Negative ? 1 : 0);
            int digitCount;
            int decimalPos;
            int firstDigit;
            int lastDigit;
            bool scientific;
            int thousandPos;
            int thousandCount;
            int thousandSeps;
            int scaleAdjust;
            int source;
            while (true)
            {
                digitCount = 0;
                decimalPos = -1;
                firstDigit = 0x7FFFFFFF;
                lastDigit = 0;
                scientific = false;
                thousandPos = -1;
                thousandCount = 0;
                thousandSeps = 0;
                scaleAdjust = 0;
                source = section;
                while (source < format.Length)
                {
                    char c = format[source++];
                    if (c == ';')
                    {
                        break;
                    }

                    switch (c)
                    {
                        case '#':
                            digitCount++;
                            break;
                        case '0':
                            if (firstDigit == 0x7FFFFFFF)
                            {
                                firstDigit = digitCount;
                            }

                            digitCount++;
                            lastDigit = digitCount;
                            break;
                        case '.':
                            if (decimalPos < 0)
                            {
                                decimalPos = digitCount;
                            }

                            break;
                        case ',':
                            if (digitCount > 0 && decimalPos < 0)
                            {
                                if (thousandPos >= 0)
                                {
                                    if (thousandPos == digitCount)
                                    {
                                        thousandCount++;
                                        break;
                                    }

                                    thousandSeps = 1;
                                }

                                thousandPos = digitCount;
                                thousandCount = 1;
                            }

                            break;
                        case '%':
                            scaleAdjust += 2;
                            break;
                        case '‰':
                            scaleAdjust += 3;
                            break;
                        case '\'':
                        case '"':
                            while (source < format.Length && format[source++] != c)
                            {
                            }

                            break;
                        case '\\':
                            if (source < format.Length)
                            {
                                source++;
                            }

                            break;
                        case 'E':
                        case 'e':
                            if ((source < format.Length && format[source] == '0')
                                || (source + 1 < format.Length && (format[source] == '+' || format[source] == '-')
                                    && format[source + 1] == '0'))
                            {
                                while (++source < format.Length && format[source] == '0')
                                {
                                }

                                scientific = true;
                            }

                            break;
                    }
                }

                if (decimalPos < 0)
                {
                    decimalPos = digitCount;
                }

                if (thousandPos >= 0)
                {
                    if (thousandPos == decimalPos)
                    {
                        scaleAdjust -= thousandCount * 3;
                    }
                    else
                    {
                        thousandSeps = 1;
                    }
                }

                if (number.Count != 0)
                {
                    number.Scale += scaleAdjust;
                    int position = scientific ? digitCount : number.Scale + digitCount - decimalPos;
                    Round(number, position, false);
                    if (number.Count == 0)
                    {
                        int zeroSection = FindSection(format, 2);
                        if (zeroSection != section)
                        {
                            section = zeroSection;
                            continue;
                        }
                    }
                }
                else
                {
                    if (!number.Floating)
                    {
                        number.Negative = false;
                    }

                    number.Scale = 0;
                }

                break;
            }

            firstDigit = firstDigit < decimalPos ? decimalPos - firstDigit : 0;
            lastDigit = lastDigit > decimalPos ? decimalPos - lastDigit : 0;
            int digPos;
            int adjust;
            if (scientific)
            {
                digPos = decimalPos;
                adjust = 0;
            }
            else
            {
                digPos = number.Scale > decimalPos ? number.Scale : decimalPos;
                adjust = number.Scale - decimalPos;
            }

            source = section;
            var separators = new int[4];
            int separatorCount = -1;
            if (thousandSeps != 0)
            {
                int groupTotal = 3;
                int totalDigits = digPos + (adjust < 0 ? adjust : 0);
                int digitsShown = firstDigit > totalDigits ? firstDigit : totalDigits;
                while (digitsShown > groupTotal)
                {
                    ++separatorCount;
                    if (separatorCount >= separators.Length)
                    {
                        var larger = new int[separators.Length * 2];
                        for (int index = 0; index < separators.Length; index++)
                        {
                            larger[index] = separators[index];
                        }

                        separators = larger;
                    }

                    separators[separatorCount] = groupTotal;
                    groupTotal += 3;
                }
            }

            var text = new TextBuilder();
            if (number.Negative && section == 0 && number.Scale != 0)
            {
                text.Append('-');
            }

            bool decimalWritten = false;
            int current = 0;
            while (source < format.Length)
            {
                char c = format[source++];
                if (c == ';')
                {
                    break;
                }

                if (adjust > 0 && (c == '#' || c == '0' || c == '.'))
                {
                    while (adjust > 0)
                    {
                        text.Append(current < number.Count ? (char)('0' + number.Digits[current++]) : '0');
                        if (thousandSeps != 0 && digPos > 1 && separatorCount >= 0 && digPos == separators[separatorCount] + 1)
                        {
                            text.Append(',');
                            separatorCount--;
                        }

                        digPos--;
                        adjust--;
                    }
                }

                switch (c)
                {
                    case '#':
                    case '0':
                    {
                        char output;
                        if (adjust < 0)
                        {
                            adjust++;
                            output = digPos <= firstDigit ? '0' : '\0';
                        }
                        else
                        {
                            output = current < number.Count ? (char)('0' + number.Digits[current++])
                                : digPos > lastDigit ? '0' : '\0';
                        }

                        if (output != '\0')
                        {
                            text.Append(output);
                            if (thousandSeps != 0 && digPos > 1 && separatorCount >= 0 && digPos == separators[separatorCount] + 1)
                            {
                                text.Append(',');
                                separatorCount--;
                            }
                        }

                        digPos--;
                        break;
                    }

                    case '.':
                        if (digPos != 0 || decimalWritten)
                        {
                            break;
                        }

                        if (lastDigit < 0 || (decimalPos < digitCount && current < number.Count))
                        {
                            text.Append('.');
                            decimalWritten = true;
                        }

                        break;
                    case '‰':
                        text.Append('‰');
                        break;
                    case '%':
                        text.Append('%');
                        break;
                    case ',':
                        break;
                    case '\'':
                    case '"':
                        while (source < format.Length && format[source] != c)
                        {
                            text.Append(format[source++]);
                        }

                        if (source < format.Length)
                        {
                            source++;
                        }

                        break;
                    case '\\':
                        if (source < format.Length)
                        {
                            text.Append(format[source++]);
                        }

                        break;
                    case 'E':
                    case 'e':
                    {
                        bool positiveSign = false;
                        int zeroes = 0;
                        if (scientific)
                        {
                            if (source < format.Length && format[source] == '0')
                            {
                                zeroes++;
                            }
                            else if (source + 1 < format.Length && format[source] == '+' && format[source + 1] == '0')
                            {
                                positiveSign = true;
                            }
                            else if (source + 1 < format.Length && format[source] == '-' && format[source + 1] == '0')
                            {
                            }
                            else
                            {
                                text.Append(c);
                                break;
                            }

                            while (++source < format.Length && format[source] == '0')
                            {
                                zeroes++;
                            }

                            if (zeroes > 10)
                            {
                                zeroes = 10;
                            }

                            int exponent = number.Count == 0 ? 0 : number.Scale - decimalPos;
                            FormatExponent(text, exponent, c, zeroes, positiveSign);
                            scientific = false;
                        }
                        else
                        {
                            text.Append(c);
                            if (source < format.Length)
                            {
                                if (format[source] == '+' || format[source] == '-')
                                {
                                    text.Append(format[source++]);
                                }

                                while (source < format.Length && format[source] == '0')
                                {
                                    text.Append(format[source++]);
                                }
                            }
                        }

                        break;
                    }

                    default:
                        text.Append(c);
                        break;
                }
            }

            if (number.Negative && section == 0 && number.Scale == 0 && text.Length > 0)
            {
                text.InsertFront("-");
            }

            return text.Text();
        }

        // An interpolation hole's or composite format's alignment: spaces
        // before (positive) or after (negative) to the width.
        public static string Align(string text, int alignment)
        {
            text = text is null ? "" : text;
            int width = alignment < 0 ? -alignment : alignment;
            if (text.Length >= width)
            {
                return text;
            }

            var result = new TextBuilder();
            if (alignment > 0)
            {
                result.Append(' ', width - text.Length);
            }

            result.Append(text);
            if (alignment < 0)
            {
                result.Append(' ', width - text.Length);
            }

            return result.Text();
        }
    }
}
