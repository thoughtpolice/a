// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.Decimal, as .NET 11 has it: a 96-bit integer and a power of ten
// (0-28) to divide it by, with a sign, in the CLR's fields (flags, the high
// 32 bits, the low 64 bits). The compiler stands this struct in for the
// framework's, so `decimal` in gameplay code is this, its literals are
// constants of these fields, and its operators, conversions and members are
// the ones here. The arithmetic is .NET's DecCalc (itself oleaut32's),
// ported statement for statement with its buffers as arrays: the same
// rounding, scales and exceptions.

namespace Gameplay.Runtime
{
    public readonly partial struct Decimal : System.IComparable<Decimal>
    {
        private const int SignMask = unchecked((int)0x80000000);
        private const int ScaleMask = 0x00FF0000;
        private const int ScaleShift = 16;

        public const decimal Zero = 0m;
        public const decimal One = 1m;
        public const decimal MinusOne = -1m;
        public const decimal MaxValue = 79228162514264337593543950335m;
        public const decimal MinValue = -79228162514264337593543950335m;

        internal readonly int flags;
        internal readonly uint hi;
        internal readonly ulong lo;

        internal Decimal(int flags, uint hi, ulong lo)
        {
            this.flags = flags;
            this.hi = hi;
            this.lo = lo;
        }

        public Decimal(int value)
        {
            if (value >= 0)
            {
                flags = 0;
            }
            else
            {
                flags = SignMask;
                value = -value;
            }

            lo = (uint)value;
            hi = 0;
        }

        public Decimal(uint value)
        {
            flags = 0;
            lo = value;
            hi = 0;
        }

        public Decimal(long value)
        {
            if (value >= 0)
            {
                flags = 0;
            }
            else
            {
                flags = SignMask;
                value = -value;
            }

            lo = (ulong)value;
            hi = 0;
        }

        public Decimal(ulong value)
        {
            flags = 0;
            lo = value;
            hi = 0;
        }

        public Decimal(float value)
        {
            Decimal result = DecCalc.FromSingle(value);
            flags = result.flags;
            hi = result.hi;
            lo = result.lo;
        }

        public Decimal(double value)
        {
            Decimal result = DecCalc.FromDouble(value);
            flags = result.flags;
            hi = result.hi;
            lo = result.lo;
        }

        public Decimal(int[] bits)
        {
            if (bits == null)
            {
                throw new System.ArgumentNullException();
            }

            if (bits.Length == 4)
            {
                int f = bits[3];
                if (IsValid(f))
                {
                    lo = (uint)bits[0] + ((ulong)(uint)bits[1] << 32);
                    hi = (uint)bits[2];
                    flags = f;
                    return;
                }
            }

            throw new System.ArgumentException("Decimal constructor requires an array or span of four valid decimal bytes.");
        }

        public Decimal(int lo, int mid, int hi, bool isNegative, byte scale)
        {
            if (scale > 28)
            {
                throw new System.ArgumentOutOfRangeException(
                    "scale", scale, "scale ('" + scale + "') must be less than or equal to '28'.");
            }

            this.lo = (uint)lo + ((ulong)(uint)mid << 32);
            this.hi = (uint)hi;
            flags = ((int)scale) << 16;
            if (isNegative)
            {
                flags |= SignMask;
            }
        }

        private static bool IsValid(int flags) =>
            (flags & ~(SignMask | ScaleMask)) == 0 && ((uint)(flags & ScaleMask) <= (28 << ScaleShift));

        internal uint High => hi;

        internal uint Low => (uint)lo;

        internal uint Mid => (uint)(lo >> 32);

        internal ulong Low64 => lo;

        public byte Scale => (byte)(flags >> ScaleShift);

        private static Decimal WithFlags(Decimal d, int flags) => new Decimal(flags, d.hi, d.lo);

        // MARK: Arithmetic

        public static Decimal Add(Decimal d1, Decimal d2) => DecCalc.AddSub(d1, d2, false);

        public static Decimal Subtract(Decimal d1, Decimal d2) => DecCalc.AddSub(d1, d2, true);

        public static Decimal Multiply(Decimal d1, Decimal d2) => DecCalc.Multiply(d1, d2);

        public static Decimal Divide(Decimal d1, Decimal d2) => DecCalc.Divide(d1, d2);

        public static Decimal Remainder(Decimal d1, Decimal d2) => DecCalc.Remainder(d1, d2);

        public static Decimal Negate(Decimal d) => WithFlags(d, d.flags ^ SignMask);

        public static Decimal operator +(Decimal d) => d;

        public static Decimal operator -(Decimal d) => WithFlags(d, d.flags ^ SignMask);

        public static Decimal operator ++(Decimal d) => DecCalc.AddSub(d, new Decimal(0, 0, 1), false);

        public static Decimal operator --(Decimal d) => DecCalc.AddSub(d, new Decimal(0, 0, 1), true);

        public static Decimal operator +(Decimal d1, Decimal d2) => DecCalc.AddSub(d1, d2, false);

        public static Decimal operator -(Decimal d1, Decimal d2) => DecCalc.AddSub(d1, d2, true);

        public static Decimal operator *(Decimal d1, Decimal d2) => DecCalc.Multiply(d1, d2);

        public static Decimal operator /(Decimal d1, Decimal d2) => DecCalc.Divide(d1, d2);

        public static Decimal operator %(Decimal d1, Decimal d2) => DecCalc.Remainder(d1, d2);

        // MARK: Comparison

        public static bool operator ==(Decimal d1, Decimal d2) => DecCalc.Equals(d1, d2);

        public static bool operator !=(Decimal d1, Decimal d2) => !DecCalc.Equals(d1, d2);

        public static bool operator <(Decimal d1, Decimal d2) => DecCalc.Compare(d1, d2) < 0;

        public static bool operator <=(Decimal d1, Decimal d2) => DecCalc.Compare(d1, d2) <= 0;

        public static bool operator >(Decimal d1, Decimal d2) => DecCalc.Compare(d1, d2) > 0;

        public static bool operator >=(Decimal d1, Decimal d2) => DecCalc.Compare(d1, d2) >= 0;

        public static int Compare(Decimal d1, Decimal d2) => DecCalc.Compare(d1, d2);

        public int CompareTo(Decimal value) => DecCalc.Compare(this, value);

        public int CompareTo(object value)
        {
            if (value == null)
            {
                return 1;
            }

            if (!(value is Decimal))
            {
                throw new System.ArgumentException("Object must be of type Decimal.");
            }

            return DecCalc.Compare(this, (Decimal)value);
        }

        public static bool Equals(Decimal d1, Decimal d2) => DecCalc.Equals(d1, d2);

        public bool Equals(Decimal value) => DecCalc.Equals(this, value);

        public override bool Equals(object value) => value is Decimal other && DecCalc.Equals(this, other);

        public override int GetHashCode() => DecCalc.GetHashCode(this);

        // The default hash of a decimal, for the compiler's equality.
        internal static int Hash(Decimal d) => DecCalc.GetHashCode(d);

        // MARK: Rounding

        public static Decimal Ceiling(Decimal d)
        {
            int f = d.flags;
            return (f & ScaleMask) != 0 ? DecCalc.InternalRound(d, (byte)(f >> ScaleShift), 4) : d;
        }

        public static Decimal Floor(Decimal d)
        {
            int f = d.flags;
            return (f & ScaleMask) != 0 ? DecCalc.InternalRound(d, (byte)(f >> ScaleShift), 3) : d;
        }

        public static Decimal Truncate(Decimal d)
        {
            int f = d.flags;
            return (f & ScaleMask) != 0 ? DecCalc.InternalRound(d, (byte)(f >> ScaleShift), 2) : d;
        }

        public static Decimal Round(Decimal d) => Round(d, 0, System.MidpointRounding.ToEven);

        public static Decimal Round(Decimal d, int decimals) => Round(d, decimals, System.MidpointRounding.ToEven);

        public static Decimal Round(Decimal d, System.MidpointRounding mode) => Round(d, 0, mode);

        public static Decimal Round(Decimal d, int decimals, System.MidpointRounding mode)
        {
            if ((uint)decimals > 28)
            {
                throw new System.ArgumentOutOfRangeException(
                    "decimals", "Decimal can only round to between 0 and 28 digits of precision.");
            }

            if ((uint)mode > (uint)System.MidpointRounding.ToPositiveInfinity)
            {
                throw new System.ArgumentException(
                    "The value '" + (int)mode + "' is not valid for this usage of the type MidpointRounding.", "mode");
            }

            int scale = d.Scale - decimals;
            return scale > 0 ? DecCalc.InternalRound(d, (uint)scale, (int)mode) : d;
        }

        // MARK: Generic math statics

        public static Decimal Abs(Decimal value) => WithFlags(value, value.flags & ~SignMask);

        public static Decimal Max(Decimal x, Decimal y) => DecCalc.Compare(x, y) >= 0 ? x : y;

        public static Decimal Min(Decimal x, Decimal y) => DecCalc.Compare(x, y) < 0 ? x : y;

        public static int Sign(Decimal d) => (d.lo | d.hi) == 0 ? 0 : (d.flags >> 31) | 1;

        public static Decimal Clamp(Decimal value, Decimal min, Decimal max)
        {
            if (DecCalc.Compare(min, max) > 0)
            {
                throw new System.ArgumentException("'" + min.ToString() + "' cannot be greater than " + max.ToString() + ".");
            }

            if (DecCalc.Compare(value, min) < 0)
            {
                return min;
            }

            return DecCalc.Compare(value, max) > 0 ? max : value;
        }

        public static Decimal CopySign(Decimal value, Decimal sign) =>
            WithFlags(value, (value.flags & ~SignMask) | (sign.flags & SignMask));

        public static bool IsNegative(Decimal value) => value.flags < 0;

        public static bool IsPositive(Decimal value) => value.flags >= 0;

        public static bool IsInteger(Decimal value) => DecCalc.Equals(value, Truncate(value));

        public static bool IsEvenInteger(Decimal value)
        {
            Decimal truncated = Truncate(value);
            return DecCalc.Equals(value, truncated) && (truncated.lo & 1) == 0;
        }

        public static bool IsOddInteger(Decimal value)
        {
            Decimal truncated = Truncate(value);
            return DecCalc.Equals(value, truncated) && (truncated.lo & 1) != 0;
        }

        public static bool IsCanonical(Decimal value)
        {
            if ((value.flags & ScaleMask) == 0)
            {
                return true;
            }

            ulong tmp = value.lo;
            if (value.hi != 0)
            {
                tmp = ((ulong)value.hi << 32) | (tmp >> 32);
                tmp %= 10;
                tmp = (tmp << 32) | (uint)value.lo;
            }

            return (tmp % 10) != 0;
        }

        public static Decimal MaxMagnitude(Decimal x, Decimal y)
        {
            int c = DecCalc.Compare(Abs(x), Abs(y));
            if (c > 0)
            {
                return x;
            }

            if (c == 0)
            {
                return IsNegative(x) ? y : x;
            }

            return y;
        }

        public static Decimal MinMagnitude(Decimal x, Decimal y)
        {
            int c = DecCalc.Compare(Abs(x), Abs(y));
            if (c < 0)
            {
                return x;
            }

            if (c == 0)
            {
                return IsNegative(x) ? x : y;
            }

            return y;
        }

        // MARK: Bits

        public static int[] GetBits(Decimal d) => new int[] { (int)d.Low, (int)d.Mid, (int)d.High, d.flags };

        public static int GetBits(Decimal d, System.Span<int> destination)
        {
            if ((uint)destination.Length <= 3)
            {
                throw new System.ArgumentException("Destination is too short.", "destination");
            }

            destination[0] = (int)d.Low;
            destination[1] = (int)d.Mid;
            destination[2] = (int)d.High;
            destination[3] = d.flags;
            return 4;
        }

        public static Decimal FromOACurrency(long cy)
        {
            ulong absoluteCy;
            bool isNegative = false;
            if (cy < 0)
            {
                isNegative = true;
                absoluteCy = (ulong)(-cy);
            }
            else
            {
                absoluteCy = (ulong)cy;
            }

            int scale = 4;
            if (absoluteCy != 0)
            {
                while (scale != 0 && ((absoluteCy % 10) == 0))
                {
                    scale--;
                    absoluteCy /= 10;
                }
            }

            return new Decimal((int)absoluteCy, (int)(absoluteCy >> 32), 0, isNegative, (byte)scale);
        }

        public static long ToOACurrency(Decimal value) => DecCalc.ToCurrency(value);

        // MARK: Conversions

        public static implicit operator Decimal(byte value) => new Decimal((uint)value);

        public static implicit operator Decimal(sbyte value) => new Decimal((int)value);

        public static implicit operator Decimal(short value) => new Decimal((int)value);

        public static implicit operator Decimal(ushort value) => new Decimal((uint)value);

        public static implicit operator Decimal(char value) => new Decimal((uint)value);

        public static implicit operator Decimal(int value) => new Decimal(value);

        public static implicit operator Decimal(uint value) => new Decimal(value);

        public static implicit operator Decimal(long value) => new Decimal(value);

        public static implicit operator Decimal(ulong value) => new Decimal(value);

        public static explicit operator Decimal(float value) => DecCalc.FromSingle(value);

        public static explicit operator Decimal(double value) => DecCalc.FromDouble(value);

        public static explicit operator byte(Decimal value) => ToByte(value);

        public static explicit operator sbyte(Decimal value) => ToSByte(value);

        public static explicit operator char(Decimal value) => ToChar(value);

        public static explicit operator short(Decimal value) => ToInt16(value);

        public static explicit operator ushort(Decimal value) => ToUInt16(value);

        public static explicit operator int(Decimal value) => ToInt32(value);

        public static explicit operator uint(Decimal value) => ToUInt32(value);

        public static explicit operator long(Decimal value) => ToInt64(value);

        public static explicit operator ulong(Decimal value) => ToUInt64(value);

        public static explicit operator float(Decimal value) => DecCalc.ToSingle(value);

        public static explicit operator double(Decimal value) => DecCalc.ToDouble(value);

        public static double ToDouble(Decimal d) => DecCalc.ToDouble(d);

        public static float ToSingle(Decimal d) => DecCalc.ToSingle(d);

        public static byte ToByte(Decimal value)
        {
            if (!TryUInt32(value, out uint temp) || temp != (byte)temp)
            {
                throw Overflow("an unsigned byte");
            }

            return (byte)temp;
        }

        public static sbyte ToSByte(Decimal value)
        {
            if (!TryInt32(value, out int temp) || temp != (sbyte)temp)
            {
                throw Overflow("a signed byte");
            }

            return (sbyte)temp;
        }

        public static short ToInt16(Decimal value)
        {
            if (!TryInt32(value, out int temp) || temp != (short)temp)
            {
                throw Overflow("an Int16");
            }

            return (short)temp;
        }

        public static ushort ToUInt16(Decimal value)
        {
            if (!TryUInt32(value, out uint temp) || temp != (ushort)temp)
            {
                throw Overflow("a UInt16");
            }

            return (ushort)temp;
        }

        private static char ToChar(Decimal value)
        {
            if (!TryUInt32(value, out uint temp) || temp != (ushort)temp)
            {
                throw new System.OverflowException(
                    "Value was either too large or too small for a character.", Overflow("a UInt16"));
            }

            return (char)temp;
        }

        public static int ToInt32(Decimal d) => TryInt32(d, out int result) ? result : throw Overflow("an Int32");

        public static uint ToUInt32(Decimal d) => TryUInt32(d, out uint result) ? result : throw Overflow("a UInt32");

        private static bool TryInt32(Decimal d, out int result)
        {
            d = Truncate(d);
            if ((d.High | d.Mid) == 0)
            {
                int i = (int)d.Low;
                if (!IsNegative(d))
                {
                    if (i >= 0)
                    {
                        result = i;
                        return true;
                    }
                }
                else
                {
                    i = -i;
                    if (i <= 0)
                    {
                        result = i;
                        return true;
                    }
                }
            }

            result = 0;
            return false;
        }

        private static bool TryUInt32(Decimal d, out uint result)
        {
            d = Truncate(d);
            if ((d.High | d.Mid) == 0)
            {
                uint i = d.Low;
                if (!IsNegative(d) || i == 0)
                {
                    result = i;
                    return true;
                }
            }

            result = 0;
            return false;
        }

        public static long ToInt64(Decimal d)
        {
            d = Truncate(d);
            if (d.High == 0)
            {
                long l = (long)d.lo;
                if (!IsNegative(d))
                {
                    if (l >= 0)
                    {
                        return l;
                    }
                }
                else
                {
                    l = -l;
                    if (l <= 0)
                    {
                        return l;
                    }
                }
            }

            throw Overflow("an Int64");
        }

        public static ulong ToUInt64(Decimal d)
        {
            d = Truncate(d);
            if (d.High == 0)
            {
                ulong l = d.lo;
                if (!IsNegative(d) || l == 0)
                {
                    return l;
                }
            }

            throw Overflow("a UInt64");
        }

        // The CLR's messages: SR.Overflow_Decimal, Overflow_Int32 and the
        // rest.
        internal static System.OverflowException Overflow(string type) =>
            new System.OverflowException("Value was either too large or too small for " + type + ".");

        // MARK: Text

        // The IFormatProvider overloads take the invariant culture's (the
        // only culture there is here; see runtime/Culture.cs) or null.
        public override string ToString() => Number.FormatDecimal(this, null);

        public string ToString(string format) => Number.FormatDecimal(this, format);

        public string ToString(System.IFormatProvider provider) => Number.FormatDecimal(this, null);

        public string ToString(string format, System.IFormatProvider provider) => Number.FormatDecimal(this, format);

        public bool TryFormat(
            System.Span<char> destination, out int charsWritten, System.ReadOnlySpan<char> format, System.IFormatProvider provider)
        {
            string text = Number.FormatDecimal(this, format.ToString());
            if (text.Length > destination.Length)
            {
                charsWritten = 0;
                return false;
            }

            for (int i = 0; i < text.Length; i++)
            {
                destination[i] = text[i];
            }

            charsWritten = text.Length;
            return true;
        }

        private const int NumberStyle = 0x6F; // NumberStyles.Number

        public static Decimal Parse(string s) => Parse(s, NumberStyle);

        public static Decimal Parse(string s, System.Globalization.NumberStyles style) => Parse(s, (int)style);

        public static Decimal Parse(string s, System.IFormatProvider provider) => Parse(s, NumberStyle);

        public static Decimal Parse(string s, System.Globalization.NumberStyles style, System.IFormatProvider provider) =>
            Parse(s, (int)style);

        public static Decimal Parse(System.ReadOnlySpan<char> s, System.Globalization.NumberStyles style, System.IFormatProvider provider) =>
            ParseText(s.ToString(), (int)style);

        public static Decimal Parse(System.ReadOnlySpan<char> s, System.IFormatProvider provider) => ParseText(s.ToString(), NumberStyle);

        public static bool TryParse(string s, out Decimal result) => TryParse(s, NumberStyle, out result);

        public static bool TryParse(System.ReadOnlySpan<char> s, out Decimal result) => TryParseText(s.ToString(), NumberStyle, out result);

        public static bool TryParse(string s, System.IFormatProvider provider, out Decimal result) => TryParse(s, NumberStyle, out result);

        public static bool TryParse(System.ReadOnlySpan<char> s, System.IFormatProvider provider, out Decimal result) =>
            TryParseText(s.ToString(), NumberStyle, out result);

        public static bool TryParse(string s, System.Globalization.NumberStyles style, System.IFormatProvider provider, out Decimal result) =>
            TryParse(s, (int)style, out result);

        public static bool TryParse(
            System.ReadOnlySpan<char> s, System.Globalization.NumberStyles style, System.IFormatProvider provider, out Decimal result) =>
            TryParseText(s.ToString(), (int)style, out result);

        // .NET 11's partial parsing: the number the text starts with, and how
        // much of the text it is (trailing white space and nulls the style
        // allows included), whatever follows it.
        public static bool TryParsePartial(
            string s, System.Globalization.NumberStyles style, System.IFormatProvider provider, out Decimal result, out int charsConsumed)
        {
            DecimalParsing.Validate((int)style);
            return TryParsePartialText(s, (int)style, out result, out charsConsumed);
        }

        public static bool TryParsePartial(
            System.ReadOnlySpan<char> s, System.Globalization.NumberStyles style, System.IFormatProvider provider, out Decimal result,
            out int charsConsumed)
        {
            DecimalParsing.Validate((int)style);
            return TryParsePartialText(s.ToString(), (int)style, out result, out charsConsumed);
        }

        public static bool TryParsePartial(
            System.ReadOnlySpan<byte> utf8Text, System.Globalization.NumberStyles style, System.IFormatProvider provider, out Decimal result,
            out int bytesConsumed)
        {
            DecimalParsing.Validate((int)style);
            return TryParsePartialText(Int128Text.AsciiPrefix(utf8Text), (int)style, out result, out bytesConsumed);
        }

        private static bool TryParsePartialText(string s, int style, out Decimal result, out int consumed)
        {
            if (s == null)
            {
                result = new Decimal(0, 0, 0);
                consumed = 0;
                return false;
            }

            bool parsed = DecimalParsing.TryParse(s, style, true, out result, out consumed) == 0;
            if (!parsed)
            {
                consumed = 0;
            }

            return parsed;
        }

        private static Decimal Parse(string s, int style)
        {
            if (s == null)
            {
                throw new System.ArgumentNullException("s");
            }

            return ParseText(s, style);
        }

        private static Decimal ParseText(string s, int style)
        {
            DecimalParsing.Validate(style);
            int status = DecimalParsing.TryParse(s, style, false, out Decimal result, out _);
            if (status == 1)
            {
                throw new System.FormatException("The input string '" + s + "' was not in a correct format.");
            }

            if (status == 2)
            {
                throw Overflow("a Decimal");
            }

            return result;
        }

        private static bool TryParse(string s, int style, out Decimal result)
        {
            DecimalParsing.Validate(style);
            if (s == null)
            {
                result = new Decimal(0, 0, 0);
                return false;
            }

            return DecimalParsing.TryParse(s, style, false, out result, out _) == 0;
        }

        private static bool TryParseText(string s, int style, out Decimal result)
        {
            DecimalParsing.Validate(style);
            return DecimalParsing.TryParse(s, style, false, out result, out _) == 0;
        }
    }

    // .NET's Decimal.DecCalc: a decimal's fields while an operation works on
    // them, and the operations.
    internal sealed class DecCalc
    {
        private const uint SignMask = 0x80000000;
        private const uint ScaleMask = 0x00FF0000;
        private const int ScaleShift = 16;
        private const int DEC_SCALE_MAX = 28;
        private const uint TenToPowerNine = 1000000000;
        private const int MaxInt32Scale = 9;
        private const int MaxInt64Scale = 19;

        internal uint uflags;
        internal uint uhi;
        internal uint ulo;
        internal uint umid;

        private DecCalc(Decimal d)
        {
            uflags = (uint)d.flags;
            uhi = d.hi;
            ulo = (uint)d.lo;
            umid = (uint)(d.lo >> 32);
        }

        private Decimal Value => new Decimal((int)uflags, uhi, Low64);

        private uint High
        {
            get => uhi;
            set => uhi = value;
        }

        private uint Low
        {
            get => ulo;
            set => ulo = value;
        }

        private uint Mid
        {
            get => umid;
            set => umid = value;
        }

        private bool IsNegative => (int)uflags < 0;

        private int Scale => (byte)(uflags >> ScaleShift);

        private ulong Low64
        {
            get => ((ulong)umid << 32) | ulo;
            set
            {
                ulo = (uint)value;
                umid = (uint)(value >> 32);
            }
        }

        private void CopyFrom(DecCalc other)
        {
            uflags = other.uflags;
            uhi = other.uhi;
            ulo = other.ulo;
            umid = other.umid;
        }

        private void Clear()
        {
            uflags = 0;
            uhi = 0;
            ulo = 0;
            umid = 0;
        }

        // MARK: Entry points

        internal static Decimal AddSub(Decimal d1, Decimal d2, bool sign)
        {
            var left = new DecCalc(d1);
            DecAddSub(left, new DecCalc(d2), sign);
            return left.Value;
        }

        internal static Decimal Multiply(Decimal d1, Decimal d2)
        {
            var left = new DecCalc(d1);
            VarDecMul(left, new DecCalc(d2));
            return left.Value;
        }

        internal static Decimal Divide(Decimal d1, Decimal d2)
        {
            var left = new DecCalc(d1);
            VarDecDiv(left, new DecCalc(d2));
            return left.Value;
        }

        internal static Decimal Remainder(Decimal d1, Decimal d2)
        {
            var left = new DecCalc(d1);
            VarDecMod(left, new DecCalc(d2));
            return left.Value;
        }

        internal static Decimal InternalRound(Decimal d, uint scale, int mode)
        {
            var value = new DecCalc(d);
            InternalRound(value, scale, mode);
            return value.Value;
        }

        internal static long ToCurrency(Decimal d) => VarCyFromDec(new DecCalc(d));

        // MARK: Helpers

        private static uint UInt32Powers10(int index)
        {
            uint power = 1;
            for (; index > 0; index--)
            {
                power *= 10;
            }

            return power;
        }

        // 10^(index + 1), as .NET's UInt64Powers10 table.
        private static ulong UInt64Powers10(int index)
        {
            ulong power = 10;
            for (; index > 0; index--)
            {
                power *= 10;
            }

            return power;
        }

        // Math.BigMul of two ulongs: the high half, the low half out.
        private static ulong BigMul(ulong a, ulong b, out ulong low)
        {
            ulong al = (uint)a;
            ulong ah = a >> 32;
            ulong bl = (uint)b;
            ulong bh = b >> 32;
            ulong mull = al * bl;
            ulong t = ah * bl + (mull >> 32);
            ulong tl = al * bh + (uint)t;
            low = (tl << 32) | (uint)mull;
            return ah * bh + (t >> 32) + (tl >> 32);
        }

        private static ulong BigMul(uint a, uint b) => (ulong)a * b;

        private static int LeadingZeroCount(uint value) => (int)System.Numerics.BitOperations.LeadingZeroCount(value);

        // The buffers of .NET's DecCalc (Buf12, Buf16, Buf24, Buf28) are
        // arrays of uints, least significant first; a view of one inside
        // another is its offset.
        private static ulong Get64(uint[] buffer, int index) => buffer[index] | ((ulong)buffer[index + 1] << 32);

        private static void Set64(uint[] buffer, int index, ulong value)
        {
            buffer[index] = (uint)value;
            buffer[index + 1] = (uint)(value >> 32);
        }

        private static uint Div64By32(ulong dividend, uint den, out uint remainder)
        {
            uint quo = (uint)(dividend / den);
            remainder = (uint)dividend - quo * den;
            return quo;
        }

        // A 96-bit dividend at `at` divided in place; the remainder.
        private static uint Div96By32(uint[] bufNum, int at, uint den)
        {
            ulong tmp;
            ulong div;
            ulong rem;
            if (bufNum[at + 2] != 0)
            {
                tmp = Get64(bufNum, at + 1);
                div = tmp / den;
                rem = tmp % den;
                Set64(bufNum, at + 1, div);
                tmp = (rem << 32) | bufNum[at];
                if (tmp == 0)
                {
                    return 0;
                }

                div = tmp / den;
                rem = tmp % den;
                bufNum[at] = (uint)div;
                return (uint)rem;
            }

            tmp = Get64(bufNum, at);
            if (tmp == 0)
            {
                return 0;
            }

            Set64(bufNum, at, tmp / den);
            return (uint)(tmp % den);
        }

        private static bool Div96ByConst(ref ulong high64, ref uint low, uint pow)
        {
            ulong div64 = high64 / pow;
            uint div = (uint)((((high64 - div64 * pow) << 32) + low) / pow);
            if (low == div * pow)
            {
                high64 = div64;
                low = div;
                return true;
            }

            return false;
        }

        private static void Unscale(ref uint low, ref ulong high64, ref int scale)
        {
            while ((byte)low == 0 && scale >= 8 && Div96ByConst(ref high64, ref low, 100000000))
            {
                scale -= 8;
            }

            if ((low & 0xF) == 0 && scale >= 4 && Div96ByConst(ref high64, ref low, 10000))
            {
                scale -= 4;
            }

            if ((low & 3) == 0 && scale >= 2 && Div96ByConst(ref high64, ref low, 100))
            {
                scale -= 2;
            }

            if ((low & 1) == 0 && scale >= 1 && Div96ByConst(ref high64, ref low, 10))
            {
                scale--;
            }
        }

        // A 128-bit dividend at `at` whose high 64 bits are below den: the
        // quotient, the remainder in its low 64 bits.
        private static ulong Div128By64(uint[] bufNum, int at, ulong den)
        {
            uint hiBits = Div96By64(bufNum, at + 1, den);
            uint loBits = Div96By64(bufNum, at, den);
            return ((ulong)hiBits << 32) | loBits;
        }

        // A 96-bit dividend at `at` whose high 64 bits are below den: the
        // quotient, the remainder in its low 64 bits.
        private static uint Div96By64(uint[] bufNum, int at, ulong den)
        {
            ulong num;
            uint num2 = bufNum[at + 2];
            if (num2 == 0)
            {
                num = Get64(bufNum, at);
                if (num < den)
                {
                    return 0;
                }

                Set64(bufNum, at, num % den);
                return (uint)(num / den);
            }

            uint quo;
            uint denHigh32 = (uint)(den >> 32);
            if (num2 >= denHigh32)
            {
                num = Get64(bufNum, at);
                num -= den << 32;
                quo = 0;
                do
                {
                    quo--;
                    num += den;
                }
                while (num >= den);

                Set64(bufNum, at, num);
                return quo;
            }

            ulong num64 = Get64(bufNum, at + 1);
            if (num64 < denHigh32)
            {
                return 0;
            }

            quo = Div64By32(num64, denHigh32, out uint rem);
            num = bufNum[at] | ((ulong)rem << 32);

            ulong prod = BigMul(quo, (uint)den);
            num -= prod;

            if (num > ~prod)
            {
                do
                {
                    quo--;
                    num += den;
                }
                while (num >= den);
            }

            Set64(bufNum, at, num);
            return quo;
        }

        // A 128-bit dividend at `at` by the 96-bit normalized divisor: the
        // quotient, the remainder in its low 96 bits.
        private static uint Div128By96(uint[] bufNum, int at, uint[] bufDen)
        {
            ulong dividend = Get64(bufNum, at + 2);
            uint den = bufDen[2];
            if (dividend < den)
            {
                return 0;
            }

            uint quo = Div64By32(dividend, den, out uint remainder);

            ulong prod1;
            uint prod2 = (uint)BigMul(Get64(bufDen, 0), quo, out prod1);
            ulong num = Get64(bufNum, at) - prod1;
            remainder -= prod2;

            if (num > ~prod1)
            {
                remainder--;
                if (remainder < ~prod2)
                {
                    goto PosRem;
                }
            }
            else if (remainder <= ~prod2)
            {
                goto PosRem;
            }

            prod1 = Get64(bufDen, 0);
            while (true)
            {
                quo--;
                num += prod1;
                remainder += den;

                if (num < prod1)
                {
                    uint before = remainder;
                    remainder++;
                    if (before < den)
                    {
                        break;
                    }
                }

                if (remainder < den)
                {
                    break;
                }
            }

        PosRem:
            Set64(bufNum, at, num);
            bufNum[at + 2] = remainder;
            return quo;
        }

        // The 96 bits at `at` times power in place; the product's top 32.
        private static uint IncreaseScale(uint[] bufNum, int at, uint power)
        {
            ulong hi64 = BigMul(Get64(bufNum, at), power, out ulong low64);
            Set64(bufNum, at, low64);
            hi64 = BigMul(bufNum[at + 2], power) + hi64;
            bufNum[at + 2] = (uint)hi64;
            return (uint)(hi64 >> 32);
        }

        // The 128 bits (with room) at 0 times power in place.
        private static void IncreaseScale128(uint[] bufNum, uint power)
        {
            ulong hi64 = BigMul(Get64(bufNum, 0), power, out ulong low64);
            Set64(bufNum, 0, low64);
            Set64(bufNum, 2, BigMul(bufNum[2], power) + hi64);
        }

        private static void IncreaseScale64(uint[] bufNum, uint power)
        {
            bufNum[2] = (uint)BigMul(Get64(bufNum, 0), power, out ulong low64);
            Set64(bufNum, 0, low64);
        }

        // The result scaled into 96 bits, as .NET's ScaleResult: the new
        // scale, the value in the buffer's low three uints.
        private static int ScaleResult(uint[] result, uint hiRes, int scale)
        {
            int newScale = 0;
            if (hiRes > 2)
            {
                newScale = (int)hiRes * 32 - 64 - 1;
                newScale -= LeadingZeroCount(result[hiRes]);
                newScale = ((newScale * 77) >> 8) + 1;
                if (newScale > scale)
                {
                    throw Decimal.Overflow("a Decimal");
                }
            }

            if (newScale < scale - DEC_SCALE_MAX)
            {
                newScale = scale - DEC_SCALE_MAX;
            }

            if (newScale != 0)
            {
                scale -= newScale;
                uint sticky = 0;
                uint quotient;
                uint remainder = 0;

                while (true)
                {
                    sticky |= remainder;

                    uint power = newScale >= 9 ? TenToPowerNine : UInt32Powers10(newScale);
                    DivByConst(result, hiRes, out quotient, out remainder, power);
                    result[hiRes] = quotient;
                    if (quotient == 0 && hiRes != 0)
                    {
                        hiRes--;
                    }

                    newScale -= MaxInt32Scale;
                    if (newScale > 0)
                    {
                        continue;
                    }

                    if (hiRes > 2)
                    {
                        if (scale == 0)
                        {
                            throw Decimal.Overflow("a Decimal");
                        }

                        newScale = 1;
                        scale--;
                        continue;
                    }

                    power >>= 1;
                    if (power <= remainder && (power < remainder || ((result[0] & 1) | sticky) != 0) && ++result[0] == 0)
                    {
                        uint cur = 0;
                        do
                        {
                            cur++;
                        }
                        while (++result[cur] == 0);

                        if (cur > 2)
                        {
                            if (scale == 0)
                            {
                                throw Decimal.Overflow("a Decimal");
                            }

                            hiRes = cur;
                            sticky = 0;
                            remainder = 0;
                            newScale = 1;
                            scale--;
                            continue;
                        }
                    }

                    break;
                }
            }

            return scale;
        }

        private static void DivByConst(uint[] result, uint hiRes, out uint quotient, out uint remainder, uint power)
        {
            uint high = result[hiRes];
            quotient = high / power;
            remainder = high % power;
            for (int i = (int)hiRes - 1; i >= 0; i--)
            {
                ulong num = result[i] + ((ulong)remainder << 32);
                uint div = (uint)(num / power);
                result[i] = div;
                remainder = (uint)num - div * power;
            }
        }

        private static int OverflowUnscale(uint[] bufQuo, int scale, bool sticky)
        {
            if (--scale < 0)
            {
                throw Decimal.Overflow("a Decimal");
            }

            const ulong highbit = 1UL << 32;
            bufQuo[2] = (uint)(highbit / 10);

            ulong tmp = ((highbit % 10) << 32) + bufQuo[1];
            uint div = (uint)(tmp / 10);
            bufQuo[1] = div;
            tmp = ((tmp - div * 10) << 32) + bufQuo[0];
            div = (uint)(tmp / 10);
            bufQuo[0] = div;
            uint remainder = (uint)(tmp - div * 10);

            if (remainder > 5 || remainder == 5 && (sticky || (bufQuo[0] & 1) != 0))
            {
                Add32To96(bufQuo, 1);
            }

            return scale;
        }

        // .NET's PowerOvflValues: the largest upper 96-bit words that do not
        // overflow times 10^(index + 1).
        private static uint PowerOvflHi(int index)
        {
            switch (index)
            {
                case 0: return 429496729;
                case 1: return 42949672;
                case 2: return 4294967;
                case 3: return 429496;
                case 4: return 42949;
                case 5: return 4294;
                case 6: return 429;
                default: return 42;
            }
        }

        private static ulong PowerOvflMidLo(int index)
        {
            switch (index)
            {
                case 0: return ((ulong)2576980377 << 32) + 2576980377;
                case 1: return ((ulong)4123168604 << 32) + 687194767;
                case 2: return ((ulong)1271310319 << 32) + 2645699854;
                case 3: return ((ulong)3133608139 << 32) + 694066715;
                case 4: return ((ulong)2890341191 << 32) + 2216890319;
                case 5: return ((ulong)4154504685 << 32) + 2369172679;
                case 6: return ((ulong)2133437386 << 32) + 4102387834;
                default: return ((ulong)4078814305 << 32) + 410238783;
            }
        }

        private static int SearchScale(ulong resMidLo, uint resHi, int scale)
        {
            const uint OVFL_MAX_9_HI = 4;
            const uint OVFL_MAX_8_HI = 42;
            const uint OVFL_MAX_7_HI = 429;
            const uint OVFL_MAX_6_HI = 4294;
            const uint OVFL_MAX_5_HI = 42949;
            const uint OVFL_MAX_4_HI = 429496;
            const uint OVFL_MAX_3_HI = 4294967;
            const uint OVFL_MAX_2_HI = 42949672;
            const uint OVFL_MAX_1_HI = 429496729;
            const ulong OVFL_MAX_9_MIDLO = 5441186219426131129;

            int curScale = 0;

            if (resHi > OVFL_MAX_1_HI)
            {
                goto HaveScale;
            }

            if (scale > DEC_SCALE_MAX - 9)
            {
                curScale = DEC_SCALE_MAX - scale;
                if (resHi < PowerOvflHi(curScale - 1))
                {
                    goto HaveScale;
                }
            }
            else if (resHi < OVFL_MAX_9_HI || resHi == OVFL_MAX_9_HI && resMidLo <= OVFL_MAX_9_MIDLO)
            {
                return 9;
            }

            if (resHi > OVFL_MAX_5_HI)
            {
                if (resHi > OVFL_MAX_3_HI)
                {
                    curScale = 2;
                    if (resHi > OVFL_MAX_2_HI)
                    {
                        curScale--;
                    }
                }
                else
                {
                    curScale = 4;
                    if (resHi > OVFL_MAX_4_HI)
                    {
                        curScale--;
                    }
                }
            }
            else
            {
                if (resHi > OVFL_MAX_7_HI)
                {
                    curScale = 6;
                    if (resHi > OVFL_MAX_6_HI)
                    {
                        curScale--;
                    }
                }
                else
                {
                    curScale = 8;
                    if (resHi > OVFL_MAX_8_HI)
                    {
                        curScale--;
                    }
                }
            }

            if (resHi == PowerOvflHi(curScale - 1) && resMidLo > PowerOvflMidLo(curScale - 1))
            {
                curScale--;
            }

        HaveScale:
            if (curScale + scale < 0)
            {
                throw Decimal.Overflow("a Decimal");
            }

            return curScale;
        }

        private static bool Add32To96(uint[] bufNum, uint value)
        {
            ulong low64 = Get64(bufNum, 0) + value;
            Set64(bufNum, 0, low64);
            if (low64 < value)
            {
                if (++bufNum[2] == 0)
                {
                    return false;
                }
            }

            return true;
        }

        // MARK: Addition

        private static void DecAddSub(DecCalc d1, DecCalc d2, bool sign)
        {
            ulong low64 = d1.Low64;
            uint high = d1.High;
            uint flags = d1.uflags;
            uint d2flags = d2.uflags;

            uint xorflags = d2flags ^ flags;
            sign ^= (xorflags & SignMask) != 0;

            if ((xorflags & ScaleMask) == 0)
            {
                goto AlignedAdd;
            }
            else
            {
                uint d1flags = flags;
                flags = d2flags & ScaleMask | flags & SignMask;
                int scale = (int)(flags - d1flags) >> ScaleShift;

                if (scale < 0)
                {
                    scale = -scale;
                    flags = d1flags;
                    if (sign)
                    {
                        flags ^= SignMask;
                    }

                    low64 = d2.Low64;
                    high = d2.High;
                    d2.CopyFrom(d1);
                }

                uint power;
                ulong tmp64;

                if (high == 0)
                {
                    if (low64 <= uint.MaxValue)
                    {
                        if ((uint)low64 == 0)
                        {
                            uint signFlags = flags & SignMask;
                            if (sign)
                            {
                                signFlags ^= SignMask;
                            }

                            d1.CopyFrom(d2);
                            d1.uflags = d2.uflags & ScaleMask | signFlags;
                            return;
                        }

                        do
                        {
                            if ((uint)scale <= MaxInt32Scale)
                            {
                                low64 = BigMul((uint)low64, UInt32Powers10(scale));
                                goto AlignedAdd;
                            }

                            scale -= MaxInt32Scale;
                            low64 = BigMul((uint)low64, TenToPowerNine);
                        }
                        while (low64 <= uint.MaxValue);
                    }

                    do
                    {
                        power = TenToPowerNine;
                        if ((uint)scale < MaxInt32Scale)
                        {
                            power = UInt32Powers10(scale);
                        }

                        high = (uint)BigMul(low64, power, out low64);
                        if ((scale -= MaxInt32Scale) <= 0)
                        {
                            goto AlignedAdd;
                        }
                    }
                    while (high == 0);
                }

                while (true)
                {
                    power = TenToPowerNine;
                    if ((uint)scale < MaxInt32Scale)
                    {
                        power = UInt32Powers10(scale);
                    }

                    tmp64 = BigMul(low64, power, out low64);
                    tmp64 += BigMul(high, power);

                    scale -= MaxInt32Scale;
                    if (tmp64 > uint.MaxValue)
                    {
                        break;
                    }

                    high = (uint)tmp64;
                    if (scale <= 0)
                    {
                        goto AlignedAdd;
                    }
                }

                uint[] bufNum = new uint[6];
                Set64(bufNum, 0, low64);
                Set64(bufNum, 2, tmp64);
                uint hiProd = 3;

                for (; scale > 0; scale -= MaxInt32Scale)
                {
                    power = TenToPowerNine;
                    if ((uint)scale < MaxInt32Scale)
                    {
                        power = UInt32Powers10(scale);
                    }

                    tmp64 = 0;
                    for (uint cur = 0; ;)
                    {
                        tmp64 += BigMul(bufNum[cur], power);
                        bufNum[cur] = (uint)tmp64;
                        cur++;
                        tmp64 >>= 32;
                        if (cur > hiProd)
                        {
                            break;
                        }
                    }

                    if ((uint)tmp64 != 0)
                    {
                        bufNum[++hiProd] = (uint)tmp64;
                    }
                }

                tmp64 = Get64(bufNum, 0);
                low64 = d2.Low64;
                uint tmpHigh = bufNum[2];
                high = d2.High;

                if (sign)
                {
                    low64 = tmp64 - low64;
                    high = tmpHigh - high;

                    if (low64 > tmp64)
                    {
                        high--;
                        if (high < tmpHigh)
                        {
                            goto NoCarry;
                        }
                    }
                    else if (high <= tmpHigh)
                    {
                        goto NoCarry;
                    }

                    uint borrow = 3;
                    while (true)
                    {
                        uint digit = bufNum[borrow];
                        bufNum[borrow] = digit - 1;
                        borrow++;
                        if (digit != 0)
                        {
                            break;
                        }
                    }

                    if (bufNum[hiProd] == 0 && --hiProd <= 2)
                    {
                        goto ReturnResult;
                    }
                }
                else
                {
                    low64 += tmp64;
                    high += tmpHigh;

                    if (low64 < tmp64)
                    {
                        high++;
                        if (high > tmpHigh)
                        {
                            goto NoCarry;
                        }
                    }
                    else if (high >= tmpHigh)
                    {
                        goto NoCarry;
                    }

                    uint carry = 3;
                    while (true)
                    {
                        uint digit = ++bufNum[carry];
                        carry++;
                        if (digit != 0)
                        {
                            break;
                        }

                        if (hiProd < carry)
                        {
                            bufNum[carry] = 1;
                            hiProd = carry;
                            break;
                        }
                    }
                }

            NoCarry:
                Set64(bufNum, 0, low64);
                bufNum[2] = high;
                scale = ScaleResult(bufNum, hiProd, (byte)(flags >> ScaleShift));
                flags = (flags & ~ScaleMask) | ((uint)scale << ScaleShift);
                low64 = Get64(bufNum, 0);
                high = bufNum[2];
                goto ReturnResult;
            }

        SignFlip:
            flags ^= SignMask;
            high = ~high;
            low64 = (ulong)(-(long)low64);
            if (low64 == 0)
            {
                high++;
            }

            goto ReturnResult;

        AlignedScale:
            if ((flags & ScaleMask) == 0)
            {
                throw Decimal.Overflow("a Decimal");
            }

            flags -= 1 << ScaleShift;
            {
                const uint den = 10;
                ulong num = high + (1UL << 32);
                high = (uint)(num / den);
                num = ((num - high * den) << 32) + (low64 >> 32);
                uint div = (uint)(num / den);
                num = ((num - div * den) << 32) + (uint)low64;
                low64 = div;
                low64 <<= 32;
                div = (uint)(num / den);
                low64 += div;
                div = (uint)num - div * den;

                if (div >= 5 && (div > 5 || (low64 & 1) != 0))
                {
                    if (++low64 == 0)
                    {
                        high++;
                    }
                }
            }

            goto ReturnResult;

        AlignedAdd:
            {
                ulong d1Low64 = low64;
                uint d1High = high;
                if (sign)
                {
                    low64 = d1Low64 - d2.Low64;
                    high = d1High - d2.High;

                    if (low64 > d1Low64)
                    {
                        high--;
                        if (high >= d1High)
                        {
                            goto SignFlip;
                        }
                    }
                    else if (high > d1High)
                    {
                        goto SignFlip;
                    }
                }
                else
                {
                    low64 = d1Low64 + d2.Low64;
                    high = d1High + d2.High;

                    if (low64 < d1Low64)
                    {
                        high++;
                        if (high <= d1High)
                        {
                            goto AlignedScale;
                        }
                    }
                    else if (high < d1High)
                    {
                        goto AlignedScale;
                    }
                }
            }

        ReturnResult:
            d1.uflags = flags;
            d1.High = high;
            d1.Low64 = low64;
        }

        // MARK: Currency

        private static long VarCyFromDec(DecCalc pdecIn)
        {
            long value;

            int scale = pdecIn.Scale - 4;
            if (scale < 0)
            {
                if (pdecIn.High != 0)
                {
                    throw Decimal.Overflow("a Currency");
                }

                uint pwr = UInt32Powers10(-scale);
                ulong high = BigMul(pdecIn.Low64, pwr, out ulong low);
                if (high != 0)
                {
                    throw Decimal.Overflow("a Currency");
                }

                value = (long)low;
            }
            else
            {
                if (scale != 0)
                {
                    InternalRound(pdecIn, (uint)scale, 0);
                }

                if (pdecIn.High != 0)
                {
                    throw Decimal.Overflow("a Currency");
                }

                value = (long)pdecIn.Low64;
            }

            if (value < 0 && (value != long.MinValue || !pdecIn.IsNegative))
            {
                throw Decimal.Overflow("a Currency");
            }

            if (pdecIn.IsNegative)
            {
                value = -value;
            }

            return value;
        }

        // MARK: Comparison

        internal static bool Equals(Decimal d1, Decimal d2)
        {
            if ((d2.lo | d2.hi) == 0)
            {
                return (d1.lo | d1.hi) == 0;
            }

            if ((d1.lo | d1.hi) == 0)
            {
                return false;
            }

            if ((d1.flags ^ d2.flags) < 0)
            {
                return false;
            }

            return VarDecCmpSub(d1, d2) == 0;
        }

        internal static int Compare(Decimal d1, Decimal d2)
        {
            if ((d2.lo | d2.hi) == 0)
            {
                if ((d1.lo | d1.hi) == 0)
                {
                    return 0;
                }

                return (d1.flags >> 31) | 1;
            }

            if ((d1.lo | d1.hi) == 0)
            {
                return -((d2.flags >> 31) | 1);
            }

            int sign = (d1.flags >> 31) - (d2.flags >> 31);
            if (sign != 0)
            {
                return sign;
            }

            return VarDecCmpSub(d1, d2);
        }

        private static int VarDecCmpSub(Decimal d1, Decimal d2)
        {
            int flags = d2.flags;
            int sign = (flags >> 31) | 1;
            int scale = flags - d1.flags;

            ulong low64 = d1.lo;
            uint high = d1.hi;

            ulong d2Low64 = d2.lo;
            uint d2High = d2.hi;

            if (scale != 0)
            {
                scale >>= ScaleShift;

                if (scale < 0)
                {
                    scale = -scale;
                    sign = -sign;

                    ulong tmp64 = low64;
                    low64 = d2Low64;
                    d2Low64 = tmp64;

                    uint tmp = high;
                    high = d2High;
                    d2High = tmp;
                }

                do
                {
                    uint power = (uint)scale >= MaxInt32Scale ? TenToPowerNine : UInt32Powers10(scale);
                    ulong tmp = BigMul(low64, power, out low64);
                    tmp += BigMul(high, power);
                    if (tmp > uint.MaxValue)
                    {
                        return sign;
                    }

                    high = (uint)tmp;
                }
                while ((scale -= MaxInt32Scale) > 0);
            }

            uint cmpHigh = high - d2High;
            if (cmpHigh != 0)
            {
                if (cmpHigh > high)
                {
                    sign = -sign;
                }

                return sign;
            }

            ulong cmpLow64 = low64 - d2Low64;
            if (cmpLow64 == 0)
            {
                sign = 0;
            }
            else if (cmpLow64 > low64)
            {
                sign = -sign;
            }

            return sign;
        }

        // MARK: Multiplication

        private static void VarDecMul(DecCalc d1, DecCalc d2)
        {
            int scale = (byte)(d1.uflags + d2.uflags >> ScaleShift);

            ulong tmp;
            uint hiProd;
            uint[] bufProd = new uint[6];

            if ((d1.High | d1.Mid) == 0)
            {
                if ((d2.High | d2.Mid) == 0)
                {
                    ulong low64 = BigMul(d1.Low, d2.Low);
                    if (scale > DEC_SCALE_MAX)
                    {
                        if (scale > DEC_SCALE_MAX + MaxInt64Scale)
                        {
                            goto ReturnZero;
                        }

                        scale -= DEC_SCALE_MAX + 1;
                        ulong power = UInt64Powers10(scale);

                        ulong remainder = low64 % power;
                        low64 /= power;

                        power >>= 1;
                        if (remainder >= power && (remainder > power || ((uint)low64 & 1) > 0))
                        {
                            low64++;
                        }

                        scale = DEC_SCALE_MAX;
                    }

                    d1.Low64 = low64;
                    d1.uflags = ((d2.uflags ^ d1.uflags) & SignMask) | ((uint)scale << ScaleShift);
                    return;
                }
                else
                {
                    tmp = BigMul(d1.Low, d2.Low64, out ulong low);
                    Set64(bufProd, 0, low);

                    if (d2.High != 0)
                    {
                        tmp += BigMul(d1.Low, d2.High);
                        if (tmp > uint.MaxValue)
                        {
                            Set64(bufProd, 2, tmp);
                            hiProd = 3;
                            goto SkipScan;
                        }
                    }

                    bufProd[2] = (uint)tmp;
                    hiProd = 2;
                }
            }
            else if ((d2.High | d2.Mid) == 0)
            {
                tmp = BigMul(d1.Low64, d2.Low, out ulong low);
                Set64(bufProd, 0, low);

                if (d1.High != 0)
                {
                    tmp += BigMul(d2.Low, d1.High);
                    if (tmp > uint.MaxValue)
                    {
                        Set64(bufProd, 2, tmp);
                        hiProd = 3;
                        goto SkipScan;
                    }
                }

                bufProd[2] = (uint)tmp;
                hiProd = 2;
            }
            else
            {
                ulong mid64 = BigMul(d1.Low64, d2.Low64, out tmp);
                Set64(bufProd, 0, tmp);

                if ((d1.High | d2.High) != 0)
                {
                    ulong hi64 = BigMul(d1.High, d2.High);

                    hi64 += BigMul(d1.Low64, d2.High, out tmp);
                    mid64 += tmp;
                    if (mid64 < tmp)
                    {
                        ++hi64;
                    }

                    hi64 += BigMul(d2.Low64, d1.High, out tmp);
                    mid64 += tmp;
                    if (mid64 < tmp)
                    {
                        ++hi64;
                    }

                    Set64(bufProd, 2, mid64);
                    Set64(bufProd, 4, hi64);
                    hiProd = 5;
                }
                else
                {
                    Set64(bufProd, 2, mid64);
                    hiProd = 3;
                }
            }

            while (bufProd[hiProd] == 0)
            {
                if (hiProd == 0)
                {
                    goto ReturnZero;
                }

                hiProd--;
            }

        SkipScan:
            if (hiProd > 2 || scale > DEC_SCALE_MAX)
            {
                scale = ScaleResult(bufProd, hiProd, scale);
            }

            d1.Low64 = Get64(bufProd, 0);
            d1.High = bufProd[2];
            d1.uflags = ((d2.uflags ^ d1.uflags) & SignMask) | ((uint)scale << ScaleShift);
            return;

        ReturnZero:
            d1.Clear();
        }

        // MARK: Floating point

        internal static Decimal FromDouble(double input)
        {
            if (input == 0)
            {
                return new Decimal(0, 0, 0);
            }

            if (double.IsNaN(input) || double.IsInfinity(input))
            {
                throw Decimal.Overflow("a Decimal");
            }

            ulong bits = (ulong)System.BitConverter.DoubleToInt64Bits(input);
            return FromBinary((bits & 0x8000000000000000) != 0, bits & 0x7FFFFFFFFFFFFFFF, 52, 11, 1023);
        }

        internal static Decimal FromSingle(float input)
        {
            if (input == 0)
            {
                return new Decimal(0, 0, 0);
            }

            if (float.IsNaN(input) || float.IsInfinity(input))
            {
                throw Decimal.Overflow("a Decimal");
            }

            uint bits = (uint)System.BitConverter.SingleToInt32Bits(input);
            return FromBinary((bits & 0x80000000) != 0, bits & 0x7FFFFFFF, 23, 8, 127);
        }

        // .NET 11's VarDecFromFloat: the float's exact value rounded once
        // (to even) to the most digits that fit.
        private static Decimal FromBinary(bool isNegative, ulong bits, int denormalMantissaBits, int exponentBits, int exponentBias)
        {
            ulong significand = bits & ((1UL << denormalMantissaBits) - 1);
            int biasedExponent = (int)((bits >> denormalMantissaBits) & ((1UL << exponentBits) - 1));

            int exponent;
            if (biasedExponent == 0)
            {
                exponent = 1 - exponentBias - denormalMantissaBits;
            }
            else
            {
                significand |= 1UL << denormalMantissaBits;
                exponent = biasedExponent - exponentBias - denormalMantissaBits;
            }

            int trailingZeros = System.Numerics.BitOperations.TrailingZeroCount(significand);
            significand >>= trailingZeros;
            exponent += trailingZeros;

            ulong mantissaHigh;
            ulong mantissaLow;
            int scale;

            if (exponent >= 0)
            {
                int significandBits = 64 - System.Numerics.BitOperations.LeadingZeroCount(significand);
                if ((significandBits + exponent) > 96)
                {
                    throw Decimal.Overflow("a Decimal");
                }

                UInt128Math.ShiftLeft(0, significand, exponent, out mantissaHigh, out mantissaLow);
                scale = 0;
            }
            else
            {
                int k = -exponent;
                scale = k < DEC_SCALE_MAX ? k : DEC_SCALE_MAX;

                while (true)
                {
                    Pow5(scale, out ulong powerHigh, out ulong powerLow);
                    ulong productLow;
                    ulong productHigh = BigMul(significand, powerLow, out productLow) + significand * powerHigh;
                    UInt128Math.RoundShiftRightEven(productHigh, productLow, k - scale, out mantissaHigh, out mantissaLow);

                    if ((mantissaHigh >> 32) == 0)
                    {
                        break;
                    }

                    scale--;
                }
            }

            if ((mantissaHigh | mantissaLow) == 0)
            {
                return new Decimal(0, 0, 0);
            }

            return new Decimal((int)((isNegative ? SignMask : 0) | ((uint)scale << ScaleShift)), (uint)mantissaHigh, mantissaLow);
        }

        private static void Pow5(int exponent, out ulong high, out ulong low)
        {
            if (exponent == DEC_SCALE_MAX)
            {
                high = 2;
                low = 359414837200037393;
                return;
            }

            high = 0;
            low = 1;
            for (; exponent > 0; exponent--)
            {
                low *= 5;
            }
        }

        internal static double ToDouble(Decimal value)
        {
            double dbl = ToFloatingPoint(value.lo, value.hi, value.Scale, false);
            return Decimal.IsNegative(value) ? -dbl : dbl;
        }

        internal static float ToSingle(Decimal value)
        {
            float flt = (float)ToFloatingPoint(value.lo, value.hi, value.Scale, true);
            return Decimal.IsNegative(value) ? -flt : flt;
        }

        // .NET 11's DecimalToFloatingPoint: Clinger's fast path where it
        // applies (for float, a double division then rounded to float, as
        // .NET does it), else the correctly rounded quotient, which the
        // Eisel-Lemire path .NET tries first equals whenever it succeeds.
        private static double ToFloatingPoint(ulong low64, uint high, int scale, bool single)
        {
            if ((low64 | high) == 0)
            {
                return 0;
            }

            if (high == 0 && low64 <= (single ? 2UL << 23 : 2UL << 52) && scale <= (single ? 10 : 22))
            {
                double quotient = (double)low64 / DoublePower10(scale);
                return single ? (double)(float)quotient : quotient;
            }

            double exact = ToFloatingPointExact(low64, high, scale, single ? 24 : 53);
            return single ? (double)(float)exact : exact;
        }

        private static double DoublePower10(int scale)
        {
            double power = 1;
            for (; scale > 0; scale--)
            {
                power *= 10;
            }

            return power;
        }

        private static double ToFloatingPointExact(ulong low64, uint high, int scale, int significandBits)
        {
            ulong mantissaHigh = high;
            ulong mantissaLow = low64;
            if ((mantissaHigh | mantissaLow) == 0)
            {
                return 0.0;
            }

            Pow5(scale, out ulong divisorHigh, out ulong divisorLow);

            int mantissaBits = 128 - UInt128Math.LeadingZeroCount(mantissaHigh, mantissaLow);
            int divisorBits = 128 - UInt128Math.LeadingZeroCount(divisorHigh, divisorLow);

            int shift = (significandBits + 1) - (mantissaBits - divisorBits);

            ulong numeratorHigh;
            ulong numeratorLow;
            ulong denominatorHigh;
            ulong denominatorLow;
            if (shift >= 0)
            {
                UInt128Math.ShiftLeft(mantissaHigh, mantissaLow, shift, out numeratorHigh, out numeratorLow);
                denominatorHigh = divisorHigh;
                denominatorLow = divisorLow;
            }
            else
            {
                numeratorHigh = mantissaHigh;
                numeratorLow = mantissaLow;
                UInt128Math.ShiftLeft(divisorHigh, divisorLow, -shift, out denominatorHigh, out denominatorLow);
            }

            UInt128Math.DivRem(
                numeratorHigh, numeratorLow, denominatorHigh, denominatorLow,
                out ulong quotientHigh, out ulong quotientLow, out ulong remainderHigh, out ulong remainderLow);

            int quotientBits = 128 - UInt128Math.LeadingZeroCount(quotientHigh, quotientLow);
            int drop = quotientBits - significandBits;

            ulong keep = (quotientLow >> drop) | (drop == 0 ? 0 : quotientHigh << (64 - drop));
            ulong roundBits = quotientLow & ((1UL << drop) - 1);
            ulong half = 1UL << (drop - 1);
            bool sticky = (remainderHigh | remainderLow) != 0 || ((roundBits & (half - 1)) != 0);

            bool roundUp;
            if (roundBits > half)
            {
                roundUp = true;
            }
            else if (roundBits < half)
            {
                roundUp = false;
            }
            else
            {
                roundUp = sticky || ((keep & 1) != 0);
            }

            if (roundUp && (++keep == (1UL << significandBits)))
            {
                keep >>= 1;
                drop++;
            }

            int exponent = drop - shift - scale;
            return DoubleDouble.ScaleB((double)keep, exponent);
        }

        // MARK: Hashing

        internal static int GetHashCode(Decimal d)
        {
            if ((d.lo | d.hi) == 0)
            {
                return 0;
            }

            uint flags = (uint)d.flags;
            if ((flags & ScaleMask) == 0 || (d.Low & 1) != 0)
            {
                return (int)(flags ^ d.High ^ d.Mid ^ d.Low);
            }

            int scale = (byte)(flags >> ScaleShift);
            uint low = d.Low;
            ulong high64 = ((ulong)d.High << 32) | d.Mid;

            Unscale(ref low, ref high64, ref scale);

            flags = (flags & ~ScaleMask) | (uint)scale << ScaleShift;
            return (int)(flags ^ (uint)(high64 >> 32) ^ (uint)high64 ^ low);
        }

        // MARK: Division

        private static void VarDecDiv(DecCalc d1, DecCalc d2)
        {
            uint[] bufQuo = new uint[3];

            uint power;
            int curScale;

            int scale = (sbyte)(d1.uflags - d2.uflags >> ScaleShift);
            bool unscale = false;
            uint tmp;

            if ((d2.High | d2.Mid) == 0)
            {
                uint den = d2.Low;
                if (den == 0)
                {
                    throw new System.DivideByZeroException();
                }

                Set64(bufQuo, 0, d1.Low64);
                bufQuo[2] = d1.High;
                uint remainder = Div96By32(bufQuo, 0, den);

                while (true)
                {
                    if (remainder == 0)
                    {
                        if (scale < 0)
                        {
                            curScale = -scale < 9 ? -scale : 9;
                            goto HaveScale;
                        }

                        break;
                    }

                    unscale = true;

                    if (scale == DEC_SCALE_MAX || (curScale = SearchScale(Get64(bufQuo, 0), bufQuo[2], scale)) == 0)
                    {
                        tmp = remainder << 1;
                        if (tmp < remainder || tmp >= den && (tmp > den || (bufQuo[0] & 1) != 0))
                        {
                            goto RoundUp;
                        }

                        break;
                    }

                HaveScale:
                    power = UInt32Powers10(curScale);
                    scale += curScale;

                    if (IncreaseScale(bufQuo, 0, power) != 0)
                    {
                        throw Decimal.Overflow("a Decimal");
                    }

                    ulong num = BigMul(remainder, power);
                    uint div = Div64By32(num, den, out remainder);

                    if (!Add32To96(bufQuo, div))
                    {
                        scale = OverflowUnscale(bufQuo, scale, remainder != 0);
                        break;
                    }
                }
            }
            else
            {
                tmp = d2.High;
                if (tmp == 0)
                {
                    tmp = d2.Mid;
                }

                curScale = LeadingZeroCount(tmp);

                uint[] bufRem = new uint[4];
                Set64(bufRem, 0, d1.Low64 << curScale);
                Set64(bufRem, 2, (d1.Mid + ((ulong)d1.High << 32)) >> (32 - curScale));

                ulong divisor = d2.Low64 << curScale;

                if (d2.High == 0)
                {
                    bufQuo[2] = 0;
                    Set64(bufQuo, 0, Div128By64(bufRem, 0, divisor));
                    while (true)
                    {
                        if (Get64(bufRem, 0) == 0)
                        {
                            if (scale < 0)
                            {
                                curScale = -scale < 9 ? -scale : 9;
                                goto HaveScale64;
                            }

                            break;
                        }

                        unscale = true;

                        if (scale == DEC_SCALE_MAX || (curScale = SearchScale(Get64(bufQuo, 0), bufQuo[2], scale)) == 0)
                        {
                            ulong tmp64 = Get64(bufRem, 0);
                            if ((long)tmp64 < 0 || (tmp64 <<= 1) > divisor || (tmp64 == divisor && (bufQuo[0] & 1) != 0))
                            {
                                goto RoundUp;
                            }

                            break;
                        }

                    HaveScale64:
                        power = UInt32Powers10(curScale);
                        scale += curScale;

                        if (IncreaseScale(bufQuo, 0, power) != 0)
                        {
                            throw Decimal.Overflow("a Decimal");
                        }

                        IncreaseScale64(bufRem, power);
                        tmp = Div96By64(bufRem, 0, divisor);
                        if (!Add32To96(bufQuo, tmp))
                        {
                            scale = OverflowUnscale(bufQuo, scale, Get64(bufRem, 0) != 0);
                            break;
                        }
                    }
                }
                else
                {
                    uint[] bufDivisor = new uint[3];
                    Set64(bufDivisor, 0, divisor);
                    bufDivisor[2] = (uint)((d2.Mid + ((ulong)d2.High << 32)) >> (32 - curScale));

                    Set64(bufQuo, 0, Div128By96(bufRem, 0, bufDivisor));
                    bufQuo[2] = 0;

                    while (true)
                    {
                        if ((Get64(bufRem, 0) | bufRem[2]) == 0)
                        {
                            if (scale < 0)
                            {
                                curScale = -scale < 9 ? -scale : 9;
                                goto HaveScale96;
                            }

                            break;
                        }

                        unscale = true;

                        if (scale == DEC_SCALE_MAX || (curScale = SearchScale(Get64(bufQuo, 0), bufQuo[2], scale)) == 0)
                        {
                            if ((int)bufRem[2] < 0)
                            {
                                goto RoundUp;
                            }

                            tmp = bufRem[1] >> 31;
                            Set64(bufRem, 0, Get64(bufRem, 0) << 1);
                            bufRem[2] = (bufRem[2] << 1) + tmp;

                            if (bufRem[2] > bufDivisor[2] || bufRem[2] == bufDivisor[2]
                                && (Get64(bufRem, 0) > Get64(bufDivisor, 0) || Get64(bufRem, 0) == Get64(bufDivisor, 0)
                                    && (bufQuo[0] & 1) != 0))
                            {
                                goto RoundUp;
                            }

                            break;
                        }

                    HaveScale96:
                        power = UInt32Powers10(curScale);
                        scale += curScale;

                        if (IncreaseScale(bufQuo, 0, power) != 0)
                        {
                            throw Decimal.Overflow("a Decimal");
                        }

                        IncreaseScale128(bufRem, power);
                        tmp = Div128By96(bufRem, 0, bufDivisor);
                        if (!Add32To96(bufQuo, tmp))
                        {
                            scale = OverflowUnscale(bufQuo, scale, (Get64(bufRem, 0) | Get64(bufRem, 2)) != 0);
                            break;
                        }
                    }
                }
            }

        Unscale:
            if (unscale)
            {
                uint low = bufQuo[0];
                ulong high64 = Get64(bufQuo, 1);
                Unscale(ref low, ref high64, ref scale);
                d1.Low = low;
                d1.Mid = (uint)high64;
                d1.High = (uint)(high64 >> 32);
            }
            else
            {
                d1.Low64 = Get64(bufQuo, 0);
                d1.High = bufQuo[2];
            }

            d1.uflags = ((d1.uflags ^ d2.uflags) & SignMask) | ((uint)scale << ScaleShift);
            return;

        RoundUp:
            {
                ulong low64 = Get64(bufQuo, 0) + 1;
                Set64(bufQuo, 0, low64);
                if (low64 == 0 && ++bufQuo[2] == 0)
                {
                    scale = OverflowUnscale(bufQuo, scale, true);
                }

                goto Unscale;
            }
        }

        // MARK: Remainder

        private static void VarDecMod(DecCalc d1, DecCalc d2)
        {
            if ((d2.Low64 | d2.uhi) == 0)
            {
                throw new System.DivideByZeroException();
            }

            if ((d1.Low64 | d1.uhi) == 0)
            {
                return;
            }

            d2.uflags = (d2.uflags & ~SignMask) | (d1.uflags & SignMask);

            int cmp = VarDecCmpSub(d1.Value, d2.Value);
            if (cmp == 0)
            {
                d1.Low64 = 0;
                d1.uhi = 0;
                if (d2.uflags > d1.uflags)
                {
                    d1.uflags = d2.uflags;
                }

                return;
            }

            if ((cmp ^ (int)(d1.uflags & SignMask)) < 0)
            {
                return;
            }

            int scale = (sbyte)(d1.uflags - d2.uflags >> ScaleShift);
            if (scale > 0)
            {
                do
                {
                    uint power = (uint)scale >= MaxInt32Scale ? TenToPowerNine : UInt32Powers10(scale);
                    uint hi32 = (uint)BigMul(d2.Low64, power, out ulong low64);
                    d2.Low64 = low64;
                    d2.High = hi32 + d2.High * power;
                }
                while ((scale -= MaxInt32Scale) > 0);
                scale = 0;
            }

            do
            {
                if (scale < 0)
                {
                    d1.uflags = d2.uflags;
                    uint[] bufQuo = new uint[3];
                    Set64(bufQuo, 0, d1.Low64);
                    bufQuo[2] = d1.High;
                    do
                    {
                        int iCurScale = SearchScale(Get64(bufQuo, 0), bufQuo[2], DEC_SCALE_MAX + scale);
                        if (iCurScale == 0)
                        {
                            break;
                        }

                        uint power = (uint)iCurScale >= MaxInt32Scale ? TenToPowerNine : UInt32Powers10(iCurScale);
                        scale += iCurScale;
                        IncreaseScale(bufQuo, 0, power);
                        if (power != TenToPowerNine)
                        {
                            break;
                        }
                    }
                    while (scale < 0);
                    d1.Low64 = Get64(bufQuo, 0);
                    d1.High = bufQuo[2];
                }

                if (d1.High == 0)
                {
                    d1.Low64 %= d2.Low64;
                    return;
                }
                else if ((d2.High | d2.Mid) == 0)
                {
                    uint den = d2.Low;
                    ulong tmp = ((ulong)d1.High << 32) | d1.Mid;
                    tmp = ((tmp % den) << 32) | d1.Low;
                    d1.Low64 = tmp % den;
                    d1.High = 0;
                }
                else
                {
                    VarDecModFull(d1, d2, scale);
                    return;
                }
            }
            while (scale < 0);
        }

        private static void VarDecModFull(DecCalc d1, DecCalc d2, int scale)
        {
            uint tmp = d2.High;
            if (tmp == 0)
            {
                tmp = d2.Mid;
            }

            int shift = LeadingZeroCount(tmp);

            uint[] b = new uint[7];
            Set64(b, 0, d1.Low64 << shift);
            Set64(b, 2, (d1.Mid + ((ulong)d1.High << 32)) >> (32 - shift));

            uint high = 3;
            while (scale < 0)
            {
                uint power = scale <= -MaxInt32Scale ? TenToPowerNine : UInt32Powers10(-scale);
                ulong tmp64 = BigMul(b[0], power);
                b[0] = (uint)tmp64;
                for (int i = 1; i <= high; i++)
                {
                    tmp64 >>= 32;
                    tmp64 += BigMul(b[i], power);
                    b[i] = (uint)tmp64;
                }

                if (tmp64 > int.MaxValue)
                {
                    b[++high] = (uint)(tmp64 >> 32);
                }

                scale += MaxInt32Scale;
            }

            if (d2.High == 0)
            {
                ulong divisor = d2.Low64 << shift;
                switch (high)
                {
                    case 6:
                        Div96By64(b, 4, divisor);
                        goto case 5;
                    case 5:
                        Div96By64(b, 3, divisor);
                        goto case 4;
                    case 4:
                        Div96By64(b, 2, divisor);
                        break;
                }

                Div96By64(b, 1, divisor);
                Div96By64(b, 0, divisor);

                d1.Low64 = Get64(b, 0) >> shift;
                d1.High = 0;
            }
            else
            {
                uint[] bufDivisor = new uint[3];
                Set64(bufDivisor, 0, d2.Low64 << shift);
                bufDivisor[2] = (uint)((d2.Mid + ((ulong)d2.High << 32)) >> (32 - shift));

                switch (high)
                {
                    case 6:
                        Div128By96(b, 3, bufDivisor);
                        goto case 5;
                    case 5:
                        Div128By96(b, 2, bufDivisor);
                        goto case 4;
                    case 4:
                        Div128By96(b, 1, bufDivisor);
                        break;
                }

                Div128By96(b, 0, bufDivisor);

                d1.Low64 = (Get64(b, 0) >> shift) + ((ulong)b[2] << (32 - shift) << 32);
                d1.High = b[2] >> shift;
            }
        }

        // MARK: Rounding

        // In place, by `scale` digits, in a MidpointRounding mode (0 to
        // even, 1 away from zero, 2 to zero, 3 down, 4 up).
        private static void InternalRound(DecCalc d, uint scale, int mode)
        {
            d.uflags -= scale << ScaleShift;

            uint remainder;
            uint sticky = 0;
            uint power;
            while (scale >= MaxInt32Scale)
            {
                scale -= MaxInt32Scale;

                const uint divisor = TenToPowerNine;
                uint n = d.uhi;
                if (n == 0)
                {
                    ulong tmp = d.Low64;
                    ulong div = tmp / divisor;
                    d.Low64 = div;
                    remainder = (uint)(tmp - div * divisor);
                }
                else
                {
                    uint q;
                    d.uhi = n / divisor;
                    remainder = n % divisor;
                    n = d.umid;
                    if ((n | remainder) != 0)
                    {
                        d.umid = q = (uint)((((ulong)remainder << 32) | n) / divisor);
                        remainder = n - q * divisor;
                    }

                    n = d.ulo;
                    if ((n | remainder) != 0)
                    {
                        d.ulo = q = (uint)((((ulong)remainder << 32) | n) / divisor);
                        remainder = n - q * divisor;
                    }
                }

                power = divisor;
                if (scale == 0)
                {
                    goto checkRemainder;
                }

                sticky |= remainder;
            }

            {
                power = UInt32Powers10((int)scale);
                uint n = d.uhi;
                if (n == 0)
                {
                    ulong tmp = d.Low64;
                    if (tmp == 0)
                    {
                        if (mode <= 2)
                        {
                            goto done;
                        }

                        remainder = 0;
                        goto checkRemainder;
                    }

                    ulong div = tmp / power;
                    d.Low64 = div;
                    remainder = (uint)(tmp - div * power);
                }
                else
                {
                    uint q;
                    d.uhi = n / power;
                    remainder = n % power;
                    n = d.umid;
                    if ((n | remainder) != 0)
                    {
                        d.umid = q = (uint)((((ulong)remainder << 32) | n) / power);
                        remainder = n - q * power;
                    }

                    n = d.ulo;
                    if ((n | remainder) != 0)
                    {
                        d.ulo = q = (uint)((((ulong)remainder << 32) | n) / power);
                        remainder = n - q * power;
                    }
                }
            }

        checkRemainder:
            if (mode == 2)
            {
                goto done;
            }
            else if (mode == 0)
            {
                remainder <<= 1;
                if ((sticky | d.ulo & 1) != 0)
                {
                    remainder++;
                }

                if (power >= remainder)
                {
                    goto done;
                }
            }
            else if (mode == 1)
            {
                remainder <<= 1;
                if (power > remainder)
                {
                    goto done;
                }
            }
            else if (mode == 3)
            {
                if ((remainder | sticky) == 0 || !d.IsNegative)
                {
                    goto done;
                }
            }
            else
            {
                if ((remainder | sticky) == 0 || d.IsNegative)
                {
                    goto done;
                }
            }

            {
                ulong low64 = d.Low64 + 1;
                d.Low64 = low64;
                if (low64 == 0)
                {
                    d.uhi++;
                }
            }

        done:
            return;
        }

        // MARK: Formatting

        // The low nine decimal digits of the 96-bit integer, divided out.
        internal static uint DecDivMod1E9(ref uint high, ref uint mid, ref uint low)
        {
            ulong high64 = ((ulong)high << 32) + mid;
            ulong div64 = high64 / TenToPowerNine;
            high = (uint)(div64 >> 32);
            mid = (uint)div64;

            ulong num = ((high64 - (uint)div64 * TenToPowerNine) << 32) + low;
            uint div = (uint)(num / TenToPowerNine);
            low = div;
            return (uint)num - div * TenToPowerNine;
        }
    }

    // decimal.Parse and TryParse: .NET's TryParseNumber with a NumberStyles
    // (NumberStyles.Number by default: white space around, a sign before or
    // after, a point, commas among the integer digits) and the invariant
    // culture's symbols (the currency symbol is ¤), then its
    // TryNumberToDecimal, which rounds past 29 digits half to even.
    internal static class DecimalParsing
    {
        private const int StateSign = 0x0001;
        private const int StateParens = 0x0002;
        private const int StateDigits = 0x0004;
        private const int StateNonZero = 0x0008;
        private const int StateDecimal = 0x0010;
        private const int StateCurrency = 0x0020;

        private const int AllowLeadingWhite = 0x01;
        private const int AllowTrailingWhite = 0x02;
        private const int AllowLeadingSign = 0x04;
        private const int AllowTrailingSign = 0x08;
        private const int AllowParentheses = 0x10;
        private const int AllowDecimalPoint = 0x20;
        private const int AllowThousands = 0x40;
        private const int AllowExponent = 0x80;
        private const int AllowCurrencySymbol = 0x100;
        private const int AllowHexSpecifier = 0x200;
        private const int AllowBinarySpecifier = 0x400;

        // NumberFormatInfo.ValidateParseStyleDecimal.
        internal static void Validate(int style)
        {
            if ((style & ~0x7FF) != 0)
            {
                throw new System.ArgumentException("An undefined NumberStyles value is being used.", "style");
            }

            if ((style & (AllowHexSpecifier | AllowBinarySpecifier)) != 0)
            {
                throw new System.ArgumentException(
                    "The number styles AllowHexSpecifier and AllowBinarySpecifier are not supported on the decimal type.", "style");
            }
        }

        private static bool IsWhite(uint ch) => ch == 0x20 || (ch - 0x09) <= (0x0D - 0x09);

        private static bool IsDigit(uint ch) => (ch - '0') <= 9;

        // 0 parsed, 1 badly formed, 2 out of range.
        internal static int TryParse(string text, int styles, bool partial, out Decimal result, out int consumed)
        {
            result = new Decimal(0, 0, 0);
            consumed = 0;
            var digits = new byte[31];
            int scale = 0;
            bool negative = false;
            bool nonZeroTail = false;
            int state = 0;
            int end = text.Length;
            int p = 0;
            bool currency = (styles & AllowCurrencySymbol) != 0;
            uint ch = p < end ? text[p] : 0u;

            while (true)
            {
                // "-¤ 1" is legal, "- 1" not: white space after a sign only
                // after a currency symbol too.
                if (!IsWhite(ch) || (styles & AllowLeadingWhite) == 0 || ((state & StateSign) != 0 && (state & StateCurrency) == 0))
                {
                    if ((styles & AllowLeadingSign) != 0 && (state & StateSign) == 0 && (ch == '+' || ch == '-'))
                    {
                        negative |= ch == '-';
                        state |= StateSign;
                    }
                    else if (ch == '(' && (styles & AllowParentheses) != 0 && (state & StateSign) == 0)
                    {
                        state |= StateSign | StateParens;
                        negative = true;
                    }
                    else if (currency && ch == 0xA4)
                    {
                        state |= StateCurrency;
                        currency = false;
                    }
                    else
                    {
                        break;
                    }
                }

                ch = ++p < end ? text[p] : 0u;
            }

            int digCount = 0;
            int digEnd = 0;
            const int maxDigCount = 30;
            while (true)
            {
                if (IsDigit(ch))
                {
                    state |= StateDigits;
                    if (ch != '0' || (state & StateNonZero) != 0)
                    {
                        if (digCount < maxDigCount)
                        {
                            digits[digCount] = (byte)ch;
                            digEnd = digCount + 1;
                        }
                        else if (ch != '0')
                        {
                            nonZeroTail = true;
                        }

                        if ((state & StateDecimal) == 0)
                        {
                            scale++;
                        }

                        digCount++;
                        state |= StateNonZero;
                    }
                    else if ((state & StateDecimal) != 0)
                    {
                        scale--;
                    }
                }
                else if ((styles & AllowDecimalPoint) != 0 && (state & StateDecimal) == 0 && ch == '.')
                {
                    state |= StateDecimal;
                }
                else if ((styles & AllowThousands) != 0 && (state & StateDigits) != 0 && (state & StateDecimal) == 0 && ch == ',')
                {
                }
                else
                {
                    break;
                }

                ch = ++p < end ? text[p] : 0u;
            }

            digits[digEnd] = 0;
            if ((state & StateDigits) == 0)
            {
                return 1;
            }

            if ((ch == 'E' || ch == 'e') && (styles & AllowExponent) != 0)
            {
                int mark = p;
                ch = ++p < end ? text[p] : 0u;
                bool negativeExponent = false;
                if (ch == '+')
                {
                    ch = ++p < end ? text[p] : 0u;
                }
                else if (ch == '-')
                {
                    ch = ++p < end ? text[p] : 0u;
                    negativeExponent = true;
                }

                if (IsDigit(ch))
                {
                    int exp = 0;
                    do
                    {
                        if (exp >= 100000000)
                        {
                            exp = int.MaxValue;
                            scale = 0;
                            while (IsDigit(ch))
                            {
                                ch = ++p < end ? text[p] : 0u;
                            }

                            break;
                        }

                        exp = (exp * 10) + (int)(ch - '0');
                        ch = ++p < end ? text[p] : 0u;
                    }
                    while (IsDigit(ch));

                    if (negativeExponent)
                    {
                        exp = -exp;
                    }

                    scale += exp;
                }
                else
                {
                    p = mark;
                    ch = p < end ? text[p] : 0u;
                }
            }

            while (true)
            {
                if (!IsWhite(ch) || (styles & AllowTrailingWhite) == 0)
                {
                    if ((styles & AllowTrailingSign) != 0 && (state & StateSign) == 0 && (ch == '+' || ch == '-'))
                    {
                        negative |= ch == '-';
                        state |= StateSign;
                    }
                    else if (ch == ')' && (state & StateParens) != 0)
                    {
                        state &= ~StateParens;
                    }
                    else if (currency && ch == 0xA4)
                    {
                        currency = false;
                    }
                    else
                    {
                        break;
                    }
                }

                ch = ++p < end ? text[p] : 0u;
            }

            if ((state & StateParens) != 0)
            {
                return 1;
            }

            int index = p;
            while (index < end && text[index] == '\0')
            {
                index++;
            }

            if (index != end && !partial)
            {
                return 1;
            }

            consumed = index;
            return ToDecimal(digits, scale, negative, nonZeroTail, out result) ? 0 : 2;
        }

        // .NET's TryNumberToDecimal.
        private static bool ToDecimal(byte[] digits, int e, bool sign, bool nonZeroTail, out Decimal value)
        {
            int p = 0;
            uint c = digits[p];
            if (c == 0)
            {
                int zeroScale = -e < 0 ? 0 : -e > 28 ? 28 : -e;
                value = new Decimal(0, 0, 0, sign, (byte)zeroScale);
                return true;
            }

            value = new Decimal(0, 0, 0);
            if (e > 29)
            {
                return false;
            }

            ulong low64 = 0;
            while (e > -28)
            {
                e--;
                low64 *= 10;
                low64 += c - '0';
                c = digits[++p];
                if (low64 >= ulong.MaxValue / 10)
                {
                    break;
                }

                if (c == 0)
                {
                    while (e > 0)
                    {
                        e--;
                        low64 *= 10;
                        if (low64 >= ulong.MaxValue / 10)
                        {
                            break;
                        }
                    }

                    break;
                }
            }

            uint high = 0;
            while ((e > 0 || (c != 0 && e > -28))
                   && (high < uint.MaxValue / 10
                       || (high == uint.MaxValue / 10 && (low64 < 0x9999999999999999 || (low64 == 0x9999999999999999 && c <= '5')))))
            {
                ulong tmpLow = (uint)low64 * 10UL;
                ulong tmp64 = ((uint)(low64 >> 32) * 10UL) + (tmpLow >> 32);
                low64 = (uint)tmpLow + (tmp64 << 32);
                high = (uint)(tmp64 >> 32) + (high * 10);

                if (c != 0)
                {
                    c -= '0';
                    low64 += c;
                    if (low64 < c)
                    {
                        high++;
                    }

                    c = digits[++p];
                }

                e--;
            }

            if (c >= '5')
            {
                bool round = true;
                if ((c == '5') && ((low64 & 1) == 0))
                {
                    c = digits[++p];
                    bool hasZeroTail = !nonZeroTail;
                    while ((c != 0) && hasZeroTail)
                    {
                        hasZeroTail &= c == '0';
                        c = digits[++p];
                    }

                    round = !hasZeroTail;
                }

                if (round && ++low64 == 0 && ++high == 0)
                {
                    low64 = 0x999999999999999A;
                    high = uint.MaxValue / 10;
                    e++;
                }
            }

            if (e > 0)
            {
                return false;
            }

            if (e <= -29)
            {
                value = new Decimal(0, 0, 0, sign, 28);
            }
            else
            {
                value = new Decimal((int)low64, (int)(low64 >> 32), (int)high, sign, (byte)-e);
            }

            return true;
        }
    }

    // UInt128 arithmetic for the floating-point conversions, on pairs of
    // ulongs.
    internal static class UInt128Math
    {
        public static int LeadingZeroCount(ulong high, ulong low) =>
            high != 0
                ? System.Numerics.BitOperations.LeadingZeroCount(high)
                : 64 + System.Numerics.BitOperations.LeadingZeroCount(low);

        public static void ShiftLeft(ulong high, ulong low, int shift, out ulong resultHigh, out ulong resultLow)
        {
            if (shift == 0)
            {
                resultHigh = high;
                resultLow = low;
            }
            else if (shift < 64)
            {
                resultHigh = (high << shift) | (low >> (64 - shift));
                resultLow = low << shift;
            }
            else if (shift < 128)
            {
                resultHigh = low << (shift - 64);
                resultLow = 0;
            }
            else
            {
                resultHigh = 0;
                resultLow = 0;
            }
        }

        public static void ShiftRight(ulong high, ulong low, int shift, out ulong resultHigh, out ulong resultLow)
        {
            if (shift == 0)
            {
                resultHigh = high;
                resultLow = low;
            }
            else if (shift < 64)
            {
                resultLow = (low >> shift) | (high << (64 - shift));
                resultHigh = high >> shift;
            }
            else if (shift < 128)
            {
                resultLow = high >> (shift - 64);
                resultHigh = 0;
            }
            else
            {
                resultHigh = 0;
                resultLow = 0;
            }
        }

        private static int Compare(ulong leftHigh, ulong leftLow, ulong rightHigh, ulong rightLow) =>
            leftHigh != rightHigh ? (leftHigh < rightHigh ? -1 : 1) : leftLow != rightLow ? (leftLow < rightLow ? -1 : 1) : 0;

        // .NET's RoundShiftRightEven: value / 2^shift, rounded to even.
        public static void RoundShiftRightEven(ulong high, ulong low, int shift, out ulong resultHigh, out ulong resultLow)
        {
            if (shift <= 0)
            {
                resultHigh = high;
                resultLow = low;
                return;
            }

            if (shift >= 128)
            {
                resultHigh = 0;
                resultLow = shift == 128 && Compare(high, low, 1UL << 63, 0) > 0 ? 1UL : 0UL;
                return;
            }

            ShiftRight(high, low, shift, out ulong quotientHigh, out ulong quotientLow);
            ShiftLeft(0, 1, shift, out ulong oneHigh, out ulong oneLow);
            ulong maskLow = oneLow - 1;
            ulong maskHigh = oneHigh - (oneLow == 0 ? 1UL : 0UL);
            ulong remainderHigh = high & maskHigh;
            ulong remainderLow = low & maskLow;
            ShiftLeft(0, 1, shift - 1, out ulong halfHigh, out ulong halfLow);

            int versus = Compare(remainderHigh, remainderLow, halfHigh, halfLow);
            if (versus > 0 || (versus == 0 && (quotientLow & 1) != 0))
            {
                quotientLow++;
                if (quotientLow == 0)
                {
                    quotientHigh++;
                }
            }

            resultHigh = quotientHigh;
            resultLow = quotientLow;
        }

        // Long division of 128-bit values, a bit at a time.
        public static void DivRem(
            ulong numeratorHigh, ulong numeratorLow, ulong denominatorHigh, ulong denominatorLow,
            out ulong quotientHigh, out ulong quotientLow, out ulong remainderHigh, out ulong remainderLow)
        {
            quotientHigh = 0;
            quotientLow = 0;
            remainderHigh = 0;
            remainderLow = 0;
            for (int bit = 127; bit >= 0; bit--)
            {
                remainderHigh = (remainderHigh << 1) | (remainderLow >> 63);
                remainderLow <<= 1;
                ulong next = bit >= 64 ? (numeratorHigh >> (bit - 64)) & 1 : (numeratorLow >> bit) & 1;
                remainderLow |= next;
                if (Compare(remainderHigh, remainderLow, denominatorHigh, denominatorLow) >= 0)
                {
                    ulong borrow = remainderLow < denominatorLow ? 1UL : 0UL;
                    remainderLow -= denominatorLow;
                    remainderHigh -= denominatorHigh + borrow;
                    if (bit >= 64)
                    {
                        quotientHigh |= 1UL << (bit - 64);
                    }
                    else
                    {
                        quotientLow |= 1UL << bit;
                    }
                }
            }
        }
    }
}

namespace System.Linq
{
    using System.Collections.Generic;

    // Enumerable's decimal aggregates, as .NET's: sums from zero, checked
    // as decimal addition always is; an array's or list's average its sum
    // over its length, another sequence's its first element plus the rest
    // over the count; the first of equal minimums and maximums.
    public static partial class Enumerable
    {
        public static decimal Sum(this IEnumerable<decimal> source)
        {
            Check(source, "source");
            decimal sum = 0;
            foreach (decimal value in source)
            {
                sum += value;
            }

            return sum;
        }

        public static decimal Sum<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal> selector)
        {
            Check(source, "source");
            Check(selector, "selector");
            decimal sum = 0;
            foreach (TSource value in source)
            {
                sum += selector(value);
            }

            return sum;
        }

        public static decimal Average(this IEnumerable<decimal> source)
        {
            Check(source, "source");
            if (source is decimal[] || source is List<decimal>)
            {
                int length = 0;
                decimal sum = 0;
                foreach (decimal value in source)
                {
                    sum += value;
                    length++;
                }

                return length == 0 ? throw NoElements() : sum / length;
            }

            using (IEnumerator<decimal> e = source.GetEnumerator())
            {
                if (!e.MoveNext())
                {
                    throw NoElements();
                }

                decimal total = e.Current;
                long count = 1;
                while (e.MoveNext())
                {
                    total += e.Current;
                    count++;
                }

                return total / count;
            }
        }

        public static decimal Average<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal> selector)
        {
            Check(source, "source");
            Check(selector, "selector");
            using (IEnumerator<TSource> e = source.GetEnumerator())
            {
                if (!e.MoveNext())
                {
                    throw NoElements();
                }

                decimal total = selector(e.Current);
                long count = 1;
                while (e.MoveNext())
                {
                    total += selector(e.Current);
                    count++;
                }

                return total / count;
            }
        }

        public static decimal Min(this IEnumerable<decimal> source)
        {
            Check(source, "source");
            using (IEnumerator<decimal> e = source.GetEnumerator())
            {
                if (!e.MoveNext())
                {
                    throw NoElements();
                }

                decimal value = e.Current;
                while (e.MoveNext())
                {
                    decimal x = e.Current;
                    if (x < value)
                    {
                        value = x;
                    }
                }

                return value;
            }
        }

        public static decimal Max(this IEnumerable<decimal> source)
        {
            Check(source, "source");
            using (IEnumerator<decimal> e = source.GetEnumerator())
            {
                if (!e.MoveNext())
                {
                    throw NoElements();
                }

                decimal value = e.Current;
                while (e.MoveNext())
                {
                    decimal x = e.Current;
                    if (x > value)
                    {
                        value = x;
                    }
                }

                return value;
            }
        }

        public static decimal Min<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal> selector) => Min(Selected(source, selector));

        public static decimal Max<TSource>(this IEnumerable<TSource> source, Func<TSource, decimal> selector) => Max(Selected(source, selector));

        // Generic in the result as Select is: an iterator class of
        // IEnumerable<decimal> would name System.Decimal, which the
        // runtime's Decimal stands for (Frontend.RuntimeCounterpart).
        private static IEnumerable<TResult> Selected<TSource, TResult>(IEnumerable<TSource> source, Func<TSource, TResult> selector)
        {
            Check(source, "source");
            Check(selector, "selector");
            return SelectedIterator(source, selector);
        }

        private static IEnumerable<TResult> SelectedIterator<TSource, TResult>(IEnumerable<TSource> source, Func<TSource, TResult> selector)
        {
            foreach (TSource element in source)
            {
                yield return selector(element);
            }
        }

        private static InvalidOperationException NoElements() =>
            new InvalidOperationException("Sequence contains no elements");

        private static void Check<T>(T argument, string name)
            where T : class
        {
            if (argument == null)
            {
                throw new ArgumentNullException(name);
            }
        }
    }
}
