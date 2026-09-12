// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Members of .NET's collections the runtime layer's (runtime/Collections.cs)
// have only in other shapes: what code compiled against .NET's reference
// assemblies binds to, and what C# lowers collection expressions to
// (CollectionsMarshal.SetCount and AsSpan).

namespace System.Collections.Generic
{
    public sealed partial class List<T>
    {
        // .NET's List<T> is an IList<T> and an IReadOnlyList<T> (merged from
        // the surface); the rest of those interfaces the runtime layer's
        // members implement.
        bool ICollection<T>.IsReadOnly => false;

        public void InsertRange(int index, IEnumerable<T> collection)
        {
            if (collection == null)
            {
                throw new ArgumentNullException(nameof(collection));
            }

            if ((uint)index > (uint)size)
            {
                throw new ArgumentOutOfRangeException(nameof(index), "Index must be within the bounds of the List.");
            }

            // Copied first, which inserting the list into itself needs.
            // Disposed once it is done, without a finally (List's constructor
            // says why).
            var copy = new List<T>();
            var enumerator = collection.GetEnumerator();
            while (enumerator.MoveNext())
            {
                copy.Add(enumerator.Current);
            }

            enumerator.Dispose();

            InsertRange(index, copy.ToArray());
        }

        // CollectionsMarshal.SetCount: the slots past the count cleared,
        // those it grows into default.
        internal void SetCount(int count)
        {
            if (count < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(count), "Non-negative number required.");
            }

            version++;
            if (count > items.Length)
            {
                Grow(count);
            }
            else if (count < size)
            {
                for (int at = count; at < size; at++)
                {
                    items[at] = default;
                }
            }

            size = count;
        }
    }
}

namespace System.Runtime.InteropServices
{
    public static partial class CollectionsMarshal
    {
        public static void SetCount<T>(System.Collections.Generic.List<T> list, int count)
        {
            if (list == null)
            {
                throw new NullReferenceException();
            }

            list.SetCount(count);
        }

        public static ref TValue GetValueRefOrAddDefault<TKey, TValue>(
            System.Collections.Generic.Dictionary<TKey, TValue> dictionary, TKey key, out bool exists)
            where TKey : notnull =>
            ref dictionary.ValueRefOrAddDefault(key, out exists);
    }
}
