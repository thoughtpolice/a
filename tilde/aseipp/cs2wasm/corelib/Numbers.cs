// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The conversions between the primitive numeric types that generic math's
// CreateChecked, CreateSaturating and CreateTruncating (and TryConvertFrom
// and TryConvertTo) make, with .NET's results: checked throws
// OverflowException out of range (and on NaN), saturating clamps (NaN is
// 0), truncating keeps an integer's low bits and converts a floating-point
// value as a cast does (which saturates). They convert to and from decimal
// too, as the primitive types' TryConvertTo<decimal> and
// TryConvertFrom<decimal> do. Other types convert to nothing here, as
// generic math's own types do not know each other. The native integers are
// 64 bits here (IntPtr.Size is 8), so they convert as long and ulong do.

namespace Gameplay.Runtime
{
    using System;

    internal static class Numbers
    {
        public const int Checked = 0;
        public const int Saturating = 1;
        public const int Truncating = 2;

        private const int None = 0;
        private const int Signed = 1;
        private const int Unsigned = 2;
        private const int Floating = 3;

        // What CreateChecked and its kin throw where neither type converts
        // the value (.NET's ThrowHelper.ThrowNotSupportedException).
        public static T Unsupported<T>() => throw new NotSupportedException("Specified method is not supported.");

        public static bool TryConvert<TFrom, TTo>(TFrom value, out TTo result, int mode)
        {
            result = default;
            if (typeof(TFrom) == typeof(decimal))
            {
                return FromDecimal((decimal)(object)value, out result, mode);
            }

            if (typeof(TFrom) == typeof(Int128))
            {
                return FromWide((UInt128)(Int128)(object)value, true, out result, mode);
            }

            if (typeof(TFrom) == typeof(UInt128))
            {
                return FromWide((UInt128)(object)value, false, out result, mode);
            }

            int kind = Read(value, out long signed, out ulong unsigned, out double floating);
            if (kind == None)
            {
                return false;
            }

            if (typeof(TTo) == typeof(double))
            {
                result = (TTo)(object)(kind == Signed ? signed : kind == Unsigned ? unsigned : floating);
                return true;
            }

            if (typeof(TTo) == typeof(float))
            {
                result = (TTo)(object)(kind == Signed ? signed : kind == Unsigned ? unsigned : (float)floating);
                return true;
            }

            if (typeof(TTo) == typeof(decimal))
            {
                result = (TTo)(object)Decimal(kind, signed, unsigned, floating, typeof(TFrom) == typeof(float) || typeof(TFrom) == typeof(Half), mode);
                return true;
            }

            // The 128-bit integers and Half, as the primitive types'
            // TryConvertTo know them: through their own conversions, the
            // checked ones for a checked conversion (a floating-point value
            // saturates otherwise, NaN to zero).
            if (typeof(TTo) == typeof(Int128))
            {
                result = (TTo)(object)(kind == Signed ? (Int128)signed
                    : kind == Unsigned ? (Int128)unsigned
                    : mode == Checked ? checked((Int128)floating) : (Int128)floating);
                return true;
            }

            if (typeof(TTo) == typeof(UInt128))
            {
                result = (TTo)(object)(kind == Signed
                    ? mode == Checked ? checked((UInt128)signed) : mode == Saturating && signed < 0 ? UInt128.Zero : (UInt128)(Int128)signed
                    : kind == Unsigned ? (UInt128)unsigned
                    : mode == Checked ? checked((UInt128)floating) : (UInt128)floating);
                return true;
            }

            if (typeof(TTo) == typeof(Half))
            {
                result = (TTo)(object)(kind == Signed ? (Half)signed : kind == Unsigned ? (Half)unsigned : (Half)floating);
                return true;
            }

            if (typeof(TTo) == typeof(sbyte))
            {
                result = (TTo)(object)unchecked((sbyte)Integer(kind, signed, unsigned, floating, sbyte.MinValue, (ulong)sbyte.MaxValue, mode));
            }
            else if (typeof(TTo) == typeof(byte))
            {
                result = (TTo)(object)unchecked((byte)Integer(kind, signed, unsigned, floating, 0, byte.MaxValue, mode));
            }
            else if (typeof(TTo) == typeof(short))
            {
                result = (TTo)(object)unchecked((short)Integer(kind, signed, unsigned, floating, short.MinValue, (ulong)short.MaxValue, mode));
            }
            else if (typeof(TTo) == typeof(ushort))
            {
                result = (TTo)(object)unchecked((ushort)Integer(kind, signed, unsigned, floating, 0, ushort.MaxValue, mode));
            }
            else if (typeof(TTo) == typeof(char))
            {
                result = (TTo)(object)unchecked((char)Integer(kind, signed, unsigned, floating, 0, char.MaxValue, mode));
            }
            else if (typeof(TTo) == typeof(int))
            {
                result = (TTo)(object)unchecked((int)Integer(kind, signed, unsigned, floating, int.MinValue, int.MaxValue, mode));
            }
            else if (typeof(TTo) == typeof(uint))
            {
                result = (TTo)(object)unchecked((uint)Integer(kind, signed, unsigned, floating, 0, uint.MaxValue, mode));
            }
            else if (typeof(TTo) == typeof(long))
            {
                result = (TTo)(object)unchecked((long)Integer(kind, signed, unsigned, floating, long.MinValue, long.MaxValue, mode));
            }
            else if (typeof(TTo) == typeof(ulong))
            {
                result = (TTo)(object)Integer(kind, signed, unsigned, floating, 0, ulong.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(nint))
            {
                result = (TTo)(object)unchecked((nint)(long)Integer(kind, signed, unsigned, floating, long.MinValue, long.MaxValue, mode));
            }
            else if (typeof(TTo) == typeof(nuint))
            {
                result = (TTo)(object)(nuint)Integer(kind, signed, unsigned, floating, 0, ulong.MaxValue, mode);
            }
            else
            {
                return false;
            }

            return true;
        }

        // A primitive number's value, as its kind says: a signed or unsigned
        // integer, or a floating-point value.
        private static int Read<T>(T value, out long signed, out ulong unsigned, out double floating)
        {
            signed = 0;
            unsigned = 0;
            floating = 0;
            if (typeof(T) == typeof(sbyte))
            {
                signed = (sbyte)(object)value;
                return Signed;
            }

            if (typeof(T) == typeof(short))
            {
                signed = (short)(object)value;
                return Signed;
            }

            if (typeof(T) == typeof(int))
            {
                signed = (int)(object)value;
                return Signed;
            }

            if (typeof(T) == typeof(long))
            {
                signed = (long)(object)value;
                return Signed;
            }

            if (typeof(T) == typeof(nint))
            {
                signed = (nint)(object)value;
                return Signed;
            }

            if (typeof(T) == typeof(byte))
            {
                unsigned = (byte)(object)value;
                return Unsigned;
            }

            if (typeof(T) == typeof(ushort))
            {
                unsigned = (ushort)(object)value;
                return Unsigned;
            }

            if (typeof(T) == typeof(char))
            {
                unsigned = (char)(object)value;
                return Unsigned;
            }

            if (typeof(T) == typeof(uint))
            {
                unsigned = (uint)(object)value;
                return Unsigned;
            }

            if (typeof(T) == typeof(ulong))
            {
                unsigned = (ulong)(object)value;
                return Unsigned;
            }

            if (typeof(T) == typeof(nuint))
            {
                unsigned = (nuint)(object)value;
                return Unsigned;
            }

            if (typeof(T) == typeof(float))
            {
                floating = (float)(object)value;
                return Floating;
            }

            if (typeof(T) == typeof(double))
            {
                floating = (double)(object)value;
                return Floating;
            }

            if (typeof(T) == typeof(Half))
            {
                // Exactly: a Half is a float's value.
                floating = (double)(Half)(object)value;
                return Floating;
            }

            return None;
        }

        // A 128-bit integer (its bits, and whether they are an Int128's) as
        // a primitive type, as the primitive types' TryConvertFrom<Int128>
        // and TryConvertFrom<UInt128> have it: checked throws out of the
        // type's range, saturating clamps, truncating keeps the low bits;
        // floating point and decimal as the 128-bit types' conversions to
        // them (decimal clamped to its range, but for checked).
        private static bool FromWide<TTo>(UInt128 bits, bool signed, out TTo result, int mode)
        {
            result = default;
            bool negative = signed && Int128.IsNegative((Int128)bits);
            if (typeof(TTo) == typeof(double))
            {
                result = (TTo)(object)(signed ? (double)(Int128)bits : (double)bits);
                return true;
            }

            if (typeof(TTo) == typeof(float))
            {
                result = (TTo)(object)(signed ? (float)(Int128)bits : (float)bits);
                return true;
            }

            if (typeof(TTo) == typeof(decimal))
            {
                var limit = new Int128(0x0000_0000_FFFF_FFFF, 0xFFFF_FFFF_FFFF_FFFF);
                if (mode != Checked && (negative ? (Int128)bits < -limit : bits > (UInt128)limit))
                {
                    result = (TTo)(object)(negative ? decimal.MinValue : decimal.MaxValue);
                }
                else
                {
                    result = (TTo)(object)(signed ? (decimal)(Int128)bits : (decimal)bits);
                }

                return true;
            }

            if (!Range<TTo>(out long minimum, out ulong maximum))
            {
                return false;
            }

            ulong low = (ulong)bits;
            bool below = negative && (Int128)bits < minimum;
            bool above = !negative && bits > maximum;
            if (below || above)
            {
                if (mode == Checked)
                {
                    throw new OverflowException("Arithmetic operation resulted in an overflow.");
                }

                if (mode == Saturating)
                {
                    low = below ? unchecked((ulong)minimum) : maximum;
                }
            }

            return Store(low, out result);
        }

        // An integer type's range, as the two's complement bits of its
        // least value and its greatest.
        private static bool Range<T>(out long minimum, out ulong maximum)
        {
            (minimum, maximum) = typeof(T) == typeof(sbyte) ? (sbyte.MinValue, (ulong)sbyte.MaxValue)
                : typeof(T) == typeof(byte) ? (0L, (ulong)byte.MaxValue)
                : typeof(T) == typeof(short) ? (short.MinValue, (ulong)short.MaxValue)
                : typeof(T) == typeof(ushort) ? (0L, (ulong)ushort.MaxValue)
                : typeof(T) == typeof(char) ? (0L, (ulong)char.MaxValue)
                : typeof(T) == typeof(int) ? (int.MinValue, (ulong)int.MaxValue)
                : typeof(T) == typeof(uint) ? (0L, (ulong)uint.MaxValue)
                : typeof(T) == typeof(long) || typeof(T) == typeof(nint) ? (long.MinValue, (ulong)long.MaxValue)
                : typeof(T) == typeof(ulong) || typeof(T) == typeof(nuint) ? (0L, ulong.MaxValue)
                : (1L, 0UL);
            return minimum <= 0;
        }

        // An integer type's value of the given bits (wrapping to its width).
        private static bool Store<T>(ulong bits, out T result)
        {
            result = default;
            if (typeof(T) == typeof(sbyte))
            {
                result = (T)(object)unchecked((sbyte)bits);
            }
            else if (typeof(T) == typeof(byte))
            {
                result = (T)(object)unchecked((byte)bits);
            }
            else if (typeof(T) == typeof(short))
            {
                result = (T)(object)unchecked((short)bits);
            }
            else if (typeof(T) == typeof(ushort))
            {
                result = (T)(object)unchecked((ushort)bits);
            }
            else if (typeof(T) == typeof(char))
            {
                result = (T)(object)unchecked((char)bits);
            }
            else if (typeof(T) == typeof(int))
            {
                result = (T)(object)unchecked((int)bits);
            }
            else if (typeof(T) == typeof(uint))
            {
                result = (T)(object)unchecked((uint)bits);
            }
            else if (typeof(T) == typeof(long))
            {
                result = (T)(object)unchecked((long)bits);
            }
            else if (typeof(T) == typeof(ulong))
            {
                result = (T)(object)bits;
            }
            else if (typeof(T) == typeof(nint))
            {
                result = (T)(object)unchecked((nint)(long)bits);
            }
            else if (typeof(T) == typeof(nuint))
            {
                result = (T)(object)(nuint)bits;
            }
            else
            {
                return false;
            }

            return true;
        }

        // A decimal as a primitive type, as the primitive types'
        // TryConvertFrom<decimal> have it: checked is decimal's explicit
        // conversion (which truncates, and throws out of range), the
        // others clamp to the type's range first.
        private static bool FromDecimal<TTo>(decimal value, out TTo result, int mode)
        {
            result = default;
            if (typeof(TTo) == typeof(double))
            {
                result = (TTo)(object)(double)value;
            }
            else if (typeof(TTo) == typeof(float))
            {
                result = (TTo)(object)(float)value;
            }
            else if (typeof(TTo) == typeof(sbyte))
            {
                result = (TTo)(object)(sbyte)Clamp(value, sbyte.MinValue, sbyte.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(byte))
            {
                result = (TTo)(object)(byte)Clamp(value, byte.MinValue, byte.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(short))
            {
                result = (TTo)(object)(short)Clamp(value, short.MinValue, short.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(ushort))
            {
                result = (TTo)(object)(ushort)Clamp(value, ushort.MinValue, ushort.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(char))
            {
                result = (TTo)(object)(char)Clamp(value, char.MinValue, char.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(int))
            {
                result = (TTo)(object)(int)Clamp(value, int.MinValue, int.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(uint))
            {
                result = (TTo)(object)(uint)Clamp(value, uint.MinValue, uint.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(long))
            {
                result = (TTo)(object)(long)Clamp(value, long.MinValue, long.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(ulong))
            {
                result = (TTo)(object)(ulong)Clamp(value, ulong.MinValue, ulong.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(nint))
            {
                result = (TTo)(object)(nint)(long)Clamp(value, long.MinValue, long.MaxValue, mode);
            }
            else if (typeof(TTo) == typeof(nuint))
            {
                result = (TTo)(object)(nuint)(ulong)Clamp(value, ulong.MinValue, ulong.MaxValue, mode);
            }
            else
            {
                return false;
            }

            return true;
        }

        private static decimal Clamp(decimal value, decimal minimum, decimal maximum, int mode) =>
            mode == Checked ? value : value >= maximum ? maximum : value <= minimum ? minimum : value;

        // The decimal a value converts to: an integer exactly, a
        // floating-point value as decimal's conversion from its type rounds
        // it (a float to 7 significant digits, a double to 15), and one out
        // of decimal's range (or NaN) as the primitive types'
        // TryConvertTo<decimal> have it: checked throws, the others clamp
        // (NaN is 0).
        private static decimal Decimal(int kind, long signed, ulong unsigned, double floating, bool single, int mode)
        {
            if (kind == Signed)
            {
                return signed;
            }

            if (kind == Unsigned)
            {
                return unsigned;
            }

            if (mode != Checked)
            {
                if (floating >= 79228162514264337593543950336.0)
                {
                    return decimal.MaxValue;
                }

                if (floating <= -79228162514264337593543950336.0)
                {
                    return decimal.MinValue;
                }

                if (double.IsNaN(floating))
                {
                    return 0.0m;
                }
            }

            return single ? (decimal)(float)floating : (decimal)floating;
        }

        // The integer in [minimum, maximum] a value converts to, as its
        // two's complement bits.
        private static ulong Integer(int kind, long signed, ulong unsigned, double floating, long minimum, ulong maximum, int mode)
        {
            if (kind == Floating)
            {
                if (double.IsNaN(floating))
                {
                    return mode == Checked ? throw new OverflowException("Arithmetic operation resulted in an overflow.") : 0UL;
                }

                double whole = Math.Truncate(floating);
                double above = maximum == ulong.MaxValue ? 18446744073709551616.0
                    : maximum == long.MaxValue ? 9223372036854775808.0
                    : (double)maximum + 1.0;
                if (whole < minimum)
                {
                    return mode == Checked ? throw new OverflowException("Arithmetic operation resulted in an overflow.") : unchecked((ulong)minimum);
                }

                if (whole >= above)
                {
                    return mode == Checked ? throw new OverflowException("Arithmetic operation resulted in an overflow.") : maximum;
                }

                return whole < 0 ? unchecked((ulong)(long)whole) : (ulong)whole;
            }

            if (kind == Signed)
            {
                if (signed < minimum || (signed > 0 && (ulong)signed > maximum))
                {
                    if (mode == Checked)
                    {
                        throw new OverflowException("Arithmetic operation resulted in an overflow.");
                    }

                    if (mode == Saturating)
                    {
                        return signed < minimum ? unchecked((ulong)minimum) : maximum;
                    }
                }

                return unchecked((ulong)signed);
            }

            if (unsigned > maximum)
            {
                if (mode == Checked)
                {
                    throw new OverflowException("Arithmetic operation resulted in an overflow.");
                }

                if (mode == Saturating)
                {
                    return maximum;
                }
            }

            return unsigned;
        }
    }
}
