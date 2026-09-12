// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// ArrayPool<T>, which the imported framework assemblies rent scratch arrays
// from: here a rented array is a new one of the length asked for (the
// collector reclaims it; a pool would only keep arrays alive), and
// returning it does nothing. Callers use no more of an array than they
// asked for, as .NET's pools' larger arrays require.

namespace System.Buffers
{
    public abstract class ArrayPool<T>
    {
        public static ArrayPool<T> Shared { get; } = new AllocatingArrayPool<T>();

        public static ArrayPool<T> Create() => new AllocatingArrayPool<T>();

        public abstract T[] Rent(int minimumLength);

        public abstract void Return(T[] array, bool clearArray = false);
    }

    internal sealed class AllocatingArrayPool<T> : ArrayPool<T>
    {
        public override T[] Rent(int minimumLength)
        {
            ArgumentOutOfRangeException.ThrowIfNegative(minimumLength);
            return new T[minimumLength];
        }

        public override void Return(T[] array, bool clearArray = false) => ArgumentNullException.ThrowIfNull(array);
    }
}
