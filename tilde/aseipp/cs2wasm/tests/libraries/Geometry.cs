// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A gameplay library (gameplayc --library Geometry), which tests/libraries/
// Shapes.cs and tests/Libraries.cs build on: its types are theirs as if
// their sources declared them (docs/IMPORTER.md, "Libraries"). On the CLR
// the three are one assembly.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;

[assembly: InternalsVisibleTo("Gameplay")]

namespace Tests.Geometry;

public interface IArea
{
    int Area();

    string Describe() => GetType().Name + ":" + Area();
}

public delegate int Mapper(int value);

public abstract class Figure : IArea, IComparable<Figure>
{
    public static int Compared;

    public abstract int Area();

    public virtual int Scale(int factor) => Area() * factor;

    public virtual T Pick<T>(T first, T second) => first;

    public int CompareTo(Figure other)
    {
        Compared++;
        return other is null ? 1 : Area().CompareTo(other.Area());
    }

    public override string ToString() => GetType().Name + "(" + Area() + ")";

    public override bool Equals(object obj) => obj is Figure other && other.GetType() == GetType() && other.Area() == Area();

    public override int GetHashCode() => Area();
}

public readonly record struct Point(int X, int Y)
{
    public Point Offset(int by) => new Point(X + by, Y - by);
}

public static class Counter<T>
{
    public static int Made;

    static Counter()
    {
        Made = 100;
    }

    public static int Next() => ++Made;
}

public sealed class Grid<T> : IEnumerable<T>
{
    private readonly T[] cells;

    public Grid(int width, int height)
    {
        Width = width;
        cells = new T[width * height];
    }

    public int Width { get; }

    public int Count => cells.Length;

    public T this[int x, int y]
    {
        get => cells[y * Width + x];
        set => cells[y * Width + x] = value;
    }

    public IEnumerator<T> GetEnumerator()
    {
        foreach (var cell in cells)
        {
            yield return cell;
        }
    }

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

public sealed class Signal
{
    public event Action<int> Changed;

    public int Value { get; private set; }

    public void Set(int value)
    {
        Value = value;
        Changed?.Invoke(value);
    }
}

public sealed class GeometryException : Exception
{
    public GeometryException(string message, int code)
        : base(message)
    {
        Code = code;
    }

    public int Code { get; }
}

public static class Algorithms
{
    public static T Largest<T>(IEnumerable<T> items)
        where T : IArea
    {
        T best = default;
        bool any = false;
        foreach (var item in items)
        {
            if (!any || item.Area() > best.Area())
            {
                best = item;
                any = true;
            }
        }

        return any ? best : throw new GeometryException("empty", 3);
    }

    public static IEnumerable<int> Evens(int count)
    {
        for (int index = 0; index < count; index++)
        {
            yield return index * 2;
        }
    }

    public static Func<int, int> Adder(int amount)
    {
        int calls = 0;
        return value => value + amount + calls++;
    }

    public static Mapper Twice(Mapper mapper) => value => mapper(mapper(value));

    // What a filter here lets through, with its code, or -1.
    public static int Guard(Func<int> body)
    {
        try
        {
            return body();
        }
        catch (GeometryException error) when (error.Code > 1)
        {
            return -error.Code;
        }
    }

    public static int Fail(int code) => throw new GeometryException("failed " + code, code);

    public static async Task<int> Later(int value)
    {
        int first = await Task.FromResult(value);
        return first + await Task.FromResult(1);
    }
}

internal static class Secrets
{
    internal static int Key => 7;
}
