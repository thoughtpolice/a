// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The fireworks show as a `game`: the host's `frame` export steps it.
namespace Console.Sdk;

public static partial class Game
{
    public static partial void Init() => Fireworks.Start();

    public static partial bool Frame(uint dtMs) => Fireworks.Step(dtMs);
}
