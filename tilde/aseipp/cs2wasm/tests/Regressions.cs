// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Generic;

namespace Tests.Regressions;

public enum Shade
{
    Dark,
    Light,
}

public struct Cell
{
    public int F;

    public void Bump() => F++;
}

public record struct Entry(bool B, int X, string S);

public sealed class Marker
{
}

public union Flag(bool, string);

public union Holder(Marker, Entry, string);

public union Number(int, long, double);

public sealed class Tracker : System.IDisposable
{
    public int Disposed;

    public void Dispose() => Disposed++;
}

public struct Counter : System.IDisposable
{
    public int Count;

    public void Add() => Count++;

    public void Dispose() => Count += 100;
}

// Minimized miscompilations and rejections the differential fuzzer found,
// each against the CLR.
public class Keyed
{
    public int V;

    public override bool Equals(object obj) => obj is Keyed other && other.V == V;

    public override int GetHashCode() => V;
}

public struct KeyedPair
{
    public Keyed Key;
    public int N;
}

public static class Regressions
{
    // A boxed struct whose first field is a class overriding Equals: the
    // box's Equals and GetHashCode read that field as a local of its own
    // (an invalid module, the struct's first local standing for all of it).
    public static int BoxedStructKeys(int x)
    {
        object a = new KeyedPair { Key = new Keyed { V = x & 3 }, N = x };
        object b = new KeyedPair { Key = new Keyed { V = x & 1 }, N = x };
        object c = new KeyValuePair<Keyed, int>(new Keyed { V = x }, 2);
        object d = new KeyValuePair<Keyed, int>(x > 0 ? new Keyed { V = x } : null, 2);
        var set = new HashSet<KeyedPair> { (KeyedPair)a, (KeyedPair)b };
        return (a.Equals(b) ? 1 : 0) + (c.Equals(d) ? 2 : 0) + set.Count * 4 + (a.GetHashCode() == b.GetHashCode() ? 8 : 0);
    }

    private static object Make(int k) => k switch
    {
        0 => 5,
        1 => 2,
        2 => 7L,
        3 => "s",
        4 => 'c',
        5 => 2.5,
        6 => true,
        7 => Shade.Light,
        8 => (byte)5,
        _ => null,
    };

    // A declaration pattern for a value type nothing else boxes.
    public static int UnboxedDeclaration(int x)
    {
        object o = x;
        int result = o is bool b && b ? 1 : 0;
        switch (o)
        {
            case char c:
                return result + c;
            case float f:
                return result + (int)f;
            case Cell s:
                return result + s.F;
            case Entry e:
                return result + e.X;
            case uint u:
                return result + (int)u;
            default:
                return result - 1;
        }
    }

    // `new U(value)` of a value type case boxes it, as `(U)value` does.
    public static int UnionConstructor(int which)
    {
        var flag = new Flag(which > 0);
        var holders = new List<Holder> { new Holder(new Entry(false, which, "abc")), new Holder("text"), new Holder(new Marker()) };
        var number = which switch { 0 => new Number(which), 1 => new Number(5L), _ => new Number(2.5) };
        int total = flag is bool ? 1 : 0;
        foreach (var holder in holders)
        {
            total = total * 10 + holder switch { Marker => 1, Entry e => 2 + e.X, string s => 5 + s.Length, null => 0 };
        }

        return total * 10 + number switch { int => 1, long => 2, double => 3, null => 4 };
    }

    // A mutating member called on a foreach or using variable mutates it.
    public static int IterationVariable(int length)
    {
        var items = new Cell[length];
        int seen = 0;
        foreach (var cell in items)
        {
            cell.Bump();
            cell.Bump();
            seen += cell.F;
        }

        var list = new List<Cell> { default, default };
        foreach (var cell in list)
        {
            cell.Bump();
            seen += cell.F * 100;
        }

        foreach (var cell in items)
        {
            System.Func<int> read = () => cell.F;
            cell.Bump();
            seen += read() * 3;
        }

        using (var counter = new Counter())
        {
            counter.Add();
            seen += counter.Count * 1000;
        }

        using var declared = new Counter();
        declared.Add();
        declared.Add();
        return seen + declared.Count * 10000 + (length > 0 ? items[0].F : -1) + list[0].F * 7;
    }

    private static readonly string[] Texts = ["", "a", "ab", "abc", "abd", "b", "B", "hello", "hellp", "é", "￿", null, "hello\ud83d\ude00", "helloa", "hell", "abcde", "abcdf", "abcdefg"];

    // CompareOrdinal as the CLR's: within the first two chars, the
    // terminator after a shorter string compares with the longer string's
    // next char; past them, the length difference decides.
    public static int CompareOrdinal(int left, int right) =>
        string.CompareOrdinal(Texts[left % Texts.Length], Texts[right % Texts.Length]);

    public static int CompareOrdinalComparison(int left, int right) =>
        string.Compare(Texts[left % Texts.Length], Texts[right % Texts.Length], System.StringComparison.Ordinal);

    public static int CompareIgnoreCase(int left, int right) =>
        string.Compare(Texts[left % Texts.Length], Texts[right % Texts.Length], System.StringComparison.OrdinalIgnoreCase);

    // Constant and relational patterns on objects.
    public static int ObjectConstants(int k)
    {
        object o = Make(k);
        int result = o is 5 ? 1 : 0;
        result = result * 10 + (o is "s" ? 1 : 0);
        result = result * 10 + (o is 7L ? 1 : 0);
        result = result * 10 + (o is 'c' or true ? 1 : 0);
        result = result * 10 + (o is 2.5 ? 1 : 0);
        result = result * 10 + (o is Shade.Light ? 1 : 0);
        result = result * 10 + (o is (byte)5 ? 1 : 0);
        result = result * 10 + (o is null ? 1 : 0);
        return result;
    }

    public static int ObjectRelations(int k)
    {
        object o = Make(k);
        int result = o switch { int i and > 3 => i, long => 9, _ => 0 };
        result = result * 10 + (o is > 1 and < 6 ? 1 : 0);
        result = result * 10 + (o is >= 2.0 ? 1 : 0);
        result = result * 10 + (o is not > 'b' ? 1 : 0);
        result = result * 10 + o switch { 7L => 1, 5 => 2, "s" => 3, _ => 0 };
        return result;
    }

    public static int GenericConstant<T>(T value) => value is 5 ? 1 : value is "s" ? 2 : 0;

    public static int Generic(int k) => GenericConstant(Make(k)) * 10 + GenericConstant(k) + GenericConstant("s") * 100;

    public static int UnionConstants(int which)
    {
        Number number = which switch { 0 => 5, 1 => 5L, _ => 2.5 };
        return (number is 5 ? 1 : 0) + (number is 5L ? 10 : 0) + (number is > 2.0 ? 100 : 0);
    }

    private static void Increment(ref int value) => value++;

    private static void Reset(out string text) => text = "reset";

    // A captured variable (by a lambda or a filter) passed by reference.
    public static int CapturedByReference(int x)
    {
        int count = x;
        string text = null;
        System.Func<int> read = () => count * 10 + (text?.Length ?? 0);
        Increment(ref count);
        Reset(out text);
        int seen = x;
        try
        {
            if (x > 1)
            {
                throw new System.InvalidOperationException();
            }
        }
        catch (System.Exception) when (seen > 2)
        {
            Increment(ref seen);
        }
        catch (System.Exception)
        {
            seen -= 100;
        }

        return read() * 1000 + seen;
    }

    // A scalar's Equals overloads.
    public static int ScalarEquals(double x, double y)
    {
        int result = x.Equals((object)y) ? 1 : 0;
        result = result * 10 + (x.Equals(y) ? 1 : 0);
        result = result * 10 + (((float)x).Equals((float)y) ? 1 : 0);
        result = result * 10 + (((float)x).Equals((object)y) ? 1 : 0);
        result = result * 10 + (((int)x).Equals((int)y) ? 1 : 0);
        result = result * 10 + (((long)x).Equals((object)(long)y) ? 1 : 0);
        result = result * 10 + (((int)x).Equals((object)(long)y) ? 1 : 0);
        result = result * 10 + ((x > 0).Equals(y > 0) ? 1 : 0);
        result = result * 10 + (((char)x).Equals((object)(char)y) ? 1 : 0);
        return result;
    }
}
