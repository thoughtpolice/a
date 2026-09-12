// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Vector128 and Vector128<T> (docs/IMPORTER.md, "SIMD as built"): the
// importer's Wasm v128, whose members FunctionEmitter.Simd lowers to SIMD
// instructions where one or a few do what the member does. These are the
// rest, and the lanes those instructions do not take (an 8-bit multiply, a
// 64-bit minimum, integer division), in terms of them and of
// dotnet/runtime's Scalar<T>, after dotnet/runtime's Vector128.cs and
// VectorMath.cs: the definitions of Min, Max and their Magnitude and Number
// forms, CopySign, the classification tests, Lerp and the sequences are
// theirs. The transcendental functions (Sin, Cos, Exp, Log, Asin, Hypot of
// doubles) are the scalar ones applied to each element, where the CLR
// computes them with vectorized approximations of its own, which can
// differ in the last bits.

using System;
using System.Diagnostics.CodeAnalysis;
using System.Numerics;
using System.Runtime.CompilerServices;
using Gameplay.Runtime;

#pragma warning disable CS0626 // FunctionEmitter.Simd implements the extern members.

namespace System.Runtime.CompilerServices
{
    // What dotnet/runtime's sources mark the members a JIT implements
    // itself with; metadata here.
    [AttributeUsage(
        AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Method | AttributeTargets.Constructor
            | AttributeTargets.Field | AttributeTargets.Property | AttributeTargets.Interface,
        Inherited = false)]
    internal sealed class IntrinsicAttribute : Attribute
    {
    }
}

namespace System.Runtime.Intrinsics
{
    [Surface]
    public static partial class Vector128
    {
        // A lane chosen at run time, unchecked (FunctionEmitter.Simd).
        internal static extern T GetElementUnsafe<T>(this Vector128<T> vector, int index);

        internal static extern Vector128<T> WithElementUnsafe<T>(this Vector128<T> vector, int index, T value);

        // The lanes from a span's elements at an offset, unchecked: the
        // caller has a vector's worth there (FunctionEmitter.Simd).
        internal static extern Vector128<T> LoadSpan<T>(ReadOnlySpan<T> span, int offset);

        // What a Vector128<T> value's own members run: Equals(object),
        // GetHashCode and ToString (FunctionEmitter.Simd).
        internal static bool ObjectEquals<T>(Vector128<T> vector, object? obj) =>
            obj is Vector128<T> other && vector.Equals(other);

        internal static int Hash<T>(Vector128<T> vector)
        {
            HashCode hash = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                hash.Add(vector.GetElementUnsafe(index));
            }

            return hash.ToHashCode();
        }

        // "<e0, e1, ...>", each element as its ToString writes it in the
        // invariant culture (whose group separator is ",").
        internal static string Format<T>(Vector128<T> vector)
        {
            string text = "<";
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                if (index > 0)
                {
                    text += ", ";
                }

                text += vector.GetElementUnsafe(index)!.ToString();
            }

            return text + ">";
        }

        public static T GetElement<T>(this Vector128<T> vector, int index)
        {
            if ((uint)index >= (uint)Vector128<T>.Count)
            {
                ThrowHelper.ThrowArgumentOutOfRangeException(ExceptionArgument.index);
            }

            return vector.GetElementUnsafe(index);
        }

        public static Vector128<T> WithElement<T>(this Vector128<T> vector, int index, T value)
        {
            if ((uint)index >= (uint)Vector128<T>.Count)
            {
                ThrowHelper.ThrowArgumentOutOfRangeException(ExceptionArgument.index);
            }

            return vector.WithElementUnsafe(index, value);
        }

        // The lanes FunctionEmitter.Simd has no instruction for, an element
        // at a time.
        public static Vector128<T> Multiply<T>(Vector128<T> left, Vector128<T> right)
        {
            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, Scalar<T>.Multiply(left.GetElementUnsafe(index), right.GetElementUnsafe(index)));
            }

            return result;
        }

        public static Vector128<T> Multiply<T>(Vector128<T> left, T right) => Multiply(left, Create(right));

        public static Vector128<T> Multiply<T>(T left, Vector128<T> right) => Multiply(Create(left), right);

        public static Vector128<T> Divide<T>(Vector128<T> left, Vector128<T> right)
        {
            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, Scalar<T>.Divide(left.GetElementUnsafe(index), right.GetElementUnsafe(index)));
            }

            return result;
        }

        public static Vector128<T> Divide<T>(Vector128<T> left, T right) => Divide(left, Create(right));

        public static Vector128<T> AddSaturate<T>(Vector128<T> left, Vector128<T> right)
        {
            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, Scalar<T>.AddSaturate(left.GetElementUnsafe(index), right.GetElementUnsafe(index)));
            }

            return result;
        }

        public static Vector128<T> SubtractSaturate<T>(Vector128<T> left, Vector128<T> right)
        {
            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, Scalar<T>.SubtractSaturate(left.GetElementUnsafe(index), right.GetElementUnsafe(index)));
            }

            return result;
        }

        public static Vector128<T> Sqrt<T>(Vector128<T> vector)
        {
            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, Scalar<T>.Sqrt(vector.GetElementUnsafe(index)));
            }

            return result;
        }

        // 64-bit integer lanes: by comparison.
        public static Vector128<T> Min<T>(Vector128<T> left, Vector128<T> right) =>
            ConditionalSelect(LessThan(left, right), left, right);

        public static Vector128<T> Max<T>(Vector128<T> left, Vector128<T> right) =>
            ConditionalSelect(GreaterThan(left, right), left, right);

        public static Vector128<T> MinNative<T>(Vector128<T> left, Vector128<T> right) => Min(left, right);

        public static Vector128<T> MaxNative<T>(Vector128<T> left, Vector128<T> right) => Max(left, right);

        public static T Sum<T>(Vector128<T> vector)
        {
            T sum = default!;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                sum = Scalar<T>.Add(sum, vector.GetElementUnsafe(index));
            }

            return sum;
        }

        public static T Dot<T>(Vector128<T> left, Vector128<T> right) => Sum(Multiply(left, right));

        public static Vector128<T> Clamp<T>(Vector128<T> value, Vector128<T> min, Vector128<T> max) => Min(Max(value, min), max);

        public static Vector128<T> ClampNative<T>(Vector128<T> value, Vector128<T> min, Vector128<T> max) =>
            MinNative(MaxNative(value, min), max);

        public static Vector128<T> MaxMagnitude<T>(Vector128<T> left, Vector128<T> right)
        {
            if (typeof(T) == typeof(float) || typeof(T) == typeof(double))
            {
                var leftMagnitude = Abs(left);
                var rightMagnitude = Abs(right);
                return ConditionalSelect(
                    GreaterThan(leftMagnitude, rightMagnitude) | IsNaN(leftMagnitude)
                    | (Equals(leftMagnitude, rightMagnitude) & IsPositive(left)),
                    left,
                    right);
            }

            return MaxMagnitudeNumber(left, right);
        }

        public static Vector128<T> MaxMagnitudeNumber<T>(Vector128<T> left, Vector128<T> right)
        {
            if (Scalar<T>.IsUnsigned)
            {
                return Max(left, right);
            }

            var leftMagnitude = Abs(left);
            var rightMagnitude = Abs(right);
            if (typeof(T) == typeof(float) || typeof(T) == typeof(double))
            {
                return ConditionalSelect(
                    GreaterThan(leftMagnitude, rightMagnitude) | IsNaN(rightMagnitude)
                    | (Equals(leftMagnitude, rightMagnitude) & IsPositive(left)),
                    left,
                    right);
            }

            return ConditionalSelect(
                (GreaterThan(leftMagnitude, rightMagnitude) & IsPositive(rightMagnitude))
                | (Equals(leftMagnitude, rightMagnitude) & IsPositive(left)) | IsNegative(leftMagnitude),
                left,
                right);
        }

        public static Vector128<T> MaxNumber<T>(Vector128<T> left, Vector128<T> right)
        {
            if (typeof(T) == typeof(float) || typeof(T) == typeof(double))
            {
                return ConditionalSelect(
                    GreaterThan(left, right) | IsNaN(right) | (Equals(left, right) & IsNegative(right)),
                    left,
                    right);
            }

            return Max(left, right);
        }

        public static Vector128<T> MinMagnitude<T>(Vector128<T> left, Vector128<T> right)
        {
            if (typeof(T) == typeof(float) || typeof(T) == typeof(double))
            {
                var leftMagnitude = Abs(left);
                var rightMagnitude = Abs(right);
                return ConditionalSelect(
                    LessThan(leftMagnitude, rightMagnitude) | IsNaN(leftMagnitude)
                    | (Equals(leftMagnitude, rightMagnitude) & IsNegative(left)),
                    left,
                    right);
            }

            return MinMagnitudeNumber(left, right);
        }

        public static Vector128<T> MinMagnitudeNumber<T>(Vector128<T> left, Vector128<T> right)
        {
            if (Scalar<T>.IsUnsigned)
            {
                return Min(left, right);
            }

            var leftMagnitude = Abs(left);
            var rightMagnitude = Abs(right);
            if (typeof(T) == typeof(float) || typeof(T) == typeof(double))
            {
                return ConditionalSelect(
                    LessThan(leftMagnitude, rightMagnitude) | IsNaN(rightMagnitude)
                    | (Equals(leftMagnitude, rightMagnitude) & IsNegative(left)),
                    left,
                    right);
            }

            return ConditionalSelect(
                (LessThan(leftMagnitude, rightMagnitude) & IsPositive(leftMagnitude))
                | (Equals(leftMagnitude, rightMagnitude) & IsNegative(left)) | IsNegative(rightMagnitude),
                left,
                right);
        }

        public static Vector128<T> MinNumber<T>(Vector128<T> left, Vector128<T> right)
        {
            if (typeof(T) == typeof(float) || typeof(T) == typeof(double))
            {
                return ConditionalSelect(
                    LessThan(left, right) | IsNaN(right) | (Equals(left, right) & IsNegative(left)),
                    left,
                    right);
            }

            return Min(left, right);
        }

        public static Vector128<T> CopySign<T>(Vector128<T> value, Vector128<T> sign)
        {
            if (Scalar<T>.IsUnsigned)
            {
                return value;
            }

            if (typeof(T) == typeof(float))
            {
                return ConditionalSelect(Create(-0.0f).As<float, T>(), sign, value);
            }

            if (typeof(T) == typeof(double))
            {
                return ConditionalSelect(Create(-0.0).As<double, T>(), sign, value);
            }

            return ConditionalSelect(IsNegative(value ^ sign), -value, value);
        }

        // The classification tests, lanes of all ones where they hold.
        public static Vector128<T> IsNaN<T>(Vector128<T> vector) =>
            typeof(T) == typeof(float) || typeof(T) == typeof(double) ? ~Equals(vector, vector) : Vector128<T>.Zero;

        public static Vector128<T> IsNegative<T>(Vector128<T> vector)
        {
            if (Scalar<T>.IsUnsigned)
            {
                return Vector128<T>.Zero;
            }

            if (typeof(T) == typeof(float))
            {
                return LessThan(vector.AsInt32(), Vector128<int>.Zero).As<int, T>();
            }

            if (typeof(T) == typeof(double))
            {
                return LessThan(vector.AsInt64(), Vector128<long>.Zero).As<long, T>();
            }

            return LessThan(vector, Vector128<T>.Zero);
        }

        public static Vector128<T> IsPositive<T>(Vector128<T> vector)
        {
            if (Scalar<T>.IsUnsigned)
            {
                return Vector128<T>.AllBitsSet;
            }

            if (typeof(T) == typeof(float))
            {
                return GreaterThanOrEqual(vector.AsInt32(), Vector128<int>.Zero).As<int, T>();
            }

            if (typeof(T) == typeof(double))
            {
                return GreaterThanOrEqual(vector.AsInt64(), Vector128<long>.Zero).As<long, T>();
            }

            return GreaterThanOrEqual(vector, Vector128<T>.Zero);
        }

        public static Vector128<T> IsZero<T>(Vector128<T> vector) => Equals(vector, Vector128<T>.Zero);

        public static Vector128<T> IsPositiveInfinity<T>(Vector128<T> vector)
        {
            if (typeof(T) == typeof(float))
            {
                return Equals(vector.AsSingle(), Create(float.PositiveInfinity)).As<float, T>();
            }

            if (typeof(T) == typeof(double))
            {
                return Equals(vector.AsDouble(), Create(double.PositiveInfinity)).As<double, T>();
            }

            return Vector128<T>.Zero;
        }

        public static Vector128<T> IsNegativeInfinity<T>(Vector128<T> vector)
        {
            if (typeof(T) == typeof(float))
            {
                return Equals(vector.AsSingle(), Create(float.NegativeInfinity)).As<float, T>();
            }

            if (typeof(T) == typeof(double))
            {
                return Equals(vector.AsDouble(), Create(double.NegativeInfinity)).As<double, T>();
            }

            return Vector128<T>.Zero;
        }

        public static Vector128<T> IsInfinity<T>(Vector128<T> vector) =>
            typeof(T) == typeof(float) || typeof(T) == typeof(double) ? IsPositiveInfinity(Abs(vector)) : Vector128<T>.Zero;

        public static Vector128<T> IsFinite<T>(Vector128<T> vector)
        {
            if (typeof(T) == typeof(float))
            {
                return (~IsZero(AndNot(Create(0x7F80_0000u), vector.AsUInt32()))).As<uint, T>();
            }

            if (typeof(T) == typeof(double))
            {
                return (~IsZero(AndNot(Create(0x7FF0_0000_0000_0000ul), vector.AsUInt64()))).As<ulong, T>();
            }

            return Vector128<T>.AllBitsSet;
        }

        public static Vector128<T> IsInteger<T>(Vector128<T> vector)
        {
            if (typeof(T) == typeof(float))
            {
                var value = vector.AsSingle();
                return (IsFinite(value) & Equals(value, Truncate(value))).As<float, T>();
            }

            if (typeof(T) == typeof(double))
            {
                var value = vector.AsDouble();
                return (IsFinite(value) & Equals(value, Truncate(value))).As<double, T>();
            }

            return Vector128<T>.AllBitsSet;
        }

        public static Vector128<T> IsEvenInteger<T>(Vector128<T> vector)
        {
            if (typeof(T) == typeof(float))
            {
                var half = vector.AsSingle() * Create(0.5f);
                return (IsInteger(vector.AsSingle()) & Equals(half, Truncate(half))).As<float, T>();
            }

            if (typeof(T) == typeof(double))
            {
                var half = vector.AsDouble() * Create(0.5);
                return (IsInteger(vector.AsDouble()) & Equals(half, Truncate(half))).As<double, T>();
            }

            return IsZero(vector & Vector128<T>.One);
        }

        public static Vector128<T> IsOddInteger<T>(Vector128<T> vector)
        {
            if (typeof(T) == typeof(float) || typeof(T) == typeof(double))
            {
                return IsInteger(vector) & ~IsEvenInteger(vector);
            }

            return ~IsZero(vector & Vector128<T>.One);
        }

        public static Vector128<T> IsNormal<T>(Vector128<T> vector)
        {
            if (typeof(T) == typeof(float))
            {
                return LessThan(Abs(vector).AsUInt32() - Create(0x0080_0000u), Create(0x7F80_0000u - 0x0080_0000u)).As<uint, T>();
            }

            if (typeof(T) == typeof(double))
            {
                return LessThan(
                    Abs(vector).AsUInt64() - Create(0x0010_0000_0000_0000ul),
                    Create(0x7FF0_0000_0000_0000ul - 0x0010_0000_0000_0000ul)).As<ulong, T>();
            }

            return ~IsZero(vector);
        }

        public static Vector128<T> IsSubnormal<T>(Vector128<T> vector)
        {
            if (typeof(T) == typeof(float))
            {
                return LessThan(Abs(vector).AsUInt32() - Vector128<uint>.One, Create(0x007F_FFFFu)).As<uint, T>();
            }

            if (typeof(T) == typeof(double))
            {
                return LessThan(Abs(vector).AsUInt64() - Vector128<ulong>.One, Create(0x000F_FFFF_FFFF_FFFFul)).As<ulong, T>();
            }

            return Vector128<T>.Zero;
        }

        // Counting and searching the lanes.
        public static bool All<T>(Vector128<T> vector, T value) => EqualsAll(vector, Create(value));

        public static bool Any<T>(Vector128<T> vector, T value) => EqualsAny(vector, Create(value));

        public static bool None<T>(Vector128<T> vector, T value) => !EqualsAny(vector, Create(value));

        public static int Count<T>(Vector128<T> vector, T value) => CountMatches(Equals(vector, Create(value)));

        public static int IndexOf<T>(Vector128<T> vector, T value) => IndexOfFirstMatch(Equals(vector, Create(value)));

        public static int LastIndexOf<T>(Vector128<T> vector, T value) => IndexOfLastMatch(Equals(vector, Create(value)));

        public static bool AllWhereAllBitsSet<T>(Vector128<T> vector) => EqualsAll(vector.AsByte(), Vector128<byte>.AllBitsSet);

        public static bool AnyWhereAllBitsSet<T>(Vector128<T> vector) => AllBitsSetLanes(vector).ExtractMostSignificantBits() != 0;

        public static bool NoneWhereAllBitsSet<T>(Vector128<T> vector) => !AnyWhereAllBitsSet(vector);

        public static int CountWhereAllBitsSet<T>(Vector128<T> vector) => CountMatches(AllBitsSetLanes(vector));

        public static int IndexOfWhereAllBitsSet<T>(Vector128<T> vector) => IndexOfFirstMatch(AllBitsSetLanes(vector));

        public static int LastIndexOfWhereAllBitsSet<T>(Vector128<T> vector) => IndexOfLastMatch(AllBitsSetLanes(vector));

        // The lanes whose bits are all set, as a mask of the same lanes.
        private static Vector128<T> AllBitsSetLanes<T>(Vector128<T> vector)
        {
            if (typeof(T) == typeof(float))
            {
                return Equals(vector.AsInt32(), Vector128<int>.AllBitsSet).As<int, T>();
            }

            if (typeof(T) == typeof(double))
            {
                return Equals(vector.AsInt64(), Vector128<long>.AllBitsSet).As<long, T>();
            }

            return Equals(vector, Vector128<T>.AllBitsSet);
        }

        internal static int CountMatches<T>(Vector128<T> mask) => BitOperations.PopCount(mask.ExtractMostSignificantBits());

        internal static int IndexOfFirstMatch<T>(Vector128<T> mask)
        {
            uint bits = mask.ExtractMostSignificantBits();
            return bits == 0 ? -1 : BitOperations.TrailingZeroCount(bits);
        }

        internal static int IndexOfLastMatch<T>(Vector128<T> mask)
        {
            uint bits = mask.ExtractMostSignificantBits();
            return bits == 0 ? -1 : 31 - BitOperations.LeadingZeroCount(bits);
        }

        // What System.Numerics' vectors ask of their Vector128<float>
        // (dotnet/runtime's Vector128.Numerics.cs): a Vector2's or Vector3's
        // lanes past its own compare as the value never is (-1), or all
        // bits set.
        internal static bool All(Vector2 vector, float value) => vector.AsVector128() == Vector2.Create(value).AsVector128();

        internal static bool All(Vector3 vector, float value) => vector.AsVector128() == Vector3.Create(value).AsVector128();

        internal static bool AllWhereAllBitsSet(Vector2 vector) => vector.AsVector128().AsInt32() == Vector2.AllBitsSet.AsVector128().AsInt32();

        internal static bool AllWhereAllBitsSet(Vector3 vector) => vector.AsVector128().AsInt32() == Vector3.AllBitsSet.AsVector128().AsInt32();

        internal static bool Any(Vector2 vector, float value) => EqualsAny(vector.AsVector128(), Create(value, value, -1, -1));

        internal static bool Any(Vector3 vector, float value) => EqualsAny(vector.AsVector128(), Create(value, value, value, -1));

        internal static bool AnyWhereAllBitsSet(Vector2 vector) => EqualsAny(vector.AsVector128().AsInt32(), Vector128<int>.AllBitsSet);

        internal static bool AnyWhereAllBitsSet(Vector3 vector) => EqualsAny(vector.AsVector128().AsInt32(), Vector128<int>.AllBitsSet);

        internal static int Count(Vector2 vector, float value) => CountMatches(Equals(vector.AsVector128(), Create(value, value, -1, -1)));

        internal static int Count(Vector3 vector, float value) => CountMatches(Equals(vector.AsVector128(), Create(value, value, value, -1)));

        internal static int CountWhereAllBitsSet(Vector2 vector) => CountWhereAllBitsSet(vector.AsVector128());

        internal static int CountWhereAllBitsSet(Vector3 vector) => CountWhereAllBitsSet(vector.AsVector128());

        internal static float Distance(Vector128<float> vector1, Vector128<float> vector2)
        {
            Vector128<float> difference = vector1 - vector2;
            return float.Sqrt(Dot(difference, difference));
        }

        internal static float DistanceSquared(Vector128<float> vector1, Vector128<float> vector2)
        {
            Vector128<float> difference = vector1 - vector2;
            return Dot(difference, difference);
        }

        internal static int IndexOf(Vector2 vector, float value) => IndexOfFirstMatch(Equals(vector.AsVector128(), Create(value, value, -1, -1)));

        internal static int IndexOf(Vector3 vector, float value) => IndexOfFirstMatch(Equals(vector.AsVector128(), Create(value, value, value, -1)));

        internal static int IndexOfWhereAllBitsSet(Vector2 vector) => IndexOfWhereAllBitsSet(vector.AsVector128());

        internal static int IndexOfWhereAllBitsSet(Vector3 vector) => IndexOfWhereAllBitsSet(vector.AsVector128());

        internal static int LastIndexOf(Vector2 vector, float value) => IndexOfLastMatch(Equals(vector.AsVector128(), Create(value, value, -1, -1)));

        internal static int LastIndexOf(Vector3 vector, float value) => IndexOfLastMatch(Equals(vector.AsVector128(), Create(value, value, value, -1)));

        internal static int LastIndexOfWhereAllBitsSet(Vector2 vector) => LastIndexOfWhereAllBitsSet(vector.AsVector128());

        internal static int LastIndexOfWhereAllBitsSet(Vector3 vector) => LastIndexOfWhereAllBitsSet(vector.AsVector128());

        internal static float Length(Vector128<float> vector) => float.Sqrt(Dot(vector, vector));

        internal static float LengthSquared(Vector128<float> vector) => Dot(vector, vector);

        internal static bool None(Vector2 vector, float value) => !EqualsAny(vector.AsVector128(), Create(value, value, -1, -1));

        internal static bool None(Vector3 vector, float value) => !EqualsAny(vector.AsVector128(), Create(value, value, value, -1));

        internal static bool NoneWhereAllBitsSet(Vector2 vector) => !EqualsAny(vector.AsVector128().AsInt32(), Vector128<int>.AllBitsSet);

        internal static bool NoneWhereAllBitsSet(Vector3 vector) => !EqualsAny(vector.AsVector128().AsInt32(), Vector128<int>.AllBitsSet);

        internal static Vector128<float> Normalize(Vector128<float> vector) => vector / Create(float.Sqrt(Dot(vector, vector)));

        // Floating point.
        public static Vector128<float> Lerp(Vector128<float> x, Vector128<float> y, Vector128<float> amount) =>
            MultiplyAddEstimate(x, Vector128<float>.One - amount, y * amount);

        public static Vector128<double> Lerp(Vector128<double> x, Vector128<double> y, Vector128<double> amount) =>
            MultiplyAddEstimate(x, Vector128<double>.One - amount, y * amount);

        // The product rounded, then the sum: what MultiplyAddEstimate
        // documents where there is no fused instruction, which Wasm SIMD
        // does not have (deterministically).
        public static Vector128<float> MultiplyAddEstimate(Vector128<float> left, Vector128<float> right, Vector128<float> addend) =>
            (left * right) + addend;

        public static Vector128<double> MultiplyAddEstimate(Vector128<double> left, Vector128<double> right, Vector128<double> addend) =>
            (left * right) + addend;

        // Rounded once, an element at a time (Gameplay.Runtime.FusedMultiply).
        public static Vector128<float> FusedMultiplyAdd(Vector128<float> left, Vector128<float> right, Vector128<float> addend)
        {
            Vector128<float> result = default;
            for (int index = 0; index < Vector128<float>.Count; index++)
            {
                result = result.WithElementUnsafe(
                    index,
                    FusedMultiply.Add(left.GetElementUnsafe(index), right.GetElementUnsafe(index), addend.GetElementUnsafe(index)));
            }

            return result;
        }

        public static Vector128<double> FusedMultiplyAdd(Vector128<double> left, Vector128<double> right, Vector128<double> addend)
        {
            Vector128<double> result = default;
            for (int index = 0; index < Vector128<double>.Count; index++)
            {
                result = result.WithElementUnsafe(
                    index,
                    FusedMultiply.Add(left.GetElementUnsafe(index), right.GetElementUnsafe(index), addend.GetElementUnsafe(index)));
            }

            return result;
        }

        public static Vector128<float> DegreesToRadians(Vector128<float> degrees) => degrees * Create(float.Pi) / Create(180.0f);

        public static Vector128<double> DegreesToRadians(Vector128<double> degrees) => degrees * Create(double.Pi) / Create(180.0);

        public static Vector128<float> RadiansToDegrees(Vector128<float> radians) => radians * Create(180.0f) / Create(float.Pi);

        public static Vector128<double> RadiansToDegrees(Vector128<double> radians) => radians * Create(180.0) / Create(double.Pi);

        public static Vector128<float> Round(Vector128<float> vector, MidpointRounding mode)
        {
            Vector128<float> result = default;
            for (int index = 0; index < Vector128<float>.Count; index++)
            {
                result = result.WithElementUnsafe(index, (float)Math.Round((double)vector.GetElementUnsafe(index), mode));
            }

            return result;
        }

        public static Vector128<double> Round(Vector128<double> vector, MidpointRounding mode)
        {
            Vector128<double> result = default;
            for (int index = 0; index < Vector128<double>.Count; index++)
            {
                result = result.WithElementUnsafe(index, Math.Round(vector.GetElementUnsafe(index), mode));
            }

            return result;
        }

        // sqrt(x * x + y * y) in doubles, where the squares of floats are
        // exact, as the CLR computes a float's.
        public static Vector128<float> Hypot(Vector128<float> x, Vector128<float> y)
        {
            Vector128<float> result = default;
            for (int index = 0; index < Vector128<float>.Count; index++)
            {
                double a = x.GetElementUnsafe(index);
                double b = y.GetElementUnsafe(index);
                float value = float.IsPositiveInfinity(Math.Abs((float)a)) || float.IsPositiveInfinity(Math.Abs((float)b))
                    ? float.PositiveInfinity
                    : (float)Math.Sqrt((a * a) + (b * b));
                result = result.WithElementUnsafe(index, value);
            }

            return result;
        }

        public static Vector128<double> Hypot(Vector128<double> x, Vector128<double> y) =>
            Elementwise(x, y, static (a, b) => double.Hypot(a, b));

        public static Vector128<float> Sin(Vector128<float> vector) => Elementwise(vector, static value => MathF.Sin(value));

        public static Vector128<double> Sin(Vector128<double> vector) => Elementwise(vector, static value => Math.Sin(value));

        public static Vector128<float> Cos(Vector128<float> vector) => Elementwise(vector, static value => MathF.Cos(value));

        public static Vector128<double> Cos(Vector128<double> vector) => Elementwise(vector, static value => Math.Cos(value));

        public static (Vector128<float> Sin, Vector128<float> Cos) SinCos(Vector128<float> vector) => (Sin(vector), Cos(vector));

        public static (Vector128<double> Sin, Vector128<double> Cos) SinCos(Vector128<double> vector) => (Sin(vector), Cos(vector));

        public static Vector128<float> Asin(Vector128<float> vector) => Elementwise(vector, static value => MathF.Asin(value));

        public static Vector128<double> Asin(Vector128<double> vector) => Elementwise(vector, static value => Math.Asin(value));

        public static Vector128<float> Exp(Vector128<float> vector) => Elementwise(vector, static value => MathF.Exp(value));

        public static Vector128<double> Exp(Vector128<double> vector) => Elementwise(vector, static value => Math.Exp(value));

        public static Vector128<float> Log(Vector128<float> vector) => Elementwise(vector, static value => MathF.Log(value));

        public static Vector128<double> Log(Vector128<double> vector) => Elementwise(vector, static value => Math.Log(value));

        public static Vector128<float> Log2(Vector128<float> vector) => Elementwise(vector, static value => MathF.Log2(value));

        public static Vector128<double> Log2(Vector128<double> vector) => Elementwise(vector, static value => Math.Log2(value));

        private static Vector128<T> Elementwise<T>(Vector128<T> vector, Func<T, T> function)
        {
            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, function(vector.GetElementUnsafe(index)));
            }

            return result;
        }

        private static Vector128<T> Elementwise<T>(Vector128<T> x, Vector128<T> y, Func<T, T, T> function)
        {
            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, function(x.GetElementUnsafe(index), y.GetElementUnsafe(index)));
            }

            return result;
        }

        // Conversions no instruction does, an element at a time; to an
        // integer they saturate, as the CLR's conversions do.
        public static Vector128<double> ConvertToDouble(Vector128<long> vector) =>
            Create((double)vector.GetElementUnsafe(0), (double)vector.GetElementUnsafe(1));

        public static Vector128<double> ConvertToDouble(Vector128<ulong> vector) =>
            Create((double)vector.GetElementUnsafe(0), (double)vector.GetElementUnsafe(1));

        public static Vector128<long> ConvertToInt64(Vector128<double> vector) =>
            Create((long)vector.GetElementUnsafe(0), (long)vector.GetElementUnsafe(1));

        public static Vector128<long> ConvertToInt64Native(Vector128<double> vector) => ConvertToInt64(vector);

        public static Vector128<ulong> ConvertToUInt64(Vector128<double> vector) =>
            Create((ulong)vector.GetElementUnsafe(0), (ulong)vector.GetElementUnsafe(1));

        public static Vector128<ulong> ConvertToUInt64Native(Vector128<double> vector) => ConvertToUInt64(vector);

        public static (Vector128<ushort> Lower, Vector128<ushort> Upper) Widen(Vector128<byte> source) => (WidenLower(source), WidenUpper(source));

        public static (Vector128<int> Lower, Vector128<int> Upper) Widen(Vector128<short> source) => (WidenLower(source), WidenUpper(source));

        public static (Vector128<long> Lower, Vector128<long> Upper) Widen(Vector128<int> source) => (WidenLower(source), WidenUpper(source));

        public static (Vector128<short> Lower, Vector128<short> Upper) Widen(Vector128<sbyte> source) => (WidenLower(source), WidenUpper(source));

        public static (Vector128<double> Lower, Vector128<double> Upper) Widen(Vector128<float> source) => (WidenLower(source), WidenUpper(source));

        public static (Vector128<uint> Lower, Vector128<uint> Upper) Widen(Vector128<ushort> source) => (WidenLower(source), WidenUpper(source));

        public static (Vector128<ulong> Lower, Vector128<ulong> Upper) Widen(Vector128<uint> source) => (WidenLower(source), WidenUpper(source));

        public static Vector128<int> NarrowWithSaturation(Vector128<long> lower, Vector128<long> upper) => Create(
            (int)Math.Clamp(lower.GetElementUnsafe(0), int.MinValue, int.MaxValue),
            (int)Math.Clamp(lower.GetElementUnsafe(1), int.MinValue, int.MaxValue),
            (int)Math.Clamp(upper.GetElementUnsafe(0), int.MinValue, int.MaxValue),
            (int)Math.Clamp(upper.GetElementUnsafe(1), int.MinValue, int.MaxValue));

        public static Vector128<uint> NarrowWithSaturation(Vector128<ulong> lower, Vector128<ulong> upper) => Create(
            (uint)Math.Min(lower.GetElementUnsafe(0), uint.MaxValue),
            (uint)Math.Min(lower.GetElementUnsafe(1), uint.MaxValue),
            (uint)Math.Min(upper.GetElementUnsafe(0), uint.MaxValue),
            (uint)Math.Min(upper.GetElementUnsafe(1), uint.MaxValue));

        // As float.CreateSaturating converts a double: rounded, out-of-range
        // values to infinities, which is Narrow's.
        public static Vector128<float> NarrowWithSaturation(Vector128<double> lower, Vector128<double> upper) => Narrow(lower, upper);

        // The sequences.
        public static Vector128<T> CreateSequence<T>(T start, T step) => (Vector128<T>.Indices * step) + Create(start);

        public static Vector128<T> CreateAlternatingSequence<T>(T even, T odd)
        {
            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, (index & 1) == 0 ? even : odd);
            }

            return result;
        }

        public static Vector128<T> CreateGeometricSequence<T>(T initial, [ConstantExpected] T multiplier)
        {
            Vector128<T> result = default;
            T value = initial;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, value);
                value = Scalar<T>.Multiply(value, multiplier);
            }

            return result;
        }

        public static Vector128<T> CreateHarmonicSequence<T>(T start, T step)
        {
            Vector128<T> result = default;
            T one = Scalar<T>.Convert(1);
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                T denominator = Scalar<T>.Add(start, Scalar<T>.Multiply(Scalar<T>.Convert(index), step));
                result = result.WithElementUnsafe(index, Scalar<T>.Divide(one, denominator));
            }

            return result;
        }

        // Rearranging lanes.
        public static Vector128<T> ZipLower<T>(Vector128<T> left, Vector128<T> right)
        {
            Vector128<T> result = default;
            int half = Vector128<T>.Count / 2;
            for (int index = 0; index < half; index++)
            {
                result = result.WithElementUnsafe(2 * index, left.GetElementUnsafe(index))
                    .WithElementUnsafe((2 * index) + 1, right.GetElementUnsafe(index));
            }

            return result;
        }

        public static Vector128<T> ZipUpper<T>(Vector128<T> left, Vector128<T> right)
        {
            Vector128<T> result = default;
            int half = Vector128<T>.Count / 2;
            for (int index = 0; index < half; index++)
            {
                result = result.WithElementUnsafe(2 * index, left.GetElementUnsafe(half + index))
                    .WithElementUnsafe((2 * index) + 1, right.GetElementUnsafe(half + index));
            }

            return result;
        }

        public static (Vector128<T> Lower, Vector128<T> Upper) Zip<T>(Vector128<T> left, Vector128<T> right) =>
            (ZipLower(left, right), ZipUpper(left, right));

        public static Vector128<T> UnzipEven<T>(Vector128<T> left, Vector128<T> right)
        {
            Vector128<T> result = default;
            int half = Vector128<T>.Count / 2;
            for (int index = 0; index < half; index++)
            {
                result = result.WithElementUnsafe(index, left.GetElementUnsafe(2 * index))
                    .WithElementUnsafe(half + index, right.GetElementUnsafe(2 * index));
            }

            return result;
        }

        public static Vector128<T> UnzipOdd<T>(Vector128<T> left, Vector128<T> right)
        {
            Vector128<T> result = default;
            int half = Vector128<T>.Count / 2;
            for (int index = 0; index < half; index++)
            {
                result = result.WithElementUnsafe(index, left.GetElementUnsafe((2 * index) + 1))
                    .WithElementUnsafe(half + index, right.GetElementUnsafe((2 * index) + 1));
            }

            return result;
        }

        public static (Vector128<T> Even, Vector128<T> Odd) Unzip<T>(Vector128<T> left, Vector128<T> right) =>
            (UnzipEven(left, right), UnzipOdd(left, right));

        public static Vector128<T> ConcatLowerLower<T>(Vector128<T> left, Vector128<T> right) => Concat(left, 0, right, 0);

        public static Vector128<T> ConcatLowerUpper<T>(Vector128<T> left, Vector128<T> right) => Concat(left, 0, right, Vector128<T>.Count / 2);

        public static Vector128<T> ConcatUpperLower<T>(Vector128<T> left, Vector128<T> right) => Concat(left, Vector128<T>.Count / 2, right, 0);

        public static Vector128<T> ConcatUpperUpper<T>(Vector128<T> left, Vector128<T> right) =>
            Concat(left, Vector128<T>.Count / 2, right, Vector128<T>.Count / 2);

        // Half of left from lane `from`, then half of right from lane `to`.
        private static Vector128<T> Concat<T>(Vector128<T> left, int from, Vector128<T> right, int to)
        {
            Vector128<T> result = default;
            int half = Vector128<T>.Count / 2;
            for (int index = 0; index < half; index++)
            {
                result = result.WithElementUnsafe(index, left.GetElementUnsafe(from + index))
                    .WithElementUnsafe(half + index, right.GetElementUnsafe(to + index));
            }

            return result;
        }

        public static Vector128<T> Reverse<T>(Vector128<T> vector)
        {
            Vector128<T> result = default;
            int count = Vector128<T>.Count;
            for (int index = 0; index < count; index++)
            {
                result = result.WithElementUnsafe(index, vector.GetElementUnsafe(count - 1 - index));
            }

            return result;
        }

        // To and from memory: arrays and spans, and references to their
        // elements (Unsafe.Add of an element's reference is the next one).
        public static Vector128<T> Create<T>(ReadOnlySpan<T> values)
        {
            if (values.Length < Vector128<T>.Count)
            {
                ThrowHelper.ThrowArgumentOutOfRangeException(ExceptionArgument.values);
            }

            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, values[index]);
            }

            return result;
        }

        public static Vector128<T> Create<T>(T[] values)
        {
            if (values.Length < Vector128<T>.Count)
            {
                ThrowHelper.ThrowArgumentOutOfRangeException(ExceptionArgument.values);
            }

            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, values[index]);
            }

            return result;
        }

        public static Vector128<T> Create<T>(T[] values, int index)
        {
            if ((index < 0) || ((values.Length - index) < Vector128<T>.Count))
            {
                ThrowHelper.ThrowArgumentOutOfRangeException(ExceptionArgument.index);
            }

            Vector128<T> result = default;
            for (int lane = 0; lane < Vector128<T>.Count; lane++)
            {
                result = result.WithElementUnsafe(lane, values[index + lane]);
            }

            return result;
        }

        public static void CopyTo<T>(this Vector128<T> vector, T[] destination)
        {
            if (destination.Length < Vector128<T>.Count)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                destination[index] = vector.GetElementUnsafe(index);
            }
        }

        public static void CopyTo<T>(this Vector128<T> vector, T[] destination, int startIndex)
        {
            if ((uint)startIndex >= (uint)destination.Length)
            {
                ThrowHelper.ThrowStartIndexArgumentOutOfRange_ArgumentOutOfRange_IndexMustBeLess();
            }

            if ((destination.Length - startIndex) < Vector128<T>.Count)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                destination[startIndex + index] = vector.GetElementUnsafe(index);
            }
        }

        public static void CopyTo<T>(this Vector128<T> vector, Span<T> destination)
        {
            if (destination.Length < Vector128<T>.Count)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                destination[index] = vector.GetElementUnsafe(index);
            }
        }

        public static bool TryCopyTo<T>(this Vector128<T> vector, Span<T> destination)
        {
            if (destination.Length < Vector128<T>.Count)
            {
                return false;
            }

            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                destination[index] = vector.GetElementUnsafe(index);
            }

            return true;
        }

        public static Vector128<T> LoadUnsafe<T>(ref readonly T source)
        {
            Vector128<T> result = default;
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                result = result.WithElementUnsafe(index, Unsafe.Add(ref Unsafe.AsRef(in source), index));
            }

            return result;
        }

        public static void StoreUnsafe<T>(this Vector128<T> source, ref T destination)
        {
            for (int index = 0; index < Vector128<T>.Count; index++)
            {
                Unsafe.Add(ref destination, index) = source.GetElementUnsafe(index);
            }
        }

        public static Vector128<T> LoadUnsafe<T>(ref readonly T source, nuint elementOffset) =>
            LoadUnsafe(in Unsafe.Add(ref Unsafe.AsRef(in source), (int)elementOffset));

        public static void StoreUnsafe<T>(this Vector128<T> source, ref T destination, nuint elementOffset) =>
            source.StoreUnsafe(ref Unsafe.Add(ref destination, (int)elementOffset));
    }

    // The operators FunctionEmitter.Simd has no instruction for, an element
    // at a time: 8-bit multiplication and integer division.
    [Surface]
    public readonly partial struct Vector128<T>
    {
        public static Vector128<T> operator *(Vector128<T> left, Vector128<T> right) => Vector128.Multiply(left, right);

        public static Vector128<T> operator *(Vector128<T> left, T right) => Vector128.Multiply(left, right);

        public static Vector128<T> operator *(T left, Vector128<T> right) => Vector128.Multiply(left, right);

        public static Vector128<T> operator /(Vector128<T> left, Vector128<T> right) => Vector128.Divide(left, right);

        public static Vector128<T> operator /(Vector128<T> left, T right) => Vector128.Divide(left, right);
    }
}

namespace Gameplay.Runtime
{
    // A multiply-add rounded once, as FusedMultiplyAdd is defined. A
    // float's is computed in doubles, where the product of two floats is
    // exact, and the sum rounded to odd, so that rounding it to a float is
    // rounding once. A double's is the product split into a head and an exact
    // tail (Dekker and Veltkamp), added to the addend with the tail rounded to
    // odd, the scheme Boldo and Melquiond prove rounds once; operands whose
    // products or sums leave the normal range take the unfused result.
    internal sealed class FusedMultiply
    {
        public static float Add(float left, float right, float addend)
        {
            double product = (double)left * right;
            double sum = product + addend;
            if (!double.IsFinite(sum))
            {
                return (float)sum;
            }

            return (float)RoundToOdd(sum, TwoSumError(product, addend, sum));
        }

        public static double Add(double left, double right, double addend)
        {
            if (double.IsFinite(left) && double.IsFinite(right) && !double.IsFinite(addend))
            {
                // The exact product is finite: the infinity or NaN it meets.
                return addend;
            }

            double head = left * right;
            if (!double.IsFinite(head) || head == 0 || !double.IsFinite(addend)
                || Math.Abs(left) > 1e150 || Math.Abs(right) > 1e150 || Math.Abs(head) < 1e-290)
            {
                return head + addend;
            }

            double tail = ProductError(left, right, head);
            double sum = head + addend;
            double error = TwoSumError(head, addend, sum);
            double rest = tail + error;
            return sum + RoundToOdd(rest, TwoSumError(tail, error, rest));
        }

        // The rounding error of a sum computed as `sum`, exactly.
        private static double TwoSumError(double left, double right, double sum)
        {
            double right2 = sum - left;
            double left2 = sum - right2;
            return (left - left2) + (right - right2);
        }

        // The rounding error of a product, exactly (Dekker's product over
        // Veltkamp's split).
        private static double ProductError(double left, double right, double product)
        {
            const double Split = 134217729.0; // 2^27 + 1
            double a = Split * left;
            double leftHigh = a - (a - left);
            double leftLow = left - leftHigh;
            double b = Split * right;
            double rightHigh = b - (b - right);
            double rightLow = right - rightHigh;
            return ((leftHigh * rightHigh - product) + leftHigh * rightLow + leftLow * rightHigh) + leftLow * rightLow;
        }

        // A rounded value moved to the odd neighbour on the side of its
        // error, where it was inexact and even: round-to-odd.
        private static double RoundToOdd(double value, double error)
        {
            long bits = BitConverter.DoubleToInt64Bits(value);
            if (error == 0 || (bits & 1) != 0)
            {
                return value;
            }

            bool up = (error > 0) == (value > 0);
            return BitConverter.Int64BitsToDouble(up ? bits + 1 : bits - 1);
        }
    }
}
