// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The timestamp dotnet/runtime's Stopwatch (dotnet-runtime/Stopwatch.cs,
// with Stopwatch.Unix.cs's nanosecond frequency) reads: the host's
// monotonic clock (Host.ClockMonotonic).

using Gameplay.Runtime;

namespace System.Diagnostics
{
    public partial class Stopwatch
    {
        public static long GetTimestamp() => Host.ClockMonotonic();
    }
}
