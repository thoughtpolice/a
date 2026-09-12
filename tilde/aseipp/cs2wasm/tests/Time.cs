// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// TimeSpan, DateTime, DateTimeOffset, Guid, Lazy<T> and Stopwatch, the
// gameplay CoreLib's (from dotnet/runtime's sources, and
// its own formatting and Guid): arithmetic, properties, formatting and
// parsing against the CLR's, and the clock, randomness and timer from the
// host's imports as far as they can be compared.

using System;
using System.Diagnostics;
using System.Globalization;

namespace Tests.Time
{
    public static class Time
    {
        private static int Digest(string text)
        {
            int digest = 17;
            foreach (char c in text)
            {
                digest = unchecked(digest * 31 + c);
            }

            return unchecked(digest * 31 + text.Length);
        }

        private static readonly string[] SpanFormats = { "c", "g", "G", "hh\\:mm\\:ss", "d\\.hh", "%s", "fffffff", "FFF", "'x'mm" };

        private static readonly string[] DateFormats =
        {
            "d", "D", "f", "F", "g", "G", "M", "O", "R", "s", "t", "T", "u", "Y",
            "yyyy-MM-dd HH:mm:ss.fff", "ddd MMM d yy h:m:s tt", "yyy yyyyy M MM MMM MMMM", "FFFFFFF", "K zzz zz z",
            "'literal' \\y HH\\:mm", "dddd, dd", "hh tt t",
        };

        private static TimeSpan Span(int which) => which switch
        {
            0 => TimeSpan.Zero,
            1 => new TimeSpan(1, 2, 3),
            2 => new TimeSpan(-3, 4, 5, 6, 789),
            3 => TimeSpan.FromMilliseconds(123456789.5),
            4 => TimeSpan.FromTicks(-1),
            5 => TimeSpan.MaxValue,
            6 => TimeSpan.MinValue,
            7 => TimeSpan.FromDays(1.5) + TimeSpan.FromMinutes(-7),
            8 => new TimeSpan(10, 20, 30, 40, 500, 600),
            _ => TimeSpan.FromSeconds(which) - TimeSpan.FromHours(which / 3.0),
        };

        private static DateTime Date(int which) => which switch
        {
            0 => new DateTime(2024, 2, 29),
            1 => new DateTime(1999, 12, 31, 23, 59, 59, DateTimeKind.Utc),
            2 => new DateTime(1, 1, 1),
            3 => new DateTime(9999, 12, 31, 23, 59, 59, 999, DateTimeKind.Local).AddTicks(9999),
            4 => DateTime.UnixEpoch.AddSeconds(1234567890.25),
            5 => new DateTime(2026, 9, 25, 7, 5, 3, 21, 42),
            6 => new DateTime(638000000000000000L, DateTimeKind.Unspecified),
            _ => new DateTime(2000 + which, 1 + which % 12, 1 + which % 28, which % 24, which % 60, which % 60),
        };

        public static long Spans(int which)
        {
            TimeSpan span = Span(which);
            long digest = span.Ticks ^ span.Days ^ span.Hours ^ span.Minutes ^ span.Seconds ^ span.Milliseconds;
            digest = unchecked(digest * 31 + (long)(span.TotalMilliseconds / 7));
            digest = unchecked(digest * 31 + span.CompareTo(TimeSpan.FromHours(1)));
            if (span != TimeSpan.MinValue)
            {
                digest = unchecked(digest * 31 + span.Duration().Ticks + span.Negate().Ticks);
            }

            return digest;
        }

        public static int SpanFormatting(int which)
        {
            TimeSpan span = Span(which % 10);
            string format = SpanFormats[which / 10 % SpanFormats.Length];
            try
            {
                return Digest(span.ToString(format, CultureInfo.InvariantCulture)) + Digest(span.ToString());
            }
            catch (FormatException)
            {
                return -1;
            }
        }

        public static long SpanChecks(int which)
        {
            try
            {
                return which switch
                {
                    0 => (TimeSpan.MaxValue + TimeSpan.FromTicks(1)).Ticks,
                    1 => TimeSpan.MinValue.Negate().Ticks,
                    2 => TimeSpan.FromDays(double.NaN).Ticks,
                    3 => TimeSpan.FromDays(1e18).Ticks,
                    4 => new TimeSpan(int.MaxValue, 0, 0, 0).Ticks,
                    5 => (TimeSpan.FromMinutes(90) / 4).Ticks,
                    6 => (TimeSpan.FromMinutes(90) * 2.5).Ticks,
                    7 => (long)(TimeSpan.FromMinutes(90) / TimeSpan.FromMinutes(20) * 1000),
                    _ => TimeSpan.FromSeconds(which).Ticks,
                };
            }
            catch (OverflowException)
            {
                return -1;
            }
            catch (ArgumentException)
            {
                return -2;
            }
        }

        public static long Dates(int which)
        {
            DateTime date = Date(which);
            long digest = date.Ticks ^ ((long)date.Kind << 60);
            digest = unchecked(digest * 31 + date.Year * 10000 + date.Month * 100 + date.Day);
            digest = unchecked(digest * 31 + date.Hour * 10000 + date.Minute * 100 + date.Second);
            digest = unchecked(digest * 31 + date.Millisecond * 1000 + date.Microsecond);
            digest = unchecked(digest * 31 + (int)date.DayOfWeek * 1000 + date.DayOfYear);
            digest = unchecked(digest * 31 + date.Date.Ticks + date.TimeOfDay.Ticks);
            digest = unchecked(digest * 31 + (DateTime.IsLeapYear(date.Year) ? 1 : 0) + DateTime.DaysInMonth(date.Year, date.Month));
            if (date.Year < 9998 && date.Year > 2)
            {
                digest = unchecked(digest * 31 + date.AddMonths(13).Ticks + date.AddYears(-1).Ticks + date.AddDays(-400.25).Ticks);
                digest = unchecked(digest * 31 + (date - new DateTime(2000, 1, 1)).Ticks);
            }

            return digest;
        }

        public static int DateFormatting(int which)
        {
            // The time zone is the machine's for the CLR (UTC in the
            // CoreLib): kept out of it.
            DateTime date = Date(which % 8);
            string format = DateFormats[which / 8 % DateFormats.Length];
            // (A time-only format of a time on the first day has the
            // machine's current offset for z whatever the kind.)
            if (format.Contains('z') && date.Ticks < TimeSpan.TicksPerDay)
            {
                date = date.AddDays(1);
            }

            date = DateTime.SpecifyKind(date, format.Contains('z') ? DateTimeKind.Utc
                                              : date.Kind == DateTimeKind.Local ? DateTimeKind.Unspecified : date.Kind);
            return Digest(date.ToString(format, CultureInfo.InvariantCulture)) + Digest(date.ToString(CultureInfo.InvariantCulture)) * 7;
        }

        public static int Offsets(int which)
        {
            DateTime date = DateTime.SpecifyKind(Date(which % 8), DateTimeKind.Unspecified);
            string format = DateFormats[which / 8 % DateFormats.Length];
            try
            {
                var offset = new DateTimeOffset(date, TimeSpan.FromMinutes(which % 5 * 90 - 180));
                string text = offset.ToString(format, CultureInfo.InvariantCulture) + offset.ToString(CultureInfo.InvariantCulture);
                return unchecked(Digest(text) * 31 + ((int)offset.UtcTicks ^ (int)(offset.UtcTicks >> 32)) + offset.Offset.Minutes
                                 + (int)offset.ToUnixTimeSeconds() + offset.CompareTo(DateTimeOffset.UnixEpoch)
                                 + (int)offset.UtcDateTime.Kind * 3);
            }
            catch (ArgumentOutOfRangeException)
            {
                return -1;
            }
        }

        public static long DateChecks(int which)
        {
            try
            {
                return which switch
                {
                    0 => new DateTime(2023, 2, 29).Ticks,
                    1 => new DateTime(10000, 1, 1).Ticks,
                    2 => DateTime.MaxValue.AddTicks(1).Ticks,
                    3 => DateTime.MinValue.AddDays(-1).Ticks,
                    4 => new DateTime(-1L).Ticks,
                    5 => new DateTimeOffset(new DateTime(2020, 1, 1), TimeSpan.FromHours(15)).Ticks,
                    6 => new DateTimeOffset(new DateTime(2020, 1, 1), TimeSpan.FromSeconds(30)).Ticks,
                    7 => DateTime.DaysInMonth(2020, 13),
                    8 => new DateTime(2020, 1, 1, 24, 0, 0).Ticks,
                    _ => DateTime.SpecifyKind(new DateTime(2020, 1, 1), (DateTimeKind)7).Ticks,
                };
            }
            catch (ArgumentOutOfRangeException)
            {
                return -1;
            }
            catch (ArgumentException)
            {
                return -2;
            }
        }

        private static readonly Guid Known = new Guid("0f8fad5b-d9cb-469f-a165-70867728950e");

        public static int Guids(int which)
        {
            Guid guid = which switch
            {
                0 => Known,
                1 => Guid.Empty,
                2 => Guid.AllBitsSet,
                3 => new Guid(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 }),
                4 => new Guid(0x12345678, 0x9abc, 0x7def, 0xf0, 0xe1, 0xd2, 0xc3, 0xb4, 0xa5, 0x96, 0x87),
                5 => new Guid(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 }, bigEndian: true),
                _ => new Guid((uint)(which * 0x01010101), (ushort)which, (ushort)(which * 7), 1, 2, 3, 4, 5, 6, 7, (byte)which),
            };
            int digest = 17;
            foreach (string format in new[] { "D", "N", "B", "P", "X", "d" })
            {
                digest = unchecked(digest * 31 + Digest(guid.ToString(format)));
            }

            foreach (byte b in guid.ToByteArray())
            {
                digest = unchecked(digest * 31 + b);
            }

            foreach (byte b in guid.ToByteArray(bigEndian: true))
            {
                digest = unchecked(digest * 31 + b);
            }

            digest = unchecked(digest * 31 + guid.GetHashCode());
            digest = unchecked(digest * 31 + guid.CompareTo(Known) + (guid == Known ? 100 : 0) + (guid < Known ? 1000 : 0));
            digest = unchecked(digest * 31 + guid.Version * 10 + guid.Variant);
            return unchecked(digest * 31 + (Guid.Parse(guid.ToString("B")) == guid ? 1 : 0) + (Guid.ParseExact(guid.ToString("X"), "X") == guid ? 2 : 0));
        }

        public static int GuidParsing(int which)
        {
            string text = which switch
            {
                0 => "0f8fad5b-d9cb-469f-a165-70867728950e",
                1 => " {0F8FAD5B-D9CB-469F-A165-70867728950E} ",
                2 => "(0f8fad5bd9cb469fa16570867728950e)",
                3 => "0f8fad5bd9cb469fa16570867728950e",
                4 => "{0x0f8fad5b,0xd9cb,0x469f,{0xa1,0x65,0x70,0x86,0x77,0x28,0x95,0x0e}}",
                5 => "0f8fad5b-d9cb-469f-a165-70867728950",
                6 => "0f8fad5b-d9cb469f-a165-70867728950ee",
                7 => "0f8fad5g-d9cb-469f-a165-70867728950e",
                8 => "",
                _ => "{0x0f8fad5b,0xd9cb,0x469f,{0xa1,0x65,0x70,0x86,0x77,0x28,0x95}}",
            };
            int result = Guid.TryParse(text, out Guid guid) ? Digest(guid.ToString()) : -1;
            try
            {
                return result + Guid.Parse(text).GetHashCode() % 1000;
            }
            catch (FormatException)
            {
                return result - 7;
            }
        }

        private static int created;

        private static int Make(int value)
        {
            created++;
            if (value < 0)
            {
                throw new InvalidOperationException("negative " + value);
            }

            return value * 2;
        }

        private static Lazy<int> recursive;

        public static int Lazies(int which)
        {
            created = 0;
            try
            {
                switch (which)
                {
                    case 0:
                        var lazy = new Lazy<int>(() => Make(21));
                        int before = lazy.IsValueCreated ? 1 : 0;
                        return lazy.Value + lazy.Value + created * 100 + before * 1000 + (lazy.IsValueCreated ? 10000 : 0)
                               + Digest(lazy.ToString());
                    case 1:
                        var failing = new Lazy<int>(() => Make(-1));
                        int first = 0;
                        try
                        {
                            _ = failing.Value;
                        }
                        catch (InvalidOperationException error)
                        {
                            first = Digest(error.Message);
                        }

                        try
                        {
                            _ = failing.Value;
                        }
                        catch (InvalidOperationException)
                        {
                            first += created * 100;
                        }

                        return first;
                    case 2:
                        var publication = new Lazy<int>(() => Make(-2), System.Threading.LazyThreadSafetyMode.PublicationOnly);
                        int count = 0;
                        for (int attempt = 0; attempt < 3; attempt++)
                        {
                            try
                            {
                                _ = publication.Value;
                            }
                            catch (InvalidOperationException)
                            {
                                count++;
                            }
                        }

                        return count * 10 + created;
                    case 3:
                        recursive = new Lazy<int>(() => recursive.Value + 1);
                        return recursive.Value;
                    case 4:
                        var unsafeLazy = new Lazy<string>(() => "text", isThreadSafe: false);
                        return Digest(unsafeLazy.Value + unsafeLazy.ToString());
                    case 5:
                        // No parameterless constructor to make the value with.
                        var none = new Lazy<string>();
                        try
                        {
                            return Digest(none.Value);
                        }
                        catch (MissingMemberException error)
                        {
                            return Digest(none.ToString() + error.Message) + (none.IsValueCreated ? 1 : 0);
                        }
                    default:
                        return new Lazy<int>(which).Value + (new Lazy<int>(which).IsValueCreated ? 1 : 0);
                }
            }
            catch (InvalidOperationException error)
            {
                return -Digest(error.Message);
            }
        }

        // The host's clock, randomness and timer: what holds whatever they
        // return.
        public static int Clocks(int which)
        {
            switch (which)
            {
                case 0:
                    DateTime now = DateTime.UtcNow;
                    return (now.Kind == DateTimeKind.Utc ? 1 : 0) + (now.Year >= 2020 && now.Year < 2200 ? 2 : 0);
                case 1:
                    DateTime local = DateTime.Now;
                    return (local.Kind == DateTimeKind.Local ? 1 : 0) + (local.Year >= 2020 ? 2 : 0);
                case 2:
                    DateTimeOffset offset = DateTimeOffset.UtcNow;
                    return (offset.Offset == TimeSpan.Zero ? 1 : 0) + (offset.Year >= 2020 ? 2 : 0);
                case 3:
                    Guid a = Guid.NewGuid();
                    Guid b = Guid.NewGuid();
                    return (a != b ? 1 : 0) + (a.Version == 4 ? 2 : 0) + ((a.Variant & 0xC) == 0x8 ? 4 : 0);
                case 4:
                    Guid ordered = Guid.CreateVersion7();
                    return (ordered.Version == 7 ? 1 : 0) + ((ordered.Variant & 0xC) == 0x8 ? 2 : 0);
                case 5:
                    var watch = new Stopwatch();
                    int stopped = !watch.IsRunning && watch.ElapsedTicks == 0 ? 1 : 0;
                    watch.Start();
                    long first = Stopwatch.GetTimestamp();
                    long second = Stopwatch.GetTimestamp();
                    watch.Stop();
                    return stopped + (second >= first ? 2 : 0) + (watch.Elapsed >= TimeSpan.Zero ? 4 : 0)
                           + (Stopwatch.Frequency > 0 ? 8 : 0) + (watch.IsRunning ? 0 : 16);
                default:
                    var started = Stopwatch.StartNew();
                    started.Restart();
                    started.Reset();
                    return (started.ElapsedMilliseconds == 0 ? 1 : 0) + (Stopwatch.GetElapsedTime(Stopwatch.GetTimestamp()) >= TimeSpan.Zero ? 2 : 0);
            }
        }
    }
}
