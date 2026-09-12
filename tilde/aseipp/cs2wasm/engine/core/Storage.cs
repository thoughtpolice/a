// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;
using System.Numerics;

/// <summary>
/// What every component type is: Kiln's generator makes each
/// <c>[Component]</c> struct implement this, where the struct is declared
/// (a program or a Kiln library), so that the world's generic members
/// (<see cref="World.Get{T}"/>, <see cref="World.Query{T1}"/>) take
/// components and nothing else. Its id, name and storage are the
/// program's, registered by its schedule (<see cref="Storage{T}"/>).
/// </summary>
public interface IComponent<TSelf>
    where TSelf : struct, IComponent<TSelf>
{
}

/// <summary>
/// A component type's storage in every world of the program: its id (the
/// program's schedule assigns them) and its bit in an entity's words, and
/// each world's sparse set,
/// indexed by <see cref="World.Index"/>. A component's storage in a world
/// is a static field load and an array index, without a cast: a
/// <c>Storage&lt;T&gt;</c> is its own class for each component, and the
/// table is an array of structs, which stay exactly typed where arrays of
/// references share one representation.
/// </summary>
public static class Storage<T>
    where T : struct, IComponent<T>
{
    // Set by the program's schedule when it makes a world (none of them
    // has an initializer, which would be code of its own for every
    // component); until then the component has no bit, so no entity has it.
    // Its bit is of the word `word` of an entity's words (World.BitOf).
    internal static ulong bit;
    internal static int word;
    internal static bool tag;

    // Each world's sparse set, by world index; none for a tag.
    internal static Slot[] slots;

    /// <summary>The component's id in this program, or -1 before its schedule has made a world.</summary>
    public static int Id => bit == 0 ? -1 : World.IdOf(word * 64 + BitOperations.TrailingZeroCount(bit));

    /// <summary>Whether it is a tag: a struct with no instance fields, kept in the entity's mask alone.</summary>
    public static bool IsTag => tag;

    /// <summary>A world's storage of the component (not a tag's).</summary>
    public static SparseSet<T> Of(World world) => slots[world.index].Set;

    internal static void Release(int world) => slots[world].Set = null;

    internal struct Slot
    {
        public SparseSet<T> Set;
    }
}

/// <summary>
/// A component's storage, whatever its type: the entities that have it,
/// densely packed, which is what a query walks.
/// </summary>
public abstract class ComponentStore
{
    // Entity slot -> dense index; valid only where the entity's mask has
    // the component's bit, so it is never cleared.
    protected int[] sparse = new int[16];

    protected ComponentStore(int id)
    {
        Id = id;
    }

    public int Id { get; }

    /// <summary>The word of an entity's words (<see cref="World.Masks"/>) that has the component's bit.</summary>
    public int Word => World.BitOf(Id) >> 6;

    /// <summary>The component's bit, in its <see cref="Word"/>.</summary>
    public ulong Bit => 1UL << (World.BitOf(Id) & 63);

    /// <summary>The number of entities with the component.</summary>
    public int Count { get; protected set; }

    /// <summary>The slots of the entities with the component, in dense order.</summary>
    public int[] Entities { get; protected set; } = new int[16];

    /// <summary>The dense index of a slot that has the component.</summary>
    public int IndexOf(int slot) => sparse[slot];

    internal abstract void RemoveSlot(int slot);
}

/// <summary>
/// A sparse set: the components packed in an array by dense index, and each
/// entity slot's dense index. Adding appends; removing moves the last
/// component into the hole, so iteration order is not insertion order
/// once anything has been removed.
/// </summary>
public sealed class SparseSet<T> : ComponentStore
    where T : struct
{
    public SparseSet(int id)
        : base(id)
    {
    }

    /// <summary>The components, by dense index; valid below <see cref="ComponentStore.Count"/>.</summary>
    public T[] Dense { get; private set; } = new T[16];

    /// <summary>The component of a slot that has it.</summary>
    public ref T Of(int slot) => ref Dense[sparse[slot]];

    // Adds or replaces the component of a slot; `present` says which.
    internal void Set(int slot, T value, bool present)
    {
        if (present)
        {
            Dense[sparse[slot]] = value;
            return;
        }

        if (slot >= sparse.Length)
        {
            var grown = new int[Math.Max(slot + 1, sparse.Length * 2)];
            Array.Copy(sparse, grown, sparse.Length);
            sparse = grown;
        }

        if (Count == Dense.Length)
        {
            var dense = new T[Count * 2];
            Array.Copy(Dense, dense, Count);
            Dense = dense;
            var entities = new int[Count * 2];
            Array.Copy(Entities, entities, Count);
            Entities = entities;
        }

        sparse[slot] = Count;
        Dense[Count] = value;
        Entities[Count] = slot;
        Count++;
    }

    internal override void RemoveSlot(int slot)
    {
        int index = sparse[slot];
        int last = Count - 1;
        if (index != last)
        {
            Dense[index] = Dense[last];
            int moved = Entities[last];
            Entities[index] = moved;
            sparse[moved] = index;
        }

        Dense[last] = default;
        Count = last;
    }
}
