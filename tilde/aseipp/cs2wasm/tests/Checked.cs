// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.Checked;

public readonly struct Meters
{
    public readonly int Value;

    public Meters(int value) => Value = value;

    public static Meters operator +(Meters a, Meters b) => new(a.Value + b.Value);

    public static Meters operator checked +(Meters a, Meters b) => new(checked(a.Value + b.Value));
}

public enum Small : byte
{
    Low = 1,
    High = 250,
}

// Checked arithmetic and conversions against the CLR: every integer width,
// binary, compound, increment, negation and lifted operators, conversions
// from integers and floating point, and unchecked regions inside checked
// ones. The differential expects fault 9 wherever the CLR throws
// OverflowException here.
public static class Checked
{
    // User-defined checked operators run in checked contexts only.
    public static int UserDefined(int a, int b, bool isChecked) =>
        isChecked ? checked(new Meters(a) + new Meters(b)).Value : unchecked(new Meters(a) + new Meters(b)).Value;

    // A lambda or local function in a checked block is checked.
    public static int Lambda(int a)
    {
        checked
        {
            Func<int, int> twice = x => x * 2;
            int Thrice(int x) => x * 3;
            return twice(a) + Thrice(1);
        }
    }

    public static int EnumConversion(int value) => (int)checked((Small)value);

    public static int AddInt(int a, int b) => checked(a + b);

    public static int SubInt(int a, int b) => checked(a - b);

    public static int MulInt(int a, int b) => checked(a * b);

    public static int NegInt(int a) => checked(-a);

    public static uint AddUInt(uint a, uint b) => checked(a + b);

    public static uint SubUInt(uint a, uint b) => checked(a - b);

    public static uint MulUInt(uint a, uint b) => checked(a * b);

    public static long AddLong(long a, long b) => checked(a + b);

    public static long SubLong(long a, long b) => checked(a - b);

    public static long MulLong(long a, long b) => checked(a * b);

    public static long NegLong(long a) => checked(-a);

    public static ulong AddULong(ulong a, ulong b) => checked(a + b);

    public static ulong SubULong(ulong a, ulong b) => checked(a - b);

    public static ulong MulULong(ulong a, ulong b) => checked(a * b);

    // Mixed widths promote first, as unchecked arithmetic does.
    public static long Mixed(int a, uint b) => checked(a + b);

    public static int Narrow(int which, int value)
    {
        checked
        {
            switch (which)
            {
                case 0:
                    byte b = (byte)value;
                    b += 10;
                    return b;
                case 1:
                    sbyte s = (sbyte)value;
                    s -= 10;
                    return s;
                case 2:
                    short h = (short)value;
                    h *= 3;
                    return h;
                case 3:
                    ushort u = (ushort)value;
                    u++;
                    return u;
                case 4:
                    char c = (char)value;
                    c--;
                    return c;
                case 5:
                    sbyte t = (sbyte)value;
                    t++;
                    return t;
                case 6:
                    int i = value;
                    i++;
                    return i;
                case 7:
                    int j = value;
                    --j;
                    return j;
                default:
                    uint k = (uint)value;
                    k--;
                    return (int)k;
            }
        }
    }

    public static long Wide(int which, long value)
    {
        checked
        {
            switch (which)
            {
                case 0:
                    long l = value;
                    l += long.MaxValue / 2;
                    return l;
                case 1:
                    long m = value;
                    m++;
                    return m;
                case 2:
                    ulong u = (ulong)value;
                    u--;
                    return (long)u;
                default:
                    long n = value;
                    n *= 1000000;
                    return n;
            }
        }
    }

    public static int Shift(int value)
    {
        checked
        {
            byte b = (byte)value;
            b <<= 1;
            b |= 1;
            return b;
        }
    }

    public static int ConvertInt(int which, long value) => which switch
    {
        0 => checked((int)value),
        1 => checked((byte)value),
        2 => checked((sbyte)value),
        3 => checked((short)value),
        4 => checked((ushort)value),
        5 => checked((char)value),
        6 => (int)checked((uint)value),
        _ => (int)checked((ulong)value),
    };

    public static int ConvertSmall(int which, int value) => which switch
    {
        0 => checked((byte)value),
        1 => checked((sbyte)value),
        2 => (int)checked((uint)value),
        3 => (int)checked((ulong)value),
        4 => checked((char)value),
        5 => checked((short)(sbyte)value),
        6 => (int)checked((uint)(short)value),
        _ => checked((int)(uint)value),
    };

    public static long ConvertUnsigned(int which, ulong value) => which switch
    {
        0 => checked((long)value),
        1 => checked((int)value),
        2 => checked((uint)value),
        3 => checked((ushort)value),
        _ => checked((sbyte)value),
    };

    public static long ConvertDouble(int which, double value) => which switch
    {
        0 => checked((int)value),
        1 => checked((long)value),
        2 => (long)checked((ulong)value),
        3 => checked((uint)value),
        4 => checked((byte)value),
        5 => checked((sbyte)value),
        6 => checked((char)value),
        7 => checked((short)value),
        _ => checked((ushort)value),
    };

    public static long ConvertFloat(int which, float value) => which switch
    {
        0 => checked((int)value),
        1 => checked((long)value),
        2 => (long)checked((ulong)value),
        3 => checked((uint)value),
        _ => checked((byte)value),
    };

    // Floating point never overflows, checked or not.
    public static double Floating(double a, double b) => checked(a * b + a - b);

    public static int Enum(int value)
    {
        var small = (Small)value;
        return (int)checked(small + 5);
    }

    public static int Unchecked(int a) => checked(unchecked(a + 1) + unchecked(a * 2));

    public static int Nullable(int which, int value)
    {
        int? a = value;
        int? none = null;
        long? wide = value * 3L;
        checked
        {
            return which switch
            {
                0 => (a + int.MaxValue / 2) ?? -1,
                1 => (-a) ?? -1,
                2 => (none + 1) ?? -1,
                3 => ((int?)(wide * 1000)) ?? -1,
                4 => ((byte?)a) ?? -1,
                _ => (a * a) ?? -1,
            };
        }
    }

    public static int NullableStep(int value)
    {
        short? s = (short)value;
        checked
        {
            s++;
            s += 100;
        }

        return s ?? -1;
    }

    public static int Caught(int value)
    {
        try
        {
            return checked(value * value);
        }
        catch (OverflowException)
        {
            return -1;
        }
    }

    // A checked method body evaluates each step, left to right.
    public static long Steps(int a, int b)
    {
        long total = 0;
        checked
        {
            for (int i = 0; i < 40; i++)
            {
                total += (long)a * b * i;
                a = a * 2 + b;
            }
        }

        return total;
    }
}
