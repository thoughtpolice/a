// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// KILN020, a warning: two systems write one component in no order. The
// module still compiles.
namespace Bad;

using Kiln;

[Component]
internal partial struct Heat
{
    public int Value;
}

public static partial class Systems
{
    [System]
    static void Warm(ref Heat heat) => heat.Value++;

    [System]
    static void Cool(ref Heat heat) => heat.Value--;

    public static int Run()
    {
        var world = World.Create();
        world.Spawn(new Heat { Value = 3 });
        world.Tick();
        return world.Count<Heat>();
    }
}
