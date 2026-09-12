// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Generic;

namespace Tests.Boxing;

public enum Color
{
    Red,
    Green,
    Blue,
}

public enum Shade
{
    Light,
    Dark,
}

public interface IShape
{
    int Area();

    void Grow(int by);

    int Size { get; }
}

public struct Square : IShape
{
    public int Side;

    public Square(int side) => Side = side;

    public int Area() => Side * Side;

    public void Grow(int by) => Side += by;

    public int Size => Side;
}

public struct Point
{
    public int X;
    public int Y;

    public Point(int x, int y)
    {
        X = x;
        Y = y;
    }
}

public struct Labeled
{
    public string Label;
    public int Value;

    public override string ToString() => Label + "=" + Value;

    public override bool Equals(object obj) => obj is Labeled other && other.Value == Value;

    public override int GetHashCode() => Value;
}

public readonly record struct Pair(int A, int B);

public sealed class Node
{
    public int Value;
}

public class Named
{
    public string Name;

    public int Identity => base.GetHashCode();

    public override string ToString() => "Named:" + Name;

    public override bool Equals(object obj) => obj is Named other && other.Name == Name;

    public override int GetHashCode() => Name.Length;
}

public sealed class Circle : IShape
{
    public int Radius;

    public int Area() => 3 * Radius * Radius;

    public void Grow(int by) => Radius += by;

    public int Size => Radius;
}

public record Tag(string Name, int Size);

public union Item(int, string, Point, Color, Pair);

public union Nested(Item, Node);

public union Shapes(IShape, Node);

public sealed class Holder
{
    public object Item;

    public IShape Shape;
}

// Boxes and object values compared with the CLR.
public static class Boxing
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

    private static object Make(int which) => which switch
    {
        0 => 5,
        1 => 2,
        2 => 7L,
        3 => "four",
        4 => new Point(1, 2),
        5 => Color.Blue,
        6 => new Square(3),
        7 => new Node { Value = 8 },
        8 => new Pair(1, 2),
        9 => 'c',
        10 => true,
        11 => 2.5,
        12 => new Circle { Radius = 2 },
        13 => Shade.Dark,
        14 => new Tag("t", 2),
        _ => null,
    };

    // Each boxing makes a new object.
    public static int Identity(int k)
    {
        object a = k;
        object b = a;
        object c = k;
        return (ReferenceEquals(a, b) ? 1 : 0) + (ReferenceEquals(a, c) ? 2 : 0) + (a == c ? 4 : 0)
               + (a.Equals(c) ? 8 : 0) + (Equals(a, c) ? 16 : 0) + (Equals(a, null) ? 32 : 0)
               + (Equals(null, null) ? 64 : 0) + (a.GetHashCode() == c.GetHashCode() ? 128 : 0);
    }

    public static int Unboxing(int which)
    {
        object o = Make(which);
        return which switch
        {
            5 or 13 => (int)o,
            2 => (int)(long)o,
            4 => ((Point)o).Y,
            6 => ((Square)o).Side,
            8 => ((Pair)o).B,
            9 => (char)o,
            10 => (bool)o ? 1 : 0,
            11 => (int)(double)o,
            _ => (int)o,
        };
    }

    public static int EnumUnboxing(int which)
    {
        object color = Color.Green;
        object number = 2;
        return which switch
        {
            0 => (int)color,
            1 => (int)(Color)number,
            2 => (int)(Shade)color,
            3 => (int)(uint)number,
            4 => (int)(long)number,
            5 => color is int ? 1 : 0,
            6 => number is Color ? 1 : 0,
            7 => color is Color ? 1 : 0,
            8 => (Color.Green.Equals(color) ? 1 : 0) + (Color.Green.Equals(number) ? 2 : 0),
            _ => Color.Blue.GetHashCode() == ((object)Color.Blue).GetHashCode() ? 1 : 0,
        };
    }

    // Unboxing copies; a struct in a box is its own copy.
    public static int Copies(int k)
    {
        var square = new Square(k);
        object boxed = square;
        square.Side = 100;
        var first = (Square)boxed;
        first.Side++;
        var second = (Square)boxed;
        var holder = new Holder { Item = square };
        square.Side = 7;
        return first.Side * 1000 + second.Side + ((Square)holder.Item).Side * 1000000;
    }

    // An interface call on a boxed struct mutates the box.
    public static int Interfaces(int k)
    {
        IShape shape = new Square(k);
        shape.Grow(2);
        shape.Grow(3);
        var back = (Square)shape;
        IShape copy = back;
        copy.Grow(1);
        var holder = new Holder { Shape = shape };
        holder.Shape.Grow(10);
        IShape circle = new Circle { Radius = k };
        return shape.Area() + back.Side * 1000 + copy.Size * 100000 + ((Square)shape).Side * 10000000
               + (circle is Square ? 1 : 0) + (shape is Square ? 2 : 0) + (shape is Circle ? 4 : 0);
    }

    public static int Patterns(int which)
    {
        object o = Make(which);
        return o switch
        {
            int i when i > 3 => i,
            int i => -i,
            long l => (int)l * 2,
            string s => s.Length * 10,
            Point { X: 1 } p => p.X * 100 + p.Y,
            Color c => 1000 + (int)c,
            IShape shape => shape.Area() * 7,
            Node node => node.Value,
            Pair(var a, var b) => a * 10 + b,
            Tag { Size: var size } => size * 1000,
            char c => c,
            bool flag => flag ? 11 : 12,
            null => -1000,
            _ => -1,
        };
    }

    public static int TypeTests(int which)
    {
        object o = Make(which);
        int bits = 0;
        bool[] tests =
        {
            o is int, o is long, o is Color, o is IShape, o is Square, o is Point, o is object, o is string,
            o is Node, o is Pair, o is Shade, o is double, o is char, o is bool,
        };
        for (int index = 0; index < tests.Length; index++)
        {
            bits |= (tests[index] ? 1 : 0) << index;
        }

        return bits;
    }

    public static int Casts(int which)
    {
        object o = Make(which);
        return which switch
        {
            3 => ((string)o).Length,
            7 => ((Node)o).Value,
            12 => ((IShape)o).Area(),
            6 => ((IShape)o).Size,
            _ => ((Node)o).Value,
        };
    }

    public static int Equality(int which)
    {
        object left = Make(which);
        object right = Make(which);
        int bits = (left == null ? right == null : left.Equals(right)) ? 1 : 0;
        bits |= (Equals(left, right) ? 1 : 0) << 1;
        bits |= (left != null && right != null && left.GetHashCode() == right.GetHashCode() ? 1 : 0) << 2;
        bits |= (left != null && left.Equals(Make(which + 1)) ? 1 : 0) << 3;
        bits |= (ReferenceEquals(left, right) ? 1 : 0) << 4;
        return bits;
    }

    public static int Overrides(int k)
    {
        object a = new Labeled { Label = "a", Value = k };
        object b = new Labeled { Label = "b", Value = k };
        object c = new Named { Name = "n" + k };
        object d = new Named { Name = "n" + k };
        var named = new HashSet<Named> { new() { Name = "x" }, new() { Name = "x" }, new() { Name = "yy" } };
        var first = new Named { Name = "i" };
        return (a.Equals(b) ? 1 : 0) + (a.GetHashCode() == k ? 2 : 0) + (c.Equals(d) ? 4 : 0)
               + (c == d ? 8 : 0) + (c.GetHashCode() == d.GetHashCode() ? 16 : 0) + named.Count * 100
               + (first.Identity == first.Identity ? 1000 : 0);
    }

    public static int Keys(int k)
    {
        var counts = new Dictionary<object, int>();
        object[] keys =
        {
            1, 1L, "a", Color.Red, new Point(1, k), new Pair(1, 2), 1, "a" + "", Color.Red, new Point(1, k),
            new Pair(1, 2), 'a', Shade.Light, k, new Named { Name = "q" }, new Named { Name = "q" },
            new Tag("x", k), new Tag("x", k),
        };
        foreach (object key in keys)
        {
            counts[key] = counts.TryGetValue(key, out int count) ? count + 1 : 1;
        }

        var node = new Node();
        counts[node] = 50;
        counts[new Node()] = 60;
        int order = 0;
        foreach (var pair in counts)
        {
            order = order * 3 + pair.Value;
        }

        var set = new HashSet<object> { 1, 1, 2, "x", "x", new Pair(1, 1), new Pair(1, 1) };
        return counts.Count * 1000 + counts[1] * 100 + counts[new Point(1, k)] * 10 + counts[node] + order % 997 * 10000
               + set.Count * 10000000;
    }

    public static int Printing(int which)
    {
        string text = which switch
        {
            0 => ((object)5).ToString(),
            1 => new Point(1, 2).ToString(),
            2 => ((object)new Pair(1, 2)).ToString(),
            3 => new Node().ToString(),
            4 => ((object)new Labeled { Label = "l", Value = 3 }).ToString(),
            5 => $"{(object)true}{(object)'c'}{(object)-7L}",
            6 => "x" + (object)null + new Named { Name = "n" } + new Point(),
            7 => ((object)"str").ToString(),
            8 => Make(8) + "|" + Make(3) + "|" + Make(9) + "|" + Make(0),
            9 => ((IShape)new Square(2)).ToString() + new Circle(),
            10 => Make(14).ToString() + (object)new Tag(null, -1),
            _ => "",
        };
        return Digest(text);
    }

    public static int Unions(int which)
    {
        Item value = which switch
        {
            0 => 5,
            1 => "text",
            2 => new Point(1, 2),
            3 => Color.Green,
            4 => new Pair(3, 4),
            _ => default,
        };
        return value switch
        {
            int i => i,
            string s => s.Length * 10,
            Point p => p.X * 100 + p.Y,
            Color c => 1000 + (int)c,
            Pair(var a, var b) => a * 10000 + b,
            null => -1,
        };
    }

    public static int UnionValues(int which)
    {
        Item value = which switch
        {
            0 => 5,
            1 => "text",
            2 => new Point(1, 2),
            3 => Color.Green,
            _ => default,
        };
        object inner = value.Value;
        return (inner switch
        {
            int i => i,
            string s => s.Length,
            Point p => p.Y,
            Color c => 10 + (int)c,
            null => -1,
            _ => -2,
        }) + (value is { Value: string text } ? 100 * text.Length : 0) + (value is { Value: null } ? 1000 : 0);
    }

    public static int NestedUnions(int which)
    {
        Nested nested = which switch
        {
            0 => new Node { Value = 7 },
            1 => (Item)5,
            2 => (Item)"ab",
            3 => (Item)new Point(3, 4),
            _ => default,
        };
        return nested switch
        {
            Item inner => inner switch
            {
                int i => i * 2,
                string s => s.Length * 100,
                Point p => p.X + p.Y * 10,
                _ => -5,
            },
            Node node => node.Value,
            null => -1,
        };
    }

    public static int InterfaceUnions(int which)
    {
        Shapes shapes = which switch
        {
            0 => new Square(3),
            1 => new Circle { Radius = 2 },
            2 => new Node { Value = 9 },
            _ => default,
        };
        return shapes switch
        {
            IShape shape => shape.Area() + (shape is Square ? 100 : 0),
            Node node => node.Value,
            null => -1,
        };
    }

    public static int UnionEquality(int k)
    {
        var set = new HashSet<Item> { 5, 5, "a", "a" + "", new Point(1, k), new Point(1, k), default, default, Color.Red };
        Item one = k;
        Item other = k;
        return set.Count * 10 + (one.Equals(other) ? 1 : 0) + (one.Equals((Item)(k + 1)) ? 2 : 0);
    }

    private static bool Same<T>(T left, T right) => left.Equals(right);

    private static int Hash<T>(T value) => value.GetHashCode();

    private static string Text<T>(T value) => value.ToString();

    public static int Generic(int k)
    {
        var list = new List<object> { k, "s", new Point(k, 1), null };
        int nulls = 0;
        foreach (object item in list)
        {
            if (item == null)
            {
                nulls++;
            }
        }

        return (Same(k, k) ? 1 : 0) + (Same(k, k + 1) ? 2 : 0) + (Same("a", "a" + "") ? 4 : 0)
               + (Same(new Point(1, 2), new Point(1, 2)) ? 8 : 0) + (Same(new Node(), new Node()) ? 16 : 0)
               + (Hash(k) == Hash(k) ? 32 : 0) + Digest(Text(k)) % 1000 * 1000 + nulls * 100000000
               + Digest(Text(new Point(1, 2))) % 10 * 10000000;
    }

    public static int Arrays(int which)
    {
        object o = new[] { which, 2 };
        object same = o;
        return ((int[])o)[0] + (o is int[] ? 10 : 0) + (ReferenceEquals(o, same) ? 100 : 0)
               + (o.Equals(same) ? 1000 : 0) + (o.Equals(new[] { which, 2 }) ? 10000 : 0);
    }

    // An array's hash is its own; the CLR's identity hash varies by run.
    public static int ArrayHash()
    {
        var array = new int[1];
        return ((object)array).GetHashCode() == array.GetHashCode() ? 1 : 0;
    }

    public static int ArrayText() => ((object)new int[1]).ToString().Length;

    public static int EnumText() => ((object)Color.Red).ToString().Length;

    public static int DoubleText() => Make(11).ToString().Length;

    private static int One() => 1;

    public static int DelegateEquality()
    {
        System.Func<int> first = One;
        System.Func<int> second = One;
        return ((object)first).Equals(second) ? 1 : 0;
    }

    // Every boxing allocates, from the entry's allocation budget.
    public static int BoxMany(int count)
    {
        object last = null;
        for (int index = 0; index < count; index++)
        {
            last = index;
        }

        return last == null ? -1 : (int)last;
    }

    public static int UnboxNull()
    {
        object o = null;
        return (int)o;
    }
}
