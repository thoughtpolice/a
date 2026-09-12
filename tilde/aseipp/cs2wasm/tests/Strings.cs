// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.StringTypes;

public sealed class Named
{
    public string Name;
    public int Score;
}

public struct Label
{
    public string Text;
    public int Size;
}

// Strings stay inside the module, so each test digests its strings into a
// number: their lengths and code units.
public static class Strings
{
    private static int Digest(string text)
    {
        if (text == null)
        {
            return -1;
        }

        int digest = text.Length;
        for (int index = 0; index < text.Length; index++)
        {
            digest = unchecked(digest * 31 + text[index]);
        }

        return digest;
    }

    public static int Literals(int which)
    {
        string text = which switch
        {
            0 => "",
            1 => "hello",
            2 => "héllo wörld ✓",
            3 => "tab\tquote\"backslash\\",
            _ => null,
        };
        return Digest(text) + (text == null ? 0 : text.Length * 1000000);
    }

    public static int Indexer(int index)
    {
        string text = "abcdef";
        return text[index];
    }

    public static int NullLength() => ((string)null).Length;

    public static int Equality(int which)
    {
        string left = which % 2 == 0 ? "same" : "diff";
        string right = "sa" + "me";
        string built = "s" + (which > 1 ? "am" : "xx") + "e";
        string missing = null;
        int result = 0;
        if (left == right)
        {
            result += 1;
        }

        if (left == built)
        {
            result += 10;
        }

        if (left != missing)
        {
            result += 100;
        }

        if (missing == null)
        {
            result += 1000;
        }

        if (string.Equals(built, right))
        {
            result += 10000;
        }

        if (built.Equals(left))
        {
            result += 100000;
        }

        return result;
    }

    public static int Concatenation(int value)
    {
        string text = "n=" + value + ", b=" + (value > 0) + ", c=" + (char)('a' + (value & 7));
        text += "!";
        text += value * 1000L;
        string empty = null;
        string both = empty + empty;
        string three = string.Concat("x", null, "z");
        return Digest(text) + both.Length * 7 + Digest(three);
    }

    public static int Integers(int which)
    {
        return which switch
        {
            0 => Digest(int.MinValue.ToString()),
            1 => Digest(int.MaxValue.ToString()),
            2 => Digest(long.MinValue.ToString()),
            3 => Digest(ulong.MaxValue.ToString()),
            4 => Digest(((byte)200).ToString()),
            5 => Digest(((sbyte)-100).ToString()),
            6 => Digest(0.ToString()),
            7 => Digest(uint.MaxValue.ToString()),
            8 => Digest(((short)-32768).ToString()),
            _ => Digest(true.ToString() + false.ToString() + 'q'.ToString()),
        };
    }

    public static int Interpolation(int value)
    {
        long wide = value * -3L;
        bool flag = value % 2 == 0;
        char letter = (char)('A' + (value & 15));
        string name = value > 5 ? "big" : null;
        string text = $"v={value}; w={wide}; f={flag}; l={letter}; n={name}; {{braces}}";
        return Digest(text) + Digest($"{value}") + Digest($"");
    }

    public static int Switches(int which)
    {
        string text = which switch
        {
            0 => "north",
            1 => "south",
            2 => "east",
            3 => null,
            _ => "west",
        };
        int score;
        switch (text)
        {
            case "north":
                score = 1;
                break;
            case "south":
            case "east":
                score = 2;
                break;
            case null:
                score = 3;
                break;
            default:
                score = 4;
                break;
        }

        return score * 10 + (text is "east" ? 1 : 0) + (text switch { "west" => 100, _ => 0 });
    }

    public static int Members(int start)
    {
        string text = "The quick brown fox";
        int digest = Digest(text.Substring(4, 5)) + Digest(text.Substring(16));
        digest = digest * 7 + text.IndexOf('q') * 100 + text.IndexOf('z') + (text.Contains('x') ? 1000 : 0);
        digest += string.IsNullOrEmpty(null) ? 10 : 0;
        digest += string.IsNullOrEmpty("") ? 20 : 0;
        digest += string.IsNullOrEmpty("a") ? 40 : 0;
        digest += string.CompareOrdinal("apple", "apricot") < 0 ? -3 : 3;
        digest += string.CompareOrdinal("same", "same");
        return digest + Digest(text.Substring(start, 3)) + Digest(string.Empty);
    }

    public static int Collections(int count)
    {
        var scores = new Dictionary<string, int>();
        var names = new List<string>();
        var seen = new HashSet<string>();
        for (int index = 0; index < count; index++)
        {
            string key = "k" + (index % 5);
            names.Add(key);
            seen.Add(key);
            scores[key] = scores.TryGetValue(key, out int old) ? old + index : index;
        }

        int digest = scores.Count * 1000 + seen.Count * 100 + names.IndexOf("k3") + (names.Contains("k9") ? 10 : 0);
        foreach (string name in names)
        {
            digest = unchecked(digest * 3 + scores[name]);
        }

        return digest + (seen.Contains("k" + 1) ? 7 : 0) + (scores.ContainsKey("K1") ? 1 : 0);
    }

    public static int Fields(int value)
    {
        var named = new Named { Name = "player" + value, Score = value };
        var label = new Label { Text = named.Name, Size = 3 };
        var copy = label;
        copy.Text = "other";
        var labels = new Dictionary<Label, int> { [label] = 1 };
        return Digest(named.Name) + Digest(label.Text) + Digest(copy.Text) + labels[new Label { Text = "player" + value, Size = 3 }];
    }

    public static int Exceptions(int which)
    {
        try
        {
            string text = which == 0 ? null : "abc";
            return text[which] + text.Length;
        }
        catch (NullReferenceException)
        {
            return -1;
        }
        catch (IndexOutOfRangeException)
        {
            return -2;
        }
    }

    public static int Substrings(int which)
    {
        string text = "abcdef";
        return which switch
        {
            0 => Digest(text.Substring(-1)),
            1 => Digest(text.Substring(7)),
            2 => Digest(text.Substring(2, 5)),
            _ => Digest(text.Substring(6)),
        };
    }
}
