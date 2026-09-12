// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Numerics;
using System.Runtime.Intrinsics;

namespace Tests.SimdPlatform;

// What .NET leaves to the platform about vectors, as it is here
// (docs/IMPORTER.md, "SIMD as built"; tests/simd.mjs): which vectors are
// accelerated, MinNative and MaxNative of NaN and of zeros of both signs
// (x64's minps and maxps), a native conversion of NaN, MultiplyAddEstimate
// (rounded twice, no fused instruction) against FusedMultiplyAdd (rounded
// once), and a reference to a variable moved by Unsafe.Add.
public static class Platform
{
    public static int Acceleration() =>
        (Vector128.IsHardwareAccelerated ? 1 : 0)
        + (Vector64.IsHardwareAccelerated ? 2 : 0)
        + (Vector256.IsHardwareAccelerated ? 4 : 0)
        + (Vector512.IsHardwareAccelerated ? 8 : 0)
        + (Vector.IsHardwareAccelerated ? 16 : 0)
        + (Vector128<float>.IsSupported ? 32 : 0)
        + (Vector128<ulong>.IsSupported ? 64 : 0);

    public static float MinNative(float left, float right) => Vector128.MinNative(Vector128.Create(left), Vector128.Create(right)).ToScalar();

    public static float MaxNative(float left, float right) => Vector128.MaxNative(Vector128.Create(left), Vector128.Create(right)).ToScalar();

    public static double MinNativeDouble(double left, double right) =>
        Vector128.MinNative(Vector128.Create(left), Vector128.Create(right)).ToScalar();

    public static int ConvertNative(float value) => Vector128.ConvertToInt32Native(Vector128.Create(value)).ToScalar();

    public static float Estimate(float left, float right, float addend) =>
        Vector128.MultiplyAddEstimate(Vector128.Create(left), Vector128.Create(right), Vector128.Create(addend)).ToScalar();

    public static float Fused(float left, float right, float addend) =>
        Vector128.FusedMultiplyAdd(Vector128.Create(left), Vector128.Create(right), Vector128.Create(addend)).ToScalar();

    public static double FusedDouble(double left, double right, double addend) =>
        Vector128.FusedMultiplyAdd(Vector128.Create(left), Vector128.Create(right), Vector128.Create(addend)).ToScalar();

    public static float ScalarFused(float left, float right, float addend) => MathF.FusedMultiplyAdd(left, right, addend);

    public static float Lerp(float from, float to, float amount) => Vector2.Lerp(new Vector2(from), new Vector2(to), amount).X;

    // A local's reference moved by one has no neighbour here.
    public static int MovedLocal(int offset)
    {
        int value = 7;
        return System.Runtime.CompilerServices.Unsafe.Add(ref value, offset);
    }
}
