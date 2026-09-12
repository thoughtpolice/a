// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Span<T> and ReadOnlySpan<T> (see Frontend.Spans): a view of part of a GC
// array, as a struct of the array, the start and the length, with .NET's
// members, checks and exceptions. A span over a string views a copy of its
// chars (strings are immutable, so no one can tell); stackalloc makes a
// fresh array. MemoryExtensions and CollectionsMarshal.AsSpan, which the
// framework reference lacks, are here too.

namespace Gameplay.Runtime
{
    using System;

    internal readonly struct Span<T>
    {
        internal readonly T[] array;
        internal readonly int start;
        internal readonly int length;

        public Span(T[] array)
        {
            this.array = array;
            start = 0;
            length = array == null ? 0 : array.Length;
        }

        public Span(T[] array, int start, int length)
        {
            if (array == null)
            {
                if (start != 0 || length != 0)
                {
                    throw new ArgumentOutOfRangeException();
                }

                this.array = null;
                this.start = 0;
                this.length = 0;
                return;
            }

            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)array.Length)
            {
                throw new ArgumentOutOfRangeException();
            }

            this.array = array;
            this.start = start;
            this.length = length;
        }

        internal Span(T[] array, int start, int length, bool unchecked_)
        {
            this.array = array;
            this.start = start;
            this.length = length;
        }

        public static Span<T> Empty => default;

        public int Length => length;

        public bool IsEmpty => length == 0;

        public ref T this[int index]
        {
            get
            {
                if ((uint)index >= (uint)length)
                {
                    throw new IndexOutOfRangeException();
                }

                return ref array[start + index];
            }
        }

        public Span<T> Slice(int start)
        {
            if ((uint)start > (uint)length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new Span<T>(array, this.start + start, length - start, true);
        }

        public Span<T> Slice(int start, int length)
        {
            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)this.length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new Span<T>(array, this.start + start, length, true);
        }

        public void CopyTo(Span<T> destination)
        {
            if ((uint)length > (uint)destination.length)
            {
                throw new ArgumentException("Destination is too short.", "destination");
            }

            Spans.Move(array, start, destination.array, destination.start, length);
        }

        public bool TryCopyTo(Span<T> destination)
        {
            if ((uint)length > (uint)destination.length)
            {
                return false;
            }

            Spans.Move(array, start, destination.array, destination.start, length);
            return true;
        }

        public void Fill(T value)
        {
            for (int i = 0; i < length; i++)
            {
                array[start + i] = value;
            }
        }

        public void Clear()
        {
            for (int i = 0; i < length; i++)
            {
                array[start + i] = default(T);
            }
        }

        public T[] ToArray()
        {
            var copy = new T[length];
            for (int i = 0; i < length; i++)
            {
                copy[i] = array[start + i];
            }

            return copy;
        }

        public Enumerator GetEnumerator() => new Enumerator(this);

        public override string ToString() => Spans.Text(array, start, length, "Span");

        public static implicit operator Span<T>(T[] array) => new Span<T>(array);

        public static implicit operator ReadOnlySpan<T>(Span<T> span) =>
            new ReadOnlySpan<T>(span.array, span.start, span.length, true);

        public static bool operator ==(Span<T> left, Span<T> right) =>
            left.length == right.length && left.array == right.array && (left.array == null || left.start == right.start);

        public static bool operator !=(Span<T> left, Span<T> right) => !(left == right);

        public override bool Equals(object obj) => throw new NotSupportedException();

        public override int GetHashCode() => throw new NotSupportedException();

        public struct Enumerator
        {
            private readonly Span<T> span;
            private int index;

            internal Enumerator(Span<T> span)
            {
                this.span = span;
                index = -1;
            }

            public bool MoveNext()
            {
                int next = index + 1;
                if (next < span.length)
                {
                    index = next;
                    return true;
                }

                return false;
            }

            public ref T Current => ref span.array[span.start + index];
        }
    }

    internal readonly struct ReadOnlySpan<T>
    {
        internal readonly T[] array;
        internal readonly int start;
        internal readonly int length;

        public ReadOnlySpan(T[] array)
        {
            this.array = array;
            start = 0;
            length = array == null ? 0 : array.Length;
        }

        public ReadOnlySpan(T[] array, int start, int length)
        {
            if (array == null)
            {
                if (start != 0 || length != 0)
                {
                    throw new ArgumentOutOfRangeException();
                }

                this.array = null;
                this.start = 0;
                this.length = 0;
                return;
            }

            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)array.Length)
            {
                throw new ArgumentOutOfRangeException();
            }

            this.array = array;
            this.start = start;
            this.length = length;
        }

        internal ReadOnlySpan(T[] array, int start, int length, bool unchecked_)
        {
            this.array = array;
            this.start = start;
            this.length = length;
        }

        public static ReadOnlySpan<T> Empty => default;

        public int Length => length;

        public bool IsEmpty => length == 0;

        public ref readonly T this[int index]
        {
            get
            {
                if ((uint)index >= (uint)length)
                {
                    throw new IndexOutOfRangeException();
                }

                return ref array[start + index];
            }
        }

        public ReadOnlySpan<T> Slice(int start)
        {
            if ((uint)start > (uint)length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new ReadOnlySpan<T>(array, this.start + start, length - start, true);
        }

        public ReadOnlySpan<T> Slice(int start, int length)
        {
            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)this.length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new ReadOnlySpan<T>(array, this.start + start, length, true);
        }

        public void CopyTo(Span<T> destination)
        {
            if ((uint)length > (uint)destination.length)
            {
                throw new ArgumentException("Destination is too short.", "destination");
            }

            Spans.Move(array, start, destination.array, destination.start, length);
        }

        public bool TryCopyTo(Span<T> destination)
        {
            if ((uint)length > (uint)destination.length)
            {
                return false;
            }

            Spans.Move(array, start, destination.array, destination.start, length);
            return true;
        }

        public T[] ToArray()
        {
            var copy = new T[length];
            for (int i = 0; i < length; i++)
            {
                copy[i] = array[start + i];
            }

            return copy;
        }

        public Enumerator GetEnumerator() => new Enumerator(this);

        public override string ToString() => Spans.Text(array, start, length, "ReadOnlySpan");

        public static implicit operator ReadOnlySpan<T>(T[] array) => new ReadOnlySpan<T>(array);

        public static bool operator ==(ReadOnlySpan<T> left, ReadOnlySpan<T> right) =>
            left.length == right.length && left.array == right.array && (left.array == null || left.start == right.start);

        public static bool operator !=(ReadOnlySpan<T> left, ReadOnlySpan<T> right) => !(left == right);

        public override bool Equals(object obj) => throw new NotSupportedException();

        public override int GetHashCode() => throw new NotSupportedException();

        public struct Enumerator
        {
            private readonly ReadOnlySpan<T> span;
            private int index;

            internal Enumerator(ReadOnlySpan<T> span)
            {
                this.span = span;
                index = -1;
            }

            public bool MoveNext()
            {
                int next = index + 1;
                if (next < span.length)
                {
                    index = next;
                    return true;
                }

                return false;
            }

            public ref readonly T Current => ref span.array[span.start + index];
        }
    }

    internal static class Spans
    {
        // Buffer.Memmove's: overlapping ranges of one array copied as if
        // through a temporary.
        internal static void Move<T>(T[] source, int sourceStart, T[] destination, int destinationStart, int count)
        {
            if (count == 0)
            {
                return;
            }

            if (source == destination && destinationStart > sourceStart)
            {
                for (int i = count - 1; i >= 0; i--)
                {
                    destination[destinationStart + i] = source[sourceStart + i];
                }

                return;
            }

            for (int i = 0; i < count; i++)
            {
                destination[destinationStart + i] = source[sourceStart + i];
            }
        }

        // A span of chars is its text; another, "System.Span<Int32>[3]".
        internal static string Text<T>(T[] array, int start, int length, string kind)
        {
            if (array is char[] chars)
            {
                return new string(chars, start, length);
            }

            if (typeof(T) == typeof(char))
            {
                return "";
            }

            return "System." + kind + "<" + typeof(T).Name + ">[" + length + "]";
        }

        // `stackalloc T[n]`: a fresh array; a negative size is an
        // OverflowException, as the CLR's.
        internal static T[] StackAlloc<T>(int size)
        {
            if (size < 0)
            {
                throw new OverflowException();
            }

            return new T[size];
        }
    }
}

namespace System
{
    public static partial class MemoryExtensions
    {
        public static Span<T> AsSpan<T>(this T[] array) => new Span<T>(array);

        public static Span<T> AsSpan<T>(this T[] array, int start)
        {
            if (array == null)
            {
                if (start != 0)
                {
                    throw new ArgumentOutOfRangeException();
                }

                return default;
            }

            if ((uint)start > (uint)array.Length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new Span<T>(array, start, array.Length - start);
        }

        public static Span<T> AsSpan<T>(this T[] array, int start, int length) => new Span<T>(array, start, length);

        public static Span<T> AsSpan<T>(this T[] array, Range range)
        {
            if (array == null)
            {
                throw new ArgumentNullException("array");
            }

            var (offset, length) = range.GetOffsetAndLength(array.Length);
            return new Span<T>(array, offset, length);
        }

        public static ReadOnlySpan<char> AsSpan(this string text) =>
            text == null ? default : new ReadOnlySpan<char>(text.ToCharArray());

        public static ReadOnlySpan<char> AsSpan(this string text, int start)
        {
            if (text == null)
            {
                if (start != 0)
                {
                    throw new ArgumentOutOfRangeException("start");
                }

                return default;
            }

            if ((uint)start > (uint)text.Length)
            {
                throw new ArgumentOutOfRangeException("start");
            }

            return new ReadOnlySpan<char>(text.ToCharArray(), start, text.Length - start);
        }

        public static ReadOnlySpan<char> AsSpan(this string text, int start, int length)
        {
            if (text == null)
            {
                if (start != 0 || length != 0)
                {
                    throw new ArgumentOutOfRangeException("start");
                }

                return default;
            }

            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)text.Length)
            {
                throw new ArgumentOutOfRangeException("start");
            }

            return new ReadOnlySpan<char>(text.ToCharArray(), start, length);
        }

        public static bool SequenceEqual<T>(this Span<T> span, ReadOnlySpan<T> other) => SequenceEqual((ReadOnlySpan<T>)span, other);

        public static bool SequenceEqual<T>(this ReadOnlySpan<T> span, ReadOnlySpan<T> other)
        {
            if (span.Length != other.Length)
            {
                return false;
            }

            for (int i = 0; i < span.Length; i++)
            {
                if (!Gameplay.Runtime.Intrinsics.Equal(span[i], other[i]))
                {
                    return false;
                }
            }

            return true;
        }

        public static int IndexOf<T>(this Span<T> span, T value) => IndexOf((ReadOnlySpan<T>)span, value);

        public static int IndexOf<T>(this ReadOnlySpan<T> span, T value)
        {
            int i = 0;
            // Integers a Vector128 at a time (Wasm SIMD, lane by lane as
            // their Equals compares them), where a span has two vectors'
            // worth: a Vector128 load of a GC array is an array.get per lane,
            // and a search over 16K ints takes about 60% of the scalar
            // loop's time in V8. SequenceEqual, with two loads a step, gains
            // nothing measurable and stays scalar (docs/IMPORTER.md, "SIMD
            // as built").
            if ((typeof(T) == typeof(int) || typeof(T) == typeof(uint) || typeof(T) == typeof(long) || typeof(T) == typeof(ulong)
                 || typeof(T) == typeof(short) || typeof(T) == typeof(ushort) || typeof(T) == typeof(byte) || typeof(T) == typeof(sbyte))
                && span.Length >= 2 * System.Runtime.Intrinsics.Vector128<T>.Count)
            {
                var target = System.Runtime.Intrinsics.Vector128.Create(value);
                int last = span.Length - System.Runtime.Intrinsics.Vector128<T>.Count;
                for (; i <= last; i += System.Runtime.Intrinsics.Vector128<T>.Count)
                {
                    uint found = System.Runtime.Intrinsics.Vector128.ExtractMostSignificantBits(
                        System.Runtime.Intrinsics.Vector128.Equals(System.Runtime.Intrinsics.Vector128.LoadSpan(span, i), target));
                    if (found != 0)
                    {
                        return i + System.Numerics.BitOperations.TrailingZeroCount(found);
                    }
                }
            }

            for (; i < span.Length; i++)
            {
                if (Gameplay.Runtime.Intrinsics.Equal(span[i], value))
                {
                    return i;
                }
            }

            return -1;
        }

        public static int LastIndexOf<T>(this Span<T> span, T value) => LastIndexOf((ReadOnlySpan<T>)span, value);

        public static int LastIndexOf<T>(this ReadOnlySpan<T> span, T value)
        {
            for (int i = span.Length - 1; i >= 0; i--)
            {
                if (Gameplay.Runtime.Intrinsics.Equal(span[i], value))
                {
                    return i;
                }
            }

            return -1;
        }

        public static bool Contains<T>(this Span<T> span, T value) => IndexOf((ReadOnlySpan<T>)span, value) >= 0;

        public static bool Contains<T>(this ReadOnlySpan<T> span, T value) => IndexOf(span, value) >= 0;

        public static bool StartsWith<T>(this ReadOnlySpan<T> span, ReadOnlySpan<T> value) =>
            value.Length <= span.Length && SequenceEqual(span.Slice(0, value.Length), value);

        public static bool EndsWith<T>(this ReadOnlySpan<T> span, ReadOnlySpan<T> value) =>
            value.Length <= span.Length && SequenceEqual(span.Slice(span.Length - value.Length), value);

        public static void Reverse<T>(this Span<T> span)
        {
            int i = 0;
            int j = span.Length - 1;
            while (i < j)
            {
                T temp = span[i];
                span[i] = span[j];
                span[j] = temp;
                i++;
                j--;
            }
        }

        public static void Sort<T>(this Span<T> span)
        {
            var copy = span.ToArray();
            Gameplay.Runtime.Sorting.SortDefault(copy, 0, copy.Length);
            copy.AsSpan().CopyTo(span);
        }

        public static void Sort<T>(this Span<T> span, Comparison<T> comparison)
        {
            if (comparison == null)
            {
                throw new ArgumentNullException("comparison");
            }

            var copy = span.ToArray();
            Gameplay.Runtime.Sorting.Sort(copy, 0, copy.Length, comparison);
            copy.AsSpan().CopyTo(span);
        }

        public static int BinarySearch<T>(this ReadOnlySpan<T> span, T value) =>
            Gameplay.Runtime.Sorting.BinarySearch(span.ToArray(), 0, span.Length, value, null);

        public static ReadOnlySpan<char> Trim(this ReadOnlySpan<char> span)
        {
            int start = 0;
            while (start < span.Length && char.IsWhiteSpace(span[start]))
            {
                start++;
            }

            int end = span.Length - 1;
            while (end >= start && char.IsWhiteSpace(span[end]))
            {
                end--;
            }

            return span.Slice(start, end - start + 1);
        }

        public static bool Equals(this ReadOnlySpan<char> span, ReadOnlySpan<char> other, StringComparison comparisonType) =>
            string.Equals(span.ToString(), other.ToString(), comparisonType);

        public static bool StartsWith(this ReadOnlySpan<char> span, ReadOnlySpan<char> value, StringComparison comparisonType) =>
            span.ToString().StartsWith(value.ToString(), comparisonType);
    }
}

namespace System.Runtime.InteropServices
{
    using System.Collections.Generic;

    public static partial class CollectionsMarshal
    {
        // The list's own array, up to its count.
        public static Span<T> AsSpan<T>(List<T> list) =>
            list == null ? default : new Span<T>(list.RawItems, 0, list.Count);
    }
}

namespace Gameplay.Runtime.Shims
{
    // MemoryMarshal.GetReference: a reference to a span's first element (a
    // handle to the array's element), for what dotnet/runtime's sources
    // load and store vectors through; an empty span's is a null reference.
    internal static class MemoryMarshal
    {
        public static ref T GetReference<T>(Span<T> span) =>
            ref span.length == 0 ? ref System.Runtime.CompilerServices.Unsafe.NullRef<T>() : ref span.array[span.start];

        public static ref T GetReference<T>(ReadOnlySpan<T> span) =>
            ref span.length == 0 ? ref System.Runtime.CompilerServices.Unsafe.NullRef<T>() : ref span.array[span.start];
    }
}
