// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Nullables;

public enum Mood
{
    Calm,
    Angry = 4,
}

public struct Point
{
    public int X;
    public int Y;

    public override string ToString() => X + ":" + Y;
}

public struct Vec
{
    public int X;

    public static Vec operator +(Vec a, Vec b) => new Vec { X = a.X + b.X };

    public static Vec operator -(Vec a) => new Vec { X = -a.X };

    public static Vec operator ++(Vec a) => new Vec { X = a.X + 1 };

    public static bool operator ==(Vec a, Vec b) => a.X == b.X;

    public static bool operator !=(Vec a, Vec b) => a.X != b.X;

    public static bool operator <(Vec a, Vec b) => a.X < b.X;

    public static bool operator >(Vec a, Vec b) => a.X > b.X;

    public override bool Equals(object other) => other is Vec vec && vec.X == X;

    public override int GetHashCode() => X;
}

public sealed class Enemy
{
    public int Health;

    public Enemy Target;

    public int? Shield;
}

public static class Nullables
{
    private static int Digest(string text)
    {
        if (text == null)
        {
            return -1;
        }

        int digest = text.Length;
        for (int index = 0; index < text.Length; index++)
        {
            digest = unchecked(digest * 31 + text[index]);
        }

        return digest;
    }

    private static int? Maybe(int value) => value % 3 == 0 ? null : value;

    private static double? MaybeDouble(double value) => value < 0 ? null : value;

    public static int Members(int a)
    {
        int? value = Maybe(a);
        return (value.HasValue ? 1000 : 0) + value.GetValueOrDefault() * 10 + value.GetValueOrDefault(7);
    }

    // Value and an explicit conversion throw without a value.
    public static int Value(int a) => Maybe(a).Value;

    public static int Explicit(int a) => (int)Maybe(a);

    public static int Coalesce(int a) => Maybe(a) ?? -1;

    public static long CoalesceWide(int a) => Maybe(a) ?? (long)a * 1000;

    public static int CoalesceChain(int a, int b) => (Maybe(a) ?? Maybe(b)) ?? -5;

    public static int Arithmetic(int a, int b)
    {
        int? sum = Maybe(a) + Maybe(b);
        int? product = Maybe(a) * 3;
        int? negated = -Maybe(b);
        return (sum ?? -1) * 10000 + (product ?? -1) * 100 + (negated ?? 99);
    }

    public static int Division(int a, int b) => (Maybe(a) / Maybe(b)) ?? -7;

    public static int Comparisons(int a, int b)
    {
        int? x = Maybe(a);
        int? y = Maybe(b);
        return (x == y ? 1 : 0) + (x != y ? 2 : 0) + (x < y ? 4 : 0) + (x >= y ? 8 : 0)
            + (x == null ? 16 : 0) + (x != null ? 32 : 0) + (x == 4 ? 64 : 0) + (null == y ? 128 : 0);
    }

    public static int FloatingCompare(double a, double b)
    {
        double? x = MaybeDouble(a);
        double? y = MaybeDouble(b);
        return (x == y ? 1 : 0) + (x != y ? 2 : 0) + (x < y ? 4 : 0) + (x <= y ? 8 : 0);
    }

    public static int Logic(int a, int b)
    {
        bool? x = a % 3 == 0 ? null : a % 3 == 1;
        bool? y = b % 3 == 0 ? null : b % 3 == 1;
        bool? and = x & y;
        bool? or = x | y;
        bool? not = !x;
        int Code(bool? value) => value == null ? 0 : value.Value ? 1 : 2;
        return Code(and) * 100 + Code(or) * 10 + Code(not);
    }

    public static int Compound(int a, int b)
    {
        int? total = Maybe(a);
        total += b;
        total *= 2;
        short? small = (short?)Maybe(b);
        small += 1000;
        small <<= 3;
        long? wide = Maybe(a);
        wide -= int.MaxValue;
        return (total ?? -1) + (small ?? -2) * 7 + (int)((wide ?? 5) % 1000);
    }

    public static int Increments(int a)
    {
        int? value = Maybe(a);
        int? before = value++;
        ++value;
        value--;
        return (before ?? -100) * 1000 + (value ?? -1);
    }

    public static int Conversions(int a)
    {
        int? value = Maybe(a);
        long? wide = value;
        double? floating = wide;
        byte? narrow = (byte?)value;
        int? back = (int?)floating;
        return (int)((wide ?? -1) + (long)((floating ?? -2) * 10) + (narrow ?? 300) * 1000 + (back ?? 7) * 100000);
    }

    public static int Boxing(int a)
    {
        object boxed = Maybe(a);
        int? unboxed = (int?)boxed;
        object direct = 5;
        int? fromDirect = (int?)direct;
        return (boxed == null ? 1 : 0) + (boxed is int n ? n * 10 : 0) + (unboxed ?? 0) * 1000 + (fromDirect ?? 0) * 100000;
    }

    public static int Patterns(int a)
    {
        int? value = Maybe(a);
        int result = value is null ? 1 : 0;
        result += value is not null ? 2 : 0;
        result += value is int bound ? bound * 10 : 0;
        result += value is > 3 and < 10 ? 1000 : 0;
        result += value is 4 or 5 ? 10000 : 0;
        result += value is { } some ? some * 100000 : 0;
        result += value switch
        {
            null => 3000000,
            1 => 4000000,
            > 10 => 5000000,
            _ => 6000000,
        };
        return result;
    }

    public static int Switch(int a)
    {
        int? value = Maybe(a);
        switch (value)
        {
            case null:
                return -1;
            case 2:
                return 20;
            case int other when other > 50:
                return 50;
            default:
                return value.Value;
        }
    }

    public static int Text(int a) =>
        Digest($"[{Maybe(a)}|{MaybeDouble(a / 4.0)}|{(Mood?)(a % 5 == 4 ? Mood.Angry : null)}]") * 3
        + Digest("x" + Maybe(a) + (a % 2 == 0 ? (char?)'c' : null)) + Digest(Maybe(a).ToString());

    public static int Objects(int a, int b) =>
        (Maybe(a).Equals(Maybe(b)) ? 1 : 0) + (Maybe(a).GetHashCode() == Maybe(b).GetHashCode() ? 2 : 0)
        + (Maybe(a).Equals((object)b) ? 4 : 0) + (Maybe(a).GetHashCode() == 0 ? 8 : 0);

    public static int Structs(int a)
    {
        Point? point = a % 2 == 0 ? new Point { X = a, Y = -a } : null;
        Point? copy = point;
        return (point?.X ?? -1) + (copy.HasValue ? copy.Value.Y * 10 : 0) + Digest($"{point}") * 100;
    }

    public static int Enums(int a)
    {
        Mood? mood = a % 3 == 0 ? null : (Mood)(a % 5);
        return (mood == Mood.Angry ? 1 : 0) + (mood.HasValue ? (int)mood.Value * 10 : 0) + (mood is Mood.Calm ? 100 : 0);
    }

    public static int Access(int a)
    {
        var enemy = a % 2 == 0 ? null : new Enemy { Health = a, Target = new Enemy { Health = a * 2 } };
        int? health = enemy?.Health;
        int? targetHealth = enemy?.Target?.Health;
        int? shield = enemy?.Shield;
        string text = Maybe(a)?.ToString();
        return (health ?? -1) + (targetHealth ?? -2) * 100 + (shield ?? -3) * 10000 + Digest(text) * 1000000;
    }

    public static int Fields(int a)
    {
        var enemy = new Enemy();
        enemy.Shield = Maybe(a);
        enemy.Shield += 5;
        var shields = new int?[3];
        shields[a % 3] = a;
        shields[(a + 1) % 3] = Maybe(a);
        int total = 0;
        foreach (int? shield in shields)
        {
            total = total * 7 + (shield ?? 3);
        }

        return (enemy.Shield ?? -1) * 100000 + total;
    }

    public static int Collections(int a)
    {
        var list = new List<int?> { 1, null, a, Maybe(a) };
        var counts = new Dictionary<int?, int>();
        foreach (var item in list)
        {
            counts[item ?? -1] = counts.TryGetValue(item, out int count) ? count + 1 : 1;
        }

        return counts.Count * 100 + list.IndexOf(null) * 10 + (list.Contains(Maybe(a)) ? 1 : 0);
    }

    public static int Generic(int a) => Or(Maybe(a), 9) + Or<double>(MaybeDouble(-a), 2.5) > 10 ? 1 : 0;

    private static T Or<T>(T? value, T fallback)
        where T : struct => value ?? fallback;

    public static int Capture(int a)
    {
        int? value = Maybe(a);
        Func<int> read = () => value ?? -1;
        value = 42;
        return read();
    }

    public static int CoalesceAssign(int a)
    {
        Enemy enemy = a > 0 ? new Enemy { Health = a } : null;
        var made = enemy ??= new Enemy { Health = 7 };
        var again = enemy ??= new Enemy { Health = 9 };
        made.Target ??= new Enemy { Health = 3 };
        int? value = a % 2 == 0 ? null : a;
        int result = value ??= 5;
        int? other = null;
        long wide = (other ??= 6) + 0L;
        int? first = a > 3 ? a : null;
        int? chained = first ??= Maybe(a);
        return made.Health * 100000 + again.Health * 10000 + made.Target.Health * 1000 + result * 100 + (value ?? -1) * 10
            + (int)wide + (chained ?? -50) * 1000000;
    }

    public static int UserOperators(int a, int b)
    {
        Vec? x = a % 3 == 0 ? null : new Vec { X = a };
        Vec? y = b % 3 == 0 ? null : new Vec { X = b };
        Vec? sum = x + y;
        Vec? negated = -x;
        Vec? incremented = x;
        incremented++;
        Vec? accumulated = y;
        accumulated += x;
        int flags = (x == y ? 1 : 0) + (x != y ? 2 : 0) + (x < y ? 4 : 0) + (x > y ? 8 : 0) + (x == null ? 16 : 0);
        return flags + (sum?.X ?? -1) * 100 + (negated?.X ?? -2) * 10000 + (incremented?.X ?? -3) * 1000000
            + (accumulated?.X ?? -4) * 100000000;
    }

    public static int Tuple(int a)
    {
        (int?, string) pair = (Maybe(a), "t");
        var (number, _) = pair;
        return (number ?? -1) + (pair == (null, "t") ? 100 : 0);
    }
}
