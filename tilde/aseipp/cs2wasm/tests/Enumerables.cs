// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections;
using System.Collections.Generic;

namespace Tests.Enumerables;

public sealed class Countdown : IEnumerable<int>
{
    private readonly int from;

    public Countdown(int from)
    {
        this.from = from;
    }

    public static int Disposed;

    public IEnumerator<int> GetEnumerator() => new Enumerator(from);

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

    private sealed class Enumerator : IEnumerator<int>
    {
        private readonly int from;
        private int current;

        public Enumerator(int from)
        {
            this.from = from;
            current = from + 1;
        }

        public int Current => current;

        object IEnumerator.Current => Current;

        public bool MoveNext() => --current >= 0;

        public void Reset() => current = from + 1;

        public void Dispose() => Disposed++;
    }
}

public sealed class Resource : IDisposable
{
    public static string Log = "";
    private readonly string name;

    public Resource(string name)
    {
        this.name = name;
    }

    public void Dispose() => Log += name + ";";
}

public static class Enumerables
{
    private static int Sum(IEnumerable<int> values)
    {
        int sum = 0;
        foreach (int value in values)
        {
            sum = sum * 31 + value;
        }

        return sum;
    }

    private static string Join<T>(IEnumerable<T> values)
    {
        string text = "";
        foreach (T value in values)
        {
            text += value + ",";
        }

        return text;
    }

    public static int Sources(int x)
    {
        var list = new List<int> { x, 2, 3 };
        var set = new HashSet<int> { 5, x, 7 };
        var queue = new Queue<int>();
        queue.Enqueue(x);
        queue.Enqueue(9);
        var stack = new Stack<int>();
        stack.Push(x);
        stack.Push(11);
        var dictionary = new Dictionary<int, int> { [1] = x, [2] = 20 };
        return Sum(new[] { 1, x, 3 })
            + Sum(list) * 3
            + Sum(set) * 5
            + Sum(queue) * 7
            + Sum(stack) * 11
            + Sum(dictionary.Keys) * 13
            + Sum(dictionary.Values) * 17
            + Sum(new Countdown(Math.Abs(x) % 20)) * 19
            + Sum(Array.Empty<int>());
    }

    private static string Text(int x)
    {
        var dictionary = new Dictionary<string, int> { ["a"] = x, ["b"] = 2 };
        return Join("hi" + x) + "|" + Join(new[] { "p", "q" }) + "|" + Join(new List<double> { 0.5, x })
            + "|" + Join(dictionary) + "|" + Join(dictionary.Keys);
    }

    public static int Manual(int x)
    {
        IEnumerable<int> values = new Countdown(Math.Abs(x) % 10);
        int sum = 0;
        using (IEnumerator<int> enumerator = values.GetEnumerator())
        {
            while (enumerator.MoveNext())
            {
                sum = sum * 3 + enumerator.Current;
            }

            enumerator.Reset();
            if (enumerator.MoveNext())
            {
                sum += 1000 * enumerator.Current;
            }
        }

        IEnumerable<int> list = new List<int> { x, x + 1 };
        IEnumerator untyped = list.GetEnumerator();
        while (untyped.MoveNext())
        {
            sum += (int)untyped.Current!;
        }

        untyped.Reset();
        untyped.MoveNext();
        return sum * 7 + (int)untyped.Current! + Countdown.Disposed;
    }

    public static int Tests(int x)
    {
        object[] values = [new int[] { x }, "text", new List<int>(), new Countdown(x), x, new string[] { "a" }];
        int result = 0;
        foreach (object value in values)
        {
            result = result * 2 + (value is IEnumerable<int> ? 1 : 0);
            result = result * 2 + (value is IEnumerable<char> ? 1 : 0);
            result = result * 2 + (value is IDisposable ? 1 : 0);
        }

        return result;
    }

    private static string Dispose(int x)
    {
        Resource.Log = "";
        IDisposable first = new Resource("a" + x);
        using (first)
        {
            using IDisposable second = new Resource("b");
            if (x > 2)
            {
                return Resource.Log + "early";
            }
        }

        return Resource.Log;
    }

    public static int Strings(int x) => Digest(Text(x));

    public static int Disposing(int x) => Digest(Dispose(x));

    public static int DisposingAfter(int x) => Digest(Dispose(x) + "/" + Resource.Log);

    private static int Digest(string text)
    {
        int digest = text.Length;
        foreach (char c in text)
        {
            digest = unchecked(digest * 31 + c);
        }

        return digest;
    }
}
