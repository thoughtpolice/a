// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Generic math over the primitive numeric types (`T : INumber<T>`), which
// the gameplay CoreLib implements (corelib/GenericMath.cs): identities and operators through type
// parameters, and the conversions between the types, checked, saturating
// and truncating.

using System;
using System.Numerics;

namespace Tests.GenericMath
{
    public static class GenericMath
    {
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
            return value - (a % (b == T.Zero ? T.One : b)) + (-T.One) + (+b);
        }

        private static int Count<T>(T value)
            where T : IBinaryInteger<T> =>
            int.CreateTruncating(T.PopCount(value)) + (T.IsNegative(value) ? 100 : 0) + (T.IsEvenInteger(value) ? 1000 : 0);

        private static T Clamp<T>(T value, T low, T high)
            where T : INumber<T> =>
            T.Clamp(value, low, high);

        private static TTo Checked<TFrom, TTo>(TFrom value)
            where TFrom : INumber<TFrom>
            where TTo : INumber<TTo> =>
            TTo.CreateChecked(value);

        private static TTo Saturating<TFrom, TTo>(TFrom value)
            where TFrom : INumber<TFrom>
            where TTo : INumber<TTo> =>
            TTo.CreateSaturating(value);

        private static TTo Truncating<TFrom, TTo>(TFrom value)
            where TFrom : INumber<TFrom>
            where TTo : INumber<TTo> =>
            TTo.CreateTruncating(value);

        public static int Integers(int a)
        {
            int[] values = { a, 3, -7, a / 2 };
            return unchecked(Sum(values) * 31 + Product(values) * 7 + Largest(values) + Mix(a, 5) + Count(a));
        }

        public static long Longs(int a)
        {
            long[] values = { a * 100000L, 3, -7, long.MaxValue / 4 };
            return unchecked(Sum(values) + Largest(values) + Mix((long)a, 9L) + Count((long)a));
        }

        public static int SmallIntegers(int a)
        {
            byte[] bytes = { (byte)a, 200, 100 };
            sbyte[] sbytes = { (sbyte)a, -100, 50 };
            short[] shorts = { (short)a, 30000, 4000 };
            ushort[] ushorts = { (ushort)a, 60000, 9000 };
            return Sum(bytes) + Sum(sbytes) * 3 + Sum(shorts) * 5 + Sum(ushorts) * 7 + Mix((byte)a, (byte)7) + Mix((sbyte)a, (sbyte)-3)
                   + Count((short)a) + Count((ushort)a);
        }

        public static double Doubles(int a)
        {
            double[] values = { a * 0.5, 1.25, -3.75, double.Epsilon };
            float[] floats = { a * 0.25f, 2.5f, -1.5f };
            return Sum(values) + Product(values) + Largest(values) + Sum(floats) + Largest(floats) + Clamp(a * 1.5, -2.0, 7.0);
        }

        public static long Checks(int which)
        {
            try
            {
                return which switch
                {
                    0 => Checked<int, byte>(255),
                    1 => Checked<int, byte>(256),
                    2 => Checked<long, int>(-2147483649L),
                    3 => Checked<double, int>(2147483647.9),
                    4 => Checked<double, int>(double.NaN),
                    5 => Checked<double, long>(-9.2e18),
                    6 => Checked<int, uint>(-1),
                    7 => (long)Checked<ulong, long>(ulong.MaxValue),
                    8 => Checked<float, short>(-32768.5f),
                    9 => Checked<char, sbyte>('A'),
                    _ => Clamp(which, 3, 1),
                };
            }
            catch (OverflowException)
            {
                return -1;
            }
            catch (ArgumentException)
            {
                return -2;
            }
        }

        public static long Saturations(int which) => which switch
        {
            0 => Saturating<int, byte>(-5),
            1 => Saturating<int, byte>(300),
            2 => Saturating<double, int>(1e20),
            3 => Saturating<double, int>(-1e20),
            4 => Saturating<double, int>(double.NaN),
            5 => Saturating<long, short>(-100000),
            6 => (long)Saturating<double, ulong>(-4.5),
            7 => Saturating<float, sbyte>(127.9f),
            8 => Saturating<int, char>(70000),
            _ => Saturating<ulong, long>(ulong.MaxValue),
        };

        public static long Truncations(int which) => which switch
        {
            0 => Truncating<int, byte>(-5),
            1 => Truncating<int, byte>(300),
            2 => Truncating<long, int>(0x1_2345_6789L),
            3 => Truncating<double, int>(-7.9),
            4 => Truncating<ulong, short>(0xFFFF_0001UL),
            5 => Truncating<int, char>(0x41 + 0x10000),
            6 => Truncating<sbyte, ushort>(-1),
            7 => (long)(Truncating<int, double>(which) * 3),
            _ => Truncating<uint, long>(uint.MaxValue),
        };
    }
}
