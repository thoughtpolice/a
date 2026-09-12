// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the compiler compiles System.Nullable<T> (`int?`) as: a value and
// whether there is one. The members are the BCL's; the conversions,
// lifted operators, boxing and patterns are the compiler's.

namespace Gameplay.Runtime
{
    internal struct Nullable<T>
        where T : struct
    {
        private readonly bool hasValue;
        private readonly T value;

        public Nullable(T value)
        {
            this.value = value;
            hasValue = true;
        }

        public readonly bool HasValue => hasValue;

        public readonly T Value => hasValue ? value : throw new System.InvalidOperationException("Nullable object must have a value.");

        public readonly T GetValueOrDefault() => value;

        public readonly T GetValueOrDefault(T defaultValue) => hasValue ? value : defaultValue;

        public override readonly bool Equals(object other) =>
            !hasValue ? other == null : other != null && value.Equals(other);

        public override readonly int GetHashCode() => hasValue ? value.GetHashCode() : 0;

        public override readonly string ToString() => hasValue ? value.ToString() : "";
    }
}
