// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Kiln;

using System;

/// <summary>
/// An entity: a slot of the world and the generation of the slot, so an
/// entity that was despawned never aliases the one reusing its slot.
/// </summary>
public readonly struct Entity : IEquatable<Entity>
{
    public Entity(int index, int generation)
    {
        Index = index;
        Generation = generation;
    }

    public int Index { get; }

    public int Generation { get; }

    /// <summary>No entity: generation zero is never alive.</summary>
    public static Entity None => default;

    public bool IsNone => Generation == 0;

    public bool Equals(Entity other) => Index == other.Index && Generation == other.Generation;

    public override bool Equals(object obj) => obj is Entity other && Equals(other);

    public override int GetHashCode() => (Index * 397) ^ Generation;

    public static bool operator ==(Entity left, Entity right) => left.Equals(right);

    public static bool operator !=(Entity left, Entity right) => !left.Equals(right);

    public override string ToString() => IsNone ? "none" : "#" + Index + "." + Generation;
}
