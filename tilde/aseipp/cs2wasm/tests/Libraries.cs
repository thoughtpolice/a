// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A module over two gameplay libraries (tests/libraries/): compiled with
// `--reference` to them, their IL is the module's own. The module derives
// from their classes, implements their interfaces, instantiates their
// generics with its own types, and reaches Geometry's internals, which
// Geometry makes visible to gameplay modules.

using System.Collections.Generic;
using System.Linq;
using Tests.Geometry;
using Tests.Shapes;

namespace Tests.Libraries;

public sealed class Circle : Figure
{
    public Circle(int radius)
    {
        Radius = radius;
    }

    public int Radius { get; }

    public override int Area() => 3 * Radius * Radius;

    public override T Pick<T>(T first, T second) => Radius % 2 == 0 ? first : second;
}

public struct Tile : IArea
{
    public int Side;

    public int Area() => Side * Side;
}

public static class Libraries
{
    private static int Text(string text)
    {
        int hash = text.Length;
        foreach (char character in text)
        {
            hash = hash * 31 + character;
        }

        return hash;
    }

    private static List<Figure> Figures(int n) => [.. Catalog.Standard(n), new Circle(n % 5)];

    public static int Areas(int n)
    {
        int total = 0;
        foreach (var figure in Figures(n))
        {
            total = total * 7 + figure.Area() + figure.Scale(3) + ((IArea)figure).Area();
        }

        return total;
    }

    public static int Descriptions(int n)
    {
        int hash = 0;
        foreach (var figure in Figures(n))
        {
            hash = hash * 17 + Text(((IArea)figure).Describe()) + Text(figure.ToString());
        }

        IArea tile = new Tile { Side = n };
        return hash + Text(tile.Describe());
    }

    public static int Sorting(int n)
    {
        Figure.Compared = 0;
        var figures = Figures(n);
        figures.AddRange(Catalog.Standard(n % 3 + 1));
        figures.Sort();
        int order = 0;
        foreach (var figure in figures)
        {
            order = order * 5 + figure.Area();
        }

        return order + (Figure.Compared > 0 ? 1 : 0) + figures.Max().Area() + figures.OrderBy(figure => -figure.Area()).First().Area();
    }

    public static int Equality(int n)
    {
        var set = new HashSet<Figure>(Figures(n));
        set.UnionWith(Catalog.Standard(n));
        var points = new Dictionary<Point, int>();
        for (int index = 0; index < n % 20; index++)
        {
            var point = new Point(index % 3, index % 4).Offset(1);
            points[point] = points.TryGetValue(point, out int seen) ? seen + 1 : 1;
        }

        return set.Count * 1000 + points.Count * 10 + (new Point(1, 2) == new Point(1, 2) ? 1 : 0) + Text(new Point(n, 1).ToString());
    }

    public static int Generics(int n)
    {
        var tiles = new[] { new Tile { Side = 2 }, new Tile { Side = n % 7 }, new Tile { Side = 3 } };
        int largest = Algorithms.Largest(tiles).Side * 100 + Algorithms.Largest(Figures(n)).Area();
        int statics = Counter<Circle>.Next() + Counter<Circle>.Next() * 2 + Counter<Tile>.Next() * 3 + Counter<int>.Made;
        var grid = new Grid<Point>(3, 2);
        grid[1, 1] = new Point(n, n + 1);
        grid[2, 0] = new Point(-1, 5);
        var names = new Grid<string>(2, 2);
        names[0, 1] = "x" + n;
        return largest + statics + grid.Sum(point => point.X + point.Y) * 10 + names.Count(name => name is not null) + grid.Width;
    }

    public static int GenericVirtuals(int n)
    {
        int total = 0;
        foreach (var figure in Figures(n))
        {
            total = total * 3 + figure.Pick(n, -n) + figure.Pick("ab", "cde").Length;
        }

        return total;
    }

    public static int Reimplemented(int n)
    {
        var labelled = new Labelled(n % 9, 4);
        Rect asRect = labelled;
        IArea asArea = labelled;
        return labelled.Area() * 10000 + asRect.Area() * 100 + asArea.Area();
    }

    public static int Delegates(int n)
    {
        var adder = Algorithms.Adder(n);
        Mapper doubled = value => value * 2;
        var twice = Algorithms.Twice(doubled);
        var signal = new Signal();
        int heard = 0;
        signal.Changed += value => heard += value;
        signal.Changed += value => heard *= 2;
        signal.Set(n);
        signal.Set(3);
        return adder(1) + adder(1) * 10 + twice(n) * 100 + heard * 1000 + signal.Value;
    }

    public static int Iterators(int n) => Algorithms.Evens(n % 12).Where(value => value % 3 != 0).Sum() + Algorithms.Evens(3).Count();

    public static int Exceptions(int n)
    {
        int guarded;
        try
        {
            // Geometry's filter lets codes 2 and 3 through; 0 and 1 go on
            // to this handler.
            guarded = Algorithms.Guard(() => Algorithms.Fail(n % 4));
        }
        catch (GeometryException error)
        {
            guarded = error.Code * 7 + error.Message.Length;
        }

        int caught;
        try
        {
            caught = Algorithms.Largest(new List<Tile>()).Side;
        }
        catch (GeometryException error)
        {
            caught = error.Code * 10 + error.Message.Length;
        }

        return guarded * 100 + caught;
    }

    public static int Async(int n) => Algorithms.Later(n).Result;

    public static int Internals(int n) => Secrets.Key * n;
}
