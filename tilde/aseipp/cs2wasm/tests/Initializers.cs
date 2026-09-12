// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Initializers;

public struct Point
{
    public int X;
    public int Y;
}

public sealed class Shape
{
    public Point Origin;
    public Shape Next;
    public List<int> Values = new();
    public Dictionary<string, int> Names = new();
    public int Width { get; set; }
    public Shape Child { get; }

    public Shape()
        : this(1)
    {
        Child = new Shape(0);
    }

    private Shape(int depth)
    {
        if (depth > 0)
        {
            Next = new Shape(depth - 1);
        }
    }
}

// Nested object and collection initializers and collection expressions,
// against the CLR.
public static class Initializers
{
    private static int Digest(int[] values)
    {
        int digest = 17;
        foreach (int value in values)
        {
            digest = unchecked(digest * 31 + value);
        }

        return digest;
    }

    private static int Step(ref int trace, int value)
    {
        trace = trace * 10 + value;
        return value;
    }

    public static int Nested(int x)
    {
        var shape = new Shape
        {
            Origin = { X = x, Y = x * 2 },
            Values = { 1, x, 3 },
            Names = { ["a"] = x, ["b"] = 2 },
            Next = { Width = x + 1, Values = { x } },
            Child = { Width = 7 },
            Width = 5,
        };
        return shape.Origin.X + shape.Origin.Y * 10 + shape.Values.Count * 100 + shape.Names["a"] * 1000
               + shape.Next.Width * 10000 + shape.Next.Values[0] * 3 + shape.Child.Width * 7 + shape.Width;
    }

    public static int NullMember(int x)
    {
        var shape = new Shape();
        shape.Next.Next = null;
        var nested = new Shape { Next = { Next = { Width = x } } };
        return nested.Next.Next.Width;
    }

    public static int Arrays(int x)
    {
        int[] empty = [];
        int[] other = [];
        string[] words = ["a", x.ToString(), "c"];
        int[] numbers = [x, x + 1, .. new[] { 7, 8 }, x * 2];
        char[] letters = [.. "hey", 'z'];
        Point[] points = [new Point { X = x }, .. new Point[] { new() { Y = 2 } }];
        return empty.Length + (ReferenceEquals(empty, other) ? 1000000 : 0) + words[1].Length * 10 + Digest(numbers) % 1000 * 100
               + letters.Length + letters[3] + points[0].X * 3 + points[1].Y * 5;
    }

    public static int Lists(int x)
    {
        List<int> empty = [];
        List<int> three = [1, 2, x];
        List<int> five = [1, 2, 3, 4, x];
        List<int> spread = [.. three, .. new[] { 9, 8 }, x];
        List<int> nothing = [.. empty];
        return empty.Capacity + three.Capacity * 10 + five.Capacity * 100 + spread.Capacity * 1000
               + Digest(spread.ToArray()) % 1000 * 10000 + nothing.Capacity * 3 + nothing.Count;
    }

    public static int Sets(int x)
    {
        HashSet<int> set = [1, 2, 2, x, .. new List<int> { x, 5 }];
        return set.Count * 100 + (set.Contains(x) ? 1 : 0) + (set.Contains(5) ? 10 : 0);
    }

    public static int AddOrder(int x)
    {
        int trace = 0;
        HashSet<int> set = [Step(ref trace, 1), Step(ref trace, x), .. new[] { 3, Step(ref trace, 4) }];
        return trace * 100 + set.Count;
    }

    public static int Order(int x)
    {
        int trace = 0;
        int[] values = [Step(ref trace, 1), .. new[] { Step(ref trace, 2), Step(ref trace, 3) }, Step(ref trace, x)];
        return trace * 1000 + values.Length;
    }

    public static int SpreadFaults(int which)
    {
        int[] none = null;
        List<int> missing = null;
        return which switch
        {
            0 => ((int[])[1, .. none]).Length,
            1 => ((List<int>)[.. missing]).Count,
            3 => ((List<int>)[1, .. none]).Count,
            4 => ((int[])[1, .. missing]).Length,
            5 => ((HashSet<int>)[1, .. none]).Count,
            6 => ((List<int>)[.. missing, 2]).Count,
            7 => ((int[])[.. missing]).Length,
            8 => ((List<int>)[.. none]).Count,
            9 => ((HashSet<int>)[.. missing]).Count,
            _ => new Shape { Next = null }.Next is null ? new Shape { Next = { Next = { Width = which } } }.Width : 0,
        };
    }
}
