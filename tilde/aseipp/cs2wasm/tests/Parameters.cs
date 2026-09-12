// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.Parameters;

public enum Speed
{
    Slow = 1,
    Fast = 4,
}

public struct Counter
{
    public int Count;

    public void Bump() => Count++;

    public readonly int Peek() => Count;
}

public delegate int Scaler(int value, int factor = 3);

public class Shape
{
    public virtual int Area(int scale = 2) => scale * 10;
}

public sealed class Square : Shape
{
    public override int Area(int scale = 5) => scale * 100;
}

public interface IGreeter
{
    int Greet(int times = 7);
}

public sealed class Greeter : IGreeter
{
    public int Greet(int times = 9) => times;
}

public sealed class Spawner
{
    public readonly int Total;

    public Spawner(int first = 10, params int[] rest)
    {
        Total = first;
        foreach (int value in rest)
        {
            Total = Total * 10 + value;
        }
    }
}

public static class Extensions
{
    public static int SumWith(this int start, params int[] values)
    {
        foreach (int value in values)
        {
            start += value;
        }

        return start;
    }
}

public static class Parameters
{
    private static int Sum(params int[] values)
    {
        if (values == null)
        {
            return -1;
        }

        int total = values.Length * 1000;
        foreach (int value in values)
        {
            total += value;
        }

        return total;
    }

    private static int Join(string separator, params string[] parts)
    {
        int digest = parts.Length;
        foreach (var part in parts)
        {
            digest = digest * 31 + (part == null ? 7 : part.Length) + separator.Length;
        }

        return digest;
    }

    private static int Defaults(
        int a,
        long b = 5,
        double c = 1.5,
        bool d = true,
        char e = 'z',
        string f = "text",
        string g = null,
        Speed h = Speed.Fast,
        Counter i = default,
        float j = -0.25f) =>
        (int)(a + b * 10 + c * 100) + (d ? 1000 : 0) + e * 10000 + f.Length * 100000 + (g == null ? 3 : 4)
        + (int)h * 7 + i.Count * 11 + (int)(j * 1000);

    private static int Order(ref int log, int step)
    {
        log = log * 10 + step;
        return step;
    }

    private static int Named(int first, int second = 2, int third = 3) => first * 100 + second * 10 + third;

    private static int Reads(in Counter counter)
    {
        // A mutating call on an `in` parameter runs on a copy.
        counter.Bump();
        return counter.Count * 10 + counter.Peek();
    }

    private static int ReadsReadonly(ref readonly int value) => value * 2;

    public static int ParamsCounts(int a) =>
        Sum() + Sum(a) * 3 + Sum(a, a + 1, a + 2) * 7 + Sum(new[] { a, a }) * 11 + Sum(null) * 13;

    public static int ParamsStrings(int a) => Join(",") + Join("--", "a", null, a > 0 ? "bb" : "ccc") * 3;

    public static int AllDefaults(int a) => Defaults(a);

    public static int SomeDefaults(int a) =>
        Defaults(a, 1, 0.5) + Defaults(a, d: false, h: Speed.Slow) * 3 + Defaults(a, e: 'a', f: "", g: "x") * 7;

    public static int NamedOrder(int a)
    {
        int log = 0;
        int result = Named(third: Order(ref log, 3), first: Order(ref log, a));
        return result * 1000 + log;
    }

    public static int InParameters(int a)
    {
        var counter = new Counter { Count = a };
        int value = a * 3;
        return Reads(counter) * 10000 + Reads(in counter) * 100 + counter.Count + ReadsReadonly(in value) * 1000000;
    }

    public static int Delegates(int a)
    {
        Scaler scale = (value, factor) => value * factor;
        return scale(a) * 100 + scale(a, 5);
    }

    public static int Virtuals(int a)
    {
        Shape shape = new Square();
        var square = new Square();
        IGreeter greeter = new Greeter();
        return shape.Area() * 1000 + square.Area() + greeter.Greet() * 100000 + new Greeter().Greet() * 10000000
            + a;
    }

    public static int Constructors(int a) =>
        new Spawner().Total * 10000 + new Spawner(a).Total * 100 + new Spawner(1, 2, 3).Total;

    public static int ExtensionParams(int a) => a.SumWith() + a.SumWith(1, 2, 3) * 100;

    public static int LocalFunctions(int a)
    {
        int Add(int x, int y = 4, params int[] more) => x + y + more.Length;
        static int Twice(int x = 21) => x * 2;
        return Add(a) + Add(a, 1) * 10 + Add(a, 1, 9, 9) * 100 + Twice() * 1000 + Twice(a) * 100000;
    }
}
