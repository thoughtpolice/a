// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Globalization;

namespace Tests.Characters;

// char's classification and casing for every UTF-16 code unit, a page of
// 256 at a time, and string casing across the supplementary planes.
public static class Characters
{
    private static int Mix(int digest, int value) => unchecked(digest * 31 + value);

    public static int Categories(int page)
    {
        int digest = page;
        for (int unit = page * 256; unit < page * 256 + 256; unit++)
        {
            digest = Mix(digest, (int)char.GetUnicodeCategory((char)unit));
        }

        return digest;
    }

    public static int Classes(int page)
    {
        int digest = page;
        for (int unit = page * 256; unit < page * 256 + 256; unit++)
        {
            char c = (char)unit;
            int bits = (char.IsDigit(c) ? 1 : 0) | (char.IsLetter(c) ? 2 : 0) | (char.IsWhiteSpace(c) ? 4 : 0)
                | (char.IsUpper(c) ? 8 : 0) | (char.IsLower(c) ? 16 : 0) | (char.IsPunctuation(c) ? 32 : 0)
                | (char.IsSymbol(c) ? 64 : 0) | (char.IsSeparator(c) ? 128 : 0) | (char.IsControl(c) ? 256 : 0)
                | (char.IsNumber(c) ? 512 : 0) | (char.IsLetterOrDigit(c) ? 1024 : 0) | (char.IsSurrogate(c) ? 2048 : 0)
                | (char.IsHighSurrogate(c) ? 4096 : 0) | (char.IsAsciiHexDigit(c) ? 8192 : 0);
            digest = Mix(digest, bits);
        }

        return digest;
    }

    public static int Cases(int page)
    {
        int digest = page;
        for (int unit = page * 256; unit < page * 256 + 256; unit++)
        {
            char c = (char)unit;
            digest = Mix(Mix(Mix(Mix(digest, char.ToUpperInvariant(c)), char.ToLowerInvariant(c)), char.ToUpper(c)), char.ToLower(c));
        }

        return digest;
    }

    // Strings of code points from `start`, 256 at a time, surrogate pairs
    // above the BMP, cased whole.
    public static int StringCases(int start)
    {
        int digest = start;
        for (int point = start; point < start + 256; point++)
        {
            if (point >= 0xD800 && point <= 0xDFFF)
            {
                continue;
            }

            string text = char.ConvertFromUtf32(point);
            digest = Mix(Mix(digest, Sum(text.ToUpperInvariant())), Sum(text.ToLowerInvariant()));
        }

        return digest;
    }

    private static int Sum(string text)
    {
        int digest = text.Length;
        foreach (char c in text)
        {
            digest = Mix(digest, c);
        }

        return digest;
    }
}
