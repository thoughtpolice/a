// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.Poisoning;

// A module as built by default: a trap, or an exception no catch clause
// takes, ends it for good, as they end a .NET process. tests/poisoning.mjs
// instantiates it once per scenario.
public static class Probe
{
    static int calls;

    public static int Count() => ++calls;

    public static int Spin(int count)
    {
        int total = 0;
        for (int index = 0; index < count; index++)
        {
            total += index;
        }

        return total;
    }

    public static int Throw(int code) => code > 0 ? throw new InvalidOperationException() : code;

    public static int Catch()
    {
        try
        {
            return Throw(1);
        }
        catch (InvalidOperationException)
        {
            return 7;
        }
    }

    public static int CallHost(int which) => PoisonHost.Call(which) + 1;

    public static int Seed() => Seeded.Value();
}

// Initialized from the host: a host exception leaves it uninitialized, not
// failed, and the module usable.
public static class Seeded
{
    static int value = PoisonHost.Call(0);

    public static int Value() => value;
}

public static class PoisonHost
{
    [Gameplay.WasmImport("test", "call")]
    public static extern int Call(int which);
}
