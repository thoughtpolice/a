// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The game's rules, as Kiln systems: each static method's parameters are
// its query, and the generator orders them into their phases.
namespace Lichgate;

using System;
using System.Numerics;
using Kiln;

/// <summary>What the room is doing: its doors, and whether it is being fought.</summary>
[Resource]
internal sealed class Arena
{
    public Room Room;
    public bool Locked;

    /// <summary>Waves still to come in this room.</summary>
    public int Pending;

    /// <summary>The door the hero is walking through, if any.</summary>
    public Side? Leaving;

    /// <summary>The entity the room's encounter script belongs to.</summary>
    public Entity Director;

    public bool Blocked(Vector2 point)
    {
        if (Room is null)
        {
            return false;
        }

        return Room.Blocked((int)MathF.Floor(point.X / Tiles.Size), (int)MathF.Floor(point.Y / Tiles.Size), Locked);
    }

    /// <summary>Whether a circle at a point overlaps a blocked cell.</summary>
    public bool Blocked(Vector2 center, float radius)
    {
        int left = (int)MathF.Floor((center.X - radius) / Tiles.Size);
        int right = (int)MathF.Floor((center.X + radius) / Tiles.Size);
        int top = (int)MathF.Floor((center.Y - radius) / Tiles.Size);
        int bottom = (int)MathF.Floor((center.Y + radius) / Tiles.Size);
        for (int y = top; y <= bottom; y++)
        {
            for (int x = left; x <= right; x++)
            {
                if (Room.Blocked(x, y, Locked))
                {
                    return true;
                }
            }
        }

        return false;
    }
}

internal static partial class Movement
{
    // The hero goes where the intent says, dashing when asked, and fires.
    [System(Phase.PreUpdate)]
    [With<Hero>]
    static void Steer(Entity self, ref Velocity velocity, in Position position, Intent intent, Crawl run, World world, Effects effects)
    {
        var stats = run.Stats;
        if (run.DashCooldown > 0)
        {
            run.DashCooldown--;
        }

        if (intent.Dash && run.DashCooldown == 0 && intent.Move != Vector2.Zero)
        {
            run.DashTimer = 9;
            run.DashCooldown = 45;
            run.DashDirection = Vector2.Normalize(intent.Move);
            world.Get<Health>(self).Invulnerable = Math.Max(world.Get<Health>(self).Invulnerable, 12);
            Game.Play(Sounds.Dash);
        }

        if (run.DashTimer > 0)
        {
            run.DashTimer--;
            velocity.Value = run.DashDirection * stats.Speed * 3.2f;
            effects.Particles.Emit(position.Value + effects.Rng.Direction() * 3, Vector2.Zero, 14, Colors.Magic);
        }
        else
        {
            velocity.Value = Interpolate.Damp(velocity.Value, intent.Move * stats.Speed, 18f, 1f / 60f);
        }

        if (intent.Aim != Vector2.Zero)
        {
            run.Facing = Vector2.Normalize(intent.Aim);
        }
        else if (intent.Move != Vector2.Zero)
        {
            run.Facing = Vector2.Normalize(intent.Move);
        }

        if (run.Cooldown > 0)
        {
            run.Cooldown--;
        }

        if (intent.Fire && run.Cooldown == 0 && intent.Aim != Vector2.Zero)
        {
            run.Cooldown = stats.FireDelay;
            Fire(world, position.Value, Vector2.Normalize(intent.Aim), stats);
        }
    }

    // A volley: the shots fanned around the aim.
    static void Fire(World world, Vector2 from, Vector2 aim, Stats stats)
    {
        float angle = MathF.Atan2(aim.Y, aim.X);
        float spread = 0.16f;
        for (int shot = 0; shot < stats.Shots; shot++)
        {
            float turn = angle + (shot - (stats.Shots - 1) / 2f) * spread;
            var direction = new Vector2(MathF.Cos(turn), MathF.Sin(turn));
            world.Spawn(new Shot(
                new Position { Value = from + direction * 6 },
                new Velocity { Value = direction * stats.ShotSpeed, Friction = 1 },
                new Body { Radius = 2.5f, Layer = 0 },
                new Bullet { Damage = stats.Damage, Life = stats.Range, Friendly = true, Pierce = stats.Pierce, Homing = stats.Homing, Trail = Colors.Magic },
                new Look { Frames = new[] { Art.Bolt } }));
        }

        Game.Play(Sounds.Shoot);
    }

    // Everything that moves, stopped by the walls and rocks if solid.
    [System(Phase.Update)]
    static void Move(ref Position position, ref Velocity velocity, in Body body, Arena arena)
    {
        var next = position.Value + velocity.Value;
        if (!body.Solid)
        {
            position.Value = next;
        }
        else
        {
            // Each axis on its own, so a wall slides rather than sticks.
            var sideways = new Vector2(next.X, position.Value.Y);
            if (arena.Blocked(sideways, body.Radius))
            {
                velocity.Value.X = 0;
            }
            else
            {
                position.Value = sideways;
            }

            var vertical = new Vector2(position.Value.X, next.Y);
            if (arena.Blocked(vertical, body.Radius))
            {
                velocity.Value.Y = 0;
            }
            else
            {
                position.Value = vertical;
            }
        }

        if (velocity.Friction > 0)
        {
            velocity.Value *= velocity.Friction;
        }
    }
}

internal static partial class Shots
{
    // Bullets age, seek, and break on walls.
    [System(Phase.Update, Order = 1)]
    static void Fly(Entity self, ref Bullet bullet, ref Velocity velocity, in Position position, Arena arena, World world, Effects effects)
    {
        if (--bullet.Life <= 0 || arena.Blocked(position.Value))
        {
            effects.Particles.Burst(effects.Rng, position.Value, 4, 0.3f, 1.2f, 6, 12, bullet.Trail ?? Colors.Dust);
            world.Despawn(self);
            return;
        }

        if (bullet.Homing > 0 && bullet.Friendly)
        {
            var target = Nearest(world, position.Value, 80);
            if (!target.IsNone)
            {
                float speed = velocity.Value.Length();
                var toward = Vector2.Normalize(world.Get<Position>(target).Value - position.Value);
                var turned = Vector2.Normalize(velocity.Value + toward * speed * bullet.Homing);
                velocity.Value = turned * speed;
            }
        }

        if (bullet.Trail is not null && (bullet.Life & 1) == 0)
        {
            effects.Particles.Emit(position.Value, velocity.Value * 0.1f, 8, bullet.Trail);
        }
    }

    // The nearest enemy that can be hurt, within a reach.
    public static Entity Nearest(World world, Vector2 from, float reach)
    {
        var best = Entity.None;
        float bestDistance = reach * reach;
        foreach (var enemy in world.Query<Enemy, Position>().Without<Spawning>())
        {
            float distance = Vector2.DistanceSquared(world.Get<Position>(enemy).Value, from);
            if (distance < bestDistance)
            {
                bestDistance = distance;
                best = enemy;
            }
        }

        return best;
    }
}

internal static partial class Contact
{
    // The broad phase, rebuilt after everything has moved.
    [System(Phase.Update, Order = 2)]
    [Without<Bullet>]
    static void Index(Entity self, in Position position, in Body body, Space space)
    {
        space.Hash.Insert(self, position.Value, body.Radius, body.Layer);
    }

    [System(Phase.Update, Order = 1)]
    static void Clear(Space space) => space.Hash.Clear();

    // Bullets against what they may hurt.
    [System(Phase.Update, Order = 3)]
    static void Strike(Entity self, ref Bullet bullet, in Position position, in Velocity velocity, in Body body, Space space, World world, EventWriter<Hit> hits)
    {
        space.Hash.Query(position.Value, body.Radius, space.Found, bullet.Friendly ? Layers.Enemy : Layers.Hero);
        foreach (var target in space.Found)
        {
            if (world.Has<Spawning>(target))
            {
                continue;
            }

            var push = velocity.Value.LengthSquared() > 0 ? Vector2.Normalize(velocity.Value) : Vector2.Zero;
            hits.Send(new Hit { Target = target, Damage = bullet.Damage, Push = push * (bullet.Friendly ? 1.6f : 2.5f), Friendly = bullet.Friendly });
            if (--bullet.Pierce < 0)
            {
                world.Despawn(self);
                return;
            }
        }
    }

    // Enemies hurt the hero by touching.
    [System(Phase.Update, Order = 3)]
    [Without<Spawning>]
    static void Touch(in Enemy enemy, in Position position, in Body body, Space space, EventWriter<Hit> hits, World world)
    {
        if (enemy.Contact <= 0)
        {
            return;
        }

        space.Hash.Query(position.Value, body.Radius, space.Found, Layers.Hero);
        foreach (var hero in space.Found)
        {
            var push = world.Get<Position>(hero).Value - position.Value;
            hits.Send(new Hit
            {
                Target = hero,
                Damage = enemy.Contact,
                Push = push == Vector2.Zero ? Vector2.Zero : Vector2.Normalize(push) * 3,
            });
        }
    }

    // The hero picks up what it walks over.
    [System(Phase.Update, Order = 3)]
    [With<Hero>]
    static void Collect(in Position position, in Body body, Space space, World world, EventWriter<Collected> collected)
    {
        space.Hash.Query(position.Value, body.Radius + 3, space.Found, Layers.Pickup);
        foreach (var found in space.Found)
        {
            if (world.TryGet<Pickup>(found, out var pickup))
            {
                if (pickup.Age < 20)
                {
                    continue;
                }

                collected.Send(new Collected { Drop = pickup.Drop, Value = pickup.Value, At = world.Get<Position>(found).Value });
                world.Despawn(found);
            }
        }
    }
}

internal static partial class Claims
{
    // Stepping onto an altar takes its relic; the others crumble.
    [System(Phase.Update, Order = 4)]
    [With<Hero>]
    static void Claim(Entity self, in Position position, in Body body, Space space, World world, Crawl run, Effects effects)
    {
        space.Hash.Query(position.Value, body.Radius + 2, space.Found, Layers.Pickup | Layers.Gate);
        foreach (var found in space.Found)
        {
            if (world.Has<Gate>(found))
            {
                run.Descending = true;
                return;
            }

            if (!world.TryGet<Offer>(found, out var offer))
            {
                continue;
            }

            var upgrade = offer.Upgrade;
            run.Upgrades.Add(upgrade);
            int before = run.Stats.MaxHealth;
            upgrade.Apply(run.Stats);
            ref var health = ref world.Get<Health>(self);
            health.Max = run.Stats.MaxHealth;
            health.Current = Math.Clamp(health.Current + Math.Max(0, run.Stats.MaxHealth - before), 1, health.Max);
            effects.Popups.Add(new Popup { Text = upgrade.Name, At = position.Value + new Vector2(-upgrade.Name.Length * 2, -16), Life = 90, Color = Colors.Yellow });
            effects.Particles.Burst(effects.Rng, world.Get<Position>(found).Value, 30, 0.5f, 2.5f, 20, 40, Colors.Gilt, -0.02f);
            Game.Play(Sounds.Relic);
            Game.Log("relic " + upgrade.Name + " on floor " + run.Floor);
            foreach (var altar in world.Query<Offer>())
            {
                effects.Particles.Burst(effects.Rng, world.Get<Position>(altar).Value, 10, 0.3f, 1f, 10, 20, Colors.Dust);
                world.Despawn(altar);
            }

            return;
        }
    }
}

internal static partial class Harm
{
    // Hits land: health, a flash, a shove, and for a killing blow a death.
    [System(Phase.PostUpdate)]
    static void Wound(EventReader<Hit> hits, World world, Crawl run, Effects effects, EventWriter<Died> deaths)
    {
        foreach (var hit in hits.Read())
        {
            if (!world.IsAlive(hit.Target) || !world.Has<Health>(hit.Target))
            {
                continue;
            }

            ref var health = ref world.Get<Health>(hit.Target);
            if (health.Invulnerable > 0 || health.Current <= 0)
            {
                continue;
            }

            health.Current -= hit.Damage;
            health.Flash = 6;
            var at = world.Get<Position>(hit.Target).Value;
            if (world.Has<Velocity>(hit.Target) && !world.Has<Boss>(hit.Target))
            {
                world.Get<Velocity>(hit.Target).Value += hit.Push;
            }

            if (world.Has<Hero>(hit.Target))
            {
                health.Invulnerable = 60;
                effects.Kick(0.55f);
                effects.Freeze = 6;
                effects.Particles.Burst(effects.Rng, at, 14, 0.5f, 2f, 10, 24, Colors.Blood, 0.05f);
                Game.Play(Sounds.Hurt);
                Game.Flash(1.6f);
                run.Combo = 0;
                if (health.Current <= 0)
                {
                    run.Over = true;
                }

                continue;
            }

            effects.Particles.Burst(effects.Rng, at, 3, 0.4f, 1.4f, 6, 14, Colors.Bone);
            Game.Play(Sounds.Hit);
            if (health.Current <= 0)
            {
                var enemy = world.Get<Enemy>(hit.Target);
                deaths.Send(new Died { Entity = hit.Target, Kind = enemy.Kind, At = at, Score = enemy.Score });
            }
        }
    }

    // The dead: sparks, score and combo, drops, and what a death leaves.
    [System(Phase.PostUpdate, Order = 1)]
    static void Bury(EventReader<Died> deaths, World world, Crawl run, Effects effects)
    {
        foreach (var death in deaths.Read())
        {
            if (!world.IsAlive(death.Entity))
            {
                continue;
            }

            world.Despawn(death.Entity);
            run.Kills++;
            run.Combo++;
            run.ComboTimer = 90;
            int multiplier = Math.Min(8, 1 + run.Combo / 4);
            int points = death.Score * multiplier;
            run.Score += points;
            effects.Popups.Add(new Popup { Text = multiplier > 1 ? points + " X" + multiplier : points.ToString(), At = death.At, Life = 40, Color = multiplier > 1 ? Colors.Yellow : Colors.Frost });
            effects.Particles.Burst(effects.Rng, death.At, 18, 0.6f, 2.4f, 12, 30, death.Kind is Kind.Slime or Kind.SmallSlime ? Colors.Ichor : Colors.Soul, 0.03f, 2);
            effects.Kick(0.18f);
            Game.Play(Sounds.Kill);
            if (death.Kind == Kind.Lich)
            {
                // Its servants and its shots die with it.
                foreach (var servant in world.Query<Enemy>())
                {
                    effects.Particles.Burst(effects.Rng, world.Get<Position>(servant).Value, 12, 0.5f, 2f, 10, 24, Colors.Soul);
                    world.Despawn(servant);
                }

                foreach (var shot in world.Query<Bullet>())
                {
                    world.Despawn(shot);
                }

                effects.Particles.Burst(effects.Rng, death.At, 90, 0.5f, 4f, 30, 70, Colors.Fire, 0.02f, 2);
                effects.Particles.Burst(effects.Rng, death.At, 60, 0.3f, 3f, 40, 80, Colors.Soul, -0.02f, 1);
                effects.Kick(1);
                effects.Freeze = 20;
                Game.Play(Sounds.Boom);
                Game.Flash(2);
                Game.Log("the lich falls on floor " + run.Floor + " score=" + run.Score);
            }

            if (death.Kind == Kind.Slime)
            {
                for (int split = -1; split <= 1; split += 2)
                {
                    Bestiary.Spawn(world, Kind.SmallSlime, death.At + new Vector2(split * 6, 0), run.Floor, immediate: true);
                }
            }

            var rng = effects.Rng;
            if (run.Stats.Siphon > 0 && rng.Chance(0.1f * run.Stats.Siphon))
            {
                ref var health = ref world.Get<Health>(run.Hero);
                health.Current = Math.Min(health.Max, health.Current + 1);
                Game.Play(Sounds.Heal);
            }

            if (rng.Chance(0.07f))
            {
                Loot.Drop(world, Drop.Heart, death.At, 2);
            }
            else if (rng.Chance(0.35f))
            {
                Loot.Drop(world, Drop.Gem, death.At, 25);
            }
        }
    }

    // What the hero picks up takes effect.
    [System(Phase.PostUpdate)]
    static void Gain(EventReader<Collected> collected, World world, Crawl run, Effects effects)
    {
        foreach (var item in collected.Read())
        {
            switch (item.Drop)
            {
                case Drop.Heart:
                    ref var health = ref world.Get<Health>(run.Hero);
                    health.Current = Math.Min(health.Max, health.Current + item.Value);
                    effects.Particles.Burst(effects.Rng, item.At, 10, 0.4f, 1.2f, 16, 28, Colors.Blood, -0.03f);
                    Game.Play(Sounds.Heal);
                    break;
                case Drop.Gem:
                    run.Score += item.Value;
                    effects.Popups.Add(new Popup { Text = "+" + item.Value, At = item.At, Life = 30, Color = Colors.Cyan });
                    Game.Play(Sounds.Pickup);
                    break;
                case Drop.Relic:
                    Game.Play(Sounds.Relic);
                    break;
            }
        }
    }
}

internal static partial class Upkeep
{
    [System(Phase.PreUpdate)]
    static void Recover(ref Health health)
    {
        if (health.Flash > 0)
        {
            health.Flash--;
        }

        if (health.Invulnerable > 0)
        {
            health.Invulnerable--;
        }
    }

    [System(Phase.PreUpdate)]
    static void Age(ref Pickup pickup)
    {
        pickup.Age++;
    }

    [System(Phase.PreUpdate)]
    static void Combo(Crawl run)
    {
        if (run.ComboTimer > 0 && --run.ComboTimer == 0)
        {
            run.Combo = 0;
        }
    }

    [System(Phase.PostUpdate)]
    static void Animate(ref Look look, in Velocity velocity, World world)
    {
        if (look.Rate > 0 && world.Ticks % look.Rate == 0)
        {
            look.Frame++;
        }

        if (velocity.Value.X < -0.05f)
        {
            look.FlipX = true;
        }
        else if (velocity.Value.X > 0.05f)
        {
            look.FlipX = false;
        }
    }

    // The camera's shake, from the trauma that hits add, fading away (the
    // sparks age in Kiln's own Particles.Advance, just before).
    [System(Phase.PostUpdate)]
    static void Settle(Effects effects)
    {
        float shake = effects.Trauma * effects.Trauma * 5;
        effects.Shake = new Vector2(effects.Rng.Range(-shake, shake), effects.Rng.Range(-shake, shake));
        effects.Trauma = Math.Max(0, effects.Trauma - 0.025f);
        for (int index = effects.Popups.Count - 1; index >= 0; index--)
        {
            var popup = effects.Popups[index];
            popup.At.Y -= 0.4f;
            if (--popup.Life <= 0)
            {
                effects.Popups.RemoveAt(index);
            }
        }
    }

    // A room is won when its last enemy falls: the doors open.
    [System(Phase.PostUpdate, Order = 2)]
    static void Conquer(Arena arena, Crawl run, World world, Effects effects)
    {
        if (!arena.Locked || arena.Pending > 0 || world.Count<Enemy>() > 0)
        {
            return;
        }

        arena.Locked = false;
        arena.Room.Cleared = true;
        run.RoomsCleared++;
        run.Score += 50 * run.Floor;
        effects.Popups.Add(new Popup { Text = "CLEARED", At = new Vector2(Dungeon.Width * 8 - 14, Dungeon.Height * 8), Life = 60, Color = Colors.Lime });
        Game.Play(Sounds.Unlock);
        Game.Log("room " + arena.Room.X + "," + arena.Room.Y + " cleared on floor " + run.Floor + " score=" + run.Score + " kills=" + run.Kills);
        if (arena.Room.Type == RoomType.Boss)
        {
            Loot.Gate(world, new Vector2(Dungeon.Width * 8, Dungeon.Height * 8 - 20));
            Loot.Altars(world, run, effects.Rng, 3, new Vector2(Dungeon.Width * 8, Dungeon.Height * 8 + 34));
        }
        else if (effects.Rng.Chance(0.3f))
        {
            Loot.Drop(world, Drop.Heart, new Vector2(Dungeon.Width * 8, Dungeon.Height * 8), 2);
        }
    }

    // Walking out through an open door.
    [System(Phase.PostUpdate, Order = 3)]
    [With<Hero>]
    static void Leave(in Position position, Arena arena)
    {
        if (arena.Locked || arena.Leaving is not null)
        {
            return;
        }

        var point = position.Value;
        const float Edge = 7;
        if (point.Y < Edge && arena.Room.Doors[(int)Side.North])
        {
            arena.Leaving = Side.North;
        }
        else if (point.Y > Dungeon.Height * Tiles.Size - Edge && arena.Room.Doors[(int)Side.South])
        {
            arena.Leaving = Side.South;
        }
        else if (point.X < Edge && arena.Room.Doors[(int)Side.West])
        {
            arena.Leaving = Side.West;
        }
        else if (point.X > Dungeon.Width * Tiles.Size - Edge && arena.Room.Doors[(int)Side.East])
        {
            arena.Leaving = Side.East;
        }
    }
}

/// <summary>What falls: hearts and gems, relics on altars, the stairs down.</summary>
internal static class Loot
{
    public static Entity Drop(World world, Drop drop, Vector2 at, int value)
    {
        var sprite = drop == Lichgate.Drop.Heart ? Art.Heart : Art.Gem;
        var entity = world.Spawn();
        world.Add(entity, new Position { Value = at });
        world.Add(entity, new Velocity { Value = new Vector2(0, -0.8f), Friction = 0.85f });
        world.Add(entity, new Body { Radius = 4, Layer = Layers.Pickup, Solid = true });
        world.Add(entity, new Pickup { Drop = drop, Value = value });
        world.Add(entity, new Look { Frames = new[] { sprite } });
        return entity;
    }

    public static void Altars(World world, Crawl run, Rng rng, int count, Vector2 center)
    {
        var offers = Upgrade.Draw(rng, run.Upgrades, count);
        for (int index = 0; index < offers.Count; index++)
        {
            var at = center + new Vector2((index - (offers.Count - 1) / 2f) * 48, 0);
            var altar = world.Spawn();
            world.Add(altar, new Position { Value = at });
            world.Add(altar, new Body { Radius = 7, Layer = Layers.Pickup });
            world.Add(altar, new Offer { Upgrade = offers[index] });
            world.Add(altar, new Look { Frames = new[] { Art.Relic } });
        }
    }

    public static void Gate(World world, Vector2 at)
    {
        var gate = world.Spawn();
        world.Add(gate, new Position { Value = at });
        world.Add(gate, new Body { Radius = 8, Layer = Layers.Gate });
        world.Add(gate, new Gate());
        world.Add(gate, new Look { Frames = new[] { Art.Portal } });
    }
}
