// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the compiler imports from the SDK's framework assemblies rather than
// the gameplay CoreLib (docs/IMPORTER.md, "Framework assemblies"),
// against the CLR: System.Collections' collections, their exceptions and
// messages; System.Linq's operators, where its own IL decides what a
// simpler implementation would not (how often a selector runs, what an
// ICollection's Cast counts, arrays as IList<T>), and its messages.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;

namespace Tests.Framework
{
    public static class Collections
    {
        private static int Digest(string text)
        {
            int digest = 17;
            foreach (char c in text)
            {
                digest = unchecked(digest * 31 + c);
            }

            return unchecked(digest * 31 + text.Length);
        }

        private static int Digest(IEnumerable<int> values)
        {
            int digest = 7;
            foreach (int value in values)
            {
                digest = unchecked(digest * 37 + value);
            }

            return digest;
        }

        // An exception's type and message, as a number.
        private static int Failure(Exception error)
        {
            int kind = error switch
            {
                ArgumentOutOfRangeException => 1,
                ArgumentNullException => 2,
                ArgumentException => 3,
                KeyNotFoundException => 4,
                InvalidOperationException => 5,
                IndexOutOfRangeException => 6,
                _ => 7,
            };
            return unchecked(Digest(error.Message) * 8 + kind);
        }

        public static int Stacks(int which)
        {
            var stack = new Stack<int>();
            for (int value = 0; value < which + 3; value++)
            {
                stack.Push(value * value - which);
            }

            try
            {
                switch (which)
                {
                    case 0:
                        return stack.Pop() * 100 + stack.Peek() * 10 + stack.Count;
                    case 1:
                        return Digest(stack.ToArray()) + (stack.Contains(0) ? 1 : 0);
                    case 2:
                        stack.Clear();
                        return stack.Pop();
                    case 3:
                        stack.Clear();
                        return stack.Peek();
                    case 4:
                        int total = 0;
                        while (stack.TryPop(out int top))
                        {
                            total = total * 3 + top;
                        }

                        return total + (stack.TryPeek(out _) ? 1000 : 0);
                    case 5:
                        var copy = new int[stack.Count + 2];
                        stack.CopyTo(copy, 1);
                        return Digest(copy);
                    case 6:
                        stack.CopyTo(new int[2], 0);
                        return 0;
                    case 7:
                        foreach (int value in stack)
                        {
                            stack.Push(value);
                        }

                        return 0;
                    default:
                        stack.TrimExcess();
                        stack.EnsureCapacity(100);
                        return Digest(stack) + stack.Count;
                }
            }
            catch (Exception error)
            {
                return Failure(error);
            }
        }

        public static int LinkedLists(int which)
        {
            var list = new LinkedList<int>(new[] { 1, 2, 3 });
            try
            {
                switch (which)
                {
                    case 0:
                        list.AddFirst(0);
                        list.AddLast(4);
                        list.AddAfter(list.Find(2)!, 25);
                        list.AddBefore(list.FindLast(3)!, 27);
                        return Digest(list) + list.Count;
                    case 1:
                        list.Remove(2);
                        list.RemoveFirst();
                        list.RemoveLast();
                        return Digest(list) * 10 + list.Count + (list.First == list.Last ? 1000 : 0);
                    case 2:
                        var other = new LinkedList<int>(new[] { 9 });
                        list.AddAfter(other.First!, 5);
                        return 0;
                    case 3:
                        list.AddFirst(list.First!);
                        return 0;
                    case 4:
                        list.Clear();
                        list.RemoveFirst();
                        return 0;
                    case 5:
                        var node = list.First!;
                        int walk = 0;
                        while (node != null)
                        {
                            walk = walk * 10 + node.Value;
                            node.Value *= 2;
                            node = node.Next;
                        }

                        return walk + Digest(list);
                    default:
                        var reversed = new List<int>();
                        for (var at = list.Last; at != null; at = at.Previous)
                        {
                            reversed.Add(at.Value);
                        }

                        return Digest(reversed) + (list.Contains(3) ? 1 : 0) + (list.Contains(7) ? 10 : 0);
                }
            }
            catch (Exception error)
            {
                return Failure(error);
            }
        }

        public static int SortedSets(int which)
        {
            var set = new SortedSet<int> { 5, -3, 12, 7, 0, 7, 44 };
            var other = new[] { 7, 8, 9, -3 };
            try
            {
                switch (which)
                {
                    case 0:
                        return Digest(set) + set.Min * 100 + set.Max;
                    case 1:
                        set.UnionWith(other);
                        return Digest(set);
                    case 2:
                        set.IntersectWith(other);
                        return Digest(set);
                    case 3:
                        set.ExceptWith(other);
                        return Digest(set);
                    case 4:
                        set.SymmetricExceptWith(other);
                        return Digest(set);
                    case 5:
                        return (set.IsSubsetOf(other) ? 1 : 0) + (set.IsSupersetOf(new[] { 7, 0 }) ? 10 : 0)
                               + (set.Overlaps(other) ? 100 : 0) + (set.SetEquals(new[] { 44, 12, 7, 5, 0, -3 }) ? 1000 : 0);
                    case 6:
                        var view = set.GetViewBetween(0, 12);
                        view.Add(3);
                        return Digest(view) * 7 + Digest(set) + view.Count;
                    case 7:
                        set.GetViewBetween(10, 1);
                        return 0;
                    case 8:
                        var view2 = set.GetViewBetween(0, 12);
                        view2.Add(100);
                        return 0;
                    case 9:
                        return Digest(set.Reverse()) + set.RemoveWhere(value => value % 2 == 0) * 1000;
                    default:
                        var descending = new SortedSet<int>(set, Comparer<int>.Create((a, b) => b.CompareTo(a)));
                        return Digest(descending) + (descending.TryGetValue(12, out int found) ? found : -1);
                }
            }
            catch (Exception error)
            {
                return Failure(error);
            }
        }

        public static int SortedMaps(int which)
        {
            var dictionary = new SortedDictionary<int, int> { [3] = 30, [1] = 10, [2] = 20 };
            var list = new SortedList<int, int> { [9] = 90, [7] = 70, [8] = 80 };
            try
            {
                switch (which)
                {
                    case 0:
                        return Digest(dictionary.Keys) * 3 + Digest(dictionary.Values) + Digest(list.Keys) * 5 + Digest(list.Values);
                    case 1:
                        dictionary.Add(2, 0);
                        return 0;
                    case 2:
                        return dictionary[4];
                    case 3:
                        list.Add(8, 0);
                        return 0;
                    case 4:
                        return list[5];
                    case 5:
                        list.RemoveAt(1);
                        return list.IndexOfKey(9) * 100 + list.IndexOfValue(70) * 10 + list.Count;
                    case 6:
                        list.RemoveAt(5);
                        return 0;
                    case 7:
                        return (dictionary.TryGetValue(2, out int two) ? two : -1) + (dictionary.Remove(1) ? 1000 : 0)
                               + (dictionary.ContainsValue(30) ? 10000 : 0) + dictionary.Count;
                    case 8:
                        list.Capacity = 1;
                        return 0;
                    default:
                        list.TrimExcess();
                        return list.Capacity * 100 + list.GetKeyAtIndex(0) + list.GetValueAtIndex(2);
                }
            }
            catch (Exception error)
            {
                return Failure(error);
            }
        }

        public static int PriorityQueues(int which)
        {
            var queue = new PriorityQueue<int, int>();
            foreach (int value in new[] { 5, 1, 4, 1, 9, 2, 6 })
            {
                queue.Enqueue(value * 10, value);
            }

            try
            {
                switch (which)
                {
                    case 0:
                        var drained = new List<int>();
                        while (queue.TryDequeue(out int element, out int priority))
                        {
                            drained.Add(element + priority);
                        }

                        return Digest(drained);
                    case 1:
                        return queue.EnqueueDequeue(0, 0) * 1000 + queue.DequeueEnqueue(70, 7) + queue.Peek() * 100000;
                    case 2:
                        queue.Clear();
                        return queue.Dequeue();
                    case 3:
                        queue.Clear();
                        return queue.Peek();
                    case 4:
                        int unordered = 0;
                        foreach (var (element, priority) in queue.UnorderedItems)
                        {
                            unordered += element * priority;
                        }

                        return unordered + queue.UnorderedItems.Count;
                    case 5:
                        return (queue.Remove(40, out int removed, out int removedPriority) ? removed + removedPriority : -1) + queue.Count * 1000;
                    default:
                        var reversed = new PriorityQueue<string, int>(Comparer<int>.Create((a, b) => b - a));
                        reversed.EnqueueRange(new[] { "a", "b", "c" }, 3);
                        reversed.Enqueue("z", 10);
                        return Digest(reversed.Dequeue() + reversed.Count);
                }
            }
            catch (Exception error)
            {
                return Failure(error);
            }
        }

        public static int OrderedDictionaries(int which)
        {
            var ordered = new OrderedDictionary<string, int> { ["b"] = 2, ["a"] = 1, ["c"] = 3 };
            try
            {
                switch (which)
                {
                    case 0:
                        int walk = 0;
                        foreach (var pair in ordered)
                        {
                            walk = walk * 31 + pair.Key[0] * pair.Value;
                        }

                        return walk + ordered.IndexOf("a") * 1000;
                    case 1:
                        ordered.Insert(1, "d", 4);
                        ordered.SetAt(0, 20);
                        ordered.RemoveAt(2);
                        return Digest(ordered.Values) + Digest(string.Concat(ordered.Keys));
                    case 2:
                        ordered.Add("a", 5);
                        return 0;
                    case 3:
                        return ordered["z"];
                    case 4:
                        var (key, value) = ordered.GetAt(2);
                        return Digest(key) + value;
                    case 5:
                        ordered.GetAt(3);
                        return 0;
                    default:
                        return (ordered.Remove("b", out int removed) ? removed : -1) + (ordered.TryAdd("a", 9) ? 10 : 20)
                               + ordered.Count * 100;
                }
            }
            catch (Exception error)
            {
                return Failure(error);
            }
        }
    }
    public static class Linq
    {
        private static int Digest(IEnumerable<int> values)
        {
            int digest = 7;
            foreach (int value in values)
            {
                digest = unchecked(digest * 37 + value);
            }

            return digest;
        }

        private static int Failure(Exception error)
        {
            int digest = 17;
            foreach (char c in error.Message)
            {
                digest = unchecked(digest * 31 + c);
            }

            int kind = error switch
            {
                ArgumentOutOfRangeException => 1,
                ArgumentNullException => 2,
                ArgumentException => 3,
                InvalidCastException => 4,
                InvalidOperationException => 5,
                NotSupportedException => 6,
                _ => 7,
            };
            return unchecked(digest * 8 + kind);
        }

        // How many times a selector ran: .NET's iterators run it only for
        // the elements an operator needs.
        public static int Selectors(int which)
        {
            int calls = 0;
            int Count(int value)
            {
                calls++;
                return value * 3;
            }

            var list = new List<int> { 5, 1, 4, 2, 3 };
            int[] array = [9, 8, 7, 6];
            int result = which switch
            {
                0 => list.Select(Count).Last(),
                1 => array.Select(Count).ElementAt(2),
                2 => list.Select(Count).Count(),
                3 => array.Select(Count).Skip(1).Take(2).Sum(),
                4 => list.Select(Count).First(),
                5 => Enumerable.Range(3, 5).Select(Count).Last(),
                6 => array.Select(Count).ToList().Count,
                7 => list.Where(value => value > 2).Select(Count).Last(),
                _ => list.Select(Count).Reverse().First(),
            };
            return result * 100 + calls;
        }

        public static int Casts(int which)
        {
            object[] things = [1, "two", 3, null, "x"];
            try
            {
                return which switch
                {
                    0 => things.Cast<string>().Count(),
                    1 => things.OfType<string>().Count() * 10 + things.OfType<int>().Sum(),
                    2 => new List<object> { 1, 2, 5 }.Cast<int>().Sum(),
                    3 => things.Cast<string>().ToList().Count,
                    4 => ((IEnumerable)new[] { 4, 5, 6 }).Cast<int>().Sum(),
                    _ => things.Cast<int>().Skip(3).Count(),
                };
            }
            catch (InvalidCastException)
            {
                // Not its message: the CLR's names the object's type and
                // the target's, which a failed cast here does not say.
                return -1;
            }
            catch (Exception error)
            {
                return Failure(error);
            }
        }

        public static int Lists(int which)
        {
            int[] array = [4, 1, 3, 1, 5, 9, 2, 6];
            IList<int> list = array;
            try
            {
                switch (which)
                {
                    case 0:
                        return list[2] * 100 + list.Count * 10 + list.IndexOf(9) + (list.Contains(7) ? 1000 : 0);
                    case 1:
                        list.Add(3);
                        return 0;
                    case 2:
                        return list[8];
                    case 3:
                        list.Clear();
                        return 0;
                    case 4:
                        var copy = new int[10];
                        list.CopyTo(copy, 1);
                        return Digest(copy);
                    case 5:
                        return Digest(array.Order().Take(^3..)) + Digest(array.Chunk(3).Select(chunk => chunk.Sum()));
                    case 6:
                        return Digest(array.Index().Where(pair => pair.Index % 2 == 0).Select(pair => pair.Item));
                    case 7:
                        IReadOnlyList<int> readOnly = array;
                        return readOnly[readOnly.Count - 1] + (list.IsReadOnly ? 100 : 0);
                    default:
                        return Digest(array.CountBy(value => value % 3).Select(pair => pair.Key * 10 + pair.Value))
                               + Digest(array.AggregateBy(value => value % 2, 0, (sum, value) => sum + value).Select(pair => pair.Value));
                }
            }
            catch (Exception error)
            {
                return Failure(error);
            }
        }

        public static int Faults(int which)
        {
            var empty = new List<int>();
            int[] numbers = [1, 2, 3];
            try
            {
                return which switch
                {
                    0 => empty.First(),
                    1 => numbers.Single(),
                    2 => numbers.ElementAt(5),
                    3 => empty.Max(),
                    4 => numbers.ToDictionary(n => n % 2).Count,
                    5 => numbers.Chunk(0).Count(),
                    6 => Enumerable.Range(0, -1).Count(),
                    7 => numbers.Take(..^5).Count() + numbers.Single(n => n > 1),
                    8 => ((IEnumerable<int>)null!).Count(),
                    _ => (int)empty.Average(),
                };
            }
            catch (Exception error)
            {
                return Failure(error);
            }
        }

        public static int Groups(int which)
        {
            string[] words = ["apple", "avocado", "banana", "blueberry", "cherry", "apricot"];
            switch (which)
            {
                case 0:
                    return Digest(words.GroupBy(word => word[0]).Select(group => group.Key * 100 + group.Count()));
                case 1:
                    var lookup = words.ToLookup(word => word.Length);
                    return lookup.Count * 1000 + lookup[6].Count() * 10 + (lookup.Contains(9) ? 1 : 0) + lookup[42].Count();
                case 2:
                    return Digest(words.OrderBy(word => word.Length).ThenByDescending(word => word[1]).Select(word => word.Length * 100 + word[1]));
                case 3:
                    return Digest(words.Select((word, index) => word.Length + index).Distinct().Order());
                default:
                    return Digest(words.Zip(Enumerable.Range(1, 10), (word, index) => word.Length * index)
                        .Concat(words.Select(word => word.Length).Intersect([5, 6, 7])));
            }
        }
    }
}
