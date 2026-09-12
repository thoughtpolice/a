// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Linq;

namespace Tests.Comparers;

public sealed class Version : IComparable<Version>
{
    public readonly int Major;
    public readonly int Minor;

    public Version(int major, int minor)
    {
        Major = major;
        Minor = minor;
    }

    public static int Calls;

    public int CompareTo(Version other)
    {
        Calls++;
        if (other is null)
        {
            return 1;
        }

        return Major != other.Major ? Major.CompareTo(other.Major) : Minor.CompareTo(other.Minor);
    }

    public override string ToString() => Major + "." + Minor;
}

public struct Money : IComparable<Money>
{
    public int Cents;

    public int CompareTo(Money other) => (Cents / 100).CompareTo(other.Cents / 100);
}

// Equal by value modulo 5, as its own Equals(object) and GetHashCode say:
// EqualityComparer<T>.Default (the CLR's ObjectEqualityComparer), the
// collections and ValueType.Equals of a struct holding one call them.
public struct Residue
{
    public int Value;

    public override bool Equals(object obj) => obj is Residue other && other.Value % 5 == Value % 5;

    public override int GetHashCode() => Value % 5;

    public override string ToString() => "r" + Value;
}

public sealed class Parity
{
    public int Value;

    public override bool Equals(object obj) => obj is Parity other && other.Value % 2 == Value % 2;

    public override int GetHashCode() => Value % 2;

    public override string ToString() => "p" + Value;
}

// A struct without an Equals of its own: ValueType.Equals compares its
// fields by their Equals(object).
public struct Pair
{
    public Residue Left;
    public Parity Right;
}

// Ordered by the last digit through a base class's IComparable<Rank>, which
// is a SubRank's too (IComparable<in T> is contravariant).
public class Rank : IComparable<Rank>
{
    public int Value;

    public int CompareTo(Rank other) => other is null ? 1 : (Value % 10).CompareTo(other.Value % 10);

    public override string ToString() => "k" + Value;
}

public sealed class SubRank : Rank
{
}

public sealed class ByLength : IComparer<string>
{
    public int Calls;

    public int Compare(string x, string y)
    {
        Calls++;
        return (x?.Length ?? -1) - (y?.Length ?? -1);
    }
}

public sealed class ModuloEquality : IEqualityComparer<int>
{
    private readonly int modulus;

    public ModuloEquality(int modulus)
    {
        this.modulus = modulus;
    }

    public bool Equals(int x, int y) => (x - y) % modulus == 0;

    public int GetHashCode(int value) => ((value % modulus) + modulus) % modulus;
}

public interface IGrid
{
    int this[int row, int column] { get; set; }

    string this[string name] { get; }
}

public sealed class Grid : IGrid
{
    private readonly int[] cells = new int[9];

    public int this[int row, int column]
    {
        get => cells[row * 3 + column];
        set => cells[row * 3 + column] = value;
    }

    public string this[string name] => name + cells[4];
}

// The default comparer of a type implementing the non-generic IComparable
// alone (the CLR's ObjectComparer<T>), a class and a struct.
public class Legacy : IComparable
{
    public int Key;

    public virtual int CompareTo(object other) => other is Legacy legacy ? Key.CompareTo(legacy.Key) : 1;
}

public sealed class Reversed : Legacy
{
    public override int CompareTo(object other) => -base.CompareTo(other);
}

public struct LegacyValue : IComparable
{
    public int Key;
    public int Tag;

    public int CompareTo(object other) => other is LegacyValue value ? Key.CompareTo(value.Key) : 1;
}

// Classes re-implementing an interface their base implements: the CLR's
// interface dispatch (and so its default comparers) runs the most derived
// re-implementation, whatever the static type.
public class Plain : IEquatable<Plain>, IComparable<Plain>, IComparable
{
    public int Key;

    public bool Equals(Plain other) => other is not null && other.Key == Key;

    public override bool Equals(object other) => other is Plain plain && Equals(plain);

    public override int GetHashCode() => Key % 3;

    public int CompareTo(Plain other) => other is null ? 1 : Key.CompareTo(other.Key);

    int IComparable.CompareTo(object other) => CompareTo(other as Plain);
}

public class Modular : Plain, IEquatable<Plain>, IComparable<Plain>
{
    public new bool Equals(Plain other) => other is not null && other.Key % 3 == Key % 3;

    public new int CompareTo(Plain other) => other is null ? 1 : -Key.CompareTo(other.Key);
}

public sealed class Inherits : Modular
{
}

public sealed class Again : Modular, IComparable<Plain>
{
    public new int CompareTo(Plain other) => other is null ? 1 : (Key % 5).CompareTo(other.Key % 5);
}

public class OldPlain : IComparable
{
    public int Key;

    public int CompareTo(object other) => other is OldPlain plain ? Key.CompareTo(plain.Key) : 1;
}

public sealed class OldReversed : OldPlain, IComparable
{
    public new int CompareTo(object other) => other is OldPlain plain ? plain.Key.CompareTo(Key) : 1;
}

public interface ITitled
{
    string Title() => "interface";
}

public class Untitled : ITitled
{
}

public class Titled : Untitled, ITitled
{
    public string Title() => "titled";
}

public class Explicit : ITitled
{
    string ITitled.Title() => "explicit";

    public string Title() => "public";
}

public sealed class Relisted : Explicit, ITitled
{
}

public class Box<T> : IEquatable<Box<T>>
{
    public T Value;

    public bool Equals(Box<T> other) => other is not null && EqualityComparer<T>.Default.Equals(Value, other.Value);

    public override bool Equals(object other) => other is Box<T> box && Equals(box);

    public override int GetHashCode() => 0;
}

public sealed class LooseBox<T> : Box<T>, IEquatable<Box<T>>
{
    public new bool Equals(Box<T> other) => other is not null;
}

public static class Comparers
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

    private static string[] Words(int x) => ["pear", "Apple", "fig", "apple", null, "kiwi" + x, "Fig", "banana", "", "PEAR"];

    public static int Ordinal(int x)
    {
        var words = Words(x);
        var sorted = words.ToArray();
        Array.Sort(sorted, StringComparer.Ordinal);
        int digest = Digest(sorted);
        var list = new List<string>(words);
        list.Sort(StringComparer.OrdinalIgnoreCase);
        digest = unchecked(digest * 31 + Digest(list));
        digest = unchecked(digest * 31 + Digest(words.Where(w => w != null).OrderBy(w => w, StringComparer.Ordinal).ThenBy(w => w.Length)));
        digest = unchecked(digest * 31 + Digest(words.OrderByDescending(w => w, StringComparer.OrdinalIgnoreCase)));
        digest = unchecked(digest * 31 + Digest(words.Distinct(StringComparer.OrdinalIgnoreCase)));
        digest = unchecked(digest * 31 + StringComparer.Ordinal.Compare("a", "b" + x) + StringComparer.OrdinalIgnoreCase.Compare("ABC", "abd"));
        digest = unchecked(digest * 31 + (StringComparer.OrdinalIgnoreCase.Equals("Kiwi", "KIWI") ? 1 : 0));
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (string word in words)
        {
            if (word != null)
            {
                counts[word] = counts.TryGetValue(word, out int count) ? count + 1 : 1;
            }
        }

        digest = unchecked(digest * 31 + Digest(counts.Keys) + counts.Count * 1000 + counts["APPLE"]);
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "a", "A", "b" };
        return unchecked(digest * 31 + set.Count + (set.Contains("B") ? 10 : 0));
    }

    public static int Custom(int x)
    {
        var byLength = new ByLength();
        var words = Words(x);
        var list = new List<string>(words);
        list.Sort(byLength);
        int digest = Digest(list) + byLength.Calls * 7;
        digest = unchecked(digest * 31 + list.BinarySearch("xyz", byLength));
        var ordered = words.OrderBy(w => w, byLength).ThenByDescending(w => w?.Length ?? 0).ToList();
        digest = unchecked(digest * 31 + Digest(ordered));
        digest = unchecked(digest * 31 + Digest(words.OrderBy(w => w, Comparer<string>.Create((a, b) => byLength.Compare(b, a)))));
        var numbers = new[] { x, 7, -3, 12, 5, x * 2, 0, 9 };
        var modulo = new ModuloEquality(3);
        digest = unchecked(digest * 31 + Digest(numbers.Distinct(modulo)));
        digest = unchecked(digest * 31 + Digest(numbers.GroupBy(n => n, modulo).Select(g => g.Key * 100 + g.Count())));
        digest = unchecked(digest * 31 + (numbers.Contains(x + 3, modulo) ? 1 : 0) + (numbers.SequenceEqual(numbers.Select(n => n + 3), modulo) ? 2 : 0));
        digest = unchecked(digest * 31 + Digest(numbers.Union(new[] { 1, 2 }, modulo)) + Digest(numbers.Except(new[] { 1 }, modulo)));
        digest = unchecked(digest * 31 + Digest(numbers.Intersect(new[] { 1, 2, 4 }, modulo)));
        var dictionary = numbers.Distinct(modulo).ToDictionary(n => n, n => n * n, modulo);
        digest = unchecked(digest * 31 + dictionary.Count + dictionary[x + 30] + (dictionary.ContainsKey(1) ? 1 : 0));
        var joined = numbers.Join(new[] { 3, 4 }, n => n, m => m, (n, m) => n * 10 + m, modulo);
        digest = unchecked(digest * 31 + Digest(joined));
        var set = numbers.ToHashSet(modulo);
        return unchecked(digest * 31 + set.Count + Comparer<int>.Default.Compare(x, 3) + (EqualityComparer<int>.Default.Equals(x, 3) ? 5 : 0)
            + (EqualityComparer<int>.Create((a, b) => a % 2 == b % 2).Equals(x, 3) ? 50 : 0));
    }

    public static int Comparable(int x)
    {
        Version.Calls = 0;
        var versions = new List<Version>
        {
            new Version(1, x & 3), null, new Version(0, 9), new Version(1, 0), null, new Version(2, -x), new Version(1, 0),
            new Version(x & 1, 5), new Version(3, 1), new Version(0, 0), new Version(1, 2), new Version(2, 2),
            new Version(0, 1), new Version(1, 1), new Version(4, 0), new Version(2, 1), new Version(0, 3),
        };
        var copy = new List<Version>(versions);
        copy.Sort();
        int digest = Digest(copy);
        var array = versions.ToArray();
        Array.Sort(array, 2, 10);
        digest = unchecked(digest * 31 + Digest(array));
        digest = unchecked(digest * 31 + Digest(versions.OrderBy(v => v)) + Digest(versions.OrderByDescending(v => v)));
        digest = unchecked(digest * 31 + (versions.Min()?.ToString().Length ?? -1) + Digest(new[] { versions.Max() }));
        digest = unchecked(digest * 31 + Digest(new[] { versions.MinBy(v => v), versions.MaxBy(v => v) }));
        digest = unchecked(digest * 31 + copy.BinarySearch(new Version(1, 1)));
        digest = unchecked(digest * 31 + Comparer<Version>.Default.Compare(null, versions[0]) + Comparer<Version>.Default.Compare(versions[0], null));
        var money = new[] { new Money { Cents = 250 + x }, new Money { Cents = 199 }, new Money { Cents = 120 }, new Money { Cents = 99 } };
        Array.Sort(money);
        foreach (var m in money)
        {
            digest = unchecked(digest * 7 + m.Cents);
        }

        digest = unchecked(digest * 31 + money.Max().Cents + money.OrderBy(m => m).First().Cents);
        return unchecked(digest * 31 + Version.Calls);
    }

    public static int Lookups(int x)
    {
        var words = Words(x);
        var lookup = words.ToLookup(w => w?.Length ?? -1);
        int digest = lookup.Count * 1000 + Digest(lookup[4]) + Digest(lookup[99]) + (lookup.Contains(-1) ? 1 : 0);
        foreach (var group in lookup)
        {
            digest = unchecked(digest * 31 + group.Key * 7 + Digest(group));
        }

        var byInitial = words.ToLookup(w => w?.Substring(0, Math.Min(1, w.Length)), w => w?.Length ?? 0, StringComparer.OrdinalIgnoreCase);
        foreach (var group in byInitial)
        {
            digest = unchecked(digest * 31 + Digest(new[] { group.Key }) + group.Sum());
        }

        digest = unchecked(digest * 31 + Digest(words.GroupBy(w => w == null ? null : w.ToUpperInvariant(), (key, items) => key + ":" + items.Count())));
        digest = unchecked(digest * 31 + Digest(words.GroupBy(w => w?.Length ?? 0, w => w, (key, items) => key * 10 + items.Count())));
        var grouped = words.GroupJoin(new[] { "APPLE", "fig", "Pear" }, w => w, v => v, (w, matches) => (w ?? "-") + matches.Count(),
            StringComparer.OrdinalIgnoreCase);
        return unchecked(digest * 31 + Digest(grouped));
    }

    public static int HashSets(int x)
    {
        var source = new HashSet<int>();
        for (int i = 0; i < 12; i++)
        {
            source.Add(i * (x | 1));
        }

        source.Remove(3 * (x | 1));
        source.Remove(7 * (x | 1));
        var copy = new HashSet<int>(source);
        copy.Add(100);
        copy.Add(200);
        var fromList = new HashSet<int>(new List<int> { 5, 5, 6, x });
        fromList.Add(-1);
        var viaLinq = source.ToHashSet();
        viaLinq.Add(300);
        var trimmed = new HashSet<int>(new[] { 1, 1, 1, 1, 1, 1, 1, 1, 1, 2 });
        trimmed.Add(9);
        return unchecked(Digest(copy) * 31 + Digest(fromList) * 7 + Digest(viaLinq) * 3 + Digest(trimmed));
    }

    private static bool Same<T>(T left, T right) => EqualityComparer<T>.Default.Equals(left, right);

    private static int Distinct<T>(IEnumerable<T> values) => values.Distinct().Count();

    private static int Order<T>(T left, T right) => Comparer<T>.Default.Compare(left, right);

    // Values whose own Equals(object) and GetHashCode differ from their
    // fields': structs overriding them, alone, in nullables, tuples, pairs
    // and a struct holding them.
    public static int ObjectEquality(int x)
    {
        var a = new Residue { Value = x };
        var b = new Residue { Value = x + 5 };
        var c = new Residue { Value = x + 1 };
        int digest = (Same(a, b) ? 1 : 0) + (Same(a, c) ? 2 : 0) + (EqualityComparer<Residue>.Default.Equals(b, a) ? 4 : 0)
                     + (EqualityComparer<Residue>.Default.GetHashCode(a) == EqualityComparer<Residue>.Default.GetHashCode(b) ? 8 : 0)
                     + (((object)a).Equals(b) ? 16 : 0);
        var set = new HashSet<Residue> { a, b, c, new Residue { Value = x + 10 } };
        var map = new Dictionary<Residue, int> { [a] = 1, [b] = 2, [c] = 3 };
        var list = new List<Residue> { c, a };
        var array = new[] { c, b, a };
        digest = unchecked(digest * 31 + set.Count * 10 + map.Count + map[new Residue { Value = x + 15 }] * 100);
        digest = unchecked(digest * 31 + list.IndexOf(b) * 10 + (list.Contains(new Residue { Value = x + 6 }) ? 1 : 0) + (list.Remove(b) ? 100 : 0));
        digest = unchecked(digest * 31 + Distinct(array) + (array.AsEnumerable().Contains(new Residue { Value = x + 20 }) ? 10 : 0)
                           + Array.IndexOf(array, new Residue { Value = x + 30 }) * 100);
        digest = unchecked(digest * 31 + Digest(array.GroupBy(r => r).Select(g => g.Count())) + Digest(array.Except(new[] { b })));
        Residue? some = a;
        Residue? other = b;
        Residue? none = null;
        digest = unchecked(digest * 31 + (Same(some, other) ? 1 : 0) + (Same(some, none) ? 2 : 0) + (Same(none, (Residue?)null) ? 4 : 0)
                           + new HashSet<Residue?> { some, other, none, null }.Count * 10);
        digest = unchecked(digest * 31 + new HashSet<(Residue, int)> { (a, 1), (b, 1), (c, 1) }.Count
                           + new HashSet<KeyValuePair<Residue, int>> { new(a, 1), new(b, 1) }.Count * 10);
        var p = new Pair { Left = a, Right = new Parity { Value = x } };
        var q = new Pair { Left = b, Right = new Parity { Value = x + 2 } };
        var r = new Pair { Left = b, Right = new Parity { Value = x + 1 } };
        digest = unchecked(digest * 31 + (Same(p, q) ? 1 : 0) + (Same(p, r) ? 2 : 0) + (((object)p).Equals(q) ? 4 : 0)
                           + new HashSet<Pair> { p, q, r }.Count * 10 + (Same(new Parity { Value = x }, new Parity { Value = x + 4 }) ? 100 : 0));
        return digest;
    }

    // The default order of a class whose IComparable<T> is its base's.
    public static int Contravariant(int x)
    {
        var ranks = new List<SubRank>();
        for (int i = 0; i < 12; i++)
        {
            ranks.Add(new SubRank { Value = (i * 7 + x) % 23 });
        }

        int digest = Order(ranks[0], ranks[1]) + Comparer<SubRank>.Default.Compare(null, ranks[2]) * 3;
        var sorted = new List<SubRank>(ranks);
        sorted.Sort();
        digest = unchecked(digest * 31 + Digest(sorted));
        digest = unchecked(digest * 31 + Digest(ranks.OrderBy(rank => rank)) + Digest(new[] { ranks.Max(), ranks.Min() }));
        var array = ranks.ToArray();
        Array.Sort(array);
        return unchecked(digest * 31 + Digest(array) + sorted.BinarySearch(new SubRank { Value = 5 }));
    }

    public static int Indexers(int x)
    {
        IGrid grid = new Grid();
        grid[1, 1] = x;
        grid[0, 2] += 3;
        grid[1, 1]++;
        return grid[1, 1] * 10 + grid[0, 2] + grid["c"].Length;
    }

    private static int Digest<T>(IEnumerable<T> values, Func<T, int> key)
    {
        int digest = 17;
        foreach (var value in values)
        {
            digest = unchecked(digest * 31 + key(value));
        }

        return digest;
    }

    // Comparer<T>.Default of nullables (no value first) and of types of
    // IComparable alone, through every collection that orders by it.
    public static int NullablesAndLegacy(int x)
    {
        var numbers = new List<int?> { x, null, 3, -x, null, 7, x * 2 };
        numbers.Sort();
        int digest = Digest(numbers, n => n ?? -1000);
        var doubles = new double?[] { 1.5, null, double.NaN, -x, null, 0.0 };
        Array.Sort(doubles);
        digest = unchecked(digest * 31 + Digest(doubles, d => d is null ? -1000 : double.IsNaN(d.Value) ? -2000 : (int)(d.Value * 10)));
        digest = unchecked(digest * 31 + Digest(numbers.OrderByDescending(n => n), n => n ?? -1000));
        var sorted = new SortedSet<int?> { x, null, 5, null, -3 };
        digest = unchecked(digest * 31 + Digest(sorted, n => n ?? -1000) + Comparer<int?>.Default.Compare(null, x) * 7
                           + Comparer<int?>.Default.Compare(x, x - 1) * 11 + Comparer<int?>.Default.Compare(null, null) * 13);
        digest = unchecked(digest * 31 + numbers.BinarySearch(7) + numbers.IndexOf(null) * 3 + (numbers.Max() ?? -1) * 5);
        var legacies = new List<Legacy> { new Legacy { Key = x }, null, new Reversed { Key = 2 }, new Legacy { Key = 4 }, new Legacy { Key = -x } };
        legacies.Sort();
        digest = unchecked(digest * 31 + Digest(legacies, l => l?.Key ?? -1000));
        digest = unchecked(digest * 31 + Digest(legacies.Where(l => l is not null).OrderBy(l => l), l => l.Key));
        var values = new[] { new LegacyValue { Key = x, Tag = 1 }, new LegacyValue { Key = 1, Tag = 2 }, new LegacyValue { Key = x, Tag = 3 } };
        Array.Sort(values);
        digest = unchecked(digest * 31 + Digest(values, v => v.Key * 10 + v.Tag));
        var byKey = new SortedDictionary<LegacyValue, int> { [new LegacyValue { Key = 3 }] = 1, [new LegacyValue { Key = x }] = 2 };
        digest = unchecked(digest * 31 + Digest(byKey, pair => pair.Key.Key * 10 + pair.Value));
        var nullableValues = new LegacyValue?[] { null, new LegacyValue { Key = x }, new LegacyValue { Key = 0 } };
        Array.Sort(nullableValues);
        digest = unchecked(digest * 31 + Digest(nullableValues, v => v?.Key ?? -1000) + Comparer<Legacy>.Default.Compare(null, legacies[1]));
        return digest;
    }

    // Interface re-implementation: calls through the interfaces, and the
    // default comparers and collections that call them, run the most
    // derived class's re-implementation (and a default interface member's
    // re-implementation); a type argument and shared generic code too.
    public static int Reimplementations(int x)
    {
        var plains = new List<Plain>
        {
            new Plain { Key = x }, new Modular { Key = x + 3 }, new Inherits { Key = 1 }, new Again { Key = 7 }, new Plain { Key = 4 },
        };
        int digest = 0;
        foreach (var plain in plains)
        {
            IEquatable<Plain> equatable = plain;
            IComparable<Plain> comparable = plain;
            IComparable old = plain;
            digest = unchecked(digest * 31 + (equatable.Equals(new Plain { Key = x }) ? 1 : 0) + comparable.CompareTo(new Plain { Key = 2 }) * 3
                               + old.CompareTo(new Plain { Key = 2 }) * 5);
            digest = unchecked(digest * 31 + (EqualityComparer<Plain>.Default.Equals(plain, new Plain { Key = x }) ? 1 : 0)
                               + Comparer<Plain>.Default.Compare(plain, new Plain { Key = 2 }) * 7);
        }

        digest = unchecked(digest * 31 + plains.IndexOf(new Plain { Key = x + 6 }) + (plains.Contains(new Plain { Key = 10 }) ? 10 : 0));
        var sorted = new List<Plain>(plains);
        sorted.Sort();
        digest = unchecked(digest * 31 + Digest(sorted, p => p.Key));
        var set = new HashSet<Plain>(plains);
        digest = unchecked(digest * 31 + set.Count + (set.Contains(new Plain { Key = x + 3 }) ? 100 : 0));
        var map = new Dictionary<Plain, int>();
        foreach (var plain in plains)
        {
            map.TryAdd(plain, plain.Key);
        }

        digest = unchecked(digest * 31 + map.Count);
        var olds = new OldPlain[] { new OldPlain { Key = x }, new OldReversed { Key = 3 }, new OldPlain { Key = 1 } };
        Array.Sort(olds);
        digest = unchecked(digest * 31 + Digest(olds, o => o.Key));
        ITitled[] titled = { new Untitled(), new Titled(), new Explicit(), new Relisted() };
        digest = unchecked(digest * 31 + Digest(titled, t => t.Title().Length * 7 + t.Title()[0]));
        digest = unchecked(digest * 31 + Same(new LooseBox<string> { Value = "a" }, new Box<string> { Value = "b" })
                           + Same(new LooseBox<Plain> { Value = null }, new Box<Plain> { Value = plains[0] }) * 2
                           + Same(new Box<string> { Value = "a" }, new Box<string> { Value = "b" }) * 4
                           + Same(new Box<Plain> { Value = plains[1] }, new Box<Plain> { Value = new Plain { Key = x + 3 } }) * 8);
        return digest;
    }

    private static int Same<T>(Box<T> left, Box<T> right) =>
        (EqualityComparer<Box<T>>.Default.Equals(left, right) ? 1 : 0) + (new List<Box<T>> { left }.Contains(right) ? 16 : 0);

    public static int Faults(int which)
    {
        string[] words = ["b", null, "a"];
        switch (which)
        {
            case 0:
                return Comparer<string>.Create(null).Compare("a", "b");
            case 1:
                return StringComparer.Ordinal.GetHashCode(null);
            case 2:
                return new Dictionary<string, int>(StringComparer.Ordinal) { [null] = 1 }.Count;
            case 3:
                return new List<Version> { new Version(1, 1), new Version(1, 1) }.ToLookup(v => v)[null].Count();
            default:
                return words.ToLookup(w => w)[null].Count();
        }
    }
}
