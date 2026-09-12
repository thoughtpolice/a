// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Multidimensional arrays (`T[,]` to rank 8): the elements in one flat
// array in row-major order, as the CLR lays them out and as foreach visits
// them, and the length of each dimension. The compiler indexes the flat
// array itself (see Frontend.Arrays); System.Array's members on such an
// array are these. Each rank is a class of its own, so that type tests
// tell `int[,]` from `int[,,]` as the CLR does.

namespace Gameplay.Runtime
{
    internal abstract class MdArray<T>
    {
        internal readonly T[] items;
        internal readonly int[] lengths;

        protected MdArray(T[] items, int[] lengths)
        {
            this.items = items;
            this.lengths = lengths;
        }

        // `new T[a, b, ...]`: a negative length is the CLR's
        // OverflowException, and so is a total past int's range.
        internal static MdArray<T> New(int[] lengths)
        {
            int total = 1;
            for (int dimension = 0; dimension < lengths.Length; dimension++)
            {
                if (lengths[dimension] < 0)
                {
                    throw new System.OverflowException();
                }

                total = checked(total * lengths[dimension]);
            }

            var items = new T[total];
            switch (lengths.Length)
            {
                case 2:
                    return new MdArray2<T>(items, lengths);
                case 3:
                    return new MdArray3<T>(items, lengths);
                case 4:
                    return new MdArray4<T>(items, lengths);
                case 5:
                    return new MdArray5<T>(items, lengths);
                case 6:
                    return new MdArray6<T>(items, lengths);
                case 7:
                    return new MdArray7<T>(items, lengths);
                default:
                    return new MdArray8<T>(items, lengths);
            }
        }

        public int Length => items.Length;

        public long LongLength => items.Length;

        public int Rank => lengths.Length;

        public int GetLength(int dimension)
        {
            if ((uint)dimension >= (uint)lengths.Length)
            {
                throw new System.IndexOutOfRangeException();
            }

            return lengths[dimension];
        }

        public long GetLongLength(int dimension) => GetLength(dimension);

        public int GetLowerBound(int dimension)
        {
            GetLength(dimension);
            return 0;
        }

        public int GetUpperBound(int dimension) => GetLength(dimension) - 1;
    }

    internal sealed class MdArray2<T> : MdArray<T>
    {
        internal MdArray2(T[] items, int[] lengths)
            : base(items, lengths)
        {
        }
    }

    internal sealed class MdArray3<T> : MdArray<T>
    {
        internal MdArray3(T[] items, int[] lengths)
            : base(items, lengths)
        {
        }
    }

    internal sealed class MdArray4<T> : MdArray<T>
    {
        internal MdArray4(T[] items, int[] lengths)
            : base(items, lengths)
        {
        }
    }

    internal sealed class MdArray5<T> : MdArray<T>
    {
        internal MdArray5(T[] items, int[] lengths)
            : base(items, lengths)
        {
        }
    }

    internal sealed class MdArray6<T> : MdArray<T>
    {
        internal MdArray6(T[] items, int[] lengths)
            : base(items, lengths)
        {
        }
    }

    internal sealed class MdArray7<T> : MdArray<T>
    {
        internal MdArray7(T[] items, int[] lengths)
            : base(items, lengths)
        {
        }
    }

    internal sealed class MdArray8<T> : MdArray<T>
    {
        internal MdArray8(T[] items, int[] lengths)
            : base(items, lengths)
        {
        }
    }
}
