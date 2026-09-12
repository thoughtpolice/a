// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Kiln is a Kiln library itself (compiled with Kiln's generator as a
// library, which marks it one): the world's particles, and the system that
// ages them, join every program's schedule.
namespace Kiln;

using System;
using System.Collections.Generic;
using System.Numerics;

/// <summary>
/// Particles: a fixed pool of plain arrays (no entity each: sparks come and
/// go by the hundred), each with a colour ramp it walks through as it
/// ages. When the pool is full the oldest spark is reused. A world's
/// <c>Particles</c> resource (<c>world.Particles</c>, none until the game
/// gives it one) is aged by the engine every tick, after the update
/// phase's systems (<see cref="Advance"/>).
/// </summary>
[Resource]
public sealed class Particles
{
    private readonly Vector2[] positions;
    private readonly Vector2[] velocities;
    private readonly float[] gravity;
    private readonly float[] drag;
    private readonly int[] life;
    private readonly int[] lifetime;
    private readonly byte[][] ramps;
    private readonly byte[] size;
    private int next;

    public Particles(int capacity)
    {
        Capacity = capacity;
        positions = new Vector2[capacity];
        velocities = new Vector2[capacity];
        gravity = new float[capacity];
        drag = new float[capacity];
        life = new int[capacity];
        lifetime = new int[capacity];
        ramps = new byte[capacity][];
        size = new byte[capacity];
    }

    public int Capacity { get; }

    /// <summary>The particles alive.</summary>
    public int Count
    {
        get
        {
            int count = 0;
            for (int index = 0; index < Capacity; index++)
            {
                if (life[index] > 0)
                {
                    count++;
                }
            }

            return count;
        }
    }

    public void Emit(Vector2 position, Vector2 velocity, int ticks, byte[] ramp, float fall = 0, float friction = 0.92f, int pixels = 1)
    {
        int index = next;
        next = (next + 1) % Capacity;
        positions[index] = position;
        velocities[index] = velocity;
        gravity[index] = fall;
        drag[index] = friction;
        life[index] = Math.Max(1, ticks);
        lifetime[index] = Math.Max(1, ticks);
        ramps[index] = ramp;
        size[index] = (byte)pixels;
    }

    /// <summary>Sparks flying out of a point in every direction.</summary>
    public void Burst(Rng rng, Vector2 position, int count, float minSpeed, float maxSpeed, int minTicks, int maxTicks, byte[] ramp, float fall = 0, int pixels = 1)
    {
        for (int index = 0; index < count; index++)
        {
            Emit(position, rng.Direction() * rng.Range(minSpeed, maxSpeed), rng.Range(minTicks, maxTicks + 1), ramp, fall, 0.9f, pixels);
        }
    }

    /// <summary>Sparks thrown within an arc around a direction.</summary>
    public void Spray(Rng rng, Vector2 position, Vector2 direction, float spread, int count, float minSpeed, float maxSpeed, int ticks, byte[] ramp)
    {
        float angle = MathF.Atan2(direction.Y, direction.X);
        for (int index = 0; index < count; index++)
        {
            float turn = angle + rng.Range(-spread, spread);
            var velocity = new Vector2(MathF.Cos(turn), MathF.Sin(turn)) * rng.Range(minSpeed, maxSpeed);
            Emit(position, velocity, ticks + rng.Range(-ticks / 3, ticks / 3 + 1), ramp);
        }
    }

    /// <summary>Ages the world's particles, if it has any: a system of every program's post-update phase.</summary>
    [System(Phase.PostUpdate)]
    public static void Advance(Particles particles) => particles?.Update();

    public void Update()
    {
        for (int index = 0; index < Capacity; index++)
        {
            if (life[index] <= 0)
            {
                continue;
            }

            life[index]--;
            velocities[index] = velocities[index] * drag[index] + new Vector2(0, gravity[index]);
            positions[index] += velocities[index];
        }
    }

    public void Draw(Canvas canvas)
    {
        for (int index = 0; index < Capacity; index++)
        {
            if (life[index] <= 0)
            {
                continue;
            }

            byte[] ramp = ramps[index];
            int age = lifetime[index] - life[index];
            byte color = ramp[Math.Min(ramp.Length - 1, age * ramp.Length / lifetime[index])];
            int x = (int)positions[index].X;
            int y = (int)positions[index].Y;
            if (size[index] <= 1)
            {
                canvas.Plot(x, y, color);
            }
            else
            {
                canvas.Fill(x, y, size[index], size[index], color);
            }
        }
    }

    public void Clear() => Array.Clear(life);
}
