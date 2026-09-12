// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;

/// <summary>
/// An indexed image: one byte per pixel, a palette index, which the
/// platform presents through the palette. Drawing is cut to the clip
/// rectangle and shifted by the camera offset, so game code draws in
/// world coordinates.
/// </summary>
public sealed class Canvas
{
    private int clipLeft;
    private int clipTop;
    private int clipRight;
    private int clipBottom;

    public Canvas(int width, int height)
    {
        Width = width;
        Height = height;
        Pixels = new byte[width * height];
        ResetClip();
    }

    public int Width { get; }

    public int Height { get; }

    public byte[] Pixels { get; }

    /// <summary>What world coordinate the canvas's top left shows.</summary>
    public int CameraX { get; set; }

    public int CameraY { get; set; }

    public void SetClip(int x, int y, int width, int height)
    {
        clipLeft = Math.Max(0, x);
        clipTop = Math.Max(0, y);
        clipRight = Math.Min(Width, x + width);
        clipBottom = Math.Min(Height, y + height);
    }

    public void ResetClip() => SetClip(0, 0, Width, Height);

    public void Clear(byte color) => Array.Fill(Pixels, color);

    /// <summary>Copies another canvas of the same size over this one.</summary>
    public void CopyFrom(Canvas other) => Array.Copy(other.Pixels, Pixels, Pixels.Length);

    /// <summary>Copies another canvas, opaque, with its top left at (x, y), row by row.</summary>
    public void Blit(Canvas source, int x, int y)
    {
        int left = x - CameraX;
        int top = y - CameraY;
        int fromColumn = Math.Max(0, clipLeft - left);
        int toColumn = Math.Min(source.Width, clipRight - left);
        int fromRow = Math.Max(0, clipTop - top);
        int toRow = Math.Min(source.Height, clipBottom - top);
        if (fromColumn >= toColumn)
        {
            return;
        }

        for (int row = fromRow; row < toRow; row++)
        {
            Array.Copy(source.Pixels, row * source.Width + fromColumn, Pixels, (top + row) * Width + left + fromColumn, toColumn - fromColumn);
        }
    }

    public void Plot(int x, int y, byte color)
    {
        x -= CameraX;
        y -= CameraY;
        if (x >= clipLeft && x < clipRight && y >= clipTop && y < clipBottom)
        {
            Pixels[y * Width + x] = color;
        }
    }

    public byte At(int x, int y)
    {
        x -= CameraX;
        y -= CameraY;
        return (uint)x < (uint)Width && (uint)y < (uint)Height ? Pixels[y * Width + x] : (byte)0;
    }

    public void Fill(int x, int y, int width, int height, byte color)
    {
        int left = Math.Max(x - CameraX, clipLeft);
        int right = Math.Min(x - CameraX + width, clipRight);
        int top = Math.Max(y - CameraY, clipTop);
        int bottom = Math.Min(y - CameraY + height, clipBottom);
        if (left >= right)
        {
            return;
        }

        for (int row = top; row < bottom; row++)
        {
            Array.Fill(Pixels, color, row * Width + left, right - left);
        }
    }

    public void Rect(int x, int y, int width, int height, byte color)
    {
        Fill(x, y, width, 1, color);
        Fill(x, y + height - 1, width, 1, color);
        Fill(x, y, 1, height, color);
        Fill(x + width - 1, y, 1, height, color);
    }

    public void Line(int x0, int y0, int x1, int y1, byte color)
    {
        int dx = Math.Abs(x1 - x0);
        int dy = -Math.Abs(y1 - y0);
        int sx = x0 < x1 ? 1 : -1;
        int sy = y0 < y1 ? 1 : -1;
        int error = dx + dy;
        while (true)
        {
            Plot(x0, y0, color);
            if (x0 == x1 && y0 == y1)
            {
                return;
            }

            int doubled = 2 * error;
            if (doubled >= dy)
            {
                error += dy;
                x0 += sx;
            }

            if (doubled <= dx)
            {
                error += dx;
                y0 += sy;
            }
        }
    }

    public void Circle(int cx, int cy, int radius, byte color)
    {
        for (int y = -radius; y <= radius; y++)
        {
            int span = (int)MathF.Sqrt(radius * radius - y * y + radius * 0.8f);
            Fill(cx - span, cy + y, 2 * span + 1, 1, color);
        }
    }

    public void Ring(int cx, int cy, int radius, byte color)
    {
        int x = radius;
        int y = 0;
        int error = 1 - radius;
        while (x >= y)
        {
            Plot(cx + x, cy + y, color);
            Plot(cx + y, cy + x, color);
            Plot(cx - y, cy + x, color);
            Plot(cx - x, cy + y, color);
            Plot(cx - x, cy - y, color);
            Plot(cx - y, cy - x, color);
            Plot(cx + y, cy - x, color);
            Plot(cx + x, cy - y, color);
            y++;
            if (error < 0)
            {
                error += 2 * y + 1;
            }
            else
            {
                x--;
                error += 2 * (y - x) + 1;
            }
        }
    }

    /// <summary>
    /// Draws a sprite with its top left at (x, y), skipping its transparent
    /// pixels. <paramref name="solid"/> draws every opaque pixel in one
    /// colour (a hit flash, a silhouette); <paramref name="remap"/>
    /// replaces colours (a palette swap).
    /// </summary>
    public void Draw(Sprite sprite, int x, int y, bool flipX = false, int solid = -1, byte[] remap = null)
    {
        int left = x - CameraX;
        int top = y - CameraY;
        int fromColumn = Math.Max(0, clipLeft - left);
        int toColumn = Math.Min(sprite.Width, clipRight - left);
        int fromRow = Math.Max(0, clipTop - top);
        int toRow = Math.Min(sprite.Height, clipBottom - top);
        if (fromColumn >= toColumn || fromRow >= toRow)
        {
            return;
        }

        byte[] source = sprite.Pixels;
        byte[] target = Pixels;
        int width = sprite.Width;
        for (int row = fromRow; row < toRow; row++)
        {
            int into = (top + row) * Width + left;
            int from = row * width;
            for (int column = fromColumn; column < toColumn; column++)
            {
                byte color = source[from + (flipX ? width - 1 - column : column)];
                if (color == Sprite.Transparent)
                {
                    continue;
                }

                target[into + column] = solid >= 0 ? (byte)solid : remap is null ? color : remap[color];
            }
        }
    }

    /// <summary>Replaces colours inside a rectangle through a table (shadows, tints).</summary>
    public void Remap(int x, int y, int width, int height, byte[] table)
    {
        int left = Math.Max(x - CameraX, clipLeft);
        int right = Math.Min(x - CameraX + width, clipRight);
        int top = Math.Max(y - CameraY, clipTop);
        int bottom = Math.Min(y - CameraY + height, clipBottom);
        for (int row = top; row < bottom; row++)
        {
            int start = row * Width;
            for (int column = left; column < right; column++)
            {
                Pixels[start + column] = table[Pixels[start + column]];
            }
        }
    }

    /// <summary>Text in the canvas's own 3x5 font (digits, capitals and a little punctuation).</summary>
    public void Text(string text, int x, int y, byte color)
    {
        int start = x;
        foreach (char character in text)
        {
            if (character == '\n')
            {
                x = start;
                y += 6;
                continue;
            }

            ushort glyph = Font.Glyph(character);
            for (int bit = 0; bit < 15; bit++)
            {
                if ((glyph & (1 << (14 - bit))) != 0)
                {
                    Plot(x + bit % 3, y + bit / 3, color);
                }
            }

            x += 4;
        }
    }
}

/// <summary>A 3x5 pixel font, one 15-bit glyph per character, rows top first.</summary>
public static class Font
{
    private const string Characters = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ!?.:+-*/%";

    private static readonly ushort[] Glyphs =
    {
        0b111_101_101_101_111, 0b010_110_010_010_111, 0b111_001_111_100_111, 0b111_001_111_001_111,
        0b101_101_111_001_001, 0b111_100_111_001_111, 0b111_100_111_101_111, 0b111_001_010_010_010,
        0b111_101_111_101_111, 0b111_101_111_001_111,
        0b010_101_111_101_101, 0b110_101_110_101_110, 0b011_100_100_100_011, 0b110_101_101_101_110,
        0b111_100_110_100_111, 0b111_100_110_100_100, 0b011_100_101_101_011, 0b101_101_111_101_101,
        0b111_010_010_010_111, 0b001_001_001_101_010, 0b101_101_110_101_101, 0b100_100_100_100_111,
        0b101_111_111_101_101, 0b110_101_101_101_101, 0b010_101_101_101_010, 0b110_101_110_100_100,
        0b010_101_101_110_011, 0b110_101_110_101_101, 0b011_100_010_001_110, 0b111_010_010_010_010,
        0b101_101_101_101_111, 0b101_101_101_101_010, 0b101_101_111_111_101, 0b101_101_010_101_101,
        0b101_101_010_010_010, 0b111_001_010_100_111,
        0b010_010_010_000_010, 0b110_001_010_000_010, 0b000_000_000_000_010, 0b000_010_000_010_000,
        0b000_010_111_010_000, 0b000_000_111_000_000, 0b000_101_010_101_000, 0b001_001_010_100_100,
        0b101_001_010_100_101,
    };

    public static ushort Glyph(char character)
    {
        if (character is >= 'a' and <= 'z')
        {
            character = (char)(character - 32);
        }

        int index = Characters.IndexOf(character);
        return index < 0 ? (ushort)0 : Glyphs[index];
    }

    /// <summary>The width text takes, in pixels.</summary>
    public static int Measure(string text) => text.Length == 0 ? 0 : text.Length * 4 - 1;
}
