// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The generic collections gameplay code writes as the BCL's, compiled with
// every program by gameplayc itself (they are generic, so nothing reaches a
// module unless code instantiates it). The algorithms follow .NET's:
// Dictionary and HashSet keep entries in insertion order with a free list,
// so enumeration visits them in the same order as the CLR after the same
// adds and removes, whatever the hash codes; each collection keeps a version
// its enumerators check. They throw the exceptions the CLR's throw.

using System.Collections;
using Gameplay.Runtime;

namespace Gameplay.Runtime
{
    // Lowered inline by the compiler; never called.
    internal static class Intrinsics
    {
        // EqualityComparer<T>.Default.Equals: values for scalars (NaN equal
        // to NaN, 0 to -0), identity for references, field by field for
        // structs.
        public static extern bool Equal<T>(T left, T right);

        // A hash code consistent with Equal.
        public static extern int Hash<T>(T value);

        // The default comparer of numbers, chars, bools and enums: the
        // values' own <, whether one is a NaN, and CompareTo's sign.
        public static extern bool LessThan<T>(T left, T right);

        public static extern bool GreaterThan<T>(T left, T right);

        public static extern bool IsNaN<T>(T value);

        public static extern int Compare<T>(T left, T right);

        // Whether the CLR sorts T by its default comparer's Compare
        // (ArraySortHelper<T>: a nullable's NullableComparer, a type of
        // IComparable alone's ObjectComparer) rather than by its own <
        // (GenericArraySortHelper<T>: the scalars and IComparable<T>).
        public static extern bool SortsByComparer<T>();

        // An enum's names and values (unsigned 64-bit patterns, a signed
        // value sign-extended) in value order, its values to and from those
        // patterns, and its underlying type as bits * 2 + signed.
        public static extern string[] EnumNames<T>();

        public static extern ulong[] EnumValues<T>();

        public static extern T EnumFromBits<T>(ulong bits);

        public static extern ulong EnumToBits<T>(T value);

        public static extern int EnumKind<T>();

        // Ends the entry with a fault that nothing catches (see README.md,
        // "Runtime budgets and fault ABI").
        public static extern void Trap(int fault);

        // The active call depth, which the budget counts: what tells a
        // call made inside another from one after it was abandoned by a
        // trap.
        public static extern int CallDepth();

        // The call depth the budget allows (gameplayc's --depth).
        public static extern int CallDepthLimit();

        // Whether the module flows ExecutionContext: names it or
        // AsyncLocal<T> (a constant the importer folds).
        public static extern bool FlowsExecutionContext();

        // Whether the module has TaskSchedulers other than the default:
        // names TaskScheduler or TaskFactory (a constant the importer folds).
        public static extern bool HasTaskSchedulers();
    }
}

namespace System.Collections.Generic
{
    public readonly struct KeyValuePair<TKey, TValue>
    {
        private readonly TKey key;
        private readonly TValue value;

        public KeyValuePair(TKey key, TValue value)
        {
            this.key = key;
            this.value = value;
        }

        public TKey Key => key;

        public TValue Value => value;

        public void Deconstruct(out TKey key, out TValue value)
        {
            key = this.key;
            value = this.value;
        }

        public override string ToString() => "[" + key + ", " + value + "]";
    }

    public sealed partial class List<T> : IEnumerable, IEnumerable<T>
    {
        private T[] items;
        private int size;
        private int version;

        public List()
        {
            items = new T[0];
        }

        public List(int capacity)
        {
            if (capacity < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            items = new T[capacity];
        }

        // List(IEnumerable<T>) for the collections code passes: arrays and
        // lists, copied at their counts.
        public List(T[] collection)
        {
            if (collection == null)
            {
                throw new ArgumentNullException();
            }

            items = new T[collection.Length];
            for (int index = 0; index < collection.Length; index++)
            {
                items[index] = collection[index];
            }

            size = collection.Length;
        }

        public List(List<T> collection)
        {
            if (collection == null)
            {
                throw new ArgumentNullException();
            }

            items = collection.ToArray();
            size = items.Length;
        }

        // Any other sequence, enumerated.
        public List(IEnumerable<T> collection)
        {
            if (collection == null)
            {
                throw new ArgumentNullException("collection");
            }

            items = new T[0];
            // Disposed once it is done, as foreach would, but without a
            // finally: a class member walked for every instance would make
            // every module handle exceptions, so an enumerator whose MoveNext
            // throws is not disposed.
            var enumerator = collection.GetEnumerator();
            while (enumerator.MoveNext())
            {
                T item = enumerator.Current;
                Add(item);
            }

            enumerator.Dispose();
        }

        // CollectionsMarshal.AsSpan's view.
        internal T[] RawItems => items;

        public int Count => size;

        public int Capacity
        {
            get => items.Length;
            set
            {
                if (value < size)
                {
                    throw new ArgumentOutOfRangeException();
                }

                if (value != items.Length)
                {
                    Resize(value);
                }
            }
        }

        public T this[int index]
        {
            get
            {
                if ((uint)index >= (uint)size)
                {
                    throw new ArgumentOutOfRangeException();
                }

                return items[index];
            }
            set
            {
                if ((uint)index >= (uint)size)
                {
                    throw new ArgumentOutOfRangeException();
                }

                items[index] = value;
                version++;
            }
        }

        public void Add(T item)
        {
            version++;
            if (size == items.Length)
            {
                Grow(size + 1);
            }

            items[size] = item;
            size++;
        }

        public void Insert(int index, T item)
        {
            if ((uint)index > (uint)size)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (size == items.Length)
            {
                Grow(size + 1);
            }

            for (int at = size; at > index; at--)
            {
                items[at] = items[at - 1];
            }

            items[index] = item;
            size++;
            version++;
        }

        public void RemoveAt(int index)
        {
            if ((uint)index >= (uint)size)
            {
                throw new ArgumentOutOfRangeException();
            }

            size--;
            for (int at = index; at < size; at++)
            {
                items[at] = items[at + 1];
            }

            items[size] = default;
            version++;
        }

        public bool Remove(T item)
        {
            int index = IndexOf(item);
            if (index < 0)
            {
                return false;
            }

            RemoveAt(index);
            return true;
        }

        public int RemoveAll(Predicate<T> match)
        {
            if (match == null)
            {
                throw new ArgumentNullException();
            }

            int free = 0;
            while (free < size && !match(items[free]))
            {
                free++;
            }

            if (free >= size)
            {
                return 0;
            }

            int current = free + 1;
            while (current < size)
            {
                while (current < size && match(items[current]))
                {
                    current++;
                }

                if (current < size)
                {
                    items[free++] = items[current++];
                }
            }

            for (int at = free; at < size; at++)
            {
                items[at] = default;
            }

            int removed = size - free;
            size = free;
            version++;
            return removed;
        }

        public void Clear()
        {
            version++;
            for (int at = 0; at < size; at++)
            {
                items[at] = default;
            }

            size = 0;
        }

        public int IndexOf(T item)
        {
            for (int index = 0; index < size; index++)
            {
                if (Intrinsics.Equal(items[index], item))
                {
                    return index;
                }
            }

            return -1;
        }

        public bool Contains(T item) => size != 0 && IndexOf(item) >= 0;

        public bool Exists(Predicate<T> match) => FindIndex(match) != -1;

        public T Find(Predicate<T> match)
        {
            int index = FindIndex(match);
            return index < 0 ? default : items[index];
        }

        public int FindIndex(Predicate<T> match)
        {
            if (match == null)
            {
                throw new ArgumentNullException();
            }

            for (int index = 0; index < size; index++)
            {
                if (match(items[index]))
                {
                    return index;
                }
            }

            return -1;
        }

        public bool TrueForAll(Predicate<T> match)
        {
            if (match == null)
            {
                throw new ArgumentNullException();
            }

            for (int index = 0; index < size; index++)
            {
                if (!match(items[index]))
                {
                    return false;
                }
            }

            return true;
        }

        public void ForEach(Action<T> action)
        {
            if (action == null)
            {
                throw new ArgumentNullException();
            }

            int started = version;
            for (int index = 0; index < size; index++)
            {
                if (started != version)
                {
                    break;
                }

                action(items[index]);
            }

            if (started != version)
            {
                throw new InvalidOperationException();
            }
        }

        public void Reverse()
        {
            for (int left = 0, right = size - 1; left < right; left++, right--)
            {
                T swap = items[left];
                items[left] = items[right];
                items[right] = swap;
            }

            version++;
        }

        public T[] ToArray()
        {
            var array = new T[size];
            for (int index = 0; index < size; index++)
            {
                array[index] = items[index];
            }

            return array;
        }

        public void AddRange(T[] collection)
        {
            if (collection == null)
            {
                throw new ArgumentNullException();
            }

            InsertRange(size, collection);
        }

        public void AddRange(List<T> collection)
        {
            if (collection == null)
            {
                throw new ArgumentNullException();
            }

            InsertRange(size, collection.ToArray());
        }

        public void AddRange(IEnumerable<T> collection)
        {
            if (collection == null)
            {
                throw new ArgumentNullException("collection");
            }

            // As .NET's: one version change, then each element appended, so a
            // query over this list sees the ones appended before it.
            version++;
            // Disposed once it is done, as foreach would, but without a
            // finally: a class member walked for every instance would make
            // every module handle exceptions, so an enumerator whose MoveNext
            // throws is not disposed.
            var enumerator = collection.GetEnumerator();
            while (enumerator.MoveNext())
            {
                T item = enumerator.Current;
                if (size == items.Length)
                {
                    Grow(size + 1);
                }

                items[size] = item;
                size++;
            }

            enumerator.Dispose();
        }

        public void InsertRange(int index, T[] collection)
        {
            if (collection == null)
            {
                throw new ArgumentNullException();
            }

            if ((uint)index > (uint)size)
            {
                throw new ArgumentOutOfRangeException();
            }

            int count = collection.Length;
            if (count > 0)
            {
                if (items.Length - size < count)
                {
                    Grow(size + count);
                }

                for (int at = size - 1; at >= index; at--)
                {
                    items[at + count] = items[at];
                }

                for (int at = 0; at < count; at++)
                {
                    items[index + at] = collection[at];
                }

                size += count;
                version++;
            }
        }

        public void InsertRange(int index, List<T> collection)
        {
            if (collection == null)
            {
                throw new ArgumentNullException();
            }

            InsertRange(index, collection.ToArray());
        }

        private void CheckRange(int index, int count)
        {
            if (index < 0 || count < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (size - index < count)
            {
                throw new ArgumentException();
            }
        }

        public List<T> GetRange(int index, int count)
        {
            CheckRange(index, count);
            var list = new List<T>(count);
            for (int at = 0; at < count; at++)
            {
                list.items[at] = items[index + at];
            }

            list.size = count;
            return list;
        }

        public List<T> Slice(int start, int length) => GetRange(start, length);

        public void RemoveRange(int index, int count)
        {
            CheckRange(index, count);
            if (count > 0)
            {
                size -= count;
                for (int at = index; at < size; at++)
                {
                    items[at] = items[at + count];
                }

                version++;
                for (int at = size; at < size + count; at++)
                {
                    items[at] = default;
                }
            }
        }

        public int IndexOf(T item, int index)
        {
            if (index > size)
            {
                throw new ArgumentOutOfRangeException();
            }

            return IndexOf(item, index, size - index);
        }

        public int IndexOf(T item, int index, int count)
        {
            if (index > size || count < 0 || index > size - count)
            {
                throw new ArgumentOutOfRangeException();
            }

            for (int at = index; at < index + count; at++)
            {
                if (Intrinsics.Equal(items[at], item))
                {
                    return at;
                }
            }

            return -1;
        }

        public int LastIndexOf(T item)
        {
            for (int at = size - 1; at >= 0; at--)
            {
                if (Intrinsics.Equal(items[at], item))
                {
                    return at;
                }
            }

            return -1;
        }

        public T FindLast(Predicate<T> match)
        {
            int index = FindLastIndex(match);
            return index < 0 ? default : items[index];
        }

        public int FindLastIndex(Predicate<T> match)
        {
            if (match == null)
            {
                throw new ArgumentNullException();
            }

            for (int index = size - 1; index >= 0; index--)
            {
                if (match(items[index]))
                {
                    return index;
                }
            }

            return -1;
        }

        public List<T> FindAll(Predicate<T> match)
        {
            if (match == null)
            {
                throw new ArgumentNullException();
            }

            var list = new List<T>();
            for (int index = 0; index < size; index++)
            {
                if (match(items[index]))
                {
                    list.Add(items[index]);
                }
            }

            return list;
        }

        public List<TOutput> ConvertAll<TOutput>(Converter<T, TOutput> converter)
        {
            if (converter == null)
            {
                throw new ArgumentNullException();
            }

            var list = new List<TOutput>(size);
            for (int index = 0; index < size; index++)
            {
                list.items[index] = converter(items[index]);
            }

            list.size = size;
            return list;
        }

        public void CopyTo(T[] array) => CopyTo(array, 0);

        public void CopyTo(T[] array, int arrayIndex)
        {
            if (array == null)
            {
                throw new ArgumentNullException();
            }

            if (arrayIndex < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (array.Length - arrayIndex < size)
            {
                throw new ArgumentException();
            }

            for (int index = 0; index < size; index++)
            {
                array[arrayIndex + index] = items[index];
            }
        }

        public void Reverse(int index, int count)
        {
            CheckRange(index, count);
            for (int left = index, right = index + count - 1; left < right; left++, right--)
            {
                T swap = items[left];
                items[left] = items[right];
                items[right] = swap;
            }

            version++;
        }

        public void Sort()
        {
            Gameplay.Runtime.Sorting.SortDefault(items, 0, size);
            version++;
        }

        public void Sort(Comparison<T> comparison)
        {
            if (comparison == null)
            {
                throw new ArgumentNullException();
            }

            if (size > 1)
            {
                Gameplay.Runtime.Sorting.Sort(items, 0, size, comparison);
            }

            version++;
        }

        public int BinarySearch(T item) => Gameplay.Runtime.Sorting.BinarySearch(items, 0, size, item, null);

        public int BinarySearch(T item, IComparer<T> comparer) => BinarySearch(0, size, item, comparer);

        public int BinarySearch(int index, int count, T item, IComparer<T> comparer)
        {
            if (index < 0 || count < 0)
            {
                throw new ArgumentOutOfRangeException(index < 0 ? "index" : "count");
            }

            if (size - index < count)
            {
                throw new ArgumentException();
            }

            return Gameplay.Runtime.Sorting.BinarySearch(items, index, count, item, Gameplay.Runtime.Sorting.ComparisonOf(comparer));
        }

        public void Sort(IComparer<T> comparer) => Sort(0, size, comparer);

        // As .NET's: a null or the default comparer sorts as Sort() does.
        public void Sort(int index, int count, IComparer<T> comparer)
        {
            if (index < 0 || count < 0)
            {
                throw new ArgumentOutOfRangeException(index < 0 ? "index" : "count");
            }

            if (size - index < count)
            {
                throw new ArgumentException();
            }

            if (count > 1)
            {
                Gameplay.Runtime.Sorting.SortWith(items, index, count, comparer);
            }

            version++;
        }

        public int EnsureCapacity(int capacity)
        {
            if (capacity < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (items.Length < capacity)
            {
                Grow(capacity);
            }

            return items.Length;
        }

        public void TrimExcess()
        {
            int threshold = (int)(items.Length * 0.9);
            if (size < threshold)
            {
                Capacity = size;
            }
        }

        private void Grow(int capacity)
        {
            int next = items.Length == 0 ? 4 : 2 * items.Length;
            if (next < capacity)
            {
                next = capacity;
            }

            Resize(next);
        }

        private void Resize(int capacity)
        {
            var next = new T[capacity];
            for (int index = 0; index < size; index++)
            {
                next[index] = items[index];
            }

            items = next;
        }

        public Enumerator GetEnumerator() => new Enumerator(this);

        // A non-generic IEnumerable enumerates as the generic one.
        IEnumerator IEnumerable.GetEnumerator() => ((IEnumerable<T>)this).GetEnumerator();

        IEnumerator<T> IEnumerable<T>.GetEnumerator() => new ListEnumerator<T>(GetEnumerator());

        public struct Enumerator
            : System.IDisposable
        {
            // .NET's enumerators are disposable, and foreach disposes them.
            public void Dispose()
            {
            }

            private readonly List<T> list;
            private readonly int version;
            private int index;
            private T current;

            internal Enumerator(List<T> list)
            {
                this.list = list;
                version = list.version;
                index = 0;
                current = default;
            }

            public bool MoveNext()
            {
                if (version == list.version && (uint)index < (uint)list.size)
                {
                    current = list.items[index];
                    index++;
                    return true;
                }

                if (version != list.version)
                {
                    throw new InvalidOperationException();
                }

                index = list.size + 1;
                current = default;
                return false;
            }

            internal void Reset()
            {
                if (version != list.version)
                {
                    throw new InvalidOperationException();
                }

                index = 0;
                current = default;
            }

            public readonly T Current => current;
        }
    }

    public sealed class Dictionary<TKey, TValue> : IEnumerable, IEnumerable<KeyValuePair<TKey, TValue>>
    {
        // A free entry's Next encodes the next free entry below this value.
        private const int StartOfFreeList = -3;

        // Chains through Next, -1 ending one; 1-based entry indices in buckets.
        private struct Entry
        {
            public uint HashCode;
            public int Next;
            public TKey Key;
            public TValue Value;
        }

        private int[] buckets;
        private Entry[] entries;
        private int count;
        private int freeList;
        private int freeCount;
        private int version;
        private KeyCollection keys;
        private ValueCollection values;
        // A comparer other than the default one, if the dictionary was made
        // with one.
        private readonly Gameplay.Runtime.KeyComparer<TKey> comparer;

        public Dictionary()
        {
        }

        public Dictionary(IEqualityComparer<TKey> comparer)
        {
            this.comparer = Gameplay.Runtime.KeyComparer<TKey>.Of(comparer);
        }

        public Dictionary(int capacity, IEqualityComparer<TKey> comparer)
            : this(capacity)
        {
            this.comparer = Gameplay.Runtime.KeyComparer<TKey>.Of(comparer);
        }

        private uint KeyHash(TKey key) => comparer == null ? (uint)Intrinsics.Hash(key) : (uint)comparer.Hash(key);

        private bool KeyEqual(TKey stored, TKey key) => comparer == null ? Intrinsics.Equal(stored, key) : comparer.Same(stored, key);

        public Dictionary(int capacity)
        {
            if (capacity < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (capacity > 0)
            {
                Initialize(capacity);
            }
        }

        public int Count => count - freeCount;

        public KeyCollection Keys
        {
            get
            {
                if (keys == null)
                {
                    keys = new KeyCollection(this);
                }

                return keys;
            }
        }

        public ValueCollection Values
        {
            get
            {
                if (values == null)
                {
                    values = new ValueCollection(this);
                }

                return values;
            }
        }

        public TValue this[TKey key]
        {
            get
            {
                int index = FindEntry(key);
                if (index < 0)
                {
                    ThrowHelper.ThrowKeyNotFoundException(key);
                    throw new KeyNotFoundException();
                }

                return entries[index].Value;
            }
            set => TryInsert(key, value, overwrite: true);
        }

        public void Add(TKey key, TValue value)
        {
            if (!TryInsert(key, value, overwrite: false))
            {
                ThrowHelper.ThrowAddingDuplicateWithKeyArgumentException(key);
                throw new ArgumentException();
            }
        }

        public bool TryAdd(TKey key, TValue value) => TryInsert(key, value, overwrite: false);

        public bool ContainsKey(TKey key) => FindEntry(key) >= 0;

        public bool ContainsValue(TValue value)
        {
            for (int index = 0; index < count; index++)
            {
                if (entries[index].Next >= -1 && Intrinsics.Equal(entries[index].Value, value))
                {
                    return true;
                }
            }

            return false;
        }

        public bool TryGetValue(TKey key, out TValue value)
        {
            int index = FindEntry(key);
            if (index >= 0)
            {
                value = entries[index].Value;
                return true;
            }

            value = default;
            return false;
        }

        public bool Remove(TKey key) => Remove(key, out _);

        public bool Remove(TKey key, out TValue value)
        {
            if (key == null)
            {
                throw new ArgumentNullException();
            }

            if (buckets != null)
            {
                uint hashCode = KeyHash(key);
                int bucket = (int)(hashCode % (uint)buckets.Length);
                int last = -1;
                int index = buckets[bucket] - 1;
                while (index >= 0)
                {
                    if (entries[index].HashCode == hashCode && KeyEqual(entries[index].Key, key))
                    {
                        if (last < 0)
                        {
                            buckets[bucket] = entries[index].Next + 1;
                        }
                        else
                        {
                            entries[last].Next = entries[index].Next;
                        }

                        value = entries[index].Value;
                        entries[index].Next = StartOfFreeList - freeList;
                        entries[index].Key = default;
                        entries[index].Value = default;
                        freeList = index;
                        freeCount++;
                        return true;
                    }

                    last = index;
                    index = entries[index].Next;
                }
            }

            value = default;
            return false;
        }

        public void Clear()
        {
            if (count > 0)
            {
                for (int index = 0; index < buckets.Length; index++)
                {
                    buckets[index] = 0;
                }

                for (int index = 0; index < count; index++)
                {
                    entries[index] = default;
                }

                count = 0;
                freeList = -1;
                freeCount = 0;
            }
        }

        // .NET's capacities: primes, 3 at the least, a bit more than
        // doubling as it grows.
        private void Initialize(int capacity)
        {
            int size = Gameplay.Runtime.HashHelpers.GetPrime(capacity);
            buckets = new int[size];
            entries = new Entry[size];
            freeList = -1;
        }

        private int FindEntry(TKey key)
        {
            if (key == null)
            {
                throw new ArgumentNullException();
            }

            if (buckets == null)
            {
                return -1;
            }

            uint hashCode = KeyHash(key);
            int index = buckets[(int)(hashCode % (uint)buckets.Length)] - 1;
            while (index >= 0)
            {
                if (entries[index].HashCode == hashCode && KeyEqual(entries[index].Key, key))
                {
                    return index;
                }

                index = entries[index].Next;
            }

            return -1;
        }

        // CollectionsMarshal.GetValueRefOrAddDefault's: the storage of a
        // key's value, added as the default if the key is not there.
        internal ref TValue ValueRefOrAddDefault(TKey key, out bool exists)
        {
            int index = FindEntry(key);
            exists = index >= 0;
            if (!exists)
            {
                TryInsert(key, default, false);
                index = FindEntry(key);
            }

            return ref entries[index].Value;
        }

        private bool TryInsert(TKey key, TValue value, bool overwrite)
        {
            if (key == null)
            {
                throw new ArgumentNullException();
            }

            if (buckets == null)
            {
                Initialize(0);
            }

            uint hashCode = KeyHash(key);
            int bucket = (int)(hashCode % (uint)buckets.Length);
            int index = buckets[bucket] - 1;
            while (index >= 0)
            {
                if (entries[index].HashCode == hashCode && KeyEqual(entries[index].Key, key))
                {
                    if (overwrite)
                    {
                        entries[index].Value = value;
                        return true;
                    }

                    return false;
                }

                index = entries[index].Next;
            }

            if (freeCount > 0)
            {
                index = freeList;
                freeList = StartOfFreeList - entries[freeList].Next;
                freeCount--;
            }
            else
            {
                if (count == entries.Length)
                {
                    Resize();
                    bucket = (int)(hashCode % (uint)buckets.Length);
                }

                index = count;
                count++;
            }

            entries[index].HashCode = hashCode;
            entries[index].Next = buckets[bucket] - 1;
            entries[index].Key = key;
            entries[index].Value = value;
            buckets[bucket] = index + 1;
            version++;
            return true;
        }

        // Entries keep their indices, so enumeration order is unchanged.
        private void Resize()
        {
            int size = Gameplay.Runtime.HashHelpers.ExpandPrime(count);
            var resized = new Entry[size];
            for (int index = 0; index < count; index++)
            {
                resized[index] = entries[index];
            }

            buckets = new int[size];
            for (int index = 0; index < count; index++)
            {
                int bucket = (int)(resized[index].HashCode % (uint)size);
                resized[index].Next = buckets[bucket] - 1;
                buckets[bucket] = index + 1;
            }

            entries = resized;
        }

        public Enumerator GetEnumerator() => new Enumerator(this);

        // A non-generic IEnumerable enumerates as the generic one.
        IEnumerator IEnumerable.GetEnumerator() => ((IEnumerable<KeyValuePair<TKey, TValue>>)this).GetEnumerator();

        IEnumerator<KeyValuePair<TKey, TValue>> IEnumerable<KeyValuePair<TKey, TValue>>.GetEnumerator() =>
            new DictionaryEnumerator<TKey, TValue>(GetEnumerator());

        public struct Enumerator
            : System.IDisposable
        {
            // .NET's enumerators are disposable, and foreach disposes them.
            public void Dispose()
            {
            }

            private readonly Dictionary<TKey, TValue> dictionary;
            private readonly int version;
            private int index;
            private KeyValuePair<TKey, TValue> current;

            internal Enumerator(Dictionary<TKey, TValue> dictionary)
            {
                this.dictionary = dictionary;
                version = dictionary.version;
                index = 0;
                current = default;
            }

            public bool MoveNext()
            {
                if (version != dictionary.version)
                {
                    throw new InvalidOperationException();
                }

                while ((uint)index < (uint)dictionary.count)
                {
                    int at = index++;
                    if (dictionary.entries[at].Next >= -1)
                    {
                        current = new KeyValuePair<TKey, TValue>(dictionary.entries[at].Key, dictionary.entries[at].Value);
                        return true;
                    }
                }

                index = dictionary.count + 1;
                current = default;
                return false;
            }

            internal void Reset()
            {
                if (version != dictionary.version)
                {
                    throw new InvalidOperationException();
                }

                index = 0;
                current = default;
            }

            public readonly KeyValuePair<TKey, TValue> Current => current;
        }

        public sealed class KeyCollection : IEnumerable<TKey>
        {
            private readonly Dictionary<TKey, TValue> dictionary;

            internal KeyCollection(Dictionary<TKey, TValue> dictionary)
            {
                this.dictionary = dictionary;
            }

            public int Count => dictionary.Count;

            public Enumerator GetEnumerator() => new Enumerator(dictionary);

            // A non-generic IEnumerable enumerates as the generic one.
            IEnumerator IEnumerable.GetEnumerator() => ((IEnumerable<TKey>)this).GetEnumerator();

            IEnumerator<TKey> IEnumerable<TKey>.GetEnumerator() => new KeyEnumerator<TKey, TValue>(GetEnumerator());

            public struct Enumerator
                : System.IDisposable
            {
                // .NET's enumerators are disposable, and foreach disposes them.
                public void Dispose()
                {
                }

                private readonly Dictionary<TKey, TValue> dictionary;
                private readonly int version;
                private int index;
                private TKey current;

                internal Enumerator(Dictionary<TKey, TValue> dictionary)
                {
                    this.dictionary = dictionary;
                    version = dictionary.version;
                    index = 0;
                    current = default;
                }

                public bool MoveNext()
                {
                    if (version != dictionary.version)
                    {
                        throw new InvalidOperationException();
                    }

                    while ((uint)index < (uint)dictionary.count)
                    {
                        int at = index++;
                        if (dictionary.entries[at].Next >= -1)
                        {
                            current = dictionary.entries[at].Key;
                            return true;
                        }
                    }

                    index = dictionary.count + 1;
                    current = default;
                    return false;
                }

                internal void Reset()
                {
                    if (version != dictionary.version)
                    {
                        throw new InvalidOperationException();
                    }

                    index = 0;
                    current = default;
                }

                public readonly TKey Current => current;
            }
        }

        public sealed class ValueCollection : IEnumerable<TValue>
        {
            private readonly Dictionary<TKey, TValue> dictionary;

            internal ValueCollection(Dictionary<TKey, TValue> dictionary)
            {
                this.dictionary = dictionary;
            }

            public int Count => dictionary.Count;

            public Enumerator GetEnumerator() => new Enumerator(dictionary);

            // A non-generic IEnumerable enumerates as the generic one.
            IEnumerator IEnumerable.GetEnumerator() => ((IEnumerable<TValue>)this).GetEnumerator();

            IEnumerator<TValue> IEnumerable<TValue>.GetEnumerator() => new ValueEnumerator<TKey, TValue>(GetEnumerator());

            public struct Enumerator
                : System.IDisposable
            {
                // .NET's enumerators are disposable, and foreach disposes them.
                public void Dispose()
                {
                }

                private readonly Dictionary<TKey, TValue> dictionary;
                private readonly int version;
                private int index;
                private TValue current;

                internal Enumerator(Dictionary<TKey, TValue> dictionary)
                {
                    this.dictionary = dictionary;
                    version = dictionary.version;
                    index = 0;
                    current = default;
                }

                public bool MoveNext()
                {
                    if (version != dictionary.version)
                    {
                        throw new InvalidOperationException();
                    }

                    while ((uint)index < (uint)dictionary.count)
                    {
                        int at = index++;
                        if (dictionary.entries[at].Next >= -1)
                        {
                            current = dictionary.entries[at].Value;
                            return true;
                        }
                    }

                    index = dictionary.count + 1;
                    current = default;
                    return false;
                }

                internal void Reset()
                {
                    if (version != dictionary.version)
                    {
                        throw new InvalidOperationException();
                    }

                    index = 0;
                    current = default;
                }

                public readonly TValue Current => current;
            }
        }
    }

    public sealed class HashSet<T> : IEnumerable, IEnumerable<T>
        , ICollection<T>, IReadOnlyCollection<T>, ISet<T>, IReadOnlySet<T>
    {
        private const int StartOfFreeList = -3;

        private struct Entry
        {
            public int HashCode;
            public int Next;
            public T Value;
        }

        private int[] buckets;
        private Entry[] entries;
        private int count;
        private int freeList;
        private int freeCount;
        private int version;
        // A comparer other than the default one, if the set was made with
        // one.
        private readonly Gameplay.Runtime.KeyComparer<T> comparer;

        // .NET's set operations and collection members, which the
        // framework's code (System.Linq's among it) calls, as dotnet/runtime's
        // HashSet.cs performs them: in its order, so that the entries they
        // free and reuse, and so the order of enumeration after, are its.
        bool ICollection<T>.IsReadOnly => false;

        void ICollection<T>.Add(T item) => Add(item);

        private bool SameComparer(HashSet<T> other) => Gameplay.Runtime.KeyComparer<T>.Same(comparer, other.comparer);

        public bool TryGetValue(T equalValue, out T actualValue)
        {
            int index = FindItemIndex(equalValue);
            if (index >= 0)
            {
                actualValue = entries[index].Value;
                return true;
            }

            actualValue = default;
            return false;
        }

        public void UnionWith(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            foreach (T item in other)
            {
                Add(item);
            }
        }

        public void IntersectWith(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            if (Count == 0 || other == this)
            {
                return;
            }

            if (other is ICollection<T> otherAsCollection)
            {
                if (otherAsCollection.Count == 0)
                {
                    Clear();
                    return;
                }

                if (other is HashSet<T> otherAsSet && SameComparer(otherAsSet))
                {
                    for (int i = 0; i < count; i++)
                    {
                        if (entries[i].Next >= -1 && !otherAsSet.Contains(entries[i].Value))
                        {
                            Remove(entries[i].Value);
                        }
                    }

                    return;
                }
            }

            int originalCount = count;
            var marked = new bool[originalCount];
            foreach (T item in other)
            {
                int index = FindItemIndex(item);
                if (index >= 0)
                {
                    marked[index] = true;
                }
            }

            for (int i = 0; i < originalCount; i++)
            {
                if (entries[i].Next >= -1 && !marked[i])
                {
                    Remove(entries[i].Value);
                }
            }
        }

        public void ExceptWith(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            if (Count == 0)
            {
                return;
            }

            if (other == this)
            {
                Clear();
                return;
            }

            foreach (T element in other)
            {
                Remove(element);
            }
        }

        public void SymmetricExceptWith(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            if (Count == 0)
            {
                UnionWith(other);
                return;
            }

            if (other == this)
            {
                Clear();
                return;
            }

            if (other is HashSet<T> otherAsSet && SameComparer(otherAsSet))
            {
                foreach (T item in otherAsSet)
                {
                    if (!Remove(item))
                    {
                        Add(item);
                    }
                }

                return;
            }

            int originalCount = count;
            var itemsToRemove = new bool[originalCount];
            var itemsAddedFromOther = new bool[originalCount];
            foreach (T item in other)
            {
                int location = FindItemIndex(item);
                if (location < 0)
                {
                    Add(item);
                    location = FindItemIndex(item);
                    if (location < originalCount)
                    {
                        itemsAddedFromOther[location] = true;
                    }
                }
                else if (location < originalCount && !itemsAddedFromOther[location])
                {
                    itemsToRemove[location] = true;
                }
            }

            for (int i = 0; i < originalCount; i++)
            {
                if (itemsToRemove[i])
                {
                    Remove(entries[i].Value);
                }
            }
        }

        private bool IsSubsetOfSet(HashSet<T> other)
        {
            foreach (T item in this)
            {
                if (!other.Contains(item))
                {
                    return false;
                }
            }

            return true;
        }

        // How many of this set's items other has (each once), and how many
        // of other's items this set has not, enumerating other until one is
        // not found if asked to.
        private (int UniqueCount, int UnfoundCount) CheckUniqueAndUnfoundElements(IEnumerable<T> other, bool returnIfUnfound)
        {
            if (count == 0)
            {
                int elements = 0;
                foreach (T item in other)
                {
                    elements++;
                    break;
                }

                return (0, elements);
            }

            var marked = new bool[count];
            int unfoundCount = 0;
            int uniqueFoundCount = 0;
            foreach (T item in other)
            {
                int index = FindItemIndex(item);
                if (index >= 0)
                {
                    if (!marked[index])
                    {
                        marked[index] = true;
                        uniqueFoundCount++;
                    }
                }
                else
                {
                    unfoundCount++;
                    if (returnIfUnfound)
                    {
                        break;
                    }
                }
            }

            return (uniqueFoundCount, unfoundCount);
        }

        public bool IsSubsetOf(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            if (Count == 0 || other == this)
            {
                return true;
            }

            if (other is ICollection<T> otherAsCollection)
            {
                if (Count > otherAsCollection.Count)
                {
                    return false;
                }

                if (other is HashSet<T> otherAsSet && SameComparer(otherAsSet))
                {
                    return IsSubsetOfSet(otherAsSet);
                }
            }

            var (uniqueCount, unfoundCount) = CheckUniqueAndUnfoundElements(other, returnIfUnfound: false);
            return uniqueCount == Count && unfoundCount >= 0;
        }

        public bool IsProperSubsetOf(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            if (other == this)
            {
                return false;
            }

            if (other is ICollection<T> otherAsCollection)
            {
                if (otherAsCollection.Count <= Count)
                {
                    return false;
                }

                if (Count == 0)
                {
                    return true;
                }

                if (other is HashSet<T> otherAsSet && SameComparer(otherAsSet))
                {
                    return IsSubsetOfSet(otherAsSet);
                }
            }

            var (uniqueCount, unfoundCount) = CheckUniqueAndUnfoundElements(other, returnIfUnfound: false);
            return uniqueCount == Count && unfoundCount > 0;
        }

        public bool IsSupersetOf(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            if (other == this)
            {
                return true;
            }

            if (other is ICollection<T> otherAsCollection)
            {
                if (otherAsCollection.Count == 0)
                {
                    return true;
                }

                if (other is HashSet<T> otherAsSet && SameComparer(otherAsSet) && otherAsSet.Count > Count)
                {
                    return false;
                }
            }

            foreach (T element in other)
            {
                if (!Contains(element))
                {
                    return false;
                }
            }

            return true;
        }

        public bool IsProperSupersetOf(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            if (Count == 0 || other == this)
            {
                return false;
            }

            if (other is ICollection<T> otherAsCollection)
            {
                if (otherAsCollection.Count == 0)
                {
                    return true;
                }

                if (other is HashSet<T> otherAsSet && SameComparer(otherAsSet))
                {
                    if (otherAsSet.Count >= Count)
                    {
                        return false;
                    }

                    return otherAsSet.IsSubsetOfSet(this);
                }
            }

            var (uniqueCount, unfoundCount) = CheckUniqueAndUnfoundElements(other, returnIfUnfound: true);
            return uniqueCount < Count && unfoundCount == 0;
        }

        public bool Overlaps(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            if (Count == 0)
            {
                return false;
            }

            if (other == this)
            {
                return true;
            }

            foreach (T element in other)
            {
                if (Contains(element))
                {
                    return true;
                }
            }

            return false;
        }

        public bool SetEquals(IEnumerable<T> other)
        {
            ArgumentNullException.ThrowIfNull(other);
            if (other == this)
            {
                return true;
            }

            if (other is ICollection<T> otherAsCollection)
            {
                if (Count == 0)
                {
                    return otherAsCollection.Count == 0;
                }

                if (other is HashSet<T> otherAsSet && SameComparer(otherAsSet))
                {
                    if (Count != otherAsSet.Count)
                    {
                        return false;
                    }

                    return IsSubsetOfSet(otherAsSet);
                }

                if (Count > otherAsCollection.Count)
                {
                    return false;
                }
            }

            var (uniqueCount, unfoundCount) = CheckUniqueAndUnfoundElements(other, returnIfUnfound: true);
            return uniqueCount == Count && unfoundCount == 0;
        }

        public void CopyTo(T[] array) => CopyTo(array, 0, Count);

        public void CopyTo(T[] array, int arrayIndex) => CopyTo(array, arrayIndex, Count);

        public void CopyTo(T[] array, int arrayIndex, int count)
        {
            ArgumentNullException.ThrowIfNull(array);
            ArgumentOutOfRangeException.ThrowIfNegative(arrayIndex);
            ArgumentOutOfRangeException.ThrowIfNegative(count);
            if (arrayIndex > array.Length || count > array.Length - arrayIndex)
            {
                throw new ArgumentException(SR.Arg_ArrayPlusOffTooSmall);
            }

            for (int i = 0; i < this.count && count != 0; i++)
            {
                if (entries[i].Next >= -1)
                {
                    array[arrayIndex++] = entries[i].Value;
                    count--;
                }
            }
        }

        public int RemoveWhere(Predicate<T> match)
        {
            ArgumentNullException.ThrowIfNull(match);
            int removed = 0;
            for (int i = 0; i < count; i++)
            {
                if (entries[i].Next >= -1)
                {
                    T value = entries[i].Value;
                    if (match(value) && Remove(value))
                    {
                        removed++;
                    }
                }
            }

            return removed;
        }

        public HashSet()
        {
        }

        public HashSet(int capacity)
        {
            if (capacity < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (capacity > 0)
            {
                Initialize(capacity);
            }
        }

        public HashSet(IEqualityComparer<T> comparer)
        {
            this.comparer = Gameplay.Runtime.KeyComparer<T>.Of(comparer);
        }

        public HashSet(int capacity, IEqualityComparer<T> comparer)
            : this(capacity)
        {
            this.comparer = Gameplay.Runtime.KeyComparer<T>.Of(comparer);
        }

        public HashSet(IEnumerable<T> collection)
            : this(collection, null)
        {
        }

        // As .NET's: a set with the same comparer is copied as it is (free
        // entries included) when its capacity is within the next one up;
        // other sequences are added, the set sized first to a collection's
        // count and trimmed when that left it three times too large.
        public HashSet(IEnumerable<T> collection, IEqualityComparer<T> comparer)
        {
            if (collection == null)
            {
                throw new ArgumentNullException("collection");
            }

            this.comparer = Gameplay.Runtime.KeyComparer<T>.Of(comparer);
            if (collection is HashSet<T> other && Gameplay.Runtime.KeyComparer<T>.Same(this.comparer, other.comparer))
            {
                ConstructFrom(other);
                return;
            }

            int known = collection is T[] array ? array.Length
                : collection is List<T> list ? list.Count
                : collection is HashSet<T> set ? set.Count
                : -1;
            if (known > 0)
            {
                Initialize(known);
            }

            // Disposed once it is done, as foreach would, but without a
            // finally: a class member walked for every instance would make
            // every module handle exceptions, so an enumerator whose MoveNext
            // throws is not disposed.
            var enumerator = collection.GetEnumerator();
            while (enumerator.MoveNext())
            {
                T item = enumerator.Current;
                Add(item);
            }

            enumerator.Dispose();

            if (count > 0 && entries.Length / count > 3)
            {
                TrimExcess();
            }
        }

        private void ConstructFrom(HashSet<T> source)
        {
            if (source.Count == 0)
            {
                return;
            }

            if (Gameplay.Runtime.HashHelpers.ExpandPrime(source.Count + 1) >= source.buckets.Length)
            {
                buckets = new int[source.buckets.Length];
                entries = new Entry[source.entries.Length];
                for (int index = 0; index < buckets.Length; index++)
                {
                    buckets[index] = source.buckets[index];
                    entries[index] = source.entries[index];
                }

                freeList = source.freeList;
                freeCount = source.freeCount;
                count = source.count;
                return;
            }

            Initialize(source.Count);
            for (int index = 0; index < source.count; index++)
            {
                if (source.entries[index].Next >= -1)
                {
                    Add(source.entries[index].Value);
                }
            }
        }

        public void TrimExcess()
        {
            int capacity = Count;
            int size = Gameplay.Runtime.HashHelpers.GetPrime(capacity);
            if (entries == null || size >= entries.Length)
            {
                return;
            }

            var old = entries;
            int oldCount = count;
            version++;
            buckets = new int[size];
            entries = new Entry[size];
            count = 0;
            freeList = -1;
            freeCount = 0;
            for (int index = 0; index < oldCount; index++)
            {
                if (old[index].Next >= -1)
                {
                    int hashCode = old[index].HashCode;
                    int bucket = (int)((uint)hashCode % (uint)size);
                    entries[count].HashCode = hashCode;
                    entries[count].Value = old[index].Value;
                    entries[count].Next = buckets[bucket] - 1;
                    buckets[bucket] = count + 1;
                    count++;
                }
            }
        }

        private int ItemHash(T item) => item == null ? 0 : comparer == null ? Intrinsics.Hash(item) : comparer.Hash(item);

        private bool ItemEqual(T stored, T item) => comparer == null ? Intrinsics.Equal(stored, item) : comparer.Same(stored, item);

        public int Count => count - freeCount;

        public bool Add(T item)
        {
            if (buckets == null)
            {
                Initialize(0);
            }

            int hashCode = ItemHash(item);
            int bucket = (int)((uint)hashCode % (uint)buckets.Length);
            int index = buckets[bucket] - 1;
            while (index >= 0)
            {
                if (entries[index].HashCode == hashCode && ItemEqual(entries[index].Value, item))
                {
                    return false;
                }

                index = entries[index].Next;
            }

            if (freeCount > 0)
            {
                index = freeList;
                freeCount--;
                freeList = StartOfFreeList - entries[freeList].Next;
            }
            else
            {
                if (count == entries.Length)
                {
                    Resize();
                    bucket = (int)((uint)hashCode % (uint)buckets.Length);
                }

                index = count;
                count++;
            }

            entries[index].HashCode = hashCode;
            entries[index].Next = buckets[bucket] - 1;
            entries[index].Value = item;
            buckets[bucket] = index + 1;
            version++;
            return true;
        }

        public bool Contains(T item) => FindItemIndex(item) >= 0;

        public bool Remove(T item)
        {
            if (buckets == null)
            {
                return false;
            }

            int hashCode = ItemHash(item);
            int bucket = (int)((uint)hashCode % (uint)buckets.Length);
            int last = -1;
            int index = buckets[bucket] - 1;
            while (index >= 0)
            {
                if (entries[index].HashCode == hashCode && ItemEqual(entries[index].Value, item))
                {
                    if (last < 0)
                    {
                        buckets[bucket] = entries[index].Next + 1;
                    }
                    else
                    {
                        entries[last].Next = entries[index].Next;
                    }

                    entries[index].Next = StartOfFreeList - freeList;
                    entries[index].Value = default;
                    freeList = index;
                    freeCount++;
                    return true;
                }

                last = index;
                index = entries[index].Next;
            }

            return false;
        }

        public void Clear()
        {
            if (count > 0)
            {
                for (int index = 0; index < buckets.Length; index++)
                {
                    buckets[index] = 0;
                }

                for (int index = 0; index < count; index++)
                {
                    entries[index] = default;
                }

                count = 0;
                freeList = -1;
                freeCount = 0;
            }
        }

        // .NET's capacities: primes, 3 at the least, a bit more than
        // doubling as it grows.
        private void Initialize(int capacity)
        {
            int size = Gameplay.Runtime.HashHelpers.GetPrime(capacity);
            buckets = new int[size];
            entries = new Entry[size];
            freeList = -1;
        }

        private int FindItemIndex(T item)
        {
            if (buckets == null)
            {
                return -1;
            }

            int hashCode = ItemHash(item);
            int index = buckets[(int)((uint)hashCode % (uint)buckets.Length)] - 1;
            while (index >= 0)
            {
                if (entries[index].HashCode == hashCode && ItemEqual(entries[index].Value, item))
                {
                    return index;
                }

                index = entries[index].Next;
            }

            return -1;
        }

        private void Resize()
        {
            int size = Gameplay.Runtime.HashHelpers.ExpandPrime(count);
            var resized = new Entry[size];
            for (int index = 0; index < count; index++)
            {
                resized[index] = entries[index];
            }

            buckets = new int[size];
            for (int index = 0; index < count; index++)
            {
                int bucket = (int)((uint)resized[index].HashCode % (uint)size);
                resized[index].Next = buckets[bucket] - 1;
                buckets[bucket] = index + 1;
            }

            entries = resized;
        }

        public Enumerator GetEnumerator() => new Enumerator(this);

        // A non-generic IEnumerable enumerates as the generic one.
        IEnumerator IEnumerable.GetEnumerator() => ((IEnumerable<T>)this).GetEnumerator();

        IEnumerator<T> IEnumerable<T>.GetEnumerator() => new SetEnumerator<T>(GetEnumerator());

        public struct Enumerator
            : System.IDisposable
        {
            // .NET's enumerators are disposable, and foreach disposes them.
            public void Dispose()
            {
            }

            private readonly HashSet<T> set;
            private readonly int version;
            private int index;
            private T current;

            internal Enumerator(HashSet<T> set)
            {
                this.set = set;
                version = set.version;
                index = 0;
                current = default;
            }

            public bool MoveNext()
            {
                if (version != set.version)
                {
                    throw new InvalidOperationException();
                }

                while ((uint)index < (uint)set.count)
                {
                    int at = index++;
                    if (set.entries[at].Next >= -1)
                    {
                        current = set.entries[at].Value;
                        return true;
                    }
                }

                index = set.count + 1;
                current = default;
                return false;
            }

            internal void Reset()
            {
                if (version != set.version)
                {
                    throw new InvalidOperationException();
                }

                index = 0;
                current = default;
            }

            public readonly T Current => current;
        }
    }

    public sealed class Queue<T> : IEnumerable, IEnumerable<T>
    {
        private T[] array;
        private int head;
        private int tail;
        private int size;
        private int version;

        public Queue()
        {
            array = new T[0];
        }

        public Queue(int capacity)
        {
            if (capacity < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            array = new T[capacity];
        }

        public int Count => size;

        public void Enqueue(T item)
        {
            if (size == array.Length)
            {
                Grow(size + 1);
            }

            array[tail] = item;
            tail = Next(tail);
            size++;
            version++;
        }

        public T Dequeue()
        {
            if (size == 0)
            {
                throw new InvalidOperationException();
            }

            T removed = array[head];
            array[head] = default;
            head = Next(head);
            size--;
            version++;
            return removed;
        }

        public bool TryDequeue(out T result)
        {
            if (size == 0)
            {
                result = default;
                return false;
            }

            result = Dequeue();
            return true;
        }

        public T Peek()
        {
            if (size == 0)
            {
                throw new InvalidOperationException();
            }

            return array[head];
        }

        public bool TryPeek(out T result)
        {
            if (size == 0)
            {
                result = default;
                return false;
            }

            result = array[head];
            return true;
        }

        public bool Contains(T item)
        {
            for (int index = 0; index < size; index++)
            {
                if (Intrinsics.Equal(array[(head + index) % array.Length], item))
                {
                    return true;
                }
            }

            return false;
        }

        public void Clear()
        {
            for (int index = 0; index < array.Length; index++)
            {
                array[index] = default;
            }

            size = 0;
            head = 0;
            tail = 0;
            version++;
        }

        public T[] ToArray()
        {
            var result = new T[size];
            for (int index = 0; index < size; index++)
            {
                result[index] = array[(head + index) % array.Length];
            }

            return result;
        }

        private int Next(int index) => index + 1 == array.Length ? 0 : index + 1;

        private void Grow(int capacity)
        {
            int next = 2 * array.Length;
            if (next < array.Length + 4)
            {
                next = array.Length + 4;
            }

            if (next < capacity)
            {
                next = capacity;
            }

            var grown = new T[next];
            for (int index = 0; index < size; index++)
            {
                grown[index] = array[(head + index) % array.Length];
            }

            array = grown;
            head = 0;
            tail = size == next ? 0 : size;
        }

        public Enumerator GetEnumerator() => new Enumerator(this);

        // A non-generic IEnumerable enumerates as the generic one.
        IEnumerator IEnumerable.GetEnumerator() => ((IEnumerable<T>)this).GetEnumerator();

        IEnumerator<T> IEnumerable<T>.GetEnumerator() => new QueueEnumerator<T>(GetEnumerator());

        public struct Enumerator
            : System.IDisposable
        {
            // .NET's enumerators are disposable, and foreach disposes them.
            public void Dispose()
            {
            }

            private readonly Queue<T> queue;
            private readonly int version;
            // -1 before the first element, -2 after the last.
            private int index;
            private T current;

            internal Enumerator(Queue<T> queue)
            {
                this.queue = queue;
                version = queue.version;
                index = -1;
                current = default;
            }

            public bool MoveNext()
            {
                if (version != queue.version)
                {
                    throw new InvalidOperationException();
                }

                if (index == -2)
                {
                    return false;
                }

                index++;
                if (index == queue.size)
                {
                    index = -2;
                    current = default;
                    return false;
                }

                current = queue.array[(queue.head + index) % queue.array.Length];
                return true;
            }

            internal void Reset()
            {
                if (version != queue.version)
                {
                    throw new InvalidOperationException();
                }

                index = -1;
                current = default;
            }

            public readonly T Current
            {
                get
                {
                    if (index < 0)
                    {
                        throw new InvalidOperationException();
                    }

                    return current;
                }
            }
        }
    }
}
