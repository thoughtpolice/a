// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The module side of world `sleepy` in sleepy.wit: two waits at
// once, then another, which tests/wit-tasks.mjs has Wasmtime run when it is
// installed.
using System.Threading.Tasks;

namespace Test.Sleepy;

public static partial class Sleepy
{
    private static async Task<uint> One(uint ms)
    {
        await MonotonicClock.WaitFor((ulong)ms * 1000000);
        return ms;
    }

    public static partial async Task<uint> Nap(uint ms)
    {
        var both = await Task.WhenAll(One(ms), One(ms * 2));
        await MonotonicClock.WaitFor(1000);
        return both[0] + both[1];
    }
}
