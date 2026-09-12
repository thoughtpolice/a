// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Sorting;

public sealed class Item
{
    public int Key;
    public int Id;
}

public enum Rank : byte
{
    Low = 3,
    High = 200,
    Middle = 50,
}

// Sorting, searching and the array and list helpers, and seeded random
// sequences, against the CLR's element order and values.
public static class Sorting
{
    private static int Mix(int digest, int value) => unchecked(digest * 31 + value);

    // A deterministic source of test data of its own.
    private static int[] Data(int seed, int length, int spread)
    {
        var data = new int[length];
        uint state = (uint)seed * 2654435761u + 12345;
        for (int index = 0; index < length; index++)
        {
            state = state * 1664525u + 1013904223u;
            data[index] = (int)(state >> 8) % spread;
        }

        return data;
    }

    private static int Digest(int[] values)
    {
        int digest = values.Length;
        foreach (int value in values)
        {
            digest = Mix(digest, value);
        }

        return digest;
    }

    public static int SortInts(int seed, int length)
    {
        var data = Data(seed, length, 1000);
        Array.Sort(data);
        return Digest(data);
    }

    public static int SortDoubles(int seed, int length)
    {
        var raw = Data(seed, length, 20);
        var data = new double[length];
        for (int index = 0; index < length; index++)
        {
            data[index] = raw[index] switch
            {
                0 => double.NaN,
                1 => -0.0,
                2 => 0.0,
                3 => double.NegativeInfinity,
                4 => -double.NaN,
                _ => raw[index] / 3.0 - 3,
            };
        }

        Array.Sort(data);
        int digest = length;
        foreach (double value in data)
        {
            digest = Mix(digest, (int)BitConverter.DoubleToInt64Bits(value) ^ (int)(BitConverter.DoubleToInt64Bits(value) >> 32));
        }

        return digest;
    }

    // Ties keep the CLR's unstable order.
    public static int SortStable(int seed, int length)
    {
        var raw = Data(seed, length, 7);
        var items = new List<Item>();
        for (int index = 0; index < length; index++)
        {
            items.Add(new Item { Key = raw[index], Id = index });
        }

        items.Sort((a, b) => a.Key.CompareTo(b.Key));
        int digest = length;
        foreach (var item in items)
        {
            digest = Mix(digest, item.Id * 10 + item.Key);
        }

        var array = items.ToArray();
        Array.Sort(array, (a, b) => b.Id % 3 - a.Id % 3);
        foreach (var item in array)
        {
            digest = Mix(digest, item.Id);
        }

        return digest;
    }

    public static int SortOthers(int seed, int length)
    {
        var raw = Data(seed, length, 300);
        var chars = new char[length];
        var ranks = new Rank[length];
        var bools = new bool[length];
        var longs = new List<long>();
        for (int index = 0; index < length; index++)
        {
            chars[index] = (char)('A' + raw[index] % 50);
            ranks[index] = (raw[index] % 3) switch { 0 => Rank.Low, 1 => Rank.High, _ => Rank.Middle };
            bools[index] = raw[index] % 2 == 0;
            longs.Add((long)raw[index] * -1000000007);
        }

        Array.Sort(chars);
        Array.Sort(ranks);
        Array.Sort(bools);
        longs.Sort();
        int digest = length;
        for (int index = 0; index < length; index++)
        {
            digest = Mix(Mix(Mix(Mix(digest, chars[index]), (int)ranks[index]), bools[index] ? 1 : 0), (int)longs[index]);
        }

        return digest;
    }

    public static int Ranges(int seed, int length)
    {
        var data = Data(seed, length, 50);
        int start = length / 4;
        int count = length / 2;
        Array.Sort(data, start, count);
        Array.Reverse(data, 0, length / 3);
        int digest = Digest(data);
        digest = Mix(digest, Array.IndexOf(data, 7));
        digest = Mix(digest, Array.IndexOf(data, 7, length / 2));
        digest = Mix(digest, Array.LastIndexOf(data, 7));
        Array.Sort(data);
        digest = Mix(digest, Array.BinarySearch(data, 25));
        digest = Mix(digest, Array.BinarySearch(data, 1000));
        digest = Mix(digest, Array.BinarySearch(data, -1));
        Array.Fill(data, 9, 0, length / 5);
        Array.Resize(ref data, length + 3);
        return Mix(digest, Digest(data));
    }

    public static int Helpers(int seed, int length)
    {
        var data = Data(seed, length, 100);
        int digest = Array.FindIndex(data, x => x > 50);
        digest = Mix(digest, Array.FindLastIndex(data, x => x < 10));
        digest = Mix(digest, Array.Find(data, x => x % 7 == 3));
        digest = Mix(digest, Array.FindLast(data, x => x % 7 == 3));
        digest = Mix(digest, Array.Exists(data, x => x == 42) ? 1 : 0);
        digest = Mix(digest, Array.TrueForAll(data, x => x < 100) ? 1 : 0);
        digest = Mix(digest, Digest(Array.FindAll(data, x => x % 2 == 0)));
        var strings = Array.ConvertAll(data, x => "v" + x);
        digest = Mix(digest, strings.Length > 0 ? strings[0].Length : -1);
        int sum = 0;
        Array.ForEach(data, x => sum += x);
        digest = Mix(digest, sum);
        digest = Mix(digest, Array.Empty<int>().Length + (ReferenceEquals(Array.Empty<string>(), Array.Empty<string>()) ? 1 : 0));
        return digest;
    }

    public static int Lists(int seed, int length)
    {
        var data = Data(seed, length, 40);
        var list = new List<int>(data);
        list.AddRange(new[] { 1, 2, 3 });
        list.InsertRange(1, new List<int> { 7, 8 });
        list.RemoveRange(0, Math.Min(2, list.Count));
        var range = list.GetRange(1, list.Count / 2);
        int digest = Digest(range.ToArray());
        digest = Mix(digest, list.IndexOf(3, 1));
        digest = Mix(digest, list.LastIndexOf(8));
        digest = Mix(digest, list.FindLastIndex(x => x > 20));
        digest = Mix(digest, list.FindAll(x => x < 5).Count);
        var halves = list.ConvertAll(x => x / 2.0);
        digest = Mix(digest, (int)(halves[0] * 10));
        list.Reverse(0, list.Count / 2);
        list.Sort();
        digest = Mix(digest, list.BinarySearch(20));
        var array = new int[list.Count + 2];
        list.CopyTo(array, 1);
        digest = Mix(digest, Digest(array));
        list.Sort((a, b) => b.CompareTo(a));
        digest = Mix(digest, Digest(list.ToArray()));
        digest = Mix(digest, list.EnsureCapacity(3) >= list.Count ? 1 : 0);
        return digest;
    }

    public static int Faults(int which)
    {
        var list = new List<int> { 3, 1, 2 };
        var array = new[] { 3, 1, 2 };
        switch (which)
        {
            case 0:
                list.Sort((a, b) => a == 1 ? throw new InvalidOperationException() : a - b);
                return 0;
            case 1:
                Array.Sort(array, 2, 5);
                return 1;
            case 2:
                list.GetRange(2, 5);
                return 2;
            case 3:
                list.RemoveRange(-1, 1);
                return 3;
            case 4:
                Array.Sort(array, (Comparison<int>)null);
                return 4;
            case 5:
                Array.Resize(ref array, -1);
                return 5;
            default:
                Array.IndexOf(array, 1, 5);
                return 6;
        }
    }

    public static long Sequence(int seed, int which)
    {
        var random = new Random(seed);
        long digest = 0;
        for (int index = 0; index < 20; index++)
        {
            long value = which switch
            {
                0 => random.Next(),
                1 => random.Next(1000),
                2 => random.Next(-50, 50),
                3 => random.Next(int.MinValue, int.MaxValue),
                4 => BitConverter.DoubleToInt64Bits(random.NextDouble()),
                5 => random.NextInt64(),
                6 => random.NextInt64(1000000000000),
                7 => random.NextInt64(-5, 3),
                8 => BitConverter.SingleToInt32Bits(random.NextSingle()),
                _ => random.Next(0),
            };
            digest = digest * 31 + value;
        }

        return digest;
    }

    public static int RandomCollections(int seed)
    {
        var random = new Random(seed);
        var bytes = new byte[13];
        random.NextBytes(bytes);
        var values = new[] { 1, 2, 3, 4, 5, 6, 7 };
        random.Shuffle(values);
        var picked = random.GetItems(new[] { 10, 20, 30 }, 5);
        int digest = 0;
        foreach (byte value in bytes)
        {
            digest = Mix(digest, value);
        }

        return Mix(Mix(digest, Digest(values)), Digest(picked));
    }

    public static int RandomFaults(int which)
    {
        var random = new Random(1);
        return which switch
        {
            0 => random.Next(-1),
            1 => random.Next(5, 1),
            _ => (int)random.NextInt64(-1),
        };
    }

    // Unseeded generators are sequences of their own; only their ranges
    // are the CLR's.
    public static int Unseeded(int count)
    {
        var random = new Random();
        int inRange = 0;
        for (int index = 0; index < count; index++)
        {
            int value = random.Next(10, 20);
            double fraction = Random.Shared.NextDouble();
            inRange += value >= 10 && value < 20 && fraction >= 0 && fraction < 1 ? 1 : 0;
        }

        return inRange;
    }
}
