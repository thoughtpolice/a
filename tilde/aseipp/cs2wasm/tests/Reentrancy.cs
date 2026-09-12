// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Tests;

// Exports a host import calls back into while an outer export is running.
// The host's `reenter` import calls Reentrancy.Inner with its argument.
public static class Reentrancy
{
    // Asks the host for `test.seed` at the first use: the import runs
    // during static initialization.
    static int seed = ReentrancyHost.Seed();

    public static int Seed() => seed;

    public static int ReadPartial() => Partial.Early * 100 + Partial.Late;

    public static int PartialSeen() => Partial.Seen * 10 + Partial.Late;

    public static int SpinnerValue() => Spinner.Value();

    // The host runs SpinnerValue, which traps, swallows the trap and
    // returns; the class it left running is initialized again here.
    public static int SwallowThenUse() => ReentrancyHost.Hook(3) * 1000000 + Spinner.Value();

    public static int DoomedValue() => Doomed.Value();

    static int log;

    private static bool Mark(int value)
    {
        log += value;
        return false;
    }

    // An exception from the host (hook 6) passes through catch clauses and
    // their filters, and runs finally blocks.
    public static int HostThroughFilters()
    {
        log = 0;
        try
        {
            try
            {
                ReentrancyHost.Hook(6);
            }
            catch (System.Exception) when (Mark(1))
            {
                log += 100;
            }
            finally
            {
                log += 10;
            }
        }
        catch (System.Exception) when (Mark(2))
        {
            log += 200;
        }

        return log;
    }

    // The handler records it passed are gone: this exception finds its own.
    public static int AfterHost()
    {
        try
        {
            throw new System.InvalidOperationException();
        }
        catch (System.InvalidOperationException) when (log >= 0)
        {
            return log + 1000;
        }
    }

    // The host swallows a trap and enters again before returning: this
    // entry is abandoned.
    public static int Abandoned() => ReentrancyHost.Hook(4) + Doomed.Value();

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

// A host import (hook 1) calls back into the module while the initializer
// runs; the nested entry sees the fields set so far.
public static class Partial
{
    public static int Early = 7;
    public static int Seen = ReentrancyHost.Hook(1);
    public static int Late = 9;
}

// Spins as many times as the host says (hook 2), counting its runs.
public static class Spinner
{
    static int runs;
    static int total = Spin(ReentrancyHost.Hook(2));

    static int Spin(int count)
    {
        runs++;
        int sum = 0;
        for (int index = 0; index < count; index++)
        {
            sum += index;
        }

        return sum;
    }

    public static int Value() => runs * 100000 + total;
}

public static class Doomed
{
    static int runs;
    static int total = Spin(ReentrancyHost.Hook(5));

    static int Spin(int count)
    {
        runs++;
        int sum = 0;
        for (int index = 0; index < count; index++)
        {
            sum += index;
        }

        return sum;
    }

    public static int Value() => runs * 100000 + total;
}

public static class ReentrancyHost
{
    [Gameplay.WasmImport("test", "hook")]
    public static extern int Hook(int which);

    [Gameplay.WasmImport("test", "reenter")]
    public static extern int Reenter(int value);

    [Gameplay.WasmImport("test", "seed")]
    public static extern int Seed();
}
