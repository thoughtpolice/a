// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// KILN010: systems ordered in a cycle.
namespace Bad;

using Kiln;

internal static partial class Systems
{
    [System, After(nameof(B))]
    static void A()
    {
    }

    [System, After(nameof(C))]
    static void B()
    {
    }

    [System, After(nameof(A))]
    static void C()
    {
    }
}
