// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// KILN014: a Kiln library's declarations join the schedules of the
// programs that reference it, so they must be public. Compiled without
// Kiln's generator, it is no Kiln library, and a program over it is told
// so (Unscheduled.cs).
using Kiln;

namespace Bad;

[Component]
internal partial struct Secret
{
    public int Value;
}

[Component]
public partial struct Wheel
{
    public int Size;
}

public static class Systems
{
    [System]
    static void Run(ref Wheel wheel) => wheel.Size++;
}
