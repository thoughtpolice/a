// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Records;

public interface IPositioned
{
    int X { get; }
}

public record Point(int X, int Y) : IPositioned
{
    public int Sum => X + Y;
}

public record Point3(int X, int Y, int Z) : Point(X, Y + 1);

public sealed record Named
{
    public string Name { get; init; }

    public int Size { get; init; }

    public int Hidden;

    private int secret;

    public Named WithSecret(int value) => this with { secret = value };

    public bool HasSecret(int value) => secret == value;
}

public readonly record struct Pair(int A, string B);

public record struct Counter(int Count, int Step)
{
    public void Bump() => Count += Step;

    public readonly int Next => Count + Step;
}

public abstract record Shape
{
    public abstract int Area();
}

public sealed record Circle(int Radius) : Shape
{
    public override int Area() => 3 * Radius * Radius;
}

public record Rect(int W, int H) : Shape
{
    public override int Area() => W * H;
}

public sealed record Square(int Side) : Rect(Side, Side);

public record Node(int Value, Node Next);

public record Labeled(string Label, Pair Inner, Point At, bool Flag, char Mark, long Big);

public record Scaled(int X)
{
    public int Double { get; init; } = X * 2;

    public int Triple = X * 3;
}

public record Mod10(int X)
{
    public override string ToString() => "Mod10:" + X;

    public virtual bool Equals(Mod10 other) => other is not null && other.X % 10 == X % 10;

    public override int GetHashCode() => X % 10;
}

public record Counted(int X)
{
    public int Copies;

    protected Counted(Counted original)
    {
        X = original.X;
        Copies = original.Copies + 1;
    }
}

public record Floats(float F, int I);

public record Outer(int A);

public record Inner(int A, int B) : Outer(A)
{
    public override string ToString() => "!" + base.ToString();
}

public record class Explicit(int X, int Y)
{
    public int X { get; init; } = X + 1;
}

public static class Containing
{
    public record Nested(int V)
    {
        public record Deeper(string W);
    }
}

public record Box<T>(T Value, int Count);

public record Holder(Counter Counter)
{
    public Counter Field;
}

public record Keyed(string Name, int[] Values);

public record Owned(Seeded Owner, IPositioned At, int Tag);

public class Seeded(int seed)
{
    public int Seed = seed * 2;

    public int Twice { get; } = seed + seed;
}

public class Derived(int value) : Seeded(value + 1)
{
    public int Value = value;
}

public struct Span(int start, int length)
{
    public int Start = start;

    public int End = start + length;
}

// Records are compared with the CLR through what their values do. The
// CLR's hash codes are not reproduced, so only their consistency is.
// A family where one record declares PrintMembers: all print through a
// StringBuilder, as C# does.
public record Printed(int X, string Name)
{
    protected virtual bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append("x=").Append(X * 2);
        return true;
    }
}

public record PrintedChild(int X, string Name, double Weight) : Printed(X, Name);

public record QuietChild(int X) : Printed(X, "q")
{
    protected override bool PrintMembers(System.Text.StringBuilder builder) => false;
}

public record struct PrintedPoint(int X, int Y)
{
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append(X).Append('/').Append(Y);
        return X != 0;
    }
}

public static class Records
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

    private static int Bits(bool[] tests)
    {
        int bits = 0;
        for (int index = 0; index < tests.Length; index++)
        {
            bits |= (tests[index] ? 1 : 0) << index;
        }

        return bits;
    }

    public static int Equality(int k)
    {
        var p = new Point(k, 2);
        var q = new Point(k, 2);
        var r = new Point(k + 1, 2);
        Point none = null;
        return Bits(new[]
        {
            p == q,
            p != q,
            p.Equals(q),
            p == r,
            p.Equals(r),
            none == null,
            p == none,
            none == p,
            p.Equals(none),
            p.GetHashCode() == q.GetHashCode(),
            new Pair(k, "b") == new Pair(k, "b"),
            new Pair(k, "b") == new Pair(k, "c"),
            new Pair(k, null) == new Pair(k, null),
            new Pair(k, "b").Equals(new Pair(k, "b")),
            new Pair(k, "x").GetHashCode() == new Pair(k, "x").GetHashCode(),
            new Named { Name = "n", Size = k } == new Named { Name = "n", Size = k },
            new Named { Name = "n", Size = k } == new Named { Name = "n", Size = k, Hidden = 1 },
            new Named { Name = "n" }.WithSecret(k) == new Named { Name = "n" }.WithSecret(k),
            new Named { Name = "n" }.WithSecret(k) == new Named { Name = "n" }.WithSecret(k + 1),
        });
    }

    // Derived records never equal their bases, even with equal fields.
    public static int Inheritance(int k)
    {
        Point p = new Point(k, 3);
        Point p3 = new Point3(k, 2, 7);
        Point same = new Point3(k, 2, 7);
        Point other = new Point3(k, 2, 8);
        Rect rect = new Rect(k, k);
        Rect square = new Square(k);
        return Bits(new[]
        {
            p == p3,
            p3 == p,
            p.Equals(p3),
            p3.Equals(p),
            p3 == same,
            p3.Equals(same),
            p3 == other,
            p3.GetHashCode() == same.GetHashCode(),
            rect == square,
            square == new Square(k),
            ((Point3)p3).Y == 3,
            p3.X == k,
            rect.Equals(square),
            square.Equals(rect),
        });
    }

    public static int With(int k)
    {
        var p = new Point(1, 2);
        var q = p with { Y = k };
        var r = q with { };
        Point p3 = new Point3(1, 2, 3);
        var moved = p3 with { X = k };
        var named = new Named { Name = "a", Size = 1, Hidden = 5 };
        var renamed = named with { Name = "b" };
        renamed.Hidden = 9;
        var pair = new Pair(k, "x");
        var repaired = pair with { B = "y" };
        var counter = new Counter(k, 2);
        var bumped = counter with { Step = 3 };
        bumped.Bump();
        var span = new Span(k, 4);
        var moreSpan = span with { End = 100 };
        Shape shape = new Circle(k);
        var sameShape = shape with { };
        return (q.Y == k ? 1 : 0)
               + (r == q ? 2 : 0)
               + (moved is Point3 { Z: 3, Y: 3 } ? 4 : 0)
               + (moved.X == k ? 8 : 0)
               + (named.Hidden == 5 && renamed.Hidden == 9 && renamed.Size == 1 ? 16 : 0)
               + (repaired.A == k && pair.B == "x" && repaired.B == "y" ? 32 : 0)
               + (counter.Count == k && bumped.Count == k + 3 ? 64 : 0)
               + (moreSpan.Start == k && moreSpan.End == 100 && span.End == k + 4 ? 128 : 0)
               + (sameShape is Circle && sameShape == shape ? 256 : 0)
               + p.X * 1000;
    }

    public static int WithNull(int k)
    {
        Point p = k > 0 ? new Point(k, k) : null;
        return (p with { X = 1 }).Y;
    }

    public static int Copies(int k)
    {
        var counted = new Counted(k);
        var copy = counted with { };
        var again = copy with { X = 2 };
        var holder = new Holder(new Counter(k, 1)) { Field = new Counter(1, 1) };
        var cloned = holder with { };
        cloned.Field.Bump();
        return counted.Copies + copy.Copies * 10 + again.Copies * 100 + again.X * 1000
               + (holder.Field.Count == 1 && cloned.Field.Count == 2 ? 10000 : 0)
               + (holder == cloned ? 100000 : 0)
               + (holder with { Field = new Counter(2, 1) } == cloned ? 1000000 : 0);
    }

    public static int Printing(int which)
    {
        string text = which switch
        {
            0 => new Point(which, -5).ToString(),
            1 => new Point3(1, 2, 3).ToString(),
            2 => new Named { Name = "n", Size = 4, Hidden = 1 }.ToString(),
            3 => new Named().ToString(),
            4 => new Pair(3, null).ToString(),
            5 => new Counter(1, 2).ToString(),
            6 => new Circle(2).ToString(),
            7 => new Node(1, new Node(2, null)).ToString(),
            8 => new Labeled("l", new Pair(1, "p"), new Point(2, 3), true, 'c', -9000000000).ToString(),
            9 => new Scaled(5).ToString(),
            10 => new Mod10(12).ToString(),
            11 => new Box<string>("s", 2).ToString(),
            12 => new Box<Pair>(new Pair(1, "q"), 0).ToString(),
            13 => "at " + new Point(1, 2) + $" and {new Pair(5, "z")}",
            15 => new Inner(1, 2).ToString(),
            16 => new Explicit(1, 2).ToString(),
            17 => new Containing.Nested(3).ToString() + new Containing.Nested.Deeper("d"),
            _ => new Square(4).ToString(),
        };
        return Digest(text);
    }

    public static int Deconstruction(int k)
    {
        var (x, y) = new Point(k, 5);
        var (a, _, c) = new Point3(1, k, 3);
        (int first, string second) = new Pair(k, "s");
        var ((left, _), right) = new Box<Point>(new Point(k, 1), 9);
        int reused;
        (reused, _) = new Point(7, 8);
        var (explicitX, explicitY) = new Explicit(k, 3);
        return x + y * 10 + a * 100 + c * 1000 + first * 10000 + second.Length * 100000 + left + right + reused
               + explicitX * 3 + explicitY;
    }

    public static int DeconstructNull(int k)
    {
        Point p = k > 0 ? new Point(k, k) : null;
        var (x, y) = p;
        return x + y;
    }

    private static int Classify(Shape shape) => shape switch
    {
        null => -1,
        Circle { Radius: 0 } => 0,
        Circle(var radius) when radius > 5 => 100 + radius,
        Circle c => c.Area(),
        Square(1) => 1,
        Square { Side: var side } => 200 + side,
        Rect(var w, 1) => 300 + w,
        Rect { W: > 10, H: < 3 } rect => 400 + rect.H,
        Rect(_, var h) => 500 + h,
        _ => -2,
    };

    public static int Patterns(int k)
    {
        Shape[] shapes = new Shape[]
        {
            new Circle(0), new Circle(k), new Square(1), new Square(k), new Rect(k, 1), new Rect(k, 2), new Rect(2, k), null,
        };
        int total = 0;
        foreach (var shape in shapes)
        {
            total = total * 3 + Classify(shape);
        }

        var line = new Box<Point>(new Point(k, 2), 3);
        bool extended = line is { Value.X: > 2, Count: 3 };
        bool nested = line is { Value: Point(_, 2) { Sum: var sum } } && sum == k + 2;
        bool positional = new Pair(k, "s") is (> 0, "s");
        bool declared = k switch { int value when value > 3 => true, _ => false };
        return total + (extended ? 1 << 20 : 0) + (nested ? 1 << 21 : 0) + (positional ? 1 << 22 : 0)
               + (declared ? 1 << 23 : 0);
    }

    public static int Keys(int k)
    {
        var points = new Dictionary<Point, int>();
        for (int index = 0; index < 6; index++)
        {
            points[new Point(index % 3, k)] = index;
        }

        var pairs = new HashSet<Pair> { new(1, "a"), new(1, "a"), new(k, "a"), new(1, null), new(1, null) };
        var nodes = new Dictionary<Node, int> { [new Node(1, new Node(k, null))] = 5 };
        var boxes = new HashSet<Box<string>> { new("x", 1), new("x", 1), new("y", 1) };
        var shapes = new Dictionary<Shape, int> { [new Rect(2, 2)] = 1, [new Square(2)] = 2, [new Circle(2)] = 3 };
        int order = 0;
        foreach (var key in points.Keys)
        {
            order = order * 10 + key.X;
        }

        return points.Count + points[new Point(1, k)] * 10 + order * 100
               + pairs.Count * 10000000 + (pairs.Contains(new Pair(k, "a")) ? 100000000 : 0)
               + (nodes.ContainsKey(new Node(1, new Node(k, null))) ? 1 << 9 : 0)
               + boxes.Count * 3
               + shapes[new Rect(2, 2)] + shapes[new Square(2)] * 7 + (shapes.ContainsKey(new Rect(3, 3)) ? 1 << 8 : 0);
    }

    public static int UserMembers(int k)
    {
        var a = new Mod10(k);
        var b = new Mod10(k + 10);
        var set = new HashSet<Mod10> { a, b, new Mod10(k + 1) };
        return Bits(new[] { a == b, a.Equals(b), a == new Mod10(k + 1), a.GetHashCode() == b.GetHashCode() })
               + set.Count * 100 + Digest(a.ToString()) % 1000 * 1000;
    }

    public static int Structs(int k)
    {
        var counter = new Counter(k, 2);
        counter.Bump();
        counter.Count += 1;
        var copy = counter;
        copy.Bump();
        var (count, step) = counter;
        return counter.Count * 100 + copy.Count + counter.Next * 10000 + count * 1000000 + step
               + (counter == copy ? 1 << 30 : 0);
    }

    public static int Initializers(int k)
    {
        var scaled = new Scaled(k);
        var changed = scaled with { X = 1 };
        var seeded = new Seeded(k);
        var derived = new Derived(k);
        var span = new Span(k, 3);
        return scaled.Double + scaled.Triple * 10 + changed.Double * 100 + changed.X * 1000
               + seeded.Seed * 10000 + seeded.Twice * 100000 + derived.Seed * 1000000 + derived.Value
               + span.End * 3;
    }

    public static int Generic(int k)
    {
        var box = new Box<int>(k, 1);
        var other = box with { Count = 2 };
        var strings = new Box<string>("v" + k, k);
        return (box == new Box<int>(k, 1) ? 1 : 0) + (box == other ? 2 : 0) + other.Count * 4
               + (strings == new Box<string>("v" + k, k) ? 8 : 0) + strings.Value.Length * 16;
    }

    public static int Interfaces(int k)
    {
        IPositioned positioned = new Point3(k, 1, 2);
        Shape shape = k > 0 ? new Circle(k) : new Rect(k, 2);
        return positioned.X + shape.Area() * 10;
    }

    public static int FloatEquality(int k)
    {
        var nan = new Floats(float.NaN, k);
        var zero = new Floats(0f, k);
        var negative = new Floats(-0f, k);
        return Bits(new[]
        {
            nan == new Floats(float.NaN, k),
            zero == negative,
            nan == zero,
            zero.GetHashCode() == negative.GetHashCode(),
        });
    }

    // Members of class and interface types compare and hash by identity.
    public static int Owners(int k)
    {
        var owner = new Seeded(k);
        var at = new Point(k, k);
        var owned = new HashSet<Owned>
        {
            new(owner, at, 1), new(owner, at, 1), new(new Seeded(k), at, 1), new(owner, new Point(k, k), 1),
        };
        var counts = new Dictionary<Owned, int>();
        foreach (var item in owned)
        {
            counts[item with { Tag = 2 }] = counts.TryGetValue(item with { Tag = 2 }, out int count) ? count + 1 : 1;
        }

        return owned.Count * 10 + counts.Count + (owned.Contains(new Owned(owner, at, 1)) ? 100 : 0);
    }

    public static int ArrayMembers(int k)
    {
        int[] values = new[] { k };
        var a = new Keyed("a", values);
        var b = new Keyed("a", values);
        var c = new Keyed("a", new[] { k });
        return Bits(new[] { a == b, a == c, a.Equals(b) });
    }

    public static int SourcePrintMembers(int which) => Digest(which switch
    {
        0 => new Printed(3, "p").ToString(),
        1 => new PrintedChild(4, "c", 1.5).ToString(),
        2 => new QuietChild(5).ToString(),
        3 => new PrintedPoint(1, 2).ToString(),
        4 => new PrintedPoint(0, 7).ToString(),
        _ => $"{(Printed)new PrintedChild(1, null, -0.0)}",
    });
}
