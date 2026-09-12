// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The module side of world `test` in features.wit: the generated partial
// classes are completed here, and every generated import is exercised.
namespace Test.Features;

public static partial class Test
{
    static uint fills;
    static long total;

    public static partial uint Run(uint steps)
    {
        var tint = new Shapes.Color(1, 2, 3, 4);
        for (uint index = 0; index < steps; index++)
            fills += Shapes.Fill(new Shapes.Rect((int)index, -(int)index, index * 2, index * 3), tint);

        var sprite = new Shapes.Sprite(new Shapes.Rect(5, 6, 7, 8), tint, true);
        total += (long)Shapes.Blit(sprite, 1.5f);
        Shapes.SetClip(null);
        Shapes.SetClip(new Shapes.Rect(1, 2, 3, 4));

        Shapes.ShapeKind kind = Shapes.KindOf(4);
        Shapes.Style style = Shapes.StyleOf(kind);
        if ((style & Shapes.Style.Dashed) != 0)
            Log(2, (int)kind);
        total += Shapes.Wide(-5, 7, -3, 65535, 0x1F600);

        var canvas = new Handles.Canvas(64, 32);
        canvas.Clear(7);
        total += (long)canvas.Area();
        Handles.Canvas other = Handles.Open(9);
        Handles.Canvas merged = Handles.Canvas.Merge(canvas, other);
        // A spent object keeps no handle to reuse.
        Log(3, other.ToHandle());
        bool clipped = merged.TakeClip(new Shapes.Rect(0, 0, 1, 1));
        merged.TakeClip(null);
        merged.Dispose();
        canvas.Dispose();
        // Merge took ownership of `other`, so this drops nothing.
        other.Dispose();
        Handles.DisposeAll();

        // Every option is lowered on its own, present or not.
        Log(9, (int)Shapes.SetClips(new Shapes.Rect(1, 2, 3, 4), new Shapes.Rect(5, 6, 7, 8)));
        Log(9, (int)Shapes.SetClips(new Shapes.Rect(9, 9, 9, 9), null));
        Log(9, (int)Shapes.SetClips(null, new Shapes.Rect(-7, 7, 7, 7)));
        Shapes.Show(new Shapes.Window(new Shapes.Rect(1, 1, 1, 1), new Shapes.Tagged(Shapes.ShapeKind.Square, true)), null);
        Shapes.Show(new Shapes.Window(new Shapes.Rect(2, 2, 2, 2), null), new Shapes.Tagged(Shapes.ShapeKind.List, false));
        Log(5, (int)Shapes.ModeOf(Shapes.Mode.None | Shapes.Mode.Fast));

        // A constructor with the handle wrapper's parameter shape.
        var counter = new Handles.Counter(41);
        Log(6, counter.Get());
        counter.Dispose();

        // A constructor spends its owned argument, with or without the option.
        var first = new Handles.Canvas(2, 2);
        var layer = new Handles.Layer(first, null);
        Log(7, first.ToHandle());
        first.Dispose();
        layer.Dispose();
        var second = new Handles.Layer(new Handles.Canvas(3, 3), new Shapes.Rect(1, 2, 3, 4));
        second.Dispose();

        // Handles of a resource used from another interface.
        Handles.Canvas gift = Gifts.Give(5);
        Handles.Canvas swapped = Gifts.Swap(gift);
        Log(8, gift.ToHandle());
        swapped.Dispose();

        // Same-named interfaces of two packages.
        Log(10, (int)(TestFeaturesUtil.Ping(1) + TestOtherUtil.Ping(2)));
        return fills + (clipped ? 1000u : 0u);
    }

    public static partial long Finish() => total;

    public static partial class Callbacks
    {
        public static partial bool OnHit(Hit hit, Shapes.Color tint)
        {
            Log(1, hit.Where.X * 1000 + (int)hit.What);
            return tint.A == 255 && hit.Where.W > 0;
        }

        public static partial int OnTick(ulong frame) => (int)(frame % 1000);

        public static partial int OnWindow(Shapes.Window window, Shapes.Rect extra)
        {
            int tag = window.Tag == null ? 0 : 100 + (int)window.Tag.Kind + (window.Tag.Visible ? 10 : 0);
            int wide = extra == null ? 0 : 1000 * extra.X;
            return window.Frame.X + tag + wide;
        }

        static Handles.Canvas previous;

        public static partial Handles.Canvas OnCanvas(Handles.Canvas seen, Handles.Canvas kept)
        {
            // The object returned last time went to the host with its handle.
            if (previous != null)
                Log(4, previous.ToHandle());
            seen.Clear(2);
            previous = kept;
            return kept;
        }
    }
}
