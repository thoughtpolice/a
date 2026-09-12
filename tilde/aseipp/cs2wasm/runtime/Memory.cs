// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Memory<T> and ReadOnlyMemory<T> (see Frontend.RuntimeCounterpart): part of
// an array, or of a string's chars, as a struct of the array, its owner
// (the array, or the string, whose chars the array copies; strings are
// immutable, so no one can tell), the start and the length. Unlike a span
// it is an ordinary struct, stored anywhere. Its members are .NET's, with
// its checks, equality (same owner, start and length) and text; Pin and
// MemoryManager are not here. MemoryExtensions.AsMemory is too.

namespace Gameplay.Runtime
{
    using System;

    internal readonly struct Memory<T>
    {
        internal readonly T[] array;
        internal readonly object owner;
        internal readonly int start;
        internal readonly int length;

        public Memory(T[] array)
        {
            this.array = array;
            owner = array;
            start = 0;
            length = array == null ? 0 : array.Length;
        }

        public Memory(T[] array, int start, int length)
        {
            if (array == null)
            {
                if (start != 0 || length != 0)
                {
                    throw new ArgumentOutOfRangeException();
                }

                this.array = null;
                owner = null;
                this.start = 0;
                this.length = 0;
                return;
            }

            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)array.Length)
            {
                throw new ArgumentOutOfRangeException();
            }

            this.array = array;
            owner = array;
            this.start = start;
            this.length = length;
        }

        internal Memory(T[] array, object owner, int start, int length)
        {
            this.array = array;
            this.owner = owner;
            this.start = start;
            this.length = length;
        }

        public static Memory<T> Empty => default;

        public int Length => length;

        public bool IsEmpty => length == 0;

        public Span<T> Span => new Span<T>(array, start, length, true);

        public Memory<T> Slice(int start)
        {
            if ((uint)start > (uint)length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new Memory<T>(array, owner, this.start + start, length - start);
        }

        public Memory<T> Slice(int start, int length)
        {
            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)this.length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new Memory<T>(array, owner, this.start + start, length);
        }

        public T[] ToArray() => Span.ToArray();

        public void CopyTo(Memory<T> destination) => Span.CopyTo(destination.Span);

        public bool TryCopyTo(Memory<T> destination) => Span.TryCopyTo(destination.Span);

        public bool Equals(Memory<T> other) => owner == other.owner && start == other.start && length == other.length;

        public override bool Equals(object obj) =>
            obj is ReadOnlyMemory<T> readOnly
                ? readOnly.Equals((ReadOnlyMemory<T>)this)
                : obj is Memory<T> memory && Equals(memory);

        // .NET's combines the owner's identity hash with a per-process seed;
        // this combines its hash (a string's is its text's), so equal
        // memories hash alike.
        public override int GetHashCode() => owner == null ? 0 : unchecked((owner.GetHashCode() * 31 + start) * 31 + length);

        public override string ToString() => Spans.Text(array, start, length, "Memory");

        public static implicit operator Memory<T>(T[] array) => new Memory<T>(array);

        public static implicit operator ReadOnlyMemory<T>(Memory<T> memory) =>
            new ReadOnlyMemory<T>(memory.array, memory.owner, memory.start, memory.length);
    }

    internal readonly struct ReadOnlyMemory<T>
    {
        internal readonly T[] array;
        internal readonly object owner;
        internal readonly int start;
        internal readonly int length;

        public ReadOnlyMemory(T[] array)
        {
            this.array = array;
            owner = array;
            start = 0;
            length = array == null ? 0 : array.Length;
        }

        public ReadOnlyMemory(T[] array, int start, int length)
        {
            if (array == null)
            {
                if (start != 0 || length != 0)
                {
                    throw new ArgumentOutOfRangeException();
                }

                this.array = null;
                owner = null;
                this.start = 0;
                this.length = 0;
                return;
            }

            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)array.Length)
            {
                throw new ArgumentOutOfRangeException();
            }

            this.array = array;
            owner = array;
            this.start = start;
            this.length = length;
        }

        internal ReadOnlyMemory(T[] array, object owner, int start, int length)
        {
            this.array = array;
            this.owner = owner;
            this.start = start;
            this.length = length;
        }

        public static ReadOnlyMemory<T> Empty => default;

        public int Length => length;

        public bool IsEmpty => length == 0;

        public ReadOnlySpan<T> Span => new ReadOnlySpan<T>(array, start, length, true);

        public ReadOnlyMemory<T> Slice(int start)
        {
            if ((uint)start > (uint)length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new ReadOnlyMemory<T>(array, owner, this.start + start, length - start);
        }

        public ReadOnlyMemory<T> Slice(int start, int length)
        {
            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)this.length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new ReadOnlyMemory<T>(array, owner, this.start + start, length);
        }

        public T[] ToArray() => Span.ToArray();

        public void CopyTo(Memory<T> destination) => Span.CopyTo(destination.Span);

        public bool TryCopyTo(Memory<T> destination) => Span.TryCopyTo(destination.Span);

        public bool Equals(ReadOnlyMemory<T> other) => owner == other.owner && start == other.start && length == other.length;

        public override bool Equals(object obj) =>
            obj is ReadOnlyMemory<T> readOnly
                ? Equals(readOnly)
                : obj is Memory<T> memory && Equals((ReadOnlyMemory<T>)memory);

        public override int GetHashCode() => owner == null ? 0 : unchecked((owner.GetHashCode() * 31 + start) * 31 + length);

        public override string ToString() => Spans.Text(array, start, length, "ReadOnlyMemory");

        public static implicit operator ReadOnlyMemory<T>(T[] array) => new ReadOnlyMemory<T>(array);
    }
}

namespace System
{
    public static partial class MemoryExtensions
    {
        // A string's memory, which remembers the string it views (so two of
        // them are equal); the runtime's struct is the framework's here.
        private static ReadOnlyMemory<char> StringMemory(string text, int start, int length) =>
            (ReadOnlyMemory<char>)(object)new Gameplay.Runtime.ReadOnlyMemory<char>(text.ToCharArray(), text, start, length);

        public static Memory<T> AsMemory<T>(this T[] array) => new Memory<T>(array);

        public static Memory<T> AsMemory<T>(this T[] array, int start)
        {
            if (array == null)
            {
                if (start != 0)
                {
                    throw new ArgumentOutOfRangeException();
                }

                return default;
            }

            return new Memory<T>(array, start, (uint)start > (uint)array.Length ? -1 : array.Length - start);
        }

        public static Memory<T> AsMemory<T>(this T[] array, int start, int length) => new Memory<T>(array, start, length);

        public static Memory<T> AsMemory<T>(this T[] array, Index startIndex)
        {
            if (array == null)
            {
                if (!startIndex.Equals(Index.Start))
                {
                    throw new ArgumentNullException("array");
                }

                return default;
            }

            int start = startIndex.GetOffset(array.Length);
            return new Memory<T>(array, start, (uint)start > (uint)array.Length ? -1 : array.Length - start);
        }

        public static Memory<T> AsMemory<T>(this T[] array, Range range)
        {
            if (array == null)
            {
                Index startIndex = range.Start;
                Index endIndex = range.End;
                if (!startIndex.Equals(Index.Start) || !endIndex.Equals(Index.Start))
                {
                    throw new ArgumentNullException("array");
                }

                return default;
            }

            var (start, length) = range.GetOffsetAndLength(array.Length);
            return new Memory<T>(array, start, length);
        }

        public static ReadOnlyMemory<char> AsMemory(this string text) =>
            text == null ? default : StringMemory(text, 0, text.Length);

        public static ReadOnlyMemory<char> AsMemory(this string text, int start)
        {
            if (text == null)
            {
                if (start != 0)
                {
                    throw new ArgumentOutOfRangeException("start");
                }

                return default;
            }

            if ((uint)start > (uint)text.Length)
            {
                throw new ArgumentOutOfRangeException("start");
            }

            return StringMemory(text, start, text.Length - start);
        }

        public static ReadOnlyMemory<char> AsMemory(this string text, int start, int length)
        {
            if (text == null)
            {
                if (start != 0 || length != 0)
                {
                    throw new ArgumentOutOfRangeException("start");
                }

                return default;
            }

            if ((ulong)(uint)start + (ulong)(uint)length > (ulong)(uint)text.Length)
            {
                throw new ArgumentOutOfRangeException("start");
            }

            return StringMemory(text, start, length);
        }

        public static ReadOnlyMemory<char> AsMemory(this string text, Range range)
        {
            if (text == null)
            {
                Index startIndex = range.Start;
                Index endIndex = range.End;
                if (!startIndex.Equals(Index.Start) || !endIndex.Equals(Index.Start))
                {
                    throw new ArgumentNullException("text");
                }

                return default;
            }

            var (start, length) = range.GetOffsetAndLength(text.Length);
            return StringMemory(text, start, length);
        }
    }
}
