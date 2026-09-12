// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What System.Private.CoreLib makes public for System.Collections'
// dictionaries: dotnet/runtime wraps a string-keyed dictionary's comparer
// in a NonRandomizedStringEqualityComparer until collisions call for
// randomized hashing. Strings' hashes here are not randomized
// (runtime/Hashing.cs), so there is nothing to wrap: GetStringComparer
// never wraps, and no comparer is one.

namespace System.Collections.Generic
{
    public class NonRandomizedStringEqualityComparer : IEqualityComparer<string?>
    {
        private NonRandomizedStringEqualityComparer()
        {
        }

        public virtual bool Equals(string? x, string? y) => string.Equals(x, y);

        public virtual int GetHashCode(string? obj) => obj?.GetHashCode() ?? 0;

        public virtual IEqualityComparer<string?> GetUnderlyingEqualityComparer() => EqualityComparer<string?>.Default;

        public static IEqualityComparer<string>? GetStringComparer(object comparer) => null;
    }
}
