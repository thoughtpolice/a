// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A fireworks show as a console:sdk game, written with async (see
// docs/IMPORTER.md, "Async as built"). The show is a script of coroutines:
// each rocket rises a step a frame (`await Frames.NextFrame()`), bursts
// into sparks that fall and fade frame by frame, and the volleys wait on
// each other with Task.WhenAll and on game time with Task.Delay. Start
// skips to the finale through a CancellationToken. `Step` advances the
// frame loop by the frame's time, which runs every coroutine that is due,
// then draws. Two games drive it: FireworksGame.cs from the `game` world's
// `frame` export, and FireworksTasks.cs from the `async-game` world's one
// long task, a frame at a time through the SDK's scheduler.
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Gameplay;

namespace Console.Sdk;

internal sealed class Rocket
{
    public float X;
    public float Y;
}

internal sealed class Spark
{
    public float X;
    public float Y;
    public float VelocityX;
    public float VelocityY;
    public int Life;
    public Gfx.Color Color = null!;
}

internal static class Fireworks
{
    const int Width = 320;
    const int Height = 240;
    const uint LongestFrameMs = 50;

    static readonly Gfx.Color Sky = new Gfx.Color(8, 8, 24, 255);
    static readonly Gfx.Color Trail = new Gfx.Color(255, 240, 200, 255);
    static readonly Gfx.Color[] Palette =
    {
        new Gfx.Color(255, 80, 80, 255),
        new Gfx.Color(255, 200, 64, 255),
        new Gfx.Color(96, 220, 120, 255),
        new Gfx.Color(96, 160, 255, 255),
        new Gfx.Color(220, 120, 255, 255),
    };

    static readonly List<Rocket> rockets = new List<Rocket>();
    static readonly List<Spark> sparks = new List<Spark>();
    static CancellationTokenSource skip = null!;
    static uint seed;
    static bool over;

    internal static void Start()
    {
        Gfx.SetMode(Width, Height);
        Clock.SetFrameRate(60);
        rockets.Clear();
        sparks.Clear();
        seed = 12345;
        over = false;
        skip = new CancellationTokenSource();
        _ = Show(skip.Token);
    }

    // Runs what the frame's time makes due, then draws; false once the
    // show is over.
    internal static bool Step(uint dtMs)
    {
        if ((Input.Poll() & Input.Buttons.Start) != 0)
        {
            skip.Cancel();
        }

        Frames.Advance(System.TimeSpan.FromMilliseconds(System.Math.Min(dtMs, LongestFrameMs)));
        Draw();
        return !over;
    }

    // A small deterministic generator: the show is the same every run.
    static int Next(int bound)
    {
        seed = seed * 1664525 + 1013904223;
        return (int)((seed >> 8) % (uint)bound);
    }

    static async Task Show(CancellationToken token)
    {
        try
        {
            for (int volley = 1; volley <= 3; volley++)
            {
                var launches = new List<Task>();
                for (int rocket = 0; rocket < volley; rocket++)
                {
                    launches.Add(Launch(40 + Next(Width - 80), rocket * 250));
                }

                await Task.WhenAll(launches);
                await Task.Delay(300, token);
            }
        }
        catch (System.OperationCanceledException)
        {
            // Start: straight to the finale.
        }

        await Task.WhenAll(Launch(Width / 4, 0), Launch(Width / 2, 150), Launch(Width * 3 / 4, 300));
        await Task.Delay(500);
        over = true;
    }

    static async Task Launch(int x, int delayMs)
    {
        await Task.Delay(delayMs);
        var rocket = new Rocket { X = x, Y = Height };
        rockets.Add(rocket);
        float peak = 40 + Next(80);
        while (rocket.Y > peak)
        {
            rocket.Y -= 5;
            await Frames.NextFrame();
        }

        rockets.Remove(rocket);
        await Burst(rocket.X, rocket.Y, Palette[Next(Palette.Length)]);
    }

    // Sparks fly out, fall and fade, a step a frame, until the last is
    // gone.
    static async Task Burst(float x, float y, Gfx.Color color)
    {
        var mine = new List<Spark>();
        const int Count = 20;
        for (int index = 0; index < Count; index++)
        {
            float angle = index * 2 * System.MathF.PI / Count;
            float speed = 1.5f + Next(100) / 50f;
            var spark = new Spark
            {
                X = x,
                Y = y,
                VelocityX = System.MathF.Cos(angle) * speed,
                VelocityY = System.MathF.Sin(angle) * speed,
                Life = 30 + Next(20),
                Color = color,
            };
            mine.Add(spark);
            sparks.Add(spark);
        }

        while (mine.Count > 0)
        {
            await Frames.NextFrame();
            for (int index = mine.Count - 1; index >= 0; index--)
            {
                var spark = mine[index];
                spark.X += spark.VelocityX;
                spark.Y += spark.VelocityY;
                spark.VelocityY += 0.05f;
                if (--spark.Life == 0)
                {
                    mine.RemoveAt(index);
                    sparks.Remove(spark);
                }
            }
        }
    }

    static void Draw()
    {
        Gfx.Clear(Sky);
        foreach (var rocket in rockets)
        {
            Gfx.FillRect(new Gfx.Rect((int)rocket.X, (int)rocket.Y, 2, 4), Trail);
        }

        foreach (var spark in sparks)
        {
            uint size = spark.Life > 20 ? 2u : 1u;
            Gfx.FillRect(new Gfx.Rect((int)spark.X, (int)spark.Y, size, size), spark.Color);
        }
    }
}
