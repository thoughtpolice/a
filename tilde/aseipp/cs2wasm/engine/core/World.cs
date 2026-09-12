// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Collections;
using System.Collections.Generic;

/// <summary>
/// The world: entities, their components and the systems over them. The
/// world is the engine's and knows no program's types: a program's
/// schedule (<see cref="Kiln.Schedule"/>, which Kiln's generator writes)
/// gives it its components' storage, its event channels and resources,
/// and runs its systems, and the world reaches a component's storage
/// through <see cref="Storage{T}"/>, a table per component type indexed by
/// the world's <see cref="Index"/>.
/// </summary>
/// <remarks>
/// While a system or a query is iterating, spawning, despawning, adding and
/// removing are deferred until it is done, in the order they were asked
/// for, so an iteration never sees its storage move under it. A spawned
/// entity exists at once (its components arrive when the iteration ends).
/// </remarks>
public sealed class World : IDisposable
{
    // An entity's components are a bitset of MaskWords words: the first
    // word's top bit marks the entity alive, and a component's bit is its
    // id's place counting from the first word's bottom, past that bit
    // (BitOf). A program of at most 63 components has one word per entity,
    // as if the bitset were one ulong.
    private const ulong AliveBit = 1UL << 63;

    // The indices of disposed worlds, for new ones.
    private static readonly Stack<int> freeIndices = new Stack<int>();
    private static int indices;

    // This world's index into the per-type tables; -1 once disposed.
    internal int index;

    private readonly Schedule schedule;

    // The words of each entity's bitset, and each component's storage by its
    // bit's place (none for a tag).
    internal readonly int words;
    private readonly ComponentStore[] stores;

    // The event channels, and what drops each table entry the world has
    // (arrays rather than lists, which would be instantiations of their own).
    private EventChannel[] channels = new EventChannel[4];
    private int channelCount;
    private Action<int>[] releases = new Action<int>[16];
    private int releaseCount;
    private ulong[] masks;
    private int[] generations = new int[64];
    private readonly Stack<int> free = new Stack<int>();
    private readonly List<Action> deferred = new List<Action>();
    private int slots;
    private int iterating;

    /// <summary>
    /// A world run by a schedule, which makes its storage, channels and
    /// resources now (a program's generated one: <c>World.Create()</c>).
    /// </summary>
    public World(Schedule schedule)
    {
        index = freeIndices.Count > 0 ? freeIndices.Pop() : indices++;
        this.schedule = schedule;
        words = WordsFor(schedule.ComponentNames.Count);
        stores = new ComponentStore[words * 64];
        masks = new ulong[generations.Length * words];
        Scheduler = new Scheduler(this);
        schedule.AttachTo(this);
    }

    /// <summary>The world's index into the per-type tables (<see cref="Storage{T}"/>), reused once it is disposed.</summary>
    public int Index => index;

    /// <summary>The schedule that runs the world.</summary>
    public Schedule Schedule => schedule;

    /// <summary>The systems, in the order they run.</summary>
    public IReadOnlyList<SystemInfo> Systems => schedule.Systems;

    /// <summary>The number of living entities.</summary>
    public int EntityCount { get; private set; }

    /// <summary>The slots used so far: every entity's index is below it.</summary>
    public int SlotCount => slots;

    /// <summary>
    /// Each slot's components, <see cref="MaskWords"/> words of them per slot
    /// (a slot's first word at <c>slot * MaskWords</c>), a bit per component
    /// (<see cref="BitOf"/>) and the first word's top bit for a living
    /// entity; all zero for a free slot.
    /// </summary>
    public ulong[] Masks => masks;

    /// <summary>The words of each slot's components in <see cref="Masks"/>: one for a program of at most 63 components.</summary>
    public int MaskWords => words;

    /// <summary>
    /// The place of a component's bit in an entity's words: its id, past the
    /// first word's top bit, which marks the entity alive. The bit is
    /// <c>1UL &lt;&lt; (place &amp; 63)</c> of word <c>place &gt;&gt; 6</c>.
    /// </summary>
    public static int BitOf(int id) => id < 63 ? id : id + 1;

    /// <summary>The id of the component whose bit is at a place (<see cref="BitOf"/>).</summary>
    public static int IdOf(int place) => place < 63 ? place : place - 1;

    /// <summary>The words of a bitset of this many components and the alive bit.</summary>
    public static int WordsFor(int components) => (components + 64) >> 6;

    /// <summary>The fixed steps ticked so far.</summary>
    public long Ticks { get; private set; }

    /// <summary>The game-time coroutines of the world (<see cref="Kiln.Scheduler"/>).</summary>
    public Scheduler Scheduler { get; }

    /// <summary>Whether a system or query is iterating, so changes are deferred.</summary>
    public bool IsIterating => iterating > 0;

    /// <summary>Runs the startup systems.</summary>
    public void Startup() => schedule.Run(Phase.Startup);

    /// <summary>
    /// One fixed step: the coroutines that are due, then the pre-update,
    /// update and post-update systems, then the events age a tick.
    /// </summary>
    public void Tick()
    {
        Ticks++;
        Scheduler.Tick();
        schedule.Run(Phase.PreUpdate);
        schedule.Run(Phase.Update);
        schedule.Run(Phase.PostUpdate);
        for (int channel = 0; channel < channelCount; channel++)
        {
            channels[channel].Update();
        }
    }

    /// <summary>Runs the render systems.</summary>
    public void Render() => schedule.Run(Phase.Render);

    /// <summary>Runs one phase's systems, for a program that schedules phases itself.</summary>
    public void Run(Phase phase) => schedule.Run(phase);

    /// <summary>
    /// Gives the world's index back for a new world, and drops its storage,
    /// channels and resources from the per-type tables. A world that is
    /// never disposed keeps them until the program ends.
    /// </summary>
    public void Dispose()
    {
        if (index < 0)
        {
            return;
        }

        for (int release = 0; release < releaseCount; release++)
        {
            releases[release](index);
            releases[release] = null;
        }

        releaseCount = 0;
        freeIndices.Push(index);
        index = -1;
    }

    // MARK: Registration, by the schedule

    internal void AddStore(ComponentStore store, Action<int> release)
    {
        stores[BitOf(store.Id)] = store;
        AddRelease(release);
    }

    internal void AddChannel(EventChannel channel, Action<int> release)
    {
        if (channelCount == channels.Length)
        {
            Array.Resize(ref channels, channelCount * 2);
        }

        channels[channelCount++] = channel;
        AddRelease(release);
    }

    private void AddRelease(Action<int> release)
    {
        if (releaseCount == releases.Length)
        {
            Array.Resize(ref releases, releaseCount * 2);
        }

        releases[releaseCount++] = release;
    }

    // MARK: Resources

    /// <summary>The world's resource of a type, or null.</summary>
    public T Resource<T>()
        where T : class
    {
        var values = Resources<T>.values;
        return values is not null && (uint)index < (uint)values.Length ? values[index] : null;
    }

    /// <summary>Sets (or with null, removes) the world's resource of a type.</summary>
    public void SetResource<T>(T value)
        where T : class
    {
        if (index < 0)
        {
            throw new InvalidOperationException("the world is disposed");
        }

        var values = Resources<T>.values;
        if (values is null || index >= values.Length)
        {
            var grown = new T[Math.Max(index + 1, values is null ? 4 : values.Length * 2)];
            for (int at = 0; values is not null && at < values.Length; at++)
            {
                grown[at] = values[at];
            }

            Resources<T>.values = values = grown;
        }

        if (values[index] is null && value is not null)
        {
            AddRelease(Resources<T>.Release);
        }

        values[index] = value;
    }

    // MARK: Entities

    public Entity Spawn()
    {
        int slot;
        if (free.Count > 0)
        {
            slot = free.Pop();
        }
        else
        {
            slot = slots++;
            if (slot == generations.Length)
            {
                Array.Resize(ref masks, slot * 2 * words);
                Array.Resize(ref generations, slot * 2);
            }
        }

        if (generations[slot] == 0)
        {
            generations[slot] = 1;
        }

        masks[slot * words] = AliveBit;
        EntityCount++;
        return new Entity(slot, generations[slot]);
    }

    public bool IsAlive(Entity entity) =>
        entity.Generation != 0 && (uint)entity.Index < (uint)slots
        && generations[entity.Index] == entity.Generation && masks[entity.Index * words] != 0;

    /// <summary>The living entity in a slot.</summary>
    public Entity EntityAt(int slot) => new Entity(slot, generations[slot]);

    public void Despawn(Entity entity)
    {
        if (!IsAlive(entity))
        {
            return;
        }

        if (iterating > 0)
        {
            deferred.Add(() => Despawn(entity));
            return;
        }

        int slot = entity.Index;
        int at = slot * words;
        // Its components' storage, lowest id first.
        for (ulong rest = masks[at] & ~AliveBit; rest != 0; rest &= rest - 1)
        {
            stores[System.Numerics.BitOperations.TrailingZeroCount(rest)]?.RemoveSlot(slot);
        }

        masks[at] = 0;
        if (words > 1)
        {
            RemoveWords(slot, at);
        }

        int next = generations[slot] + 1;
        generations[slot] = next <= 0 ? 1 : next;
        free.Push(slot);
        EntityCount--;
        Scheduler.Forget(entity);
    }

    // The components of a despawned entity's words past the first.
    private void RemoveWords(int slot, int at)
    {
        for (int word = 1; word < words; word++)
        {
            for (ulong rest = masks[at + word]; rest != 0; rest &= rest - 1)
            {
                stores[word * 64 + System.Numerics.BitOperations.TrailingZeroCount(rest)]?.RemoveSlot(slot);
            }

            masks[at + word] = 0;
        }
    }

    /// <summary>Despawns every entity.</summary>
    public void Clear()
    {
        for (int slot = 0; slot < slots; slot++)
        {
            if (masks[slot * words] != 0)
            {
                Despawn(EntityAt(slot));
            }
        }
    }

    /// <summary>The names of an entity's components, for debugging.</summary>
    public string Describe(Entity entity)
    {
        if (!IsAlive(entity))
        {
            return entity + " (dead)";
        }

        var names = new List<string>();
        var known = schedule.ComponentNames;
        int at = entity.Index * words;
        for (int id = 0; id < known.Count; id++)
        {
            int place = BitOf(id);
            if ((masks[at + (place >> 6)] & (1UL << (place & 63))) != 0)
            {
                names.Add(known[id]);
            }
        }

        return entity + " [" + string.Join(", ", names) + "]";
    }

    // MARK: Components

    public bool Has<T>(Entity entity)
        where T : struct, IComponent<T> =>
        IsAlive(entity) && (masks[entity.Index * words + Storage<T>.word] & Storage<T>.bit) != 0;

    /// <summary>The world's storage of a component (not a tag's).</summary>
    public SparseSet<T> Store<T>()
        where T : struct, IComponent<T> => Storage<T>.slots[index].Set;

    /// <summary>The entity's component, which it must have.</summary>
    public ref T Get<T>(Entity entity)
        where T : struct, IComponent<T>
    {
        if (!Has<T>(entity))
        {
            throw Refuse(entity, Storage<T>.bit, Storage<T>.word, tag: false);
        }

        if (Storage<T>.tag)
        {
            throw Refuse(entity, Storage<T>.bit, Storage<T>.word, tag: true);
        }

        return ref Storage<T>.slots[index].Set.Of(entity.Index);
    }

    public bool TryGet<T>(Entity entity, out T value)
        where T : struct, IComponent<T>
    {
        if (Has<T>(entity) && !Storage<T>.tag)
        {
            value = Storage<T>.slots[index].Set.Of(entity.Index);
            return true;
        }

        value = default;
        return false;
    }

    /// <summary>Adds the component, or replaces the one the entity has.</summary>
    public void Add<T>(Entity entity, T value = default)
        where T : struct, IComponent<T>
    {
        if (!IsAlive(entity))
        {
            return;
        }

        if (iterating > 0)
        {
            deferred.Add(() => Add(entity, value));
            return;
        }

        ulong bit = Bit<T>();
        int slot = entity.Index;
        int at = slot * words + Storage<T>.word;
        bool present = (masks[at] & bit) != 0;
        if (!Storage<T>.tag)
        {
            Storage<T>.slots[index].Set.Set(slot, value, present);
        }

        masks[at] |= bit;
    }

    public void Remove<T>(Entity entity)
        where T : struct, IComponent<T>
    {
        if (!Has<T>(entity))
        {
            return;
        }

        if (iterating > 0)
        {
            deferred.Add(() => Remove<T>(entity));
            return;
        }

        int slot = entity.Index;
        if (!Storage<T>.tag)
        {
            Storage<T>.slots[index].Set.RemoveSlot(slot);
        }

        masks[slot * words + Storage<T>.word] &= ~Storage<T>.bit;
    }

    /// <summary>A new entity with one component; <c>With</c> adds more.</summary>
    public EntityBuilder Spawn<T>(T value)
        where T : struct, IComponent<T>
    {
        var entity = Spawn();
        Add(entity, value);
        return new EntityBuilder(this, entity);
    }

    /// <summary>The number of living entities with the component.</summary>
    public int Count<T>()
        where T : struct, IComponent<T>
    {
        if (!Storage<T>.tag)
        {
            return Storage<T>.slots[index].Set.Count;
        }

        int count = 0;
        ulong bit = Bit<T>();
        int word = Storage<T>.word;
        for (int slot = 0; slot < slots; slot++)
        {
            if ((masks[slot * words + word] & bit) != 0)
            {
                count++;
            }
        }

        return count;
    }

    // Why an entity's component cannot be had: the entity has none, or it
    // is a tag.
    private InvalidOperationException Refuse(Entity entity, ulong bit, int word, bool tag)
    {
        string name = bit == 0
            ? "such component"
            : schedule.ComponentNames[IdOf(word * 64 + System.Numerics.BitOperations.TrailingZeroCount(bit))];
        return new InvalidOperationException(tag ? name + " is a tag, which has no value" : Describe(entity) + " has no " + name);
    }

    // A component's bit (of its word), which it has once its schedule has
    // made a world.
    private static ulong Bit<T>()
        where T : struct, IComponent<T>
    {
        ulong bit = Storage<T>.bit;
        return bit != 0 ? bit : throw Unscheduled();
    }

    private static InvalidOperationException Unscheduled() =>
        new InvalidOperationException("a component that is not the program's schedule's: is its declaration seen by Kiln's generator?");

    // MARK: Events

    /// <summary>Sends an event, which every reader of its type sees once.</summary>
    public void Send<T>(T value)
        where T : struct, IEvent<T> => Channels<T>.slots[index].Channel.Send(value);

    /// <summary>A reader of an event type, which sees what is sent from now on.</summary>
    public EventReader<T> Reader<T>()
        where T : struct, IEvent<T> => Channels<T>.slots[index].Channel.Reader();

    /// <summary>A writer of an event type.</summary>
    public EventWriter<T> Writer<T>()
        where T : struct, IEvent<T> => Channels<T>.slots[index].Channel.Writer();

    // MARK: Iteration

    /// <summary>Defers structural changes until the matching <see cref="EndIteration"/>.</summary>
    public void BeginIteration() => iterating++;

    /// <summary>Applies the deferred changes once the outermost iteration ends.</summary>
    public void EndIteration()
    {
        if (--iterating > 0 || deferred.Count == 0)
        {
            return;
        }

        // A deferred change can defer others only while something iterates,
        // which nothing does now; those it makes run at once.
        for (int index = 0; index < deferred.Count; index++)
        {
            deferred[index]();
        }

        deferred.Clear();
    }

    /// <summary>The entities with <typeparamref name="T1"/>.</summary>
    public Query Query<T1>()
        where T1 : struct, IComponent<T1>
    {
        ulong bit = Bit<T1>();
        var driver = Smallest(null, Driver<T1>());
        return Storage<T1>.word == 0
            ? new Query(this, bit, 0, null, driver)
            : Kiln.Query.Of(this, driver, bit, Storage<T1>.word, 0, 0, 0, 0);
    }

    /// <summary>The entities with both components.</summary>
    public Query Query<T1, T2>()
        where T1 : struct, IComponent<T1>
        where T2 : struct, IComponent<T2>
    {
        ulong first = Bit<T1>();
        ulong second = Bit<T2>();
        var driver = Smallest(Smallest(null, Driver<T1>()), Driver<T2>());
        return (Storage<T1>.word | Storage<T2>.word) == 0
            ? new Query(this, first | second, 0, null, driver)
            : Kiln.Query.Of(this, driver, first, Storage<T1>.word, second, Storage<T2>.word, 0, 0);
    }

    /// <summary>The entities with all three components.</summary>
    public Query Query<T1, T2, T3>()
        where T1 : struct, IComponent<T1>
        where T2 : struct, IComponent<T2>
        where T3 : struct, IComponent<T3>
    {
        ulong first = Bit<T1>();
        ulong second = Bit<T2>();
        ulong third = Bit<T3>();
        var driver = Smallest(Smallest(Smallest(null, Driver<T1>()), Driver<T2>()), Driver<T3>());
        return (Storage<T1>.word | Storage<T2>.word | Storage<T3>.word) == 0
            ? new Query(this, first | second | third, 0, null, driver)
            : Kiln.Query.Of(this, driver, first, Storage<T1>.word, second, Storage<T2>.word, third, Storage<T3>.word);
    }

    private ComponentStore Driver<T>()
        where T : struct, IComponent<T> => Storage<T>.tag ? null : Storage<T>.slots[index].Set;

    private static ComponentStore Smallest(ComponentStore current, ComponentStore candidate) =>
        candidate is null ? current : current is null || candidate.Count < current.Count ? candidate : current;
}

/// <summary>A resource type's value in every world of the program, by <see cref="World.Index"/>.</summary>
internal static class Resources<T>
    where T : class
{
    internal static T[] values;

    internal static void Release(int world) => values[world] = null;
}

/// <summary>A spawned entity, and a fluent way to add its components.</summary>
public readonly struct EntityBuilder
{
    private readonly World world;

    public EntityBuilder(World world, Entity entity)
    {
        this.world = world;
        Entity = entity;
    }

    public Entity Entity { get; }

    public EntityBuilder With<T>(T value = default)
        where T : struct, IComponent<T>
    {
        world.Add(Entity, value);
        return this;
    }

    public static implicit operator Entity(EntityBuilder builder) => builder.Entity;
}

/// <summary>
/// The entities that have every component of a mask and none of another,
/// walked through the smallest storage among them (or every slot when they
/// are all tags). The world defers changes while one is being enumerated,
/// so it is safe to despawn what it yields.
/// </summary>
public sealed class Query : IEnumerable<Entity>
{
    private readonly World world;

    // The components required and excluded, as an entity's words have them
    // (World.Masks): the first word's bits, and each later word's required
    // and excluded bits in pairs from the second word, or null when the
    // query has no component past the first word (as in any program of at
    // most 63 components).
    private readonly ulong required;
    private readonly ulong excluded;
    private readonly ulong[] rest;
    private readonly ComponentStore driver;

    internal Query(World world, ulong required, ulong excluded, ulong[] rest, ComponentStore driver)
    {
        this.world = world;
        this.required = required;
        this.excluded = excluded;
        this.rest = rest;
        this.driver = driver;
    }

    // A query of up to three components (a bit of zero is none) some of
    // which are past the first word.
    internal static Query Of(World world, ComponentStore driver, ulong first, int firstWord, ulong second, int secondWord, ulong third, int thirdWord)
    {
        ulong required = 0;
        var rest = new ulong[2 * (world.words - 1)];
        required |= Put(rest, first, firstWord, 0);
        required |= Put(rest, second, secondWord, 0);
        required |= Put(rest, third, thirdWord, 0);
        return new Query(world, required, 0, rest, driver);
    }

    // Puts a bit in a later word's required (0) or excluded (1) bits, and
    // returns it if it is the first word's instead.
    private static ulong Put(ulong[] rest, ulong bit, int word, int excluded)
    {
        if (word == 0)
        {
            return bit;
        }

        rest[2 * (word - 1) + excluded] |= bit;
        return 0;
    }

    /// <summary>The same query, without the entities that have <typeparamref name="T"/>.</summary>
    public Query Without<T>()
        where T : struct, IComponent<T> =>
        Storage<T>.word == 0
            ? new Query(world, required, excluded | Storage<T>.bit, rest, driver)
            : Excluding(Storage<T>.bit, Storage<T>.word);

    // The same query, without a component past the first word.
    private Query Excluding(ulong bit, int word)
    {
        var more = new ulong[2 * (world.words - 1)];
        for (int index = 0; rest is not null && index < rest.Length; index++)
        {
            more[index] = rest[index];
        }

        Put(more, bit, word, 1);
        return new Query(world, required, excluded, more, driver);
    }

    /// <summary>The number of entities it yields.</summary>
    public int Count()
    {
        int count = 0;
        foreach (var _ in this)
        {
            count++;
        }

        return count;
    }

    /// <summary>The first entity it yields, or <see cref="Entity.None"/>.</summary>
    public Entity First()
    {
        foreach (var entity in this)
        {
            return entity;
        }

        return Entity.None;
    }

    public Enumerator GetEnumerator() => new Enumerator(world, required, excluded, rest, driver);

    IEnumerator<Entity> IEnumerable<Entity>.GetEnumerator() => new Boxed(GetEnumerator());

    IEnumerator IEnumerable.GetEnumerator() => new Boxed(GetEnumerator());

    public struct Enumerator : IDisposable
    {
        private readonly World world;
        private readonly ulong required;
        private readonly ulong excluded;
        private readonly ulong[] rest;
        private readonly int words;
        private readonly int[] slots;
        private readonly int count;
        private int index;
        private Entity current;
        private bool open;

        internal Enumerator(World world, ulong required, ulong excluded, ulong[] rest, ComponentStore driver)
        {
            this.world = world;
            this.required = required;
            this.excluded = excluded;
            this.rest = rest;
            words = world.words;
            slots = driver?.Entities;
            count = driver?.Count ?? world.SlotCount;
            index = -1;
            current = default;
            open = true;
            world.BeginIteration();
        }

        public Entity Current => current;

        public bool MoveNext()
        {
            var masks = world.Masks;
            while (++index < count)
            {
                int slot = slots is null ? index : slots[index];
                ulong mask = masks[slot * words];
                if (mask != 0 && (mask & required) == required && (mask & excluded) == 0
                    && (rest is null || MatchesRest(rest, masks, slot * words)))
                {
                    current = world.EntityAt(slot);
                    return true;
                }
            }

            return false;
        }

        public void Dispose()
        {
            if (open)
            {
                open = false;
                world.EndIteration();
            }
        }
    }

    // Whether the words past the first of the slot whose first word is at
    // `at` have the required bits and none of the excluded.
    private static bool MatchesRest(ulong[] rest, ulong[] masks, int at)
    {
        for (int word = 1; 2 * word <= rest.Length; word++)
        {
            ulong mask = masks[at + word];
            ulong required = rest[2 * word - 2];
            if ((mask & required) != required || (mask & rest[2 * word - 1]) != 0)
            {
                return false;
            }
        }

        return true;
    }

    // The enumerator behind the interfaces, for LINQ.
    private sealed class Boxed : IEnumerator<Entity>
    {
        private Enumerator inner;

        public Boxed(Enumerator inner)
        {
            this.inner = inner;
        }

        public Entity Current => inner.Current;

        object IEnumerator.Current => inner.Current;

        public bool MoveNext() => inner.MoveNext();

        public void Reset() => throw new NotSupportedException();

        public void Dispose() => inner.Dispose();
    }
}
