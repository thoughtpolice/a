// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DateTime and DateTimeOffset formatting for dotnet/runtime's DateTime.cs
// and DateTimeOffset.cs, which call this class by .NET's internal name
// (dotnet/runtime's own is unsafe span code over culture data): the
// invariant culture's standard formats and every custom specifier, as .NET
// writes them. Local time is UTC (see corelib/DateTime.cs).

using System.Text;

namespace System
{
    // (No static fields: a module carries a class's static state wherever
    // it is imported.)
    internal static class DateTimeFormat
    {
        private static string DayName(DayOfWeek day) => day switch
        {
            DayOfWeek.Sunday => "Sunday",
            DayOfWeek.Monday => "Monday",
            DayOfWeek.Tuesday => "Tuesday",
            DayOfWeek.Wednesday => "Wednesday",
            DayOfWeek.Thursday => "Thursday",
            DayOfWeek.Friday => "Friday",
            _ => "Saturday",
        };

        private static string MonthName(int month) => month switch
        {
            1 => "January",
            2 => "February",
            3 => "March",
            4 => "April",
            5 => "May",
            6 => "June",
            7 => "July",
            8 => "August",
            9 => "September",
            10 => "October",
            11 => "November",
            _ => "December",
        };

        // No offset: a DateTime's own (UTC, and local, which is UTC).
        private static TimeSpan NullOffset => new TimeSpan(long.MinValue);

        internal static string Format(DateTime dateTime, string? format, IFormatProvider? provider) =>
            Format(dateTime, format, provider, NullOffset);

        internal static string Format(DateTime dateTime, string? format, IFormatProvider? provider, TimeSpan offset)
        {
            if (string.IsNullOrEmpty(format))
            {
                // "G", and DateTimeOffset's default adds its offset.
                return Custom(dateTime, offset == NullOffset ? "MM/dd/yyyy HH:mm:ss" : "MM/dd/yyyy HH:mm:ss zzz", offset);
            }

            if (format.Length == 1)
            {
                // Expanded first: R, u and U change the time they format.
                string pattern = Expand(format, ref dateTime, ref offset);
                return Custom(dateTime, pattern, offset);
            }

            return Custom(dateTime, format, offset);
        }

        // A standard format's pattern (the invariant culture's), with R, u
        // and U's conversion to UTC.
        private static string Expand(string format, ref DateTime dateTime, ref TimeSpan offset)
        {
            switch (format[0])
            {
                case 'd':
                    return "MM/dd/yyyy";
                case 'D':
                    return "dddd, dd MMMM yyyy";
                case 'f':
                    return "dddd, dd MMMM yyyy HH:mm";
                case 'F':
                    return "dddd, dd MMMM yyyy HH:mm:ss";
                case 'g':
                    return "MM/dd/yyyy HH:mm";
                case 'G':
                    return "MM/dd/yyyy HH:mm:ss";
                case 'm':
                case 'M':
                    return "MMMM dd";
                case 'o':
                case 'O':
                    return "yyyy'-'MM'-'dd'T'HH':'mm':'ss'.'fffffffK";
                case 'r':
                case 'R':
                    if (offset != NullOffset)
                    {
                        dateTime -= offset;
                        offset = NullOffset;
                    }

                    return "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'";
                case 's':
                    return "yyyy'-'MM'-'dd'T'HH':'mm':'ss";
                case 't':
                    return "HH:mm";
                case 'T':
                    return "HH:mm:ss";
                case 'u':
                    if (offset != NullOffset)
                    {
                        dateTime -= offset;
                        offset = NullOffset;
                    }

                    return "yyyy'-'MM'-'dd HH':'mm':'ss'Z'";
                case 'U':
                    if (offset != NullOffset)
                    {
                        throw new FormatException("Input string was not in a correct format.");
                    }

                    dateTime = dateTime.ToUniversalTime();
                    return "dddd, dd MMMM yyyy HH:mm:ss";
                case 'y':
                case 'Y':
                    return "yyyy MMMM";
            }

            throw new FormatException("Input string was not in a correct format.");
        }

        private static string Custom(DateTime dateTime, string format, TimeSpan offset)
        {
            var text = new StringBuilder();
            int index = 0;
            while (index < format.Length)
            {
                char c = format[index];
                int count = Repeat(format, index, c);
                switch (c)
                {
                    case 'g':
                        text.Append("A.D.");
                        break;
                    case 'h':
                        int hour12 = dateTime.Hour % 12;
                        Digits(text, hour12 == 0 ? 12 : hour12, Math.Min(count, 2));
                        break;
                    case 'H':
                        Digits(text, dateTime.Hour, Math.Min(count, 2));
                        break;
                    case 'm':
                        Digits(text, dateTime.Minute, Math.Min(count, 2));
                        break;
                    case 's':
                        Digits(text, dateTime.Second, Math.Min(count, 2));
                        break;
                    case 'f':
                    case 'F':
                        if (count > 7)
                        {
                            throw new FormatException("Input string was not in a correct format.");
                        }

                        long fraction = dateTime.Ticks % TimeSpan.TicksPerSecond;
                        for (int scale = count; scale < 7; scale++)
                        {
                            fraction /= 10;
                        }

                        if (c == 'f')
                        {
                            Digits(text, fraction, count);
                        }
                        else
                        {
                            int width = count;
                            while (width > 0 && fraction % 10 == 0)
                            {
                                fraction /= 10;
                                width--;
                            }

                            if (width > 0)
                            {
                                Digits(text, fraction, width);
                            }
                            else if (text.Length > 0 && text[text.Length - 1] == '.')
                            {
                                // .NET drops the separator before an empty
                                // fraction.
                                text.Length--;
                            }
                        }

                        break;
                    case 't':
                        string designator = dateTime.Hour < 12 ? "AM" : "PM";
                        if (count == 1)
                        {
                            text.Append(designator[0]);
                        }
                        else
                        {
                            text.Append(designator);
                        }

                        break;
                    case 'd':
                        if (count <= 2)
                        {
                            Digits(text, dateTime.Day, count);
                        }
                        else
                        {
                            string day = DayName(dateTime.DayOfWeek);
                            text.Append(count == 3 ? day.Substring(0, 3) : day);
                        }

                        break;
                    case 'M':
                        if (count <= 2)
                        {
                            Digits(text, dateTime.Month, count);
                        }
                        else
                        {
                            string month = MonthName(dateTime.Month);
                            text.Append(count == 3 ? month.Substring(0, 3) : month);
                        }

                        break;
                    case 'y':
                        int year = dateTime.Year;
                        if (count <= 2)
                        {
                            Digits(text, year % 100, count);
                        }
                        else
                        {
                            Digits(text, year, count);
                        }

                        break;
                    case 'z':
                        Offset(text, offset == NullOffset ? TimeSpan.Zero : offset, count);
                        break;
                    case 'K':
                        if (offset != NullOffset)
                        {
                            Offset(text, offset, 3);
                        }
                        else if (dateTime.Kind == DateTimeKind.Utc)
                        {
                            text.Append('Z');
                        }
                        else if (dateTime.Kind == DateTimeKind.Local)
                        {
                            Offset(text, TimeSpan.Zero, 3);
                        }

                        count = 1;
                        break;
                    case ':':
                        text.Append(':');
                        count = 1;
                        break;
                    case '/':
                        text.Append('/');
                        count = 1;
                        break;
                    case '\'':
                    case '"':
                        int end = format.IndexOf(c, index + 1);
                        if (end < 0)
                        {
                            throw new FormatException("Input string was not in a correct format.");
                        }

                        text.Append(format, index + 1, end - index - 1);
                        count = end - index + 1;
                        break;
                    case '%':
                        if (index + 1 >= format.Length || format[index + 1] == '%')
                        {
                            throw new FormatException("Input string was not in a correct format.");
                        }

                        count = 1;
                        break;
                    case '\\':
                        if (index + 1 >= format.Length)
                        {
                            throw new FormatException("Input string was not in a correct format.");
                        }

                        text.Append(format[index + 1]);
                        count = 2;
                        break;
                    default:
                        text.Append(c);
                        count = 1;
                        break;
                }

                index += count;
            }

            return text.ToString();
        }

        private static int Repeat(string format, int index, char c)
        {
            int count = 1;
            while (index + count < format.Length && format[index + count] == c)
            {
                count++;
            }

            return count;
        }

        // z: hours; zz: two-digit hours; zzz: hh:mm.
        private static void Offset(StringBuilder text, TimeSpan offset, int count)
        {
            text.Append(offset.Ticks < 0 ? '-' : '+');
            long ticks = Math.Abs(offset.Ticks);
            int hours = (int)(ticks / TimeSpan.TicksPerHour);
            int minutes = (int)(ticks / TimeSpan.TicksPerMinute % 60);
            if (count == 1)
            {
                text.Append(hours);
            }
            else if (count == 2)
            {
                Digits(text, hours, 2);
            }
            else
            {
                Digits(text, hours, 2);
                text.Append(':');
                Digits(text, minutes, 2);
            }
        }

        private static void Digits(StringBuilder text, long value, int width)
        {
            string digits = value.ToString();
            for (int pad = digits.Length; pad < width; pad++)
            {
                text.Append('0');
            }

            text.Append(digits);
        }
    }
}
