// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.CollectionTypes;

public sealed class Entity
{
    public int Id;

    public Entity(int id) => Id = id;
}

public interface ITagged
{
    int Tag { get; }
}

public class Unit : ITagged
{
    public int Tag { get; set; }
}

public struct Cell
{
    public int X;
    public int Y;

    public Cell(int x, int y)
    {
        X = x;
        Y = y;
    }
}

public struct Weighted
{
    public float Weight;
    public Entity Owner;
}

// A two-dimensional indexer, and an enumerator that is a class.
public sealed class Grid
{
    private readonly int[] cells;
    private readonly int width;

    public Grid(int width, int height)
    {
        this.width = width;
        cells = new int[width * height];
    }

    public int this[int x, int y]
    {
        get => cells[y * width + x];
        set => cells[y * width + x] = value;
    }

    public Walker GetEnumerator() => new Walker(this);

    public sealed class Walker
    {
        private readonly Grid grid;
        private int index = -1;

        public Walker(Grid grid) => this.grid = grid;

        public bool MoveNext() => ++index < grid.cells.Length;

        public int Current => grid.cells[index];
    }
}

// An indexer on a struct, which mutates it in place.
public struct Pair
{
    private int first;
    private int second;

    public int this[int index]
    {
        readonly get => index == 0 ? first : second;
        set
        {
            if (index == 0)
            {
                first = value;
            }
            else
            {
                second = value;
            }
        }
    }
}

// Runs of adds and removes, each summarized as one number, so the CLR and
// Wasm runs can be compared call by call.
// A sequence of 0 to count - 1 whose enumerators count how many of them
// are open and how many were disposed.
public sealed class Counted : IEnumerable<int>
{
    private readonly int count;

    public Counted(int count) => this.count = count;

    public int Open { get; set; }

    public int Disposed { get; set; }

    public IEnumerator<int> GetEnumerator()
    {
        Open++;
        return new Walker(this);
    }

    System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();

    private sealed class Walker : IEnumerator<int>
    {
        private readonly Counted owner;
        private int index = -1;

        public Walker(Counted owner) => this.owner = owner;

        public int Current => index;

        object System.Collections.IEnumerator.Current => index;

        public bool MoveNext() => ++index < owner.count;

        public void Reset() => index = -1;

        public void Dispose()
        {
            owner.Open--;
            owner.Disposed++;
        }
    }
}

public static class Collections
{
    // Digits of a sequence, most significant first, wrapping like an int.
    private static int Digest(int digest, int value) => unchecked(digest * 31 + value);

    public static int ListBasics(int count)
    {
        var list = new List<int>();
        for (int index = 0; index < count; index++)
        {
            list.Add(index * 3);
        }

        list.Insert(0, -1);
        list.Insert(list.Count, 99);
        list.Remove(3);
        list.Remove(1000);
        if (list.Count > 2)
        {
            list.RemoveAt(1);
            list[1] = 42;
        }

        int digest = list.Count * 1000 + list.Capacity;
        for (int index = 0; index < list.Count; index++)
        {
            digest = Digest(digest, list[index]);
        }

        return Digest(digest, list.IndexOf(42) * 10 + (list.Contains(99) ? 1 : 0));
    }

    public static int ListForeach(int count)
    {
        var list = new List<long> { 5, 7 };
        for (int index = 0; index < count; index++)
        {
            list.Add(index);
        }

        long total = 0;
        foreach (long value in list)
        {
            total = total * 3 + value;
        }

        foreach (int narrow in new List<long> { 1, 2 })
        {
            total += narrow;
        }

        return (int)total;
    }

    public static int ListModifiedWhileEnumerating(int mode)
    {
        var list = new List<int> { 1, 2, 3 };
        int seen = 0;
        foreach (int value in list)
        {
            seen += value;
            if (value == 2)
            {
                switch (mode)
                {
                    case 0:
                        list.Add(4);
                        break;
                    case 1:
                        list[0] = 10;
                        break;
                    case 2:
                        list.RemoveAt(0);
                        break;
                    case 3:
                        list.Clear();
                        break;
                    default:
                        seen += list.Count;
                        break;
                }
            }
        }

        return seen;
    }

    public static int ListFaults(int mode)
    {
        var list = new List<int> { 1, 2 };
        return mode switch
        {
            0 => list[2],
            1 => list[-1],
            2 => RemoveAt(list, 5),
            3 => Insert(list, 3),
            4 => new List<int>(-1).Count,
            _ => list[1],
        };
    }

    private static int RemoveAt(List<int> list, int index)
    {
        list.RemoveAt(index);
        return list.Count;
    }

    private static int Insert(List<int> list, int index)
    {
        list.Insert(index, 0);
        return list.Count;
    }

    public static int ListGrowth(int count)
    {
        var list = new List<int>(2);
        int digest = list.Capacity;
        for (int index = 0; index < count; index++)
        {
            list.Add(index);
            digest = Digest(digest, list.Capacity);
        }

        list.Capacity = count + 3;
        return Digest(digest, list.Capacity);
    }

    public static int ListPredicates(int threshold)
    {
        var list = new List<int> { 5, 1, 8, 3, 9, 2 };
        int found = list.Find(value => value > threshold);
        int index = list.FindIndex(value => value > threshold);
        bool exists = list.Exists(value => value == threshold);
        bool all = list.TrueForAll(value => value < 10);
        int removed = list.RemoveAll(value => value % 2 == 0);
        int sum = 0;
        list.ForEach(value => sum = sum * 10 + value);
        list.Reverse();
        var array = list.ToArray();
        return Digest(Digest(Digest(found * 100 + index, exists ? 1 : 0), all ? removed : -removed), sum) + array[0];
    }

    public static int ListForEachModified()
    {
        var list = new List<int> { 1, 2, 3 };
        int calls = 0;
        list.ForEach(value =>
        {
            calls++;
            if (value == 2)
            {
                list.Add(4);
            }
        });
        return calls;
    }

    public static int ListOfStructs(int count)
    {
        var cells = new List<Cell>();
        for (int index = 0; index < count; index++)
        {
            cells.Add(new Cell(index, index * index));
        }

        var first = cells[0];
        first.X = 100;
        int digest = cells.IndexOf(new Cell(1, 1)) * 1000 + (cells.Contains(new Cell(2, 5)) ? 1 : 0);
        cells.Remove(new Cell(0, 0));
        foreach (var cell in cells)
        {
            digest = Digest(digest, cell.X * 10 + cell.Y);
        }

        return digest + first.X;
    }

    public static int ListOfReferences(int count)
    {
        var entities = new List<Entity>();
        var keep = new Entity(-1);
        for (int index = 0; index < count; index++)
        {
            entities.Add(new Entity(index));
        }

        entities.Add(keep);
        entities.Add(null);
        int digest = entities.IndexOf(keep) * 100 + entities.IndexOf(null) + (entities.Contains(new Entity(0)) ? 7 : 0);
        entities.Remove(keep);
        return Digest(digest, entities.Count);
    }

    public static int FloatEquality(int mode)
    {
        var list = new List<double> { 1.5, double.NaN, -0.0 };
        return mode switch
        {
            0 => list.IndexOf(double.NaN),
            1 => list.IndexOf(0.0),
            2 => list.Contains(1.5) ? 1 : 0,
            _ => new List<float> { float.NaN }.IndexOf(float.NaN),
        };
    }

    // A sequence of adds and removes, then the enumeration order of keys
    // and values, which the free list decides.
    public static int DictionaryOrder(int seed)
    {
        var dictionary = new Dictionary<int, int>();
        int state = seed;
        for (int step = 0; step < 40; step++)
        {
            state = unchecked(state * 1103515245 + 12345);
            int key = (state >> 16) & 15;
            if ((state & 3) == 0)
            {
                dictionary.Remove(key);
            }
            else
            {
                dictionary[key] = step;
            }
        }

        int digest = dictionary.Count;
        foreach (var pair in dictionary)
        {
            digest = Digest(digest, pair.Key * 100 + pair.Value);
        }

        foreach (int key in dictionary.Keys)
        {
            digest = Digest(digest, key);
        }

        foreach (int value in dictionary.Values)
        {
            digest = Digest(digest, value);
        }

        return Digest(digest, dictionary.Keys.Count + dictionary.Values.Count);
    }

    public static int DictionaryBasics(int key)
    {
        var dictionary = new Dictionary<int, int[]>();
        var scores = new Dictionary<int, long> { { 1, 10 }, { 2, 20 }, { 3, 30 } };
        scores[2] += 5;
        bool added = scores.TryAdd(4, 40);
        bool again = scores.TryAdd(4, 41);
        bool found = scores.TryGetValue(key, out long value);
        bool removed = scores.Remove(1, out long old);
        int digest = (added ? 1 : 0) + (again ? 2 : 0) + (found ? 4 : 0) + (removed ? 8 : 0);
        digest = Digest(digest, (int)value);
        digest = Digest(digest, (int)old);
        digest = Digest(digest, scores.ContainsKey(1) ? 1 : 0);
        digest = Digest(digest, scores.ContainsValue(40) ? 1 : 0);
        digest = Digest(digest, dictionary.Count);
        scores.Clear();
        scores[9] = 9;
        foreach (var pair in scores)
        {
            digest = Digest(digest, pair.Key + (int)pair.Value);
        }

        return digest;
    }

    public static int DictionaryFaults(int mode)
    {
        var dictionary = new Dictionary<int, int> { [1] = 1 };
        var entities = new Dictionary<Entity, int>();
        switch (mode)
        {
            case 0:
                return dictionary[2];
            case 1:
                dictionary.Add(1, 5);
                return 0;
            case 2:
                entities.Add(null, 1);
                return 0;
            case 3:
                return entities.ContainsKey(null) ? 1 : 0;
            case 4:
                return new Dictionary<int, int>(-1).Count;
            default:
                return dictionary[1];
        }
    }

    public static int DictionaryModifiedWhileEnumerating(int mode)
    {
        var dictionary = new Dictionary<int, int> { [1] = 1, [2] = 2, [3] = 3 };
        int seen = 0;
        foreach (var pair in dictionary)
        {
            seen += pair.Value;
            if (pair.Key == 2)
            {
                switch (mode)
                {
                    case 0:
                        dictionary[4] = 4;
                        break;
                    case 1:
                        dictionary[1] = 10;
                        break;
                    case 2:
                        dictionary.Remove(3);
                        break;
                    case 3:
                        dictionary.Remove(1);
                        break;
                    case 4:
                        dictionary.Clear();
                        break;
                    case 5:
                        dictionary.TryAdd(1, 7);
                        break;
                    default:
                        seen += dictionary.Count;
                        break;
                }
            }
        }

        return seen;
    }

    public static int KeysModifiedWhileEnumerating(int mode)
    {
        var dictionary = new Dictionary<int, int> { [1] = 1, [2] = 2 };
        int seen = 0;
        foreach (int key in dictionary.Keys)
        {
            seen += key;
            if (mode == 0)
            {
                dictionary[key + 10] = 0;
            }
        }

        foreach (int value in dictionary.Values)
        {
            seen += value;
            if (mode == 1)
            {
                dictionary.Remove(1);
            }
        }

        return seen;
    }

    public static int ReferenceKeys(int count)
    {
        var entities = new List<Entity>();
        var positions = new Dictionary<Entity, int>();
        for (int index = 0; index < count; index++)
        {
            var entity = new Entity(index);
            entities.Add(entity);
            positions[entity] = index * 10;
        }

        positions.Remove(entities[count / 2]);
        positions[new Entity(0)] = -1;
        int digest = positions.Count;
        foreach (var pair in positions)
        {
            digest = Digest(digest, pair.Key.Id * 1000 + pair.Value);
        }

        return Digest(digest, positions.ContainsKey(entities[0]) ? positions[entities[0]] + 1 : -2);
    }

    public static int InterfaceKeys(int count)
    {
        var tagged = new HashSet<ITagged>();
        ITagged first = null;
        for (int index = 0; index < count; index++)
        {
            var unit = new Unit { Tag = index };
            if (first == null)
            {
                first = unit;
            }

            tagged.Add(unit);
            tagged.Add(unit);
        }

        int digest = tagged.Count;
        foreach (var item in tagged)
        {
            digest = Digest(digest, item.Tag);
        }

        return Digest(digest, tagged.Contains(first) ? 1 : 0);
    }

    public static int StructKeys(int count)
    {
        var owner = new Entity(5);
        var visited = new HashSet<Cell>();
        var weights = new Dictionary<Weighted, int>();
        for (int index = 0; index < count; index++)
        {
            visited.Add(new Cell(index % 4, index % 3));
            weights[new Weighted { Weight = index % 2 == 0 ? 0.0f : -0.0f, Owner = owner }] = index;
        }

        weights[new Weighted { Weight = float.NaN }] = 1;
        weights[new Weighted { Weight = float.NaN }] = 2;
        int digest = visited.Count * 100 + weights.Count;
        foreach (var cell in visited)
        {
            digest = Digest(digest, cell.X * 10 + cell.Y);
        }

        return Digest(digest, visited.Contains(new Cell(1, 1)) ? weights[new Weighted { Weight = float.NaN }] : -1);
    }

    public static int HashSetOrder(int seed)
    {
        var set = new HashSet<long>();
        int state = seed;
        int digest = 0;
        for (int step = 0; step < 50; step++)
        {
            state = unchecked(state * 1103515245 + 12345);
            long item = (state >> 16) & 31;
            if ((state & 3) == 0)
            {
                digest = Digest(digest, set.Remove(item) ? 1 : 0);
            }
            else
            {
                digest = Digest(digest, set.Add(item) ? 1 : 0);
            }
        }

        foreach (long item in set)
        {
            digest = Digest(digest, (int)item);
        }

        return Digest(digest, set.Count);
    }

    public static int HashSetModifiedWhileEnumerating(int mode)
    {
        var set = new HashSet<int> { 1, 2, 3 };
        int seen = 0;
        foreach (int item in set)
        {
            seen += item;
            if (item == 2)
            {
                switch (mode)
                {
                    case 0:
                        set.Add(4);
                        break;
                    case 1:
                        set.Remove(3);
                        break;
                    case 2:
                        set.Add(2);
                        break;
                    case 3:
                        set.Clear();
                        break;
                    default:
                        seen += set.Count;
                        break;
                }
            }
        }

        return seen;
    }

    public static int NullElements(int mode)
    {
        var set = new HashSet<Entity> { null };
        var entity = new Entity(1);
        set.Add(entity);
        return mode switch
        {
            0 => set.Contains(null) ? 1 : 0,
            1 => set.Remove(null) ? set.Count : -1,
            _ => set.Add(null) ? 1 : 0,
        };
    }

    public static int Queues(int count)
    {
        var queue = new Queue<int>();
        int digest = 0;
        for (int index = 0; index < count; index++)
        {
            queue.Enqueue(index);
            if (index % 3 == 2)
            {
                digest = Digest(digest, queue.Dequeue());
            }
        }

        digest = Digest(digest, queue.Count);
        if (queue.TryPeek(out int head))
        {
            digest = Digest(digest, head);
        }

        foreach (int item in queue)
        {
            digest = Digest(digest, item);
        }

        digest = Digest(digest, queue.Contains(count - 1) ? 1 : 0);
        var array = queue.ToArray();
        digest = Digest(digest, array.Length);
        while (queue.TryDequeue(out int item))
        {
            digest = Digest(digest, item);
        }

        return digest;
    }

    public static int Stacks(int count)
    {
        var stack = new Stack<Cell>();
        int digest = 0;
        for (int index = 0; index < count; index++)
        {
            stack.Push(new Cell(index, -index));
            if (index % 4 == 3)
            {
                digest = Digest(digest, stack.Pop().X);
            }
        }

        if (stack.TryPeek(out var top))
        {
            digest = Digest(digest, top.X);
        }

        foreach (var cell in stack)
        {
            digest = Digest(digest, cell.X * 10 + cell.Y);
        }

        digest = Digest(digest, stack.Contains(new Cell(0, 0)) ? 1 : 0);
        var array = stack.ToArray();
        digest = Digest(digest, array.Length == 0 ? -1 : array[0].X);
        stack.Clear();
        return Digest(digest, stack.Count);
    }

    public static int EmptyFaults(int mode)
    {
        var queue = new Queue<int>();
        var stack = new Stack<int>();
        return mode switch
        {
            0 => queue.Dequeue(),
            1 => queue.Peek(),
            2 => stack.Pop(),
            3 => stack.Peek(),
            _ => queue.Count + stack.Count,
        };
    }

    public static int QueueModifiedWhileEnumerating(int mode)
    {
        var queue = new Queue<int>();
        var stack = new Stack<int>();
        for (int index = 1; index <= 3; index++)
        {
            queue.Enqueue(index);
            stack.Push(index);
        }

        int seen = 0;
        if (mode < 2)
        {
            foreach (int item in queue)
            {
                seen += item;
                if (mode == 0 && item == 2)
                {
                    queue.Enqueue(9);
                }
            }
        }
        else
        {
            foreach (int item in stack)
            {
                seen += item;
                if (mode == 2 && item == 2)
                {
                    stack.Pop();
                }
            }
        }

        return seen;
    }

    public static int Indexers(int value)
    {
        var grid = new Grid(3, 2);
        grid[1, 1] = value;
        grid[2, 0] += 5;
        grid[2, 0]++;
        int total = 0;
        foreach (int cell in grid)
        {
            total = total * 7 + cell;
        }

        var pair = new Pair();
        pair[0] = 3;
        pair[1] = value;
        pair[1] *= 2;
        var copy = pair;
        copy[0] = 100;
        return total + pair[0] * 1000 + pair[1] + copy[0] * 100000;
    }

    public static int NullIndexer()
    {
        Grid grid = null;
        grid[0, 0] = 1;
        return 0;
    }

    // Collections as fields and elements, of generic code and of closures.
    public static int Nested(int count)
    {
        var groups = new Dictionary<int, List<Entity>>();
        for (int index = 0; index < count; index++)
        {
            if (!groups.TryGetValue(index % 3, out var group))
            {
                group = new List<Entity>();
                groups.Add(index % 3, group);
            }

            group.Add(new Entity(index));
        }

        int digest = 0;
        foreach (var pair in groups)
        {
            digest = Digest(digest, pair.Key * 100 + pair.Value.Count);
            pair.Value.ForEach(entity => digest = Digest(digest, entity.Id));
        }

        return Digest(digest, Largest(groups).Count);
    }

    private static List<T> Largest<TKey, T>(Dictionary<TKey, List<T>> groups)
    {
        List<T> largest = null;
        foreach (var group in groups.Values)
        {
            if (largest == null || group.Count > largest.Count)
            {
                largest = group;
            }
        }

        return largest ?? new List<T>();
    }

    // A sequence the collections copy from disposes its enumerator once
    // they are done with it, as the BCL's do (an enumerator that ends an
    // iteration when disposed, as a Kiln query's does, relies on it).
    public static int EnumeratorsDisposed(int count)
    {
        var counted = new Counted(count);
        var list = new List<int>(counted);
        list.AddRange(counted);
        list.InsertRange(0, counted);
        var set = new HashSet<int>(counted);
        return counted.Disposed * 1000000 + counted.Open * 10000 + list.Count * 100 + set.Count;
    }
}
