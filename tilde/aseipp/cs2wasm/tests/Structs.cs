// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

// A readonly member calling a mutating one on `this` mutates a copy, on
// purpose here.
#pragma warning disable CS8656

namespace Tests.StructTypes;

public readonly struct Vector2
{
    public readonly float X;
    public readonly float Y;

    public Vector2(float x, float y)
    {
        X = x;
        Y = y;
    }

    public Vector2 Add(Vector2 other) => new Vector2(X + other.X, Y + other.Y);

    public Vector2 Scale(float factor) => new Vector2(X * factor, Y * factor);

    public float Dot(Vector2 other) => X * other.X + Y * other.Y;

    public float LengthSquared => Dot(this);

    public static Vector2 operator +(Vector2 left, Vector2 right) => left.Add(right);

    public static Vector2 operator -(Vector2 value) => new Vector2(-value.X, -value.Y);

    public static Vector2 operator *(Vector2 value, float factor) => value.Scale(factor);

    public static explicit operator Point(Vector2 value) => new Point { X = (int)value.X, Y = (int)value.Y };
}

public struct Counter : ICounter
{
    public int Count;
    public int Step;

    public Counter(int step)
    {
        Count = 0;
        Step = step;
    }

    public void Increment() => Count += Step == 0 ? 1 : Step;

    public readonly int Peek() => Count;

    public int Value => Count;

    public int Doubled
    {
        get => Count * 2;
        set => Count = value / 2;
    }

    // A readonly member calling a mutating one mutates a copy.
    public readonly int PeekAfterIncrement()
    {
        Increment();
        return Count;
    }

    public void Reset() => this = new Counter(Step);

    public static Counter operator ++(Counter counter)
    {
        counter.Increment();
        return counter;
    }
}

public interface ICounter
{
    void Increment();

    int Value { get; }
}

public struct Rect
{
    public Point Min;
    public Point Max;
    public int Tag;

    public int Area => (Max.X - Min.X) * (Max.Y - Min.Y);

    public void Grow(int amount)
    {
        Min.Move(-amount, -amount);
        Max.Move(amount, amount);
    }
}

public struct Point
{
    public int X;
    public int Y;

    public void Move(int dx, int dy)
    {
        X += dx;
        Y += dy;
    }
}

// Field initializers run in written constructors; `new Settings()` runs the
// parameterless one, and `default` skips it.
public struct Settings
{
    public int Volume = 7;
    public bool Enabled = true;
    public long Seed;

    public Settings()
    {
        Seed = 42;
    }

    public Settings(long seed)
    {
        Seed = seed;
    }
}

// A struct holding references and every scalar width.
public struct Mixed
{
    public byte Small;
    public char Letter;
    public long Wide;
    public double Real;
    public int[] Items;
    public Holder Owner;
}

public struct Empty
{
}

// A constructor that mutates `this` through a method.
public struct Accumulator
{
    public int Total;

    public Accumulator(int start, int times)
    {
        Total = start;
        for (int index = 0; index < times; index++)
        {
            Add(index);
        }
    }

    public void Add(int value) => Total += value;
}

public sealed class Holder
{
    public Counter Counter;
    public Rect Bounds;
    public readonly Counter Frozen = new Counter(1);
    public Point[] Points = new Point[3];

    public Point Position { get; set; }

    public int Bump()
    {
        Counter.Increment();
        Frozen.Increment();
        return Counter.Count * 100 + Frozen.Count;
    }
}

public sealed class Wrapper<T>
{
    public T Value;
}

// Thrown in a module without a try statement, which ends the entry.
public sealed class StructFault : Exception
{
    public Point Where;
}

// Structs through virtual, interface and delegate calls.
public abstract class Shape
{
    public abstract Point Corner(Point origin);
}

public sealed class Frame : Shape
{
    public override Point Corner(Point origin)
    {
        origin.Move(2, 3);
        return origin;
    }
}

public interface IMover
{
    Point Move(Point point, int distance);
}

public sealed class Mover : IMover
{
    public Point Move(Point point, int distance)
    {
        point.Move(distance, -distance);
        return point;
    }
}

public static class Structs
{
    private static int calls;
    private static Counter shared;
    private static Holder missing = null;

    private static int Next() => ++calls;

    public static int Calls() => calls;

    public static float Vectors(float x)
    {
        var a = new Vector2(x, 2);
        var b = new Vector2(3, x);
        var sum = a.Add(b).Scale(0.5f);
        return sum.X * 1000 + sum.Y * 10 + a.Dot(b) + b.LengthSquared;
    }

    public static float Operators(float x)
    {
        var a = new Vector2(x, 1);
        var b = -a + new Vector2(2, 3) * 2;
        b += a * 2;
        b *= 0.5f;
        var point = (Point)(b * 10);
        var counter = new Counter(3);
        var before = counter++;
        ++counter;
        var holder = new Holder();
        holder.Counter++;
        return b.X * 1000 + b.Y + point.X * 100000 + before.Count * 10 + counter.Count + holder.Counter.Count * 0.5f;
    }

    public static int CopySemantics(int value)
    {
        var first = new Counter(value);
        var second = first;
        second.Increment();
        second.Increment();
        first.Increment();
        var third = second;
        third.Count = 100;
        return first.Count * 10000 + second.Count * 100 + third.Count + first.Peek();
    }

    public static int Properties(int value)
    {
        var counter = new Counter(1);
        counter.Doubled = value;
        int before = counter.Doubled;
        counter.Increment();
        int peeked = counter.PeekAfterIncrement();
        return before * 1000 + counter.Value * 10 + peeked;
    }

    public static int WholeThis(int step)
    {
        var counter = new Counter(step);
        counter.Increment();
        counter.Increment();
        int before = counter.Count;
        counter.Reset();
        counter.Increment();
        return before * 100 + counter.Count;
    }

    public static int Arrays(int count)
    {
        var points = new Point[count];
        for (int index = 0; index < count; index++)
        {
            points[index].X = index;
            points[index].Move(1, index * 2);
        }

        var copy = points[count - 1];
        copy.X = 1000;
        int total = 0;
        foreach (var point in points)
        {
            var moved = point;
            moved.Move(5, 5);
            total += point.X * 10 + point.Y + moved.X;
        }

        return total + points[count - 1].X * 100000;
    }

    public static int ArrayInitializer(int value)
    {
        var points = new[] { new Point { X = value, Y = 1 }, new Point { X = 2, Y = value } };
        var empty = new Point[2];
        return points[0].X * 1000 + points[1].Y * 10 + empty[1].X + empty[0].Y;
    }

    public static int Fields(int value)
    {
        var holder = new Holder();
        holder.Counter.Step = value;
        holder.Counter.Increment();
        holder.Counter.Increment();
        var copy = holder.Counter;
        copy.Increment();
        holder.Bounds.Max.X = 10;
        holder.Bounds.Max.Y = 5;
        holder.Bounds.Grow(1);
        holder.Points[1].Move(value, 1);
        int bumped = holder.Bump();
        return holder.Counter.Count * 1000000 + copy.Count * 10000 + holder.Bounds.Area * 10 + holder.Points[1].X
            + bumped * 100000000;
    }

    public static int AutoProperty(int value)
    {
        var holder = new Holder();
        var position = holder.Position;
        position.Move(value, 1);
        holder.Position = position;
        position.Move(100, 100);
        return holder.Position.X * 100 + holder.Position.Y + position.Y * 1000;
    }

    public static int Nested(int amount)
    {
        var rect = new Rect { Tag = 3 };
        rect.Max.X = 4;
        rect.Max.Y = 4;
        rect.Grow(amount);
        var inner = rect.Min;
        inner.Move(100, 100);
        rect.Min.Move(1, 0);
        return rect.Area * 1000 + rect.Min.X * 10 + inner.X + rect.Tag * 100000;
    }

    public static int Constructors(int value)
    {
        var made = new Settings();
        var seeded = new Settings(value);
        Settings zero = default;
        var empty = new Empty();
        var copyOfEmpty = empty;
        _ = copyOfEmpty;
        var accumulator = new Accumulator(value, 4);
        return made.Volume * 1000 + (made.Enabled ? 100 : 0) + (int)made.Seed + (int)seeded.Seed * 10000
            + zero.Volume + (zero.Enabled ? 1 : 0) + accumulator.Total * 1000000;
    }

    public static double MixedFields(int value)
    {
        var mixed = new Mixed { Small = (byte)value, Letter = 'A', Wide = value * 3L, Real = value / 4.0 };
        mixed.Items = new[] { value, 2 };
        mixed.Owner = new Holder();
        var copy = mixed;
        copy.Items[0] = 9;
        copy.Small++;
        copy.Owner.Counter.Count = 5;
        return mixed.Small + mixed.Letter + mixed.Wide + mixed.Real + mixed.Items[0] * 1000 + copy.Small * 100
            + mixed.Owner.Counter.Count * 10000;
    }

    public static int Closures(int value)
    {
        var counter = new Counter(value);
        Action bump = () => counter.Increment();
        Func<int> read = () => counter.Count;
        bump();
        bump();
        var snapshot = counter;
        Func<int> readSnapshot = () => snapshot.Count;
        bump();
        return read() * 10000 + readSnapshot() * 100 + counter.Count;
    }

    public static int Statics(int value)
    {
        shared.Step = value;
        shared.Increment();
        var copy = shared;
        copy.Increment();
        return shared.Count * 100 + copy.Count;
    }

    private static bool TryDivide(int left, int right, out int quotient)
    {
        if (right == 0)
        {
            quotient = -1;
            return false;
        }

        quotient = left / right;
        return true;
    }

    private static void Swap<T>(ref T left, ref T right)
    {
        T swap = left;
        left = right;
        right = swap;
    }

    private static void MoveBy(ref Point point, int amount) => point.Move(amount, amount);

    private static void Read(out Vector2 vector, out Counter counter)
    {
        vector = new Vector2(1, 2);
        counter = new Counter(3);
        counter.Increment();
    }

    public static int References(int value)
    {
        bool ok = TryDivide(100, value, out int quotient);
        TryDivide(1, 0, out var failed);
        TryDivide(7, 1, out _);
        int left = 1;
        int right = 2;
        Swap(ref left, ref right);
        var points = new Point[2];
        points[1].X = 5;
        Swap(ref points[0], ref points[1]);
        MoveBy(ref points[0], value);
        var holder = new Holder();
        MoveBy(ref holder.Bounds.Min, 3);
        Read(out var vector, out var counter);
        return (ok ? quotient : 0) * 1000000 + failed * 100000 + left * 10000 + right * 1000 + points[0].X * 10
            + holder.Bounds.Min.Y + (int)vector.Y * 100 + counter.Count;
    }

    private static void Countdown(ref int remaining, ref Counter counter)
    {
        while (remaining > 0)
        {
            remaining--;
            counter.Increment();
            Tick(ref remaining);
        }
    }

    private static void Tick(ref int remaining) => remaining -= remaining > 5 ? 1 : 0;

    public static int RefParameters(int value)
    {
        int remaining = value;
        var counter = new Counter(2);
        Countdown(ref remaining, ref counter);
        return remaining * 1000 + counter.Count;
    }

    private static int BumpTwice<T>(T counter)
        where T : ICounter
    {
        counter.Increment();
        counter.Increment();
        return counter.Value;
    }

    private static int BumpBoxed<T>(Wrapper<T> wrapper)
        where T : ICounter
    {
        wrapper.Value.Increment();
        return wrapper.Value.Value;
    }

    public static int Generic(int value)
    {
        var counter = new Counter(value);
        int bumped = BumpTwice(counter);
        var wrapper = new Wrapper<Counter> { Value = counter };
        int inWrapper = BumpBoxed(wrapper);
        var vectors = new Wrapper<Vector2[]> { Value = new[] { new Vector2(1, 2), new Vector2(value, 4) } };
        var pair = new Vector2(3, 4);
        var other = new Vector2(5, 6);
        Swap(ref pair, ref other);
        return bumped * 1000000 + inWrapper * 10000 + counter.Count * 100 + (int)vectors.Value[1].X * 10 + (int)pair.X;
    }

    public static int Dispatch(int value)
    {
        Shape shape = new Frame();
        IMover mover = new Mover();
        var origin = new Point { X = value, Y = 1 };
        var corner = shape.Corner(origin);
        var moved = mover.Move(origin, 5);
        Func<Point, int, Point> lambda = (point, distance) =>
        {
            point.Move(distance, distance);
            return point;
        };
        var viaLambda = lambda(origin, 10);
        return corner.X * 1000000 + corner.Y * 10000 + moved.X * 100 + moved.Y + viaLambda.Y * 1000 + origin.X;
    }

    public static int Conditional(int value)
    {
        var chosen = value > 0 ? new Point { X = 1, Y = 2 } : new Point { X = 3, Y = 4 };
        var switched = value switch
        {
            0 => new Point { X = 10 },
            1 => new Point { Y = 20 },
            _ => default,
        };
        return chosen.X * 1000 + chosen.Y * 100 + switched.X + switched.Y;
    }

    public static int Temporaries(int value)
    {
        int total = MakeCounter(value).Peek();
        MakeCounter(value).Increment();
        total += MakeCounter(value).PeekAfterIncrement() * 100;
        return total;
    }

    private static Counter MakeCounter(int step)
    {
        var counter = new Counter(step);
        counter.Increment();
        return counter;
    }

    // The CLR takes the address of `missing.Counter` before calling Next,
    // so the null check comes first; a plain field store checks after.
    public static int Throws(int value)
    {
        if (value > 0)
        {
            throw new StructFault { Where = new Point { X = value } };
        }

        return value;
    }

    public static int NullNestedStore()
    {
        missing.Counter.Count = Next();
        return 0;
    }

    public static int NullStore()
    {
        missing.Frozen.Increment();
        return 0;
    }

    public static int OutOfRangeStore(int index)
    {
        var points = new Point[2];
        points[index].X = Next();
        return points[0].X;
    }
}
