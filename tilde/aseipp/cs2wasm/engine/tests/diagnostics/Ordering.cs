// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// KILN011 and KILN013: ordering against a system of another phase, and a
// run condition that is not a static bool method.
namespace Bad;

using Kiln;

internal static partial class Systems
{
    [System(Phase.Render)]
    static void Draw()
    {
    }

    [System, After(nameof(Draw))]
    static void Move()
    {
    }

    static int Sometimes() => 1;

    [System, RunIf(nameof(Sometimes))]
    static void Maybe()
    {
    }
}
