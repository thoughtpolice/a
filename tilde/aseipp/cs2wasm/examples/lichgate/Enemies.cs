// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The Lich's servants. Each is a bundle of components and a script: an
// async method the engine's scheduler resumes in game time, owned by the
// creature, so it simply stops when the creature dies.
namespace Lichgate;

using System;
using System.Collections.Generic;
using System.Numerics;
using System.Threading.Tasks;
using Kiln;

internal static class Bestiary
{
    private sealed record Breed(Sprite[] Frames, int Health, float Radius, int Contact, int Score, int Rate, float Friction, int Lift = 0);

    private static readonly Dictionary<Kind, Breed> Breeds = new Dictionary<Kind, Breed>
    {
        [Kind.Bat] = new Breed(Art.Bat, 5, 5, 1, 10, 6, 0.96f, 3),
        [Kind.Slime] = new Breed(Art.Slime, 12, 6, 1, 15, 0, 0.9f),
        [Kind.SmallSlime] = new Breed(Art.SmallSlime, 4, 4, 1, 5, 0, 0.9f),
        [Kind.Skeleton] = new Breed(Art.Skeleton, 9, 5, 1, 20, 10, 0.8f),
        [Kind.Eye] = new Breed(Art.Eye, 16, 6, 1, 25, 0, 0.7f),
        [Kind.Boar] = new Breed(Art.Boar, 20, 7, 2, 30, 8, 0.82f),
        [Kind.Wisp] = new Breed(Art.Wisp, 3, 4, 2, 15, 7, 0.98f, 2),
        [Kind.Lich] = new Breed(Art.Lich, 300, 11, 2, 1000, 20, 0.85f),
    };

    /// <summary>What a floor's waves draw from, and how heavily.</summary>
    public static (Kind Kind, int Weight)[] Roster(int floor) => floor switch
    {
        1 => new[] { (Kind.Bat, 4), (Kind.Slime, 3), (Kind.Skeleton, 2) },
        2 => new[] { (Kind.Bat, 3), (Kind.Slime, 3), (Kind.Skeleton, 3), (Kind.Eye, 2), (Kind.Boar, 2) },
        _ => new[] { (Kind.Bat, 3), (Kind.Slime, 2), (Kind.Skeleton, 3), (Kind.Eye, 2), (Kind.Boar, 3), (Kind.Wisp, 3) },
    };

    /// <summary>
    /// A creature at a point. Unless <paramref name="immediate"/>, it
    /// fades in first (a Spawning tag, harmless and unhurt) and starts its
    /// script when solid.
    /// </summary>
    public static Entity Spawn(World world, Kind kind, Vector2 at, int floor, bool immediate = false)
    {
        var breed = Breeds[kind];
        int health = kind == Kind.Lich ? breed.Health + 110 * (floor - 1) : breed.Health + breed.Health * (floor - 1) * 2 / 5;
        var entity = world.Spawn(new Mob(
            new Position { Value = at },
            new Velocity { Friction = breed.Friction },
            new Body { Radius = breed.Radius, Layer = Layers.Enemy, Solid = kind != Kind.Bat && kind != Kind.Wisp && kind != Kind.Lich },
            new Health { Current = health, Max = health },
            new Look { Frames = breed.Frames, Rate = breed.Rate, Lift = breed.Lift },
            new Enemy { Kind = kind, Contact = breed.Contact, Score = breed.Score }));
        if (kind == Kind.Lich)
        {
            world.Add(entity, new Boss());
        }

        world.Scheduler.Start(entity, script => Life(script, kind, immediate), kind.ToString());
        return entity;
    }

    private static async Task Life(Script script, Kind kind, bool immediate)
    {
        if (!immediate)
        {
            script.World.Add(script.Self, new Spawning());
            var effects = script.World.Effects;
            for (int tick = 0; tick < 36; tick++)
            {
                if (tick % 6 == 0)
                {
                    effects.Particles.Burst(effects.Rng, script.Get<Position>().Value, 3, 0.3f, 0.9f, 10, 18, Colors.Soul, -0.02f);
                }

                await script.NextTick();
            }

            script.World.Remove<Spawning>(script.Self);
        }

        await (kind switch
        {
            Kind.Bat => Flutter(script),
            Kind.Slime or Kind.SmallSlime => Hop(script, kind == Kind.SmallSlime),
            Kind.Skeleton => Snipe(script),
            Kind.Eye => Gaze(script),
            Kind.Boar => Charge(script),
            Kind.Wisp => Drift(script),
            _ => Lich.Rule(script),
        });
    }

    public static Vector2 Hero(World world) =>
        world.IsAlive(world.Crawl.Hero) ? world.Get<Position>(world.Crawl.Hero).Value : new Vector2(Dungeon.Width * 8, Dungeon.Height * 8);

    private static Vector2 Toward(Script script, Vector2 target)
    {
        var offset = target - script.Get<Position>().Value;
        return offset.LengthSquared() < 0.01f ? Vector2.Zero : Vector2.Normalize(offset);
    }

    // A direction turned by an angle: System.Numerics' rotation matrix.
    private static Vector2 Turn(Vector2 direction, float angle) =>
        Vector2.TransformNormal(direction, Matrix3x2.CreateRotation(angle));

    /// <summary>A hostile shot.</summary>
    public static void Projectile(World world, Vector2 from, Vector2 direction, float speed, Sprite sprite, int damage = 1)
    {
        world.Spawn(new Shot(
            new Position { Value = from + direction * 5 },
            new Velocity { Value = direction * speed, Friction = 1 },
            new Body { Radius = 2.5f, Layer = 0 },
            new Bullet { Damage = damage, Life = 240, Friendly = false, Trail = null },
            new Look { Frames = new[] { sprite } }));
    }

    /// <summary>A ring of shots.</summary>
    public static void Ring(World world, Vector2 from, int count, float speed, float offset)
    {
        for (int index = 0; index < count; index++)
        {
            float angle = offset + index * MathF.Tau / count;
            Projectile(world, from, new Vector2(MathF.Cos(angle), MathF.Sin(angle)), speed, Art.Orb);
        }

        Game.Play(Sounds.EnemyShoot);
    }

    // Bats: darts at the hero, askew, and a rest between.
    private static async Task Flutter(Script script)
    {
        var rng = script.World.Effects.Rng;
        while (true)
        {
            var aim = Turn(Toward(script, Hero(script.World)), rng.Range(-0.9f, 0.9f));
            script.Get<Velocity>().Value = aim * rng.Range(1.1f, 1.6f);
            await script.Ticks(rng.Range(16, 30));
            script.Get<Velocity>().Value *= 0.3f;
            await script.Ticks(rng.Range(6, 14));
        }
    }

    // Slimes: squat, then leap at the hero.
    private static async Task Hop(Script script, bool small)
    {
        var rng = script.World.Effects.Rng;
        while (true)
        {
            await script.Ticks(rng.Range(small ? 20 : 35, small ? 45 : 70));
            script.Get<Look>().Frame = 1;
            await script.Ticks(10);
            script.Get<Look>().Frame = 0;
            script.Get<Velocity>().Value = Toward(script, Hero(script.World)) * (small ? 3.2f : 2.6f);
            await script.Ticks(18);
        }
    }

    // Skeletons: keep their distance, draw, and loose an arrow.
    private static async Task Snipe(Script script)
    {
        var world = script.World;
        var rng = world.Effects.Rng;
        while (true)
        {
            for (int step = 0; step < 50; step++)
            {
                var hero = Hero(world);
                float distance = Vector2.Distance(hero, script.Get<Position>().Value);
                var away = Toward(script, hero) * (distance < 80 ? -0.7f : distance > 110 ? 0.7f : 0);
                script.Get<Velocity>().Value = away + Turn(Toward(script, hero), MathF.PI / 2) * 0.35f;
                await script.NextTick();
            }

            script.Get<Velocity>().Value = Vector2.Zero;
            script.Get<Look>().Remap = Colors.Pale;
            await script.Ticks(22);
            script.Get<Look>().Remap = null;
            var aim = Toward(script, Hero(world));
            Projectile(world, script.Get<Position>().Value, aim, 2.4f, Art.Arrow);
            Game.Play(Sounds.EnemyShoot);
            await script.Ticks(rng.Range(20, 40));
        }
    }

    // Eyes: blink, then rings of orbs, each a little turned.
    private static async Task Gaze(Script script)
    {
        var world = script.World;
        var rng = world.Effects.Rng;
        float offset = rng.Range(0, MathF.Tau);
        while (true)
        {
            script.Get<Look>().Frame = 1;
            await script.Ticks(rng.Range(60, 100));
            script.Get<Look>().Frame = 0;
            await script.Ticks(15);
            for (int burst = 0; burst < 3; burst++)
            {
                Ring(world, script.Get<Position>().Value, 8, 1.3f, offset);
                offset += 0.2f;
                await script.Ticks(18);
            }
        }
    }

    // Boars: glare, paw the ground, and charge until a wall stops them.
    private static async Task Charge(Script script)
    {
        var world = script.World;
        var rng = world.Effects.Rng;
        while (true)
        {
            await script.Ticks(rng.Range(40, 70));
            var aim = Toward(script, Hero(world));
            script.Get<Look>().Remap = Colors.Cursed;
            Game.Play(Sounds.Charge);
            var origin = script.Get<Position>().Value;
            for (int tick = 0; tick < 30; tick++)
            {
                script.Get<Position>().Value = origin + new Vector2(tick % 2 == 0 ? 1 : -1, 0);
                await script.NextTick();
            }

            script.Get<Position>().Value = origin;
            script.Get<Velocity>().Friction = 1;
            script.Get<Velocity>().Value = aim * 3.6f;
            for (int tick = 0; tick < 100; tick++)
            {
                await script.NextTick();
                if (script.Get<Velocity>().Value.LengthSquared() < 1)
                {
                    break;
                }

                world.Effects.Particles.Emit(script.Get<Position>().Value + new Vector2(0, 5), Vector2.Zero, 12, Colors.Dust);
            }

            script.Get<Velocity>().Friction = 0.82f;
            script.Get<Look>().Remap = null;
            if (script.Get<Velocity>().Value.LengthSquared() < 1)
            {
                Game.Play(Sounds.Thud);
                world.Effects.Kick(0.3f);
                world.Effects.Particles.Burst(rng, script.Get<Position>().Value, 12, 0.5f, 1.5f, 10, 20, Colors.Dust);
                script.Get<Velocity>().Value = Vector2.Zero;
                await script.Ticks(50);
            }
        }
    }

    // Wisps: drift closer and closer, and burst beside the hero.
    private static async Task Drift(Script script)
    {
        var world = script.World;
        while (true)
        {
            var hero = Hero(world);
            ref var velocity = ref script.Get<Velocity>().Value;
            velocity += Toward(script, hero) * 0.07f;
            if (velocity.Length() > 1.1f)
            {
                velocity = Vector2.Normalize(velocity) * 1.1f;
            }

            if (Vector2.Distance(hero, script.Get<Position>().Value) < 16)
            {
                Ring(world, script.Get<Position>().Value, 6, 1.6f, 0);
                world.Effects.Particles.Burst(world.Effects.Rng, script.Get<Position>().Value, 16, 0.5f, 2f, 10, 20, Colors.Magic);
                world.Despawn(script.Self);
                return;
            }

            await script.NextTick();
        }
    }
}
