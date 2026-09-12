// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Comparer<T>, EqualityComparer<T> and StringComparer's ordinal comparers,
// as .NET's: Default is one object per type (the default order and
// equality the CLR chooses for the type, see Frontend.Linq and
// FunctionEmitter.Equality), Create wraps a delegate, and the ordinal
// string comparers compare code units (ignoring case: code points, each
// uppercased, as .NET's invariant mode does). The culture-sensitive string
// comparers are not here, so code naming them is rejected.

namespace System.Collections.Generic
{
    public abstract class Comparer<T> : IComparer<T>
    {
        public static Comparer<T> Default => DefaultComparer<T>.Instance;

        public static Comparer<T> Create(Comparison<T> comparison)
        {
            if (comparison == null)
            {
                throw new ArgumentNullException("comparison");
            }

            return new ComparisonComparer<T>(comparison);
        }

        public abstract int Compare(T x, T y);
    }

    internal sealed class DefaultComparer<T> : Comparer<T>
    {
        internal static readonly DefaultComparer<T> Instance = new DefaultComparer<T>();

        public override int Compare(T x, T y) => Gameplay.Runtime.Intrinsics.Compare(x, y);
    }

    internal sealed class ComparisonComparer<T> : Comparer<T>
    {
        private readonly Comparison<T> comparison;

        internal ComparisonComparer(Comparison<T> comparison)
        {
            this.comparison = comparison;
        }

        public override int Compare(T x, T y) => comparison(x, y);
    }

    public abstract class EqualityComparer<T> : IEqualityComparer<T>
    {
        public static EqualityComparer<T> Default => DefaultEqualityComparer<T>.Instance;

        public static EqualityComparer<T> Create(Func<T, T, bool> equals, Func<T, int> getHashCode = null)
        {
            if (equals == null)
            {
                throw new ArgumentNullException("equals");
            }

            return new DelegateEqualityComparer<T>(equals, getHashCode);
        }

        public abstract bool Equals(T x, T y);

        public abstract int GetHashCode(T obj);
    }

    internal sealed class DefaultEqualityComparer<T> : EqualityComparer<T>
    {
        internal static readonly DefaultEqualityComparer<T> Instance = new DefaultEqualityComparer<T>();

        public override bool Equals(T x, T y) => Gameplay.Runtime.Intrinsics.Equal(x, y);

        public override int GetHashCode(T obj) => obj == null ? 0 : Gameplay.Runtime.Intrinsics.Hash(obj);
    }

    internal sealed class DelegateEqualityComparer<T> : EqualityComparer<T>
    {
        private readonly Func<T, T, bool> equals;
        private readonly Func<T, int> getHashCode;

        internal DelegateEqualityComparer(Func<T, T, bool> equals, Func<T, int> getHashCode)
        {
            this.equals = equals;
            this.getHashCode = getHashCode;
        }

        public override bool Equals(T x, T y) => equals(x, y);

        public override int GetHashCode(T obj) =>
            getHashCode == null ? throw new NotSupportedException() : getHashCode(obj);
    }
}

namespace Gameplay.Runtime
{
    // System.StringComparer (see Frontend.RuntimeCounterpart): its ordinal
    // comparers.
    internal abstract class StringComparer : System.Collections.Generic.IComparer<string>,
        System.Collections.Generic.IEqualityComparer<string>
    {
        // In a generic holder: a non-generic runtime class's static state
        // would be every module's (see Frontend.Initialization).
        public static StringComparer Ordinal => StaticState<StringComparer>.Ordinal;

        public static StringComparer OrdinalIgnoreCase => StaticState<StringComparer>.OrdinalIgnoreCase;

        // The culture's order, which strings do not have here: a comparer
        // that throws where it would compare, as Comparer<string>.Default's
        // order does. System.Linq names it for OrderBy's string keys under
        // the default comparer, which the user's own calls are rejected for
        // (Frontend.Linq).
        public static StringComparer CurrentCulture => new CultureComparer();

        private sealed class CultureComparer : StringComparer
        {
            public override int Compare(string x, string y) => Ordering.Unsupported();

            public override bool Equals(string x, string y) => Ordering.Unsupported() == 0;

            public override int GetHashCode(string obj) => Ordering.Unsupported();
        }

        public abstract int Compare(string x, string y);

        public abstract bool Equals(string x, string y);

        public abstract int GetHashCode(string obj);
    }

    internal sealed class OrdinalComparer : StringComparer
    {
        private readonly bool ignoreCase;

        internal OrdinalComparer(bool ignoreCase)
        {
            this.ignoreCase = ignoreCase;
        }

        public override int Compare(string x, string y)
        {
            if (ReferenceEquals(x, y))
            {
                return 0;
            }

            if (x == null)
            {
                return -1;
            }

            if (y == null)
            {
                return 1;
            }

            return ignoreCase ? Text.CompareIgnoreCase(x, y) : Strings.CompareOrdinal(x, y);
        }

        public override bool Equals(string x, string y)
        {
            if (ReferenceEquals(x, y))
            {
                return true;
            }

            if (x == null || y == null || x.Length != y.Length)
            {
                return false;
            }

            return ignoreCase ? Text.CompareIgnoreCase(x, y) == 0 : x == y;
        }

        public override int GetHashCode(string obj)
        {
            if (obj == null)
            {
                throw new System.ArgumentNullException("obj");
            }

            return Intrinsics.Hash(ignoreCase ? obj.ToUpperInvariant() : obj);
        }
    }
}

namespace Gameplay.Runtime
{
    // A dictionary's or set's comparer other than the default one (which
    // is kept as none, as .NET treats it), behind a class of the runtime's
    // so that the collections name no interface until one is given.
    internal abstract class KeyComparer<T>
    {
        internal abstract bool Same(T x, T y);

        internal abstract int Hash(T value);

        internal abstract bool Wraps(KeyComparer<T> other);

        internal static KeyComparer<T> Of(System.Collections.Generic.IEqualityComparer<T> comparer) =>
            comparer == null || comparer is System.Collections.Generic.DefaultEqualityComparer<T>
                ? null
                : new InterfaceKeyComparer<T>(comparer);

        // Whether two collections compare alike, as .NET decides it for
        // copying a set: both by default, or by one comparer.
        internal static bool Same(KeyComparer<T> left, KeyComparer<T> right) =>
            left == null ? right == null : right != null && left.Wraps(right);
    }

    internal sealed class InterfaceKeyComparer<T> : KeyComparer<T>
    {
        private readonly System.Collections.Generic.IEqualityComparer<T> comparer;

        internal InterfaceKeyComparer(System.Collections.Generic.IEqualityComparer<T> comparer)
        {
            this.comparer = comparer;
        }

        internal override bool Same(T x, T y) => comparer.Equals(x, y);

        internal override int Hash(T value) => comparer.GetHashCode(value);

        internal override bool Wraps(KeyComparer<T> other) =>
            other is InterfaceKeyComparer<T> wrapper && wrapper.comparer == comparer;
    }

    // The runtime's static state, in a generic class so that a module has
    // it only where it is used.
    internal static class StaticState<T>
    {
        internal static readonly StringComparer Ordinal = new OrdinalComparer(false);
        internal static readonly StringComparer OrdinalIgnoreCase = new OrdinalComparer(true);

        internal static readonly int[] Primes =
        [
            3, 7, 11, 17, 23, 29, 37, 47, 59, 71, 89, 107, 131, 163, 197, 239, 293, 353, 431, 521, 631, 761, 919,
            1103, 1327, 1597, 1931, 2333, 2801, 3371, 4049, 4861, 5839, 7013, 8419, 10103, 12143, 14591,
            17519, 21023, 25229, 30293, 36353, 43627, 52361, 62851, 75431, 90523, 108631, 130363, 156437,
            187751, 225307, 270371, 324449, 389357, 467237, 560689, 672827, 807403, 968897, 1162687, 1395263,
            1674319, 2009191, 2411033, 2893249, 3471899, 4166287, 4999559, 5999471, 7199369,
        ];
    }

    // .NET's HashHelpers: the primes hashed collections size themselves by.
    internal static class HashHelpers
    {

        public static int GetPrime(int min)
        {
            if (min < 0)
            {
                throw new System.ArgumentException();
            }

            foreach (int prime in StaticState<int>.Primes)
            {
                if (prime >= min)
                {
                    return prime;
                }
            }

            for (int candidate = min | 1; candidate < int.MaxValue; candidate += 2)
            {
                if (IsPrime(candidate) && (candidate - 1) % 101 != 0)
                {
                    return candidate;
                }
            }

            return min;
        }

        private static bool IsPrime(int candidate)
        {
            if ((candidate & 1) != 0)
            {
                for (int divisor = 3; divisor * divisor <= candidate; divisor += 2)
                {
                    if (candidate % divisor == 0)
                    {
                        return false;
                    }
                }

                return true;
            }

            return candidate == 2;
        }

        public static int ExpandPrime(int oldSize)
        {
            int newSize = 2 * oldSize;
            if ((uint)newSize > 0x7FFFFFC3u && 0x7FFFFFC3 > oldSize)
            {
                return 0x7FFFFFC3;
            }

            return GetPrime(newSize);
        }
    }
}
