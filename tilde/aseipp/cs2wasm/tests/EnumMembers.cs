// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.EnumMembers;

public enum Suit
{
    Clubs,
    Diamonds = 5,
    Hearts = -3,
    Spades = 5,
}

[Flags]
public enum Access : byte
{
    None = 0,
    Read = 1,
    Write = 2,
    Execute = 4,
    All = 7,
}

public enum Tiny : sbyte
{
    Low = -128,
    High = 127,
}

public enum Wide : ulong
{
    Zero,
    Huge = ulong.MaxValue,
}

public enum Big : long
{
    Negative = long.MinValue,
    Positive = long.MaxValue,
}

// Enum.Parse, TryParse, GetNames, GetValues, GetName and IsDefined,
// against the CLR.
public static class EnumMembers
{
    private static readonly string[] Inputs =
    [
        "Clubs", "Diamonds", " Hearts ", "hearts", "Spades", "5", "-3", "+7", "  42 ", "Nope", "", "   ", "Clubs,Hearts",
        "Read, Write", "Read,,Write", "7", "256", "-1", "300", "-129", "127", "18446744073709551615", "18446744073709551616",
        "-9223372036854775808", "9223372036854775808", "Execute ,Read", "1e3", "0x10", "Low", "High", "Huge", "Positive",
        null,
    ];

    public const int InputCount = 33;

    private static int Digest(string text)
    {
        if (text == null)
        {
            return -1;
        }

        int digest = text.Length;
        foreach (char c in text)
        {
            digest = unchecked(digest * 31 + c);
        }

        return digest;
    }

    public static long Parse(int which, int input, bool ignoreCase)
    {
        string text = Inputs[input];
        return which switch
        {
            0 => (long)Enum.Parse<Suit>(text, ignoreCase),
            1 => (long)Enum.Parse<Access>(text, ignoreCase),
            2 => (long)Enum.Parse<Tiny>(text, ignoreCase),
            3 => (long)(ulong)Enum.Parse<Wide>(text, ignoreCase),
            _ => (long)Enum.Parse<Big>(text, ignoreCase),
        };
    }

    public static long TryParse(int which, int input, bool ignoreCase)
    {
        string text = Inputs[input];
        switch (which)
        {
            case 0:
                return Enum.TryParse(text, ignoreCase, out Suit suit) ? (long)suit : -1000;
            case 1:
                return Enum.TryParse(text, out Access access) ? (long)access : -1000;
            case 2:
                return Enum.TryParse(text, ignoreCase, out Tiny tiny) ? (long)tiny : -1000;
            case 3:
                return Enum.TryParse(text, ignoreCase, out Wide wide) ? (long)(ulong)wide : -1000;
            default:
                return Enum.TryParse(text, ignoreCase, out Big big) ? (long)big : -1000;
        }
    }

    public static int Names(int which)
    {
        string[] names = which switch
        {
            0 => Enum.GetNames<Suit>(),
            1 => Enum.GetNames<Access>(),
            2 => Enum.GetNames<Tiny>(),
            3 => Enum.GetNames<Wide>(),
            _ => Enum.GetNames<Big>(),
        };
        int digest = names.Length;
        foreach (var name in names)
        {
            digest = unchecked(digest * 31 + Digest(name));
        }

        return digest;
    }

    public static long Values(int which)
    {
        long digest = 0;
        switch (which)
        {
            case 0:
                foreach (var value in Enum.GetValues<Suit>())
                {
                    digest = digest * 31 + (long)value;
                }

                break;
            case 1:
                foreach (var value in Enum.GetValues<Access>())
                {
                    digest = digest * 31 + (long)value;
                }

                break;
            case 2:
                foreach (var value in Enum.GetValues<Tiny>())
                {
                    digest = digest * 31 + (long)value;
                }

                break;
            case 3:
                foreach (var value in Enum.GetValues<Wide>())
                {
                    digest = digest * 31 + (long)value;
                }

                break;
            default:
                foreach (var value in Enum.GetValues<Big>())
                {
                    digest = digest * 31 + (long)value;
                }

                break;
        }

        return digest;
    }

    public static int Named(int value) =>
        Digest(Enum.GetName((Suit)value)) + Digest(Enum.GetName((Access)value)) * 7 + (Enum.IsDefined((Suit)value) ? 1 : 0)
        + (Enum.IsDefined((Access)value) ? 2 : 0) + (Enum.IsDefined((Tiny)value) ? 4 : 0);
}
