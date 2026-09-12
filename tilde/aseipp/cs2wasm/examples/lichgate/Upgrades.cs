// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The hero's numbers and the relics that change them: records, one per
// relic, each applying itself to the stats.
namespace Lichgate;

using System;
using System.Collections.Generic;
using System.Linq;
using Kiln;

internal sealed class Stats
{
    /// <summary>In half hearts.</summary>
    public int MaxHealth = 6;
    public float Speed = 1.45f;
    public int Damage = 3;
    public int FireDelay = 14;
    public float ShotSpeed = 3.4f;
    public int Shots = 1;
    public int Pierce;
    public float Homing;
    public int Range = 48;
    public int Siphon;
}

internal abstract record Upgrade(string Name, string Blurb)
{
    public abstract void Apply(Stats stats);

    /// <summary>Every relic there is.</summary>
    public static IReadOnlyList<Upgrade> All { get; } = new Upgrade[]
    {
        new Whetstone(),
        new Quickdraw(),
        new SwiftBoots(),
        new TwinSigil(),
        new SeekerRunes(),
        new PiercingHex(),
        new HeartVessel(),
        new LongReach(),
        new BloodPact(),
        new SoulSiphon(),
    };

    /// <summary>Relics not yet held, in an order the seed decides.</summary>
    public static List<Upgrade> Draw(Rng rng, IReadOnlyCollection<Upgrade> held, int count)
    {
        var pool = All.Where(upgrade => upgrade is TwinSigil or HeartVessel or Whetstone || !held.Contains(upgrade)).ToList();
        rng.Shuffle(pool);
        return pool.Take(count).ToList();
    }
}

internal sealed record Whetstone() : Upgrade("WHETSTONE", "+1 DAMAGE")
{
    public override void Apply(Stats stats) => stats.Damage += 1;
}

internal sealed record Quickdraw() : Upgrade("QUICKDRAW", "FASTER SHOTS")
{
    public override void Apply(Stats stats) => stats.FireDelay = Math.Max(5, stats.FireDelay - 3);
}

internal sealed record SwiftBoots() : Upgrade("SWIFT BOOTS", "+SPEED")
{
    public override void Apply(Stats stats) => stats.Speed += 0.3f;
}

internal sealed record TwinSigil() : Upgrade("TWIN SIGIL", "+1 SHOT")
{
    public override void Apply(Stats stats) => stats.Shots = Math.Min(5, stats.Shots + 1);
}

internal sealed record SeekerRunes() : Upgrade("SEEKER RUNES", "HOMING SHOTS")
{
    public override void Apply(Stats stats) => stats.Homing += 0.09f;
}

internal sealed record PiercingHex() : Upgrade("PIERCING HEX", "SHOTS PIERCE")
{
    public override void Apply(Stats stats) => stats.Pierce += 1;
}

internal sealed record HeartVessel() : Upgrade("HEART VESSEL", "+1 HEART")
{
    public override void Apply(Stats stats) => stats.MaxHealth = Math.Min(16, stats.MaxHealth + 2);
}

internal sealed record LongReach() : Upgrade("LONG REACH", "+RANGE +SHOT SPEED")
{
    public override void Apply(Stats stats)
    {
        stats.Range += 18;
        stats.ShotSpeed += 0.7f;
    }
}

internal sealed record BloodPact() : Upgrade("BLOOD PACT", "+2 DAMAGE -1 HEART")
{
    public override void Apply(Stats stats)
    {
        stats.Damage += 2;
        stats.MaxHealth = Math.Max(2, stats.MaxHealth - 2);
    }
}

internal sealed record SoulSiphon() : Upgrade("SOUL SIPHON", "KILLS MAY HEAL")
{
    public override void Apply(Stats stats) => stats.Siphon += 1;
}
