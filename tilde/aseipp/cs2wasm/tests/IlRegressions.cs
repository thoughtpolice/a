// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the compiler once compiled wrongly or rejected, found by the fuzzer and
// the size work, against the CLR.

using System;
using System.Collections.Generic;

namespace Tests.IlRegressions
{
    public sealed record Point(int X, int Y);

    public struct Counter
    {
        public int Count { get; set; }

        public int Twice => Count * 2;
    }

    // A struct without fields, which a constructor passed as nothing (its
    // local took the next local's id) before a base constructor call.
    public struct Nothing
    {
    }

    public class Base
    {
        public readonly int Value;

        public Base(int value) => Value = value;
    }

    public sealed class Holder<T> : Base
    {
        public readonly T Item;

        public Holder(T item, int value)
            : base(value)
        {
            Item = item;
        }
    }

    public sealed class Failure : Exception
    {
        public Failure(string message)
            : base(message)
        {
        }
    }

    public static class Tables
    {
        public static readonly int[] Primes = { 2, 3, 5, 7, 11 };
        public static readonly Counter Start = new Counter { Count = 4 };
        public static int Calls;
    }

    public static class IlRegressions
    {
        // A stackalloc initializer whose element branches (fuzz seeds
        // 100716 and 102744): the memory stays on the stack across it.
        public static int StackallocAcrossBranches(int which)
        {
            string text = which > 0 ? "abc" : null;
            Span<long> values = stackalloc long[] { (text ?? "n").Length, which < 0 ? 7 : 8, 3 };
            long sum = 0;
            foreach (long value in values)
            {
                sum = sum * 10 + value;
            }

            return (int)sum;
        }

        // `record == null`, a reference test.
        public static int RecordNull(int which)
        {
            Point point = which > 0 ? new Point(which, 2) : null;
            return (point == null ? 1 : 0) + (point != null ? 2 : 0) + (null == point ? 4 : 0)
                   + (point == new Point(which, 2) ? 8 : 0);
        }

        // Auto-property getters read in place, on classes and on structs.
        public static int AutoProperties(int x)
        {
            var point = new Point(x, x + 1);
            var counter = new Counter { Count = x };
            counter.Count += 3;
            return point.X * 100 + point.Y * 10 + counter.Count + counter.Twice;
        }

        // Eagerly initialized statics, and foreach over a List<T> without
        // its try/finally.
        public static int EagerStatics(int count)
        {
            var list = new List<int>(Tables.Primes);
            int sum = Tables.Start.Count;
            foreach (int prime in list)
            {
                if (prime > count)
                {
                    break;
                }

                sum += prime;
            }

            Tables.Calls++;
            return sum * 100 + Tables.Calls;
        }

        // A boxed number's IComparable<T> and IEquatable<T>, which trapped:
        // its itables did not have them.
        public static int BoxedInterfaces(int x)
        {
            IComparable<int> comparable = x;
            IEquatable<int> equatable = x;
            object boxed = x;
            return comparable.CompareTo(3) * 100 + (equatable.Equals(4) ? 10 : 0)
                   + (boxed is IComparable<int> ? 1 : 0) + (boxed is IComparable<long> ? 1000 : 0);
        }

        public static int FieldlessStructs(int x) =>
            new Holder<Nothing>(default, x).Value + new Holder<Nothing>(new Nothing(), 2).Value * 10;

        // GetType of an exception typed as a base: its own class, which a
        // BCL exception's type test answered first.
        public static int ExceptionTypes(int which)
        {
            Exception exception = (Math.Abs(which * 3) % 5) switch
            {
                0 => new InvalidOperationException("a"),
                1 => new Failure("b"),
                2 => new ArgumentOutOfRangeException("c"),
                3 => new KeyNotFoundException("d"),
                _ => new Exception("e"),
            };
            return exception.GetType().Name.Length * 100 + (exception.GetType() == typeof(Exception) ? 1 : 0);
        }

        // A branch on a constant in a try block, which folding made
        // unconditional (Il.Folding): the return it skipped is unreachable,
        // and so is where it would have left the try block to.
        public static int FoldedTry(int x)
        {
            bool never = false;
            try
            {
                if (never)
                {
                    return -1;
                }

                x += 2;
            }
            finally
            {
                x *= 3;
            }

            return x;
        }

        // An itable thunk whose function type, interned by its flattened
        // parameters, reads back as another member's: IComparer<string>'s
        // Compare(string, string) and IEqualityComparer<KeyValuePair<string,
        // string>>'s GetHashCode(pair) both take an object and two
        // references, so the thunk's shape was the pair's, and its
        // arguments went uncast to the comparer's strings (invalid Wasm).
        private static readonly SortedDictionary<string, string> Sorted = new SortedDictionary<string, string>(StringComparer.Ordinal);

        // Equality and hashing of a type an array or a string may be (an
        // array interface, an eqref here), in shared code: a record's
        // member of it compared through EqualityComparer<T>.Default, whose
        // step took the value for an object with a vtable (invalid Wasm).
        public sealed class Item
        {
            public int Value;
        }

        public sealed record Shelf(string Name, IReadOnlyList<Item> Items);

        public static int ArrayInterfaceEquality(int x)
        {
            var items = new[] { new Item { Value = x } };
            var list = new List<Item>(items);
            var first = new Shelf("a", items);
            var same = new Shelf("a", items);
            var other = new Shelf("a", list);
            IEnumerable<string> words = new[] { "w" + x };
            int result = (first == same ? 1 : 0) + (first == other ? 10 : 0)
                         + (first.GetHashCode() == same.GetHashCode() ? 100 : 0)
                         + (EqualityComparer<IEnumerable<string>>.Default.Equals(words, words) ? 1000 : 0)
                         + (EqualityComparer<IReadOnlyList<Item>>.Default.Equals(items, list) ? 10000 : 0)
                         + (EqualityComparer<IEnumerable<char>>.Default.Equals("ab", "ab") ? 100000 : 0);
            return result;
        }

        // An exception caught after unwinding frames left the call depth
        // theirs, so a loop catching a few hundred of them faulted with
        // CallDepthExceeded (2) (through a finally and a filter too).
        private static int Deep(int depth, int x) => depth == 0 ? throw new InvalidOperationException("deep " + x) : Deep(depth - 1, x) + 1;

        private static int Caught(int x)
        {
            try
            {
                return Deep(5, x);
            }
            catch (InvalidOperationException error) when ((x & 1) == 0 && error.Message.Length > 5)
            {
                return x;
            }
            finally
            {
                Finished++;
            }
        }

        private static int Finished;

        public static int CaughtDepth(int x)
        {
            Finished = 0;
            int total = 0;
            for (int index = 0; index < 300; index++)
            {
                try
                {
                    total += Caught(x + index);
                }
                catch (InvalidOperationException)
                {
                    total -= 1;
                }
            }

            return total + Finished;
        }

        public static int SortedStrings(int x)
        {
            Sorted.Clear();
            for (int index = 0; index < 5; index++)
            {
                Sorted[((x + index * 7) % 11).ToString()] = index.ToString();
            }

            int digest = Sorted.Count;
            foreach (var (key, value) in Sorted)
            {
                digest = digest * 31 + key.Length * 10 + value[0];
            }

            return digest;
        }
    }
}
