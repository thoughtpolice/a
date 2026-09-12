// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.Numerics;

// The numeric types' generic math statics (int.Max, double.IsInteger and
// the like), HashCode and string hashing, against the CLR.
public static class Numerics
{

    public const int SByteOperations = 21;

    public static long SByte(int which, sbyte a, sbyte b) => which switch
    {
        0 => (long)(sbyte.Abs(a)),
        1 => (long)(sbyte.Max(a, b)),
        2 => (long)(sbyte.Min(a, b)),
        3 => (long)(sbyte.Clamp(a, b, (sbyte)(b + 3))),
        4 => (long)(sbyte.Sign(a)),
        5 => (long)(sbyte.IsNegative(a) ? 1 : 0),
        6 => (long)(sbyte.IsPositive(a) ? 1 : 0),
        7 => (long)(sbyte.IsEvenInteger(a) ? 1 : 0),
        8 => (long)(sbyte.IsOddInteger(a) ? 1 : 0),
        9 => (long)(sbyte.IsPow2(a) ? 1 : 0),
        10 => (long)(sbyte.Log2(a)),
        11 => (long)(sbyte.PopCount(a)),
        12 => (long)(sbyte.LeadingZeroCount(a)),
        13 => (long)(sbyte.TrailingZeroCount(a)),
        14 => (long)(sbyte.RotateLeft(a, (int)b)),
        15 => (long)(sbyte.RotateRight(a, (int)b)),
        16 => (long)(sbyte.DivRem(a, b).Quotient * 1000 + sbyte.DivRem(a, b).Remainder),
        17 => (long)(sbyte.Clamp(a, (sbyte)(b + 1), b)),
        18 => (long)(sbyte.MaxMagnitude(a, b)),
        19 => (long)(sbyte.MinMagnitude(a, b)),
        20 => (long)(sbyte.CopySign(a, b)),
        _ => -1,
    };

    public const int ByteOperations = 15;

    public static long Byte(int which, byte a, byte b) => which switch
    {
        0 => (long)(byte.Max(a, b)),
        1 => (long)(byte.Min(a, b)),
        2 => (long)(byte.Clamp(a, b, (byte)(b + 3))),
        3 => (long)(byte.Sign(a)),
        4 => (long)(byte.IsEvenInteger(a) ? 1 : 0),
        5 => (long)(byte.IsOddInteger(a) ? 1 : 0),
        6 => (long)(byte.IsPow2(a) ? 1 : 0),
        7 => (long)(byte.Log2(a)),
        8 => (long)(byte.PopCount(a)),
        9 => (long)(byte.LeadingZeroCount(a)),
        10 => (long)(byte.TrailingZeroCount(a)),
        11 => (long)(byte.RotateLeft(a, (int)b)),
        12 => (long)(byte.RotateRight(a, (int)b)),
        13 => (long)(byte.DivRem(a, b).Quotient * 1000 + byte.DivRem(a, b).Remainder),
        14 => (long)(byte.Clamp(a, (byte)(b + 1), b)),
        _ => -1,
    };

    public const int Int16Operations = 21;

    public static long Int16(int which, short a, short b) => which switch
    {
        0 => (long)(short.Abs(a)),
        1 => (long)(short.Max(a, b)),
        2 => (long)(short.Min(a, b)),
        3 => (long)(short.Clamp(a, b, (short)(b + 3))),
        4 => (long)(short.Sign(a)),
        5 => (long)(short.IsNegative(a) ? 1 : 0),
        6 => (long)(short.IsPositive(a) ? 1 : 0),
        7 => (long)(short.IsEvenInteger(a) ? 1 : 0),
        8 => (long)(short.IsOddInteger(a) ? 1 : 0),
        9 => (long)(short.IsPow2(a) ? 1 : 0),
        10 => (long)(short.Log2(a)),
        11 => (long)(short.PopCount(a)),
        12 => (long)(short.LeadingZeroCount(a)),
        13 => (long)(short.TrailingZeroCount(a)),
        14 => (long)(short.RotateLeft(a, (int)b)),
        15 => (long)(short.RotateRight(a, (int)b)),
        16 => (long)(short.DivRem(a, b).Quotient * 1000 + short.DivRem(a, b).Remainder),
        17 => (long)(short.Clamp(a, (short)(b + 1), b)),
        18 => (long)(short.MaxMagnitude(a, b)),
        19 => (long)(short.MinMagnitude(a, b)),
        20 => (long)(short.CopySign(a, b)),
        _ => -1,
    };

    public const int UInt16Operations = 15;

    public static long UInt16(int which, ushort a, ushort b) => which switch
    {
        0 => (long)(ushort.Max(a, b)),
        1 => (long)(ushort.Min(a, b)),
        2 => (long)(ushort.Clamp(a, b, (ushort)(b + 3))),
        3 => (long)(ushort.Sign(a)),
        4 => (long)(ushort.IsEvenInteger(a) ? 1 : 0),
        5 => (long)(ushort.IsOddInteger(a) ? 1 : 0),
        6 => (long)(ushort.IsPow2(a) ? 1 : 0),
        7 => (long)(ushort.Log2(a)),
        8 => (long)(ushort.PopCount(a)),
        9 => (long)(ushort.LeadingZeroCount(a)),
        10 => (long)(ushort.TrailingZeroCount(a)),
        11 => (long)(ushort.RotateLeft(a, (int)b)),
        12 => (long)(ushort.RotateRight(a, (int)b)),
        13 => (long)(ushort.DivRem(a, b).Quotient * 1000 + ushort.DivRem(a, b).Remainder),
        14 => (long)(ushort.Clamp(a, (ushort)(b + 1), b)),
        _ => -1,
    };

    public const int Int32Operations = 21;

    public static long Int32(int which, int a, int b) => which switch
    {
        0 => (long)(int.Abs(a)),
        1 => (long)(int.Max(a, b)),
        2 => (long)(int.Min(a, b)),
        3 => (long)(int.Clamp(a, b, (int)(b + 3))),
        4 => (long)(int.Sign(a)),
        5 => (long)(int.IsNegative(a) ? 1 : 0),
        6 => (long)(int.IsPositive(a) ? 1 : 0),
        7 => (long)(int.IsEvenInteger(a) ? 1 : 0),
        8 => (long)(int.IsOddInteger(a) ? 1 : 0),
        9 => (long)(int.IsPow2(a) ? 1 : 0),
        10 => (long)(int.Log2(a)),
        11 => (long)(int.PopCount(a)),
        12 => (long)(int.LeadingZeroCount(a)),
        13 => (long)(int.TrailingZeroCount(a)),
        14 => (long)(int.RotateLeft(a, (int)b)),
        15 => (long)(int.RotateRight(a, (int)b)),
        16 => (long)(int.DivRem(a, b).Quotient * 1000 + int.DivRem(a, b).Remainder),
        17 => (long)(int.Clamp(a, (int)(b + 1), b)),
        18 => (long)(int.MaxMagnitude(a, b)),
        19 => (long)(int.MinMagnitude(a, b)),
        20 => (long)(int.CopySign(a, b)),
        _ => -1,
    };

    public const int UInt32Operations = 15;

    public static long UInt32(int which, uint a, uint b) => which switch
    {
        0 => (long)(uint.Max(a, b)),
        1 => (long)(uint.Min(a, b)),
        2 => (long)(uint.Clamp(a, b, (uint)(b + 3))),
        3 => (long)(uint.Sign(a)),
        4 => (long)(uint.IsEvenInteger(a) ? 1 : 0),
        5 => (long)(uint.IsOddInteger(a) ? 1 : 0),
        6 => (long)(uint.IsPow2(a) ? 1 : 0),
        7 => (long)(uint.Log2(a)),
        8 => (long)(uint.PopCount(a)),
        9 => (long)(uint.LeadingZeroCount(a)),
        10 => (long)(uint.TrailingZeroCount(a)),
        11 => (long)(uint.RotateLeft(a, (int)b)),
        12 => (long)(uint.RotateRight(a, (int)b)),
        13 => (long)(uint.DivRem(a, b).Quotient * 1000 + uint.DivRem(a, b).Remainder),
        14 => (long)(uint.Clamp(a, (uint)(b + 1), b)),
        _ => -1,
    };

    public const int Int64Operations = 21;

    public static long Int64(int which, long a, long b) => which switch
    {
        0 => (long)(long.Abs(a)),
        1 => (long)(long.Max(a, b)),
        2 => (long)(long.Min(a, b)),
        3 => (long)(long.Clamp(a, b, (long)(b + 3))),
        4 => (long)(long.Sign(a)),
        5 => (long)(long.IsNegative(a) ? 1 : 0),
        6 => (long)(long.IsPositive(a) ? 1 : 0),
        7 => (long)(long.IsEvenInteger(a) ? 1 : 0),
        8 => (long)(long.IsOddInteger(a) ? 1 : 0),
        9 => (long)(long.IsPow2(a) ? 1 : 0),
        10 => (long)(long.Log2(a)),
        11 => (long)(long.PopCount(a)),
        12 => (long)(long.LeadingZeroCount(a)),
        13 => (long)(long.TrailingZeroCount(a)),
        14 => (long)(long.RotateLeft(a, (int)b)),
        15 => (long)(long.RotateRight(a, (int)b)),
        16 => (long)(long.DivRem(a, b).Quotient * 1000 + long.DivRem(a, b).Remainder),
        17 => (long)(long.Clamp(a, (long)(b + 1), b)),
        18 => (long)(long.MaxMagnitude(a, b)),
        19 => (long)(long.MinMagnitude(a, b)),
        20 => (long)(long.CopySign(a, b)),
        _ => -1,
    };

    public const int UInt64Operations = 15;

    public static long UInt64(int which, ulong a, ulong b) => which switch
    {
        0 => (long)(ulong.Max(a, b)),
        1 => (long)(ulong.Min(a, b)),
        2 => (long)(ulong.Clamp(a, b, (ulong)(b + 3))),
        3 => (long)(ulong.Sign(a)),
        4 => (long)(ulong.IsEvenInteger(a) ? 1 : 0),
        5 => (long)(ulong.IsOddInteger(a) ? 1 : 0),
        6 => (long)(ulong.IsPow2(a) ? 1 : 0),
        7 => (long)(ulong.Log2(a)),
        8 => (long)(ulong.PopCount(a)),
        9 => (long)(ulong.LeadingZeroCount(a)),
        10 => (long)(ulong.TrailingZeroCount(a)),
        11 => (long)(ulong.RotateLeft(a, (int)b)),
        12 => (long)(ulong.RotateRight(a, (int)b)),
        13 => (long)(ulong.DivRem(a, b).Quotient * 1000 + ulong.DivRem(a, b).Remainder),
        14 => (long)(ulong.Clamp(a, (ulong)(b + 1), b)),
        _ => -1,
    };

    public const int SingleOperations = 31;

    public static double Single(int which, float a, float b) => which switch
    {
        0 => (double)(float.Abs(a)),
        1 => (double)(float.Max(a, b)),
        2 => (double)(float.Min(a, b)),
        3 => (double)(float.Clamp(a, -2, 3)),
        4 => (double)(float.Sign(a)),
        5 => (double)(float.CopySign(a, b)),
        6 => (double)(float.Floor(a)),
        7 => (double)(float.Ceiling(a)),
        8 => (double)(float.Truncate(a)),
        9 => (double)(float.Round(a)),
        10 => (double)(float.Round(a, 1)),
        11 => (double)(float.Round(a, MidpointRounding.AwayFromZero)),
        12 => (double)(float.Sqrt(a)),
        13 => (double)(float.IsNegative(a) ? 1 : 0),
        14 => (double)(float.IsPositive(a) ? 1 : 0),
        15 => (double)(float.IsInteger(a) ? 1 : 0),
        16 => (double)(float.IsEvenInteger(a) ? 1 : 0),
        17 => (double)(float.IsOddInteger(a) ? 1 : 0),
        18 => (double)(float.IsNormal(a) ? 1 : 0),
        19 => (double)(float.IsSubnormal(a) ? 1 : 0),
        20 => (double)(float.IsNegativeInfinity(a) ? 1 : 0),
        21 => (double)(float.IsPositiveInfinity(a) ? 1 : 0),
        22 => (double)(float.MaxMagnitude(a, b)),
        23 => (double)(float.MinMagnitude(a, b)),
        24 => (double)(float.MaxNumber(a, b)),
        25 => (double)(float.MinNumber(a, b)),
        26 => (double)(float.Lerp(a, b, (float)0.25)),
        27 => (double)(float.Clamp(a, 3, -2)),
        28 => (double)(float.Exp(a)),
        29 => (double)(float.Atan2(a, b)),
        30 => (double)(float.Pow(a, b)),
        _ => -1,
    };

    public const int DoubleOperations = 31;

    public static double Double(int which, double a, double b) => which switch
    {
        0 => (double)(double.Abs(a)),
        1 => (double)(double.Max(a, b)),
        2 => (double)(double.Min(a, b)),
        3 => (double)(double.Clamp(a, -2, 3)),
        4 => (double)(double.Sign(a)),
        5 => (double)(double.CopySign(a, b)),
        6 => (double)(double.Floor(a)),
        7 => (double)(double.Ceiling(a)),
        8 => (double)(double.Truncate(a)),
        9 => (double)(double.Round(a)),
        10 => (double)(double.Round(a, 1)),
        11 => (double)(double.Round(a, MidpointRounding.AwayFromZero)),
        12 => (double)(double.Sqrt(a)),
        13 => (double)(double.IsNegative(a) ? 1 : 0),
        14 => (double)(double.IsPositive(a) ? 1 : 0),
        15 => (double)(double.IsInteger(a) ? 1 : 0),
        16 => (double)(double.IsEvenInteger(a) ? 1 : 0),
        17 => (double)(double.IsOddInteger(a) ? 1 : 0),
        18 => (double)(double.IsNormal(a) ? 1 : 0),
        19 => (double)(double.IsSubnormal(a) ? 1 : 0),
        20 => (double)(double.IsNegativeInfinity(a) ? 1 : 0),
        21 => (double)(double.IsPositiveInfinity(a) ? 1 : 0),
        22 => (double)(double.MaxMagnitude(a, b)),
        23 => (double)(double.MinMagnitude(a, b)),
        24 => (double)(double.MaxNumber(a, b)),
        25 => (double)(double.MinNumber(a, b)),
        26 => (double)(double.Lerp(a, b, (double)0.25)),
        27 => (double)(double.Clamp(a, 3, -2)),
        28 => (double)(double.Exp(a)),
        29 => (double)(double.Atan2(a, b)),
        30 => (double)(double.Pow(a, b)),
        _ => -1,
    };

    // HashCode.Combine and Add agree, as in .NET; each value's hash is its
    // type's.
    public static int Hashes(int a, int b)
    {
        var added = new HashCode();
        added.Add(a);
        added.Add(b);
        added.Add("text");
        added.Add(a * 0.5);
        added.Add(b > 0);
        int result = HashCode.Combine(a, b, "text", a * 0.5, b > 0) == added.ToHashCode() ? 1 : 0;
        result += HashCode.Combine(a) == HashCode.Combine(a) ? 10 : 0;
        result += HashCode.Combine(a, b) == HashCode.Combine(a, b) ? 100 : 0;
        var eight = new HashCode();
        for (int index = 0; index < 8; index++)
        {
            eight.Add(a + index);
        }

        result += HashCode.Combine(a, a + 1, a + 2, a + 3, a + 4, a + 5, a + 6, a + 7) == eight.ToHashCode() ? 1000 : 0;
        var none = new HashCode();
        result += none.ToHashCode() == new HashCode().ToHashCode() ? 10000 : 0;
        string first = "ab" + a;
        string second = "a" + ("b" + a);
        result += first.GetHashCode() == second.GetHashCode() ? 100000 : 0;
        result += HashCode.Combine<string>(null) == HashCode.Combine(0) ? 1000000 : 0;
        return result;
    }

    public static int NullHash(int which)
    {
        string text = which > 0 ? "x" : null;
        return text.GetHashCode() * 0 + 1;
    }
}
