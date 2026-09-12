// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// .NET's span extensions that the runtime layer (runtime/Spans.cs) has no
// overload of: what C# binds array and span calls to against .NET's
// reference assemblies (`array.Contains(x)`, `array.Max()` and
// `span.BinarySearch(x)` are span calls in .NET 11), with .NET's checks and
// results.

using System.Collections.Generic;

namespace System
{
    public static partial class MemoryExtensions
    {
        public static bool Contains<T>(this ReadOnlySpan<T> span, T value, IEqualityComparer<T>? comparer = null) =>
            IndexOf(span, value, comparer) >= 0;

        public static int IndexOf<T>(this ReadOnlySpan<T> span, T value, IEqualityComparer<T>? comparer = null)
        {
            if (comparer == null)
            {
                return IndexOf(span, value);
            }

            for (int i = 0; i < span.Length; i++)
            {
                if (comparer.Equals(span[i], value))
                {
                    return i;
                }
            }

            return -1;
        }

        public static int LastIndexOf<T>(this ReadOnlySpan<T> span, T value, IEqualityComparer<T>? comparer = null)
        {
            if (comparer == null)
            {
                return LastIndexOf(span, value);
            }

            for (int i = span.Length - 1; i >= 0; i--)
            {
                if (comparer.Equals(span[i], value))
                {
                    return i;
                }
            }

            return -1;
        }

        public static bool SequenceEqual<T>(this ReadOnlySpan<T> span, ReadOnlySpan<T> other, IEqualityComparer<T>? comparer = null)
        {
            if (comparer == null)
            {
                return SequenceEqual(span, other);
            }

            if (span.Length != other.Length)
            {
                return false;
            }

            for (int i = 0; i < span.Length; i++)
            {
                if (!comparer.Equals(span[i], other[i]))
                {
                    return false;
                }
            }

            return true;
        }

        public static bool SequenceEqual<T>(this Span<T> span, ReadOnlySpan<T> other, IEqualityComparer<T>? comparer = null) =>
            SequenceEqual((ReadOnlySpan<T>)span, other, comparer);

        public static int BinarySearch<T>(this Span<T> span, IComparable<T> comparable) =>
            BinarySearch<T, IComparable<T>>((ReadOnlySpan<T>)span, comparable);

        public static int BinarySearch<T, TComparable>(this Span<T> span, TComparable comparable)
            where TComparable : IComparable<T> =>
            BinarySearch((ReadOnlySpan<T>)span, comparable);

        public static int BinarySearch<T, TComparer>(this Span<T> span, T value, TComparer comparer)
            where TComparer : IComparer<T> =>
            BinarySearch((ReadOnlySpan<T>)span, value, comparer);

        public static int BinarySearch<T>(this ReadOnlySpan<T> span, IComparable<T> comparable) =>
            BinarySearch<T, IComparable<T>>(span, comparable);

        public static int BinarySearch<T, TComparable>(this ReadOnlySpan<T> span, TComparable comparable)
            where TComparable : IComparable<T>
        {
            if (comparable == null)
            {
                throw new ArgumentNullException(nameof(comparable));
            }

            int lo = 0;
            int hi = span.Length - 1;
            while (lo <= hi)
            {
                int i = (int)(((uint)hi + (uint)lo) >> 1);
                int c = comparable.CompareTo(span[i]);
                if (c == 0)
                {
                    return i;
                }

                if (c > 0)
                {
                    lo = i + 1;
                }
                else
                {
                    hi = i - 1;
                }
            }

            return ~lo;
        }

        public static int BinarySearch<T, TComparer>(this ReadOnlySpan<T> span, T value, TComparer comparer)
            where TComparer : IComparer<T>
        {
            if (comparer == null)
            {
                throw new ArgumentNullException(nameof(comparer));
            }

            int lo = 0;
            int hi = span.Length - 1;
            while (lo <= hi)
            {
                int i = (int)(((uint)hi + (uint)lo) >> 1);
                int c = comparer.Compare(value, span[i]);
                if (c == 0)
                {
                    return i;
                }

                if (c > 0)
                {
                    lo = i + 1;
                }
                else
                {
                    hi = i - 1;
                }
            }

            return ~lo;
        }

        // Min and Max as .NET 11 has them: a value type's empty span throws,
        // a reference type's (or a nullable's) gives null; nulls are
        // skipped; the default comparer orders a NaN below every number.
        public static T? Min<T>(this ReadOnlySpan<T> span) => MinMax(span, Comparer<T>.Default, max: false);

        public static T? Min<T>(this ReadOnlySpan<T> span, IComparer<T>? comparer) =>
            MinMax(span, comparer ?? Comparer<T>.Default, max: false);

        public static T? Max<T>(this ReadOnlySpan<T> span) => MinMax(span, Comparer<T>.Default, max: true);

        public static T? Max<T>(this ReadOnlySpan<T> span, IComparer<T>? comparer) =>
            MinMax(span, comparer ?? Comparer<T>.Default, max: true);

        private static T? MinMax<T>(ReadOnlySpan<T> span, IComparer<T> comparer, bool max)
        {
            T? value = default;
            if (value == null)
            {
                int i;
                for (i = 0; i < span.Length; i++)
                {
                    value = span[i];
                    if (value != null)
                    {
                        i++;
                        break;
                    }
                }

                for (; i < span.Length; i++)
                {
                    T next = span[i];
                    if (next != null && Better(comparer.Compare(next, value!), max))
                    {
                        value = next;
                    }
                }

                return value;
            }

            if (span.IsEmpty)
            {
                throw new InvalidOperationException(SR.InvalidOperation_NoElements);
            }

            value = span[0];
            for (int i = 1; i < span.Length; i++)
            {
                T next = span[i];
                if (Better(comparer.Compare(next, value), max))
                {
                    value = next;
                }
            }

            return value;
        }

        // The searches for anything but one value, and the trims of one
        // value (dotnet/runtime's BigInteger trims and skips zero limbs).
        public static int IndexOfAnyExcept<T>(this ReadOnlySpan<T> span, T value)
        {
            for (int i = 0; i < span.Length; i++)
            {
                if (!Gameplay.Runtime.Intrinsics.Equal(span[i], value))
                {
                    return i;
                }
            }

            return -1;
        }

        public static int IndexOfAnyExcept<T>(this Span<T> span, T value) => IndexOfAnyExcept((ReadOnlySpan<T>)span, value);

        public static int LastIndexOfAnyExcept<T>(this ReadOnlySpan<T> span, T value)
        {
            for (int i = span.Length - 1; i >= 0; i--)
            {
                if (!Gameplay.Runtime.Intrinsics.Equal(span[i], value))
                {
                    return i;
                }
            }

            return -1;
        }

        public static int LastIndexOfAnyExcept<T>(this Span<T> span, T value) => LastIndexOfAnyExcept((ReadOnlySpan<T>)span, value);

        public static bool ContainsAnyExcept<T>(this ReadOnlySpan<T> span, T value) => IndexOfAnyExcept(span, value) >= 0;

        public static bool ContainsAnyExcept<T>(this Span<T> span, T value) => IndexOfAnyExcept((ReadOnlySpan<T>)span, value) >= 0;

        public static ReadOnlySpan<T> TrimEnd<T>(this ReadOnlySpan<T> span, T trimElement) =>
            span.Slice(0, LastIndexOfAnyExcept(span, trimElement) + 1);

        public static Span<T> TrimEnd<T>(this Span<T> span, T trimElement) =>
            span.Slice(0, LastIndexOfAnyExcept((ReadOnlySpan<T>)span, trimElement) + 1);

        public static ReadOnlySpan<T> TrimStart<T>(this ReadOnlySpan<T> span, T trimElement)
        {
            int start = IndexOfAnyExcept(span, trimElement);
            return start < 0 ? span.Slice(span.Length) : span.Slice(start);
        }

        public static Span<T> TrimStart<T>(this Span<T> span, T trimElement)
        {
            int start = IndexOfAnyExcept((ReadOnlySpan<T>)span, trimElement);
            return start < 0 ? span.Slice(span.Length) : span.Slice(start);
        }

        private static bool Better(int comparison, bool max) => max ? comparison > 0 : comparison < 0;
    }
}
