// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Numerics;

/// <summary>
/// Easing curves over [0, 1], written once with generic math for any IEEE
/// floating-point type (the game uses float; the tests run them on double
/// too).
/// </summary>
public static class Ease
{
    public static T Linear<T>(T t)
        where T : IFloatingPointIeee754<T> => t;

    public static T InQuad<T>(T t)
        where T : IFloatingPointIeee754<T> => t * t;

    public static T OutQuad<T>(T t)
        where T : IFloatingPointIeee754<T> => T.One - (T.One - t) * (T.One - t);

    public static T InOutQuad<T>(T t)
        where T : IFloatingPointIeee754<T>
    {
        T two = T.One + T.One;
        return t < T.One / two ? two * t * t : T.One - T.Pow(-two * t + two, two) / two;
    }

    public static T OutCubic<T>(T t)
        where T : IFloatingPointIeee754<T>
    {
        T inverse = T.One - t;
        return T.One - inverse * inverse * inverse;
    }

    /// <summary>Overshoots a little and settles back.</summary>
    public static T OutBack<T>(T t)
        where T : IFloatingPointIeee754<T>
    {
        T c1 = T.CreateTruncating(1.70158);
        T c3 = c1 + T.One;
        T shifted = t - T.One;
        return T.One + c3 * shifted * shifted * shifted + c1 * shifted * shifted;
    }

    /// <summary>A spring: overshoots and rings out.</summary>
    public static T OutElastic<T>(T t)
        where T : IFloatingPointIeee754<T>
    {
        if (t <= T.Zero || t >= T.One)
        {
            return T.Clamp(t, T.Zero, T.One);
        }

        T ten = T.CreateTruncating(10);
        T period = T.Tau / T.CreateTruncating(3);
        return T.Pow(T.CreateTruncating(2), -ten * t) * T.Sin((t * ten - T.CreateTruncating(0.75)) * period) + T.One;
    }

    public static T OutBounce<T>(T t)
        where T : IFloatingPointIeee754<T>
    {
        T n = T.CreateTruncating(7.5625);
        T d = T.CreateTruncating(2.75);
        if (t < T.One / d)
        {
            return n * t * t;
        }

        if (t < T.CreateTruncating(2) / d)
        {
            t -= T.CreateTruncating(1.5) / d;
            return n * t * t + T.CreateTruncating(0.75);
        }

        if (t < T.CreateTruncating(2.5) / d)
        {
            t -= T.CreateTruncating(2.25) / d;
            return n * t * t + T.CreateTruncating(0.9375);
        }

        t -= T.CreateTruncating(2.625) / d;
        return n * t * t + T.CreateTruncating(0.984375);
    }

    public static T SmoothStep<T>(T t)
        where T : IFloatingPointIeee754<T> =>
        t * t * (T.CreateTruncating(3) - T.CreateTruncating(2) * t);
}

/// <summary>Interpolation, for any number type.</summary>
public static class Interpolate
{
    /// <summary>From <paramref name="from"/> towards <paramref name="to"/> by <paramref name="t"/> in [0, 1], in <typeparamref name="T"/>'s own arithmetic.</summary>
    public static T Lerp<T>(T from, T to, float t)
        where T : INumber<T> =>
        from + T.CreateTruncating(float.CreateTruncating(to - from) * t);

    /// <summary>Moves towards a target by at most a step, never past it.</summary>
    public static T Approach<T>(T value, T target, T step)
        where T : INumber<T> =>
        value < target ? T.Min(value + step, target) : T.Max(value - step, target);

    /// <summary>Where <paramref name="value"/> falls between two others, 0 to 1.</summary>
    public static float Inverse<T>(T from, T to, T value)
        where T : INumber<T> =>
        to == from ? 0 : Math.Clamp(float.CreateTruncating(value - from) / float.CreateTruncating(to - from), 0f, 1f);

    /// <summary>Exponential smoothing towards a target, independent of the step count.</summary>
    public static float Damp(float value, float target, float sharpness, float step) =>
        target + (value - target) * MathF.Exp(-sharpness * step);

    public static Vector2 Damp(Vector2 value, Vector2 target, float sharpness, float step) =>
        target + (value - target) * MathF.Exp(-sharpness * step);
}

/// <summary>
/// A value animated over a number of ticks along an easing curve: a
/// float's scale, an int's score counting up.
/// </summary>
public sealed class Tween<T>
    where T : INumber<T>
{
    private readonly Func<float, float> ease;
    private int elapsed;

    public Tween(T from, T to, int ticks, Func<float, float> ease = null)
    {
        From = from;
        To = to;
        Ticks = Math.Max(1, ticks);
        this.ease = ease ?? Ease.Linear;
    }

    public T From { get; private set; }

    public T To { get; private set; }

    public int Ticks { get; private set; }

    public bool Done => elapsed >= Ticks;

    public float Progress => Math.Min(1f, elapsed / (float)Ticks);

    public T Value => Done ? To : Interpolate.Lerp(From, To, ease(Progress));

    public T Step()
    {
        if (elapsed < Ticks)
        {
            elapsed++;
        }

        return Value;
    }

    /// <summary>Starts again from where it is now towards a new target.</summary>
    public void Retarget(T to, int ticks)
    {
        From = Value;
        To = to;
        Ticks = Math.Max(1, ticks);
        elapsed = 0;
    }
}
