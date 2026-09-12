// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Collections.Generic;

/// <summary>
/// What every event type is: the generator makes each <c>[Event]</c>
/// struct implement this, where it is declared, so the world's event
/// members take events and nothing else.
/// </summary>
public interface IEvent<TSelf>
    where TSelf : struct, IEvent<TSelf>
{
}

/// <summary>
/// An event type's channel in every world of the program, by
/// <see cref="World.Index"/>, as <see cref="Storage{T}"/> keeps a
/// component's storage.
/// </summary>
public static class Channels<T>
    where T : struct, IEvent<T>
{
    internal static Slot[] slots;

    /// <summary>A world's channel of the event type (which its schedule makes).</summary>
    public static Events<T> Of(World world) => slots[world.index].Channel;

    internal static void Put(int world, Events<T> channel)
    {
        if (slots is null || world >= slots.Length)
        {
            var grown = new Slot[Math.Max(world + 1, slots is null ? 4 : slots.Length * 2)];
            for (int index = 0; slots is not null && index < slots.Length; index++)
            {
                grown[index] = slots[index];
            }

            slots = grown;
        }

        slots[world].Channel = channel;
    }

    internal static void Release(int world) => slots[world].Channel = null;

    internal struct Slot
    {
        public Events<T> Channel;
    }
}

/// <summary>A channel of events, whatever their type, as the world ages them.</summary>
public abstract class EventChannel
{
    /// <summary>Ends a tick: what was sent the tick before is dropped.</summary>
    public abstract void Update();
}

/// <summary>
/// The events of one type: what was sent this tick and the tick before.
/// Every event has a sequence number, so each <see cref="EventReader{T}"/>
/// (one per system that reads them) sees each event once, whether it runs
/// before the sender in the tick (it sees them next tick) or after.
/// </summary>
public sealed class Events<T> : EventChannel
    where T : struct
{
    private List<T> older = new List<T>();
    private List<T> newer = new List<T>();
    private long olderStart;
    private long newerStart;

    /// <summary>The sequence number the next event will have.</summary>
    public long Next => newerStart + newer.Count;

    /// <summary>The sequence number of the oldest event still kept.</summary>
    public long Oldest => olderStart;

    public void Send(T value) => newer.Add(value);

    /// <summary>The event with a sequence number from <see cref="Oldest"/> to <see cref="Next"/>.</summary>
    public T At(long sequence) => sequence < newerStart
        ? older[(int)(sequence - olderStart)]
        : newer[(int)(sequence - newerStart)];

    public override void Update()
    {
        var recycled = older;
        recycled.Clear();
        older = newer;
        olderStart = newerStart;
        newer = recycled;
        newerStart = olderStart + older.Count;
    }

    /// <summary>A reader of its own: it sees what is sent from now on.</summary>
    public EventReader<T> Reader() => new EventReader<T>(this);

    public EventWriter<T> Writer() => new EventWriter<T>(this);
}

/// <summary>A system's view of an event type: what it has not seen yet.</summary>
public sealed class EventReader<T>
    where T : struct
{
    private readonly Events<T> events;
    private long cursor;

    public EventReader(Events<T> events)
    {
        this.events = events;
        cursor = events.Next;
    }

    /// <summary>Whether anything is waiting to be read.</summary>
    public bool IsEmpty => events.Next <= cursor;

    /// <summary>What was sent since the last read, oldest first; reading marks it seen.</summary>
    public Enumerator Read()
    {
        long start = cursor < events.Oldest ? events.Oldest : cursor;
        long end = events.Next;
        cursor = end;
        return new Enumerator(events, start, end);
    }

    /// <summary>Marks everything sent so far seen, unread.</summary>
    public void Clear() => cursor = events.Next;

    public struct Enumerator
    {
        private readonly Events<T> events;
        private readonly long end;
        private long next;
        private T current;

        internal Enumerator(Events<T> events, long start, long end)
        {
            this.events = events;
            this.end = end;
            next = start;
            current = default;
        }

        public T Current => current;

        public Enumerator GetEnumerator() => this;

        public bool MoveNext()
        {
            if (next >= end)
            {
                return false;
            }

            current = events.At(next++);
            return true;
        }
    }
}

/// <summary>A system's way to send an event type.</summary>
public sealed class EventWriter<T>
    where T : struct
{
    private readonly Events<T> events;

    public EventWriter(Events<T> events)
    {
        this.events = events;
    }

    public void Send(T value) => events.Send(value);
}
