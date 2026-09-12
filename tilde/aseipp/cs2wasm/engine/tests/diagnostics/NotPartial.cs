// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// KILN001: a component that is not partial.
namespace Bad;

using Kiln;

[Component]
internal struct Position
{
    public float X;
}

// KILN003: a system of a class that is not partial.
internal static class Loose
{
    [System]
    static void Run()
    {
    }
}
