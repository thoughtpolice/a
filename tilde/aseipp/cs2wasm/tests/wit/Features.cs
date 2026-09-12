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

        // Records compare by value, and `with` copies them.
        var sprite = new Shapes.Sprite(new Shapes.Rect(5, 6, 7, 8), tint, false) with { Visible = true };
        if (sprite == new Shapes.Sprite(new Shapes.Rect(5, 6, 7, 8), new Shapes.Color(1, 2, 3, 4), true))
            total += (long)Shapes.Blit(sprite, 1.5f);
        Shapes.SetClip(null);
        Shapes.SetClip(new Shapes.Rect(1, 2, 3, 4));

        Shapes.ShapeKind kind = Shapes.KindOf(4);
        Shapes.Style style = Shapes.StyleOf(kind);
        if ((style & Shapes.Style.Dashed) != 0)
            Log(2, (int)kind);
        // A try statement gives the module an exception tag, which the
        // component must keep.
        try
        {
            total += Shapes.Wide(-5, 7, -3, 65535, 0x1F600);
        }
        catch (System.InvalidOperationException)
        {
            total = -1;
        }

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

    // Every import through the boundary memory: strings (with a surrogate
    // pair), empty ones, lists, records of strings and lists, tuples,
    // options, seventeen parameters, a list bigger than the first page of
    // memory, and nested lists; the result summarizes what came back.
    public static partial string Describe()
    {
        string greeting = Text.Greet("wörld 🌍");
        string empty = Text.Greet("");
        int[] reversed = Text.Reverse(new[] { 1, 2, 3 });
        int[] none = Text.Reverse(new int[0]);
        Text.Entry[] entries = Text.Entries("item", 3);
        var split = Text.Split("left|right", 4);
        var found = Text.Find(new ushort[] { 5, 7, 9 }, 9);
        var missing = Text.Find(new ushort[0], 1);
        string name = Text.MaybeName(1);
        string nobody = Text.MaybeName(0);
        ulong many = Text.Many(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17);
        // Copying it costs a unit of fuel per byte; filling it would too.
        var big = new byte[65536];
        big[0] = 1;
        big[big.Length - 1] = 2;
        uint checksum = Text.Checksum(big);
        byte[][] transposed = Text.Transpose(new[] { new byte[] { 1, 2, 3 }, new byte[] { 4, 5, 6 } });
        uint pairs = Text.Pairs(new[]
        {
            new Tuple2<string, Option<long>>("a", new Option<long>(-5)),
            new Tuple2<string, Option<long>>("bb", default),
        });
        Shapes.Label(new Shapes.Rect(1, 2, 3, 4), "label ✓");
        var (measuredX, _, measuredW, _) = Shapes.Measure(6);

        // Variants and results, flat and through memory.
        double areas = Text.Area(new Text.ShapeCircle(1.5f)) + Text.Area(new Text.ShapeRect(new Tuple2<uint, uint>(3, 4)))
                       + Text.Area(new Text.ShapeLabel("wörd")) + Text.Area(new Text.ShapeEmpty());
        string parsed = Text.Parse("42") switch
        {
            Ok<uint> ok => "ok" + ok.Value,
            Err<string> error => "err" + error.Value,
        } + Text.Parse("x") switch
        {
            Ok<uint> ok => "ok" + ok.Value,
            Err<string> error => "err" + error.Value,
        };
        string mixed = Mixed(Text.Mix(new Text.MixedSmall(2.5f))) + Mixed(Text.Mix(new Text.MixedBig(1UL << 40)))
                       + Mixed(Text.Mix(new Text.MixedText("tx"))) + Mixed(Text.Mix(new Text.MixedNothing()));
        Text.Signal signal = Text.SignalOf(1);
        string validated = Text.Validate(new Result<Text.Shape, byte>[]
        {
            new Ok<Text.Shape>(new Text.ShapeCircle(1)),
            new Err<byte>(9),
            new Ok<Text.Shape>(new Text.ShapeLabel("")),
        }) switch
        {
            Ok<Unit> => "valid",
            Err<string[]> errors => errors.Value.Length + ":" + errors.Value[0],
        };
        return $"{greeting}|{empty.Length}|{reversed[0]}{reversed[2]}{none.Length}"
            + $"|{entries.Length}:{entries[2].Name}:{entries[2].Size}:{entries[2].Tags.Length}:{entries[2].Tags[1]}"
            + $"|{split.Item0}+{split.Item1}|{(found.HasValue ? found.Value : 99)}{(missing.HasValue ? 1 : 0)}"
            + $"|{name}{(nobody == null ? "-" : nobody)}|{many}|{checksum}"
            + $"|{transposed.Length}x{transposed[0].Length}:{transposed[2][1]}|{pairs}"
            + $"|{measuredX},{measuredW}|{(int)(areas * 100)}|{parsed}|{mixed}|{(int)signal}|{validated}";
    }

    private static string Mixed(Text.Mixed value) => value switch
    {
        Text.MixedSmall(var small) => "s" + (int)(small * 10),
        Text.MixedBig(var big) => "b" + (big >> 32),
        Text.MixedText(var text) => "t" + text,
        Text.MixedNothing => "n",
    };

    public static partial class TextCallbacks
    {
        public static partial string OnText(string text) => "<" + text + ">" + text.Length;

        public static partial string[] OnValues(double[] values)
        {
            var result = new string[values.Length];
            for (int index = 0; index < values.Length; index++)
                result[index] = ((long)values[index]).ToString();
            return result;
        }

        public static partial Text.Entry OnEntry(Text.Entry entry, Option<byte> extra)
        {
            if (!extra.HasValue)
                return null;
            var tags = new string[entry.Tags.Length];
            for (int index = 0; index < tags.Length; index++)
                tags[index] = entry.Tags[tags.Length - 1 - index];
            return new Text.Entry(entry.Name + "!", entry.Size + extra.Value, tags);
        }

        public static partial Result<string, uint> OnShape(Text.Shape shape) => shape switch
        {
            Text.ShapeCircle circle => new Ok<string>("circle " + (int)(circle.Value * 4)),
            Text.ShapeRect((var width, var height)) => new Ok<string>("rect " + width * height),
            Text.ShapeLabel label => new Ok<string>("label " + label.Value),
            _ => new Err<uint>(404),
        };

        public static partial Result<Unit, string>[] OnMixed(Text.Mixed[] values)
        {
            var results = new Result<Unit, string>[values.Length];
            for (int index = 0; index < values.Length; index++)
            {
                results[index] = values[index] switch
                {
                    Text.MixedText text => new Err<string>("no " + text.Value),
                    Text.MixedBig big when big.Value > 100 => new Err<string>("too big"),
                    _ => new Ok<Unit>(null),
                };
            }

            return results;
        }

        public static partial Tuple2<long, string> OnMany(
            int a, int b, int c, int d, int e, int f, int g, int h, int i,
            int j, int k, int l, int m, int n, int o, int p, string q)
        {
            long sum = a + b + c + d + e + f + g + h + i + j + k + l + m + n + o + p;
            return new Tuple2<long, string>(sum, q + q);
        }
    }

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
