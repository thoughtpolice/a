// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// TimeSpan's formatting, over dotnet/runtime's TimeSpan (whose own goes
// through unsafe span code): the invariant culture's standard formats ("c",
// "t", "T", "g", "G") and the custom ones, as .NET writes them.

using System.Text;

namespace System
{
    public readonly partial struct TimeSpan
    {
        public override string ToString() => Format(this, "c");

        public string ToString(string? format) => Format(this, format);

        public string ToString(string? format, IFormatProvider? formatProvider) => Format(this, format);

        private static string Format(TimeSpan value, string? format)
        {
            if (string.IsNullOrEmpty(format) || format is "c" or "t" or "T")
            {
                return Constant(value);
            }

            if (format.Length == 1)
            {
                return format[0] switch
                {
                    'g' => General(value, full: false),
                    'G' => General(value, full: true),
                    _ => throw new FormatException("Input string was not in a correct format."),
                };
            }

            return Custom(value, format);
        }

        // [-][d.]hh:mm:ss[.fffffff]
        private static string Constant(TimeSpan value)
        {
            long ticks = value.Ticks;
            var text = new StringBuilder();
            ulong magnitude = ticks < 0 ? (ulong)(-(ticks + 1)) + 1 : (ulong)ticks;
            if (ticks < 0)
            {
                text.Append('-');
            }

            ulong days = magnitude / TicksPerDay;
            ulong time = magnitude % TicksPerDay;
            if (days != 0)
            {
                text.Append(days);
                text.Append('.');
            }

            Two(text, (int)(time / TicksPerHour));
            text.Append(':');
            Two(text, (int)(time / TicksPerMinute % 60));
            text.Append(':');
            Two(text, (int)(time / TicksPerSecond % 60));
            int fraction = (int)(time % TicksPerSecond);
            if (fraction != 0)
            {
                text.Append('.');
                Digits(text, fraction, 7);
            }

            return text.ToString();
        }

        // "g": [-][d:]h:mm:ss[.FFFFFFF]; "G": [-]d:hh:mm:ss.fffffff.
        private static string General(TimeSpan value, bool full)
        {
            long ticks = value.Ticks;
            var text = new StringBuilder();
            ulong magnitude = ticks < 0 ? (ulong)(-(ticks + 1)) + 1 : (ulong)ticks;
            if (ticks < 0)
            {
                text.Append('-');
            }

            ulong days = magnitude / TicksPerDay;
            ulong time = magnitude % TicksPerDay;
            if (full || days != 0)
            {
                text.Append(days);
                text.Append(':');
            }

            int hours = (int)(time / TicksPerHour);
            if (full)
            {
                Two(text, hours);
            }
            else
            {
                text.Append(hours);
            }

            text.Append(':');
            Two(text, (int)(time / TicksPerMinute % 60));
            text.Append(':');
            Two(text, (int)(time / TicksPerSecond % 60));
            int fraction = (int)(time % TicksPerSecond);
            if (full)
            {
                text.Append('.');
                Digits(text, fraction, 7);
            }
            else if (fraction != 0)
            {
                text.Append('.');
                int width = 7;
                while (fraction % 10 == 0)
                {
                    fraction /= 10;
                    width--;
                }

                Digits(text, fraction, width);
            }

            return text.ToString();
        }

        // The custom format specifiers: d, h, m, s (one or two, d up to
        // eight), f and F (up to seven), and quoted or escaped literals.
        private static string Custom(TimeSpan value, string format)
        {
            long ticks = value.Ticks;
            ulong magnitude = ticks < 0 ? (ulong)(-(ticks + 1)) + 1 : (ulong)ticks;
            ulong time = magnitude % TicksPerDay;
            int days = (int)(magnitude / TicksPerDay);
            int hours = (int)(time / TicksPerHour);
            int minutes = (int)(time / TicksPerMinute % 60);
            int seconds = (int)(time / TicksPerSecond % 60);
            int fraction = (int)(time % TicksPerSecond);
            var text = new StringBuilder();
            int index = 0;
            while (index < format.Length)
            {
                char c = format[index];
                int count = 1;
                while (index + count < format.Length && format[index + count] == c)
                {
                    count++;
                }

                switch (c)
                {
                    case 'd':
                        if (count > 8)
                        {
                            throw Invalid();
                        }

                        Digits(text, days, count);
                        break;
                    case 'h':
                    case 'm':
                    case 's':
                        if (count > 2)
                        {
                            throw Invalid();
                        }

                        Digits(text, c == 'h' ? hours : c == 'm' ? minutes : seconds, count);
                        break;
                    case 'f':
                        if (count > 7)
                        {
                            throw Invalid();
                        }

                        Digits(text, fraction / Scale(7 - count), count);
                        break;
                    case 'F':
                        if (count > 7)
                        {
                            throw Invalid();
                        }

                        int digits = fraction / Scale(7 - count);
                        int width = count;
                        while (width > 0 && digits % 10 == 0)
                        {
                            digits /= 10;
                            width--;
                        }

                        if (width > 0)
                        {
                            Digits(text, digits, width);
                        }

                        break;
                    case '\'':
                    case '"':
                        int end = format.IndexOf(c, index + 1);
                        if (end < 0)
                        {
                            throw Invalid();
                        }

                        text.Append(format, index + 1, end - index - 1);
                        index = end + 1;
                        continue;
                    case '\\':
                        if (index + 1 >= format.Length)
                        {
                            throw Invalid();
                        }

                        text.Append(format[index + 1]);
                        index += 2;
                        continue;
                    case '%':
                        if (index + 1 >= format.Length || format[index + 1] == '%')
                        {
                            throw Invalid();
                        }

                        index++;
                        continue;
                    default:
                        throw Invalid();
                }

                index += count;
            }

            return text.ToString();
        }

        private static FormatException Invalid() => new("Input string was not in a correct format.");

        private static int Scale(int power)
        {
            int scale = 1;
            for (int i = 0; i < power; i++)
            {
                scale *= 10;
            }

            return scale;
        }

        private static void Two(StringBuilder text, int value) => Digits(text, value, 2);

        private static void Digits(StringBuilder text, long value, int width)
        {
            string digits = value.ToString();
            for (int pad = digits.Length; pad < width; pad++)
            {
                text.Append('0');
            }

            text.Append(digits);
        }

        private static void Digits(StringBuilder text, ulong value, int width) => Digits(text, (long)value, width);
    }
}
