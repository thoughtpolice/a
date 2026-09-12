// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Collections.Generic;
using System.Numerics;

/// <summary>
/// A seeded random number generator (PCG32: a 64-bit linear congruential
/// state, output by a permuted shift), so a seed makes the same world on
/// every engine.
/// </summary>
public sealed class Rng
{
    private const ulong Multiplier = 6364136223846793005UL;
    private const ulong Increment = 1442695040888963407UL;

    private ulong state;

    public Rng(ulong seed)
    {
        state = seed + Increment;
        Next();
    }

    /// <summary>A generator of its own, seeded from this one: a stream for one purpose.</summary>
    public Rng Fork() => new Rng(((ulong)Next() << 32) | Next());

    public uint Next()
    {
        ulong old = state;
        state = old * Multiplier + Increment;
        uint shifted = (uint)(((old >> 18) ^ old) >> 27);
        int rotation = (int)(old >> 59);
        return (shifted >> rotation) | (shifted << (-rotation & 31));
    }

    /// <summary>An integer from <paramref name="min"/> up to but not including <paramref name="max"/>.</summary>
    public int Range(int min, int max) => max <= min ? min : min + (int)(Next() % (uint)(max - min));

    /// <summary>A float in [0, 1).</summary>
    public float Float() => (Next() >> 8) * (1f / 16777216f);

    public float Range(float min, float max) => min + (max - min) * Float();

    public bool Chance(float probability) => Float() < probability;

    /// <summary>-1 or 1.</summary>
    public int Sign() => (Next() & 1) == 0 ? -1 : 1;

    public T Pick<T>(IReadOnlyList<T> items) => items[Range(0, items.Count)];

    /// <summary>An index chosen with the given weights.</summary>
    public int Weighted(IReadOnlyList<int> weights)
    {
        int total = 0;
        foreach (int weight in weights)
        {
            total += weight;
        }

        int roll = Range(0, total);
        for (int index = 0; index < weights.Count; index++)
        {
            roll -= weights[index];
            if (roll < 0)
            {
                return index;
            }
        }

        return weights.Count - 1;
    }

    public void Shuffle<T>(IList<T> items)
    {
        for (int index = items.Count - 1; index > 0; index--)
        {
            int other = Range(0, index + 1);
            (items[index], items[other]) = (items[other], items[index]);
        }
    }

    /// <summary>A unit vector in a uniformly random direction.</summary>
    public Vector2 Direction()
    {
        float angle = Float() * MathF.Tau;
        return new Vector2(MathF.Cos(angle), MathF.Sin(angle));
    }
}
