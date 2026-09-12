// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The enumerators of arrays and strings as IEnumerable<T>, as the CLR's
// (SZGenericArrayEnumerator and CharEnumerator), and the class enumerators
// the runtime's collections give as IEnumerable<T>, which behave as their
// boxed struct enumerators do in the CLR.

using System.Collections;
using System.Collections.Generic;

namespace Gameplay.Runtime
{
    internal static class Enumerables
    {
        public static IEnumerator<T> OfArray<T>(T[] array) => new ArrayEnumerator<T>(array);

        public static IEnumerator<char> OfString(string text) => new StringEnumerator(text);
    }

    internal sealed class ArrayEnumerator<T> : IEnumerator<T>
    {
        private readonly T[] array;
        private int index;

        public ArrayEnumerator(T[] array)
        {
            this.array = array;
            index = -1;
        }

        public bool MoveNext()
        {
            int next = index + 1;
            if (next < array.Length)
            {
                index = next;
                return true;
            }

            index = array.Length;
            return false;
        }

        public T Current
        {
            get
            {
                if ((uint)index >= (uint)array.Length)
                {
                    throw new System.InvalidOperationException();
                }

                return array[index];
            }
        }

        object IEnumerator.Current => Current;

        public void Reset() => index = -1;

        public void Dispose()
        {
        }
    }

    internal sealed class StringEnumerator : IEnumerator<char>
    {
        private string text;
        private int index;
        private char current;

        public StringEnumerator(string text)
        {
            this.text = text;
            index = -1;
        }

        public bool MoveNext()
        {
            if (index < text.Length - 1)
            {
                index++;
                current = text[index];
                return true;
            }

            index = text.Length;
            return false;
        }

        public char Current
        {
            get
            {
                if (index == -1 || index >= text.Length)
                {
                    throw new System.InvalidOperationException();
                }

                return current;
            }
        }

        object IEnumerator.Current => Current;

        public void Reset()
        {
            current = (char)0;
            index = -1;
        }

        public void Dispose()
        {
        }
    }
}

namespace System.Collections.Generic
{
    // A collection's struct enumerator as a class, as the CLR's boxed one:
    // the runtime's collections' IEnumerable<T>.GetEnumerator.
    internal sealed class ListEnumerator<T> : IEnumerator<T>
    {
        private List<T>.Enumerator inner;

        public ListEnumerator(List<T>.Enumerator inner) => this.inner = inner;

        public bool MoveNext() => inner.MoveNext();

        public T Current => inner.Current;

        object IEnumerator.Current => Current;

        public void Reset() => inner.Reset();

        public void Dispose()
        {
        }
    }

    internal sealed class DictionaryEnumerator<TKey, TValue> : IEnumerator<KeyValuePair<TKey, TValue>>
    {
        private Dictionary<TKey, TValue>.Enumerator inner;

        public DictionaryEnumerator(Dictionary<TKey, TValue>.Enumerator inner) => this.inner = inner;

        public bool MoveNext() => inner.MoveNext();

        public KeyValuePair<TKey, TValue> Current => inner.Current;

        object IEnumerator.Current => Current;

        public void Reset() => inner.Reset();

        public void Dispose()
        {
        }
    }

    internal sealed class KeyEnumerator<TKey, TValue> : IEnumerator<TKey>
    {
        private Dictionary<TKey, TValue>.KeyCollection.Enumerator inner;

        public KeyEnumerator(Dictionary<TKey, TValue>.KeyCollection.Enumerator inner) => this.inner = inner;

        public bool MoveNext() => inner.MoveNext();

        public TKey Current => inner.Current;

        object IEnumerator.Current => Current;

        public void Reset() => inner.Reset();

        public void Dispose()
        {
        }
    }

    internal sealed class ValueEnumerator<TKey, TValue> : IEnumerator<TValue>
    {
        private Dictionary<TKey, TValue>.ValueCollection.Enumerator inner;

        public ValueEnumerator(Dictionary<TKey, TValue>.ValueCollection.Enumerator inner) => this.inner = inner;

        public bool MoveNext() => inner.MoveNext();

        public TValue Current => inner.Current;

        object IEnumerator.Current => Current;

        public void Reset() => inner.Reset();

        public void Dispose()
        {
        }
    }

    internal sealed class SetEnumerator<T> : IEnumerator<T>
    {
        private HashSet<T>.Enumerator inner;

        public SetEnumerator(HashSet<T>.Enumerator inner) => this.inner = inner;

        public bool MoveNext() => inner.MoveNext();

        public T Current => inner.Current;

        object IEnumerator.Current => Current;

        public void Reset() => inner.Reset();

        public void Dispose()
        {
        }
    }

    internal sealed class QueueEnumerator<T> : IEnumerator<T>
    {
        private Queue<T>.Enumerator inner;

        public QueueEnumerator(Queue<T>.Enumerator inner) => this.inner = inner;

        public bool MoveNext() => inner.MoveNext();

        public T Current => inner.Current;

        object IEnumerator.Current => Current;

        public void Reset() => inner.Reset();

        public void Dispose()
        {
        }
    }
}
