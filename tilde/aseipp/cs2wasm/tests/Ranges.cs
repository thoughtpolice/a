// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Ranges;

// A class C# indexes implicitly: a Count, an int indexer and a Slice.
public sealed class Ring
{
    private readonly int[] items;

    public Ring(int count)
    {
        if (count < 0)
        {
            throw new ArgumentOutOfRangeException();
        }

        items = new int[count];
        for (int index = 0; index < count; index++)
        {
            items[index] = index * index;
        }
    }

    public int Count => items.Length;

    public int this[int index]
    {
        get => items[index];
        set => items[index] = value;
    }

    public Ring Slice(int start, int length)
    {
        var ring = new Ring(length);
        for (int index = 0; index < length; index++)
        {
            ring.items[index] = items[start + index];
        }

        return ring;
    }

    public int Sum()
    {
        int sum = 0;
        foreach (int item in items)
        {
            sum += item;
        }

        return sum;
    }
}

public struct Pair
{
    public int First;
    public int Second;

    public int Length => 2;

    public int this[int index] => index == 0 ? First : index == 1 ? Second : throw new IndexOutOfRangeException();
}

// Indices, ranges, implicit indexers, list patterns and tuple patterns,
// against the CLR.
public static class Ranges
{
    private static int[] Numbers(int length)
    {
        var numbers = new int[length];
        for (int index = 0; index < length; index++)
        {
            numbers[index] = index * 7 + 1;
        }

        return numbers;
    }

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

    private static int Digest(int[] values)
    {
        int digest = values.Length;
        foreach (int value in values)
        {
            digest = unchecked(digest * 31 + value);
        }

        return digest;
    }

    public static int FromEnd(int length, int back) => Numbers(length)[^back];

    public static int Stored(int length, int at, bool fromEnd)
    {
        Index index = fromEnd ? ^at : at;
        var numbers = Numbers(length);
        return numbers[index] * 10 + (index.IsFromEnd ? 1 : 0) + index.Value * 100 + index.GetOffset(length) * 10000;
    }

    public static int Assign(int length, int back)
    {
        var numbers = Numbers(length);
        numbers[^back] = -5;
        numbers[^back] += 3;
        numbers[^back]++;
        return Digest(numbers);
    }

    public static int Slice(int length, int start, int end) => Digest(Numbers(length)[start..end]);

    public static int SliceFromEnd(int length, int start, int back) => Digest(Numbers(length)[start..^back]);

    public static int OpenEnds(int length, int at, int which) => which switch
    {
        0 => Digest(Numbers(length)[at..]),
        1 => Digest(Numbers(length)[..at]),
        2 => Digest(Numbers(length)[..]),
        3 => Digest(Numbers(length)[^at..]),
        _ => Digest(Numbers(length)[..^at]),
    };

    public static int RangeValues(int start, int end, int length)
    {
        Range range = start..^end;
        var (offset, count) = range.GetOffsetAndLength(length);
        return offset * 1000 + count + (range.Start.Value * 7 + range.End.Value * 13) * 100000;
    }

    public static int IndexMembers(int value)
    {
        var start = Index.FromStart(value);
        var end = Index.FromEnd(value);
        var made = new Index(value, true);
        return (start.Equals(made) ? 1 : 0) + (end.Equals(made) ? 2 : 0) + (Index.Start.GetOffset(9) * 4)
            + Index.End.GetOffset(9) * 40 + (made.Equals((object)end) ? 1000 : 0);
    }

    public static int Texts(int value)
    {
        Index index = ^value;
        Range range = 1..^value;
        Range open = ..;
        return index.ToString().Length * 100 + range.ToString().Length * 10 + open.ToString().Length;
    }

    public static int TextOf(int value) => Digest((^value).ToString() + "|" + (value..^2).ToString() + "|" + (..value).ToString());

    public static int Strings(int back)
    {
        string text = "abcdefghij";
        return text[^back] + text[1..^back].Length * 1000;
    }

    public static int Substrings(int start, int back) => Digest("The quick brown fox"[start..^back]);

    public static int Lists(int count, int back)
    {
        var list = new List<int>();
        for (int index = 0; index < count; index++)
        {
            list.Add(index * 3);
        }

        list[^back] = 100;
        list[^1] += 7;
        return list[^back] * 1000 + list[^1] + Digest(list[1..^back].ToArray()) % 1000 * 100000;
    }

    public static int Custom(int count, int back)
    {
        var ring = new Ring(count);
        ring[^back] = 5;
        return ring[^back] * 1000 + ring[^1] + ring[1..^back].Sum() * 100000;
    }

    public static int Struct(int first, int second)
    {
        var pair = new Pair { First = first, Second = second };
        return pair[^1] * 100 + pair[^2] + (pair is [var a, var b] ? a * 7 + b * 11 : -1) * 10000;
    }

    public static int Patterns(int length)
    {
        var numbers = Numbers(length);
        return numbers switch
        {
            [] => 0,
            [var only] => only * 10,
            [1, 8] => 20,
            [1, _, var third] => third * 1000,
            [var first, .., var last] when last > 60 => first + last * 100,
            [_, _, .. var middle, _] => Digest(middle),
            _ => -7,
        };
    }

    public static int Nested(int a, int b)
    {
        int[][] grid = [[a, b], [b, a, a], []];
        int result = 0;
        foreach (var row in grid)
        {
            result = result * 10 + row switch
            {
                [] => 1,
                [> 5, ..] => 2,
                [_, < 3] => 3,
                [.., 4] => 4,
                _ => 5,
            };
        }

        return result;
    }

    public static int StringPatterns(int which)
    {
        string text = which switch
        {
            0 => "",
            1 => "a",
            2 => "ab",
            3 => "abc",
            4 => "xyzzy",
            _ => null,
        };
        return text switch
        {
            null => -1,
            [] => 0,
            ['a'] => 1,
            ['a', 'b'] => 2,
            ['a', .. var rest] => 30 + rest.Length,
            [var first, .. var middle, var last] => first * 1000 + middle.Length * 10 + (last == 'y' ? 1 : 0),
            _ => -9,
        };
    }

    public static int ListPatterns(int count)
    {
        var list = new List<int>();
        for (int index = 0; index < count; index++)
        {
            list.Add(index + 1);
        }

        return list switch
        {
            [] => 0,
            [var one] => one,
            [1, 2, .. var rest] when rest.Count > 1 => 100 + rest.Count * 10 + rest[^1],
            [.., var last] => last * 1000,
        };
    }

    public static int Declared(int length)
    {
        object value = Numbers(length);
        if (value is int[] and [_, var second, ..] all)
        {
            return second * 100 + all.Length;
        }

        return -1;
    }

    public static int Tuples(int a, int b) => (a, b) switch
    {
        (0, 0) => 1,
        (0, _) => 2,
        (_, 0) => 3,
        ( > 5, < 5) => 4,
        (var x, var y) when x == y => 5 + x,
        _ => 6,
    };

    public static int TuplePattern(int a, int b)
    {
        var pair = (Name: a, Count: b);
        return pair is (1, var count) ? count : pair is ( > 2, _) and { Count: 3 } ? 30 : -1;
    }

    public static int Faults(int which)
    {
        var numbers = Numbers(3);
        int[] none = null;
        return which switch
        {
            0 => numbers[^0],
            1 => numbers[^4],
            2 => numbers[2..1].Length,
            3 => numbers[..5].Length,
            4 => none[^1],
            5 => none[1..].Length,
            6 => "abc"[^4],
            7 => "abc"[2..5].Length,
            8 => new List<int>()[^1],
            _ => Index.FromEnd(-which).Value,
        };
    }
}
