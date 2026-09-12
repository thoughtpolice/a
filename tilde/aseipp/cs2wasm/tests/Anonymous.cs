// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Linq;

namespace Tests.Anonymous;

public static class Anonymous
{
    private static int Digest(string text)
    {
        if (text == null)
        {
            return -1;
        }

        int digest = text.Length;
        foreach (char c in text)
        {
            digest = unchecked(digest * 31 + c);
        }

        return digest;
    }

    private static int Pairs<T>(T[] items)
    {
        var pairs = items.Select((item, index) => new { item, index });
        return pairs.Count(pair => pair.index % 2 == 0) * 100 + Digest(string.Join("|", pairs));
    }

    public static int Members(int x)
    {
        var point = new { X = x, Y = x * 2 };
        var same = new { X = x, Y = x * 2 };
        var other = new { X = x, Z = x * 2 };
        var nested = new { Point = point, Label = "p" + x, Scale = x / 4.0 };
        int digest = point.X * 7 + point.Y + nested.Point.Y * 3;
        digest = unchecked(digest * 31 + (point.Equals(same) ? 1 : 0) + (point.Equals(null) ? 2 : 0)
            + (point.Equals(other) ? 4 : 0) + (ReferenceEquals(point, same) ? 8 : 0));
        digest = unchecked(digest * 31 + Digest(point.ToString()) + Digest(nested.ToString()));
        digest = unchecked(digest * 31 + Digest(new { Text = (string)null, Flag = x > 1, Letter = (char)('a' + (x & 7)) }.ToString()));
        return digest;
    }

    public static int Hashes(int x)
    {
        int digest = new { X = x, Y = x * 2 }.GetHashCode();
        digest = unchecked(digest * 31 + new { A = x }.GetHashCode());
        digest = unchecked(digest * 31 + new { A = (long)x << 33, B = x > 0, C = (byte)x }.GetHashCode());
        digest = unchecked(digest * 31 + new { First = 1, Second = 2, Third = 3, Fourth = x, Fifth = 5, Sixth = 6, Seventh = 7, Eighth = 8 }
            .GetHashCode());
        return digest;
    }

    public static int Collections(int x)
    {
        var seen = new HashSet<object>();
        var counts = new Dictionary<(int, int), int>();
        var keys = new List<int>();
        foreach (int value in new[] { x, 3, x, -1, 3, 4 })
        {
            var key = new { Value = value, Odd = (value & 1) != 0 };
            keys.Add(key.Value);
            seen.Add(key);
            counts[(key.Value, key.Odd ? 1 : 0)] = counts.TryGetValue((key.Value, key.Odd ? 1 : 0), out int count) ? count + 1 : 1;
        }

        var distinct = keys.Select(k => new { k, square = k * k }).Distinct().ToList();
        int digest = seen.Count * 100 + distinct.Count;
        foreach (var group in keys.GroupBy(k => new { Sign = Math.Sign(k), Big = k > 3 }))
        {
            digest = unchecked(digest * 31 + group.Key.Sign * 3 + (group.Key.Big ? 1 : 0) + group.Count() * 7);
        }

        return unchecked(digest * 31 + Pairs(new[] { x, 2, 3 }) + Pairs(new[] { "a", "b" + x }) + counts.Count);
    }

    private static string order = "";

    private static int Note(string what, int value)
    {
        order += what;
        return value;
    }

    public static int Shapes(int x)
    {
        var empty = new { };
        var other = new { };
        var wide = new { A = x, B = 2, C = 3, D = 4, E = 5, F = 6, G = 7, H = 8, I = 9, J = x * 2, K = "k" };
        var wider = new { A = x, B = 2, C = 3, D = 4, E = 5, F = 6, G = 7, H = 8, I = 9, J = x * 2, K = "k" };
        int digest = Digest(empty.ToString()) + empty.GetHashCode() + (empty.Equals(other) ? 1 : 0);
        digest = unchecked(digest * 31 + Digest(wide.ToString()) + wide.J + (wide.Equals(wider) ? 7 : 0));
        digest = unchecked(digest * 31 + new { A = x, B = 2, C = 3, D = 4, E = 5, F = 6, G = 7, H = 8, I = 9, J = x }.GetHashCode());
        order = "";
        var point = new { X = Note("x", x), Y = Note("y", 2), Name = "p" };
        var moved = point with { Y = Note("b", 10), X = Note("a", point.X + 1) };
        var same = point with { };
        digest = unchecked(digest * 31 + Digest(moved.ToString()) + Digest(order) + (same.Equals(point) ? 3 : 0));
        var renamed = wide with { K = "z", A = 0 };
        return unchecked(digest * 31 + Digest(renamed.ToString()) + (ReferenceEquals(same, point) ? 100 : 0));
    }

    public static int Queries(int x)
    {
        var words = new[] { "apple", "bob", "cat" + x, "axe", "banana" };
        var lengths = from word in words
                      let length = word.Length
                      where length > 2
                      orderby length descending, word[0]
                      select new { word, length, first = word[0] };
        int digest = 0;
        foreach (var item in lengths)
        {
            digest = unchecked(digest * 31 + item.length * 3 + item.first + Digest(item.word));
        }

        var pairs = from a in Enumerable.Range(0, 5)
                    from b in Enumerable.Range(0, a)
                    where (a + b) % 2 == Math.Abs(x) % 2
                    select new { a, b, sum = a + b };
        foreach (var pair in pairs.OrderBy(p => p.sum).ThenByDescending(p => p.a))
        {
            digest = unchecked(digest * 7 + pair.a * 10 + pair.b);
        }

        return unchecked(digest * 31 + Digest(string.Join(";", pairs.Take(3))));
    }
}
