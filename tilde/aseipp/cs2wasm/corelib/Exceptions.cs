// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The argument exceptions' throw helpers, as dotnet/runtime writes them
// (with its messages). The exception types stay .NET's, which the importer
// implements.

using System.Collections.Generic;
using System.Numerics;
using System.Runtime.CompilerServices;
using Gameplay.Runtime;

namespace System
{
    [Surface]
    public partial class ArgumentNullException
    {
        public static void ThrowIfNull(object? argument, [CallerArgumentExpression(nameof(argument))] string? paramName = null)
        {
            if (argument is null)
            {
                throw new ArgumentNullException(paramName);
            }
        }
    }

    [Surface]
    public partial class ArgumentException
    {
        public static void ThrowIfNullOrEmpty(string? argument, [CallerArgumentExpression(nameof(argument))] string? paramName = null)
        {
            if (string.IsNullOrEmpty(argument))
            {
                ArgumentNullException.ThrowIfNull(argument, paramName);
                throw new ArgumentException(SR.Argument_EmptyString, paramName);
            }
        }

        public static void ThrowIfNullOrWhiteSpace(string? argument, [CallerArgumentExpression(nameof(argument))] string? paramName = null)
        {
            if (string.IsNullOrWhiteSpace(argument))
            {
                ArgumentNullException.ThrowIfNull(argument, paramName);
                throw new ArgumentException(SR.Argument_EmptyOrWhiteSpaceString, paramName);
            }
        }
    }

    [Surface]
    public partial class ArgumentOutOfRangeException
    {
        private static void Throw(string? paramName, object? value, string message) =>
            throw new ArgumentOutOfRangeException(paramName, value, message);

        public static void ThrowIfZero<T>(T value, [CallerArgumentExpression(nameof(value))] string? paramName = null)
            where T : INumberBase<T>
        {
            if (T.IsZero(value))
            {
                Throw(paramName, value, SR.Format(SR.ArgumentOutOfRange_Generic_MustBeNonZero, paramName, value));
            }
        }

        public static void ThrowIfNegative<T>(T value, [CallerArgumentExpression(nameof(value))] string? paramName = null)
            where T : INumberBase<T>
        {
            if (T.IsNegative(value))
            {
                Throw(paramName, value, SR.Format(SR.ArgumentOutOfRange_Generic_MustBeNonNegative, paramName, value));
            }
        }

        public static void ThrowIfNegativeOrZero<T>(T value, [CallerArgumentExpression(nameof(value))] string? paramName = null)
            where T : INumberBase<T>
        {
            if (T.IsNegative(value) || T.IsZero(value))
            {
                Throw(paramName, value, SR.Format(SR.ArgumentOutOfRange_Generic_MustBeNonNegativeNonZero, paramName, value));
            }
        }

        public static void ThrowIfEqual<T>(T value, T other, [CallerArgumentExpression(nameof(value))] string? paramName = null)
        {
            if (EqualityComparer<T>.Default.Equals(value, other))
            {
                Throw(paramName, value, SR.Format(SR.ArgumentOutOfRange_Generic_MustBeNotEqual, paramName, (object?)value ?? "null", (object?)other ?? "null"));
            }
        }

        public static void ThrowIfNotEqual<T>(T value, T other, [CallerArgumentExpression(nameof(value))] string? paramName = null)
        {
            if (!EqualityComparer<T>.Default.Equals(value, other))
            {
                Throw(paramName, value, SR.Format(SR.ArgumentOutOfRange_Generic_MustBeEqual, paramName, (object?)value ?? "null", (object?)other ?? "null"));
            }
        }

        public static void ThrowIfGreaterThan<T>(T value, T other, [CallerArgumentExpression(nameof(value))] string? paramName = null)
            where T : IComparable<T>
        {
            if (value.CompareTo(other) > 0)
            {
                Throw(paramName, value, SR.Format(SR.ArgumentOutOfRange_Generic_MustBeLessOrEqual, paramName, value, other));
            }
        }

        public static void ThrowIfGreaterThanOrEqual<T>(T value, T other, [CallerArgumentExpression(nameof(value))] string? paramName = null)
            where T : IComparable<T>
        {
            if (value.CompareTo(other) >= 0)
            {
                Throw(paramName, value, SR.Format(SR.ArgumentOutOfRange_Generic_MustBeLess, paramName, value, other));
            }
        }

        public static void ThrowIfLessThan<T>(T value, T other, [CallerArgumentExpression(nameof(value))] string? paramName = null)
            where T : IComparable<T>
        {
            if (value.CompareTo(other) < 0)
            {
                Throw(paramName, value, SR.Format(SR.ArgumentOutOfRange_Generic_MustBeGreaterOrEqual, paramName, value, other));
            }
        }

        public static void ThrowIfLessThanOrEqual<T>(T value, T other, [CallerArgumentExpression(nameof(value))] string? paramName = null)
            where T : IComparable<T>
        {
            if (value.CompareTo(other) <= 0)
            {
                Throw(paramName, value, SR.Format(SR.ArgumentOutOfRange_Generic_MustBeGreater, paramName, value, other));
            }
        }
    }
}
