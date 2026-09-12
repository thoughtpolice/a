// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Tests;

// Exports a host import calls back into while an outer export is running.
// The host's `reenter` import calls Reentrancy.Inner with its argument.
public static class Reentrancy
{
    // Asks the host for `test.reenter` on the first entry: the import runs
    // during static initialization.
    static int seed = ReentrancyHost.Seed();

    public static int Seed() => seed;

    // `depth` frames deep, counting this one.
    public static int Inner(int depth) => depth <= 1 ? 1 : 1 + Inner(depth - 1);

    // Recurses `down` frames, lets the host run Inner(`nested`) from there,
    // then recurses `more` further frames from the same depth. The outer
    // call's depth budget is its own: the nested entry neither spends it nor
    // resets it.
    public static int Deep(int down, int nested, int more)
    {
        if (down > 0)
        {
            return 1 + Deep(down - 1, nested, more);
        }

        return ReentrancyHost.Reenter(nested) * 1000 + Inner(more);
    }

    // Each iteration costs one unit of the outer call's fuel; the nested
    // entries' fuel is theirs and does not refill the outer call's.
    public static int Spin(int iterations, int nested)
    {
        int total = 0;
        for (int i = 0; i < iterations; i++)
        {
            total += ReentrancyHost.Reenter(nested);
        }

        return total;
    }

    // Each nested entry allocates on its own budget; the outer call's
    // allocations are charged to the outer budget only.
    public static int Allocate(int outer, int nested)
    {
        int total = 0;
        for (int i = 0; i < outer; i++)
        {
            total += new int[1000].Length / 1000;
            total += ReentrancyHost.Reenter(nested);
        }

        return total;
    }

    public static int AllocateInner(int count)
    {
        int total = 0;
        for (int i = 0; i < count; i++)
        {
            total += new int[1000].Length / 1000;
        }

        return total;
    }
}

public static class ReentrancyHost
{
    [Gameplay.WasmImport("test", "reenter")]
    public static extern int Reenter(int value);

    [Gameplay.WasmImport("test", "seed")]
    public static extern int Seed();
}
