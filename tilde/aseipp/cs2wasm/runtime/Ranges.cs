// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Index and Range as .NET has them, which the compiler takes for the
// framework's (Frontend.RuntimeCounterpart), matching members by name and
// parameter types, and the slice `array[range]` makes.

namespace Gameplay.Runtime
{
    public readonly struct Index
    {
        // Non-negative from the start; the complement from the end.
        private readonly int _value;

        public Index(int value, bool fromEnd = false)
        {
            if (value < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            _value = fromEnd ? ~value : value;
        }

        private Index(bool encoded, int value) => _value = value;

        public static Index Start => new Index(true, 0);

        public static Index End => new Index(true, ~0);

        public static Index FromStart(int value) =>
            value >= 0 ? new Index(true, value) : throw new System.ArgumentOutOfRangeException();

        public static Index FromEnd(int value) =>
            value >= 0 ? new Index(true, ~value) : throw new System.ArgumentOutOfRangeException();

        public int Value => _value < 0 ? ~_value : _value;

        public bool IsFromEnd => _value < 0;

        public int GetOffset(int length)
        {
            int offset = _value;
            if (IsFromEnd)
            {
                offset += length + 1;
            }

            return offset;
        }

        public bool Equals(Index other) => _value == other._value;

        public override bool Equals(object value) => value is Index index && _value == index._value;

        public override int GetHashCode() => _value;

        public override string ToString() => IsFromEnd ? "^" + ((uint)Value).ToString() : ((uint)Value).ToString();

        public static implicit operator Index(int value) => FromStart(value);
    }

    public readonly struct Range
    {
        public Index Start { get; }

        public Index End { get; }

        public Range(Index start, Index end)
        {
            Start = start;
            End = end;
        }

        public static Range StartAt(Index start) => new Range(start, Index.End);

        public static Range EndAt(Index end) => new Range(Index.Start, end);

        public static Range All => new Range(Index.Start, Index.End);

        public (int Offset, int Length) GetOffsetAndLength(int length)
        {
            int start = Start.GetOffset(length);
            int end = End.GetOffset(length);
            if ((uint)end > (uint)length || (uint)start > (uint)end)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return (start, end - start);
        }

        public bool Equals(Range other) => other.Start.Equals(Start) && other.End.Equals(End);

        public override bool Equals(object value) => value is Range range && Equals(range);

        public override int GetHashCode() => Start.GetHashCode() * 31 + End.GetHashCode();

        public override string ToString() => Start.ToString() + ".." + End.ToString();
    }

    internal static class Ranges
    {
        // RuntimeHelpers.GetSubArray, which `array[range]` calls.
        public static T[] SubArray<T>(T[] array, Range range)
        {
            if (array == null)
            {
                throw new System.ArgumentNullException();
            }

            var (offset, length) = range.GetOffsetAndLength(array.Length);
            return SubArrayAt(array, offset, length);
        }

        public static T[] SubArrayAt<T>(T[] array, int offset, int length)
        {
            if (length == 0)
            {
                return EmptyArray<T>.Value;
            }

            var result = new T[length];
            for (int index = 0; index < length; index++)
            {
                result[index] = array[offset + index];
            }

            return result;
        }
    }
}
