// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Sorting and searching as .NET's ArraySortHelper<T> (a Comparison) and
// GenericArraySortHelper<T> (the default comparer of numbers, chars, bools
// and enums) do them: the same introspective sort, step for step, so that
// elements a comparison ties land where the CLR puts them, and floats'
// NaNs first. Array's generic helpers (Array.Sort, Reverse, IndexOf, Fill,
// Resize, Find...) are shims over these and the arrays themselves.

using Gameplay.Runtime;

namespace Gameplay.Runtime
{
    internal static class Sorting
    {
        private const int IntrosortSizeThreshold = 16;

        private static int Log2(int value)
        {
            int log = 0;
            while ((value >>= 1) != 0)
            {
                log++;
            }

            return log;
        }

        private static void Swap<T>(T[] keys, int i, int j)
        {
            T t = keys[i];
            keys[i] = keys[j];
            keys[j] = t;
        }

        // ArraySortHelper<T>.Sort(span, comparison): an exception the
        // comparison throws surfaces as InvalidOperationException, and an
        // index out of range (a comparison inconsistent with itself) as
        // ArgumentException.
        public static void Sort<T>(T[] keys, int index, int length, System.Comparison<T> comparer)
        {
            try
            {
                if (length > 1)
                {
                    IntroSort(keys, index, length, 2 * (Log2(length) + 1), comparer);
                }
            }
            catch (System.IndexOutOfRangeException)
            {
                throw new System.ArgumentException();
            }
            catch (System.Exception exception)
            {
                throw new System.InvalidOperationException("Failed to compare two elements in the array.", exception);
            }
        }

        private static void SwapIfGreater<T>(T[] keys, System.Comparison<T> comparer, int i, int j)
        {
            if (comparer(keys[i], keys[j]) > 0)
            {
                Swap(keys, i, j);
            }
        }

        private static void IntroSort<T>(T[] keys, int lo, int length, int depthLimit, System.Comparison<T> comparer)
        {
            int partitionSize = length;
            while (partitionSize > 1)
            {
                if (partitionSize <= IntrosortSizeThreshold)
                {
                    if (partitionSize == 2)
                    {
                        SwapIfGreater(keys, comparer, lo, lo + 1);
                        return;
                    }

                    if (partitionSize == 3)
                    {
                        SwapIfGreater(keys, comparer, lo, lo + 1);
                        SwapIfGreater(keys, comparer, lo, lo + 2);
                        SwapIfGreater(keys, comparer, lo + 1, lo + 2);
                        return;
                    }

                    InsertionSort(keys, lo, partitionSize, comparer);
                    return;
                }

                if (depthLimit == 0)
                {
                    HeapSort(keys, lo, partitionSize, comparer);
                    return;
                }

                depthLimit--;
                int p = PickPivotAndPartition(keys, lo, partitionSize, comparer);
                IntroSort(keys, lo + p + 1, partitionSize - (p + 1), depthLimit, comparer);
                partitionSize = p;
            }
        }

        private static int PickPivotAndPartition<T>(T[] keys, int lo, int length, System.Comparison<T> comparer)
        {
            int hi = length - 1;
            int middle = hi >> 1;
            SwapIfGreater(keys, comparer, lo, lo + middle);
            SwapIfGreater(keys, comparer, lo, lo + hi);
            SwapIfGreater(keys, comparer, lo + middle, lo + hi);
            T pivot = keys[lo + middle];
            Swap(keys, lo + middle, lo + hi - 1);
            int left = 0;
            int right = hi - 1;
            while (left < right)
            {
                while (comparer(keys[lo + ++left], pivot) < 0)
                {
                }

                while (comparer(pivot, keys[lo + --right]) < 0)
                {
                }

                if (left >= right)
                {
                    break;
                }

                Swap(keys, lo + left, lo + right);
            }

            if (left != hi - 1)
            {
                Swap(keys, lo + left, lo + hi - 1);
            }

            return left;
        }

        private static void HeapSort<T>(T[] keys, int lo, int n, System.Comparison<T> comparer)
        {
            for (int i = n >> 1; i >= 1; i--)
            {
                DownHeap(keys, lo, i, n, comparer);
            }

            for (int i = n; i > 1; i--)
            {
                Swap(keys, lo, lo + i - 1);
                DownHeap(keys, lo, 1, i - 1, comparer);
            }
        }

        private static void DownHeap<T>(T[] keys, int lo, int i, int n, System.Comparison<T> comparer)
        {
            T d = keys[lo + i - 1];
            while (i <= n >> 1)
            {
                int child = 2 * i;
                if (child < n && comparer(keys[lo + child - 1], keys[lo + child]) < 0)
                {
                    child++;
                }

                if (!(comparer(d, keys[lo + child - 1]) < 0))
                {
                    break;
                }

                keys[lo + i - 1] = keys[lo + child - 1];
                i = child;
            }

            keys[lo + i - 1] = d;
        }

        private static void InsertionSort<T>(T[] keys, int lo, int length, System.Comparison<T> comparer)
        {
            for (int i = 0; i < length - 1; i++)
            {
                T t = keys[lo + i + 1];
                int j = i;
                while (j >= 0 && comparer(t, keys[lo + j]) < 0)
                {
                    keys[lo + j + 1] = keys[lo + j];
                    j--;
                }

                keys[lo + j + 1] = t;
            }
        }

        // GenericArraySortHelper<T>: NaNs first, then the introspective sort
        // with the values' own < and > (an IComparable<T>'s CompareTo), a
        // null reference ordered first without calling CompareTo on it.
        // Array.Sort with an IComparer: the default order's sort for none or
        // the default comparer, else the comparer's Compare.
        public static void SortWith<T>(T[] keys, int index, int length, System.Collections.Generic.IComparer<T> comparer)
        {
            if (comparer == null || comparer is System.Collections.Generic.DefaultComparer<T>)
            {
                SortDefault(keys, index, length);
            }
            else if (length > 1)
            {
                Sort(keys, index, length, (x, y) => comparer.Compare(x, y));
            }
        }

        // What BinarySearch compares by: the default order for none or the
        // default comparer.
        public static System.Comparison<T> ComparisonOf<T>(System.Collections.Generic.IComparer<T> comparer) =>
            comparer == null || comparer is System.Collections.Generic.DefaultComparer<T> ? null : (x, y) => comparer.Compare(x, y);

        public static void SortDefault<T>(T[] keys, int index, int length)
        {
            if (length < 2)
            {
                return;
            }

            if (Intrinsics.SortsByComparer<T>())
            {
                // ArraySortHelper<T> with Comparer<T>.Default, as the CLR
                // sorts a nullable and a type of IComparable alone.
                Sort(keys, index, length, DefaultCompare);
                return;
            }

            int nans = 0;
            for (int i = 0; i < length; i++)
            {
                if (Intrinsics.IsNaN(keys[index + i]))
                {
                    Swap(keys, index + nans, index + i);
                    nans++;
                }
            }

            index += nans;
            length -= nans;
            if (length > 1)
            {
                IntroSortDefault(keys, index, length, 2 * (Log2(length) + 1));
            }
        }

        private static int DefaultCompare<T>(T x, T y) => Intrinsics.Compare(x, y);

        private static void SwapIfGreaterDefault<T>(T[] keys, int i, int j)
        {
            if (keys[i] != null && Intrinsics.GreaterThan(keys[i], keys[j]))
            {
                Swap(keys, i, j);
            }
        }

        private static void IntroSortDefault<T>(T[] keys, int lo, int length, int depthLimit)
        {
            int partitionSize = length;
            while (partitionSize > 1)
            {
                if (partitionSize <= IntrosortSizeThreshold)
                {
                    if (partitionSize == 2)
                    {
                        SwapIfGreaterDefault(keys, lo, lo + 1);
                        return;
                    }

                    if (partitionSize == 3)
                    {
                        SwapIfGreaterDefault(keys, lo, lo + 1);
                        SwapIfGreaterDefault(keys, lo, lo + 2);
                        SwapIfGreaterDefault(keys, lo + 1, lo + 2);
                        return;
                    }

                    InsertionSortDefault(keys, lo, partitionSize);
                    return;
                }

                if (depthLimit == 0)
                {
                    HeapSortDefault(keys, lo, partitionSize);
                    return;
                }

                depthLimit--;
                int p = PickPivotAndPartitionDefault(keys, lo, partitionSize);
                IntroSortDefault(keys, lo + p + 1, partitionSize - (p + 1), depthLimit);
                partitionSize = p;
            }
        }

        private static int PickPivotAndPartitionDefault<T>(T[] keys, int lo, int length)
        {
            int last = lo + length - 1;
            int middle = lo + ((length - 1) >> 1);
            SwapIfGreaterDefault(keys, lo, middle);
            SwapIfGreaterDefault(keys, lo, last);
            SwapIfGreaterDefault(keys, middle, last);
            int nextToLast = lo + length - 2;
            T pivot = keys[middle];
            Swap(keys, middle, nextToLast);
            int left = lo;
            int right = nextToLast;
            while (left < right)
            {
                if (pivot == null)
                {
                    while (left < nextToLast && keys[++left] == null)
                    {
                    }

                    while (right > lo && keys[--right] != null)
                    {
                    }
                }
                else
                {
                    while (left < nextToLast && Intrinsics.GreaterThan(pivot, keys[++left]))
                    {
                    }

                    while (right > lo && Intrinsics.LessThan(pivot, keys[--right]))
                    {
                    }
                }

                if (left >= right)
                {
                    break;
                }

                Swap(keys, left, right);
            }

            if (left != nextToLast)
            {
                Swap(keys, left, nextToLast);
            }

            return left - lo;
        }

        private static void HeapSortDefault<T>(T[] keys, int lo, int n)
        {
            for (int i = n >> 1; i >= 1; i--)
            {
                DownHeapDefault(keys, lo, i, n);
            }

            for (int i = n; i > 1; i--)
            {
                Swap(keys, lo, lo + i - 1);
                DownHeapDefault(keys, lo, 1, i - 1);
            }
        }

        private static void DownHeapDefault<T>(T[] keys, int lo, int i, int n)
        {
            T d = keys[lo + i - 1];
            while (i <= n >> 1)
            {
                int child = 2 * i;
                if (child < n && (keys[lo + child - 1] == null || Intrinsics.LessThan(keys[lo + child - 1], keys[lo + child])))
                {
                    child++;
                }

                if (keys[lo + child - 1] == null || !Intrinsics.LessThan(d, keys[lo + child - 1]))
                {
                    break;
                }

                keys[lo + i - 1] = keys[lo + child - 1];
                i = child;
            }

            keys[lo + i - 1] = d;
        }

        private static void InsertionSortDefault<T>(T[] keys, int lo, int length)
        {
            for (int i = 0; i < length - 1; i++)
            {
                T t = keys[lo + i + 1];
                int j = i;
                while (j >= 0 && (t == null || Intrinsics.LessThan(t, keys[lo + j])))
                {
                    keys[lo + j + 1] = keys[lo + j];
                    j--;
                }

                keys[lo + j + 1] = t;
            }
        }

        // Array.BinarySearch's: an index of a match, or the complement of
        // where the value would go.
        public static int BinarySearch<T>(T[] array, int index, int length, T value, System.Comparison<T> comparer)
        {
            int lo = index;
            int hi = index + length - 1;
            while (lo <= hi)
            {
                int i = lo + ((hi - lo) >> 1);
                int order = comparer == null ? Intrinsics.Compare(array[i], value) : comparer(array[i], value);
                if (order == 0)
                {
                    return i;
                }

                if (order < 0)
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

        // The checks Array's members make on an array and a range of it.
        public static void CheckRange<T>(T[] array, int index, int length)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            if (index < 0 || length < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            if (array.Length - index < length)
            {
                throw new System.ArgumentException();
            }
        }
    }

    // Array.Empty<T>()'s one array per type.
    internal static class EmptyArray<T>
    {
        public static readonly T[] Value = new T[0];
    }
}

namespace Gameplay.Runtime.Shims
{
    internal static class Array
    {
        public static void Sort<T>(T[] array)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            Sorting.SortDefault(array, 0, array.Length);
        }

        public static void Sort<T>(T[] array, int index, int length)
        {
            Sorting.CheckRange(array, index, length);
            Sorting.SortDefault(array, index, length);
        }

        public static void Sort<T>(T[] array, System.Comparison<T> comparison)
        {
            if (array == null || comparison == null)
            {
                throw new System.ArgumentNullException();
            }

            Sorting.Sort(array, 0, array.Length, comparison);
        }

        public static void Sort<T>(T[] array, System.Collections.Generic.IComparer<T> comparer)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            Sorting.SortWith(array, 0, array.Length, comparer);
        }

        public static void Sort<T>(T[] array, int index, int length, System.Collections.Generic.IComparer<T> comparer)
        {
            Sorting.CheckRange(array, index, length);
            Sorting.SortWith(array, index, length, comparer);
        }

        public static int BinarySearch<T>(T[] array, T value, System.Collections.Generic.IComparer<T> comparer)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            return Sorting.BinarySearch(array, 0, array.Length, value, Sorting.ComparisonOf(comparer));
        }

        public static int BinarySearch<T>(T[] array, int index, int length, T value, System.Collections.Generic.IComparer<T> comparer)
        {
            Sorting.CheckRange(array, index, length);
            return Sorting.BinarySearch(array, index, length, value, Sorting.ComparisonOf(comparer));
        }

        public static int BinarySearch<T>(T[] array, T value)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            return Sorting.BinarySearch(array, 0, array.Length, value, null);
        }

        public static int BinarySearch<T>(T[] array, int index, int length, T value)
        {
            Sorting.CheckRange(array, index, length);
            return Sorting.BinarySearch(array, index, length, value, null);
        }

        public static void Reverse<T>(T[] array)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            Reverse(array, 0, array.Length);
        }

        public static void Reverse<T>(T[] array, int index, int length)
        {
            Sorting.CheckRange(array, index, length);
            for (int left = index, right = index + length - 1; left < right; left++, right--)
            {
                T swap = array[left];
                array[left] = array[right];
                array[right] = swap;
            }
        }

        public static int IndexOf<T>(T[] array, T value)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            return IndexOf(array, value, 0, array.Length);
        }

        public static int IndexOf<T>(T[] array, T value, int startIndex)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            if ((uint)startIndex > (uint)array.Length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return IndexOf(array, value, startIndex, array.Length - startIndex);
        }

        public static int IndexOf<T>(T[] array, T value, int startIndex, int count)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            if ((uint)startIndex > (uint)array.Length || (uint)count > (uint)(array.Length - startIndex))
            {
                throw new System.ArgumentOutOfRangeException();
            }

            for (int index = startIndex; index < startIndex + count; index++)
            {
                if (Intrinsics.Equal(array[index], value))
                {
                    return index;
                }
            }

            return -1;
        }

        public static int LastIndexOf<T>(T[] array, T value)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            for (int index = array.Length - 1; index >= 0; index--)
            {
                if (Intrinsics.Equal(array[index], value))
                {
                    return index;
                }
            }

            return -1;
        }

        public static void Fill<T>(T[] array, T value)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            for (int index = 0; index < array.Length; index++)
            {
                array[index] = value;
            }
        }

        public static void Fill<T>(T[] array, T value, int startIndex, int count)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            if ((uint)startIndex > (uint)array.Length || (uint)count > (uint)(array.Length - startIndex))
            {
                throw new System.ArgumentOutOfRangeException();
            }

            for (int index = startIndex; index < startIndex + count; index++)
            {
                array[index] = value;
            }
        }

        public static void Resize<T>(ref T[] array, int newSize)
        {
            if (newSize < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            T[] larray = array;
            if (larray == null)
            {
                array = new T[newSize];
                return;
            }

            if (larray.Length != newSize)
            {
                var newArray = new T[newSize];
                int count = larray.Length > newSize ? newSize : larray.Length;
                for (int index = 0; index < count; index++)
                {
                    newArray[index] = larray[index];
                }

                array = newArray;
            }
        }

        public static T[] Empty<T>() => EmptyArray<T>.Value;

        public static bool Exists<T>(T[] array, System.Predicate<T> match) => FindIndex(array, match) != -1;

        public static T Find<T>(T[] array, System.Predicate<T> match)
        {
            int index = FindIndex(array, match);
            return index < 0 ? default : array[index];
        }

        public static int FindIndex<T>(T[] array, System.Predicate<T> match)
        {
            if (array == null || match == null)
            {
                throw new System.ArgumentNullException();
            }

            for (int index = 0; index < array.Length; index++)
            {
                if (match(array[index]))
                {
                    return index;
                }
            }

            return -1;
        }

        public static T FindLast<T>(T[] array, System.Predicate<T> match)
        {
            int index = FindLastIndex(array, match);
            return index < 0 ? default : array[index];
        }

        public static int FindLastIndex<T>(T[] array, System.Predicate<T> match)
        {
            if (array == null || match == null)
            {
                throw new System.ArgumentNullException();
            }

            for (int index = array.Length - 1; index >= 0; index--)
            {
                if (match(array[index]))
                {
                    return index;
                }
            }

            return -1;
        }

        public static T[] FindAll<T>(T[] array, System.Predicate<T> match)
        {
            if (array == null || match == null)
            {
                throw new System.ArgumentNullException();
            }

            var found = new System.Collections.Generic.List<T>();
            for (int index = 0; index < array.Length; index++)
            {
                if (match(array[index]))
                {
                    found.Add(array[index]);
                }
            }

            return found.ToArray();
        }

        public static bool TrueForAll<T>(T[] array, System.Predicate<T> match)
        {
            if (array == null || match == null)
            {
                throw new System.ArgumentNullException();
            }

            for (int index = 0; index < array.Length; index++)
            {
                if (!match(array[index]))
                {
                    return false;
                }
            }

            return true;
        }

        public static void ForEach<T>(T[] array, System.Action<T> action)
        {
            if (array == null || action == null)
            {
                throw new System.ArgumentNullException();
            }

            for (int index = 0; index < array.Length; index++)
            {
                action(array[index]);
            }
        }

        public static TOutput[] ConvertAll<TInput, TOutput>(TInput[] array, System.Converter<TInput, TOutput> converter)
        {
            if (array == null || converter == null)
            {
                throw new System.ArgumentNullException();
            }

            var result = new TOutput[array.Length];
            for (int index = 0; index < array.Length; index++)
            {
                result[index] = converter(array[index]);
            }

            return result;
        }
    }
}

namespace Gameplay.Runtime
{
    // Ordering a type without a default order here (see Frontend.Linq).
    internal static class Ordering
    {
        public static int Unsupported() =>
            throw new System.NotSupportedException("Ordering by the default comparer is unsupported for this type.");
    }
}
