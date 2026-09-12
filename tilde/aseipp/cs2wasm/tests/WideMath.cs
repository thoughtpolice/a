// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Generic math over the numeric types beyond the primitive ones the
// CoreLib's own generic math covers (tests/GenericMath.cs): the native
// integers (as long and ulong, corelib/GenericMath.cs), Int128, UInt128 and
// Half (dotnet/runtime's own sources, with the CoreLib's text,
// corelib/Int128.cs and corelib/Half.cs): operators and the numeric
// interfaces' statics through type parameters, the conversions between
// every pair of numeric types (checked, saturating and truncating), and
// the 128-bit integers' and Half's formatting and parsing, every Half
// value's shortest text included.

using System;
using System.Globalization;
using System.Numerics;

namespace Tests.WideMath
{
    public static class WideMath
    {
        private static long Digest(string text)
        {
            long digest = 17;
            foreach (char c in text)
            {
                digest = unchecked(digest * 31 + c);
            }

            return unchecked(digest * 31 + text.Length);
        }

        private static long Failure(Exception e) => e switch
        {
            OverflowException => -1,
            DivideByZeroException => -2,
            ArgumentOutOfRangeException => -3,
            ArgumentException => -4,
            FormatException => -5,
            NotSupportedException => -6,
            _ => -7,
        };

        private static long Text<T>(T value)
            where T : INumberBase<T> => Digest(value.ToString());

        private static T Sum<T>(T[] values)
            where T : INumber<T>
        {
            T total = T.Zero;
            foreach (T value in values)
            {
                total += value;
            }

            return total;
        }

        private static T Product<T>(T[] values)
            where T : INumber<T>
        {
            T total = T.One;
            for (int index = 0; index < values.Length; index++)
            {
                total *= values[index];
            }

            return total;
        }

        private static T Largest<T>(T[] values)
            where T : INumber<T>
        {
            T best = values[0];
            foreach (T value in values)
            {
                if (value > best)
                {
                    best = value;
                }
            }

            return best;
        }

        private static T Mix<T>(T a, T b)
            where T : IBinaryInteger<T>
        {
            T value = (a ^ b) | (a & T.One);
            value = (value << 3) >> 1;
            value++;
            value--;
            return value - (a % (b == T.Zero ? T.One : b)) + (+b) + (value >>> 2) + ~b;
        }

        // The integer statics and predicates.
        private static long Integer<T>(T value, T other)
            where T : IBinaryInteger<T>, IMinMaxValue<T>
        {
            long digest = Text(T.PopCount(value));
            digest = unchecked(digest * 31 + Text(T.LeadingZeroCount(value)));
            digest = unchecked(digest * 31 + Text(T.TrailingZeroCount(value)));
            digest = unchecked(digest * 31 + Text(T.RotateLeft(value, 5)));
            digest = unchecked(digest * 31 + Text(T.RotateRight(value, 67)));
            digest = unchecked(digest * 31 + (T.IsPow2(value) ? 1 : 2) + (T.IsNegative(value) ? 4 : 8) + (T.IsEvenInteger(value) ? 16 : 32));
            digest = unchecked(digest * 31 + Text(T.Min(value, other)) + Text(T.Max(value, other)) * 3);
            digest = unchecked(digest * 31 + Text(T.MaxMagnitude(value, other)) + Text(T.MinMagnitude(value, other)) * 3);
            digest = unchecked(digest * 31 + Text(T.Clamp(value, T.Min(other, T.Zero), T.Max(other, T.Zero))));
            digest = unchecked(digest * 31 + Text(T.MaxValue) + Text(T.MinValue) * 3 + Text(T.AllBitsSet) * 5);
            digest = unchecked(digest * 31 + T.Sign(value) + value.CompareTo(other) * 7 + (value.Equals(other) ? 11 : 13));
            if (!T.IsZero(other))
            {
                var (quotient, remainder) = T.DivRem(value, other);
                digest = unchecked(digest * 31 + Text(quotient) + Text(remainder) * 3);
            }

            if (T.IsPositive(value) && !T.IsZero(value))
            {
                digest = unchecked(digest * 31 + Text(T.Log2(value)));
            }

            try
            {
                digest = unchecked(digest * 31 + Text(T.Abs(value)));
            }
            catch (OverflowException)
            {
                digest = unchecked(digest * 31 - 1);
            }

            return digest;
        }

        // IBinaryInteger's byte-order members.
        private static long ByteOrder<T>(T value)
            where T : IBinaryInteger<T>, IMinMaxValue<T>
        {
            Span<byte> bytes = stackalloc byte[20];
            long digest = value.GetByteCount() + value.GetShortestBitLength() * 3;
            if (value.TryWriteLittleEndian(bytes, out int little))
            {
                foreach (byte b in bytes.Slice(0, little))
                {
                    digest = unchecked(digest * 31 + b);
                }

                digest = unchecked(digest * 31 + Text(T.ReadLittleEndian(bytes.Slice(0, little), !T.IsNegative(T.MinValue))));
            }

            if (value.TryWriteBigEndian(bytes, out int big))
            {
                foreach (byte b in bytes.Slice(0, big))
                {
                    digest = unchecked(digest * 31 + b);
                }

                digest = unchecked(digest * 31 + Text(T.ReadBigEndian(bytes.Slice(0, big), true)));
                digest = unchecked(digest * 31 + (T.TryReadBigEndian(bytes.Slice(0, 3), false, out T three) ? Text(three) : -1));
                digest = unchecked(digest * 31 + (T.TryReadLittleEndian(bytes.Slice(0, 17), false, out T wide) ? Text(wide) : -1));
            }

            return digest;
        }

        private static long Checked<T>(T a, T b)
            where T : IBinaryInteger<T>
        {
            long digest = 0;
            foreach (int op in new[] { 0, 1, 2, 3, 4 })
            {
                try
                {
                    T result = op switch
                    {
                        0 => checked(a + b),
                        1 => checked(a - b),
                        2 => checked(a * b),
                        3 => checked(-a),
                        _ => a / b,
                    };
                    digest = unchecked(digest * 31 + Text(result));
                }
                catch (Exception e)
                {
                    digest = unchecked(digest * 31 + Failure(e));
                }
            }

            return digest;
        }

        public static long NativeIntegers(int a)
        {
            nint[] values = { a, 3, -7, a / 2, (nint)a << 40 };
            long digest = Text(Sum(values)) + Text(Product(values)) * 3 + Text(Largest(values)) * 5 + Text(Mix((nint)a, (nint)(-5))) * 7;
            digest = unchecked(digest * 31 + Integer((nint)a, (nint)(-5)) + Integer((nint)a << 33, (nint)a) * 3);
            return unchecked(digest * 31 + Checked((nint)a << 32, (nint)a << 31) + Checked((nint)a, (nint)0) * 3);
        }

        public static long NativeUnsigned(int a)
        {
            nuint[] values = { (nuint)(uint)a, 3, 7, (nuint)(uint)a << 33 };
            long digest = Text(Sum(values)) + Text(Product(values)) * 3 + Text(Largest(values)) * 5 + Text(Mix((nuint)(uint)a, (nuint)5)) * 7;
            digest = unchecked(digest * 31 + Integer((nuint)(uint)a, (nuint)9) + Integer((nuint)(uint)a << 40, (nuint)(uint)a) * 3);
            return unchecked(digest * 31 + Checked((nuint)(uint)a << 32, (nuint)(uint)a << 31) + Checked((nuint)3, (nuint)(uint)a) * 3);
        }

        private static Int128 Wide(int a) => ((Int128)a << 90) + ((Int128)a * 1234567890123L) - 99;

        public static long WideIntegers(int a)
        {
            Int128[] values = { Wide(a), 3, -7, Wide(a) / 5, Int128.MaxValue / 3 };
            long digest = Text(Sum(values)) + Text(Product(values)) * 3 + Text(Largest(values)) * 5 + Text(Mix(Wide(a), (Int128)(-5))) * 7;
            digest = unchecked(digest * 31 + Integer(Wide(a), (Int128)(-5)) + Integer((Int128)a, Wide(a)) * 3 + Integer(Int128.MinValue, Wide(a)) * 5);
            digest = unchecked(digest * 31 + ByteOrder(Wide(a)) + ByteOrder(-Wide(a)) * 3);
            return unchecked(digest * 31 + Checked(Wide(a), Wide(a)) + Checked(Int128.MinValue, (Int128)a) * 3 + Checked(Wide(a), Int128.Zero) * 5);
        }

        public static long WideUnsigned(int a)
        {
            UInt128 w = (UInt128)Wide(a);
            UInt128[] values = { w, 3, 7, w / 5, UInt128.MaxValue / 3 };
            long digest = Text(Sum(values)) + Text(Product(values)) * 3 + Text(Largest(values)) * 5 + Text(Mix(w, (UInt128)5)) * 7;
            digest = unchecked(digest * 31 + Integer(w, (UInt128)9) + Integer((UInt128)(uint)a, w) * 3 + Integer(UInt128.MaxValue, w) * 5);
            digest = unchecked(digest * 31 + ByteOrder(w) + ByteOrder(UInt128.MaxValue - w) * 3);
            return unchecked(digest * 31 + Checked(w, w) + Checked((UInt128)(uint)a, w) * 3 + Checked(w, UInt128.Zero) * 5);
        }

        // The floating-point statics through a type parameter.
        private static long Floating<T>(T x, T y)
            where T : IBinaryFloatingPointIeee754<T>
        {
            long digest = Text(x + y) + Text(x - y) * 3 + Text(x * y) * 5 + Text(x / y) * 7 + Text(x % y) * 11;
            digest = unchecked(digest * 31 + Text(T.Abs(x)) + Text(T.Floor(x)) * 3 + Text(T.Ceiling(x)) * 5 + Text(T.Truncate(x)) * 7);
            digest = unchecked(digest * 31 + Text(T.Round(x)) + Text(T.Round(x, 1)) * 3 + Text(T.Round(x, MidpointRounding.AwayFromZero)) * 5);
            digest = unchecked(digest * 31 + Text(T.Sqrt(T.Abs(x))) + Text(T.FusedMultiplyAdd(x, y, T.One)) * 3);
            digest = unchecked(digest * 31 + Text(T.Min(x, y)) + Text(T.Max(x, y)) * 3 + Text(T.MinNumber(x, y)) * 5 + Text(T.MaxMagnitude(x, y)) * 7);
            digest = unchecked(digest * 31 + Text(T.CopySign(x, y)) + Text(T.BitIncrement(x)) * 3 + Text(T.BitDecrement(x)) * 5);
            digest = unchecked(digest * 31 + Text(T.ScaleB(x, 3)) + Text(T.Clamp(x, -T.One, T.One)) * 3 + Text(T.Lerp(x, y, T.One / (T.One + T.One))) * 5);
            digest = unchecked(digest * 31 + (T.IsNaN(x) ? 1 : 2) + (T.IsInfinity(x) ? 4 : 8) + (T.IsNegative(x) ? 16 : 32) + (T.IsSubnormal(x) ? 64 : 128)
                               + (T.IsNormal(x) ? 256 : 512) + (T.IsInteger(x) ? 1024 : 2048) + (T.IsFinite(x) ? 4096 : 8192) + (T.IsZero(x) ? 16384 : 32768));
            digest = unchecked(digest * 31 + x.CompareTo(y) + (x == y ? 3 : 5) + (x < y ? 7 : 11) + (x <= y ? 13 : 17) + (x.Equals(y) ? 19 : 23));
            if (T.IsFinite(x) && x != T.Zero)
            {
                digest = unchecked(digest * 31 + T.ILogB(x) + x.GetExponentShortestBitLength() * 3 + x.GetSignificandBitLength() * 5);
            }

            return digest;
        }

        private static readonly double[] Doubles =
        {
            0, -0.0, 1, -1, 0.5, 1.5, 2.5, -2.5, 3.14159, 1e-3, 6.1e-5, 5.96e-8, 2.98e-8, 1e-8, 65504, 65519.99, 65520, 1e5,
            double.PositiveInfinity, double.NegativeInfinity, double.NaN, 1234.5678, -0.1, 0.1, 2049, 4097,
        };

        public static long Halves(int i, int j)
        {
            Half x = (Half)Doubles[i % Doubles.Length];
            Half y = (Half)Doubles[j % Doubles.Length];
            Half[] values = { x, y, (Half)3, (Half)(-0.25) };
            long digest = Text(Sum(values)) + Text(Product(values)) * 3 + Text(Largest(values)) * 5;
            return unchecked(digest * 31 + Floating(x, y) + Text(Half.Epsilon) + Text(Half.MaxValue) * 3 + Text(Half.MinValue) * 5);
        }

        // Every Half value in a block of 256 by its bits: its shortest text,
        // which must read back as it, and a few standard formats.
        private static readonly string[] HalfFormats = { "R", "G3", "E2", "F3", "N1", "P0", "0.###", "e", "C" };

        public static long HalfTexts(int block)
        {
            long digest = 0;
            for (int bits = block * 256; bits < block * 256 + 256; bits++)
            {
                Half value = BitConverter.UInt16BitsToHalf((ushort)bits);
                string text = value.ToString();
                Half back = Half.Parse(text, CultureInfo.InvariantCulture);
                digest = unchecked(digest * 31 + Digest(text) + (BitConverter.HalfToUInt16Bits(back) == bits || Half.IsNaN(value) ? 1 : 2));
                digest = unchecked(digest * 31 + Digest(value.ToString(HalfFormats[bits % HalfFormats.Length], CultureInfo.InvariantCulture)));
                digest = unchecked(digest * 31 + Digest(((double)value).ToString("R", CultureInfo.InvariantCulture)) + Digest(((float)value).ToString()) * 3);
            }

            return digest;
        }

        private static readonly string[] HalfInputs =
        {
            "0", "-0", "1", "-1.5", "  2.5  ", "+3", "1e4", "65504", "65519.99", "65520", "65536", "1e5", "-1e5", "5.96e-8",
            "2.98e-8", "2.9802322387695312e-8", "2.9802322387695313e-8", "1.00048828125", "1.000488281250000000000000001",
            "1.00146484375", "0.1", "Infinity", "-Infinity", "NaN", "-nan", "+Infinity", " infinity ", "1,234.5", "(1)", "1-",
            "¤5", "", " ", "abc", "1.5x", "0x10", "1e", "1e+", ".5", "5.", "-.0", "1e-10000", "1e10000", "0.00001", "6.1e-5",
        };

        private static readonly NumberStyles[] Styles =
        {
            NumberStyles.Float | NumberStyles.AllowThousands, NumberStyles.Float, NumberStyles.Integer, NumberStyles.Any,
            NumberStyles.None, NumberStyles.Currency, NumberStyles.AllowDecimalPoint, NumberStyles.HexNumber,
            NumberStyles.AllowBinarySpecifier, (NumberStyles)0x10000,
        };

        public static long HalfParsing(int op, int i)
        {
            string text = HalfInputs[i % HalfInputs.Length];
            NumberStyles style = Styles[op % Styles.Length];
            long digest;
            try
            {
                digest = BitConverter.HalfToUInt16Bits(Half.Parse(text, style, CultureInfo.InvariantCulture));
            }
            catch (Exception e)
            {
                digest = Failure(e);
            }

            try
            {
                bool parsed = Half.TryParse(text, style, CultureInfo.InvariantCulture, out Half result);
                digest = unchecked(digest * 31 + (parsed ? BitConverter.HalfToUInt16Bits(result) : 11));
            }
            catch (Exception e)
            {
                digest = unchecked(digest * 31 + Failure(e));
            }

            return digest;
        }

        private static readonly string[] IntegerFormats =
        {
            null, "", "D", "d", "D45", "G", "g5", "R", "X", "x", "X40", "x1", "B", "b130", "N", "N0", "N3", "E", "e3", "E0",
            "F", "F2", "C", "C0", "P", "P1", "#,##0", "0.00e+0", "00000", "#", "0;(0);zero", "Q",
        };

        private static readonly Int128[] Wides =
        {
            0, 1, -1, 42, -42, long.MaxValue, long.MinValue, (Int128)ulong.MaxValue + 1, Int128.MaxValue, Int128.MinValue,
            Int128.MaxValue / 10, -(Int128.MaxValue / 7), (Int128)1 << 100, 12345678901234567890,
        };

        public static long WideFormatting(int op, int i)
        {
            Int128 a = Wides[i % Wides.Length];
            string format = IntegerFormats[op % IntegerFormats.Length];
            long digest;
            try
            {
                digest = Digest(a.ToString(format, CultureInfo.InvariantCulture));
                Span<char> destination = stackalloc char[200];
                bool fits = a.TryFormat(destination, out int written, format, CultureInfo.InvariantCulture);
                digest = unchecked(digest * 31 + (fits ? Digest(destination.Slice(0, written).ToString()) : -9));
            }
            catch (Exception e)
            {
                digest = Failure(e);
            }

            try
            {
                UInt128 u = (UInt128)a;
                digest = unchecked(digest * 31 + Digest(u.ToString(format, CultureInfo.InvariantCulture)));
                Span<byte> utf8 = stackalloc byte[200];
                bool fits = u.TryFormat(utf8, out int written, format, CultureInfo.InvariantCulture);
                digest = unchecked(digest * 31 + (fits ? written : -9));
            }
            catch (Exception e)
            {
                digest = unchecked(digest * 31 + Failure(e));
            }

            return unchecked(digest * 31 + Digest($"{a} {a:X} {a,45:N0}"));
        }

        private static readonly string[] IntegerInputs =
        {
            "0", "-0", "123", "-123", "  456  ", "+789", "1,234,567", "(42)", "12e3", "1.000", "1.5", "1e-2", "10e-1", "ff",
            "FF", "0F", "80", "7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "80000000000000000000000000000000", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            "170141183460469231731687303715884105727", "170141183460469231731687303715884105728", "-170141183460469231731687303715884105728",
            "-170141183460469231731687303715884105729", "340282366920938463463374607431768211455", "340282366920938463463374607431768211456",
            "3402823669209384634633746074317682114550", "-", "", " ", "1 2", "12abc", "¤100", "100-", "1e1000000000", "5\0\0", "1.0e2",
            "00000000000000000000000000000000000000000001", "101", "-0.0", "99999999999999999999999999999999999999999x",
        };

        public static long WideParsing(int op, int i)
        {
            string text = IntegerInputs[i % IntegerInputs.Length];
            NumberStyles style = Styles[op % Styles.Length] == (NumberStyles.Float | NumberStyles.AllowThousands)
                ? NumberStyles.Integer
                : Styles[op % Styles.Length];
            long digest;
            try
            {
                digest = Text(Int128.Parse(text, style, CultureInfo.InvariantCulture));
            }
            catch (Exception e)
            {
                digest = Failure(e) * 1000 + Digest(e.Message) % 1000;
            }

            try
            {
                bool parsed = Int128.TryParse(text.AsSpan(), style, CultureInfo.InvariantCulture, out Int128 result);
                digest = unchecked(digest * 31 + (parsed ? Text(result) : 11));
            }
            catch (Exception e)
            {
                digest = unchecked(digest * 31 + Failure(e));
            }

            try
            {
                digest = unchecked(digest * 31 + Text(UInt128.Parse(text, style, CultureInfo.InvariantCulture)));
            }
            catch (Exception e)
            {
                digest = unchecked(digest * 31 + Failure(e) * 1000 + Digest(e.Message) % 1000);
            }

            try
            {
                bool parsed = Int128.TryParsePartial(text, style, CultureInfo.InvariantCulture, out Int128 result, out int consumed);
                digest = unchecked(digest * 31 + (parsed ? Text(result) + consumed * 7 : 13));
                parsed = UInt128.TryParsePartial(text.AsSpan(), style, CultureInfo.InvariantCulture, out UInt128 unsigned, out consumed);
                digest = unchecked(digest * 31 + (parsed ? Text(unsigned) + consumed * 7 : 17));
            }
            catch (Exception e)
            {
                digest = unchecked(digest * 31 + Failure(e));
            }

            return digest;
        }

        // Every pair of numeric types, each conversion of a set of values
        // of the first (made from the seeds by saturating) to the second.
        private static readonly Int128[] IntegerSeeds =
        {
            0, 1, -1, 127, 128, 255, 256, -129, 32767, -32769, 65504, 65520, 65536, int.MaxValue, (Int128)int.MaxValue + 1,
            uint.MaxValue, long.MaxValue, long.MinValue, ulong.MaxValue, (Int128)ulong.MaxValue + 1, Int128.MaxValue, Int128.MinValue,
            ((Int128)1 << 96) + 12345,
        };

        private static readonly double[] FloatingSeeds =
        {
            0, -0.0, 0.5, -0.5, 1.5, -1.5, 255.5, 65519.99, 65520, 1e10, -1e10, 1e20, 3e38, 1e39, -1e39, 8e28, 1e30,
            9.3e18, -9.3e18, 1.8e19, 1.7e38, 3.5e38, 5.96e-8, 1e-300, double.NaN, double.PositiveInfinity, double.NegativeInfinity,
        };

        private static long To<TFrom, TTo>(TFrom value, int mode)
            where TFrom : INumberBase<TFrom>
            where TTo : INumberBase<TTo>
        {
            try
            {
                TTo result = mode switch
                {
                    0 => TTo.CreateChecked(value),
                    1 => TTo.CreateSaturating(value),
                    _ => TTo.CreateTruncating(value),
                };
                return Text(result);
            }
            catch (Exception e)
            {
                return Failure(e);
            }
        }

        private static long From<TFrom>(TFrom value, int to, int mode)
            where TFrom : INumberBase<TFrom> => to switch
        {
            0 => To<TFrom, sbyte>(value, mode),
            1 => To<TFrom, byte>(value, mode),
            2 => To<TFrom, short>(value, mode),
            3 => To<TFrom, ushort>(value, mode),
            4 => To<TFrom, int>(value, mode),
            5 => To<TFrom, uint>(value, mode),
            6 => To<TFrom, long>(value, mode),
            7 => To<TFrom, ulong>(value, mode),
            8 => To<TFrom, nint>(value, mode),
            9 => To<TFrom, nuint>(value, mode),
            10 => To<TFrom, Int128>(value, mode),
            11 => To<TFrom, UInt128>(value, mode),
            12 => To<TFrom, Half>(value, mode),
            13 => To<TFrom, float>(value, mode),
            14 => To<TFrom, double>(value, mode),
            15 => To<TFrom, decimal>(value, mode),
            _ => To<TFrom, char>(value, mode),
        };

        private static long Seeded<TFrom>(int to, int mode, bool floating)
            where TFrom : INumberBase<TFrom>
        {
            long digest = 0;
            if (floating)
            {
                foreach (double seed in FloatingSeeds)
                {
                    digest = unchecked(digest * 31 + From(TFrom.CreateSaturating(seed), to, mode));
                }
            }

            foreach (Int128 seed in IntegerSeeds)
            {
                digest = unchecked(digest * 31 + From(TFrom.CreateSaturating(seed), to, mode));
            }

            return digest;
        }

        public static long Conversions(int from, int to, int mode) => from switch
        {
            0 => Seeded<sbyte>(to, mode, false),
            1 => Seeded<byte>(to, mode, false),
            2 => Seeded<short>(to, mode, false),
            3 => Seeded<ushort>(to, mode, false),
            4 => Seeded<int>(to, mode, false),
            5 => Seeded<uint>(to, mode, false),
            6 => Seeded<long>(to, mode, false),
            7 => Seeded<ulong>(to, mode, false),
            8 => Seeded<nint>(to, mode, false),
            9 => Seeded<nuint>(to, mode, false),
            10 => Seeded<Int128>(to, mode, false),
            11 => Seeded<UInt128>(to, mode, false),
            12 => Seeded<Half>(to, mode, true),
            13 => Seeded<float>(to, mode, true),
            14 => Seeded<double>(to, mode, true),
            15 => Seeded<decimal>(to, mode, true),
            _ => Seeded<char>(to, mode, false),
        };
    }
}
