// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;

/// <summary>
/// An indexed image with transparency. Pixel art is written in source as
/// rows of characters: '.' is transparent, and <c>0</c>-<c>9</c> then
/// <c>A</c>-<c>V</c> are palette indices 0 to 31.
/// </summary>
public sealed class Sprite
{
    /// <summary>The index a sprite uses for a transparent pixel.</summary>
    public const byte Transparent = 255;

    private const string Digits = "0123456789ABCDEFGHIJKLMNOPQRSTUV";

    public Sprite(int width, int height)
    {
        Width = width;
        Height = height;
        Pixels = new byte[width * height];
        Array.Fill(Pixels, Transparent);
    }

    public int Width { get; }

    public int Height { get; }

    public byte[] Pixels { get; }

    public static Sprite Parse(params string[] rows)
    {
        int width = 0;
        foreach (string row in rows)
        {
            width = Math.Max(width, row.Length);
        }

        var sprite = new Sprite(width, rows.Length);
        for (int y = 0; y < rows.Length; y++)
        {
            for (int x = 0; x < rows[y].Length; x++)
            {
                int index = Digits.IndexOf(rows[y][x]);
                if (index >= 0)
                {
                    sprite.Pixels[y * width + x] = (byte)index;
                }
            }
        }

        return sprite;
    }

    public byte this[int x, int y]
    {
        get => Pixels[y * Width + x];
        set => Pixels[y * Width + x] = value;
    }

    /// <summary>A copy with colours replaced through a table (a palette swap).</summary>
    public Sprite Recolor(byte[] table)
    {
        var copy = new Sprite(Width, Height);
        for (int index = 0; index < Pixels.Length; index++)
        {
            byte color = Pixels[index];
            copy.Pixels[index] = color == Transparent ? Transparent : table[color];
        }

        return copy;
    }

    /// <summary>A copy with a one-pixel outline of <paramref name="color"/> around its opaque pixels.</summary>
    public Sprite Outlined(byte color)
    {
        var copy = new Sprite(Width + 2, Height + 2);
        for (int y = 0; y < Height; y++)
        {
            for (int x = 0; x < Width; x++)
            {
                if (this[x, y] == Transparent)
                {
                    continue;
                }

                for (int dy = 0; dy <= 2; dy++)
                {
                    for (int dx = 0; dx <= 2; dx++)
                    {
                        if (copy[x + dx, y + dy] == Transparent)
                        {
                            copy[x + dx, y + dy] = color;
                        }
                    }
                }
            }
        }

        for (int y = 0; y < Height; y++)
        {
            for (int x = 0; x < Width; x++)
            {
                if (this[x, y] != Transparent)
                {
                    copy[x + 1, y + 1] = this[x, y];
                }
            }
        }

        return copy;
    }
}

/// <summary>
/// The 256 colours an indexed canvas is shown through, as 0xRRGGBB, and a
/// brightness the platform applies when it presents (fades, flashes).
/// </summary>
public sealed class Palette
{
    private readonly uint[] colors = new uint[256];
    private float brightness = 1;

    /// <summary>Changes whenever the colours or brightness do, so the platform uploads them only then.</summary>
    public int Version { get; private set; }

    public uint this[int index]
    {
        get => colors[index];
        set
        {
            if (colors[index] != value)
            {
                colors[index] = value;
                Version++;
            }
        }
    }

    /// <summary>0 is black, 1 the colours as they are, above 1 towards white.</summary>
    public float Brightness
    {
        get => brightness;
        set
        {
            float clamped = Math.Clamp(value, 0f, 2f);
            if (clamped != brightness)
            {
                brightness = clamped;
                Version++;
            }
        }
    }

    /// <summary>A colour as shown: brightness applied.</summary>
    public (byte R, byte G, byte B) Shown(int index)
    {
        uint color = colors[index];
        return (Channel(color >> 16), Channel(color >> 8), Channel(color));
    }

    private byte Channel(uint value)
    {
        float channel = value & 0xFF;
        channel = brightness <= 1 ? channel * brightness : channel + (255 - channel) * (brightness - 1);
        return (byte)Math.Clamp((int)(channel + 0.5f), 0, 255);
    }

    /// <summary>The index of the nearest colour among the first <paramref name="count"/>.</summary>
    public byte Nearest(uint color, int count = 256)
    {
        int best = 0;
        int bestDistance = int.MaxValue;
        for (int index = 0; index < count; index++)
        {
            int dr = (int)((colors[index] >> 16) & 0xFF) - (int)((color >> 16) & 0xFF);
            int dg = (int)((colors[index] >> 8) & 0xFF) - (int)((color >> 8) & 0xFF);
            int db = (int)(colors[index] & 0xFF) - (int)(color & 0xFF);
            int distance = dr * dr * 3 + dg * dg * 4 + db * db * 2;
            if (distance < bestDistance)
            {
                best = index;
                bestDistance = distance;
            }
        }

        return (byte)best;
    }
}
