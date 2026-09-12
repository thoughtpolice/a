// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// IEquatable<T>: EqualityComparer<T>.Default is the CLR's
// GenericEqualityComparer<T> for a T implementing IEquatable<T>, which
// calls Equals(T), and its ObjectEqualityComparer<T> otherwise, which calls
// Equals(object). The types here make the two disagree, so every
// collection, Linq operator and generic method shows which one ran,
// against the CLR.

using System;
using System.Collections.Generic;
using System.Linq;

namespace Tests.Equatables
{
    // Equals(T) by value modulo 3, Equals(object) by value. The hash is
    // the residue, consistent with both.
    public class Mod : IEquatable<Mod>
    {
        public static int Calls;

        public Mod(int value)
        {
            Value = value;
        }

        public int Value { get; }

        public virtual bool Equals(Mod other)
        {
            Calls++;
            return other is not null && other.Value % 3 == Value % 3;
        }

        public override bool Equals(object obj) => obj is Mod other && other.Value == Value;

        public override int GetHashCode() => Value % 3;

        public override string ToString() => "m" + Value;
    }

    // Overrides Equals(Mod): the comparer's call dispatches to it. Its own
    // IEquatable<Strict> it has not (IEquatable<T> is invariant), so its
    // default comparer is Equals(object)'s.
    public sealed class Strict : Mod
    {
        public Strict(int value) : base(value)
        {
        }

        public override bool Equals(Mod other) => other is not null && other.Value == Value;
    }

    // IEquatable<T> implemented explicitly, by tens.
    public sealed class Tens : IEquatable<Tens>
    {
        public int Value;

        bool IEquatable<Tens>.Equals(Tens other) => other is not null && other.Value / 10 == Value / 10;

        public override bool Equals(object obj) => obj is Tens other && other.Value == Value;

        public override int GetHashCode() => Value / 10;

        public override string ToString() => "t" + Value;
    }

    // IEquatable<T> without Equals(object): that one is identity.
    public sealed class Bare : IEquatable<Bare>
    {
        public int Value;

        public bool Equals(Bare other) => other is not null && other.Value % 2 == Value % 2;
    }

    // A struct by value modulo 4, with its hash; without Equals(object) of
    // its own, so boxed it compares by its field.
    public struct Quad : IEquatable<Quad>
    {
        public int Value;

        public bool Equals(Quad other) => other.Value % 4 == Value % 4;

        public override int GetHashCode() => Value % 4;

        public override string ToString() => "q" + Value;
    }

    // An interface over IEquatable of itself: its default comparer calls
    // through the interface.
    public interface IShape : IEquatable<IShape>
    {
        int Size { get; }
    }

    public sealed class Square : IShape
    {
        public int Size { get; set; }

        public bool Equals(IShape other) => other is not null && other.Size % 2 == Size % 2;

        public override bool Equals(object obj) => obj is Square other && other.Size == Size;

        public override int GetHashCode() => Size % 2;
    }

    // Records, anonymous types and tuples compare their members by
    // EqualityComparer<T>.Default.
    public sealed record Holder(Mod Item, int Count);

    // Shared code over several reference types: each instantiation's
    // comparer is its own T's.
    public sealed class Bag<T>
    {
        private readonly List<T> items = new List<T>();

        public int Count => items.Count;

        public bool Add(T item)
        {
            foreach (var existing in items)
            {
                if (EqualityComparer<T>.Default.Equals(existing, item))
                {
                    return false;
                }
            }

            items.Add(item);
            return true;
        }

        public bool Has(T item) => items.Contains(item);

        public int Unique(IEnumerable<T> values) => new HashSet<T>(values).Count;
    }

    public static class Equatables
    {
        private static bool Same<T>(T left, T right) => EqualityComparer<T>.Default.Equals(left, right);

        private static int Hash<T>(T value) => EqualityComparer<T>.Default.GetHashCode(value);

        private static int Distinct<T>(IEnumerable<T> values) => values.Distinct().Count();

        private static int Find<T>(List<T> list, T value) => list.IndexOf(value);

        private static int Digest<T>(IEnumerable<T> values)
        {
            int digest = 17;
            foreach (T value in values)
            {
                string text = value?.ToString() ?? "null";
                foreach (char c in text)
                {
                    digest = unchecked(digest * 31 + c);
                }

                digest = unchecked(digest * 7 + 1);
            }

            return digest;
        }

        // EqualityComparer<T>.Default itself: which Equals, nulls (which
        // Equals(T) never sees) and the hash.
        public static int Comparer(int x)
        {
            Mod.Calls = 0;
            var a = new Mod(x);
            var b = new Mod(x + 3);
            var c = new Mod(x + 1);
            var comparer = EqualityComparer<Mod>.Default;
            int digest = (comparer.Equals(a, b) ? 1 : 0) + (comparer.Equals(a, c) ? 2 : 0) + (comparer.Equals(null, null) ? 4 : 0)
                         + (comparer.Equals(a, null) ? 8 : 0) + (comparer.Equals(null, b) ? 16 : 0)
                         + (EqualityComparer<object>.Default.Equals(a, b) ? 32 : 0) + (a.Equals((object)b) ? 64 : 0);
            digest = unchecked(digest * 31 + comparer.GetHashCode(b) + comparer.GetHashCode(null) * 10 + Mod.Calls * 100);
            digest = unchecked(digest * 31 + (Same(new Tens { Value = x }, new Tens { Value = x + 1 }) ? 1 : 0)
                               + (Same(new Bare { Value = x }, new Bare { Value = x + 2 }) ? 2 : 0)
                               + (Same(new Quad { Value = x }, new Quad { Value = x + 4 }) ? 4 : 0)
                               + (Same<IShape>(new Square { Size = x }, new Square { Size = x + 2 }) ? 8 : 0)
                               + (Same(new Strict(x), new Strict(x + 3)) ? 16 : 0)
                               + (Same<Mod>(new Strict(x), new Mod(x + 3)) ? 32 : 0)
                               + (Same<Mod>(new Mod(x + 3), new Strict(x)) ? 64 : 0));
            Quad? some = new Quad { Value = x };
            Quad? other = new Quad { Value = x + 8 };
            digest = unchecked(digest * 31 + (Same(some, other) ? 1 : 0) + (Same(some, null) ? 2 : 0) + (Same<Quad?>(null, null) ? 4 : 0)
                               + (((object)new Quad { Value = x }).Equals(new Quad { Value = x + 4 }) ? 8 : 0)
                               + (new Quad { Value = x }.Equals((object)new Quad { Value = x }) ? 16 : 0));
            return unchecked(digest * 31 + Hash(new Tens { Value = x * 10 }) + Hash(new Quad { Value = x }) * 7);
        }

        // The collections' default comparers.
        public static int Collections(int x)
        {
            var a = new Mod(x);
            var b = new Mod(x + 3);
            var c = new Mod(x + 1);
            var set = new HashSet<Mod> { a, b, c, new Mod(x + 6) };
            var map = new Dictionary<Mod, int> { [a] = 1, [b] = 2, [c] = 3 };
            int digest = set.Count * 10 + map.Count + (map.TryGetValue(new Mod(x + 9), out int found) ? found : -1) * 100 + (set.Contains(new Mod(x + 4)) ? 1000 : 0);
            var list = new List<Mod> { c, a };
            digest = unchecked(digest * 31 + list.IndexOf(b) * 10 + (list.Contains(new Mod(x + 30)) ? 1 : 0) + list.LastIndexOf(b) * 100
                               + (list.Remove(new Mod(x + 12)) ? 1000 : 0) + list.Count * 10000);
            var array = new[] { c, a };
            // The CLR's array as a collection interface compares references
            // by Equals(object); Array.IndexOf by the default comparer.
            digest = unchecked(digest * 31 + Array.IndexOf(array, b) + (((ICollection<Mod>)array).Contains(b) ? 10 : 0)
                               + ((IList<Mod>)array).IndexOf(b) * 100);
            var quads = new[] { new Quad { Value = x } };
            digest = unchecked(digest * 31 + (((ICollection<Quad>)quads).Contains(new Quad { Value = x + 4 }) ? 1 : 0)
                               + ((IList<Quad?>)new Quad?[] { new Quad { Value = x } }).IndexOf(new Quad { Value = x + 8 }) * 10);
            var stack = new Stack<Mod>();
            stack.Push(a);
            var queue = new Queue<Mod>();
            queue.Enqueue(a);
            var linked = new LinkedList<Mod>();
            linked.AddLast(a);
            digest = unchecked(digest * 31 + (stack.Contains(b) ? 1 : 0) + (queue.Contains(b) ? 10 : 0) + (linked.Find(b) != null ? 100 : 0)
                               + (map.ContainsKey(new Mod(x + 30)) ? 1000 : 0) + (new Dictionary<int, Mod> { [1] = a }.ContainsValue(b) ? 10000 : 0));
            var squares = new HashSet<IShape> { new Square { Size = x }, new Square { Size = x + 2 }, new Square { Size = x + 1 } };
            var quadSet = new HashSet<Quad> { new Quad { Value = x }, new Quad { Value = x + 4 }, new Quad { Value = x + 1 } };
            var strict = new HashSet<Strict> { new Strict(x), new Strict(x + 3) };
            return unchecked(digest * 31 + squares.Count + quadSet.Count * 10 + strict.Count * 100);
        }

        // System.Linq's operators, whose default comparer is the element
        // type's.
        public static int Linq(int x)
        {
            var values = new List<Mod>();
            for (int i = 0; i < 9; i++)
            {
                values.Add(new Mod(x + i * 2));
            }

            var probe = new Mod(x + 30);
            int digest = Distinct(values) + (values.Contains(probe) ? 10 : 0) + (values.AsEnumerable().Contains(probe) ? 100 : 0)
                         + (values.ToArray().AsEnumerable().Contains(probe) ? 1000 : 0)
                         + (values.Select(value => value).Contains(probe) ? 10000 : 0);
            digest = unchecked(digest * 31 + Digest(values.Distinct()) + Digest(values.GroupBy(value => value).Select(g => g.Key.Value * 10 + g.Count())));
            digest = unchecked(digest * 31 + Digest(values.Union(new[] { probe })) + Digest(values.Intersect(new[] { probe }))
                               + Digest(values.Except(new[] { probe })));
            digest = unchecked(digest * 31 + values.ToLookup(value => value).Count + values.Take(3).ToDictionary(value => value).Count * 10
                               + (values.SequenceEqual(values.Select(value => new Mod(value.Value + 3))) ? 100 : 0)
                               + values.Select(value => value.Value).Distinct().Count() * 1000);
            var tens = new[] { new Tens { Value = x }, new Tens { Value = x + 1 }, new Tens { Value = x + 10 } };
            var quads = new List<Quad> { new Quad { Value = x }, new Quad { Value = x + 4 }, new Quad { Value = x + 2 } };
            return unchecked(digest * 31 + Distinct(tens) + Distinct(quads) * 10 + (quads.Contains(new Quad { Value = x + 8 }) ? 100 : 0)
                             + Digest(quads.Distinct()) + Digest(tens.GroupJoin(tens, t => t, t => t, (t, matches) => matches.Count())));
        }

        // Shared generic code over several reference types, each comparing
        // as its own type argument does.
        public static int Shared(int x)
        {
            var mods = new Bag<Mod>();
            var tens = new Bag<Tens>();
            var words = new Bag<string>();
            var shapes = new Bag<IShape>();
            for (int i = 0; i < 6; i++)
            {
                mods.Add(new Mod(x + i));
                tens.Add(new Tens { Value = x + i * 4 });
                words.Add(i % 2 == 0 ? "even" : "odd" + i % 3);
                shapes.Add(new Square { Size = x + i });
            }

            int digest = mods.Count + tens.Count * 10 + words.Count * 100 + shapes.Count * 1000;
            digest = unchecked(digest * 31 + (mods.Has(new Mod(x + 9)) ? 1 : 0) + (tens.Has(new Tens { Value = x + 1 }) ? 2 : 0)
                               + (words.Has("od" + "d1") ? 4 : 0) + (shapes.Has(new Square { Size = x + 20 }) ? 8 : 0));
            digest = unchecked(digest * 31 + mods.Unique(new[] { new Mod(x), new Mod(x + 3), new Mod(x + 4) })
                               + tens.Unique(new[] { new Tens { Value = 1 }, new Tens { Value = 2 } }) * 10);
            digest = unchecked(digest * 31 + (Same(new Mod(x), new Mod(x + 6)) ? 1 : 0) + (Same((object)new Mod(x), new Mod(x + 6)) ? 2 : 0)
                               + (Same(new Tens { Value = x }, new Tens { Value = x + 3 }) ? 4 : 0) + (Same("a", "b") ? 8 : 0));
            var list = new List<Mod> { new Mod(x + 1), new Mod(x + 2) };
            var tensList = new List<Tens> { new Tens { Value = 30 }, new Tens { Value = 45 } };
            return unchecked(digest * 31 + Find(list, new Mod(x + 5)) + Find(tensList, new Tens { Value = 41 }) * 10
                             + Find(new List<string> { "x", "y" }, "y") * 100);
        }

        // Members compared by EqualityComparer<T>.Default: records,
        // anonymous types, tuples; pairs and boxes by Equals(object).
        public static int Composites(int x)
        {
            var a = new Mod(x);
            var b = new Mod(x + 3);
            int digest = (new Holder(a, 1) == new Holder(b, 1) ? 1 : 0) + (new Holder(a, 1).Equals(new Holder(b, 2)) ? 2 : 0)
                         + (new { Item = a }.Equals(new { Item = b }) ? 4 : 0) + ((a, 1).Equals((b, 1)) ? 8 : 0)
                         + (Same((a, "k"), (b, "k")) ? 16 : 0)
                         + (Same(new KeyValuePair<Mod, int>(a, 1), new KeyValuePair<Mod, int>(b, 1)) ? 32 : 0)
                         + (((object)(new Quad { Value = x }, 1)).Equals((new Quad { Value = x + 4 }, 1)) ? 64 : 0);
            var holders = new HashSet<Holder> { new Holder(a, 1), new Holder(b, 1), new Holder(b, 2) };
            var tuples = new HashSet<(Mod, int)> { (a, 1), (b, 1), (new Mod(x + 1), 1) };
            var pairs = new HashSet<KeyValuePair<Mod, int>> { new(a, 1), new(b, 1) };
            var anonymous = new[] { new { Item = a }, new { Item = b } }.Distinct().Count();
            return unchecked(digest * 31 + holders.Count + tuples.Count * 10 + pairs.Count * 100 + anonymous * 1000);
        }
    }
}
