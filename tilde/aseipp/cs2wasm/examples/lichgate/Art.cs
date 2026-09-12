// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Lichgate's look: a 32-colour palette (DawnBringer's DB32) and its dark,
// cursed and pale variants in the rest of the 256 entries, pixel art as
// rows of palette digits in source, and tiles drawn from a seed.
namespace Lichgate;

using System;
using Kiln;

internal static class Colors
{
    public const byte Black = 0;
    public const byte Night = 1;
    public const byte Plum = 2;
    public const byte Umber = 3;
    public const byte Brown = 4;
    public const byte Orange = 5;
    public const byte Tan = 6;
    public const byte Skin = 7;
    public const byte Yellow = 8;
    public const byte Lime = 9;
    public const byte Green = 10;
    public const byte Teal = 11;
    public const byte Moss = 12;
    public const byte Olive = 13;
    public const byte Slate = 14;
    public const byte Indigo = 15;
    public const byte Navy = 16;
    public const byte Blue = 17;
    public const byte Sky = 18;
    public const byte Cyan = 19;
    public const byte Frost = 20;
    public const byte White = 21;
    public const byte Silver = 22;
    public const byte Gray = 23;
    public const byte Stone = 24;
    public const byte Ash = 25;
    public const byte Purple = 26;
    public const byte Red = 27;
    public const byte Rose = 28;
    public const byte Pink = 29;
    public const byte Khaki = 30;
    public const byte Gold = 31;

    // DawnBringer's 32-colour palette.
    private static readonly uint[] Base =
    {
        0x000000, 0x222034, 0x45283C, 0x663931, 0x8F563B, 0xDF7126, 0xD9A066, 0xEEC39A,
        0xFBF236, 0x99E550, 0x6ABE30, 0x37946E, 0x4B692F, 0x524B24, 0x323C39, 0x3F3F74,
        0x306082, 0x5B6EE1, 0x639BFF, 0x5FCDE4, 0xCBDBFC, 0xFFFFFF, 0x9BADB7, 0x847E87,
        0x696A6A, 0x595652, 0x76428A, 0xAC3232, 0xD95763, 0xD77BBA, 0x8F974A, 0x8A6F30,
    };

    /// <summary>Each colour's shadowed version: its own entry in 32 to 63.</summary>
    public static readonly byte[] Shade = new byte[256];

    /// <summary>Each colour as the Lich's curse tints it (enraged boss, low health).</summary>
    public static readonly byte[] Cursed = new byte[256];

    /// <summary>Each colour washed pale (spawning enemies, ghosts).</summary>
    public static readonly byte[] Pale = new byte[256];

    // Colour ramps particles walk through as they age.
    public static readonly byte[] Fire = { Yellow, Orange, Red, Plum, Umber };
    public static readonly byte[] Magic = { White, Cyan, Sky, Blue, Indigo };
    public static readonly byte[] Blood = { Rose, Red, Red, Plum };
    public static readonly byte[] Ichor = { Lime, Green, Moss, Olive };
    public static readonly byte[] Bone = { White, Frost, Silver, Gray, Ash };
    public static readonly byte[] Soul = { White, Pink, Purple, Indigo };
    public static readonly byte[] Gilt = { White, Yellow, Gold, Umber };
    public static readonly byte[] Dust = { Tan, Brown, Umber };

    public static void Install(Palette palette)
    {
        for (int index = 0; index < 32; index++)
        {
            uint color = Base[index];
            palette[index] = color;
            palette[32 + index] = Scale(color, 0.55f, 0.5f, 0.7f);
            palette[64 + index] = Curse(color);
            palette[96 + index] = Mix(color, 0xCBDBFC, 0.6f);
            Shade[index] = (byte)(32 + index);
            Cursed[index] = (byte)(64 + index);
            Pale[index] = (byte)(96 + index);
        }

        for (int index = 32; index < 256; index++)
        {
            Shade[index] = (byte)index;
            Cursed[index] = (byte)index;
            Pale[index] = (byte)index;
        }
    }

    private static uint Scale(uint color, float r, float g, float b) =>
        ((uint)(((color >> 16) & 0xFF) * r) << 16) | ((uint)(((color >> 8) & 0xFF) * g) << 8) | (uint)((color & 0xFF) * b);

    private static uint Mix(uint color, uint other, float amount)
    {
        uint Channel(int shift)
        {
            float from = (color >> shift) & 0xFF;
            float to = (other >> shift) & 0xFF;
            return (uint)(from + (to - from) * amount) << shift;
        }

        return Channel(16) | Channel(8) | Channel(0);
    }

    // The curse: luminance pushed into reds and purples.
    private static uint Curse(uint color)
    {
        float r = (color >> 16) & 0xFF;
        float g = (color >> 8) & 0xFF;
        float b = color & 0xFF;
        float light = r * 0.3f + g * 0.59f + b * 0.11f;
        return ((uint)Math.Min(255, light * 1.3f + 30) << 16) | ((uint)(light * 0.35f) << 8) | (uint)Math.Min(255, light * 0.6f + 20);
    }
}

/// <summary>The game's sprites, drawn once from their rows.</summary>
internal static class Art
{
    // The hooded wanderer: two walking frames, facing right.
    public static readonly Sprite[] Player =
    {
        Sprite.Parse(
            "....FFFF....",
            "...FGGGGF...",
            "..FGGHHGGF..",
            "..FG7777GF..",
            "..FG70707F..",
            "...F7777F...",
            "..FFGGGGFF..",
            ".FGGGHHGGGF.",
            ".F7GGGGGG7F.",
            "..FGGGGGGF..",
            "..FGG44GGF..",
            "...F4..4F...",
            "...33..33..."),
        Sprite.Parse(
            "....FFFF....",
            "...FGGGGF...",
            "..FGGHHGGF..",
            "..FG7777GF..",
            "..FG70707F..",
            "...F7777F...",
            "..FFGGGGFF..",
            ".FGGGHHGGGF.",
            ".F7GGGGGG7F.",
            "..FGGGGGGF..",
            "..FGG44GGF..",
            "...F4.4F....",
            "....33.33..."),
    };

    public static readonly Sprite[] Bat =
    {
        Sprite.Parse(
            "Q..........Q",
            "QQ..2222..QQ",
            "QQQ22RR22QQQ",
            ".QQ2S22S2QQ.",
            "..Q222222Q..",
            "....2..2...."),
        Sprite.Parse(
            "....2222....",
            "...22RR22...",
            "..Q2S22S2Q..",
            ".QQ222222QQ.",
            "QQQ.2..2.QQQ",
            "QQ........QQ"),
    };

    public static readonly Sprite[] Slime =
    {
        Sprite.Parse(
            "....AAAA....",
            "..AA9999AA..",
            ".A99999999A.",
            ".A9L9999L9A.",
            "A9909999099A",
            "A9999999999A",
            "A99999999C9A",
            ".AAAAAAAAAA."),
        Sprite.Parse(
            "............",
            "...AAAAAA...",
            ".AA999999AA.",
            "A99L9999L99A",
            "A9909999099A",
            "A9999999999A",
            "AAAAAAAAAAAA",
            "............"),
    };

    public static readonly Sprite[] SmallSlime =
    {
        Sprite.Parse(
            "..AAAA..",
            ".A9999A.",
            "A9L99L9A",
            "A909909A",
            "A999999A",
            ".AAAAAA."),
        Sprite.Parse(
            "........",
            ".AAAAAA.",
            "A9L99L9A",
            "A909909A",
            "AAAAAAAA",
            "........"),
    };

    public static readonly Sprite[] Skeleton =
    {
        Sprite.Parse(
            "...LLLL...",
            "..LKKKKL..",
            "..K0KK0K..",
            "..KKKKKK..",
            "...K00K...",
            "..LKKKKL..",
            ".K.LKKL.K.",
            ".K.KLLK.K.",
            "...LKKL...",
            "...K..K...",
            "..KK..KK.."),
        Sprite.Parse(
            "...LLLL...",
            "..LKKKKL..",
            "..K0KK0K..",
            "..KKKKKK..",
            "...K00K...",
            "..LKKKKL..",
            "K..LKKL..K",
            ".K.KLLK.K.",
            "...LKKL...",
            "..K....K..",
            ".KK....KK."),
    };

    public static readonly Sprite[] Eye =
    {
        Sprite.Parse(
            "...QQQQQ...",
            "..QKKKKKQ..",
            ".QKKKJJKKQ.",
            "QKKJJHHJJKQ",
            "QKJH0000HJQ",
            "QKJH0000HJQ",
            "QKKJJHHJJKQ",
            ".QKKKJJKKQ.",
            "..QKKKKKQ..",
            "...QQQQQ..."),
        Sprite.Parse(
            "...QQQQQ...",
            "..QKKKKKQ..",
            ".QKKKKKKKQ.",
            "QKKKKKKKKKQ",
            "QQQQQQQQQQQ",
            "QKKKKKKKKKQ",
            "QKKKKKKKKKQ",
            ".QKKKKKKKQ.",
            "..QKKKKKQ..",
            "...QQQQQ..."),
    };

    public static readonly Sprite[] Boar =
    {
        Sprite.Parse(
            "..........33....",
            ".....333334433..",
            "...3344444444433",
            "..344444444RR443",
            ".3444444444440K4",
            "34444444444444K4",
            "344444444444446.",
            ".34444444444433.",
            "..333333333333..",
            "..33.33..33.33..",
            "..3...3..3...3.."),
        Sprite.Parse(
            "..........33....",
            ".....333334433..",
            "...3344444444433",
            "..344444444RR443",
            ".3444444444440K4",
            "34444444444444K4",
            "344444444444446.",
            ".34444444444433.",
            "..333333333333..",
            "...33.33.33.33..",
            "...3..3..3..3..."),
    };

    public static readonly Sprite[] Wisp =
    {
        Sprite.Parse(
            "..JJJJ..",
            ".JKLLKJ.",
            "JKL00LKJ",
            "JKLLLLKJ",
            ".JKLLKJ.",
            "..J..J..",
            ".J....J."),
        Sprite.Parse(
            "..JJJJ..",
            ".JKLLKJ.",
            "JKL00LKJ",
            "JKLLLLKJ",
            ".JKLLKJ.",
            "...JJ...",
            "..J..J.."),
    };

    // The Lich: a crowned skull in a tattered robe.
    public static readonly Sprite[] Lich =
    {
        Sprite.Parse(
            "........V..V..V.........",
            "........VVVVVVVV........",
            ".......VV88VV88VV.......",
            "......KKKKKKKKKKKK......",
            ".....KKKKKKKKKKKKKK.....",
            ".....KK00KKKKKK00KK.....",
            ".....KK0SKKKKKK0SKK.....",
            ".....KKKKKK00KKKKKK.....",
            "......KKKKKKKKKKKK......",
            ".......K0K0K0K0K0.......",
            "........KKKKKKKK........",
            ".....QQQQQQQQQQQQQQ.....",
            "....QQQQQQ2222QQQQQQ....",
            "...QQQQQQ222222QQQQQQ...",
            "..QQKKQQQ2RRRR2QQQKKQQ..",
            "..QKK.QQQ222222QQQ.KKQ..",
            "..KK..QQQQ2222QQQQ..KK..",
            ".KK...QQQQQQQQQQQQ...KK.",
            ".K....QQQQQQQQQQQQ....K.",
            "......QQQQQQQQQQQQ......",
            "......QQ2QQQQQQ2QQ......",
            ".....QQ22QQQQQQ22QQ.....",
            ".....Q2.2Q2..2Q2.2Q.....",
            "....Q2..2.2..2.2..2Q....",
            "....2...2..2.2..2..2...."),
        Sprite.Parse(
            "........V..V..V.........",
            "........VVVVVVVV........",
            ".......VV88VV88VV.......",
            "......KKKKKKKKKKKK......",
            ".....KKKKKKKKKKKKKK.....",
            ".....KK00KKKKKK00KK.....",
            ".....KK0SKKKKKK0SKK.....",
            ".....KKKKKK00KKKKKK.....",
            "......KKKKKKKKKKKK......",
            ".......K0K0K0K0K0.......",
            "........KKKKKKKK........",
            ".KK..QQQQQQQQQQQQQQ..KK.",
            "..KKQQQQQQ2222QQQQQQKK..",
            "...QQQQQQ222222QQQQQQ...",
            "...QQQQQQ2RRRR2QQQQQQ...",
            "....QQQQQ222222QQQQQ....",
            "......QQQQ2222QQQQ......",
            "......QQQQQQQQQQQQ......",
            "......QQQQQQQQQQQQ......",
            "......QQQQQQQQQQQQ......",
            "......QQ2QQQQQQ2QQ......",
            ".....QQ22QQQQQQ22QQ.....",
            ".....Q2.2Q2..2Q2.2Q.....",
            "....Q2..2.2..2.2..2Q....",
            "....2...2..2.2..2..2...."),
    };

    public static readonly Sprite Bolt = Sprite.Parse(
        ".JJ.",
        "JLLJ",
        "JLLJ",
        ".JJ.");

    public static readonly Sprite Orb = Sprite.Parse(
        ".SS.",
        "SLLS",
        "SLLS",
        ".SS.");

    public static readonly Sprite Arrow = Sprite.Parse(
        "KK.",
        "LLL",
        "KK.");

    public static readonly Sprite Heart = Sprite.Parse(
        ".RR.RR.",
        "RSSRSSR",
        "RSSSSSR",
        ".RSSSR.",
        "..RSR..",
        "...R...");

    public static readonly Sprite HeartEmpty = Sprite.Parse(
        ".11.11.",
        "1221221",
        "1222221",
        ".12221.",
        "..121..",
        "...1...");

    public static readonly Sprite HeartHalf = Sprite.Parse(
        ".RR.11.",
        "RSS1221",
        "RSS2221",
        ".RS221.",
        "..R21..",
        "...R...");

    public static readonly Sprite Gem = Sprite.Parse(
        "..L..",
        ".JLJ.",
        "JJLJJ",
        ".J.J.",
        "..J..");

    public static readonly Sprite Relic = Sprite.Parse(
        "..VVVV..",
        ".V8888V.",
        "V888LL8V",
        "V88LLL8V",
        "V8LLL88V",
        "V8LL888V",
        ".V8888V.",
        "..VVVV..");

    public static readonly Sprite Altar = Sprite.Parse(
        "..NNNNNNNNNNNN..",
        ".NOOOOOOOOOOOON.",
        ".NOPPPPPPPPPPON.",
        "..NNNNNNNNNNNN..",
        "...NONNNNNNON...",
        "...NONNNNNNON...",
        "...NONNNNNNON...",
        "..NNNNNNNNNNNN..",
        ".NOOOOOOOOOOOON.");

    public static readonly Sprite Portal = Sprite.Parse(
        "....QQQQQQQQ....",
        "..QQJJJJJJJJQQ..",
        ".QJJKKKKKKKKJJQ.",
        "QJKKLLLLLLLLKKJQ",
        "QJKL00000000LKJQ",
        "QJKL00000000LKJQ",
        "QJKKLLLLLLLLKKJQ",
        ".QJJKKKKKKKKJJQ.",
        "..QQJJJJJJJJQQ..",
        "....QQQQQQQQ....");

    public static readonly Sprite Crosshair = Sprite.Parse(
        "..L..",
        ".....",
        "L.L.L",
        ".....",
        "..L..");

    /// <summary>Sprites' outlined versions, drawn under them to pick them out of the floor.</summary>
    public static Sprite[] Outline(Sprite[] frames)
    {
        var outlined = new Sprite[frames.Length];
        for (int index = 0; index < frames.Length; index++)
        {
            outlined[index] = frames[index].Outlined(Colors.Black);
        }

        return outlined;
    }
}

/// <summary>Tiles, 16 pixels a side, drawn from a seed rather than by hand.</summary>
internal static class Tiles
{
    public const int Size = 16;

    public static Sprite Floor(Rng rng, byte baseColor, byte speck, byte crack)
    {
        var tile = new Sprite(Size, Size);
        for (int y = 0; y < Size; y++)
        {
            for (int x = 0; x < Size; x++)
            {
                tile[x, y] = baseColor;
            }
        }

        for (int index = 0; index < 10; index++)
        {
            tile[rng.Range(0, Size), rng.Range(0, Size)] = speck;
        }

        if (rng.Chance(0.35f))
        {
            int x = rng.Range(2, 13);
            int y = rng.Range(2, 13);
            for (int step = 0; step < 6; step++)
            {
                tile[Math.Clamp(x, 0, 15), Math.Clamp(y, 0, 15)] = crack;
                x += rng.Range(-1, 2);
                y += rng.Range(0, 2);
            }
        }

        // The grout between flagstones.
        for (int i = 0; i < Size; i++)
        {
            tile[i, 0] = crack;
            tile[0, i] = crack;
        }

        return tile;
    }

    public static Sprite Wall(Rng rng, byte face, byte light, byte mortar)
    {
        var tile = new Sprite(Size, Size);
        for (int y = 0; y < Size; y++)
        {
            int row = y / 4;
            int offset = row % 2 == 0 ? 0 : 4;
            for (int x = 0; x < Size; x++)
            {
                bool joint = y % 4 == 3 || (x + offset) % 8 == 7;
                tile[x, y] = joint ? mortar : y % 4 == 0 ? light : face;
            }
        }

        for (int index = 0; index < 4; index++)
        {
            tile[rng.Range(0, Size), rng.Range(0, Size)] = mortar;
        }

        return tile;
    }

    public static Sprite Rock(Rng rng)
    {
        var tile = new Sprite(Size, Size);
        float cx = 7.5f + rng.Range(-0.8f, 0.8f);
        float cy = 8.5f;
        for (int y = 0; y < Size; y++)
        {
            for (int x = 0; x < Size; x++)
            {
                float dx = (x - cx) / 7.2f;
                float dy = (y - cy) / 6.8f;
                float d = dx * dx + dy * dy + rng.Range(-0.06f, 0.06f);
                if (d > 1)
                {
                    continue;
                }

                tile[x, y] = d > 0.8f ? Colors.Night : dx + dy < -0.6f ? Colors.Silver : dx + dy < 0 ? Colors.Gray : Colors.Stone;
            }
        }

        return tile;
    }
}
