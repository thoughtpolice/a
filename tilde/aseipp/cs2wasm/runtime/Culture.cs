// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.IFormatProvider, CultureInfo and NumberFormatInfo (see
// Frontend.RuntimeCounterpart): the invariant culture, the only one here, so
// that the IFormatProvider overloads of formatting and parsing take
// CultureInfo.InvariantCulture, NumberFormatInfo.InvariantInfo or null.
// Other cultures (and CurrentCulture, which is the machine's) are rejected
// where code names them.

namespace Gameplay.Runtime
{
    internal abstract class FormatProvider
    {
    }

    internal sealed class CultureInfo : FormatProvider
    {
        public static CultureInfo InvariantCulture => Invariant<int>.Culture;

        public NumberFormatInfo NumberFormat => Invariant<int>.Numbers;

        public string Name => "";

        public override string ToString() => "";
    }

    // The invariant culture's number symbols.
    internal sealed class NumberFormatInfo : FormatProvider
    {
        public static NumberFormatInfo InvariantInfo => Invariant<int>.Numbers;

        public string NumberDecimalSeparator => ".";

        public string NumberGroupSeparator => ",";

        public string NegativeSign => "-";

        public string PositiveSign => "+";

        public string CurrencySymbol => "¤";

        public string PercentSymbol => "%";

        public string NaNSymbol => "NaN";

        public string PositiveInfinitySymbol => "Infinity";

        public string NegativeInfinitySymbol => "-Infinity";

        public int NumberDecimalDigits => 2;
    }

    // The single instances, as statics of a generic class (a non-generic
    // class's statics would be part of every module).
    internal static class Invariant<T>
    {
        internal static readonly CultureInfo Culture = new CultureInfo();
        internal static readonly NumberFormatInfo Numbers = new NumberFormatInfo();
    }
}
