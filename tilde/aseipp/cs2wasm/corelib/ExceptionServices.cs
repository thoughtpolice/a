// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// ExceptionDispatchInfo for one thread and no stack traces: throwing the
// captured exception again is rethrowing it (what Lazy<T> does with a
// factory's exception).

namespace System.Runtime.ExceptionServices
{
    public sealed class ExceptionDispatchInfo
    {
        private readonly Exception exception;

        private ExceptionDispatchInfo(Exception exception) => this.exception = exception;

        public Exception SourceException => exception;

        public static ExceptionDispatchInfo Capture(Exception source) =>
            new(source ?? throw new ArgumentNullException(nameof(source)));

        public static void Throw(Exception source) => Capture(source).Throw();

        public void Throw() => throw exception;
    }
}
