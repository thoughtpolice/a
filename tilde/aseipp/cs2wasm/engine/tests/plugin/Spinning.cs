// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A Kiln library (Kiln.Tests.Plugin) contributing gameplay to the programs
// that reference it, as a Bevy plugin does: components, a tag, a resource,
// an event, a bundle and systems, which join the schedule of tests/Ecs.cs
// (whose own system reads the laps, ordered after Spinning.Turn). Compiled
// with Kiln's generator (as a library, which the build tells it), the
// library gets its components' and event's interfaces, its resource's and
// bundle's world members and the mark of a Kiln library; the program's
// generator schedules its systems.
using Kiln;

namespace Kiln.Tests.Plugin;

[Component]
public partial struct Spin
{
    public int Turns;
    public int Speed;
}

[Component]
public partial struct Wheel
{
    public int Size;
}

[Component]
public partial struct Stopped
{
}

[Resource]
public sealed class Odometer
{
    public int Total;
    public int Runs;
    public int Launched;
}

[Event]
public partial struct Lap
{
    public Entity Wheel;
    public int Size;
}

[Bundle]
public partial record struct Spinner(Spin Spin, Wheel Wheel);

public static class Spinning
{
    // Every wheel that is not stopped turns, and each full turn is a lap.
    [System(Phase.Update)]
    [Without<Stopped>]
    public static void Turn(Entity self, ref Spin spin, in Wheel wheel, Odometer odometer, EventWriter<Lap> laps)
    {
        spin.Turns += spin.Speed;
        odometer.Total += spin.Speed;
        while (spin.Turns >= wheel.Size)
        {
            spin.Turns -= wheel.Size;
            laps.Send(new Lap { Wheel = self, Size = wheel.Size });
        }
    }

    public static bool Counting(Odometer odometer) => odometer.Runs < 5;

    [System(Phase.PostUpdate)]
    [RunIf(nameof(Counting))]
    public static void Count(Odometer odometer) => odometer.Runs++;

    // The library's own code uses its bundle's Spawn and its resource's
    // world property, which its generator wrote.
    public static Entity Launch(World world, int speed, int size)
    {
        var wheel = world.Spawn(new Spinner(new Spin { Speed = speed }, new Wheel { Size = size }));
        world.Odometer.Launched++;
        return wheel;
    }
}
