// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the engine's host starts: the game.
namespace Kiln;

internal abstract partial class App
{
    public static partial App Create() => new Lichgate.Game();
}
