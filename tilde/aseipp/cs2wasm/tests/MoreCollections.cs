// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Linq;

namespace Tests.MoreCollections;

public sealed class Job
{
    public readonly string Name;
    public readonly int Cost;

    public Job(string name, int cost)
    {
        Name = name;
        Cost = cost;
    }

    public override string ToString() => Name + Cost;
}

public static class MoreCollections
{
    private static int Digest<T>(IEnumerable<T> values)
    {
        int digest = 17;
        foreach (T value in values)
        {
            string text = value?.ToString() ?? "null";
            digest = unchecked(digest * 31 + text.Length);
            foreach (char c in text)
            {
                digest = unchecked(digest * 31 + c);
            }
        }

        return digest;
    }

    // Ties in priority dequeue in the order .NET's quaternary heap gives.
    public static int Priorities(int x)
    {
        var queue = new PriorityQueue<string, int>();
        for (int i = 0; i < 23; i++)
        {
            queue.Enqueue("e" + i, ((i * 7) ^ x) % 5);
        }

        int digest = Digest(queue.UnorderedItems.Select(item => item.Element + item.Priority));
        var order = new List<string>();
        bool refilled = false;
        order.Add(queue.Dequeue());
        order.Add(queue.EnqueueDequeue("new", 2));
        order.Add(queue.DequeueEnqueue("again", x & 3));
        while (queue.TryDequeue(out string element, out int priority))
        {
            order.Add(element + ":" + priority);
            if (queue.Count == 10 && !refilled)
            {
                refilled = true;
                queue.EnqueueRange(new[] { ("a", 1), ("b", 0), ("c", 1) });
            }
        }

        digest = unchecked(digest * 31 + Digest(order));
        var reversed = new PriorityQueue<Job, int>(Comparer<int>.Create((a, b) => b - a));
        reversed.EnqueueRange(Enumerable.Range(0, 9).Select(i => new Job("j" + i, i % 3)), 1);
        reversed.Enqueue(new Job("top", 9), 9);
        var fromItems = new PriorityQueue<int, int>(Enumerable.Range(0, 12).Select(i => (i, (i * x) % 4)));
        var drained = new List<int>();
        while (fromItems.Count > 0)
        {
            drained.Add(fromItems.Dequeue());
        }

        digest = unchecked(digest * 31 + Digest(drained) + Digest(new[] { reversed.Peek() }) + reversed.Count);
        reversed.Clear();
        return unchecked(digest * 31 + (reversed.TryPeek(out var none, out int _) ? 1 : 0) + (none == null ? 2 : 0));
    }

    public static int Sorted(int x)
    {
        var list = new SortedList<int, string>();
        var dictionary = new SortedDictionary<string, int>(StringComparer.Ordinal);
        var set = new SortedSet<int>();
        for (int i = 0; i < 15; i++)
        {
            int key = (i * 37 + x) % 17;
            list[key] = "v" + i;
            dictionary["k" + key] = i;
            set.Add(key % 9);
        }

        list.Remove(x % 17);
        dictionary.Remove("k3");
        set.Remove(4);
        int digest = Digest(list.Select(pair => pair.Key + "=" + pair.Value)) + list.IndexOfKey(5) + list.GetKeyAtIndex(0);
        digest = unchecked(digest * 31 + Digest(dictionary.Keys) + Digest(dictionary.Values) + dictionary.Count);
        digest = unchecked(digest * 31 + Digest(set) + set.Min * 100 + set.Max + (set.Contains(8) ? 7 : 0));
        var byLength = new SortedSet<string>(new[] { "ccc", "a", "bb", "dd", "a" }, Comparer<string>.Create((a, b) => a.Length - b.Length));
        digest = unchecked(digest * 31 + Digest(byLength));
        set.UnionWith(new[] { 100, -1 });
        set.IntersectWith(new[] { -1, 0, 1, 2, 3, 100 });
        return unchecked(digest * 31 + Digest(set) + (list.TryGetValue(x % 17, out string missing) ? 1 : 0) + (missing == null ? 2 : 0));
    }

    // SortedList's and SortedDictionary's Keys and Values: live views,
    // indexed, searched and copied.
    public static int Views(int x)
    {
        var list = new SortedList<int, string>();
        var dictionary = new SortedDictionary<int, int>();
        for (int i = 0; i < 9; i++)
        {
            list[(i * 5 + x) & 15] = "s" + i;
            dictionary[(i * 3 - x) & 7] = i;
        }

        var keys = list.Keys;
        var values = list.Values;
        int digest = keys.Count * 1000 + keys[0] * 100 + keys[keys.Count - 1] + keys.IndexOf(x & 15) * 7 + (keys.Contains(3) ? 1 : 0);
        digest = unchecked(digest * 31 + values.IndexOf("s4") + (values.Contains("s9") ? 1 : 0) + values[1].Length);
        list[99] = "late";
        digest = unchecked(digest * 31 + keys.Count + Digest(values));
        int[] copied = new int[dictionary.Count + 2];
        dictionary.Keys.CopyTo(copied, 1);
        digest = unchecked(digest * 31 + Digest(copied) + dictionary.Values.Count + dictionary.Keys.Count);
        try
        {
            return unchecked(digest * 31 + keys[x & 31]);
        }
        catch (ArgumentOutOfRangeException)
        {
            return unchecked(digest * 31 + 1);
        }
    }

    public static int Linked(int x)
    {
        var list = new LinkedList<int>(new[] { 1, 2, 3 });
        var first = list.First;
        list.AddFirst(0);
        list.AddAfter(first, 10 + x);
        list.AddBefore(list.Last, 20);
        var node = new LinkedListNode<int>(99);
        list.AddLast(node);
        list.Remove(2);
        list.RemoveFirst();
        int digest = Digest(list) + list.Count * 100 + (list.Contains(20) ? 1 : 0);
        digest = unchecked(digest * 31 + (list.Find(20)?.Next?.Value ?? -1) + (list.FindLast(99)?.Previous?.Value ?? -1));
        digest = unchecked(digest * 31 + (node.List == list ? 1 : 0) + (list.First.Previous == null ? 2 : 0) + (list.Last.Next == null ? 4 : 0));
        list.Remove(node);
        digest = unchecked(digest * 31 + (node.List == null ? 1 : 0) + list.Last.Value);
        return digest;
    }

    public static int Faults(int which)
    {
        var queue = new PriorityQueue<int, int>();
        var sorted = new SortedList<int, int> { [1] = 1 };
        var linked = new LinkedList<int>();
        var other = new LinkedList<int>(new[] { 1 });
        switch (which)
        {
            case 0:
                return queue.Dequeue();
            case 1:
                return queue.Peek();
            case 2:
                sorted.Add(1, 2);
                return 0;
            case 3:
                return sorted[2];
            case 4:
                linked.RemoveFirst();
                return 0;
            case 5:
                linked.AddAfter(other.First, 3);
                return 0;
            case 6:
                foreach (var pair in sorted)
                {
                    sorted[5] = 5;
                }

                return 0;
            case 7:
                return new SortedDictionary<string, int>(StringComparer.Ordinal)[null];
            default:
                return new PriorityQueue<int, int>(-1).Count;
        }
    }
}
