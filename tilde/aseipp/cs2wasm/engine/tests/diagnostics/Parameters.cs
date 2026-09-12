// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// KILN005 and KILN007: a parameter that is nothing a system can take, and
// a tag as a parameter.
namespace Bad;

using Kiln;

[Component]
internal partial struct Marked
{
}

internal static partial class Systems
{
    [System]
    static void Strange(string text)
    {
    }

    [System]
    static void Tagged(Marked marked)
    {
    }
}
