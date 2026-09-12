// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The game's data, as Kiln components, resources, events and bundles; the
// engine's generator writes their storage and the systems' queries.
namespace Lichgate;

using System.Collections.Generic;
using System.Numerics;
using Kiln;

[Component]
internal partial struct Position
{
    public Vector2 Value;
}

[Component]
internal partial struct Velocity
{
    public Vector2 Value;

    /// <summary>How much of the velocity is kept each tick.</summary>
    public float Friction;
}

/// <summary>A circle that collides with others, on a layer.</summary>
[Component]
internal partial struct Body
{
    public float Radius;
    public int Layer;

    /// <summary>Whether the room's walls and rocks stop it.</summary>
    public bool Solid;
}

[Component]
internal partial struct Health
{
    public int Current;
    public int Max;

    /// <summary>Ticks it flashes white for, after a hit.</summary>
    public int Flash;

    /// <summary>Ticks before it can be hurt again.</summary>
    public int Invulnerable;
}

[Component]
internal partial struct Look
{
    public Sprite[] Frames;
    public int Frame;
    public int Rate;
    public bool FlipX;

    /// <summary>A palette swap for the sprite, or null.</summary>
    public byte[] Remap;

    /// <summary>Drawn above everything on its row (flying things).</summary>
    public int Lift;
}

internal enum Kind
{
    Bat,
    Slime,
    SmallSlime,
    Skeleton,
    Eye,
    Boar,
    Wisp,
    Lich,
}

[Component]
internal partial struct Enemy
{
    public Kind Kind;
    public int Contact;
    public int Score;
}

[Component]
internal partial struct Bullet
{
    public int Damage;
    public int Life;
    public bool Friendly;
    public int Pierce;
    public float Homing;
    public byte[] Trail;
}

internal enum Drop
{
    Heart,
    Gem,
    Relic,
}

[Component]
internal partial struct Pickup
{
    public Drop Drop;
    public int Value;
    public int Age;
}

/// <summary>An altar offering an upgrade, taken by walking onto it.</summary>
[Component]
internal partial struct Offer
{
    public Upgrade Upgrade;
}

[Component]
internal partial struct Hero
{
}

[Component]
internal partial struct Boss
{
}

/// <summary>Not yet dangerous: fading in where it will appear.</summary>
[Component]
internal partial struct Spawning
{
}

/// <summary>A stairway to the next floor.</summary>
[Component]
internal partial struct Gate
{
}

internal static class Layers
{
    public const int Hero = 1;
    public const int Enemy = 2;
    public const int Pickup = 4;
    public const int Gate = 8;
}

[Event]
internal partial struct Hit
{
    public Entity Target;
    public int Damage;
    public Vector2 Push;
    public bool Friendly;
}

[Event]
internal partial struct Died
{
    public Entity Entity;
    public Kind Kind;
    public Vector2 At;
    public int Score;
}

[Event]
internal partial struct Collected
{
    public Drop Drop;
    public int Value;
    public Vector2 At;
}

[Bundle]
internal partial record struct Mob(Position Position, Velocity Velocity, Body Body, Health Health, Look Look, Enemy Enemy);

[Bundle]
internal partial record struct Shot(Position Position, Velocity Velocity, Body Body, Bullet Bullet, Look Look);

/// <summary>What the player (or the autopilot) asks for this tick.</summary>
[Resource]
internal sealed class Intent
{
    public Vector2 Move;
    public Vector2 Aim;
    public bool Fire;
    public bool Dash;
}

/// <summary>The run: the hero's stats, score, and the floor being explored.</summary>
[Resource]
internal sealed class Crawl
{
    public Stats Stats = new Stats();
    public List<Upgrade> Upgrades = new List<Upgrade>();
    public int Score;
    public int Kills;
    public int Combo;
    public int ComboTimer;
    public int Floor = 1;
    public int RoomsCleared;
    public int Cooldown;
    public int DashTimer;
    public int DashCooldown;
    public Vector2 DashDirection;
    public Vector2 Facing = new Vector2(1, 0);
    public bool Over;
    public bool Descending;
    public Dungeon Dungeon;
    public Room Room;

    /// <summary>The hero, while there is one.</summary>
    public Entity Hero;
}

/// <summary>The dressing around the world: particles, the camera's shake, hit-stop.</summary>
[Resource]
internal sealed class Effects
{
    public Particles Particles = new Particles(900);
    public float Trauma;
    public int Freeze;
    public Rng Rng = new Rng(1);
    public List<Popup> Popups = new List<Popup>();
    public Vector2 Shake;

    public void Kick(float amount) => Trauma = System.Math.Min(1f, Trauma + amount);
}

internal sealed class Popup
{
    public string Text;
    public Vector2 At;
    public int Life;
    public byte Color;
}

/// <summary>The broad phase, rebuilt every tick.</summary>
[Resource]
internal sealed class Space
{
    public SpatialHash Hash = new SpatialHash(Dungeon.Width * Tiles.Size, Dungeon.Height * Tiles.Size, 24);
    public List<Entity> Found = new List<Entity>();
}
