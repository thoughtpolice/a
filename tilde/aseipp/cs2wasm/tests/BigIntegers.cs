// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.Numerics.BigInteger (dotnet/runtime's, compiled into the gameplay
// CoreLib, with the CoreLib's own text; docs/IMPORTER.md,
// "System.Runtime.Numerics as built") against the CLR's: arithmetic on
// values of every size and sign, shifts and bitwise operations on negative
// numbers, powers, modular powers, greatest common divisors, logarithms,
// conversions to and from the primitives, decimal and Int128, bytes,
// comparison, generic math, formatting and parsing. A case's result is a
// digest of the value's two's complement bytes, or of the text.

using System;
using System.Globalization;
using System.Numerics;

namespace Tests.BigIntegers
{
    public static class BigIntegers
    {
        private static BigInteger Value(int which)
        {
            switch (which)
            {
                case 0: return BigInteger.Zero;
                case 1: return BigInteger.One;
                case 2: return BigInteger.MinusOne;
                case 3: return int.MaxValue;
                case 4: return int.MinValue;
                case 5: return long.MaxValue;
                case 6: return long.MinValue;
                case 7: return ulong.MaxValue;
                case 8: return BigInteger.One << 64;
                case 9: return -(BigInteger.One << 64);
                case 10: return (BigInteger.One << 127) - 1;
                case 11: return -(BigInteger.One << 128);
                case 12: return BigInteger.Pow(10, 30) + 7;
                case 13: return -BigInteger.Pow(10, 40);
                case 14: return BigInteger.Pow(3, 200);
                case 15: return -BigInteger.Pow(7, 150);
                case 16: return (BigInteger.One << 256) - 1;
                case 17: return (BigInteger.One << 512) - 12345;
                case 18: return BigInteger.Parse("-123456789012345678901234567890123456789012345678901234567890");
                case 19: return 1000000007;
                case 20: return -65536;
                case 21: return 12345;
                case 22: return BigInteger.Pow(2, 1000) + BigInteger.Pow(3, 500);
                case 23: return -(BigInteger.Pow(5, 400) - 1);
                default: return new BigInteger(which * 7919L - 100000L) * BigInteger.Pow(11, which % 37);
            }
        }

        private static long Digest(BigInteger value)
        {
            long digest = 17;
            foreach (byte b in value.ToByteArray())
            {
                digest = unchecked(digest * 31 + b);
            }

            return unchecked(digest * 31 + value.Sign);
        }

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
            DivideByZeroException => -1,
            OverflowException => -2,
            ArgumentOutOfRangeException => -3,
            ArgumentException => -4,
            FormatException => -5,
            _ => -6,
        };

        public static long Arithmetic(int op, int i, int j)
        {
            BigInteger a = Value(i);
            BigInteger b = Value(j);
            try
            {
                switch (op)
                {
                    case 0: return Digest(a + b);
                    case 1: return Digest(a - b);
                    case 2: return Digest(a * b);
                    case 3: return Digest(a / b);
                    case 4: return Digest(a % b);
                    case 5:
                        BigInteger quotient = BigInteger.DivRem(a, b, out BigInteger remainder);
                        return unchecked(Digest(quotient) * 7 + Digest(remainder));
                    case 6: return Digest(BigInteger.Pow(a, j % 13));
                    case 7: return Digest(BigInteger.ModPow(a, BigInteger.Abs(b) % 1000, Value((i + j) % 24) + 3));
                    case 8: return Digest(a << (j * 13 % 300 - 100));
                    case 9: return Digest(a >> (j * 13 % 300 - 100));
                    case 10: return Digest(a & b);
                    case 11: return Digest(a | b);
                    case 12: return Digest(a ^ b);
                    case 13: return Digest(~a);
                    case 14: return Digest(-a) + Digest(BigInteger.Abs(a)) * 3 + Digest(BigInteger.Negate(b)) * 5;
                    case 15: return Digest(BigInteger.GreatestCommonDivisor(a, b));
                    case 16: return Digest(BigInteger.Min(a, b)) + Digest(BigInteger.Max(a, b)) * 3;
                    case 17: return a.CompareTo(b) * 9 + (a == b ? 1 : 0) + (a < b ? 2 : 0) + (a.Equals(b) ? 4 : 0);
                    case 18: return (a.IsPowerOfTwo ? 1 : 0) + (a.IsEven ? 2 : 0) + (a.IsOne ? 4 : 0) + (a.IsZero ? 8 : 0) + a.Sign * 16;
                    case 19: return Digest(BigInteger.Remainder(a, b)) + Digest(BigInteger.Divide(a, b)) * 3;
                    case 20: return Digest(a * a - b * b) + Digest((a + b) * (a - b));
                    case 21: return Digest(BigInteger.RotateLeft(a, j * 7 % 200 - 20)) + Digest(BigInteger.RotateRight(a, j * 3 % 130));
                    case 22: return (long)BigInteger.PopCount(a) + (long)BigInteger.LeadingZeroCount(a) * 1000 + (long)BigInteger.TrailingZeroCount(a) * 1000000;
                    case 23: return Digest(a++) + Digest(a) * 3 + Digest(--b) * 7;
                    case 24: return Digest(BigInteger.Clamp(b, BigInteger.Min(a, 5), BigInteger.Max(a, 5))) + Digest(BigInteger.CopySign(a, b));
                    case 25: return Digest(BigInteger.MaxMagnitude(a, b)) + Digest(BigInteger.MinMagnitude(a, b)) * 3;
                    case 26: return Digest(a >>> (j * 5 % 100)) + Digest(BigInteger.Abs(a) >>> 3);
                    case 27: return Digest(BigInteger.ModPow(a, 65537, BigInteger.Pow(2, 521) - 1));
                    default: return a.GetBitLength() * 1000 + a.GetByteCount() + a.GetByteCount(isUnsigned: a.Sign >= 0) * 100000;
                }
            }
            catch (Exception e)
            {
                return Failure(e);
            }
        }

        public static double Logarithms(int op, int i)
        {
            BigInteger a = BigInteger.Abs(Value(i)) + 1;
            return op switch
            {
                0 => BigInteger.Log(a),
                1 => BigInteger.Log10(a),
                2 => BigInteger.Log(a, 3.5),
                3 => BigInteger.Log(-Value(i)),
                4 => (double)Value(i),
                5 => (double)(float)Value(i),
                _ => BigInteger.Log(a, 2),
            };
        }

        private static readonly double[] Doubles =
        {
            0.0, -0.0, 1.5, -1.5, 1e20, -3.7e25, 1.7976931348623157e308, 4.9e-324, 123456789.987, double.NaN,
            double.PositiveInfinity, 9007199254740993.0, 2e18, -9.2233720368547758e18, 0.999999,
        };

        public static long Conversions(int op, int i)
        {
            BigInteger a = Value(i);
            try
            {
                switch (op)
                {
                    case 0: return (long)a;
                    case 1: return (long)(ulong)a;
                    case 2: return (int)a;
                    case 3: return (long)(uint)a + (short)a * 100000000000L;
                    case 4: return Digest(((decimal)a).ToString(CultureInfo.InvariantCulture));
                    case 5: return Digest(new BigInteger((decimal)i * 1234567.891m - 5e20m)) + Digest((BigInteger)(decimal.MaxValue / (i + 1)));
                    case 6: return Digest(new BigInteger(Doubles[i % Doubles.Length]));
                    case 7: return Digest((BigInteger)(float)Doubles[i % Doubles.Length]);
                    case 8: return (long)(Int128)a ^ (long)((Int128)a >> 64);
                    case 9: return (long)(UInt128)a ^ (long)((UInt128)a >> 64);
                    case 10: return Digest((BigInteger)(Int128.MaxValue / (i + 1)) - (BigInteger)(UInt128.MaxValue / (ulong)(i + 1)));
                    case 11:
                        byte[] bytes = a.ToByteArray(isUnsigned: false, isBigEndian: true);
                        return Digest(new BigInteger(bytes, isBigEndian: true)) + bytes.Length;
                    case 12:
                        byte[] unsigned = BigInteger.Abs(a).ToByteArray(isUnsigned: true);
                        return Digest(new BigInteger(unsigned, isUnsigned: true)) * 3 + Digest(new BigInteger(unsigned)) + unsigned.Length;
                    case 13:
                        Span<byte> buffer = stackalloc byte[80];
                        bool written = a.TryWriteBytes(buffer, out int count, isBigEndian: i % 2 == 0);
                        return written ? Digest(new BigInteger(buffer.Slice(0, count), isBigEndian: i % 2 == 0)) + count : -7;
                    case 14: return (long)(byte)(a & 255) + (long)(sbyte)(a % 100) * 1000 + (long)(char)(a & 0xFFFF) * 1000000;
                    case 15: return checked((long)(a / 1000000000));
                    case 16: return (BigInteger.CreateChecked(Doubles[i % 9]).IsEven ? 1 : 0) + (long)BigInteger.CreateSaturating(Doubles[i % Doubles.Length]);
                    case 17: return (long)long.CreateSaturating(a) ^ (long)int.CreateTruncating(a) ^ (long)ulong.CreateSaturating(a);
                    case 18: return Digest(BigInteger.CreateTruncating(Doubles[i % Doubles.Length]));
                    default: return Digest(new BigInteger(a.ToByteArray()) - a);
                }
            }
            catch (Exception e)
            {
                return Failure(e);
            }
        }

        private static readonly string[] Formats =
        {
            null, "", "D", "d", "D40", "G", "g5", "R", "X", "x", "X20", "x1", "B", "b70", "N", "N0", "N3", "E", "e3", "E0",
            "F", "F2", "C", "C0", "P", "P1", "#,##0", "0.00e+0", "00000", "#", "0;(0);zero", "Q", "D1000000000",
        };

        public static long Formatting(int op, int i)
        {
            BigInteger a = Value(i);
            string format = Formats[op % Formats.Length];
            try
            {
                string text = a.ToString(format, CultureInfo.InvariantCulture);
                Span<char> destination = stackalloc char[400];
                bool fits = a.TryFormat(destination, out int written, format, CultureInfo.InvariantCulture);
                Span<char> small = stackalloc char[5];
                bool smallFits = a.TryFormat(small, out int smallWritten, format, CultureInfo.InvariantCulture);
                long digest = Digest(text) + (fits ? Digest(destination.Slice(0, written).ToString()) * 3 : -9);
                return digest + (smallFits ? smallWritten : -1) * 7;
            }
            catch (Exception e)
            {
                return Failure(e);
            }
        }

        public static long Texts(int i)
        {
            BigInteger a = Value(i);
            Span<byte> utf8 = stackalloc byte[400];
            bool fits = a.TryFormat(utf8, out int written, "N", CultureInfo.InvariantCulture);
            long digest = 0;
            for (int index = 0; index < written; index++)
            {
                digest = digest * 31 + utf8[index];
            }

            return Digest(a.ToString()) + Digest($"{a} {a:X} {a,40:N0}") * 3 + (fits ? digest : -1) * 5;
        }

        private static readonly string[] Texts_ =
        {
            "0", "-0", "123", "-123", "  456  ", "+789", "1,234,567", "(42)", "12e3", "1.000", "1.5", "1e-2", "10e-1",
            "ff", "FF", "0F", "80", "7FFFFFFFFFFFFFFFFFFF", "-", "", " ", "1 2", "12abc", "¤100", "100-", "1e1000000000",
            "123456789012345678901234567890123456789012345678901234567890", "-0000000000000000000000000000001", "101", "0101", "1111",
            "9999999999999999999999999999999999999999e-10", "5\0\0", "1.0e2",
        };

        private static readonly NumberStyles[] Styles =
        {
            NumberStyles.Integer, NumberStyles.Number, NumberStyles.Any, NumberStyles.HexNumber, NumberStyles.AllowHexSpecifier,
            NumberStyles.BinaryNumber, NumberStyles.AllowExponent | NumberStyles.AllowDecimalPoint, NumberStyles.None,
            NumberStyles.AllowParentheses | NumberStyles.AllowTrailingSign, NumberStyles.AllowHexSpecifier | NumberStyles.AllowLeadingSign,
            (NumberStyles)0x10000, NumberStyles.Currency,
        };

        public static long Parsing(int op, int i)
        {
            string text = Texts_[i % Texts_.Length];
            NumberStyles style = Styles[op % Styles.Length];
            long digest;
            try
            {
                digest = Digest(BigInteger.Parse(text, style, CultureInfo.InvariantCulture));
            }
            catch (Exception e)
            {
                digest = Failure(e);
            }

            try
            {
                bool parsed = BigInteger.TryParse(text.AsSpan(), style, CultureInfo.InvariantCulture, out BigInteger result);
                digest = unchecked(digest * 31 + (parsed ? Digest(result) : 11));
            }
            catch (Exception e)
            {
                digest = unchecked(digest * 31 + Failure(e));
            }

            try
            {
                byte[] utf8 = new byte[text.Length];
                bool ascii = true;
                for (int index = 0; index < text.Length; index++)
                {
                    ascii &= text[index] < 0x80;
                    utf8[index] = (byte)text[index];
                }

                if (ascii)
                {
                    bool parsed = BigInteger.TryParse(utf8, style, CultureInfo.InvariantCulture, out BigInteger result);
                    digest = unchecked(digest * 31 + (parsed ? Digest(result) : 13));
                }
            }
            catch (Exception e)
            {
                digest = unchecked(digest * 31 + Failure(e));
            }

            return digest;
        }

        public static long RoundTrips(int i, int format)
        {
            BigInteger a = Value(i);
            string[] formats = { "D", "R", "X", "B", "N0" };
            NumberStyles[] styles = { NumberStyles.Integer, NumberStyles.Integer, NumberStyles.HexNumber, NumberStyles.BinaryNumber, NumberStyles.Number };
            string text = a.ToString(formats[format]);
            return BigInteger.Parse(text, styles[format], CultureInfo.InvariantCulture) == a ? 1 : Digest(text);
        }

        private static T Sum<T>(T[] values)
            where T : INumber<T>
        {
            T total = T.Zero;
            foreach (T value in values)
            {
                total += value * value - T.One;
            }

            return total;
        }

        private static T Mix<T>(T a, T b)
            where T : IBinaryInteger<T>
        {
            T value = (a ^ b) | (a & T.One);
            value = (value << 3) >> 1;
            value++;
            return T.Max(value, T.Abs(b)) + T.CreateChecked(a.GetByteCount()) + T.PopCount(value);
        }

        public static long GenericMath(int i, int j)
        {
            BigInteger[] values = { Value(i), Value(j), Value((i + j) % 24) };
            return Digest(Sum(values)) + Digest(Mix(Value(i), Value(j))) * 3 + (BigInteger.IsNegative(Value(i)) ? 5 : 0);
        }

        public static long Collections(int count)
        {
            var set = new System.Collections.Generic.HashSet<BigInteger>();
            var dictionary = new System.Collections.Generic.Dictionary<BigInteger, int>();
            for (int k = 0; k < count; k++)
            {
                BigInteger value = Value(k % 24) + k / 24;
                set.Add(value);
                dictionary[value] = k;
            }

            var sorted = new System.Collections.Generic.List<BigInteger>(set);
            sorted.Sort();
            long digest = set.Count + dictionary.Count * 1000;
            foreach (BigInteger value in sorted)
            {
                digest = unchecked(digest * 31 + Digest(value));
            }

            return digest + (set.Contains(Value(3)) ? 1 : 0) + dictionary[Value(1)];
        }
    }
}
