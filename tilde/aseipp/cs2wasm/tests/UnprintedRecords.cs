// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A module whose derived records have floating members that nothing
// prints: their PrintMembers still needs the formatters (a fuzzer finding),
// and nothing else here demands them.

namespace Tests.UnprintedRecords;

internal record Base(double Weight, int Count);

internal record Derived(double Weight, int Count, string Name, bool Flag) : Base(Weight, Count);

internal record Single(float Ratio);

internal record Wider(float Ratio, long Id) : Single(Ratio);

public static class UnprintedRecords
{
    public static int Values(int x)
    {
        var derived = new Derived(x * 0.5, x, "n", x > 0);
        var wider = new Wider(x / 4f, x * 3L);
        Base other = derived with { Count = x + 1 };
        return derived.Count * 100 + (derived == other ? 1 : 0) + (int)(wider.Ratio * 8) + (int)wider.Id;
    }
}
