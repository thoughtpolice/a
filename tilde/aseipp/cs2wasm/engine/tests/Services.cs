// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Kiln's services outside the world: the generator, easing and tweens over
// generic math, the spatial hash, the canvas and its sprites and font,
// particles, the synthesizer and the composer, and the saved-data format.
// Every check returns a count or a hash, compared with the CLR's by
// tests/engine.mjs.
namespace Kiln.Tests;

using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using Kiln;

public static class Services
{
    private static int Hash(IEnumerable<int> values)
    {
        uint hash = 2166136261;
        foreach (int value in values)
        {
            hash = (hash ^ (uint)value) * 16777619;
        }

        return unchecked((int)hash);
    }

    private static int Hash(byte[] bytes) => Hash(bytes.Select(value => (int)value));

    public static int Random(int seed)
    {
        var rng = new Rng((ulong)seed);
        var values = new List<int>();
        for (int index = 0; index < 50; index++)
        {
            values.Add((int)rng.Next());
            values.Add(rng.Range(-10, 10));
            values.Add((int)(rng.Float() * 1000000));
        }

        var fork = rng.Fork();
        values.Add(fork.Range(0, 1000));
        var items = Enumerable.Range(0, 20).ToList();
        rng.Shuffle(items);
        values.AddRange(items);
        values.Add(rng.Weighted(new[] { 1, 5, 20, 3 }));
        var direction = rng.Direction();
        values.Add((int)(direction.Length() * 1000));
        return Hash(values);
    }

    // Each curve at eleven points, in float and in double.
    public static int Easing()
    {
        var values = new List<int>();
        for (int step = 0; step <= 10; step++)
        {
            float t = step / 10f;
            double d = step / 10.0;
            values.Add((int)(Ease.InQuad(t) * 10000));
            values.Add((int)(Ease.OutQuad(t) * 10000));
            values.Add((int)(Ease.InOutQuad(t) * 10000));
            values.Add((int)(Ease.OutCubic(t) * 10000));
            values.Add((int)(Ease.OutBack(t) * 10000));
            values.Add((int)(Ease.OutElastic(t) * 10000));
            values.Add((int)(Ease.OutBounce(t) * 10000));
            values.Add((int)(Ease.SmoothStep(t) * 10000));
            values.Add((int)(Ease.OutBack(d) * 10000));
            values.Add((int)(Ease.OutElastic(d) * 10000));
        }

        return Hash(values);
    }

    // An int counting up and a float easing out, a tick at a time.
    public static int Tweens(int ticks)
    {
        var score = new Tween<int>(0, 1250, 30, Ease.OutCubic);
        var scale = new Tween<float>(0.5f, 2f, 20, Ease.OutBack);
        var values = new List<int>();
        for (int tick = 0; tick < ticks; tick++)
        {
            values.Add(score.Step());
            values.Add((int)(scale.Step() * 1000));
            if (tick == 25)
            {
                scale.Retarget(1f, 10);
            }
        }

        values.Add(score.Done ? 1 : 0);
        values.Add(Interpolate.Approach(10, 3, 4));
        values.Add((int)(Interpolate.Inverse(2.0, 6.0, 5.0) * 100));
        values.Add((int)(Interpolate.Damp(0f, 10f, 8f, 1f / 60f) * 1000));
        return Hash(values);
    }

    // Pairs found by the grid against every pair tested directly.
    public static int Collisions(int seed)
    {
        var rng = new Rng((ulong)seed);
        var grid = new SpatialHash(320, 180, 24);
        var world = World.Create();
        var bodies = new List<(Entity Entity, Vector2 Center, float Radius)>();
        for (int index = 0; index < 120; index++)
        {
            var entity = world.Spawn();
            var center = new Vector2(rng.Range(-10f, 330f), rng.Range(-10f, 190f));
            float radius = rng.Range(2f, 14f);
            bodies.Add((entity, center, radius));
            grid.Insert(entity, center, radius, index % 2 == 0 ? 1 : 2);
        }

        int found = 0;
        int expected = 0;
        int mismatches = 0;
        var results = new List<Entity>();
        foreach (var body in bodies)
        {
            grid.Query(body.Center, body.Radius, results);
            found += results.Count;
            var direct = bodies.Where(other => Vector2.Distance(other.Center, body.Center) <= other.Radius + body.Radius).Select(other => other.Entity).ToHashSet();
            expected += direct.Count;
            if (!direct.SetEquals(results))
            {
                mismatches++;
            }
        }

        grid.Query(new Vector2(160, 90), 60, results, 2);
        return mismatches * 1000000 + found * 100 + results.Count;
    }

    // Everything the canvas draws, hashed.
    public static int Drawing()
    {
        var canvas = new Canvas(64, 48);
        canvas.Clear(1);
        canvas.Fill(-4, 3, 20, 7, 2);
        canvas.Rect(10, 10, 30, 20, 3);
        canvas.Line(0, 47, 63, 0, 4);
        canvas.Circle(40, 30, 9, 5);
        canvas.Ring(20, 30, 12, 6);
        var sprite = Sprite.Parse(
            "..12..",
            ".1221.",
            "122221",
            ".1..1.");
        canvas.Draw(sprite, 50, 40);
        canvas.Draw(sprite, 2, 2, flipX: true);
        canvas.Draw(sprite.Outlined(9), 30, 5, solid: 7);
        canvas.CameraX = 10;
        canvas.CameraY = -5;
        canvas.Text("HI 42!", 12, 0, 8);
        canvas.SetClip(0, 0, 32, 24);
        canvas.Circle(20, 10, 30, 11);
        canvas.ResetClip();
        var table = Enumerable.Range(0, 256).Select(value => (byte)(value + 100)).ToArray();
        canvas.Remap(0, 0, 16, 16, table);
        return Hash(canvas.Pixels) ^ canvas.At(20, 20);
    }

    public static int Sparks(int ticks)
    {
        var rng = new Rng(7);
        var particles = new Particles(64);
        var ramp = new byte[] { 9, 8, 7, 6 };
        particles.Burst(rng, new Vector2(32, 24), 40, 0.5f, 2f, 10, 30, ramp, 0.05f);
        particles.Spray(rng, new Vector2(10, 10), new Vector2(1, 0), 0.4f, 40, 1f, 2f, 20, ramp);
        var canvas = new Canvas(64, 48);
        for (int tick = 0; tick < ticks; tick++)
        {
            particles.Update();
        }

        particles.Draw(canvas);
        return Hash(canvas.Pixels) * 31 + particles.Count;
    }

    // A sixth of a second of a song with effects over it, hashed sample by
    // sample (a check is one call, and one call's fuel runs out long before
    // a second of samples).
    public static int Audio(int seed)
    {
        var synth = new Synth
        {
            Music = new Sequencer(Composer.Compose((ulong)seed, "test", seed % 2 == 0)),
        };
        var samples = new short[735 * 2];
        var values = new List<int>();
        for (int frame = 0; frame < 10; frame++)
        {
            if (frame % 4 == 0)
            {
                synth.Play(new Sound(Wave.Square, 880, 220, 0.2f, Duty: 0.25f));
            }

            if (frame == 5)
            {
                synth.Play(new Sound(Wave.Noise, 2000, 200, 0.4f, Volume: 0.8f, Pan: -0.5f));
            }

            synth.Render(samples, 735);
            int sum = 0;
            foreach (short sample in samples)
            {
                sum = sum * 31 + sample;
            }

            values.Add(sum);
        }

        values.Add(synth.Music.Step);
        values.Add(synth.Music.Song.Tempo);
        return Hash(values);
    }

    public static int Song(int seed)
    {
        var song = Composer.Compose((ulong)seed, "test", seed % 3 == 0);
        return Hash(song.Tracks.SelectMany(track => track.Notes).Append(song.Tempo).Append(song.Steps));
    }

    public static int Saved()
    {
        var values = KeyValues.Parse("volume=7\nname = ADA\n\nbroken line\nmuted=1\nunknown=kept\n");
        values.Set("volume", values.GetInt("volume") + 1);
        values.Set("fresh", true);
        values.Set("name", values.Get("name") + "\nX");
        string text = values.Serialize();
        var again = KeyValues.Parse(KeyValues.Decode(KeyValues.Encode(text)));
        return Hash(text.Select(character => (int)character)) + again.Count * 7 + (again.GetBool("muted") ? 1 : 0) + again.GetInt("missing", 42);
    }
}
