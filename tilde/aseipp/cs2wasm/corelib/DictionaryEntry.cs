// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DictionaryEntry, the non-generic IDictionaryEnumerator's entry, which the
// imported System.Collections' SortedList and SortedDictionary enumerators
// give as their non-generic Current: dotnet/runtime's struct.

namespace System.Collections
{
    public struct DictionaryEntry
    {
        private object _key;
        private object? _value;

        public DictionaryEntry(object key, object? value)
        {
            _key = key;
            _value = value;
        }

        public object Key
        {
            get => _key;
            set => _key = value;
        }

        public object? Value
        {
            get => _value;
            set => _value = value;
        }

        public void Deconstruct(out object key, out object? value)
        {
            key = Key;
            value = Value;
        }

        public override string ToString() => "[" + _key?.ToString() + ", " + _value?.ToString() + "]";
    }
}
