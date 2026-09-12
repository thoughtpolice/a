// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln
{
    using Sdk = global::Console.Sdk;

    /// <summary>
    /// The display: an indexed canvas presented through the palette (the
    /// palette uploaded only when it changes), and the platform's overlay
    /// for text in its built-in font, drawn over the presented frame.
    /// </summary>
    internal sealed class Screen
    {
        private readonly Sdk.Gfx.Color[] upload = new Sdk.Gfx.Color[256];
        private int uploaded = -1;

        public Screen(int width, int height)
        {
            Canvas = new Canvas(width, height);
            Palette = new Palette();
        }

        public Canvas Canvas { get; }

        public Palette Palette { get; }

        public int Width => Canvas.Width;

        public int Height => Canvas.Height;

        /// <summary>Overlay text in the built-in 5x7 font, 6 pixels a character.</summary>
        public void Text(int x, int y, string text, byte color)
        {
            Refresh();
            Sdk.Gfx.DrawText(x, y, text, upload[color]);
        }

        public void TextCentered(int y, string text, byte color) => Text((Width - text.Length * 6 + 1) / 2, y, text, color);

        /// <summary>A text with a one-pixel shadow under it.</summary>
        public void Shadowed(int x, int y, string text, byte color, byte shadow)
        {
            Text(x + 1, y + 1, text, shadow);
            Text(x, y, text, color);
        }

        public void ShadowedCentered(int y, string text, byte color, byte shadow) =>
            Shadowed((Width - text.Length * 6 + 1) / 2, y, text, color, shadow);

        /// <summary>An overlay rectangle, over everything the canvas shows.</summary>
        public void Panel(int x, int y, int width, int height, byte color)
        {
            Refresh();
            Sdk.Gfx.FillRect(new Sdk.Gfx.Rect(x, y, (uint)width, (uint)height), upload[color]);
        }

        internal void Present()
        {
            Refresh();
            Sdk.Gfx.PresentIndexed((uint)Canvas.Width, (uint)Canvas.Height, Canvas.Pixels);
        }

        private void Refresh()
        {
            if (uploaded == Palette.Version)
            {
                return;
            }

            for (int index = 0; index < 256; index++)
            {
                var (r, g, b) = Palette.Shown(index);
                upload[index] = new Sdk.Gfx.Color(r, g, b, 255);
            }

            Sdk.Gfx.SetPalette(0, upload);
            uploaded = Palette.Version;
        }
    }
}
