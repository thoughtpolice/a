// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Collections.Generic;

/// <summary>What the generator knows about a system, in run order.</summary>
public sealed record SystemInfo(string Name, Phase Phase, int Order, string Reads, string Writes);

/// <summary>
/// A program's schedule: its components' ids, each world's storage,
/// channels, resources and event readers, and its systems' query loops in
/// phase order. Kiln's generator writes one per program
/// (<c>Kiln.Generated.GameSchedule</c>, which <c>World.Create()</c>
/// makes a world with) from the program's declarations and those of the
/// Kiln libraries it references; the world is the engine's, and calls it
/// once per phase. One schedule runs one world.
/// </summary>
public abstract class Schedule
{
    /// <summary>The world it runs.</summary>
    public World World { get; private set; }

    /// <summary>The systems, in the order they run.</summary>
    public abstract IReadOnlyList<SystemInfo> Systems { get; }

    /// <summary>The components' names, by id.</summary>
    public abstract IReadOnlyList<string> ComponentNames { get; }

    internal void AttachTo(World world)
    {
        if (World is not null)
        {
            throw new InvalidOperationException("a schedule runs one world");
        }

        World = world;
        Attach(world);
    }

    /// <summary>Makes a new world's storage, channels, resources and readers.</summary>
    protected abstract void Attach(World world);

    /// <summary>Runs one phase's systems.</summary>
    protected internal abstract void Run(Phase phase);

    /// <summary>Gives a component its id in the program, and the world its storage.</summary>
    protected static void Component<T>(World world, int id, string name)
        where T : struct, IComponent<T>
    {
        Storage<T>.bit = Bit(Storage<T>.bit, Storage<T>.word, id, name);
        Storage<T>.word = World.BitOf(id) >> 6;
        var set = new SparseSet<T>(id);
        var slots = Storage<T>.slots;
        int index = world.index;
        if (slots is null || index >= slots.Length)
        {
            var grown = new Storage<T>.Slot[Math.Max(index + 1, slots is null ? 4 : slots.Length * 2)];
            for (int at = 0; slots is not null && at < slots.Length; at++)
            {
                grown[at] = slots[at];
            }

            Storage<T>.slots = slots = grown;
        }

        slots[index].Set = set;
        world.AddStore(set, Storage<T>.Release);
    }

    /// <summary>Gives a tag (a component without fields, and without storage) its id in the program.</summary>
    protected static void Tag<T>(World world, int id, string name)
        where T : struct, IComponent<T>
    {
        Storage<T>.bit = Bit(Storage<T>.bit, Storage<T>.word, id, name);
        Storage<T>.word = World.BitOf(id) >> 6;
        Storage<T>.tag = true;
    }

    /// <summary>Gives the world a channel of an event type.</summary>
    protected static void Event<T>(World world)
        where T : struct, IEvent<T>
    {
        var channel = new Events<T>();
        Channels<T>.Put(world.index, channel);
        world.AddChannel(channel, Channels<T>.Release);
    }

    // A component's bit, of its word (World.BitOf), which every schedule of
    // the program must give it.
    private static ulong Bit(ulong had, int hadWord, int id, string name)
    {
        int place = World.BitOf(id);
        ulong bit = 1UL << (place & 63);
        if (had != 0 && (had != bit || hadWord != place >> 6))
        {
            throw new InvalidOperationException("component " + name + " has another id already: a program's worlds share one schedule's ids");
        }

        return bit;
    }
}
