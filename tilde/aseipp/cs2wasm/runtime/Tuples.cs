// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The tuples C# writes as (a, b), which the language lowers to the BCL's
// ValueTuple structs: the same public fields, equality, hashing and text.
// Like the collections, they are generic, so nothing reaches a module
// unless code uses it. Equals compares element by element as
// EqualityComparer<T>.Default does; GetHashCode combines the elements'
// hashes deterministically, where the CLR's HashCode.Combine is seeded at
// random per process.

using Gameplay.Runtime;

namespace System
{
    public struct ValueTuple<T1, T2>
    {
        public T1 Item1;
        public T2 Item2;

        public ValueTuple(T1 item1, T2 item2)
        {
            Item1 = item1;
            Item2 = item2;
        }

        public bool Equals(ValueTuple<T1, T2> other) =>
            Intrinsics.Equal(Item1, other.Item1)
                && Intrinsics.Equal(Item2, other.Item2);

        public override bool Equals(object obj) => obj is ValueTuple<T1, T2> other && Equals(other);

        public override int GetHashCode()
        {
            int hash = Intrinsics.Hash(Item1);
            hash = hash * -1521134295 + Intrinsics.Hash(Item2);
            return hash;
        }

        public override string ToString() => "(" + Item1?.ToString() + ", " + Item2?.ToString() + ")";
    }

    public struct ValueTuple<T1, T2, T3>
    {
        public T1 Item1;
        public T2 Item2;
        public T3 Item3;

        public ValueTuple(T1 item1, T2 item2, T3 item3)
        {
            Item1 = item1;
            Item2 = item2;
            Item3 = item3;
        }

        public bool Equals(ValueTuple<T1, T2, T3> other) =>
            Intrinsics.Equal(Item1, other.Item1)
                && Intrinsics.Equal(Item2, other.Item2)
                && Intrinsics.Equal(Item3, other.Item3);

        public override bool Equals(object obj) => obj is ValueTuple<T1, T2, T3> other && Equals(other);

        public override int GetHashCode()
        {
            int hash = Intrinsics.Hash(Item1);
            hash = hash * -1521134295 + Intrinsics.Hash(Item2);
            hash = hash * -1521134295 + Intrinsics.Hash(Item3);
            return hash;
        }

        public override string ToString() => "(" + Item1?.ToString() + ", " + Item2?.ToString() + ", " + Item3?.ToString() + ")";
    }

    public struct ValueTuple<T1, T2, T3, T4>
    {
        public T1 Item1;
        public T2 Item2;
        public T3 Item3;
        public T4 Item4;

        public ValueTuple(T1 item1, T2 item2, T3 item3, T4 item4)
        {
            Item1 = item1;
            Item2 = item2;
            Item3 = item3;
            Item4 = item4;
        }

        public bool Equals(ValueTuple<T1, T2, T3, T4> other) =>
            Intrinsics.Equal(Item1, other.Item1)
                && Intrinsics.Equal(Item2, other.Item2)
                && Intrinsics.Equal(Item3, other.Item3)
                && Intrinsics.Equal(Item4, other.Item4);

        public override bool Equals(object obj) => obj is ValueTuple<T1, T2, T3, T4> other && Equals(other);

        public override int GetHashCode()
        {
            int hash = Intrinsics.Hash(Item1);
            hash = hash * -1521134295 + Intrinsics.Hash(Item2);
            hash = hash * -1521134295 + Intrinsics.Hash(Item3);
            hash = hash * -1521134295 + Intrinsics.Hash(Item4);
            return hash;
        }

        public override string ToString() => "(" + Item1?.ToString() + ", " + Item2?.ToString() + ", " + Item3?.ToString() + ", " + Item4?.ToString() + ")";
    }

    public struct ValueTuple<T1, T2, T3, T4, T5>
    {
        public T1 Item1;
        public T2 Item2;
        public T3 Item3;
        public T4 Item4;
        public T5 Item5;

        public ValueTuple(T1 item1, T2 item2, T3 item3, T4 item4, T5 item5)
        {
            Item1 = item1;
            Item2 = item2;
            Item3 = item3;
            Item4 = item4;
            Item5 = item5;
        }

        public bool Equals(ValueTuple<T1, T2, T3, T4, T5> other) =>
            Intrinsics.Equal(Item1, other.Item1)
                && Intrinsics.Equal(Item2, other.Item2)
                && Intrinsics.Equal(Item3, other.Item3)
                && Intrinsics.Equal(Item4, other.Item4)
                && Intrinsics.Equal(Item5, other.Item5);

        public override bool Equals(object obj) => obj is ValueTuple<T1, T2, T3, T4, T5> other && Equals(other);

        public override int GetHashCode()
        {
            int hash = Intrinsics.Hash(Item1);
            hash = hash * -1521134295 + Intrinsics.Hash(Item2);
            hash = hash * -1521134295 + Intrinsics.Hash(Item3);
            hash = hash * -1521134295 + Intrinsics.Hash(Item4);
            hash = hash * -1521134295 + Intrinsics.Hash(Item5);
            return hash;
        }

        public override string ToString() => "(" + Item1?.ToString() + ", " + Item2?.ToString() + ", " + Item3?.ToString() + ", " + Item4?.ToString() + ", " + Item5?.ToString() + ")";
    }

    public struct ValueTuple<T1, T2, T3, T4, T5, T6>
    {
        public T1 Item1;
        public T2 Item2;
        public T3 Item3;
        public T4 Item4;
        public T5 Item5;
        public T6 Item6;

        public ValueTuple(T1 item1, T2 item2, T3 item3, T4 item4, T5 item5, T6 item6)
        {
            Item1 = item1;
            Item2 = item2;
            Item3 = item3;
            Item4 = item4;
            Item5 = item5;
            Item6 = item6;
        }

        public bool Equals(ValueTuple<T1, T2, T3, T4, T5, T6> other) =>
            Intrinsics.Equal(Item1, other.Item1)
                && Intrinsics.Equal(Item2, other.Item2)
                && Intrinsics.Equal(Item3, other.Item3)
                && Intrinsics.Equal(Item4, other.Item4)
                && Intrinsics.Equal(Item5, other.Item5)
                && Intrinsics.Equal(Item6, other.Item6);

        public override bool Equals(object obj) => obj is ValueTuple<T1, T2, T3, T4, T5, T6> other && Equals(other);

        public override int GetHashCode()
        {
            int hash = Intrinsics.Hash(Item1);
            hash = hash * -1521134295 + Intrinsics.Hash(Item2);
            hash = hash * -1521134295 + Intrinsics.Hash(Item3);
            hash = hash * -1521134295 + Intrinsics.Hash(Item4);
            hash = hash * -1521134295 + Intrinsics.Hash(Item5);
            hash = hash * -1521134295 + Intrinsics.Hash(Item6);
            return hash;
        }

        public override string ToString() => "(" + Item1?.ToString() + ", " + Item2?.ToString() + ", " + Item3?.ToString() + ", " + Item4?.ToString() + ", " + Item5?.ToString() + ", " + Item6?.ToString() + ")";
    }

    public struct ValueTuple<T1, T2, T3, T4, T5, T6, T7>
    {
        public T1 Item1;
        public T2 Item2;
        public T3 Item3;
        public T4 Item4;
        public T5 Item5;
        public T6 Item6;
        public T7 Item7;

        public ValueTuple(T1 item1, T2 item2, T3 item3, T4 item4, T5 item5, T6 item6, T7 item7)
        {
            Item1 = item1;
            Item2 = item2;
            Item3 = item3;
            Item4 = item4;
            Item5 = item5;
            Item6 = item6;
            Item7 = item7;
        }

        public bool Equals(ValueTuple<T1, T2, T3, T4, T5, T6, T7> other) =>
            Intrinsics.Equal(Item1, other.Item1)
                && Intrinsics.Equal(Item2, other.Item2)
                && Intrinsics.Equal(Item3, other.Item3)
                && Intrinsics.Equal(Item4, other.Item4)
                && Intrinsics.Equal(Item5, other.Item5)
                && Intrinsics.Equal(Item6, other.Item6)
                && Intrinsics.Equal(Item7, other.Item7);

        public override bool Equals(object obj) => obj is ValueTuple<T1, T2, T3, T4, T5, T6, T7> other && Equals(other);

        public override int GetHashCode()
        {
            int hash = Intrinsics.Hash(Item1);
            hash = hash * -1521134295 + Intrinsics.Hash(Item2);
            hash = hash * -1521134295 + Intrinsics.Hash(Item3);
            hash = hash * -1521134295 + Intrinsics.Hash(Item4);
            hash = hash * -1521134295 + Intrinsics.Hash(Item5);
            hash = hash * -1521134295 + Intrinsics.Hash(Item6);
            hash = hash * -1521134295 + Intrinsics.Hash(Item7);
            return hash;
        }

        public override string ToString() => "(" + Item1?.ToString() + ", " + Item2?.ToString() + ", " + Item3?.ToString() + ", " + Item4?.ToString() + ", " + Item5?.ToString() + ", " + Item6?.ToString() + ", " + Item7?.ToString() + ")";
    }
}
