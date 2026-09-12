// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Tuples;

public sealed class Holder
{
    public (int, int) Pair;

    public (string Name, double Weight) Entry = ("none", 0.5);
}

public struct Cell
{
    public (short, bool) Parts;
}

public sealed class Tracer
{
    public int Log;

    public int Field;

    public Tracer Note(int step)
    {
        Log = Log * 10 + step;
        return this;
    }
}

public static class Tuples
{
    private static int Digest(string text)
    {
        if (text == null)
        {
            return -1;
        }

        int digest = text.Length;
        for (int index = 0; index < text.Length; index++)
        {
            digest = unchecked(digest * 31 + text[index]);
        }

        return digest;
    }

    private static (int, int) Pair(int a) => (a, a * 2);

    private static (int Low, long High) Split(long value) => ((int)(value & 0xFFFF), value >> 16);

    public static int Deconstruct(int a)
    {
        var (p, q) = Pair(a);
        return p * 100 + q;
    }

    public static long Named(long value)
    {
        var parts = Split(value);
        return parts.Low + parts.High * 3 + parts.Item1;
    }

    public static int Equal(int a, int b) => (a, 2) == (b, 2) ? 1 : 0;

    public static int NotEqual(int a, long b) => (a, 2) != (b, 2.0) ? 1 : 0;

    // == on doubles: NaN is unequal to itself, -0 equal to 0.
    public static int FloatEqual(double a, double b) => (a, 1) == (b, 1) ? 1 : 0;

    // Equals is EqualityComparer's: NaN equals itself.
    public static int FloatEquals(double a, double b) => (a, 1).Equals((b, 1)) ? 1 : 0;

    public static int Swap(int a, int b)
    {
        (a, b) = (b, a);
        return a * 10 + b;
    }

    public static int Rotate(int a, int b, int c)
    {
        (a, b, c) = (b, c, a);
        return a * 100 + b * 10 + c;
    }

    public static int Text(int a, int b) => Digest($"{(a, b)}") * 7 + Digest(Pair(a).ToString());

    public static int MixedText(int a) => Digest((a, "x", a / 4.0, (char)('a' + a % 26), a % 2 == 0).ToString());

    public static int NullText(int a) => Digest((a > 0 ? "set" : null, a).ToString());

    public static int NestedText(int a) => Digest(((a, a + 1), (a + 2, (a + 3, "deep"))).ToString());

    public static int Keyed(int a)
    {
        var counts = new Dictionary<(int, int), int>();
        counts[(1, 2)] = 5;
        counts[(a, 2)] = 7;
        counts[(2, a)] = 9;
        return counts[(1, 2)] * 100 + counts.Count * 10 + (counts.ContainsKey((2, 1)) ? 1 : 0);
    }

    public static int Boxed(int a)
    {
        object value = Pair(a);
        return (value is ValueTuple<int, int> pair ? pair.Item2 : -1) * 10 + (value.Equals(Pair(a)) ? 1 : 0);
    }

    public static int BoxedText(int a)
    {
        object value = (a, "x");
        return Digest(value.ToString());
    }

    public static int Listed(int count)
    {
        count %= 100;
        var list = new List<(int Index, string Name)>();
        for (int index = 0; index < count; index++)
        {
            list.Add((index, index % 3 == 0 ? "" : index % 3 == 1 ? "s" : "ss"));
        }

        int sum = 0;
        foreach (var (index, name) in list)
        {
            sum = sum * 3 + index + name.Length;
        }

        foreach (var entry in list)
        {
            sum += entry.Index * entry.Name.Length;
        }

        return sum;
    }

    public static int ArrayLoop(int count)
    {
        count %= 100;
        count = count < 0 ? -count : count;
        var pairs = new (int, long)[count];
        for (int index = 0; index < count; index++)
        {
            pairs[index] = (index, index * 1000L);
        }

        long sum = 0;
        foreach ((int small, long large) in pairs)
        {
            sum += small + large;
        }

        return (int)sum;
    }

    public static double Mixed(int a)
    {
        (double D, int I) value = (a, a);
        value.D += 0.5;
        value.I *= 3;
        return value.D + value.I;
    }

    public static int Nested(int a)
    {
        var value = (a, (a + 1, a + 2));
        var (x, (y, z)) = value;
        return x + y * 10 + z * 100 + (value == (a, (a + 1, a + 2)) ? 1000 : 0);
    }

    public static int Fields(int a)
    {
        var holder = new Holder();
        holder.Pair = (a, a);
        holder.Pair.Item1++;
        holder.Entry.Weight *= a;
        var cell = new Cell { Parts = ((short)a, true) };
        cell.Parts.Item1 += 2;
        return holder.Pair.Item1 + holder.Pair.Item2 + (int)(holder.Entry.Weight * 10) + cell.Parts.Item1 * 1000
            + (cell.Parts.Item2 ? 1 : 0) + Digest(holder.Entry.Name);
    }

    public static int NullCompare(int a)
    {
        string text = a > 0 ? "x" : null;
        return ((text, 1) == (null, 1) ? 1 : 0) + ((text, 1) != ("x", 1) ? 10 : 0);
    }

    // The targets' receivers are evaluated before the value, then assigned
    // left to right.
    public static int Order(int a)
    {
        var tracer = new Tracer();
        var array = new int[3];
        (tracer.Note(1).Field, array[tracer.Note(2).Log % 3]) = (tracer.Note(3).Log, tracer.Note(4).Log + a);
        return tracer.Log * 1000 + tracer.Field * 10 + array[0] + array[1] + array[2];
    }

    public static int Hashes(int a, int b) =>
        (Pair(a).GetHashCode() == Pair(b).GetHashCode() ? 1 : 0) + ((a, "s").GetHashCode() == (b, "s").GetHashCode() ? 2 : 0);

    public static int Converted(int a)
    {
        (long, double) wide = (a, a);
        (long, double) fromValue = Pair(a);
        return (int)(wide.Item1 + wide.Item2 + fromValue.Item1 * 10 + fromValue.Item2 * 100);
    }

    public static int Generic(int a) => Swap<string, int>(("x", a)).Item1 + First((a, 1.5)) * 2;

    private static (U, T) Swap<T, U>((T, U) pair) => (pair.Item2, pair.Item1);

    private static int First<T>((int, T) pair) => pair.Item1;

    public static int Seven(int a)
    {
        var value = (a, a + 1, a + 2, a + 3, a + 4, a + 5, a + 6);
        var (b, c, d, e, f, g, h) = value;
        return b + c + d + e + f + g + h + value.Item7 * 100 + Digest(value.ToString());
    }

    public static int Capture(int a)
    {
        var value = (a, a * 2);
        Func<int> read = () => value.Item1 + value.Item2;
        value.Item1 = 10;
        return read();
    }
}
