// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Numerics;
using System.Runtime.Intrinsics;

namespace Tests.Simd;

// System.Runtime.Intrinsics.Vector128 (Wasm's v128) against the
// CLR's, whose Vector128 is hardware accelerated too: every element type's
// arithmetic, comparisons, reductions, conversions and rearrangements over
// boundary values, NaN, signed zeros, infinities and subnormals, and a
// Vector128 as a value (fields, arrays, references, boxes, generics). Each
// case hashes the lanes' bits (NaN as one NaN: its payload is unspecified).
// Where .NET leaves a result to the platform (MinNative and MaxNative of NaN
// or zeros of both signs, MultiplyAddEstimate, the transcendental functions'
// last bits), tests/differential.mjs asks only what both promise: the
// Native forms of ordered, distinct inputs, estimates of exact products, and
// transcendentals within an ulp or two.
public static class Simd
{
    private static readonly float[] Floats =
    [
        0f, -0f, 1f, -1f, 0.5f, -2.25f, 3f, 100f, 1e-40f, -1e-40f, float.Epsilon, float.MaxValue, float.MinValue,
        float.PositiveInfinity, float.NegativeInfinity, float.NaN, 0.1f, 1.0000001f, 16777216f, -7.75f,
    ];

    private static readonly double[] Doubles =
    [
        0.0, -0.0, 1.0, -1.0, 0.5, -2.25, 3.0, 1e300, 1e-310, -1e-310, double.Epsilon, double.MaxValue, double.MinValue,
        double.PositiveInfinity, double.NegativeInfinity, double.NaN, 0.1, 1.0000000000000002, 9007199254740993.0, -7.75,
    ];

    // Ordered, distinct from each other in every lane pair used, and never
    // zero or NaN: what MinNative and MaxNative agree on everywhere.
    private static readonly float[] Plain = [1f, -1f, 0.5f, -2.25f, 3f, 100f, 0.1f, -7.75f, 1e-30f, 12345.678f];

    private static readonly long[] Integers =
    [
        0, 1, -1, 2, -2, 7, 100, -100, 127, -128, 128, 255, 256, 32767, -32768, 65535, 65536, int.MaxValue, int.MinValue,
        uint.MaxValue, long.MaxValue, long.MinValue, 0x5555_5555_5555_5555, 1234567890123,
    ];

    private static Vector128<float> F(int i) => Vector128.Create(
        Floats[i % Floats.Length],
        Floats[(i + 5) % Floats.Length],
        Floats[(i + 11) % Floats.Length],
        Floats[(i + 17) % Floats.Length]);

    private static Vector128<double> D(int i) => Vector128.Create(Doubles[i % Doubles.Length], Doubles[(i + 7) % Doubles.Length]);

    private static Vector128<float> P(int i) => Vector128.Create(
        Plain[i % Plain.Length],
        Plain[(i + 3) % Plain.Length],
        Plain[(i + 6) % Plain.Length],
        Plain[(i + 8) % Plain.Length]);

    // Lanes from the integers, wrapped to T.
    private static Vector128<T> I<T>(int i)
        where T : IBinaryInteger<T>
    {
        var result = Vector128<T>.Zero;
        for (int lane = 0; lane < Vector128<T>.Count; lane++)
        {
            result = result.WithElement(lane, T.CreateTruncating(Integers[(i + (lane * 5)) % Integers.Length]));
        }

        return result;
    }

    private static long Bits(float value) => float.IsNaN(value) ? 0x7FC0_0000 : BitConverter.SingleToInt32Bits(value);

    private static long Bits(double value) => double.IsNaN(value) ? 0x7FF8_0000_0000_0000 : BitConverter.DoubleToInt64Bits(value);

    private static long Hash(Vector128<float> vector)
    {
        long hash = 17;
        for (int lane = 0; lane < Vector128<float>.Count; lane++)
        {
            hash = (hash * 1_000_003) + Bits(vector.GetElement(lane));
        }

        return hash;
    }

    private static long Hash(Vector128<double> vector) => (Bits(vector.GetElement(0)) * 1_000_003) + Bits(vector[1]);

    private static long Hash<T>(Vector128<T> vector)
        where T : IBinaryInteger<T>
    {
        long hash = 17;
        for (int lane = 0; lane < Vector128<T>.Count; lane++)
        {
            hash = (hash * 1_000_003) + long.CreateTruncating(vector[lane]);
        }

        return hash;
    }

    // Two float vectors into a vector: op 0 to 30.
    public static long FloatBinary(int op, int i, int j)
    {
        var a = F(i);
        var b = F(j);
        var result = op switch
        {
            0 => a + b,
            1 => a - b,
            2 => a * b,
            3 => a / b,
            4 => Vector128.Min(a, b),
            5 => Vector128.Max(a, b),
            6 => Vector128.MinNumber(a, b),
            7 => Vector128.MaxNumber(a, b),
            8 => Vector128.MinMagnitude(a, b),
            9 => Vector128.MaxMagnitude(a, b),
            10 => Vector128.MinMagnitudeNumber(a, b),
            11 => Vector128.MaxMagnitudeNumber(a, b),
            12 => Vector128.CopySign(a, b),
            13 => Vector128.AndNot(a, b),
            14 => a & b,
            15 => a | b,
            16 => a ^ b,
            17 => Vector128.Equals(a, b),
            18 => Vector128.LessThan(a, b),
            19 => Vector128.LessThanOrEqual(a, b),
            20 => Vector128.GreaterThan(a, b),
            21 => Vector128.GreaterThanOrEqual(a, b),
            22 => a * b.GetElement(1),
            23 => a / b.ToScalar(),
            24 => Vector128.Hypot(a, b),
            25 => Vector128.ConditionalSelect(Vector128.GreaterThan(a, b), a, b),
            26 => Vector128.Clamp(a, Vector128.Min(a, b), Vector128.Max(a, b)),
            27 => Vector128.AddSaturate(a, b),
            28 => Vector128.SubtractSaturate(a, b),
            29 => Vector128.FusedMultiplyAdd(a, b, F(i + j)),
            30 => b.GetElement(3) * a,
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
        return Hash(result);
    }

    // One lane of FloatBinary's vector, and of FloatUnary's (op 0 to 31).
    public static float FloatBinaryLane(int op, int i, int j, int lane) => FloatBinaryVector(op, i, j).GetElement(lane);

    public static float FloatUnaryLane(int op, int i, int lane) => FloatUnaryVector(op, i).GetElement(lane);

    private static Vector128<float> FloatBinaryVector(int op, int i, int j) => op switch
    {
        24 => Vector128.Hypot(F(i), F(j)),
        29 => Vector128.FusedMultiplyAdd(F(i), F(j), F(i + j)),
        _ => F(i) + F(j),
    };

    private static Vector128<float> FloatUnaryVector(int op, int i) => op switch
    {
        6 => Vector128.Round(F(i)),
        7 => Vector128.Round(F(i), MidpointRounding.AwayFromZero),
        8 => Vector128.Round(F(i), MidpointRounding.ToZero),
        9 => Vector128.Round(F(i), MidpointRounding.ToNegativeInfinity),
        _ => F(i),
    };

    // A float vector into a vector: op 0 to 38.
    public static long FloatUnary(int op, int i)
    {
        var a = F(i);
        return op switch
        {
            0 => Hash(-a),
            1 => Hash(Vector128.Abs(a)),
            2 => Hash(Vector128.Sqrt(a)),
            3 => Hash(Vector128.Floor(a)),
            4 => Hash(Vector128.Ceiling(a)),
            5 => Hash(Vector128.Truncate(a)),
            6 => Hash(Vector128.Round(a)),
            7 => Hash(Vector128.Round(a, MidpointRounding.AwayFromZero)),
            8 => Hash(Vector128.Round(a, MidpointRounding.ToZero)),
            9 => Hash(Vector128.Round(a, MidpointRounding.ToNegativeInfinity)),
            10 => Hash(Vector128.IsNaN(a)),
            11 => Hash(Vector128.IsNegative(a)),
            12 => Hash(Vector128.IsPositive(a)),
            13 => Hash(Vector128.IsInfinity(a)),
            14 => Hash(Vector128.IsPositiveInfinity(a)),
            15 => Hash(Vector128.IsNegativeInfinity(a)),
            16 => Hash(Vector128.IsFinite(a)),
            17 => Hash(Vector128.IsNormal(a)),
            18 => Hash(Vector128.IsSubnormal(a)),
            19 => Hash(Vector128.IsZero(a)),
            20 => Hash(Vector128.IsInteger(a)),
            21 => Hash(Vector128.IsEvenInteger(a)),
            22 => Hash(Vector128.IsOddInteger(a)),
            23 => Hash(~a),
            24 => Hash(Vector128.ConvertToInt32(a)),
            25 => Hash(Vector128.ConvertToUInt32(a)),
            26 => Hash(Vector128.WidenLower(a)),
            27 => Hash(Vector128.WidenUpper(a)),
            28 => Hash(a.AsInt32() << 3),
            29 => Hash(a.AsInt32() >> 7),
            30 => Hash(a.AsUInt32() >>> 9),
            31 => Hash(Vector128.Reverse(a)),
            32 => a.ExtractMostSignificantBits(),
            33 => Bits(Vector128.Sum(a)),
            34 => Bits(Vector128.Dot(a, F(i + 3))),
            35 => Bits(a.ToScalar()),
            36 => Hash(Vector128.Shuffle(a, Vector128.Create(3, 0, 5, -1))),
            37 => Hash(Vector128.Shuffle(a, Vector128.Create(i % 4, (i + 1) % 4, i % 3, 2))),
            38 => Hash(Vector128.ConvertToInt32Native(a)),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // Whole-vector answers of two float vectors: op 0 to 21.
    public static int FloatTests(int op, int i, int j)
    {
        var a = F(i);
        var b = op >= 16 ? a : F(j);
        float value = F(j).GetElement(2);
        bool result = op switch
        {
            0 => Vector128.EqualsAll(a, b),
            1 => Vector128.EqualsAny(a, b),
            2 => Vector128.LessThanAll(a, b),
            3 => Vector128.LessThanAny(a, b),
            4 => Vector128.LessThanOrEqualAll(a, b),
            5 => Vector128.GreaterThanAny(a, b),
            6 => Vector128.GreaterThanOrEqualAll(a, b),
            7 => a == b,
            8 => a != b,
            9 => a.Equals(b),
            10 => a.Equals((object)b),
            11 => Vector128.All(a, value),
            12 => Vector128.Any(a, value),
            13 => Vector128.None(a, value),
            14 => Vector128.Count(a, value) == 1,
            15 => Vector128.IndexOf(a, value) == Vector128.LastIndexOf(a, value),
            16 => a.Equals(b),
            17 => a == b,
            18 => a.GetHashCode() == b.GetHashCode(),
            19 => Vector128.AnyWhereAllBitsSet(a | Vector128<float>.AllBitsSet),
            20 => Vector128.AllWhereAllBitsSet(a),
            21 => a.Equals((object)a.AsInt32()),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
        return result ? 1 : 0;
    }

    public static int FloatIndex(int i, int j)
    {
        var a = F(i);
        float value = F(j).GetElement(1);
        return (Vector128.IndexOf(a, value) * 10) + Vector128.LastIndexOf(a, value) + (Vector128.Count(a, value) * 100);
    }

    // What only ordered, distinct lanes answer alike everywhere.
    public static long Native(int op, int i, int j)
    {
        var a = P(i);
        var b = P(j + 1);
        return op switch
        {
            0 => Hash(Vector128.MinNative(a, b)),
            1 => Hash(Vector128.MaxNative(a, b)),
            2 => Hash(Vector128.ClampNative(a, Vector128.Min(a, b), Vector128.Max(a, b))),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // Estimates of exact products and sums: small dyadic lanes.
    public static long Estimates(int op, int i)
    {
        var a = Vector128.Create(0.5f * i, -1.25f, 3f, 0.75f);
        var b = Vector128.Create(2f, i, -0.5f, 4f);
        var c = Vector128.Create(1f, 0.25f, i, -8f);
        return op switch
        {
            0 => Hash(Vector128.MultiplyAddEstimate(a, b, c)),
            1 => Hash(Vector128.Lerp(a, b, Vector128.Create(0.25f))),
            2 => Hash(Vector128.Lerp(a, b, Vector128.Create(0.5f, 0f, 1f, 0.75f))),
            3 => Hash(Vector128.MultiplyAddEstimate(Vector128.Create(0.5 * i, 3.0), Vector128.Create(2.0, i), Vector128.Create(1.0, -2.0))),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // One lane of a transcendental function (within ulps of the CLR's).
    public static float Transcendental(int op, int lane, float x)
    {
        var v = Vector128.Create(x, x * 0.5f, -x, x + 1f);
        var result = op switch
        {
            0 => Vector128.Sin(v),
            1 => Vector128.Cos(v),
            2 => Vector128.Exp(v),
            3 => Vector128.Log(Vector128.Abs(v)),
            4 => Vector128.Log2(Vector128.Abs(v)),
            5 => Vector128.Asin(v * 0.125f),
            6 => Vector128.SinCos(v).Cos,
            7 => Vector128.DegreesToRadians(v),
            8 => Vector128.RadiansToDegrees(v),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
        return result.GetElement(lane);
    }

    public static double TranscendentalDouble(int op, int lane, double x)
    {
        var v = Vector128.Create(x, -0.5 * x);
        var result = op switch
        {
            0 => Vector128.Sin(v),
            1 => Vector128.Cos(v),
            2 => Vector128.Exp(v),
            3 => Vector128.Log(Vector128.Abs(v)),
            4 => Vector128.Hypot(v, Vector128.Create(3.0, x)),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
        return result.GetElement(lane);
    }

    // Two double vectors: op 0 to 22.
    public static long DoubleBinary(int op, int i, int j)
    {
        var a = D(i);
        var b = D(j);
        return op switch
        {
            0 => Hash(a + b),
            1 => Hash(a - b),
            2 => Hash(a * b),
            3 => Hash(a / b),
            4 => Hash(Vector128.Min(a, b)),
            5 => Hash(Vector128.Max(a, b)),
            6 => Hash(Vector128.MinNumber(a, b)),
            7 => Hash(Vector128.MaxMagnitude(a, b)),
            8 => Hash(Vector128.CopySign(a, b)),
            9 => Hash(Vector128.Equals(a, b)),
            10 => Hash(Vector128.LessThan(a, b)),
            11 => Hash(Vector128.GreaterThanOrEqual(a, b)),
            12 => Hash(Vector128.Sqrt(a)),
            13 => Hash(Vector128.Floor(a)),
            14 => Hash(Vector128.Round(a)),
            15 => Hash(Vector128.Narrow(a, b)),
            16 => Hash(Vector128.NarrowWithSaturation(a, b)),
            17 => Hash(Vector128.ConvertToInt64(a)),
            18 => Hash(Vector128.ConvertToUInt64(a)),
            19 => Bits(Vector128.Sum(a)),
            20 => Bits(Vector128.Dot(a, b)),
            21 => Hash(Vector128.FusedMultiplyAdd(a, b, D(i + j))),
            22 => (Vector128.EqualsAll(a, b) ? 1 : 0) + (a.Equals(b) ? 2 : 0) + (Vector128.IsNaN(a).ExtractMostSignificantBits() * 4),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // Integer lanes: op 0 to 41 over T.
    private static long Integer<T>(int op, int i, int j)
        where T : IBinaryInteger<T>, IMinMaxValue<T>
    {
        var a = I<T>(i);
        var b = I<T>(j);
        int shift = (int)(Integers[j % Integers.Length] & 127);
        return op switch
        {
            0 => Hash(a + b),
            1 => Hash(a - b),
            2 => Hash(a * b),
            3 => Hash(a / (b | Vector128<T>.One)),
            4 => Hash(Vector128.Min(a, b)),
            5 => Hash(Vector128.Max(a, b)),
            6 => Hash(Vector128.AddSaturate(a, b)),
            7 => Hash(Vector128.SubtractSaturate(a, b)),
            8 => Hash(a & b),
            9 => Hash(a | b),
            10 => Hash(a ^ b),
            11 => Hash(Vector128.AndNot(a, b)),
            12 => Hash(Vector128.Equals(a, b)),
            13 => Hash(Vector128.LessThan(a, b)),
            14 => Hash(Vector128.LessThanOrEqual(a, b)),
            15 => Hash(Vector128.GreaterThan(a, b)),
            16 => Hash(Vector128.GreaterThanOrEqual(a, b)),
            17 => Hash(a << shift),
            18 => Hash(a >> shift),
            19 => Hash(a >>> shift),
            20 => Hash(Vector128.Abs(a)),
            21 => Hash(-a),
            22 => Hash(~a),
            23 => long.CreateTruncating(Vector128.Sum(a)),
            24 => long.CreateTruncating(Vector128.Dot(a, b)),
            25 => a.ExtractMostSignificantBits(),
            26 => Hash(Vector128.Reverse(a) + Vector128.ZipLower(a, b)),
            27 => Hash(Vector128.CopySign(a, b)),
            28 => Hash(Vector128.IsNegative(a)),
            29 => Hash(Vector128.IsPositive(a)),
            30 => Hash(Vector128.IsZero(a & b)),
            31 => Hash(Vector128.IsEvenInteger(a)),
            32 => Hash(Vector128.IsOddInteger(a)),
            33 => Hash(Vector128.MinMagnitude(a, b)),
            34 => Hash(Vector128.MaxMagnitudeNumber(a, b)),
            35 => Hash(Vector128.Clamp(a, Vector128.Min(b, I<T>(i + j)), Vector128.Max(b, I<T>(i + j)))),
            36 => Hash(Vector128.CreateSequence(T.CreateTruncating(Integers[i % Integers.Length]), T.CreateTruncating(Integers[j % Integers.Length]))),
            37 => (Vector128.EqualsAll(a, b) ? 1 : 0) + (Vector128.LessThanAny(a, b) ? 2 : 0) + (Vector128.GreaterThanAll(a, b) ? 4 : 0)
                  + (a == b ? 8 : 0) + (a != b ? 16 : 0) + (a.Equals(b) ? 32 : 0),
            38 => (Vector128.IndexOf(a, b[0]) * 100) + (Vector128.LastIndexOf(a, b[0]) * 10) + Vector128.Count(a, b[0]),
            39 => Hash(Vector128.ConditionalSelect(Vector128.GreaterThan(a, b), a, b)),
            40 => Hash(Vector128.MinNative(a, b)),
            41 => Hash(Vector128.MaxNative(a, b)),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    public static long SBytes(int op, int i, int j) => Integer<sbyte>(op, i, j);

    public static long Bytes(int op, int i, int j) => Integer<byte>(op, i, j);

    public static long Shorts(int op, int i, int j) => Integer<short>(op, i, j);

    public static long UShorts(int op, int i, int j) => Integer<ushort>(op, i, j);

    public static long Ints(int op, int i, int j) => Integer<int>(op, i, j);

    public static long UInts(int op, int i, int j) => Integer<uint>(op, i, j);

    public static long Longs(int op, int i, int j) => Integer<long>(op, i, j);

    public static long ULongs(int op, int i, int j) => Integer<ulong>(op, i, j);

    // Integer division by zero in a lane throws, as a scalar division does.
    public static long DivideByZero(int i) => Hash(I<int>(i) / I<int>(0));

    // Widening, narrowing and converting between element types: op 0 to 21.
    public static long Conversions(int op, int i, int j)
    {
        return op switch
        {
            0 => Hash(Vector128.WidenLower(I<sbyte>(i))) + Hash(Vector128.WidenUpper(I<sbyte>(i))),
            1 => Hash(Vector128.WidenLower(I<byte>(i))) + Hash(Vector128.WidenUpper(I<byte>(i))),
            2 => Hash(Vector128.WidenLower(I<short>(i))) + Hash(Vector128.WidenUpper(I<short>(i))),
            3 => Hash(Vector128.WidenLower(I<ushort>(i))) + Hash(Vector128.WidenUpper(I<ushort>(i))),
            4 => Hash(Vector128.WidenLower(I<int>(i))) + Hash(Vector128.WidenUpper(I<int>(i))),
            5 => Hash(Vector128.WidenLower(I<uint>(i))) + Hash(Vector128.WidenUpper(I<uint>(i))),
            6 => Hash(Vector128.Narrow(I<short>(i), I<short>(j))),
            7 => Hash(Vector128.Narrow(I<ushort>(i), I<ushort>(j))),
            8 => Hash(Vector128.Narrow(I<int>(i), I<int>(j))),
            9 => Hash(Vector128.Narrow(I<uint>(i), I<uint>(j))),
            10 => Hash(Vector128.Narrow(I<long>(i), I<long>(j))),
            11 => Hash(Vector128.Narrow(I<ulong>(i), I<ulong>(j))),
            12 => Hash(Vector128.NarrowWithSaturation(I<short>(i), I<short>(j))),
            13 => Hash(Vector128.NarrowWithSaturation(I<ushort>(i), I<ushort>(j))),
            14 => Hash(Vector128.NarrowWithSaturation(I<int>(i), I<int>(j))),
            15 => Hash(Vector128.NarrowWithSaturation(I<uint>(i), I<uint>(j))),
            16 => Hash(Vector128.NarrowWithSaturation(I<long>(i), I<long>(j))),
            17 => Hash(Vector128.NarrowWithSaturation(I<ulong>(i), I<ulong>(j))),
            18 => Hash(Vector128.ConvertToSingle(I<int>(i))),
            19 => Hash(Vector128.ConvertToSingle(I<uint>(i))),
            20 => Hash(Vector128.ConvertToDouble(I<long>(i))),
            21 => Hash(Vector128.ConvertToDouble(I<ulong>(i))),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // Rearranging lanes: op 0 to 11.
    public static long Rearrange(int op, int i, int j)
    {
        var a = I<int>(i);
        var b = I<int>(j);
        var bytes = I<byte>(i);
        return op switch
        {
            0 => Hash(Vector128.ZipLower(a, b)),
            1 => Hash(Vector128.ZipUpper(a, b)),
            2 => Hash(Vector128.UnzipEven(a, b)),
            3 => Hash(Vector128.UnzipOdd(a, b)),
            4 => Hash(Vector128.ConcatLowerLower(a, b)),
            5 => Hash(Vector128.ConcatUpperUpper(a, b)),
            6 => Hash(Vector128.ConcatLowerUpper(a, b)),
            7 => Hash(Vector128.ConcatUpperLower(a, b)),
            8 => Hash(Vector128.Reverse(bytes)),
            9 => Hash(Vector128.Shuffle(bytes, I<byte>(j))),
            10 => Hash(Vector128.Shuffle(I<long>(i), Vector128.Create((long)(j % 3), -1))),
            11 => Hash(Vector128.Shuffle(I<short>(i), I<short>(j) & Vector128.Create((short)15))),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // Construction, elements and constants: op 0 to 17.
    public static long Elements(int op, int i)
    {
        var a = F(i);
        return op switch
        {
            0 => Hash(a.WithElement(i % 4, 42.5f)),
            1 => Bits(a.GetElement(i % 4)),
            2 => Bits(a[(i + 1) % 4]),
            3 => Hash(Vector128.CreateScalar(Floats[i % Floats.Length])),
            4 => Hash(Vector128<float>.Indices),
            5 => Hash(Vector128<int>.Indices),
            6 => Hash(Vector128<float>.One),
            7 => Hash(Vector128<ushort>.AllBitsSet),
            8 => Hash(Vector128<float>.Pi) + Hash(Vector128<double>.E) + Hash(Vector128<float>.Tau),
            9 => Hash(Vector128<float>.NaN) + Hash(Vector128<float>.NegativeZero) + Hash(Vector128<double>.Epsilon),
            10 => Hash(Vector128<sbyte>.NegativeOne) + Hash(Vector128<int>.SignSequence) + Hash(Vector128<float>.SignSequence),
            11 => Hash(Vector128.Create(new float[] { 1f, 2f, 3f, 4f, 5f }, i % 2)),
            12 => Hash(Vector128.Create((ReadOnlySpan<int>)[4, 3, 2, 1])),
            13 => Hash(Vector128.CreateAlternatingSequence(1.5f, -2f)),
            14 => Hash(Vector128.CreateGeometricSequence(3, 2)),
            15 => Vector128<byte>.Count * 1000 + Vector128<double>.Count * 100 + (Vector128.IsHardwareAccelerated ? 1 : 0),
            16 => Hash(Vector128.Create(1.5, -2.5).WithElement(1, 7.0)),
            17 => Hash(a.AsDouble().AsSingle()) + Hash(a.AsByte()) + Hash(a.As<float, uint>()),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // An element index out of range throws ArgumentOutOfRangeException.
    public static float ElementOutOfRange(int index) => Vector128.Create(1f, 2f, 3f, 4f).GetElement(index);

    public static float IndexerOutOfRange(int index) => Vector128.Create(1f, 2f, 3f, 4f)[index];

    public static long WithElementOutOfRange(int index) => Hash(Vector128.Create(1, 2, 3, 4).WithElement(index, 9));

    // Copying to and from arrays and spans, and what does not fit.
    public static long Copies(int op, int length)
    {
        var a = Vector128.Create(1, 2, 3, 4);
        var array = new int[length];
        switch (op)
        {
            case 0:
                a.CopyTo(array);
                break;
            case 1:
                a.CopyTo(array, 1);
                break;
            case 2:
                a.CopyTo((Span<int>)array);
                break;
            case 3:
                return a.TryCopyTo(array) ? array[length - 1] : -1;
            case 4:
                return Hash(Vector128.Create(array));
            case 5:
                return Hash(Vector128.Create(array, 1));
        }

        long hash = 0;
        foreach (int value in array)
        {
            hash = (hash * 31) + value;
        }

        return hash;
    }

    public static string Text(int i) => F(i).ToString() + Vector128.Create(1, -2, 3, 40).ToString() + Vector128.Create((byte)7).ToString();

    public static int TextLength(int i) => Text(i).Length;

    public static int TextHash(int i)
    {
        int hash = 0;
        foreach (char c in Text(i))
        {
            hash = (hash * 31) + c;
        }

        return hash;
    }

    // A Vector128 as a value: in fields, arrays, lists, references, boxes,
    // dictionaries and generic code.
    private struct Particle
    {
        public Vector128<float> Position;
        public Vector128<float> Velocity;
        public int Id;

        public void Step(float dt) => Position += Velocity * dt;
    }

    private sealed class Holder
    {
        public Vector128<int> Value = Vector128.Create(1, 2, 3, 4);
        public static Vector128<int> Shared;
    }

    private sealed class Cell<T>
    {
        public T Value;
    }

    private static void Bump(ref Vector128<int> vector, int amount) => vector += Vector128.Create(amount);

    private static void Make(out Vector128<int> vector, int seed) => vector = Vector128.Create(seed, seed + 1, seed + 2, seed + 3);

    private static Vector128<T> Twice<T>(Vector128<T> vector) => vector + vector;

    private static T First<T>(Vector128<T> vector) => vector.GetElement(0);

    public static long Values(int op, int n)
    {
        switch (op)
        {
            case 0:
            {
                var particles = new Particle[n];
                for (int index = 0; index < n; index++)
                {
                    particles[index].Position = Vector128.Create((float)index);
                    particles[index].Velocity = Vector128.Create(1f, -1f, 0.5f, 2f);
                    particles[index].Id = index;
                    particles[index].Step(0.5f);
                }

                long hash = 0;
                foreach (var particle in particles)
                {
                    hash = (hash * 31) + Hash(particle.Position) + particle.Id;
                }

                return hash;
            }

            case 1:
            {
                var vectors = new Vector128<int>[n];
                for (int index = 0; index < n; index++)
                {
                    vectors[index] = Vector128.Create(index) * Vector128.Create(1, 2, 3, 4);
                }

                var sum = Vector128<int>.Zero;
                foreach (var vector in vectors)
                {
                    sum += vector;
                }

                Array.Reverse(vectors);
                return Hash(sum) + Hash(vectors[0]);
            }

            case 2:
            {
                var list = new List<Vector128<float>>();
                for (int index = 0; index < n; index++)
                {
                    list.Add(F(index));
                }

                return (list.Contains(F(n / 2)) ? 1 : 0) + (list.IndexOf(F(1)) * 10) + (list.Contains(Vector128.Create(123f)) ? 100 : 0);
            }

            case 3:
            {
                var holder = new Holder();
                Bump(ref holder.Value, n);
                Holder.Shared = holder.Value;
                Bump(ref Holder.Shared, 1);
                var local = Holder.Shared;
                Bump(ref local, 1);
                Make(out var made, n);
                var array = new Vector128<int>[2];
                Bump(ref array[1], n);
                return Hash(holder.Value) + Hash(Holder.Shared) + Hash(local) + Hash(made) + Hash(array[1]);
            }

            case 4:
            {
                object boxed = Vector128.Create(n, 2, 3, 4);
                object other = Vector128.Create(n, 2, 3, 4);
                var unboxed = (Vector128<int>)boxed;
                IEquatable<Vector128<int>> equatable = unboxed;
                return (boxed.Equals(other) ? 1 : 0) + (boxed.GetHashCode() == other.GetHashCode() ? 2 : 0)
                       + (equatable.Equals(Vector128.Create(n, 2, 3, 4)) ? 4 : 0) + (boxed is Vector128<int> ? 8 : 0)
                       + (boxed is Vector128<float> ? 16 : 0) + (boxed.Equals(Vector128.Create(n, 2, 3, 5)) ? 32 : 0) + Hash(unboxed);
            }

            case 5:
            {
                var counts = new Dictionary<Vector128<int>, int>();
                for (int index = 0; index < n * 3; index++)
                {
                    var key = Vector128.Create(index % n, 0, index % 2, 1);
                    counts[key] = counts.TryGetValue(key, out int count) ? count + 1 : 1;
                }

                return (counts.Count * 1000) + counts[Vector128.Create(0, 0, 0, 1)];
            }

            case 6:
            {
                var cell = new Cell<Vector128<double>> { Value = Vector128.Create(n, 0.5) };
                var ints = new Cell<Vector128<int>> { Value = Vector128.Create(n) };
                return Hash(Twice(cell.Value)) + Hash(Twice(ints.Value)) + Bits(First(cell.Value)) + First(Twice(ints.Value));
            }

            case 7:
            {
                Vector128<float> vector = default;
                var copy = vector;
                vector = vector.WithElement(1, n);
                return Hash(vector) + Hash(copy) + (EqualityComparer<Vector128<float>>.Default.Equals(vector, copy) ? 1 : 0);
            }
        }

        throw new ArgumentOutOfRangeException(nameof(op));
    }

    // Loads and stores through references to array elements.
    public static long Memory(int offset)
    {
        var floats = new float[] { 1f, 2f, 3f, 4f, 5f, 6f, 7f, 8f };
        var vector = Vector128.LoadUnsafe(ref floats[offset]);
        (vector * 2f).StoreUnsafe(ref floats[4 - offset]);
        long hash = Hash(vector);
        foreach (float value in floats)
        {
            hash = (hash * 31) + Bits(value);
        }

        return hash;
    }
}
