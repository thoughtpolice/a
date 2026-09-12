// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Shared generics (docs/IMPORTER.md): one generic definition's
// code over several reference types, and what it asks of each exact type
// argument (casts and type tests, typeof, new T[] and new C<T>(), static
// state per instantiation, the default comparers, generic virtual methods,
// variance), against the CLR.

using System;
using System.Collections.Generic;
using System.Linq;

namespace Tests.Sharing
{
    public class Enemy
    {
        public Enemy(int health) { Health = health; }

        public int Health { get; }

        public override string ToString() => "Enemy" + Health;
    }

    public sealed class Boss : Enemy
    {
        public Boss(int health) : base(health) { }
    }

    // Equal by parity as an IEquatable<Odd>, by value as an object: the
    // default comparer of Odd compares by parity (the CLR's
    // GenericEqualityComparer), of object by value, of Enemy by reference,
    // of string by contents.
    public sealed class Odd : IEquatable<Odd>
    {
        public int Value;

        public bool Equals(Odd other) => other is not null && other.Value % 2 == Value % 2;

        public override bool Equals(object obj) => obj is Odd other && other.Value == Value;

        public override int GetHashCode() => Value % 2;
    }

    // Equal by tens as an IEquatable<Ten>, by value as an object.
    public sealed class Ten : IEquatable<Ten>
    {
        public int Value;

        public bool Equals(Ten other) => other is not null && other.Value / 10 == Value / 10;

        public override bool Equals(object obj) => obj is Ten other && other.Value == Value;

        public override int GetHashCode() => Value / 10;
    }

    // One class's shared code over several element types, each deduplicated
    // by its own default comparer.
    public sealed class Distinct<T>
    {
        private readonly List<T> items = new List<T>();

        public int Count => items.Count;

        public void Add(T item)
        {
            if (!items.Contains(item) && !new HashSet<T>(items).Contains(item))
            {
                items.Add(item);
            }
        }

        public bool Same(T left, T right) => EqualityComparer<T>.Default.Equals(left, right);
    }

    public sealed class Box<T>
    {
        public static int Made;

        public Box(T value)
        {
            Value = value;
            Made++;
        }

        public T Value;

        public bool Holds(object candidate) => candidate is T;

        public T Cast(object candidate) => (T)candidate;

        public T[] Repeat(int count)
        {
            var items = new T[count];
            for (int index = 0; index < count; index++)
            {
                items[index] = Value;
            }

            return items;
        }

        public string Name() => typeof(T).Name;

        public Box<T> Copy() => new Box<T>(Value);

        public List<T> Listed() => new List<T> { Value, Value };
    }

    public static class Registry<T>
    {
        public static readonly List<string> Log = new List<string>();

        static Registry()
        {
            Sharing.Order += typeof(T).Name + ";";
        }

        public static int Count;

        public static void Add(T item)
        {
            Count++;
            Log.Add(item?.ToString() ?? "null");
        }
    }

    public abstract class Visitor<TResult>
    {
        public abstract TResult Visit<TItem>(TItem item);
    }

    public sealed class Namer : Visitor<string>
    {
        public override string Visit<TItem>(TItem item) => typeof(TItem).Name + ":" + item;
    }

    public sealed class Counter<T> : Visitor<int>
    {
        public int Seen;

        public override int Visit<TItem>(TItem item) => ++Seen + (item is T ? 100 : 0);
    }

    public static class Sharing
    {
        public static string Order = "";

        private static bool Same<T>(T left, T right) => EqualityComparer<T>.Default.Equals(left, right);

        private static int Hash<T>(T value) => EqualityComparer<T>.Default.GetHashCode(value);

        private static T[] Fill<T>(T[] items, T value)
        {
            for (int index = 0; index < items.Length; index++)
            {
                items[index] = value;
            }

            return items;
        }

        private static bool Is<T>(object value) => value is T;

        private static T As<T>(object value)
            where T : class => value as T;

        private static object MakeList<T>() => new List<T>();

        private static string Names<T>(IEnumerable<T> items) => string.Join(",", items.Select(item => item.ToString()));

        private static int Visit<T>(Visitor<T> visitor, object a, string b, Enemy c)
        {
            var text = visitor.Visit(a) + "|" + visitor.Visit(b) + "|" + visitor.Visit(c) + "|" + visitor.Visit(3);
            return text.Length;
        }

        // One class over several reference types: its values, type tests,
        // casts, arrays, typeof and static state per instantiation.
        public static int Boxes(int which)
        {
            var text = new Box<string>("text");
            var enemy = new Box<Enemy>(new Boss(7));
            var numbers = new Box<int[]>(new[] { 1, 2, 3 });
            var action = new Box<Func<int>>(() => which);
            switch (which)
            {
                case 0:
                    return text.Value.Length + enemy.Value.Health * 10 + numbers.Value.Length * 100 + action.Value() * 1000;
                case 1:
                    return (text.Holds("a") ? 1 : 0) + (text.Holds(enemy.Value) ? 2 : 0) + (enemy.Holds(new Boss(1)) ? 4 : 0)
                           + (enemy.Holds("x") ? 8 : 0) + (numbers.Holds(new[] { 1 }) ? 16 : 0) + (numbers.Holds(new long[1]) ? 32 : 0)
                           + (action.Value is not null ? 64 : 0);
                case 2:
                    try
                    {
                        return text.Cast("ok").Length + enemy.Cast(new Boss(2)).Health + text.Cast(new Enemy(1)).Length;
                    }
                    catch (InvalidCastException)
                    {
                        return -1;
                    }

                case 3:
                    var strings = text.Repeat(3);
                    var enemies = enemy.Repeat(2);
                    object any = strings;
                    return strings.Length + enemies.Length * 10 + (any is string[] ? 100 : 0) + (any is Enemy[] ? 1000 : 0)
                           + (enemies is object[] ? 10000 : 0) + (((object)enemies) is Boss[] ? 100000 : 0);
                case 4:
                    return (text.Name() + enemy.Name() + numbers.Name() + action.Name()).Length;
                case 5:
                    int before = Box<string>.Made * 100 + Box<Enemy>.Made;
                    text.Copy();
                    text.Copy();
                    enemy.Copy();
                    return (Box<string>.Made * 100 + Box<Enemy>.Made - before) * 10 + Box<int[]>.Made;
                default:
                    object list = text.Listed();
                    object enemyList = enemy.Listed();
                    return (list is List<string> ? 1 : 0) + (list is List<Enemy> ? 2 : 0) + (enemyList is List<Enemy> ? 4 : 0)
                           + (list.GetType() == typeof(List<string>) ? 8 : 0) + (enemyList.GetType() == typeof(List<string>) ? 16 : 0)
                           + (list is IList<string> ? 32 : 0) + (list is IList<Enemy> ? 64 : 0) + (list is IEnumerable<object> ? 128 : 0)
                           + (enemyList is IReadOnlyList<Enemy> ? 256 : 0) + ((List<string>)list).Count * 1000;
            }
        }

        // Generic methods over several reference types.
        public static int Methods(int which)
        {
            switch (which)
            {
                case 0:
                    return (Is<string>("a") ? 1 : 0) + (Is<Enemy>(new Boss(1)) ? 2 : 0) + (Is<Boss>(new Enemy(1)) ? 4 : 0)
                           + (Is<IEnumerable<char>>("x") ? 8 : 0) + (Is<object[]>(new string[1]) ? 16 : 0) + (Is<string>(null) ? 32 : 0);
                case 1:
                    return (As<string>("abc")?.Length ?? -1) + (As<Enemy>("abc")?.Health ?? -10) + (As<Enemy>(new Boss(4))?.Health ?? -100) * 1000;
                case 2:
                    return (MakeList<string>() is List<string> ? 1 : 0) + (MakeList<Enemy>() is List<string> ? 2 : 0)
                           + (MakeList<Enemy>() is List<Enemy> ? 4 : 0) + (MakeList<int[]>() is List<int[]> ? 8 : 0);
                case 3:
                    return (Names(new[] { "a", "b" }) + Names(new List<Enemy> { new Enemy(1), new Boss(2) }) + Names(new[] { 3, 4 })).Length;
                default:
                    try
                    {
                        // A store of the wrong type into a covariant array, from shared code.
                        object[] objects = new string[2];
                        Fill(objects, "s");
                        Fill(objects, (object)1);
                        return 0;
                    }
                    catch (ArrayTypeMismatchException)
                    {
                        return 7;
                    }
            }
        }

        // The default comparer of each exact type argument.
        public static int Comparers(int which)
        {
            var a = new Odd { Value = 1 };
            var b = new Odd { Value = 3 };
            switch (which)
            {
                case 0:
                    return (Same(a, b) ? 1 : 0) + (Same((object)a, b) ? 2 : 0) + (Same("x", "x" + "") ? 4 : 0) + (Same("x", "y") ? 8 : 0)
                           + (Same<Enemy>(null, null) ? 16 : 0) + (Same(new Enemy(1), new Enemy(1)) ? 32 : 0);
                case 1:
                    return Hash(a) + Hash(b) * 10 + (Hash("abc") == Hash("ab" + "c") ? 100 : 0);
                case 2:
                    var set = new HashSet<Odd> { a, b, new Odd { Value = 2 } };
                    var strings = new HashSet<string> { "a", "a", "b" };
                    return set.Count * 10 + strings.Count;
                case 3:
                    var list = new List<Odd> { a };
                    var words = new List<string> { "a", "b" };
                    return (list.Contains(b) ? 1 : 0) + list.IndexOf(new Odd { Value = 5 }) * 10 + words.IndexOf("b") * 100
                           + (words.Contains("c") ? 1000 : 0);
                case 5:
                    var odds = new Distinct<Odd>();
                    var tens = new Distinct<Ten>();
                    var names = new Distinct<string>();
                    var enemies = new Distinct<Enemy>();
                    var shared = new Enemy(1);
                    for (int value = 0; value < 5; value++)
                    {
                        odds.Add(new Odd { Value = value * 3 });
                        tens.Add(new Ten { Value = value * 4 });
                        names.Add("n" + value % 2);
                        enemies.Add(value % 2 == 0 ? shared : new Enemy(1));
                    }

                    return odds.Count + tens.Count * 10 + names.Count * 100 + enemies.Count * 1000
                           + (odds.Same(a, b) ? 10000 : 0) + (tens.Same(new Ten { Value = 1 }, new Ten { Value = 9 }) ? 20000 : 0)
                           + (new[] { a, b }.Distinct().Count() == 1 ? 40000 : 0) + (new object[] { a, b }.Distinct().Count() == 2 ? 80000 : 0);
                default:
                    var counts = new Dictionary<string, int>();
                    var byOdd = new Dictionary<Odd, int>();
                    foreach (var word in new[] { "x", "y", "x" })
                    {
                        counts[word] = counts.TryGetValue(word, out int count) ? count + 1 : 1;
                    }

                    byOdd[a] = 1;
                    byOdd[b] = 2;
                    return counts["x"] * 10 + counts.Count + byOdd.Count * 100 + byOdd[a] * 1000;
            }
        }

        // Static state and initialization per exact instantiation.
        public static int Statics(int which)
        {
            Order = "";
            Registry<string>.Add("a");
            Registry<string>.Add(null);
            Registry<Enemy>.Add(new Enemy(which));
            Registry<int[]>.Count += which;
            return which switch
            {
                0 => Registry<string>.Count * 100 + Registry<Enemy>.Count * 10 + Registry<Boss>.Count,
                1 => string.Join("", Registry<string>.Log).Length + string.Join("", Registry<Enemy>.Log).Length * 10,
                _ => Order.Length + Registry<int[]>.Count,
            };
        }

        // Generic virtual methods, over a class and a shared class.
        public static int Virtuals(int which)
        {
            return which switch
            {
                0 => Visit(new Namer(), "o", "b", new Enemy(2)),
                1 => Visit(new Counter<string>(), "o", "b", new Enemy(2)),
                _ => Visit(new Counter<Enemy>(), new Boss(1), "b", new Enemy(2)),
            };
        }

        // Variance through shared code: interfaces and delegates of one
        // type as another's.
        public static int Variance(int which)
        {
            IEnumerable<object> objects = new List<string> { "a", "bb" };
            IEnumerable<Enemy> enemies = new List<Boss> { new Boss(3) };
            Func<Boss> make = () => new Boss(5);
            Func<Enemy> general = make;
            Action<Enemy> hit = enemy => Order += enemy.Health;
            Action<Boss> narrowed = hit;
            switch (which)
            {
                case 0:
                    return objects.Count() + enemies.Sum(enemy => enemy.Health) * 10 + objects.OfType<string>().Sum(text => text.Length) * 100;
                case 1:
                    Order = "";
                    narrowed(new Boss(9));
                    return general().Health + Order.Length * 10 + (general is Func<Boss> ? 100 : 0) + (narrowed is Action<Enemy> ? 1000 : 0);
                default:
                    var lookup = enemies.Concat(new[] { new Enemy(1) }).ToLookup(enemy => enemy is Boss);
                    return lookup[true].Count() * 10 + lookup[false].Count();
            }
        }

        // Nested and mixed instantiations: structs of references, and
        // dictionaries of lists.
        public static int Nested(int which)
        {
            var groups = new Dictionary<string, List<Enemy>>();
            foreach (var (name, health) in new[] { ("a", 1), ("b", 2), ("a", 3) })
            {
                if (!groups.TryGetValue(name, out var list))
                {
                    groups[name] = list = new List<Enemy>();
                }

                list.Add(new Enemy(health));
            }

            var pairs = groups.Select(pair => new KeyValuePair<string, int>(pair.Key, pair.Value.Sum(enemy => enemy.Health))).ToArray();
            object any = pairs;
            return which switch
            {
                0 => groups["a"].Count * 10 + groups["b"][0].Health,
                1 => pairs.Sum(pair => pair.Value) + pairs.Length * 100,
                _ => (any is KeyValuePair<string, int>[] ? 1 : 0) + (any is KeyValuePair<string, long>[] ? 2 : 0)
                     + (any is KeyValuePair<Enemy, int>[] ? 4 : 0) + string.Join("", pairs.Select(pair => pair.Key)).Length * 10,
            };
        }
    }
}
