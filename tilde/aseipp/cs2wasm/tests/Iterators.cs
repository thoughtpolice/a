// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections;
using System.Collections.Generic;

namespace Tests.Iterators;

public struct Point
{
    public int X;
    public int Y;
}

public sealed class Resource : IDisposable
{
    public static int Disposed;

    public void Dispose() => Disposed++;
}

public sealed class Tree
{
    public readonly int Value;
    public readonly Tree Left;
    public readonly Tree Right;

    public Tree(int value, Tree left, Tree right)
    {
        Value = value;
        Left = left;
        Right = right;
    }

    public static Tree Build(int low, int high) =>
        low > high ? null : new Tree((low + high) / 2, Build(low, (low + high) / 2 - 1), Build((low + high) / 2 + 1, high));

    // In order, through nested iterators.
    public IEnumerable<int> InOrder()
    {
        if (Left is not null)
        {
            foreach (int value in Left.InOrder())
            {
                yield return value;
            }
        }

        yield return Value;
        if (Right is not null)
        {
            foreach (int value in Right.InOrder())
            {
                yield return value;
            }
        }
    }
}

public abstract class Source
{
    public abstract IEnumerable<string> Items(int count);

    public virtual IEnumerable<string> Tagged(int count)
    {
        foreach (string item in Items(count))
        {
            yield return "<" + item + ">";
        }
    }
}

public sealed class Letters : Source
{
    private readonly string letters;

    public Letters(string letters)
    {
        this.letters = letters;
    }

    public override IEnumerable<string> Items(int count)
    {
        for (int index = 0; index < count; index++)
        {
            yield return letters[index % letters.Length].ToString();
        }
    }

    public IEnumerable<char> Distinct
    {
        get
        {
            var seen = new HashSet<char>();
            foreach (char c in letters)
            {
                if (seen.Add(c))
                {
                    yield return c;
                }
            }
        }
    }
}

public sealed class Window<T>
{
    private readonly T[] items;

    public Window(T[] items)
    {
        this.items = items;
    }

    public IEnumerable<T> Slide(int start, int count)
    {
        for (int index = start; index < start + count && index < items.Length; index++)
        {
            yield return items[index];
        }
    }
}

public struct Counter
{
    public int Start;
    public int Step;

    // An iterator of a struct runs on a copy of it, made when called:
    // mutating `this` inside changes only that copy.
    public IEnumerable<int> Run(int count)
    {
        for (int i = 0; i < count; i++)
        {
            yield return Start;
            Start += Step;
        }

        Step = -1;
        yield return Step;
    }

    public readonly IEnumerable<int> Twice()
    {
        yield return Start * 2;
        yield return Step * 2;
    }
}

public static class Iterators
{
    public static string Log = "";

    private static int Digest(string text)
    {
        int digest = text.Length;
        foreach (char c in text)
        {
            digest = unchecked(digest * 31 + c);
        }

        return digest;
    }

    private static int Sum(IEnumerable<int> values)
    {
        int sum = 0;
        foreach (int value in values)
        {
            sum = unchecked(sum * 7 + value);
        }

        return sum;
    }

    private static IEnumerable<int> Squares(int count)
    {
        for (int i = 0; i < count; i++)
        {
            yield return i * i;
        }
    }

    private static IEnumerable<int> Fibonacci()
    {
        int a = 0;
        int b = 1;
        while (true)
        {
            yield return a;
            (a, b) = (b, unchecked(a + b));
        }
    }

    private static IEnumerable<int> Take(IEnumerable<int> source, int count)
    {
        if (count <= 0)
        {
            yield break;
        }

        foreach (int value in source)
        {
            yield return value;
            if (--count == 0)
            {
                yield break;
            }
        }
    }

    private static IEnumerable<int> Where(IEnumerable<int> source, Func<int, bool> keep)
    {
        foreach (int value in source)
        {
            if (keep(value))
            {
                yield return value;
            }
        }
    }

    private static IEnumerable<TResult> Select<TSource, TResult>(IEnumerable<TSource> source, Func<TSource, TResult> map)
    {
        foreach (TSource value in source)
        {
            yield return map(value);
        }
    }

    private static IEnumerable<int> Guarded(int count)
    {
        Log += "[";
        try
        {
            for (int i = 0; i < count; i++)
            {
                Log += i;
                yield return i;
            }
        }
        finally
        {
            Log += "]";
        }

        Log += "end";
    }

    private static IEnumerable<int> Nested()
    {
        try
        {
            Log += "a";
            yield return 1;
            try
            {
                Log += "b";
                yield return 2;
                yield return 3;
            }
            finally
            {
                Log += "x";
            }

            yield return 4;
        }
        finally
        {
            Log += "y";
        }
    }

    private static IEnumerable<int> Throwing(int at)
    {
        try
        {
            for (int i = 0; ; i++)
            {
                if (i == at)
                {
                    throw new InvalidOperationException("at " + i);
                }

                yield return i;
            }
        }
        finally
        {
            Log += "f";
        }
    }

    private static IEnumerable<string> Words(int count)
    {
        for (int i = 0; i < count; i++)
        {
            switch (i % 4)
            {
                case 0:
                    yield return "zero";
                    break;
                case 1:
                    if (i > 4)
                    {
                        yield return "big";
                    }
                    else
                    {
                        yield return "one";
                    }

                    break;
                case 2:
                    using (new Resource())
                    {
                        yield return "two";
                        yield return "again";
                    }

                    break;
                default:
                    int n = 0;
                    do
                    {
                        yield return "d" + n;
                    }
                    while (++n < 2);
                    break;
            }
        }
    }

    private static IEnumerable<Func<int>> Makers(int count)
    {
        for (int i = 0; i < count; i++)
        {
            int j = i * 2;
            yield return () => j + count;
        }
    }

    private static IEnumerable<Point> Walk(Point start, int count)
    {
        var point = start;
        for (int i = 0; i < count; i++)
        {
            point.X += point.Y;
            point.Y++;
            yield return point;
        }
    }

    private static IEnumerable<T> Twice<T>(IEnumerable<T> items)
    {
        foreach (T item in items)
        {
            yield return item;
            yield return item;
        }
    }

    private static IEnumerator<char> Characters(string text)
    {
        int index = 0;
        while (index < text.Length)
        {
            if (text[index] != ' ')
            {
                yield return text[index];
            }

            index++;
        }
    }

    private static IEnumerable<int> UsingDeclaration(int count)
    {
        using var resource = new Resource();
        var list = new List<int>();
        for (int i = 0; i < count; i++)
        {
            list.Add(i);
        }

        foreach (int value in list)
        {
            yield return value + Resource.Disposed * 100;
        }

        lock (list)
        {
            yield return -1;
        }
    }

    private static IEnumerable<long> Longs(long start)
    {
        long value = start;
        double scale = 1.5;
        for (int step = 0; step < 5; step++)
        {
            yield return value;
            value = (long)(value * scale) + step;
        }
    }

    public static int Basic(int x) =>
        Sum(Squares(x)) + Sum(Take(Fibonacci(), x)) * 3 + Sum(Take(Squares(10), x - 3)) * 5;

    public static int Composed(int x) =>
        Sum(Select(Where(Take(Fibonacci(), 20), value => value % 2 == x % 2), value => value / 2 + x))
        + Digest(string.Concat(Select(Squares(x), value => value.ToString())));

    public static int Finally(int x)
    {
        Log = "";
        int sum = 0;
        foreach (int value in Guarded(5))
        {
            sum += value;
            if (value == x)
            {
                break;
            }
        }

        Log += "|";
        foreach (int value in Nested())
        {
            sum = sum * 3 + value;
            if (value == x)
            {
                break;
            }
        }

        return sum * 1000 + Digest(Log);
    }

    public static int Exceptions(int x)
    {
        Log = "";
        int sum = 0;
        try
        {
            foreach (int value in Throwing(x))
            {
                sum += value + 1;
                if (value >= 6)
                {
                    break;
                }
            }
        }
        catch (InvalidOperationException e)
        {
            Log += e.Message;
        }

        var enumerator = Squares(3).GetEnumerator();
        try
        {
            ((IEnumerator)enumerator).Reset();
        }
        catch (NotSupportedException)
        {
            Log += "reset";
        }

        return sum * 1000 + Digest(Log);
    }

    public static int Statements(int x)
    {
        Resource.Disposed = 0;
        int digest = 0;
        foreach (string word in Words(x))
        {
            digest = unchecked(digest * 31 + Digest(word));
        }

        foreach (Func<int> maker in Makers(x))
        {
            digest = unchecked(digest * 3 + maker());
        }

        foreach (Point point in Walk(new Point { X = x, Y = 2 }, 4))
        {
            digest = unchecked(digest * 5 + point.X * 3 + point.Y);
        }

        foreach (int value in UsingDeclaration(x))
        {
            digest = unchecked(digest * 7 + value);
        }

        foreach (long value in Longs(x))
        {
            digest = unchecked(digest * 11 + (int)value);
        }

        return unchecked(digest * 100 + Resource.Disposed);
    }

    public static int Enumerators(int x)
    {
        var range = Take(Fibonacci(), x);
        int sum = Sum(range) + Sum(range) * 2;
        var first = range.GetEnumerator();
        var second = range.GetEnumerator();
        first.MoveNext();
        first.MoveNext();
        second.MoveNext();
        int digest = sum * 100 + first.Current * 10 + second.Current;
        var characters = Characters("a b " + x);
        while (characters.MoveNext())
        {
            digest = unchecked(digest * 31 + characters.Current);
        }

        characters.Dispose();
        digest = digest * 2 + (characters.MoveNext() ? 1 : 0);
        var squares = Squares(x).GetEnumerator();
        while (squares.MoveNext())
        {
        }

        return unchecked(digest * 3 + squares.Current + (squares.MoveNext() ? 1 : 0));
    }

    public static int Classes(int x)
    {
        var tree = Tree.Build(1, Math.Abs(x) % 20);
        int digest = tree is null ? 7 : Sum(tree.InOrder());
        var letters = new Letters("abca" + x);
        foreach (string item in letters.Tagged(Math.Abs(x) % 7))
        {
            digest = unchecked(digest * 31 + Digest(item));
        }

        foreach (char c in letters.Distinct)
        {
            digest = unchecked(digest * 31 + c);
        }

        Source source = letters;
        foreach (string item in source.Items(3))
        {
            digest = unchecked(digest * 31 + Digest(item));
        }

        var window = new Window<string>(["p", "q", "r", x.ToString()]);
        foreach (string item in window.Slide(1, 5))
        {
            digest = unchecked(digest * 31 + Digest(item));
        }

        foreach (int value in Twice(new[] { 1, x }))
        {
            digest = unchecked(digest * 3 + value);
        }

        foreach (char c in Twice(Twice("ab")))
        {
            digest += c;
        }

        return digest;
    }

    private static IEnumerable<string> Pairs(Dictionary<string, int> map)
    {
        foreach (var (key, value) in map)
        {
            if (value > 0)
            {
                yield return key + value;
            }
            else
            {
                continue;
            }
        }
    }

    private static IEnumerable<int> Locked(int count)
    {
        lock (Log)
        {
            using var nothing = (IDisposable)null;
            for (int i = 0; i < count; i++)
            {
                try
                {
                    yield return i;
                }
                finally
                {
                    count--;
                }
            }
        }
    }

    public static int StructIterators(int x)
    {
        var counter = new Counter { Start = x, Step = 3 };
        var run = counter.Run(3);
        counter.Start = 1000;
        int digest = Sum(run) + Sum(run) * 3;
        digest = unchecked(digest * 31 + counter.Start + counter.Step);
        digest = unchecked(digest * 31 + Sum(counter.Twice()));
        var boxed = new List<Counter> { counter };
        return unchecked(digest * 31 + Sum(boxed[0].Run(2)));
    }

    public static int LocalIterators(int x)
    {
        int offset = x;
        var seen = new List<int>();
        IEnumerable<int> Steps(int count)
        {
            try
            {
                for (int i = 0; i < count; i++)
                {
                    seen.Add(i);
                    yield return i * offset;
                    offset++;
                }
            }
            finally
            {
                seen.Add(-1);
            }
        }

        static IEnumerable<string> Words(string text)
        {
            foreach (char c in text)
            {
                if (c != ' ')
                {
                    yield return c + "!";
                }
            }
        }

        int digest = Sum(Steps(3));
        foreach (int v in Steps(4))
        {
            digest = digest * 7 + v;
            if (v > 10)
            {
                break;
            }
        }

        foreach (string w in Words("a b" + x))
        {
            digest = digest * 5 + w.Length + w[0];
        }

        return unchecked(digest * 31 + seen.Count * 100 + offset);
    }

    private static IEnumerable<int> Labeled(int n)
    {
        int i = 0;
        again:
        yield return i * 10;
        if (++i < n)
        {
            goto again;
        }

        yield return -1;
        done:
        if (i < n + 2)
        {
            i++;
            yield return i;
            goto done;
        }
    }

    private static IEnumerable<string> Cases(int n)
    {
        for (int i = 0; i < n; i++)
        {
            switch (i % 4)
            {
                case 0:
                    yield return "zero";
                    goto case 2;
                case 1:
                    yield return "one";
                    goto default;
                case 2:
                    yield return "two";
                    break;
                default:
                    yield return "other";
                    break;
            }
        }
    }

    public static int Jumps(int x)
    {
        int digest = Sum(Labeled(Math.Abs(x) % 5));
        foreach (string word in Cases(Math.Abs(x) % 9))
        {
            digest = digest * 7 + word.Length + word[1];
        }

        return digest;
    }

    public static int Fuel(int count)
    {
        int sum = 0;
        foreach (int value in Take(Fibonacci(), count))
        {
            sum = unchecked(sum + value);
        }

        return sum;
    }

    public static int Deconstructing(int x)
    {
        var map = new Dictionary<string, int> { ["a"] = x, ["b"] = -1, ["c"] = x * 2 };
        int digest = 0;
        foreach (var (key, value) in map)
        {
            digest = unchecked(digest * 31 + Digest(key) + value);
        }

        foreach (string pair in Pairs(map))
        {
            digest = unchecked(digest * 31 + Digest(pair));
        }

        foreach (int value in Locked(x))
        {
            digest = unchecked(digest * 7 + value);
        }

        return digest;
    }
}
