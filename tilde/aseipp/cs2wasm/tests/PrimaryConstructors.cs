// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.PrimaryConstructors;

public class Counter(int start, int step)
{
    // Read by an initializer and by members: one hidden field each.
    public readonly int First = start * 10;

    public int Next()
    {
        start += step;
        return start;
    }

    public int Current => start;

    public Func<int> Reader() => () => start * 100 + step;

    public void Reset(int value) => start = value;
}

public class Named(string name) : Counter(name.Length, 2)
{
    public string Describe() => name + ":" + Current;

    public string Name => $"<{name}>";
}

public sealed class Pool<T>(int capacity)
{
    private readonly List<T> items = new List<T>();

    public bool Add(T item)
    {
        if (items.Count >= capacity)
        {
            return false;
        }

        items.Add(item);
        return true;
    }

    public int Room => capacity - items.Count;
}

public sealed class Uncaptured(int seed)
{
    public int Value = seed + 1;

    public string Label { get; } = $"seed {seed}";
}

public static class PrimaryConstructors
{
    private static int Digest(string text)
    {
        int digest = text.Length;
        foreach (char c in text)
        {
            digest = digest * 31 + c;
        }

        return digest;
    }

    public static int Counting(int start)
    {
        var counter = new Counter(start, 3);
        var reader = counter.Reader();
        counter.Next();
        counter.Next();
        int read = reader();
        counter.Reset(7);
        return counter.First * 100000 + counter.Current * 1000 + read + reader() * 10000000;
    }

    public static int Inherited(int length)
    {
        var named = new Named(new string('n', length % 5 + 1));
        named.Next();
        return Digest(named.Describe()) * 7 + Digest(named.Name) + named.First;
    }

    public static int Generic(int capacity)
    {
        var pool = new Pool<string>(capacity);
        int added = 0;
        for (int index = 0; index < 5; index++)
        {
            added += pool.Add("item") ? 1 : 0;
        }

        return added * 10 + pool.Room;
    }

    public static int Plain(int seed)
    {
        var value = new Uncaptured(seed);
        return value.Value * 1000 + Digest(value.Label);
    }
}
