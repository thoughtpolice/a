// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.References;

public enum Level : short
{
    Low = 1,
    High = 9,
}

public struct Vector
{
    public int X;
    public int Y;

    public void Scale(int factor)
    {
        X *= factor;
        Y *= factor;
    }
}

public class Counter
{
    public int Count;
    public long Total;
    public double Ratio;
    public bool Flag;
    public string Name = "c";
    public Vector Position;
    public static int Shared;

    private readonly int[] slots = new int[4];

    public ref int Slot(int index) => ref slots[index];

    public ref int this[int index] => ref slots[index];

    public virtual ref int Pick(bool first) => ref first ? ref Count : ref Shared;

    public int Sum() => slots[0] + slots[1] * 10 + slots[2] * 100 + slots[3] * 1000;
}

public sealed class Doubler : Counter
{
    public override ref int Pick(bool first) => ref first ? ref Shared : ref Count;
}

// Managed references to array elements, fields, statics and variables:
// ref arguments, ref locals and ref returns, against the CLR.
public static class References
{
    private static void Swap<T>(ref T left, ref T right)
    {
        T swap = left;
        left = right;
        right = swap;
    }

    private static int Aliased(ref int left, ref int right)
    {
        left = 1;
        right = 2;
        return left * 10 + right;
    }

    private static void Bump(ref int value, int by) => value += by;

    private static void Set<T>(out T target, T value) => target = value;

    private static ref int Larger(ref int left, ref int right) => ref left >= right ? ref left : ref right;

    private static int[] storage = new int[3];

    private static ref int Stored(int index) => ref storage[index];

    public static int Elements(int x)
    {
        int[] numbers = [x, 2, 3, 4];
        Swap(ref numbers[0], ref numbers[3]);
        Swap(ref numbers[1], ref numbers[1]);
        Bump(ref numbers[2], x);
        string[] words = ["a", "bb", "ccc"];
        Swap(ref words[0], ref words[2]);
        Level[] levels = [Level.Low, Level.High];
        Swap(ref levels[0], ref levels[1]);
        Vector[] vectors = [new Vector { X = x, Y = 1 }, new Vector { X = 2, Y = 3 }];
        Swap(ref vectors[0], ref vectors[1]);
        return numbers[0] + numbers[1] * 10 + numbers[2] * 100 + numbers[3] * 1000 + words[0].Length * 10000
               + (int)levels[0] * 100000 + vectors[1].X * 1000000 + Aliased(ref numbers[0], ref numbers[0]) * 10000000;
    }

    public static long Fields(int x)
    {
        var counter = new Counter();
        Bump(ref counter.Count, x);
        Set(out counter.Total, 1L << 40);
        Set(out counter.Ratio, 2.5);
        Set(out counter.Flag, x > 0);
        Set(out counter.Name, "named");
        Bump(ref counter.Position.X, 7);
        Bump(ref Counter.Shared, x * 3);
        Swap(ref counter.Count, ref Counter.Shared);
        return counter.Count + counter.Total + (long)(counter.Ratio * 10) * 100 + (counter.Flag ? 1000 : 0)
               + counter.Name.Length * 10000 + counter.Position.X * 100000L + Counter.Shared * 10000000L;
    }

    public static int Locals(int x)
    {
        int[] numbers = [1, 2, 3];
        ref int first = ref numbers[0];
        first = x;
        first++;
        first += 10;
        ref int last = ref numbers[2];
        int local = 5;
        ref int alias = ref local;
        alias *= x;
        ref int chosen = ref Larger(ref numbers[1], ref local);
        chosen = 100;
        alias = ref last;
        alias = 42;
        var vector = new Vector { X = x, Y = 2 };
        ref Vector place = ref vector;
        place.Scale(3);
        ref int component = ref vector.Y;
        component = 11;
        Vector[] vectors = [new Vector { X = 1, Y = 1 }];
        ref Vector element = ref vectors[0];
        element.X = 9;
        element.Scale(2);
        return numbers[0] + numbers[1] * 1000 + numbers[2] * 100000 + local * 7 + vector.X * 13 + vector.Y * 17
               + vectors[0].X * 19 + vectors[0].Y * 23;
    }

    public static int Returns(int x)
    {
        var counter = new Counter();
        counter.Slot(0) = x;
        counter.Slot(1)++;
        counter.Slot(2) += 5;
        counter[3] = 7;
        counter[3] *= 2;
        ref int slot = ref counter.Slot(1);
        slot = 8;
        Bump(ref counter[0], 1);
        Stored(1) = x;
        int value = counter.Slot(0) + Stored(1);
        Counter picker = x > 0 ? new Doubler() : new Counter();
        picker.Pick(true) = 21;
        picker.Pick(false) += 4;
        return counter.Sum() + value * 100000 + picker.Count * 1000000 + Counter.Shared;
    }

    private sealed class Frozen
    {
        public readonly int Value;
        public readonly Vector Where;

        public Frozen(int value)
        {
            Value = value;
            Where = new Vector { X = value, Y = -value };
        }

        public ref readonly int Peek() => ref Value;
    }

    public static int ReadOnly(int x)
    {
        var frozen = new Frozen(x);
        ref readonly int value = ref frozen.Value;
        ref readonly Vector where = ref frozen.Where;
        ref readonly int peeked = ref frozen.Peek();
        return value * 100 + where.Y * 10 + peeked + frozen.Peek();
    }

    public static int Captured(int x)
    {
        int value = x;
        Func<int> read = () => value;
        ref int alias = ref value;
        alias += 10;
        Bump(ref value, 1);
        return read();
    }

    public static int Faults(int which)
    {
        int[] numbers = new int[2];
        Counter nothing = null;
        switch (which)
        {
            case 0:
                Bump(ref numbers[5], 1);
                return 0;
            case 1:
                Bump(ref nothing.Count, 1);
                return 1;
            case 2:
                ref int missing = ref numbers[which - 3];
                return missing;
            default:
                return new Counter().Slot(9);
        }
    }

    public static int Parsed(int which)
    {
        int[] results = new int[2];
        bool parsed = int.TryParse(which == 0 ? "123" : "x", out results[1]);
        return results[1] * 10 + (parsed ? 1 : 0);
    }
}
