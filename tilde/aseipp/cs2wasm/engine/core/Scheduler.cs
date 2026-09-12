// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Collections.Generic;
using System.Threading.Tasks;

/// <summary>
/// Coroutines in game time: tasks that complete after a number of the
/// world's fixed steps, which async code awaits (<c>await
/// scheduler.Seconds(0.5f)</c>). A wait may belong to an entity; when the
/// entity is despawned its waits are dropped, never completed, so the
/// entity's scripts simply stop where they were (their <c>finally</c>
/// blocks do not run). Waits that come due together complete in the order
/// they were made, and their continuations run inside the tick, before
/// the systems: the same order on every engine, the CLR's included.
/// </summary>
public sealed class Scheduler
{
    /// <summary>Fixed steps per second.</summary>
    public const int TicksPerSecond = 60;

    private readonly World world;
    private readonly List<Waiting> waiting = new List<Waiting>();
    private readonly List<Waiting> due = new List<Waiting>();
    private readonly List<(Entity Owner, Task Task, string Name)> scripts = new List<(Entity, Task, string)>();
    private long sequence;

    internal Scheduler(World world)
    {
        this.world = world;
    }

    /// <summary>The ticks so far.</summary>
    public long Now { get; private set; }

    /// <summary>The waits not yet due.</summary>
    public int Pending => waiting.Count;

    /// <summary>The scripts still running.</summary>
    public int Running => scripts.Count;

    public static int TicksIn(float seconds) => Math.Max(1, (int)MathF.Round(seconds * TicksPerSecond));

    /// <summary>Completes after <paramref name="ticks"/> ticks (at least one).</summary>
    public Task Ticks(int ticks, Entity owner = default)
    {
        var source = new TaskCompletionSource();
        waiting.Add(new Waiting(Now + Math.Max(1, ticks), sequence++, owner, source, null));
        return source.Task;
    }

    /// <summary>Completes at the next tick.</summary>
    public Task NextTick(Entity owner = default) => Ticks(1, owner);

    public Task Seconds(float seconds, Entity owner = default) => Ticks(TicksIn(seconds), owner);

    /// <summary>Completes at the first tick when <paramref name="condition"/> holds.</summary>
    public Task Until(Func<bool> condition, Entity owner = default)
    {
        var source = new TaskCompletionSource();
        waiting.Add(new Waiting(Now + 1, sequence++, owner, source, condition));
        return source.Task;
    }

    /// <summary>
    /// Starts a script owned by an entity: it runs until its first wait at
    /// once, and is abandoned when the entity is despawned. An exception
    /// escaping it is thrown again from the tick that finds it.
    /// </summary>
    public void Start(Entity owner, Func<Script, Task> body, string name = "script")
    {
        var task = body(new Script(world, owner));
        if (!task.IsCompleted || task.IsFaulted)
        {
            scripts.Add((owner, task, name));
        }
    }

    // Drops the waits of an entity that was despawned.
    internal void Forget(Entity owner)
    {
        for (int index = waiting.Count - 1; index >= 0; index--)
        {
            if (waiting[index].Owner == owner)
            {
                waiting.RemoveAt(index);
            }
        }
    }

    internal void Tick()
    {
        Now++;
        due.Clear();
        int kept = 0;
        for (int index = 0; index < waiting.Count; index++)
        {
            var wait = waiting[index];
            if (wait.Due <= Now && (wait.Condition is null || wait.Condition()))
            {
                due.Add(wait);
            }
            else
            {
                waiting[kept++] = wait;
            }
        }

        waiting.RemoveRange(kept, waiting.Count - kept);
        if (due.Count > 1)
        {
            due.Sort((left, right) => left.Due != right.Due ? left.Due.CompareTo(right.Due) : left.Sequence.CompareTo(right.Sequence));
        }

        for (int index = 0; index < due.Count; index++)
        {
            var wait = due[index];
            if (wait.Owner.IsNone || world.IsAlive(wait.Owner))
            {
                wait.Source.SetResult();
            }
        }

        for (int index = scripts.Count - 1; index >= 0; index--)
        {
            var (owner, task, name) = scripts[index];
            if (task.IsFaulted)
            {
                scripts.RemoveAt(index);
                var error = task.Exception.InnerException;
                throw new InvalidOperationException("script '" + name + "' of " + owner + " failed: " + error.Message, error);
            }

            if (task.IsCompleted || (!owner.IsNone && !world.IsAlive(owner)))
            {
                scripts.RemoveAt(index);
            }
        }
    }

    private sealed record Waiting(long Due, long Sequence, Entity Owner, TaskCompletionSource Source, Func<bool> Condition);
}

/// <summary>An entity's script: its entity, its world, and waits that belong to it.</summary>
public sealed class Script
{
    public Script(World world, Entity self)
    {
        World = world;
        Self = self;
    }

    public World World { get; }

    public Entity Self { get; }

    public bool Alive => World.IsAlive(Self);

    public Task Ticks(int ticks) => World.Scheduler.Ticks(ticks, Self);

    public Task NextTick() => World.Scheduler.NextTick(Self);

    public Task Seconds(float seconds) => World.Scheduler.Seconds(seconds, Self);

    public Task Until(Func<bool> condition) => World.Scheduler.Until(condition, Self);

    public ref T Get<T>()
        where T : struct, IComponent<T> => ref World.Get<T>(Self);

    public bool Has<T>()
        where T : struct, IComponent<T> => World.Has<T>(Self);
}
