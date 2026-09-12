// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A gameplay library over another (gameplayc --library Shapes --reference
// Geometry.dll): its classes derive from Geometry's, and one re-implements
// Geometry's interface.

using System.Collections.Generic;
using Tests.Geometry;

namespace Tests.Shapes;

public class Rect : Figure
{
    public Rect(int width, int height)
    {
        Width = width;
        Height = height;
    }

    public int Width { get; }

    public int Height { get; }

    public override int Area() => Width * Height;
}

public sealed class Square : Rect
{
    public Square(int side)
        : base(side, side)
    {
    }

    public override int Scale(int factor) => base.Scale(factor) + 1;

    public override T Pick<T>(T first, T second) => second;
}

// Geometry's interface again, so its Area is this class's own, whatever
// Rect's is.
public sealed class Labelled : Rect, IArea
{
    public Labelled(int width, int height)
        : base(width, height)
    {
    }

    int IArea.Area() => 1000 + Width;
}

public static class Catalog
{
    public static List<Figure> Standard(int size) => [new Rect(size, 2), new Square(size), new Labelled(1, size)];
}
