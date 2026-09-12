// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Tests.Spans;

public struct Particle
{
    public int X;
    public int Life;
}

public static class Spans
{
    private static int Digest(ReadOnlySpan<int> values)
    {
        int digest = values.Length;
        foreach (int value in values)
        {
            digest = unchecked(digest * 31 + value);
        }

        return digest;
    }

    private static int Digest(string text)
    {
        int digest = text.Length;
        foreach (char c in text)
        {
            digest = unchecked(digest * 31 + c);
        }

        return digest;
    }

    private static int Sum(params ReadOnlySpan<int> values)
    {
        int sum = 0;
        for (int i = 0; i < values.Length; i++)
        {
            sum += values[i] * (i + 1);
        }

        return sum;
    }

    private static Span<int> Middle(int[] array) => array.AsSpan(1, array.Length - 2);

    public static int Views(int x)
    {
        int[] array = { 1, 2, 3, 4, 5, 6, x };
        Span<int> all = array;
        var middle = Middle(array);
        middle[0] = 20;
        ref int last = ref middle[middle.Length - 1];
        last += x;
        int digest = Digest(array) + Digest(middle) * 3;
        var slice = all.Slice(2, 3);
        slice.Fill(x);
        digest = unchecked(digest * 31 + Digest(array) + slice.Length + (slice.IsEmpty ? 1 : 0));
        all[..2].Clear();
        digest = unchecked(digest * 31 + Digest(array) + all[^1] + Digest(all[1..^1]));
        foreach (ref int value in all)
        {
            value *= 2;
        }

        digest = unchecked(digest * 31 + Digest(array) + Digest(all.ToArray()));
        return unchecked(digest * 31 + (all.Slice(1) == all.Slice(1) ? 1 : 0) + (all.Slice(1) == all.Slice(2) ? 2 : 0)
            + (Span<int>.Empty.IsEmpty ? 4 : 0));
    }

    public static int Copies(int x)
    {
        int[] array = { 1, 2, 3, 4, 5, 6, 7, 8 };
        Span<int> span = array;
        span.Slice(0, 5).CopyTo(span.Slice(2));
        int digest = Digest(array);
        span.Slice(3).CopyTo(span);
        digest = unchecked(digest * 31 + Digest(array));
        Span<int> small = stackalloc int[3];
        bool copied = span.TryCopyTo(small);
        span.Slice(0, 3).CopyTo(small);
        digest = unchecked(digest * 31 + Digest(small) + (copied ? 1 : 0));
        Span<int> made = stackalloc[] { x, x + 1, x * 3 };
        Span<int> sized = stackalloc int[4] { 9, 8, 7, x };
        Span<long> zeros = stackalloc long[Math.Abs(x) % 5];
        digest = unchecked(digest * 31 + Digest(made) + Digest(sized) + zeros.Length);
        Span<int> collected = [x, 2, 3];
        ReadOnlySpan<int> readOnly = [7, x];
        return unchecked(digest * 31 + Digest(collected) + Digest(readOnly) + Sum(1, 2, x) + Sum(array) + Sum());
    }

    public static int Searching(int x)
    {
        int[] array = { 5, x, 3, 9, x, 1 };
        Span<int> span = array;
        int digest = span.IndexOf(x) * 10 + span.LastIndexOf(x) + (span.Contains(9) ? 100 : 0);
        ReadOnlySpan<int> other = new int[] { 5, x, 3 };
        digest = unchecked(digest * 31 + (span.SequenceEqual(array) ? 1 : 0) + (((ReadOnlySpan<int>)span).StartsWith(other) ? 2 : 0));
        span.Reverse();
        digest = unchecked(digest * 31 + Digest(array));
        span.Sort();
        digest = unchecked(digest * 31 + Digest(array) + ((ReadOnlySpan<int>)span).BinarySearch(9));
        span.Sort((a, b) => b - a);
        return unchecked(digest * 31 + Digest(array));
    }

    public static int Text(int x)
    {
        string text = "  hello, world " + x + "  ";
        ReadOnlySpan<char> span = text;
        var trimmed = span.Trim();
        int digest = Digest(trimmed.ToString()) + trimmed.Length;
        var word = trimmed.Slice(0, 5);
        digest = unchecked(digest * 31 + Digest(word.ToString()) + word.IndexOf('l') + (word.StartsWith("he".AsSpan()) ? 1 : 0));
        digest = unchecked(digest * 31 + (text.AsSpan(2, 5).Equals("HELLO", StringComparison.OrdinalIgnoreCase) ? 1 : 0));
        digest = unchecked(digest * 31 + Digest(text.AsSpan(3).ToString()) + Digest(new int[] { 1, 2 }.AsSpan().ToString()));
        char[] chars = new char[4];
        Span<char> buffer = chars;
        buffer.Fill('z');
        buffer[1] = (char)('a' + (x & 7));
        digest = unchecked(digest * 31 + Digest(string.Concat(word, trimmed.Slice(5))) + Digest(new string(word)));
        return unchecked(digest * 31 + Digest(new string(chars)) + Digest(buffer.ToString()));
    }

    public static int Structs(int x)
    {
        var particles = new Particle[4];
        Span<Particle> span = particles;
        span[1].X = x;
        span[2].Life = 3;
        foreach (ref Particle particle in span)
        {
            particle.Life += 10;
        }

        var list = new List<int> { 1, 2, x };
        var view = CollectionsMarshal.AsSpan(list);
        view[0] = 100;
        return unchecked(particles[1].X * 1000 + particles[2].Life * 10 + particles[0].Life + list[0] + view.Length);
    }

    public static int Faults(int which)
    {
        int[] array = { 1, 2, 3 };
        Span<int> span = array;
        switch (which)
        {
            case 0:
                return span[3];
            case 1:
                return span.Slice(4).Length;
            case 2:
                return span.Slice(1, 3).Length;
            case 3:
                span.CopyTo(stackalloc int[2]);
                return 0;
            case 4:
                return span.Slice(-1, 1).Length;
            case 5:
                return new Span<int>(array, 2, 2).Length;
            case 6:
                return array.AsSpan(-1).Length;
            default:
                return "abc".AsSpan(1, 5).Length;
        }
    }
}
