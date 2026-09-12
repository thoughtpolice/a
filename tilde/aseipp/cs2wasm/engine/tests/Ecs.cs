// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Kiln's ECS, exercised: components, tags, resources, events, bundles,
// queries, deferred changes, the generated schedule, coroutines in game
// time, several worlds at once, and the gameplay a Kiln library
// (tests/plugin) contributes to the schedule. Each check returns a number
// (a count, or a hash of what it traced); tests/engine.mjs compares every
// one with the CLR's, which runs this file compiled by csc with the same
// generator over the same libraries, and a few with what they must be.
namespace Kiln.Tests;

using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Threading.Tasks;
using Kiln;
using Kiln.Tests.Plugin;

[Component]
internal partial struct Position
{
    public Vector2 Value;
}

[Component]
internal partial struct Velocity
{
    public Vector2 Value;
}

[Component]
internal partial record struct Health(int Current, int Max);

[Component]
internal partial struct Frozen
{
}

[Component]
internal partial struct Enemy
{
}

[Resource]
internal sealed class Trace
{
    public readonly List<string> Lines = new List<string>();

    public void Add(string line) => Lines.Add(line);

    public int Hash()
    {
        uint hash = 2166136261;
        foreach (string line in Lines)
        {
            foreach (char character in line)
            {
                hash = (hash ^ character) * 16777619;
            }

            hash = (hash ^ '\n') * 16777619;
        }

        return unchecked((int)hash);
    }
}

[Resource]
internal sealed class Clock
{
    public float Step = 1f / 60f;
}

[Event]
internal partial struct Damage
{
    public Entity Target;
    public int Amount;
}

[Bundle]
internal partial record struct Mover(Position Position, Velocity Velocity);

internal static partial class Motion
{
    [System(Phase.Update)]
    [Without<Frozen>]
    static void Integrate(ref Position position, in Velocity velocity, Clock clock) =>
        position.Value += velocity.Value * clock.Step * 60f;

    [System(Phase.Update, Order = 1)]
    static void Bounds(Entity self, ref Position position, World world)
    {
        if (position.Value.X > 100)
        {
            world.Despawn(self);
        }
    }
}

internal static partial class Combat
{
    // Sends a point of damage to every enemy each tick: its readers run
    // both before (next tick) and after it (this tick).
    [System(Phase.Update)]
    [With<Enemy>]
    [After("Motion.Integrate")]
    static void Hurt(Entity self, EventWriter<Damage> damage) => damage.Send(new Damage { Target = self, Amount = 1 });

    [System(Phase.PostUpdate)]
    static void Apply(EventReader<Damage> damage, World world, Trace trace)
    {
        foreach (var hit in damage.Read())
        {
            if (world.TryGet<Health>(hit.Target, out var health))
            {
                world.Get<Health>(hit.Target) = health with { Current = health.Current - hit.Amount };
                if (health.Current - hit.Amount <= 0)
                {
                    trace.Add("dies " + hit.Target);
                    world.Despawn(hit.Target);
                }
            }
        }
    }

    [System(Phase.PreUpdate)]
    static void Count(EventReader<Damage> damage, Trace trace)
    {
        int count = 0;
        foreach (var _ in damage.Read())
        {
            count++;
        }

        trace.Add("pre " + count);
    }
}

internal static partial class Order
{
    [System(Phase.Render, Order = 2)]
    static void Last(Trace trace) => trace.Add("render last");

    [System(Phase.Render)]
    [Before(nameof(Middle))]
    static void Zeta(Trace trace) => trace.Add("render zeta");

    [System(Phase.Render)]
    static void Middle(Trace trace) => trace.Add("render middle");

    [System(Phase.Render)]
    static void Alpha(Trace trace) => trace.Add("render alpha");

    [System(Phase.Startup)]
    static void Begin(Trace trace) => trace.Add("startup");

    // Ordered against a system of the Kiln library, reading its event.
    [System(Phase.Update)]
    [After("Spinning.Turn")]
    static void Laps(EventReader<Lap> laps, Trace trace, World world)
    {
        foreach (var lap in laps.Read())
        {
            trace.Add("lap " + lap.Wheel + " of " + lap.Size + " at " + world.Ticks);
        }
    }

    static bool Enabled(Trace trace) => trace.Lines.Count < 6;

    [System(Phase.Render, Order = 3)]
    [RunIf(nameof(Enabled))]
    static void Conditional(Trace trace) => trace.Add("conditional");
}

public static class Checks
{
    static World NewWorld()
    {
        // The CLR's frame loop installs its context on first use; the
        // CoreLib's is current from the start.
        _ = Gameplay.Frames.Count;
        return World.Create();
    }

    // The schedule the generator wrote, as names in run order.
    public static int ScheduleHash()
    {
        var trace = new Trace();
        foreach (var system in NewWorld().Systems)
        {
            trace.Add(system.Phase + " " + system.Name + " r=" + system.Reads + " w=" + system.Writes);
        }

        return trace.Hash();
    }

    public static int SystemCount() => NewWorld().Systems.Count;

    // 1 when the library's Turn runs before the program's Laps, which is
    // ordered after it, in the update phase.
    public static int PluginOrder()
    {
        var names = NewWorld().Systems.Select(system => system.Name).ToList();
        int turn = names.IndexOf("Spinning.Turn");
        int laps = names.IndexOf("Order.Laps");
        return turn >= 0 && laps > turn && NewWorld().Systems[turn].Writes == "Spin" && NewWorld().Systems[turn].Reads == "Wheel" ? 1 : 0;
    }

    // 1 when Zeta runs before Middle, Alpha first among equals, Last and
    // the conditional system after.
    public static int RenderOrder()
    {
        var world = NewWorld();
        world.Render();
        var lines = world.Trace.Lines;
        return lines.Count == 5 && lines[0] == "render alpha" && lines[1] == "render zeta"
               && lines[2] == "render middle" && lines[3] == "render last" && lines[4] == "conditional" ? 1 : 0;
    }

    public static int RunIf()
    {
        var world = NewWorld();
        world.Startup();
        world.Render();
        world.Render();
        return world.Trace.Lines.Count(line => line == "conditional");
    }

    public static int Movement(int ticks)
    {
        var world = NewWorld();
        for (int index = 0; index < 20; index++)
        {
            var entity = world.Spawn(new Mover(
                new Position { Value = new Vector2(index, 0) },
                new Velocity { Value = new Vector2(1 + index % 3, 0.5f) }));
            if (index % 4 == 0)
            {
                world.Add(entity, new Frozen());
            }
        }

        for (int tick = 0; tick < ticks; tick++)
        {
            world.Tick();
        }

        float sum = 0;
        foreach (var entity in world.Query<Position>())
        {
            sum += world.Get<Position>(entity).Value.X * 3 + world.Get<Position>(entity).Value.Y;
        }

        return world.EntityCount * 100000 + (int)sum;
    }

    // Enemies take a point a tick until they die; the others do not.
    public static int Events(int health)
    {
        var world = NewWorld();
        for (int index = 0; index < 6; index++)
        {
            var entity = world.Spawn(new Health(health + index, health + index));
            if (index % 2 == 0)
            {
                world.Add(entity, new Enemy());
            }
        }

        for (int tick = 0; tick < health + 8; tick++)
        {
            world.Tick();
        }

        return world.EntityCount * 1000 + world.Query<Health>().Count() * 100 + world.Trace.Lines.Count(line => line.StartsWith("dies", System.StringComparison.Ordinal)) * 10
               + world.Count<Enemy>();
    }

    public static int EventTrace(int health)
    {
        var world = NewWorld();
        for (int index = 0; index < 3; index++)
        {
            world.Spawn(new Health(health, health)).With(new Enemy());
        }

        for (int tick = 0; tick < health + 2; tick++)
        {
            world.Tick();
        }

        return world.Trace.Hash();
    }

    // Despawning and adding while a query runs is deferred, in order.
    public static int Deferred(int count)
    {
        var world = NewWorld();
        var spawned = new List<Entity>();
        for (int index = 0; index < count; index++)
        {
            spawned.Add(world.Spawn(new Health(index, index)));
        }

        int seen = 0;
        foreach (var entity in world.Query<Health>())
        {
            seen++;
            if (world.Get<Health>(entity).Current % 2 == 0)
            {
                world.Despawn(entity);
                world.Spawn(new Health(-1, -1));
            }
        }

        int negatives = world.Query<Health>().Count(entity => world.Get<Health>(entity).Current < 0);
        bool stale = spawned.Where((entity, index) => index % 2 == 0).Any(world.IsAlive);
        return seen * 10000 + world.EntityCount * 100 + negatives + (stale ? 5000000 : 0);
    }

    // Generations keep a despawned entity from aliasing its slot's reuse.
    public static int Generations()
    {
        var world = NewWorld();
        var first = world.Spawn();
        world.Despawn(first);
        var second = world.Spawn();
        return (world.IsAlive(first) ? 1 : 0) * 100 + (world.IsAlive(second) ? 10 : 0) + (first.Index == second.Index ? 1 : 0);
    }

    public static int Describe()
    {
        var world = NewWorld();
        var entity = world.Spawn(new Mover(default, default));
        world.Add(entity, new Enemy());
        world.Add(entity, new Health(3, 4));
        world.Remove<Velocity>(entity);
        var trace = new Trace();
        trace.Add(world.Describe(entity));
        trace.Add(world.Get<Health>(entity).ToString());
        return trace.Hash();
    }

    // Scripts in game time: a pulse every few ticks, a script that ends
    // when its entity is despawned, and WhenAll over two of them.
    public static int Scripts(int ticks)
    {
        var world = NewWorld();
        var trace = world.Trace;
        var pulser = world.Spawn(new Health(0, 0));
        world.Scheduler.Start(pulser, async script =>
        {
            for (int pulse = 0; ; pulse++)
            {
                await script.Ticks(3);
                script.Get<Health>() = new Health(pulse, pulse);
                trace.Add("pulse " + pulse + " at " + script.World.Ticks);
            }
        });
        var doomed = world.Spawn();
        world.Scheduler.Start(doomed, async script =>
        {
            await script.Seconds(0.1f);
            trace.Add("doomed wakes at " + script.World.Ticks);
            script.World.Despawn(script.Self);
            await script.NextTick();
            trace.Add("never");
        });
        _ = Sequence(world, trace);
        for (int tick = 0; tick < ticks; tick++)
        {
            world.Tick();
        }

        trace.Add("running " + world.Scheduler.Running + " pending " + world.Scheduler.Pending);
        return trace.Hash();
    }

    static async Task Sequence(World world, Trace trace)
    {
        await Task.WhenAll(Wait(world, trace, "a", 5), Wait(world, trace, "b", 2));
        trace.Add("both at " + world.Ticks);
        await world.Scheduler.Until(() => world.Ticks >= 12);
        trace.Add("until at " + world.Ticks);
    }

    static async Task Wait(World world, Trace trace, string name, int ticks)
    {
        await world.Scheduler.Ticks(ticks);
        trace.Add(name + " at " + world.Ticks);
    }

    public static int ScriptLines(int ticks)
    {
        var world = NewWorld();
        var trace = world.Trace;
        _ = Sequence(world, trace);
        for (int tick = 0; tick < ticks; tick++)
        {
            world.Tick();
        }

        return trace.Lines.Count;
    }

    // The Kiln library's wheels turn and lap, its tag stops one, its run
    // condition stops counting, and the program reads its laps.
    public static int Plugin(int ticks)
    {
        var world = NewWorld();
        var trace = world.Trace;
        var slow = Spinning.Launch(world, 1, 3);
        var fast = Spinning.Launch(world, 4, 5);
        var stopped = Spinning.Launch(world, 7, 2);
        world.Add(stopped, new Stopped());
        world.Add(fast, new Health(2, 2));
        for (int tick = 0; tick < ticks; tick++)
        {
            world.Tick();
            if (tick == 3)
            {
                world.Remove<Stopped>(stopped);
                world.Despawn(slow);
            }
        }

        var odometer = world.Odometer;
        trace.Add("odometer " + odometer.Total + " runs " + odometer.Runs + " launched " + odometer.Launched);
        trace.Add(world.Describe(fast) + " " + world.Get<Spin>(fast).Turns + " " + world.Count<Wheel>() + " " + world.Count<Stopped>());
        return trace.Hash();
    }

    public static int PluginLaps(int ticks)
    {
        var world = NewWorld();
        Spinning.Launch(world, 3, 4);
        for (int tick = 0; tick < ticks; tick++)
        {
            world.Tick();
        }

        return world.Trace.Lines.Count(line => line.StartsWith("lap ", System.StringComparison.Ordinal));
    }

    // Worlds side by side: each its own entities, storage, events,
    // resources and schedule; a disposed world's index goes to the next
    // world, which starts empty.
    public static int Worlds(int ticks)
    {
        var first = NewWorld();
        var second = NewWorld();
        var trace = new Trace();
        for (int index = 0; index < 4; index++)
        {
            first.Spawn(new Mover(new Position { Value = new Vector2(index, 0) }, new Velocity { Value = new Vector2(1, 0) }));
        }

        second.Spawn(new Health(3, 3)).With(new Enemy());
        Spinning.Launch(second, 2, 3);
        first.Clock.Step = 2f / 60f;
        for (int tick = 0; tick < ticks; tick++)
        {
            first.Tick();
            second.Tick();
        }

        float sum = 0;
        foreach (var entity in first.Query<Position>())
        {
            sum += first.Get<Position>(entity).Value.X;
        }

        trace.Add("first " + first.EntityCount + " " + first.Count<Position>() + " " + first.Count<Health>() + " " + sum);
        trace.Add("second " + second.EntityCount + " " + second.Count<Position>() + " " + second.Count<Health>() + " " + second.Odometer.Total + " " + second.Trace.Lines.Count);
        trace.Add("apart " + (first.Trace != second.Trace) + " " + (first.Index != second.Index) + " " + first.Odometer.Total + " " + first.Trace.Lines.Count);
        int reused = second.Index;
        second.Dispose();
        var third = NewWorld();
        trace.Add("third " + (third.Index == reused) + " " + third.EntityCount + " " + third.Count<Health>() + " " + third.Odometer.Total + " " + second.Index);
        var spawned = third.Spawn(new Health(1, 1));
        third.Tick();
        trace.Add(third.Describe(spawned) + " " + first.Count<Health>());
        return trace.Hash();
    }

    // Kiln's own system ages the world's particles every tick, once the
    // world has some.
    public static int WorldSparks(int ticks)
    {
        var world = NewWorld();
        world.Tick();
        world.Particles = new Particles(32);
        world.Particles.Burst(new Rng(5), Vector2.Zero, 10, 0.5f, 1f, 3, 8, new byte[] { 1, 2 });
        for (int tick = 0; tick < ticks; tick++)
        {
            world.Tick();
        }

        return world.Particles.Count;
    }

    // A resource is the world's property and its Resource<T>(), set and
    // replaced; one never set is null.
    public static int Resources()
    {
        var world = NewWorld();
        var trace = new Trace();
        var made = world.Trace;
        world.Trace = trace;
        int result = (made is not null ? 1 : 0) + (world.Resource<Trace>() == trace ? 10 : 0) + (world.Trace == trace ? 100 : 0);
        world.SetResource<Trace>(null);
        result += world.Trace is null ? 1000 : 0;
        result += world.Resource<string>() is null ? 10000 : 0;
        return result;
    }
}
