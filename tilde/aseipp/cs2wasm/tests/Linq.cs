// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Linq;

namespace Tests.Linq;

public enum Suit
{
    Clubs,
    Hearts,
    Spades,
}

public sealed class Card
{
    public Card(int rank, Suit suit)
    {
        Rank = rank;
        Suit = suit;
    }

    public int Rank { get; }

    public Suit Suit { get; }

    public override string ToString() => Rank + "" + Suit.ToString()[0];
}

public static class Linq
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

    private static int[] Numbers(int x) => [x, 3, -4, x * 2, 7, 3, 0, x % 5, 12, -x];

    private static List<Card> Deck(int x)
    {
        var cards = new List<Card>();
        for (int i = 0; i < 12; i++)
        {
            cards.Add(new Card((i * 7 + x) % 13 + 1, (Suit)((i + x) % 3)));
        }

        return cards;
    }

    public static int Filtering(int x)
    {
        var numbers = Numbers(x);
        int digest = Digest(numbers.Where(n => n > 0));
        digest = unchecked(digest * 3 + Digest(numbers.Where((n, i) => i % 2 == 0 || n < 0)));
        digest = unchecked(digest * 3 + Digest(numbers.Select(n => n * n - x)));
        digest = unchecked(digest * 3 + Digest(numbers.Select((n, i) => n + "@" + i)));
        digest = unchecked(digest * 3 + Digest(numbers.SelectMany(n => Enumerable.Repeat(n, Math.Abs(n) % 3))));
        digest = unchecked(digest * 3 + Digest(numbers.Take(x)));
        digest = unchecked(digest * 3 + Digest(numbers.Skip(x)));
        digest = unchecked(digest * 3 + Digest(numbers.TakeWhile(n => n != 7)));
        digest = unchecked(digest * 3 + Digest(numbers.SkipWhile(n => n != 7)));
        digest = unchecked(digest * 3 + Digest(numbers.TakeLast(x)));
        digest = unchecked(digest * 3 + Digest(numbers.SkipLast(x)));
        digest = unchecked(digest * 3 + Digest(numbers.AsEnumerable().Reverse()) + Digest(numbers.Reverse<int>()));
        digest = unchecked(digest * 3 + Digest(numbers.Append(x).Prepend(-x).Concat(numbers)));
        digest = unchecked(digest * 3 + Digest(Enumerable.Range(x, 5).Zip(numbers, (a, b) => a * b)));
        digest = unchecked(digest * 3 + Digest(numbers.Zip(Enumerable.Range(0, 4)).Select(pair => pair.First - pair.Second)));
        digest = unchecked(digest * 3 + Digest(numbers.Chunk(Math.Abs(x) % 4 + 1).Select(chunk => chunk.Sum())));
        digest = unchecked(digest * 3 + Digest(numbers.Where(n => n > 100).DefaultIfEmpty(x)));
        return digest;
    }

    public static int Sets(int x)
    {
        var numbers = Numbers(x);
        var other = new List<int> { 3, 12, x, 100, -4, 3 };
        int digest = Digest(numbers.Distinct());
        digest = unchecked(digest * 3 + Digest(numbers.DistinctBy(n => Math.Abs(n) % 4)));
        digest = unchecked(digest * 3 + Digest(numbers.Union(other)));
        digest = unchecked(digest * 3 + Digest(numbers.Intersect(other)));
        digest = unchecked(digest * 3 + Digest(numbers.Except(other)));
        digest = unchecked(digest * 3 + Digest(new[] { "b", "a" + x, "b", "c" }.Distinct()));
        digest = unchecked(digest * 3 + (numbers.SequenceEqual(numbers.ToList()) ? 1 : 0));
        digest = unchecked(digest * 3 + (numbers.SequenceEqual(other) ? 1 : 0));
        digest = unchecked(digest * 3 + numbers.ToHashSet().Count);
        return digest;
    }

    public static int Ordering(int x)
    {
        var numbers = Numbers(x);
        var deck = Deck(x);
        int digest = Digest(numbers.OrderBy(n => n));
        digest = unchecked(digest * 3 + Digest(numbers.OrderByDescending(n => n % 3)));
        digest = unchecked(digest * 3 + Digest(numbers.Order()));
        digest = unchecked(digest * 3 + Digest(numbers.OrderDescending()));
        digest = unchecked(digest * 3 + Digest(deck.OrderBy(card => card.Suit).ThenByDescending(card => card.Rank)));
        digest = unchecked(digest * 3 + Digest(deck.OrderByDescending(card => card.Rank % 4).ThenBy(card => card.Suit)
            .ThenBy(card => card.Rank)));
        int calls = 0;
        var keyed = numbers.OrderBy(n =>
        {
            calls++;
            return -n;
        });
        digest = unchecked(digest * 3 + Digest(keyed) + calls * 1000);
        digest = unchecked(digest * 3 + Digest(keyed.Take(3)) + calls);
        digest = unchecked(digest * 3 + deck.MinBy(card => card.Rank * 3 + (int)card.Suit)!.Rank);
        digest = unchecked(digest * 3 + deck.MaxBy(card => card.Suit)!.Rank);
        return digest;
    }

    public static int Grouping(int x)
    {
        var deck = Deck(x);
        int digest = 0;
        foreach (var group in deck.GroupBy(card => card.Suit))
        {
            digest = unchecked(digest * 31 + (int)group.Key * 7 + group.Count() + Digest(group));
        }

        foreach (var group in Numbers(x).GroupBy(n => n % 3, n => n * 10))
        {
            digest = unchecked(digest * 31 + group.Key + group.Sum());
        }

        var bySuit = deck.ToDictionary(card => card.Rank * 10 + (int)card.Suit, card => card.Suit);
        digest = unchecked(digest * 31 + bySuit.Count + Digest(bySuit.Keys));
        var byRank = deck.DistinctBy(card => card.Rank).ToDictionary(card => card.Rank);
        return unchecked(digest * 31 + byRank.Count + Digest(byRank.Values));
    }

    public static int Elements(int x)
    {
        var numbers = Numbers(x);
        int digest = numbers.First() + numbers.First(n => n > 5) * 3 + numbers.FirstOrDefault(n => n > 1000) * 5;
        digest = unchecked(digest * 7 + numbers.Last() + numbers.Last(n => n > 5) * 3 + numbers.LastOrDefault(n => n > 1000, -9));
        digest = unchecked(digest * 7 + numbers.ElementAt(Math.Abs(x) % 10) + numbers.ElementAtOrDefault(x + 20));
        digest = unchecked(digest * 7 + numbers.Where(n => n == 7).Single() + numbers.SingleOrDefault(n => n > 1000));
        digest = unchecked(digest * 7 + new int[0].FirstOrDefault() + Enumerable.Empty<int>().LastOrDefault(4));
        digest = unchecked(digest * 7 + (numbers.Any() ? 1 : 0) + (numbers.Any(n => n > 11) ? 2 : 0)
            + (numbers.All(n => n > -100) ? 4 : 0) + (numbers.Contains(x * 2) ? 8 : 0));
        digest = unchecked(digest * 7 + numbers.Count() + numbers.Count(n => n % 2 == 0) * 100 + (int)numbers.LongCount());
        return digest;
    }

    public static int Aggregates(int x)
    {
        var numbers = Numbers(x);
        int digest = numbers.Sum() + numbers.Min() * 3 + numbers.Max() * 5;
        digest = unchecked(digest * 7 + (int)(numbers.Sum(n => (long)n * n) % 1000003));
        digest = unchecked(digest * 7 + numbers.Aggregate((a, b) => a * 3 - b));
        digest = unchecked(digest * 7 + numbers.Aggregate("", (text, n) => text + n).Length);
        digest = unchecked(digest * 7 + numbers.Aggregate(1L, (product, n) => product * (n | 1), product => (int)(product % 1000)));
        digest = unchecked(digest * 7 + numbers.Min(n => -n) + numbers.Max(n => n % 4));
        digest = unchecked(digest * 7 + (int)Deck(x).Select(card => card.Suit).Max());
        return digest;
    }

    public static double Averages(int x)
    {
        var numbers = Numbers(x);
        double[] doubles = [x / 3.0, 1.5, -2.25, double.NaN, x];
        float[] floats = [x / 7f, 0.1f, 0.2f, 1e-8f];
        return numbers.Average() * 1000 + numbers.Average(n => (double)n / 7) + doubles.Take(3).Average()
            + floats.Average() + floats.Sum() + doubles.Where(d => !double.IsNaN(d)).Sum()
            + doubles.Min(d => d * 2) + doubles.Max() + doubles.Skip(2).Min() + floats.Max()
            + (double.IsNaN(doubles.Min()) ? 7 : 0) + numbers.Select(n => (long)n).Average();
    }

    public static int Queries(int x)
    {
        var deck = Deck(x);
        var high = from card in deck
                   where card.Rank > 5
                   orderby card.Rank descending, card.Suit
                   select card.Rank * 10 + (int)card.Suit;
        var grouped = from card in deck
                      group card.Rank by card.Suit into suits
                      orderby suits.Key descending
                      select suits.Sum();
        return unchecked(Digest(high) * 31 + Digest(grouped));
    }

    public static int Deferred(int x)
    {
        var list = new List<int> { 1, 2, 3 };
        int calls = 0;
        var query = list.Where(n =>
        {
            calls++;
            return n % 2 == 1;
        }).Select(n => n * x);
        int before = calls;
        list.Add(5);
        int first = query.Sum();
        list.Add(7);
        int second = query.Count();
        return before * 100000 + calls * 1000 + first * 10 + second;
    }

    public static int Collections(int x)
    {
        var list = new List<int>(Enumerable.Range(x, 4).Where(n => n % 2 != 0));
        list.AddRange(list.Select(n => n * 10).Take(3));
        list.AddRange(new HashSet<int> { x, 1, x });
        var copy = new List<string>(list.Select(n => n.ToString()));
        return unchecked(Digest(list) * 31 + Digest(copy) + list.Count);
    }

    public static int Joins(int x)
    {
        var deck = Deck(x);
        var names = new[] { "clubs", "hearts", "spades" + x };
        var joined = from card in deck
                     join name in names on (int)card.Suit equals name.Length % 3
                     where card.Rank > 3
                     select card.Rank + name;
        int digest = Digest(joined);
        var grouped = from name in names
                      join card in deck on name.Length % 3 equals (int)card.Suit into cards
                      select name + ":" + cards.Count() + ":" + cards.Sum(card => card.Rank);
        digest = unchecked(digest * 31 + Digest(grouped));
        var byLength = names.Join(new[] { "x", "yy", "zzzzz", "abcde" }, n => n.Length % 7, m => m.Length, (n, m) => n + m);
        digest = unchecked(digest * 31 + Digest(byLength));
        var empty = names.Join(new string[0], n => n, m => m, (n, m) => n + m);
        return unchecked(digest * 31 + empty.Count());
    }

    public static int Casts(int x)
    {
        object[] things = [1, "two", x, 3.5, null, "x" + x, new Card(x & 7, Suit.Hearts)];
        int digest = Digest(things.OfType<string>()) + Digest(things.OfType<int>()) * 3 + things.OfType<Card>().Count() * 5;
        var cards = new List<Card> { new Card(1, Suit.Clubs), new Card(2, Suit.Spades) };
        digest = unchecked(digest * 31 + cards.Cast<Card>().Sum(card => card.Rank) + Digest("abc".Cast<char>()));
        var numbers = new[] { x, 2, 3 };
        digest = unchecked(digest * 31 + numbers.Cast<int>().Sum() + numbers.OfType<int>().Count());
        var boxed = new List<object> { 1, 2, x };
        digest = unchecked(digest * 31 + boxed.Cast<int>().Sum());
        try
        {
            digest += things.Cast<string>().Count();
        }
        catch (InvalidCastException)
        {
            digest += 1000;
        }

        return digest;
    }

    public static int Faults(int which)
    {
        var empty = new List<int>();
        int[] numbers = [1, 2, 3];
        switch (which)
        {
            case 0:
                return empty.First();
            case 1:
                return numbers.First(n => n > 10);
            case 2:
                return empty.Max();
            case 3:
                return (int)empty.Average();
            case 4:
                return numbers.Single();
            case 5:
                return numbers.ElementAt(5);
            case 6:
                return new[] { int.MaxValue, 1 }.Sum();
            case 7:
                return Enumerable.Range(0, -1).Count();
            case 8:
                return numbers.Chunk(0).Count();
            case 9:
                return empty.Aggregate((a, b) => a + b);
            case 10:
                return numbers.ToDictionary(n => n % 2).Count;
            case 11:
                return numbers.Single(n => n > 1);
            default:
                IEnumerable<int> none = null;
                return none.Count();
        }
    }
}
