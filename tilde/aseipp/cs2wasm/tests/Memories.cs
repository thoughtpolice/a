// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Memories
{
    public sealed class Buffer
    {
        public Memory<int> Window;
        public ReadOnlyMemory<char> Name;
        public readonly List<ReadOnlyMemory<int>> Parts = new List<ReadOnlyMemory<int>>();
    }

    public struct Chunk
    {
        public Memory<byte> Bytes;
        public int Tag;
    }

    // Memory<T> and ReadOnlyMemory<T> against the CLR: over arrays and
    // strings, sliced (with ranges too), written through Span, copied,
    // compared, printed, stored in fields, structs, collections and
    // closures, and their argument checks.
    public static class Memories
    {
        private static int Digest(string text)
        {
            int digest = text.Length;
            foreach (char c in text)
            {
                digest = unchecked(digest * 31 + c);
            }

            return digest;
        }

        private static int Digest<T>(ReadOnlySpan<T> span)
        {
            int digest = span.Length;
            foreach (T value in span)
            {
                digest = unchecked(digest * 31 + value.GetHashCode());
            }

            return digest;
        }

        public static int Arrays(int x)
        {
            int[] data = { 1, 2, 3, 4, 5, 6, 7 };
            Memory<int> all = data;
            Memory<int> middle = all.Slice(1, 4);
            middle.Span[0] = x;
            Memory<int> tail = data.AsMemory(x & 3);
            Memory<int> ranged = all[2..^1];
            ReadOnlyMemory<int> view = middle;
            int digest = Digest<int>(data) * 31 + Digest(view.Span);
            digest = unchecked(digest * 31 + tail.Length * 100 + ranged.Span[0] + data.AsMemory(1..3).Length * 7);
            digest = unchecked(digest * 31 + middle.ToArray()[1] + (Memory<int>.Empty.IsEmpty ? 1 : 0) + all.Length);
            Memory<int> target = new int[9];
            middle.CopyTo(target.Slice(2));
            digest = unchecked(digest * 31 + Digest<int>(target.Span) + (all.TryCopyTo(middle) ? 1 : 0) + (middle.TryCopyTo(target) ? 2 : 0));
            return digest;
        }

        public static int Strings(int x)
        {
            string text = "memory, spans and strings";
            ReadOnlyMemory<char> whole = text.AsMemory();
            ReadOnlyMemory<char> part = text.AsMemory(x & 7, 5);
            ReadOnlyMemory<char> again = text.AsMemory(x & 7, 5);
            int digest = Digest(part.ToString()) + Digest(whole.Slice(8).ToString()) * 3;
            digest = unchecked(digest * 31 + (part.Equals(again) ? 1 : 0) + (part.Equals((object)again) ? 2 : 0)
                               + (whole.Equals(text.AsMemory()) ? 4 : 0) + (part.Equals(part.Slice(0)) ? 8 : 0));
            digest = unchecked(digest * 31 + part.Span.IndexOf('s') + whole.Span.LastIndexOf(' ') * 10);
            digest = unchecked(digest * 31 + Digest(text.AsMemory(..6).ToString()) + Digest(new string(part.Span)));
            ReadOnlyMemory<char> copy = text.ToCharArray();
            digest = unchecked(digest * 31 + (copy.Equals(whole) ? 1 : 0) + Digest(copy.Slice(2, 3).ToString()));
            return digest;
        }

        public static int Storage(int x)
        {
            var buffer = new Buffer { Window = new int[] { x, x + 1, x + 2, x + 3 }, Name = "buffer".AsMemory(1) };
            buffer.Parts.Add(buffer.Window);
            buffer.Parts.Add(buffer.Window.Slice(2));
            var chunk = new Chunk { Bytes = new byte[] { 1, 2, 3 }, Tag = x };
            var chunks = new[] { chunk, chunk };
            chunks[1].Bytes = chunks[1].Bytes.Slice(1);
            Func<int> sum = () =>
            {
                int total = 0;
                foreach (var part in buffer.Parts)
                {
                    total += part.Span[0] * part.Length;
                }

                return total;
            };
            buffer.Window.Span[2] = 100;
            var byKey = new Dictionary<int, Memory<int>> { [1] = buffer.Window };
            return unchecked(sum() * 31 + chunks[0].Bytes.Length * 10 + chunks[1].Bytes.Span[0] + byKey[1].Span[3]
                             + Digest(buffer.Name.ToString()) + (buffer.Parts[0].Equals(buffer.Window) ? 1000 : 0));
        }

        public static int Text(int x)
        {
            Memory<int> ints = new int[x & 7];
            ReadOnlyMemory<char> none = default;
            Memory<char> chars = "chars".ToCharArray();
            Memory<char> empty = default;
            return unchecked(Digest(ints.ToString()) + Digest(none.ToString()) * 3 + Digest(chars.Slice(1).ToString()) * 7
                             + Digest(((ReadOnlyMemory<int>)ints).ToString()) * 11 + Digest(empty.ToString()) * 13
                             + Digest(chars.Span.ToString()) * 17);
        }

        public static int Checks(int which)
        {
            int[] data = new int[4];
            try
            {
                switch (which)
                {
                    case 0:
                        return data.AsMemory(3, 2).Length;
                    case 1:
                        return data.AsMemory(5).Length;
                    case 2:
                        return ((Memory<int>)data).Slice(-1).Length;
                    case 3:
                        return new Memory<int>(null, 1, 0).Length;
                    case 4:
                        return "abc".AsMemory(4).Length;
                    case 5:
                        return new ReadOnlyMemory<int>(null).Length + new Memory<int>(null, 0, 0).Length;
                    case 6:
                        ((Memory<int>)new int[5]).CopyTo(data);
                        return 0;
                    default:
                        return ((ReadOnlyMemory<int>)data).Slice(2, 3).Length;
                }
            }
            catch (ArgumentOutOfRangeException)
            {
                return -1;
            }
            catch (ArgumentException)
            {
                return -2;
            }
        }
    }
}
