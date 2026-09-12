// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.Transcendentals;

// System.Math and MathF against the CLR's, whose results come from the
// platform's libm: tests/differential.mjs allows an ulp where neither is
// guaranteed to round correctly, and nothing where both are exact.
public static class Transcendentals
{
    public static double Sin(double x) => Math.Sin(x);

    public static double Cos(double x) => Math.Cos(x);

    public static double Tan(double x) => Math.Tan(x);

    public static double Asin(double x) => Math.Asin(x);

    public static double Acos(double x) => Math.Acos(x);

    public static double Atan(double x) => Math.Atan(x);

    public static double Atan2(double y, double x) => Math.Atan2(y, x);

    public static double Sinh(double x) => Math.Sinh(x);

    public static double Cosh(double x) => Math.Cosh(x);

    public static double Tanh(double x) => Math.Tanh(x);

    public static double Exp(double x) => Math.Exp(x);

    public static double Log(double x) => Math.Log(x);

    public static double LogBase(double x, double b) => Math.Log(x, b);

    public static double Log10(double x) => Math.Log10(x);

    public static double Log2(double x) => Math.Log2(x);

    public static double Pow(double x, double y) => Math.Pow(x, y);

    public static double Cbrt(double x) => Math.Cbrt(x);

    public static float SinF(float x) => MathF.Sin(x);

    public static float CosF(float x) => MathF.Cos(x);

    public static float Atan2F(float y, float x) => MathF.Atan2(y, x);

    public static float ExpF(float x) => MathF.Exp(x);

    public static float LogF(float x) => MathF.Log(x);

    public static float PowF(float x, float y) => MathF.Pow(x, y);

    // Exact everywhere.
    public static double Remainder(double x, double y) => x % y;

    public static float RemainderF(float x, float y) => x % y;

    public static double CompoundRemainder(double x, double y)
    {
        x %= y;
        return x;
    }

    public static double Round(double x, int digits, int mode) => Math.Round(x, digits, (MidpointRounding)mode);

    public static float RoundF(float x, int digits, int mode) => MathF.Round(x, digits, (MidpointRounding)mode);

    public static int Sign(double x) => Math.Sign(x);

    public static double ScaleB(double x, int n) => Math.ScaleB(x, n);

    // Exact identities a correctly rounded implementation keeps.
    public static int Identities(int k)
    {
        int bits = 0;
        bits |= (Math.Pow(2, k % 60) == (double)(1L << (k % 60)) ? 1 : 0);
        bits |= (Math.Log10(1000) == 3 ? 2 : 0);
        bits |= (Math.Log2(1024) == 10 ? 4 : 0);
        bits |= (Math.Atan2(0, -1) == Math.PI ? 8 : 0);
        bits |= (Math.Exp(0) == 1 ? 16 : 0);
        bits |= (Math.Pow(-2, 3) == -8 ? 32 : 0);
        bits |= (Math.Pow(10, k % 20) == Pow10(k % 20) ? 64 : 0);
        bits |= (Math.Sqrt(Math.Pow(k, 2)) == Math.Abs(k) ? 128 : 0);
        return bits;
    }

    // nameof over method groups is a constant, whatever it names.
    public static int NameOf() => nameof(Math.Sin).Length * 100 + nameof(Identities).Length;

    private static double Pow10(int n)
    {
        double result = 1;
        for (int i = 0; i < n; i++)
        {
            result *= 10;
        }

        return result;
    }
}
