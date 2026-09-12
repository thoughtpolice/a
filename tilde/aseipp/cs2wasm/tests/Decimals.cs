// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Numerics;

namespace Tests.Decimals
{
    public record Price(decimal Amount, string Currency);

    public struct Line
    {
        public decimal Quantity;
        public decimal Unit;

        public Line(decimal quantity, decimal unit)
        {
            Quantity = quantity;
            Unit = unit;
        }

        public decimal Total => Quantity * Unit;
    }

    public enum Level : short
    {
        Low = -2,
        High = 300,
    }

    public sealed class Account
    {
        public const decimal Fee = 2.50m;
        public static readonly decimal Rate = 0.0125m;
        public decimal Balance = 100.00m;

        public decimal Charge(decimal amount = 9.99m)
        {
            Balance -= amount + Fee;
            return Balance;
        }
    }

    // decimal against the CLR: its arithmetic's exact results, scales,
    // rounding and exceptions on values of every shape (integers, scaled
    // values, full 96-bit mantissas, scale 28, the extremes, midpoints),
    // conversions to and from every numeric type (the exact double
    // conversions of .NET 11), text in every format, parsing, rounding,
    // hashing, decimal in the language: constants, operators, patterns,
    // nullable, records, tuples, collections and LINQ, and decimal as a
    // generic math type argument. Results are digests of decimal.GetBits,
    // so scales count.
    public static class Decimals
    {
        private const int OverflowCode = 0x7F00001;
        private const int DivideByZeroCode = 0x7F00002;
        private const int FormatCode = 0x7F00003;
        private const int ArgumentCode = 0x7F00004;

        private static ulong state;

        private static ulong Next()
        {
            state = unchecked(state * 6364136223846793005UL + 1442695040888963407UL);
            ulong value = state;
            value ^= value >> 29;
            return value;
        }

        private static int Digest(string text)
        {
            if (text == null)
            {
                return -1;
            }

            int digest = text.Length;
            for (int index = 0; index < text.Length; index++)
            {
                digest = unchecked(digest * 31 + text[index]);
            }

            return digest;
        }

        private static int Mix(decimal value)
        {
            int[] bits = decimal.GetBits(value);
            return unchecked(((bits[0] * 31 + bits[1]) * 31 + bits[2]) * 31 + bits[3]);
        }

        private static int Combine(int digest, int value) => unchecked(digest * 1000003 + value);

        private static readonly decimal[] Boundaries =
        {
            decimal.MaxValue, decimal.MinValue, 0m, new decimal(0, 0, 0, true, 0), 0.0000m, new decimal(0, 0, 0, true, 28),
            1m, -1m, new decimal(1, 0, 0, false, 28), new decimal(1, 0, 0, true, 28), 0.5m, 2.5m, -2.5m, 1.5m,
            new decimal(-1, -1, -1, false, 28), new decimal(-1, -1, -1, true, 1), 7922816251426433759354395033.5m,
            0.3333333333333333333333333333m, 0.6666666666666666666666666667m, 1.0000000000000000000000000000m,
            100m, 100.00m, 1e-10m, 123456789012345678901234567.8m, 18446744073709551615m, 18446744073709551616m,
            4294967295m, 4294967296m, 9223372036854775807m, -9223372036854775808m, 9223372036854775808m,
            2147483647.5m, -2147483648.5m, 922337203685477.5807m, -922337203685477.5808m, 65535.99m, 255.5m,
            -128.9m, 0.00001m, 12345.6789m,
        };

        private static decimal Power10(int exponent)
        {
            decimal value = 1m;
            for (int index = 0; index < exponent; index++)
            {
                value *= 10m;
            }

            return value;
        }

        // A value of one of several shapes.
        private static decimal Random(int kind)
        {
            ulong bits = Next();
            bool negative = (bits & 1) != 0;
            switch (kind % 10)
            {
                case 0:
                    return (long)(bits % 2001) - 1000;
                case 1:
                    return new decimal((int)(bits % 100000), 0, 0, negative, (byte)((bits >> 20) % 6));
                case 2:
                    return new decimal((int)(bits >> 1), (int)(bits >> 33), (int)Next(), negative, (byte)(Next() % 29));
                case 3:
                    return new decimal((int)(bits >> 1), (int)(bits >> 33), (int)Next(), negative, (byte)((bits & 2) != 0 ? 28 : 0));
                case 4:
                    return Boundaries[(int)((bits >> 8) % (ulong)Boundaries.Length)];
                case 5:
                    return new decimal((int)(bits >> 1), (int)(bits >> 33), 0, negative, (byte)((bits >> 40) % 29));
                case 6:
                    decimal power = Power10((int)((bits >> 8) % 28));
                    return negative ? -power : power;
                case 7:
                    return new decimal((int)((bits >> 8) % 100000) * 10 + 5, 0, 0, negative, (byte)(1 + (bits >> 40) % 8));
                case 8:
                    return new decimal((int)(bits >> 16), 0, 0, negative, (byte)(20 + (bits >> 48) % 9));
                default:
                    return new decimal(-1, -1, (int)(bits >> 34) | 0x40000000, negative, (byte)((bits >> 8) % 29));
            }
        }

        private static void Seed(int seed)
        {
            state = (ulong)seed * 0x9E3779B97F4A7C15UL + 12345;
            Next();
        }

        private static decimal Operand() => Random((int)(Next() % 10));

        // MARK: Arithmetic

        private static int Apply(int op, decimal a, decimal b)
        {
            try
            {
                switch (op)
                {
                    case 0:
                        return Mix(a + b);
                    case 1:
                        return Mix(a - b);
                    case 2:
                        return Mix(a * b);
                    case 3:
                        return Mix(a / b);
                    default:
                        return Mix(a % b);
                }
            }
            catch (OverflowException)
            {
                return OverflowCode;
            }
            catch (DivideByZeroException)
            {
                return DivideByZeroCode;
            }
        }

        public static int Add(int seed)
        {
            Seed(seed);
            return Apply(0, Operand(), Operand());
        }

        public static int Subtract(int seed)
        {
            Seed(seed);
            return Apply(1, Operand(), Operand());
        }

        public static int Multiply(int seed)
        {
            Seed(seed);
            return Apply(2, Operand(), Operand());
        }

        public static int Divide(int seed)
        {
            Seed(seed);
            return Apply(3, Operand(), Operand());
        }

        public static int Remainder(int seed)
        {
            Seed(seed);
            return Apply(4, Operand(), Operand());
        }

        // The static methods, compound assignment, increments and negation.
        public static int Operators(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            decimal b = Operand();
            int digest = 0;
            try
            {
                digest = Combine(digest, Mix(decimal.Add(a, b)));
                digest = Combine(digest, Mix(decimal.Subtract(b, a)));
                digest = Combine(digest, Mix(decimal.Negate(a)));
                digest = Combine(digest, Mix(-b));
                digest = Combine(digest, Mix(+a));
                decimal c = a;
                c++;
                digest = Combine(digest, Mix(c));
                c--;
                --c;
                digest = Combine(digest, Mix(c));
                c += b;
                digest = Combine(digest, Mix(c));
                c -= 1.5m;
                digest = Combine(digest, Mix(c));
                c *= 0.1m;
                digest = Combine(digest, Mix(c));
                c /= 3;
                digest = Combine(digest, Mix(c));
                c %= 7.25m;
                digest = Combine(digest, Mix(c));
                digest = Combine(digest, Mix(decimal.Multiply(a, 3)));
                digest = Combine(digest, Mix(decimal.Divide(a, 8)));
                digest = Combine(digest, Mix(decimal.Remainder(b, 0.3m)));
            }
            catch (OverflowException)
            {
                digest = Combine(digest, OverflowCode);
            }
            catch (DivideByZeroException)
            {
                digest = Combine(digest, DivideByZeroCode);
            }

            return digest;
        }

        // MARK: Comparison and hashing

        public static int Compare(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            decimal b = (Next() & 3) == 0 ? a * 1.000m : Operand();
            int result = decimal.Compare(a, b) + 3;
            result = result * 2 + (a == b ? 1 : 0);
            result = result * 2 + (a != b ? 1 : 0);
            result = result * 2 + (a < b ? 1 : 0);
            result = result * 2 + (a <= b ? 1 : 0);
            result = result * 2 + (a > b ? 1 : 0);
            result = result * 2 + (a >= b ? 1 : 0);
            result = result * 2 + (a.Equals(b) ? 1 : 0);
            result = result * 2 + (a.Equals((object)b) ? 1 : 0);
            result = result * 2 + (decimal.Equals(a, b) ? 1 : 0);
            result = result * 4 + a.CompareTo(b) + 1;
            result = result * 4 + a.CompareTo((object)b) + 1;
            result = result * 2 + (a.GetHashCode() == b.GetHashCode() ? 1 : 0);
            return result;
        }

        public static int Hash(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            return Combine(a.GetHashCode(), (a / 3).GetHashCode());
        }

        // MARK: Conversions

        private static double RandomDouble(int kind)
        {
            ulong bits = Next();
            switch (kind % 7)
            {
                case 0:
                    return BitConverter.Int64BitsToDouble((long)bits);
                case 1:
                    // Near 1 and in the decimal range.
                    return BitConverter.Int64BitsToDouble((long)((bits & 0x800FFFFFFFFFFFFFUL) | (0x3A0UL + ((bits >> 52) % 0xC0)) << 52));
                case 2:
                    return (long)(bits % 2000001) - 1000000 + ((long)(bits >> 40) % 1000) / 1000.0;
                case 3:
                    return ((long)(bits % 10000001) - 5000000) / 128.0;
                case 4:
                    return (long)bits * 1e10;
                case 5:
                    return (bits % 1000) * 1e-25;
                default:
                    return (bits % 100) / 10.0 + 0.05;
            }
        }

        public static int FromDouble(int seed)
        {
            Seed(seed);
            double value = RandomDouble(seed);
            try
            {
                return Mix((decimal)value);
            }
            catch (OverflowException)
            {
                return OverflowCode;
            }
        }

        public static int FromSingle(int seed)
        {
            Seed(seed);
            float value = (float)RandomDouble(seed);
            try
            {
                return Combine(Mix((decimal)value), Mix(new decimal(value)));
            }
            catch (OverflowException)
            {
                return OverflowCode;
            }
        }

        public static double ToDouble(int seed)
        {
            Seed(seed);
            return (double)Operand();
        }

        public static double ToSingle(int seed)
        {
            Seed(seed);
            return decimal.ToSingle(Operand());
        }

        private static int Checked(Func<int> convert)
        {
            try
            {
                return convert();
            }
            catch (OverflowException)
            {
                return OverflowCode;
            }
        }

        public static int ToIntegers(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            if ((Next() & 1) == 0)
            {
                // Within the narrower types' ranges more often.
                a = decimal.Remainder(a, 70000m);
            }

            int digest = Checked(() => (int)a);
            digest = Combine(digest, Checked(() => (int)((long)a >> 7)));
            digest = Combine(digest, Checked(() => (int)(uint)a));
            digest = Combine(digest, Checked(() => (int)((ulong)a >> 5)));
            digest = Combine(digest, Checked(() => (short)a));
            digest = Combine(digest, Checked(() => (ushort)a));
            digest = Combine(digest, Checked(() => (byte)a));
            digest = Combine(digest, Checked(() => (sbyte)a));
            digest = Combine(digest, Checked(() => (char)a));
            digest = Combine(digest, Checked(() => decimal.ToInt32(a)));
            digest = Combine(digest, Checked(() => (int)decimal.ToInt64(a)));
            digest = Combine(digest, Checked(() => (int)decimal.ToOACurrency(a)));
            return digest;
        }

        public static int FromIntegers(int seed)
        {
            Seed(seed);
            ulong bits = Next();
            int digest = Mix((int)bits);
            digest = Combine(digest, Mix((long)bits));
            digest = Combine(digest, Mix((uint)bits));
            digest = Combine(digest, Mix(bits));
            digest = Combine(digest, Mix((short)bits));
            digest = Combine(digest, Mix((ushort)bits));
            digest = Combine(digest, Mix((byte)bits));
            digest = Combine(digest, Mix((sbyte)bits));
            digest = Combine(digest, Mix((char)bits));
            digest = Combine(digest, Mix(new decimal((long)bits)));
            digest = Combine(digest, Mix(new decimal((int)bits)));
            digest = Combine(digest, Mix(decimal.FromOACurrency((long)bits)));
            digest = Combine(digest, Mix(decimal.FromOACurrency((long)(bits % 1000000))));
            return digest;
        }

        // MARK: Rounding

        public static int Rounding(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            int decimals = (int)(Next() % 30);
            int digest = Mix(Math.Round(a));
            digest = Combine(digest, Mix(decimal.Round(a)));
            digest = Combine(digest, Mix(Math.Floor(a)));
            digest = Combine(digest, Mix(Math.Ceiling(a)));
            digest = Combine(digest, Mix(Math.Truncate(a)));
            digest = Combine(digest, Mix(decimal.Floor(a)));
            digest = Combine(digest, Mix(decimal.Ceiling(a)));
            digest = Combine(digest, Mix(decimal.Truncate(a)));
            try
            {
                digest = Combine(digest, Mix(Math.Round(a, decimals)));
                digest = Combine(digest, Mix(Math.Round(a, decimals, MidpointRounding.AwayFromZero)));
                digest = Combine(digest, Mix(Math.Round(a, decimals, MidpointRounding.ToZero)));
                digest = Combine(digest, Mix(decimal.Round(a, decimals, MidpointRounding.ToNegativeInfinity)));
                digest = Combine(digest, Mix(decimal.Round(a, decimals, MidpointRounding.ToPositiveInfinity)));
                digest = Combine(digest, Mix(decimal.Round(a, MidpointRounding.AwayFromZero)));
                digest = Combine(digest, Mix(Math.Round(a, MidpointRounding.ToEven)));
            }
            catch (ArgumentOutOfRangeException)
            {
                digest = Combine(digest, ArgumentCode);
            }

            return digest;
        }

        // MARK: Other members

        public static int Members(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            decimal b = Operand();
            int digest = Mix(Math.Abs(a));
            digest = Combine(digest, Mix(decimal.Abs(b)));
            digest = Combine(digest, Mix(Math.Max(a, b)));
            digest = Combine(digest, Mix(Math.Min(a, b)));
            digest = Combine(digest, Mix(decimal.Max(a, b)));
            digest = Combine(digest, Mix(decimal.Min(a, a * 1.0m)));
            digest = Combine(digest, Math.Sign(a));
            digest = Combine(digest, decimal.Sign(b));
            digest = Combine(digest, Mix(decimal.CopySign(a, b)));
            digest = Combine(digest, Mix(decimal.MaxMagnitude(a, b)));
            digest = Combine(digest, Mix(decimal.MinMagnitude(a, -a)));
            digest = Combine(digest, a.Scale);
            digest = Combine(digest, (decimal.IsInteger(a) ? 1 : 0) + (decimal.IsNegative(a) ? 2 : 0) + (decimal.IsPositive(a) ? 4 : 0)
                                     + (decimal.IsEvenInteger(a) ? 8 : 0) + (decimal.IsOddInteger(a) ? 16 : 0)
                                     + (decimal.IsCanonical(a) ? 32 : 0));
            try
            {
                digest = Combine(digest, Mix(Math.Clamp(a, Math.Min(b, 0m), Math.Max(b, 0m))));
                digest = Combine(digest, Mix(decimal.Clamp(a, b, 1m)));
            }
            catch (ArgumentException)
            {
                digest = Combine(digest, ArgumentCode);
            }

            int[] bits = decimal.GetBits(a);
            digest = Combine(digest, Mix(new decimal(bits)));
            bits[3] |= (int)(Next() & 0x00FF0000);
            try
            {
                digest = Combine(digest, Mix(new decimal(bits)));
            }
            catch (ArgumentException)
            {
                digest = Combine(digest, ArgumentCode);
            }

            return digest;
        }

        // MARK: Generic math

        private static T Polynomial<T>(T x)
            where T : INumber<T>
        {
            T two = T.One + T.One;
            T total = T.Zero;
            foreach (int coefficient in new[] { 3, -1, 2 })
            {
                total = checked(total * x + T.CreateChecked(coefficient));
            }

            T sum = T.AdditiveIdentity;
            T product = T.MultiplicativeIdentity;
            sum++;
            product--;
            return checked(total / two + x - T.One + sum * product % (two + two) + -(+x));
        }

        private static int Predicates<T>(T x)
            where T : INumberBase<T> =>
            (T.IsZero(x) ? 1 : 0) + (T.IsNaN(x) ? 2 : 0) + (T.IsFinite(x) ? 4 : 0) + (T.IsInfinity(x) ? 8 : 0)
            + (T.IsNormal(x) ? 16 : 0) + (T.IsSubnormal(x) ? 32 : 0) + (T.IsInteger(x) ? 64 : 0)
            + (T.IsEvenInteger(x) ? 128 : 0) + (T.IsOddInteger(x) ? 256 : 0) + (T.IsNegative(x) ? 512 : 0)
            + (T.IsPositive(x) ? 1024 : 0) + (T.IsCanonical(x) ? 2048 : 0) + (T.IsRealNumber(x) ? 4096 : 0)
            + (T.IsComplexNumber(x) ? 8192 : 0) + (T.IsImaginaryNumber(x) ? 16384 : 0)
            + (T.IsPositiveInfinity(x) ? 32768 : 0) + (T.IsNegativeInfinity(x) ? 65536 : 0) + T.Radix * 131072;

        private static T Extremes<T>(T x, T y, int which)
            where T : INumber<T>, ISignedNumber<T>, IMinMaxValue<T> => which switch
            {
                0 => T.Max(x, y),
                1 => T.Min(x, y),
                2 => T.MaxNumber(x, y),
                3 => T.MinNumber(x, y),
                4 => T.MaxMagnitude(x, y),
                5 => T.MinMagnitude(x, y),
                6 => T.MaxMagnitudeNumber(x, y),
                7 => T.MinMagnitudeNumber(x, y),
                8 => T.Clamp(x, T.Min(y, T.Zero), T.Max(y, T.Zero)),
                9 => T.CopySign(x, y),
                10 => T.Abs(x) + T.CreateChecked(T.Sign(y)),
                11 => T.MultiplyAddEstimate(x, T.NegativeOne, y),
                12 => T.MaxValue - T.Abs(T.Min(x, T.Zero)),
                _ => T.MinValue + T.Abs(T.Max(x, T.Zero)),
            };

        private static T Rounded<T>(T x, int which)
            where T : IFloatingPoint<T> => which switch
            {
                0 => T.Floor(x),
                1 => T.Ceiling(x),
                2 => T.Truncate(x),
                3 => T.Round(x),
                4 => T.Round(x, 2),
                5 => T.Round(x, MidpointRounding.AwayFromZero),
                6 => T.Round(x, 1, MidpointRounding.ToNegativeInfinity),
                7 => T.E * T.Pi / T.Tau,
                _ => T.Round(x, 3, MidpointRounding.ToZero),
            };

        private static int Layout<T>(T x)
            where T : IFloatingPoint<T>
        {
            Span<byte> bytes = stackalloc byte[12];
            int digest = x.GetExponentByteCount() * 7 + x.GetExponentShortestBitLength();
            digest = Combine(digest, x.GetSignificandByteCount() * 7 + x.GetSignificandBitLength());
            foreach (int which in new[] { 0, 1, 2, 3 })
            {
                int count;
                bool written = which switch
                {
                    0 => x.TryWriteExponentBigEndian(bytes, out count),
                    1 => x.TryWriteExponentLittleEndian(bytes, out count),
                    2 => x.TryWriteSignificandBigEndian(bytes, out count),
                    _ => x.TryWriteSignificandLittleEndian(bytes, out count),
                };
                digest = Combine(digest, written ? count : -1);
                for (int index = 0; index < count; index++)
                {
                    digest = Combine(digest, bytes[index]);
                }

                digest = Combine(digest, x.TryWriteSignificandBigEndian(bytes.Slice(0, 11), out _) ? 1 : 0);
            }

            return digest;
        }

        // T.CreateChecked, CreateSaturating or CreateTruncating of a value.
        private static string Create<TFrom, TTo>(TFrom value, int mode)
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
                return result.ToString();
            }
            catch (OverflowException)
            {
                return "overflow";
            }
        }

        private static string Conversions(decimal value, int mode) =>
            Create<decimal, sbyte>(value, mode) + "," + Create<decimal, byte>(value, mode) + ","
            + Create<decimal, short>(value, mode) + "," + Create<decimal, ushort>(value, mode) + ","
            + Create<decimal, int>(value, mode) + "," + Create<decimal, uint>(value, mode) + ","
            + Create<decimal, long>(value, mode) + "," + Create<decimal, ulong>(value, mode) + ","
            + Create<decimal, float>(value, mode) + "," + Create<decimal, double>(value, mode) + ","
            + Create<decimal, decimal>(value, mode) + "," + Create<decimal, BigInteger>(value, mode);

        private static string Creations(ulong bits, int mode) =>
            Create<sbyte, decimal>((sbyte)bits, mode) + "," + Create<byte, decimal>((byte)bits, mode) + ","
            + Create<short, decimal>((short)bits, mode) + "," + Create<ushort, decimal>((ushort)bits, mode) + ","
            + Create<char, decimal>((char)bits, mode) + "," + Create<int, decimal>((int)bits, mode) + ","
            + Create<uint, decimal>((uint)bits, mode) + "," + Create<long, decimal>((long)bits, mode) + ","
            + Create<ulong, decimal>(bits, mode) + ","
            + Create<float, decimal>(BitConverter.Int32BitsToSingle((int)(bits >> 32)) % 1e20f, mode) + ","
            + Create<double, decimal>((double)(long)bits / (1L << (int)(bits % 50)), mode) + ","
            + Create<BigInteger, decimal>(new BigInteger((long)bits) * (long)(bits >> 20), mode);

        // Number text is ASCII.
        private static byte[] Ascii(string text)
        {
            var bytes = new byte[text.Length];
            for (int index = 0; index < text.Length; index++)
            {
                bytes[index] = (byte)text[index];
            }

            return bytes;
        }

        private static T ParseAll<T>(string text)
            where T : INumberBase<T>
        {
            byte[] utf8 = Ascii(text);
            T total = T.Parse(text, NumberStyles.Number, CultureInfo.InvariantCulture);
            total += T.Parse(text.AsSpan(), NumberStyles.Number, CultureInfo.InvariantCulture);
            total += T.Parse(utf8, NumberStyles.Number, CultureInfo.InvariantCulture);
            total += T.TryParse(text, NumberStyles.Any, CultureInfo.InvariantCulture, out T parsed) ? parsed : T.One;
            total += T.TryParse(utf8, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) ? parsed : T.One;
            return total;
        }

        private static string Utf8Text<T>(T value)
            where T : IUtf8SpanFormattable
        {
            Span<byte> bytes = stackalloc byte[64];
            if (!value.TryFormat(bytes, out int count, "F3", CultureInfo.InvariantCulture))
            {
                return "short";
            }

            var chars = new char[count];
            for (int index = 0; index < count; index++)
            {
                chars[index] = (char)bytes[index];
            }

            return new string(chars);
        }

        public static int GenericMath(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            decimal b = Operand();
            int digest = Predicates(a);
            try
            {
                digest = Combine(digest, Mix(Polynomial(a)));
            }
            catch (OverflowException)
            {
                digest = Combine(digest, OverflowCode);
            }
            catch (DivideByZeroException)
            {
                digest = Combine(digest, DivideByZeroCode);
            }

            for (int which = 0; which < 14; which++)
            {
                try
                {
                    digest = Combine(digest, Mix(Extremes(a, b, which)));
                }
                catch (OverflowException)
                {
                    digest = Combine(digest, OverflowCode);
                }
                catch (ArgumentException)
                {
                    digest = Combine(digest, ArgumentCode);
                }
            }

            for (int which = 0; which < 9; which++)
            {
                digest = Combine(digest, Mix(Rounded(a, which)));
            }

            digest = Combine(digest, Layout(a));
            digest = Combine(digest, Digest(Utf8Text(a)));
            return digest;
        }

        public static int GenericConversions(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            ulong bits = Next();
            int digest = 0;
            for (int mode = 0; mode < 3; mode++)
            {
                digest = Combine(digest, Digest(Conversions(a, mode)));
                digest = Combine(digest, Digest(Creations(bits, mode)));
            }

            digest = Combine(digest, Digest(decimal.ConvertToInteger<int>(a) + "," + decimal.ConvertToIntegerNative<long>(a)));
            try
            {
                digest = Combine(digest, Mix(ParseAll<decimal>(a.ToString(CultureInfo.InvariantCulture))));
            }
            catch (OverflowException)
            {
                digest = Combine(digest, OverflowCode);
            }

            return digest;
        }

        // MARK: Text

        private static readonly string[] Formats =
        {
            null, "", "G", "g", "G0", "G1", "G5", "G15", "G29", "G30", "R", "F", "F0", "F2", "F10", "F28", "N", "N0", "N3",
            "E", "e2", "E0", "E28", "C", "C0", "P", "P3", "0.00", "#,##0.###", "0.###E+0", "#.#", "00000",
            "0.0;(0.0);zero", "#", "0", "0.##########################", "'x'0\\%", "#,##0,,", "D", "X",
        };

        public static int Text(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            int digest = Digest(a.ToString());
            digest = Combine(digest, Digest($"{a}"));
            digest = Combine(digest, Digest("[" + a + "]"));
            return digest;
        }

        public static int Format(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            string format = Formats[(int)(Next() % (ulong)Formats.Length)];
            try
            {
                return Digest(a.ToString(format));
            }
            catch (FormatException)
            {
                return FormatCode;
            }
        }

        public static int Interpolation(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            decimal? b = (Next() & 1) == 0 ? null : a / 7;
            return Digest($"{a:F3}|{a,12}|{a,-30:N2}|{a:0.00}|{a:E2}|{b}|{b:F1}");
        }

        private static readonly string[] Pieces =
        {
            "0", "1", "5", "9", "12", "000", ".", ",", "-", "+", " ", "\t", "e", "E5", "(", ")", "$", "7922816251", "4264337593",
            "5435", "0000000000", "\0", "x",
        };

        public static int Parse(int seed)
        {
            Seed(seed);
            string text;
            if ((Next() & 1) == 0)
            {
                decimal a = Operand();
                string[] shapes = { null, "F2", "F28", "N", "G", "0.#####" };
                text = a.ToString(shapes[(int)(Next() % 6)]);
                if ((Next() & 3) == 0)
                {
                    text = " " + text + "  ";
                }
            }
            else
            {
                text = "";
                int count = 1 + (int)(Next() % 6);
                for (int index = 0; index < count; index++)
                {
                    text += Pieces[(int)(Next() % (ulong)Pieces.Length)];
                }
            }

            int tried = decimal.TryParse(text, out decimal parsed) ? Mix(parsed) : -1;
            try
            {
                return Combine(tried, Mix(decimal.Parse(text)));
            }
            catch (FormatException)
            {
                return Combine(tried, FormatCode);
            }
            catch (OverflowException)
            {
                return Combine(tried, OverflowCode);
            }
        }

        // MARK: Styles, providers, spans and enums

        private static readonly string[] StylePieces =
        {
            "0", "1", "5", "9", "12", "000", ".", ",", "-", "+", " ", "e", "E", "e-", "E+", "(", ")", "\u00A4", "7922816251",
            "4264337593", "3", "\t", "x", "e30", "e-30",
        };

        // NumberStyles' flags, invalid ones included.
        public static int Styles(int seed)
        {
            Seed(seed);
            string text = "";
            int count = 1 + (int)(Next() % 6);
            for (int index = 0; index < count; index++)
            {
                text += StylePieces[(int)(Next() % (ulong)StylePieces.Length)];
            }

            var style = (NumberStyles)(int)(Next() % 0x1FF);
            if ((Next() & 7) == 0)
            {
                style |= (NumberStyles)(int)(0x200 << (int)(Next() % 3));
            }

            try
            {
                int tried = decimal.TryParse(text, style, CultureInfo.InvariantCulture, out decimal parsed) ? Mix(parsed) : -1;
                int spanned = decimal.TryParse(text.AsSpan(), style, NumberFormatInfo.InvariantInfo, out decimal spanParsed) ? Mix(spanParsed) : -1;
                return Combine(Combine(tried, spanned), Mix(decimal.Parse(text, style, null)));
            }
            catch (FormatException)
            {
                return FormatCode;
            }
            catch (OverflowException)
            {
                return OverflowCode;
            }
            catch (ArgumentException exception)
            {
                return Combine(ArgumentCode, Digest(exception.Message));
            }
        }

        // .NET 11's TryParsePartial: the number a text starts with, under
        // any NumberStyles, and how many characters it is.
        public static int PartialStyles(int seed)
        {
            Seed(seed);
            string text = "";
            int count = 1 + (int)(Next() % 7);
            for (int index = 0; index < count; index++)
            {
                text += StylePieces[(int)(Next() % (ulong)StylePieces.Length)];
            }

            var style = (NumberStyles)(int)(Next() % 0x1FF);
            try
            {
                int partial = decimal.TryParsePartial(text, style, CultureInfo.InvariantCulture, out decimal parsed, out int consumed)
                    ? Combine(Mix(parsed), consumed)
                    : Combine(-1, consumed);
                int spanned = decimal.TryParsePartial(text.AsSpan(), style, null, out decimal spanParsed, out int spanConsumed)
                    ? Combine(Mix(spanParsed), spanConsumed)
                    : -1;
                return Combine(partial, spanned);
            }
            catch (ArgumentException exception)
            {
                return Combine(ArgumentCode, Digest(exception.Message));
            }
        }

        public static int Providers(int seed)
        {
            Seed(seed);
            decimal a = Operand();
            string format = Formats[(int)(Next() % (ulong)Formats.Length)];
            IFormatProvider provider = (Next() % 3) switch
            {
                0 => CultureInfo.InvariantCulture,
                1 => NumberFormatInfo.InvariantInfo,
                _ => null,
            };
            Span<char> buffer = new char[40];
            try
            {
                int digest = Digest(a.ToString(format, provider));
                digest = Combine(digest, Digest(a.ToString(provider)));
                bool written = a.TryFormat(buffer, out int length, format, provider);
                digest = Combine(digest, written ? Digest(new string(buffer.Slice(0, length))) : -length);
                digest = Combine(digest, a.TryFormat(buffer.Slice(0, (int)(Next() % 8)), out int shortLength) ? shortLength : -1);
                string text = a.ToString(CultureInfo.InvariantCulture);
                digest = Combine(digest, Mix(decimal.Parse(text, provider)) + Mix(decimal.Parse(text.AsSpan(), provider)));
                digest = Combine(digest, decimal.TryParse(text, provider, out decimal again) ? Mix(again) : -1);
                return digest;
            }
            catch (FormatException)
            {
                return FormatCode;
            }
        }

        public static int Enums(int x)
        {
            decimal fromEnum = (decimal)(Level)x + (decimal)Level.High;
            int digest = Mix(fromEnum);
            try
            {
                digest = Combine(digest, (int)(Level)(x * 1.5m));
                digest = Combine(digest, (int)(Level?)(x * 101.25m));
                decimal? nullable = x == 0 ? null : (decimal?)(Level)x;
                digest = Combine(digest, nullable.HasValue ? Mix(nullable.Value) : -1);
            }
            catch (OverflowException exception)
            {
                digest = Combine(digest, Digest(exception.Message));
            }

            return digest;
        }

        // MARK: Messages

        public static int Messages(int which)
        {
            try
            {
                switch (which)
                {
                    case 0:
                        return Mix(decimal.MaxValue + which + 1);
                    case 1:
                        return (int)(decimal.MaxValue / (which + 1));
                    case 2:
                        return (int)(long)(decimal.MinValue / which);
                    case 3:
                        return (byte)(100m * which);
                    case 4:
                        return (sbyte)(-50m * which);
                    case 5:
                        return (short)(8000m * which);
                    case 6:
                        return (ushort)(-1m * which);
                    case 7:
                        return (int)(uint)(-1m * which);
                    case 8:
                        return (int)(ulong)(-1m * which);
                    case 9:
                        return (char)(8000m * which);
                    case 10:
                        return (int)decimal.ToOACurrency(decimal.MaxValue - which);
                    case 11:
                        return Mix(decimal.Parse("99999999999999999999999999999" + which));
                    case 12:
                        return Mix((decimal)(double.MaxValue / which));
                    case 13:
                        return Mix((decimal)(float.NaN * which));
                    case 14:
                        return Mix(1m / (which - 14));
                    case 15:
                        return Mix(decimal.MinValue * which);
                    case 16:
                        return Mix(decimal.Round(1m, which + 13));
                    case 17:
                        return Mix(Math.Clamp(1m, 2.50m + which, 1m));
                    case 18:
                        return Mix(new decimal(new[] { 1, 2, 3, 0x1D0000 + which }));
                    case 19:
                        return Mix(new decimal(1, 2, 3, false, (byte)(10 + which)));
                    case 20:
                        return 3m.CompareTo((object)which);
                    case 22:
                        return Mix(decimal.Parse("1.2." + which));
                    default:
                        return Mix(decimal.Round(1m, 2, (MidpointRounding)which));
                }
            }
            catch (Exception exception)
            {
                return Combine(Digest(exception.Message), exception.InnerException is { } inner ? Digest(inner.Message) : 0);
            }
        }

        // Uncaught: the checks' faults.
        public static int Faults(int which)
        {
            decimal zero = which * 0m;
            switch (which)
            {
                case 0:
                    return (int)(1m / zero);
                case 1:
                    return (int)(decimal.MaxValue * (which + 2));
                case 2:
                    return (int)(decimal.MaxValue - which);
                default:
                    return (int)(1m % zero);
            }
        }

        // MARK: The language

        private static decimal Tax(decimal amount, decimal rate = 0.08m) => decimal.Round(amount * rate, 2, MidpointRounding.AwayFromZero);

        private static T Larger<T>(T a, T b)
            where T : IComparable<T> => a.CompareTo(b) >= 0 ? a : b;

        private static string Grade(decimal score) => score switch
        {
            < 0m => "negative",
            0m => "zero",
            >= 90.0m and <= 100m => "A",
            >= 80m => "B",
            1.5m or 2.50m => "special",
            _ => "other",
        };

        public static int Language(int which)
        {
            switch (which)
            {
                case 0:
                {
                    var account = new Account();
                    account.Charge();
                    account.Charge(Account.Rate * 1000);
                    return Mix(account.Balance);
                }

                case 1:
                {
                    decimal? missing = null;
                    decimal? present = 2.5m;
                    decimal? sum = missing + present;
                    decimal? product = present * 2;
                    int? count = 3;
                    decimal? converted = count;
                    return Combine(Combine(sum.HasValue ? 1 : 0, Mix(product.Value)), Mix(converted.Value + (present ?? 0m)))
                           + (present > 1m ? 7 : 0) + (missing < 1m ? 11 : 0);
                }

                case 2:
                {
                    var lines = new List<Line> { new Line(3, 1.25m), new Line(0.5m, 19.99m), new Line(12, 0.10m) };
                    decimal total = lines.Sum(line => line.Total);
                    decimal average = lines.Average(line => line.Unit);
                    return Combine(Combine(Mix(total), Mix(average)), Combine(Mix(lines.Max(line => line.Quantity)), Mix(lines.Min(line => line.Total))));
                }

                case 3:
                {
                    decimal[] values = { 3.5m, -1m, 2.50m, 2.5m, 0m, 10.001m, -1.00m };
                    Array.Sort(values);
                    int digest = 0;
                    foreach (decimal value in values)
                    {
                        digest = Combine(digest, Mix(value));
                    }

                    var ordered = values.OrderByDescending(value => value).ToList();
                    digest = Combine(digest, Mix(ordered[0]));
                    digest = Combine(digest, Mix(values.Sum()));
                    digest = Combine(digest, Mix(values.Average()));
                    digest = Combine(digest, Mix(values.Where(value => value > 0).Average()));
                    digest = Combine(digest, Mix(values.Max()));
                    digest = Combine(digest, Mix(values.Min()));
                    return digest;
                }

                case 4:
                {
                    var counts = new Dictionary<decimal, int>();
                    foreach (decimal value in new[] { 1m, 1.0m, 1.00m, 2m, 2.000m, -0m, 0m, 0.0m })
                    {
                        counts[value] = counts.TryGetValue(value, out int count) ? count + 1 : 1;
                    }

                    var set = new HashSet<decimal> { 5m, 5.0m, 5.00m, 6m };
                    int digest = counts.Count * 100 + set.Count;
                    foreach (var pair in counts)
                    {
                        digest = Combine(digest, Combine(Mix(pair.Key), pair.Value));
                    }

                    return digest;
                }

                case 5:
                {
                    var price = new Price(19.990m, "EUR");
                    var same = new Price(19.99m, "EUR");
                    var cheaper = price with { Amount = price.Amount - 5 };
                    return Combine(Combine(Digest(price.ToString()), price == same ? 1 : 0),
                        Combine(Digest(cheaper.ToString()), price.GetHashCode() == same.GetHashCode() ? 1 : 0));
                }

                case 6:
                {
                    (decimal Amount, int Count) pair = (1.50m, 2);
                    var other = (Amount: 1.5m, Count: 2);
                    var (amount, count) = pair;
                    return (pair == other ? 1 : 0) + (pair != (2m, 2) ? 2 : 0) + Mix(amount * count) * 4;
                }

                case 7:
                {
                    int digest = 0;
                    foreach (decimal score in new[] { -1m, 0.00m, 95m, 100.0m, 85m, 1.50m, 2.5m, 42m })
                    {
                        digest = Combine(digest, Digest(Grade(score)));
                    }

                    return digest;
                }

                case 8:
                {
                    object boxed = 12.50m;
                    object other = 12.5m;
                    int digest = Digest(boxed.GetType().ToString()) + Digest(boxed.GetType().Name);
                    digest = Combine(digest, boxed.Equals(other) ? 1 : 0);
                    digest = Combine(digest, boxed is decimal d && d == 12.5m ? 1 : 0);
                    digest = Combine(digest, boxed is 12.5m ? 1 : 0);
                    digest = Combine(digest, Mix((decimal)boxed));
                    digest = Combine(digest, Digest(boxed.ToString()));
                    digest = Combine(digest, boxed.GetHashCode());
                    IComparable<decimal> comparable = 3m;
                    digest = Combine(digest, comparable.CompareTo(2.99m));
                    return digest;
                }

                case 9:
                {
                    decimal total = 0;
                    for (int index = 1; index <= 20; index++)
                    {
                        total += Tax(index * 3.33m);
                    }

                    return Combine(Mix(total), Mix(Tax(10m, 0.075m)));
                }

                case 10:
                {
                    decimal x = Larger(1.10m, 1.1m);
                    decimal y = Larger(-5m, 4.999m);
                    int compare = Comparer<decimal>.Default.Compare(x, y) + 5;
                    bool equal = EqualityComparer<decimal>.Default.Equals(1.10m, 1.1m);
                    var sorted = new List<decimal> { 3m, 1.5m, 2m, 1.50m };
                    sorted.Sort();
                    return Combine(Combine(Mix(x), Mix(y)), Combine(compare, equal ? 1 : 0)) + Mix(sorted[0]) + sorted.IndexOf(1.5m) * 3;
                }

                case 11:
                {
                    const decimal third = 1m / 3m;
                    decimal[,] grid = new decimal[2, 2];
                    grid[1, 1] = third;
                    decimal[] row = new decimal[3];
                    row[1] += 0.5m;
                    row[2] = row[1]++;
                    return Combine(Combine(Mix(grid[1, 1]), Mix(grid[0, 0])), Combine(Mix(row[1]), Mix(row[2]))) + default(decimal).Scale;
                }

                case 12:
                {
                    decimal value = 1234567.891m;
                    string text = string.Concat("v=", value.ToString("N2"), ";", (-value).ToString("C"), ";", (value / 1000000).ToString("P1"));
                    return Digest(text) + Digest(string.Join(",", new[] { 1.5m, 2.25m }.Select(d => d.ToString("F3"))));
                }

                case 13:
                {
                    long big = long.MaxValue;
                    ulong bigger = ulong.MaxValue;
                    decimal sum = big + (decimal)bigger;
                    double d = 0.1;
                    float f = 0.1f;
                    return Combine(Combine(Mix(sum), Mix((decimal)d)), Combine(Mix((decimal)f), Mix((decimal)(d + f))));
                }

                default:
                {
                    decimal value = 0.1m;
                    int iterations = 0;
                    while (value < 1000000m)
                    {
                        value = value * 1.07m + 0.01m;
                        iterations++;
                    }

                    return Combine(iterations, Mix(value));
                }
            }
        }
    }
}
