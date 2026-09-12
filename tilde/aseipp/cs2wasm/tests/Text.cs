// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Text;

namespace Tests.Text;

public enum Tint
{
    Red,
    Green = 4,
}

public sealed class Tag
{
    public override string ToString() => "tag";
}

// String, char and StringBuilder members and parsing, over a set of sample
// strings chosen by index, digested.
public static class Text
{
    private static readonly string[] Samples =
    [
        "", " ", "a", "Hello, World", "  padded\t\n", "a,b,,c,", ",,", "x--y--z", "ÀÉÎõü ß straße", "İıſ Σσς",
        "tab\tsep nbsp em", "\0nul\0", "123", "-42", "+7", " 99 ", "3.25", "-1.5e3", "1,234.5", "1e400",
        "NaN", "-Infinity", "0x10", "9223372036854775808", "2147483648", "-2147483649", "abcabcabc", "ABC-abc",
        "𐐨𐐀", "True", " false ", "yes", "á", "{0}{1}", "٣٤", "Ⅻ", "¼", null,
    ];

    public static int Count => Samples.Length;

    private static string Sample(int index) => Samples[(index % Samples.Length + Samples.Length) % Samples.Length];

    private static int Mix(int digest, int value) => unchecked(digest * 31 + value);

    private static int Digest(string text)
    {
        if (text == null)
        {
            return -1;
        }

        int digest = text.Length;
        foreach (char c in text)
        {
            digest = Mix(digest, c);
        }

        return digest;
    }

    private static int Digest(string[] texts)
    {
        if (texts == null)
        {
            return -2;
        }

        int digest = texts.Length;
        foreach (var text in texts)
        {
            digest = Mix(digest, Digest(text));
        }

        return digest;
    }

    public static int Casing(int which)
    {
        string s = Sample(which);
        return Mix(Mix(Mix(Digest(s.ToUpper()), Digest(s.ToLower())), Digest(s.ToUpperInvariant())), Digest(s.ToLowerInvariant()));
    }

    public static int Trimming(int which)
    {
        string s = Sample(which);
        return Mix(Mix(Mix(Mix(Mix(Digest(s.Trim()), Digest(s.TrimStart())), Digest(s.TrimEnd())), Digest(s.Trim('a', ','))),
            Digest(s.TrimStart('x', ' '))), Digest(s.TrimEnd(',')));
    }

    public static int Searching(int which, int other)
    {
        string s = Sample(which);
        string t = Sample(other);
        int digest = s.IndexOf(t, StringComparison.Ordinal);
        digest = Mix(digest, s.IndexOf(t, StringComparison.OrdinalIgnoreCase));
        digest = Mix(digest, s.LastIndexOf(t, StringComparison.Ordinal));
        digest = Mix(digest, s.Contains(t) ? 1 : 0);
        digest = Mix(digest, s.Contains(t, StringComparison.OrdinalIgnoreCase) ? 1 : 0);
        digest = Mix(digest, s.StartsWith(t, StringComparison.Ordinal) ? 1 : 0);
        digest = Mix(digest, s.EndsWith(t, StringComparison.OrdinalIgnoreCase) ? 1 : 0);
        digest = Mix(digest, s.Equals(t, StringComparison.OrdinalIgnoreCase) ? 1 : 0);
        digest = Mix(digest, string.Equals(s, t, StringComparison.Ordinal) ? 1 : 0);
        digest = Mix(digest, Math.Sign(string.Compare(s, t, StringComparison.Ordinal)));
        digest = Mix(digest, Math.Sign(string.Compare(s, t, StringComparison.OrdinalIgnoreCase)));
        if (t.Length > 0)
        {
            char c = t[0];
            digest = Mix(digest, s.IndexOf(c));
            digest = Mix(digest, s.LastIndexOf(c));
            digest = Mix(digest, s.IndexOfAny(t.ToCharArray()));
            digest = Mix(digest, s.LastIndexOfAny(t.ToCharArray()));
            digest = Mix(digest, s.StartsWith(c) ? 1 : 0);
            digest = Mix(digest, s.EndsWith(c) ? 1 : 0);
            digest = Mix(digest, s.IndexOf(c, s.Length / 2));
            digest = Mix(digest, s.Contains(c, StringComparison.OrdinalIgnoreCase) ? 1 : 0);
        }

        return digest;
    }

    public static int Replacing(int which, int other)
    {
        string s = Sample(which);
        string t = Sample(other);
        int digest = t.Length > 0 ? Digest(s.Replace(t, "<>")) : 0;
        digest = Mix(digest, t.Length > 0 ? Digest(s.Replace(t, null)) : 1);
        digest = Mix(digest, Digest(s.Replace('a', 'A')));
        digest = Mix(digest, Digest(s.Insert(s.Length / 2, t)));
        digest = Mix(digest, s.Length > 0 ? Digest(s.Remove(s.Length / 2)) : 2);
        digest = Mix(digest, Digest(s.Remove(0, s.Length / 3)));
        digest = Mix(digest, Digest(s.PadLeft(12)) + Digest(s.PadRight(14, '.')));
        digest = Mix(digest, Digest(s.Substring(s.Length / 2)));
        digest = Mix(digest, Digest(new string(s.ToCharArray())));
        digest = Mix(digest, Digest(new string('=', t.Length)));
        return digest;
    }

    public static int Splitting(int which)
    {
        string s = Sample(which);
        int digest = Digest(s.Split(','));
        digest = Mix(digest, Digest(s.Split(',', StringSplitOptions.RemoveEmptyEntries)));
        digest = Mix(digest, Digest(s.Split(new[] { ',', '-' }, StringSplitOptions.TrimEntries)));
        digest = Mix(digest, Digest(s.Split(new[] { ',', ' ' }, 2)));
        digest = Mix(digest, Digest(s.Split("--")));
        digest = Mix(digest, Digest(s.Split(new[] { "--", "," }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)));
        digest = Mix(digest, Digest(s.Split()));
        digest = Mix(digest, Digest(s.Split((char[])null, 3, StringSplitOptions.RemoveEmptyEntries)));
        digest = Mix(digest, Digest(s.Split(',', 3, StringSplitOptions.None)));
        digest = Mix(digest, Digest(s.Split(',', 1, StringSplitOptions.TrimEntries)));
        digest = Mix(digest, Digest(s.Split("", StringSplitOptions.None)));
        return digest;
    }

    public static int Joining(int which, int other)
    {
        string s = Sample(which);
        string t = Sample(other);
        int digest = Digest(string.Join(", ", s, t, null, "end"));
        digest = Mix(digest, Digest(string.Join('|', new[] { s, t })));
        digest = Mix(digest, Digest(string.Join(null, new[] { t, s })));
        digest = Mix(digest, Digest(string.Join("/", new object[] { 1, 2.5, null, 'c', true, Tint.Green, new Tag() })));
        digest = Mix(digest, Digest(string.Join("-", new[] { "a", "b", "c", "d" }, 1, 2)));
        digest = Mix(digest, Digest(string.Concat(s, t, s, t, s)));
        digest = Mix(digest, Digest(string.Concat(new[] { s, null, t })));
        digest = Mix(digest, Digest(string.Concat((object)1, (object)null, (object)2.5f)));
        digest = Mix(digest, string.IsNullOrWhiteSpace(s) ? 1 : 0);
        return digest;
    }

    public static int Formats(int which, int value)
    {
        string s = Sample(which);
        double d = value / 8.0;
        int digest = Digest(string.Format("{0}", s));
        digest = Mix(digest, Digest(string.Format("[{0,6}|{1,-6}|{0:X}]", value, s)));
        digest = Mix(digest, Digest(string.Format("{0:F2} {1:N0} {2:E3} {0,10:0.00}", d, value * 1000, d)));
        digest = Mix(digest, Digest(string.Format("{0} {1:D} {1:X} {2} {3:x} {4}", Tint.Green, Tint.Red, true, 'c', null)));
        digest = Mix(digest, Digest(string.Format("{{{0}}} }} {{", value)));
        digest = Mix(digest, Digest(string.Format("{0}{1}{2}{3}{4}", 1, 2L, 3.5f, (byte)4, (short)-5)));
        digest = Mix(digest, Digest(string.Format("{0:x}{0:B}{1}", new Tag(), (object)null)));
        return digest;
    }

    // A format the compiler cannot see: composite formatting at run time.
    public static int RuntimeFormats(int which, int value)
    {
        string[] formats = ["{0}", "{0,5}", "{0:X4}|{1}", "{1,-4}:{0:F1}", "{{{0}}}", "{0", "{1}", "}", "{0:D3} {2}", "{ 0}", "{0 ,3}"];
        string format = formats[(which % formats.Length + formats.Length) % formats.Length];
        return Digest(string.Format(format, value, "s", value / 3.0));
    }

    public static int InvalidFormat(int which) =>
        Digest(which switch
        {
            0 => string.Format("{1}", 1),
            1 => string.Format("{0", 1),
            2 => string.Format("}", 1),
            3 => string.Format("{a}", 1),
            4 => string.Format("{0,}", 1),
            5 => string.Format("{0:{}", 1),
            _ => string.Format(null, 1),
        });

    public static int Builder(int which, int value)
    {
        string s = Sample(which);
        var builder = new StringBuilder("start");
        builder.Append(s).Append(':').Append(value).Append(' ').Append(value / 4.0).Append(true).Append('x', 3);
        builder.AppendLine().AppendLine(s).Append((object)null).Append(new Tag()).Append(new[] { 'a', 'b' });
        builder.Append(s, 0, s.Length / 2).AppendFormat("<{0,4}:{1}>", value, s);
        builder.Insert(2, "INS").Remove(0, 1).Replace('a', 'A').Replace("tag", "TAG");
        builder[0] = '#';
        int length = builder.Length;
        builder.Length = length + 2;
        string text = builder.ToString();
        builder.Length = 3;
        return Mix(Mix(Mix(Digest(text), Digest(builder.ToString())), length), builder[1]);
    }

    public static int BuilderFaults(int which) =>
        which switch
        {
            0 => new StringBuilder("ab")[5],
            1 => new StringBuilder("ab").Remove(1, 5).Length,
            2 => new StringBuilder("ab").Insert(3, "x").Length,
            3 => new StringBuilder(-1).Length,
            _ => new StringBuilder().Append('x', -1).Length,
        };

    public static int Characters(int unit)
    {
        char c = (char)unit;
        string s = "a" + c;
        return Mix(Mix(Mix((char.IsDigit(s, 1) ? 1 : 0) + (char.IsLetter(s, 1) ? 2 : 0) + (char.IsWhiteSpace(s, 1) ? 4 : 0),
            char.ToUpper(c)), Digest(char.ToString(c))), (int)char.GetUnicodeCategory(c));
    }

    public static long ParseInteger(int which, int type)
    {
        string s = Sample(which);
        return type switch
        {
            0 => int.Parse(s),
            1 => long.Parse(s),
            2 => uint.Parse(s),
            3 => short.Parse(s),
            4 => byte.Parse(s),
            5 => (long)ulong.Parse(s),
            6 => sbyte.Parse(s),
            _ => ushort.Parse(s),
        };
    }

    public static long TryParseInteger(int which, int type)
    {
        string s = Sample(which);
        bool ok;
        long value;
        switch (type)
        {
            case 0:
                ok = int.TryParse(s, out int i);
                value = i;
                break;
            case 1:
                ok = long.TryParse(s, out long l);
                value = l;
                break;
            case 2:
                ok = uint.TryParse(s, out uint u);
                value = u;
                break;
            default:
                ok = byte.TryParse(s, out byte b);
                value = b;
                break;
        }

        return ok ? value : -999;
    }

    public static double ParseDouble(int which) => double.Parse(Sample(which));

    public static float ParseSingle(int which) => float.Parse(Sample(which));

    public static double TryParseDouble(int which) => double.TryParse(Sample(which), out double value) ? value : -999;

    // Digits long and exact: halfway cases and many digits.
    public static double ParseDigits(int which) => which switch
    {
        0 => double.Parse("9007199254740993"),
        1 => double.Parse("9007199254740993.0000000000000000000000000001"),
        2 => double.Parse("2.2250738585072011e-308"),
        3 => double.Parse("4.9406564584124654e-324"),
        4 => double.Parse("2.4703282292062327e-324"),
        5 => double.Parse("2.4703282292062328e-324"),
        6 => double.Parse("1.7976931348623157e308"),
        7 => double.Parse("1.7976931348623158e308"),
        8 => double.Parse("0.1000000000000000055511151231257827021181583404541015625"),
        9 => double.Parse("123456789012345678901234567890e-20"),
        10 => float.Parse("16777217"),
        11 => float.Parse("3.4028235e38"),
        12 => float.Parse("1.4e-45"),
        13 => double.Parse("  +.5  "),
        14 => double.Parse("1,,000.25"),
        15 => double.Parse("-0"),
        _ => double.Parse("1e"),
    };

    public static int ParseBool(int which) =>
        bool.TryParse(Sample(which), out bool value) ? (value ? 1 : 0) : bool.Parse(Sample(which)) ? 2 : 3;

    public static int ParseChar(int which) => char.TryParse(Sample(which), out char c) ? c : -char.Parse(Sample(which));
}
