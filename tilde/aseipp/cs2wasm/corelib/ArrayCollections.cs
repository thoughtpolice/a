// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A one-dimensional array as the collection interfaces the CLR gives it
// (ICollection<T>, IList<T>, IReadOnlyCollection<T>, IReadOnlyList<T>): a
// call of one of their members on an array runs these, as the CLR's
// SZArrayHelper runs them (Frontend.ArrayImplementation). The members that
// would change the array's length are not supported, with .NET's
// messages.

using System;
using System.Collections.Generic;

namespace Gameplay.Runtime
{
    internal static class ArrayCollections
    {
        internal static int Count<T>(T[] array) => array.Length;

        internal static bool IsReadOnly<T>(T[] array) => true;

        internal static T GetItem<T>(T[] array, int index)
        {
            if ((uint)index >= (uint)array.Length)
            {
                throw new ArgumentOutOfRangeException("index", SR.ArgumentOutOfRange_IndexMustBeLess);
            }

            return array[index];
        }

        internal static void SetItem<T>(T[] array, int index, T value)
        {
            if ((uint)index >= (uint)array.Length)
            {
                throw new ArgumentOutOfRangeException("index", SR.ArgumentOutOfRange_IndexMustBeLess);
            }

            array[index] = value;
        }

        // An array of references compares as EqualityComparer<object>
        // would, by Equals(object): the CLR runs SZArrayHelper's shared
        // code over them, whose default comparer is object's, not T's
        // (an IEquatable<T>'s Equals(T) is not called), unlike List<T>'s.
        internal static int IndexOf<T>(T[] array, T value)
        {
            if (!typeof(T).IsValueType)
            {
                return ObjectIndexOf(array, value);
            }

            var comparer = EqualityComparer<T>.Default;
            for (int index = 0; index < array.Length; index++)
            {
                if (comparer.Equals(array[index], value))
                {
                    return index;
                }
            }

            return -1;
        }

        internal static bool Contains<T>(T[] array, T value) => IndexOf(array, value) >= 0;

        internal static void CopyTo<T>(T[] array, T[] destination, int index) =>
            ArrayMethods.Copy(array, 0, destination, index, array.Length);

        internal static void Add<T>(T[] array, T value) =>
            throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static void Insert<T>(T[] array, int index, T value) =>
            throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static bool Remove<T>(T[] array, T value) =>
            throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static void RemoveAt<T>(T[] array, int index) =>
            throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static void Clear<T>(T[] array) =>
            throw new NotSupportedException(SR.NotSupported_ReadOnlyCollection);

        // The non-generic IEnumerable, ICollection and IList, which any
        // array is: the importer calls the one of its element type
        // (Frontend.ObjectArrayHelper). IList's indexer is Array's
        // GetValue, which throws IndexOutOfRangeException.
        internal static System.Collections.IEnumerator ObjectGetEnumerator<T>(T[] array) => Enumerables.OfArray(array);

        internal static int ObjectCount<T>(T[] array) => array.Length;

        internal static object ObjectGetItem<T>(T[] array, int index) => array[index];

        internal static void ObjectSetItem<T>(T[] array, int index, object value)
        {
            if ((uint)index >= (uint)array.Length)
            {
                ThrowHelper.ThrowIndexOutOfRangeException();
            }

            if (value is not T && !(value is null && default(T) is null))
            {
                throw new InvalidCastException(SR.Arg_ObjObjEx);
            }

            array[index] = (T)value!;
        }

        internal static int ObjectIndexOf<T>(T[] array, object value)
        {
            for (int index = 0; index < array.Length; index++)
            {
                object element = array[index];
                if (element == null ? value == null : element.Equals(value))
                {
                    return index;
                }
            }

            return -1;
        }

        internal static bool ObjectContains<T>(T[] array, object value) => ObjectIndexOf(array, value) >= 0;

        internal static bool ObjectIsReadOnly<T>(T[] array) => false;

        internal static bool ObjectIsFixedSize<T>(T[] array) => true;

        internal static void ObjectClear<T>(T[] array) => ArrayMethods.Clear(array);

        internal static int ObjectAdd<T>(T[] array, object value) =>
            throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static void ObjectInsert<T>(T[] array, int index, object value) =>
            throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static void ObjectRemove<T>(T[] array, object value) =>
            throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static void ObjectRemoveAt<T>(T[] array, int index) =>
            throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);
    }
}

namespace Gameplay.Runtime
{
    // An array of X as a collection interface of E, a type its elements
    // convert to by reference (a Bird[] as an IReadOnlyList<Animal>), by
    // array covariance: the CLR's SZArrayHelper of E over it, whose stores
    // check the value's type.
    internal static class CovariantArrayCollections
    {
        internal static int CovariantCount<X, E>(X[] array)
            where X : E => array.Length;

        internal static bool CovariantIsReadOnly<X, E>(X[] array)
            where X : E => true;

        internal static E CovariantGetItem<X, E>(X[] array, int index)
            where X : E => ArrayCollections.GetItem(array, index);

        internal static void CovariantSetItem<X, E>(X[] array, int index, E value)
            where X : E
        {
            if ((uint)index >= (uint)array.Length)
            {
                throw new ArgumentOutOfRangeException("index", SR.ArgumentOutOfRange_IndexMustBeLess);
            }

            if (value is X element)
            {
                array[index] = element;
            }
            else if (value is null)
            {
                array[index] = default!;
            }
            else
            {
                throw new ArrayTypeMismatchException();
            }
        }

        // By Equals(object), as ArrayCollections.IndexOf compares
        // references.
        internal static int CovariantIndexOf<X, E>(X[] array, E value)
            where X : E => ArrayCollections.ObjectIndexOf(array, value);

        internal static bool CovariantContains<X, E>(X[] array, E value)
            where X : E => CovariantIndexOf(array, value) >= 0;

        internal static void CovariantCopyTo<X, E>(X[] array, E[] destination, int index)
            where X : E
        {
            ArgumentNullException.ThrowIfNull(destination, "destinationArray");
            ArgumentOutOfRangeException.ThrowIfLessThan(index, 0, "destinationIndex");
            if ((uint)(index + array.Length) > (uint)destination.Length)
            {
                throw new ArgumentException(SR.Arg_LongerThanDestArray, "destinationArray");
            }

            for (int offset = 0; offset < array.Length; offset++)
            {
                destination[index + offset] = array[offset];
            }
        }

        internal static void CovariantAdd<X, E>(X[] array, E value)
            where X : E => throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static void CovariantInsert<X, E>(X[] array, int index, E value)
            where X : E => throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static bool CovariantRemove<X, E>(X[] array, E value)
            where X : E => throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static void CovariantRemoveAt<X, E>(X[] array, int index)
            where X : E => throw new NotSupportedException(SR.NotSupported_FixedSizeCollection);

        internal static void CovariantClear<X, E>(X[] array)
            where X : E => throw new NotSupportedException(SR.NotSupported_ReadOnlyCollection);
    }
}
