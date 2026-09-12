// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What dotnet/runtime's DateTime (dotnet-runtime/DateTime.cs, the
// platform-independent part) leaves to its platform files and time zones:
// the clock is the host's (Host.ClockUtc), and a module has no time zone of
// its own, so local time is UTC (TimeZoneInfo below). DateTimeOffset.Now
// and UtcNow follow from these.

using Gameplay.Runtime;

namespace System
{
    public readonly partial struct DateTime
    {
        public static DateTime UtcNow =>
            new DateTime(((ulong)(Host.ClockUtc() * TimeSpan.TicksPerMicrosecond + UnixEpochTicks)) | KindUtc);
    }

    internal enum TimeZoneInfoOptions
    {
        None = 1,
        NoThrowOnInvalidTime = 2,
    }

    // The time zone dotnet/runtime's DateTime and DateTimeOffset consult,
    // for a module: UTC, always.
    internal sealed class TimeZoneInfo
    {
        public static TimeZoneInfo Local { get; } = new TimeZoneInfo();

        public bool IsDaylightSavingTime(DateTime dateTime, TimeZoneInfoOptions flags) => false;

        public static TimeSpan GetLocalUtcOffset(DateTime dateTime, TimeZoneInfoOptions flags) => TimeSpan.Zero;

        public static TimeSpan GetUtcOffsetFromUtc(DateTime time, TimeZoneInfo zone, out bool isDaylightSavings, out bool isAmbiguousLocalDst)
        {
            isDaylightSavings = false;
            isAmbiguousLocalDst = false;
            return TimeSpan.Zero;
        }

        public static long GetLocalDateTimeNowTicks(DateTime time, out bool isAmbiguousLocalDst)
        {
            isAmbiguousLocalDst = false;
            return time.Ticks;
        }

        public static DateTime ConvertTimeToUtc(DateTime dateTime, TimeZoneInfoOptions flags) =>
            DateTime.SpecifyKind(dateTime, DateTimeKind.Utc);
    }
}
