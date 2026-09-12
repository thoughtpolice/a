// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Combinations;

// A generic struct with a generic method, a nested struct and an interface.
public struct Slot<T> : IMeasured
{
    public T Item;
    public int Uses;
    public Range Span;

    public Slot(T item)
    {
        Item = item;
        Uses = 0;
        Span = new Range { Low = 0, High = 1 };
    }

    public T Take()
    {
        Uses++;
        Span.Widen(1);
        return Item;
    }

    public readonly TResult Map<TResult>(Func<T, TResult> map) => map(Item);

    public readonly int Measure() => Uses * 100 + Span.Length;

    int IMeasured.Explicit() => Uses + 1000;
}

public struct Range
{
    public int Low;
    public int High;

    public readonly int Length => High - Low;

    public void Widen(int by)
    {
        Low -= by;
        High += by;
    }
}

public interface IMeasured
{
    int Measure();

    int Explicit();
}

public static class Registry<T>
{
    public static List<T> Items = new List<T>();
    public static int Version;

    public static void Add(T item)
    {
        Items.Add(item);
        Version++;
    }

    public static class Nested<TKey>
    {
        public static Dictionary<TKey, T> ByKey = new Dictionary<TKey, T>();
    }
}

public sealed class Inventory
{
    private readonly Dictionary<int, List<Range>> byKind = new Dictionary<int, List<Range>>();
    private readonly Queue<Slot<int>> pending = new Queue<Slot<int>>();

    public void Add(int kind, int low, int high)
    {
        if (!byKind.TryGetValue(kind, out var list))
        {
            list = new List<Range>();
            byKind[kind] = list;
        }

        list.Add(new Range { Low = low, High = high });
        pending.Enqueue(new Slot<int>(kind));
    }

    public int Total()
    {
        int total = 0;
        foreach (var pair in byKind)
        {
            foreach (var range in pair.Value)
            {
                total += pair.Key * range.Length;
            }
        }

        while (pending.Count > 0)
        {
            var slot = pending.Dequeue();
            total += slot.Take() + slot.Measure();
        }

        return total;
    }
}

public static class Combinations
{
    private static int Measure<T>(T value)
        where T : IMeasured => value.Measure() * 10 + value.Explicit();

    private static int MeasureAll<T>(List<T> values)
        where T : IMeasured
    {
        int total = 0;
        foreach (var value in values)
        {
            total += value.Measure();
        }

        return total;
    }

    public static int GenericStructs(int value)
    {
        var slot = new Slot<long>(value);
        long taken = slot.Take() + slot.Take();
        var mapped = slot.Map(item => item * 3);
        var slots = new List<Slot<long>> { slot, new Slot<long>(2) };
        var copy = slots[0];
        copy.Take();
        return (int)taken * 1000 + (int)mapped + Measure(slot) * 100000 + MeasureAll(slots) + copy.Uses * 7;
    }

    public static int NestedCollections(int count)
    {
        var grid = new List<List<int>>();
        for (int row = 0; row < count; row++)
        {
            grid.Add(new List<int>());
            for (int column = 0; column <= row; column++)
            {
                grid[row].Add(row * column);
            }
        }

        var index = new Dictionary<Range, List<int>>();
        foreach (var row in grid)
        {
            var key = new Range { Low = row.Count % 3, High = 5 };
            if (!index.ContainsKey(key))
            {
                index[key] = new List<int>();
            }

            index[key].Add(row.Count);
        }

        int total = 0;
        foreach (var pair in index)
        {
            total = total * 31 + pair.Key.Low * 100 + pair.Value.Count;
        }

        return total;
    }

    public static int GenericStatics(int value)
    {
        Registry<int>.Add(value);
        Registry<int>.Add(value * 2);
        Registry<Range>.Add(new Range { High = value });
        Registry<int>.Nested<long>.ByKey[value] = value + 1;
        Registry<Range>.Nested<int>.ByKey[1] = new Range { Low = -value };
        return Registry<int>.Version * 1000 + Registry<Range>.Version * 100 + Registry<int>.Items.Count * 10
            + Registry<int>.Nested<long>.ByKey.Count + Registry<Range>.Nested<int>.ByKey[1].Low;
    }

    public static int Inventory(int count)
    {
        var inventory = new Inventory();
        for (int index = 0; index < count; index++)
        {
            inventory.Add(index % 3, -index, index * 2);
        }

        return inventory.Total();
    }

    public static int StructsInClosuresAndCollections(int value)
    {
        var ranges = new List<Range>();
        var current = new Range { High = value };
        Action grow = () =>
        {
            current.Widen(1);
            ranges.Add(current);
        };
        grow();
        grow();
        current.Low = 100;
        grow();
        int total = 0;
        foreach (var range in ranges)
        {
            total = total * 10 + range.Length;
        }

        var set = new HashSet<Range>();
        ranges.ForEach(range => set.Add(range));
        return total * 100 + set.Count + ranges[0].Low;
    }

    public static int ExceptionsInGenericCode(int value)
    {
        var lookups = new Dictionary<int, Slot<int>>();
        lookups[1] = new Slot<int>(value);
        int found = 0;
        foreach (int key in new[] { 1, 2 })
        {
            try
            {
                var slot = lookups[key];
                found += slot.Take();
            }
            catch (KeyNotFoundException)
            {
                found += 1000;
            }
            finally
            {
                found *= 2;
            }
        }

        return found;
    }

    public static int EnumeratorOverStructs(int count)
    {
        var stack = new Stack<Slot<Range>>();
        for (int index = 0; index < count; index++)
        {
            stack.Push(new Slot<Range>(new Range { High = index }));
        }

        int total = 0;
        foreach (var slot in stack)
        {
            var copy = slot;
            copy.Take();
            total = total * 3 + copy.Measure() + slot.Measure() + slot.Item.Length;
        }

        return total;
    }
}
