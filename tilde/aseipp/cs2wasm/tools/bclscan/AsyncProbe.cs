// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace AsyncProbe;

public static class Probe
{
    public static async Task<int> AddLater(Task<int> a, int b)
    {
        int x = await a;
        await Task.Yield();
        return x + b;
    }

    public static async ValueTask Nothing()
    {
        await Task.Delay(1);
    }
}
