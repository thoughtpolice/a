// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The Lich: three phases by its remaining health, each a script of
// patterns run together with Task.WhenAll (a spiral while it summons, a
// drift while it fires fans), between teleports.
namespace Lichgate;

using System;
using System.Numerics;
using System.Threading.Tasks;
using Kiln;

internal static class Lich
{
    /// <summary>Which phase a health fraction is.</summary>
    public static int Phase(Health health) =>
        health.Current * 3 > health.Max * 2 ? 1 : health.Current * 3 > health.Max ? 2 : 3;

    public static async Task Rule(Script script)
    {
        var world = script.World;
        await script.Ticks(50);
        while (true)
        {
            int phase = Phase(script.Get<Health>());
            await Teleport(script);
            switch (phase)
            {
                case 1:
                    await Task.WhenAll(Fans(script, 4, 5, 0.22f), Hover(script, 110));
                    await Rings(script, 3, 12);
                    break;
                case 2:
                    await Task.WhenAll(Spiral(script, 150, 3, 0.19f), Summon(script, 2));
                    await Fans(script, 3, 7, 0.18f);
                    break;
                default:
                    await Task.WhenAll(Spiral(script, 180, 4, 0.23f), Spiral(script, 180, 2, -0.31f), Fans(script, 5, 5, 0.26f));
                    await Rings(script, 4, 16);
                    break;
            }

            await script.Ticks(phase == 3 ? 20 : 40);
        }
    }

    // Fades out, reappears somewhere away from the hero, fades in.
    private static async Task Teleport(Script script)
    {
        var world = script.World;
        var rng = world.Effects.Rng;
        script.Get<Look>().Remap = Colors.Pale;
        script.Get<Health>().Invulnerable = 40;
        Game.Play(Sounds.Teleport);
        world.Effects.Particles.Burst(rng, script.Get<Position>().Value, 24, 0.5f, 2f, 16, 30, Colors.Soul);
        await script.Ticks(14);
        var hero = Bestiary.Hero(world);
        var spot = hero;
        for (int attempt = 0; attempt < 12 && Vector2.Distance(spot, hero) < 90; attempt++)
        {
            spot = new Vector2(rng.Range(48f, Dungeon.Width * 16 - 48f), rng.Range(40f, Dungeon.Height * 16 - 40f));
        }

        script.Get<Position>().Value = spot;
        world.Effects.Particles.Burst(rng, spot, 24, 0.5f, 2f, 16, 30, Colors.Soul);
        await script.Ticks(14);
        script.Get<Look>().Remap = Phase(script.Get<Health>()) == 3 ? Colors.Cursed : null;
    }

    private static async Task Hover(Script script, int ticks)
    {
        var world = script.World;
        for (int tick = 0; tick < ticks; tick++)
        {
            var offset = Bestiary.Hero(world) - script.Get<Position>().Value;
            var side = new Vector2(-offset.Y, offset.X);
            script.Get<Velocity>().Value = side == Vector2.Zero ? Vector2.Zero : Vector2.Normalize(side) * 0.6f;
            await script.NextTick();
        }

        script.Get<Velocity>().Value = Vector2.Zero;
    }

    // Aimed fans of shots.
    private static async Task Fans(Script script, int volleys, int width, float spread)
    {
        var world = script.World;
        for (int volley = 0; volley < volleys; volley++)
        {
            var from = script.Get<Position>().Value;
            var aim = Bestiary.Hero(world) - from;
            float angle = MathF.Atan2(aim.Y, aim.X);
            for (int shot = 0; shot < width; shot++)
            {
                float turn = angle + (shot - (width - 1) / 2f) * spread;
                Bestiary.Projectile(world, from, new Vector2(MathF.Cos(turn), MathF.Sin(turn)), 1.9f, Art.Orb);
            }

            Game.Play(Sounds.EnemyShoot);
            await script.Ticks(26);
        }
    }

    private static async Task Rings(Script script, int count, int bullets)
    {
        var world = script.World;
        for (int ring = 0; ring < count; ring++)
        {
            Bestiary.Ring(world, script.Get<Position>().Value, bullets, 1.2f + ring * 0.15f, ring * 0.3f);
            await script.Ticks(20);
        }
    }

    // Arms of shots turning as they are fired.
    private static async Task Spiral(Script script, int ticks, int arms, float turn)
    {
        var world = script.World;
        float angle = 0;
        for (int tick = 0; tick < ticks; tick += 5)
        {
            var from = script.Get<Position>().Value;
            for (int arm = 0; arm < arms; arm++)
            {
                float a = angle + arm * MathF.Tau / arms;
                Bestiary.Projectile(world, from, new Vector2(MathF.Cos(a), MathF.Sin(a)), 1.4f, Art.Orb);
            }

            angle += turn;
            await script.Ticks(5);
        }
    }

    // Raises servants at its sides.
    private static async Task Summon(Script script, int count)
    {
        var world = script.World;
        var rng = world.Effects.Rng;
        for (int index = 0; index < count; index++)
        {
            var at = script.Get<Position>().Value + rng.Direction() * 30;
            at = Vector2.Clamp(at, new Vector2(32, 32), new Vector2(Dungeon.Width * 16 - 32, Dungeon.Height * 16 - 32));
            Bestiary.Spawn(world, rng.Chance(0.5f) ? Kind.Skeleton : Kind.Bat, at, world.Crawl.Floor);
            await script.Ticks(40);
        }
    }
}
