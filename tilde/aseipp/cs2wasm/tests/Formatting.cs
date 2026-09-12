// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.Formatting;

public enum Suit
{
    Hearts,
    Spades = 5,
    Clubs = -3,
}

[Flags]
public enum Access : byte
{
    None = 0,
    Read = 1,
    Write = 2,
    Run = 4,
    All = 7,
}

[Flags]
public enum Wide : long
{
    A = 1,
    B = 1L << 40,
}

public enum Plain
{
    X = 1,
    Y = 2,
}

public sealed class Box<T>
{
    public T Value;
}

public class Outer<T>
{
    public sealed class Inner
    {
    }
}

public sealed class Failure : Exception
{
    public Failure(string message, Exception inner)
        : base(message, inner)
    {
    }
}

// Numbers formatted with the CLR's text, compared through digests of the
// strings (and, for single values, their characters).
public static class Formatting
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

    private static ulong state;

    private static ulong Next()
    {
        state = unchecked(state * 6364136223846793005UL + 1442695040888963407UL);
        ulong value = state;
        value ^= value >> 29;
        return value;
    }

    private static readonly string[] DoubleFormats =
    {
        null, "R", "G", "G3", "G17", "F", "F0", "F2", "F5", "E", "E2", "e10", "N", "N0", "N3", "P", "P1", "C", "0.00",
        "#,##0.###", "0.###E+0", "00000", "#.#", "0.0;(0.0);zero", "#,##0,,", "'x'0\\%", "0%", "", "g5", "f9",
    };

    private static readonly string[] IntegerFormats =
    {
        null, "D", "D8", "X", "x4", "X16", "N", "N0", "F2", "E", "E0", "G", "G3", "P0", "C", "0000", "#,##0", "0.00",
        "#", "00;(00)", "0e+0",
    };

    private static double Power(int exponent)
    {
        double result = 1;
        for (; exponent > 0; exponent--)
        {
            result *= 10;
        }

        for (; exponent < 0; exponent++)
        {
            result /= 10;
        }

        return result;
    }

    private static double RandomDouble(int kind)
    {
        ulong bits = Next();
        switch (kind % 6)
        {
            case 0:
                return BitConverter.Int64BitsToDouble((long)bits);
            case 1:
                // Near 1, in the formats' ranges.
                return BitConverter.Int64BitsToDouble((long)((bits & 0x800FFFFFFFFFFFFFUL) | (0x3E0UL + ((bits >> 52) & 0x3F)) << 52));
            case 2:
                // Subnormal.
                return BitConverter.Int64BitsToDouble((long)(bits & 0x800FFFFFFFFFFFFFUL));
            case 3:
                // Few digits.
                return (long)(bits % 2000001) - 1000000 + ((long)(bits >> 40) % 1000) / 1000.0;
            case 4:
                return ((long)(bits % 10000001) - 5000000) / 128.0;
            default:
                return (bits % 100) * Power((int)((bits >> 8) % 40) - 20);
        }
    }

    public static int Doubles(int seed)
    {
        state = (ulong)seed * 0x9E3779B97F4A7C15UL + 1;
        int digest = 0;
        for (int index = 0; index < 6; index++)
        {
            double value = RandomDouble(index);
            if (double.IsNaN(value))
            {
                value = index;
            }

            string format = DoubleFormats[(int)(Next() % (ulong)DoubleFormats.Length)];
            digest = unchecked(digest * 31 + Digest(value.ToString(format)));
            digest = unchecked(digest * 31 + Digest(value.ToString()));
        }

        return digest;
    }

    public static int Probe(int seed, int item, int index)
    {
        state = (ulong)seed * 0x9E3779B97F4A7C15UL + 1;
        string text = null;
        for (int current = 0; current <= item / 2; current++)
        {
            double value = RandomDouble(current);
            if (double.IsNaN(value))
            {
                value = current;
            }

            string format = DoubleFormats[(int)(Next() % (ulong)DoubleFormats.Length)];
            text = item % 2 == 0 ? value.ToString(format) + "|" + format : value.ToString("R") + "|" + BitConverter.DoubleToInt64Bits(value);
        }

        return index < text.Length ? text[index] : -1;
    }

    // .NET 11's X format of floating point (hexadecimal significand, binary
    // exponent), of doubles, floats and halves, with and without precisions.
    private static readonly string[] HexFormats = { "X", "x", "X0", "x1", "X3", "x13", "X20", "x7" };

    public static int HexFloats(int seed)
    {
        state = (ulong)seed * 0x9E3779B97F4A7C15UL + 11;
        int digest = 0;
        for (int index = 0; index < 6; index++)
        {
            double value = index == 0 ? BitConverter.Int64BitsToDouble((long)(Next() & 0xFFFFFFFFFFFFFUL)) : RandomDouble(index);
            string format = HexFormats[(int)(Next() % (ulong)HexFormats.Length)];
            digest = unchecked(digest * 31 + Digest(value.ToString(format)));
            digest = unchecked(digest * 31 + Digest(((float)value).ToString(format)));
            digest = unchecked(digest * 31 + Digest(((Half)value).ToString(format)));
            digest = unchecked(digest * 31 + Digest(BitConverter.UInt16BitsToHalf((ushort)Next()).ToString(format)));
        }

        return digest;
    }

    public static int Singles(int seed)
    {
        state = (ulong)seed * 0x9E3779B97F4A7C15UL + 7;
        int digest = 0;
        for (int index = 0; index < 6; index++)
        {
            float value = index % 2 == 0
                ? BitConverter.Int32BitsToSingle((int)Next())
                : (float)RandomDouble(index);
            if (float.IsNaN(value))
            {
                value = index;
            }

            string format = DoubleFormats[(int)(Next() % (ulong)DoubleFormats.Length)];
            digest = unchecked(digest * 31 + Digest(value.ToString(format)));
            digest = unchecked(digest * 31 + Digest(value.ToString()));
            digest = unchecked(digest * 31 + Digest($"{value}"));
        }

        return digest;
    }

    public static int Integers(int seed)
    {
        state = (ulong)seed * 0x9E3779B97F4A7C15UL + 3;
        int digest = 0;
        for (int index = 0; index < 6; index++)
        {
            ulong bits = Next();
            string format = IntegerFormats[(int)(Next() % (ulong)IntegerFormats.Length)];
            string text = (index % 8) switch
            {
                0 => ((int)bits).ToString(format),
                1 => ((long)bits).ToString(format),
                2 => ((short)bits).ToString(format),
                3 => ((sbyte)bits).ToString(format),
                4 => ((uint)bits).ToString(format),
                5 => bits.ToString(format),
                6 => ((byte)bits).ToString(format),
                _ => ((int)(bits % 2000) - 1000).ToString(format),
            };
            digest = unchecked(digest * 31 + Digest(text));
        }

        return digest;
    }

    private static readonly double[] Specials =
    {
        0.0, -0.0, 1.0, -1.0, 0.1, 0.2, 0.3, 1.0 / 3, 2.0 / 3, 1e15, 1e14, 123456789012345.0, 1234567890123456.0, 1e16,
        1e-5, 1e-4, 0.0001234, 1.7976931348623157e308, double.MinValue, double.Epsilon, 2.2250738585072014e-308,
        2.2250738585072009e-308, 5e-324, 0.125, 0.375, 2.5, 3.5, -2.5, 0.5, 1.5, 1.005, 1.25, 9.5, 99.5, 999.995,
        123.456, 1e21, 1e22, 1e23, 9007199254740992.0, 9007199254740993.0, 4.35, 0.15, 100, 1000000, 12345678,
        double.NaN, double.PositiveInfinity, double.NegativeInfinity, 5e-5, 0.000001, 1.23E+22, 4.9406564584124654E-324,
    };

    public static int Special(int which)
    {
        double value = Specials[which % Specials.Length];
        string format = DoubleFormats[which / Specials.Length % DoubleFormats.Length];
        return Digest(value.ToString(format));
    }

    public static int SingleSpecial(int which)
    {
        float value = (float)Specials[which % Specials.Length];
        string format = DoubleFormats[which / Specials.Length % DoubleFormats.Length];
        return Digest(value.ToString(format));
    }

    // One character of a formatted value, to pin text down exactly.
    public static int Character(int which, int index)
    {
        string text = which switch
        {
            0 => 0.1.ToString(),
            1 => (0.1 + 0.2).ToString(),
            2 => 1e15.ToString(),
            3 => 1e-5.ToString(),
            4 => (-0.0).ToString(),
            5 => 123.456.ToString("F2"),
            6 => 0.125.ToString("F2"),
            7 => 1234567.891.ToString("N2"),
            8 => 16777216f.ToString(),
            9 => 1e7f.ToString(),
            10 => 0.1f.ToString(),
            11 => $"{3.14159:F3}|{42,6}|{-7,-4}|{255:X4}|{0.5:P0}",
            12 => (-0.001).ToString("F2"),
            13 => 1234.5.ToString("E3"),
            14 => 12.0.ToString("0.00;minus;zero"),
            _ => double.MaxValue.ToString(),
        };
        return index < text.Length ? text[index] : -1;
    }

    public static int Interpolation(int value)
    {
        double scaled = value / 7.0;
        float single = value / 3f;
        return Digest($"{scaled} {single} {scaled:F3} {value:D6} {value,8:X} {single,-10:G4}| {scaled:0.##} {value:N0}");
    }

    public static int Concatenation(int value) => Digest("v=" + value / 8.0 + ";" + (float)value / 9 + ";" + 1e300 * value);

    public static int Enums(int which) => Digest(which switch
    {
        0 => Suit.Spades.ToString(),
        1 => ((Suit)4).ToString(),
        2 => ((Suit)(-3)).ToString(),
        3 => (Access.Read | Access.Write).ToString(),
        4 => ((Access)8).ToString(),
        5 => ((Access)9).ToString(),
        6 => Access.None.ToString(),
        7 => Access.All.ToString(),
        8 => ((Access)15).ToString(),
        9 => (Wide.A | Wide.B).ToString(),
        10 => (Plain.X | Plain.Y).ToString(),
        11 => (Plain.X | Plain.Y).ToString("F"),
        12 => Suit.Clubs.ToString("D"),
        13 => Suit.Clubs.ToString("X"),
        14 => Access.Run.ToString("x"),
        15 => $"{Access.Read,-8}|{Suit.Spades:D}|{Access.All:G}",
        16 => ((object)Access.Write).ToString(),
        17 => "e=" + Suit.Hearts + (Access)6,
        18 => Access.All.HasFlag(Access.Run) + "," + Access.Read.HasFlag(Access.Write),
        _ => ((Wide)(1L << 41)).ToString(),
    });

    public static int Names(int which) => Digest(NameText(which));

    public static int NameCharacter(int which, int index) =>
        index < NameText(which).Length ? NameText(which)[index] : -1;

    private static string NameText(int which) => (which switch
    {
        0 => new Box<int>().ToString(),
        1 => new Box<string>().ToString(),
        2 => new Outer<int>.Inner().ToString(),
        3 => new Box<Box<long>>().ToString(),
        4 => ((object)new int[0]).ToString(),
        5 => new Failure("bad", new InvalidOperationException("inner")).ToString(),
        6 => new Exception().ToString(),
        7 => new Failure(null, null).ToString(),
        8 => ((object)new string[1]).ToString(),
        9 => new System.Collections.Generic.List<int>().ToString(),
        10 => new Exception("outer", new Failure("middle", new Exception())).ToString(),
        _ => ((object)new Box<double>[0]).ToString(),
    });

    public static int HashPart(int which, int value) => which switch
    {
        0 => ((sbyte)value).GetHashCode(),
        1 => ((short)value).GetHashCode(),
        2 => ((char)value).GetHashCode(),
        3 => value.GetHashCode(),
        4 => ((long)value * 0x100000001L).GetHashCode(),
        5 => ((float)value / 3).GetHashCode(),
        6 => ((double)value / 7).GetHashCode(),
        7 => ((uint)value).GetHashCode(),
        8 => ((byte)value).GetHashCode(),
        9 => ((ushort)value).GetHashCode(),
        10 => (value > 0).GetHashCode(),
        11 => ((Suit)value).GetHashCode(),
        12 => ((Access)value).GetHashCode(),
        13 => (-0.0).GetHashCode() + double.NaN.GetHashCode() + ((ulong)value << 33).GetHashCode(),
        14 => ((object)value).GetHashCode() + ((object)(sbyte)value).GetHashCode(),
        _ => (value.Equals(value + 1) ? 1 : 0) + (1.5.Equals(1.5) ? 2 : 0) + (double.NaN.Equals(double.NaN) ? 4 : 0),
    };

    public static int HashProbe(int value, int which) => HashPart(which, value);

    public static int Hashes(int value)
    {
        int hash = 0;
        for (int which = 0; which < 16; which++)
        {
            hash = hash * 31 + HashPart(which, value);
        }

        return hash;
    }

    // A thrown exception's text has the CLR's stack trace.
    public static int ThrownText()
    {
        try
        {
            throw new Failure("x", null);
        }
        catch (Exception e)
        {
            return e.ToString().Length;
        }
    }

    public static int BadFormat(int which) => which switch
    {
        0 => 1.5.ToString("Q").Length,
        1 => 5.ToString("R").Length,
        _ => 5.ToString("Z3").Length,
    };
}
