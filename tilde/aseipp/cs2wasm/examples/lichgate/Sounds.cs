// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Every sound the game makes, as data for the engine's synthesizer, and
// the songs: one composed from each floor's seed, the Lich's, and the
// title's.
namespace Lichgate;

using Kiln;

internal static class Sounds
{
    public static readonly Sound Shoot = new(Wave.Square, 900, 380, 0.07f, Volume: 0.12f, Duty: 0.25f);
    public static readonly Sound EnemyShoot = new(Wave.Square, 300, 520, 0.1f, Volume: 0.12f, Duty: 0.5f, Pan: 0.3f);
    public static readonly Sound Hit = new(Wave.Noise, 1800, 600, 0.06f, Volume: 0.22f);
    public static readonly Sound Kill = new(Wave.Noise, 900, 90, 0.28f, Volume: 0.4f);
    public static readonly Sound Pop = new(Wave.Triangle, 660, 1320, 0.08f, Volume: 0.3f);
    public static readonly Sound Hurt = new(Wave.Saw, 440, 110, 0.3f, Volume: 0.35f, Vibrato: 0.05f);
    public static readonly Sound Dash = new(Wave.Noise, 4000, 1200, 0.15f, Volume: 0.15f);
    public static readonly Sound Pickup = new(Wave.Square, 988, 1976, 0.1f, Volume: 0.18f, Duty: 0.125f);
    public static readonly Sound Heal = new(Wave.Triangle, 523, 1046, 0.25f, Volume: 0.35f, Vibrato: 0.02f);
    public static readonly Sound Door = new(Wave.Triangle, 220, 110, 0.35f, Volume: 0.4f);
    public static readonly Sound Unlock = new(Wave.Square, 392, 784, 0.3f, Volume: 0.2f, Duty: 0.25f);
    public static readonly Sound Relic = new(Wave.Sine, 523, 2093, 0.6f, Volume: 0.35f, Vibrato: 0.03f);
    public static readonly Sound Teleport = new(Wave.Sine, 1600, 200, 0.4f, Volume: 0.3f, Vibrato: 0.1f);
    public static readonly Sound Charge = new(Wave.Saw, 80, 220, 0.5f, Volume: 0.25f);
    public static readonly Sound Thud = new(Wave.Noise, 300, 40, 0.35f, Volume: 0.5f);
    public static readonly Sound Boom = new(Wave.Noise, 700, 30, 0.8f, Volume: 0.6f);
    public static readonly Sound Select = new(Wave.Square, 660, 660, 0.05f, Volume: 0.15f, Duty: 0.5f);
    public static readonly Sound Start = new(Wave.Square, 330, 1320, 0.35f, Volume: 0.2f, Duty: 0.25f);

    public static Song Title => Composer.Compose(0x71C4, "title", false);

    public static Song Floor(ulong seed, int floor) => Composer.Compose(seed + (ulong)floor * 31, "floor " + floor, false);

    public static Song Lair(ulong seed) => Composer.Compose(seed ^ 0xB055, "the lich", true);
}
