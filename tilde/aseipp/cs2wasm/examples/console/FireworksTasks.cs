// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The fireworks show as an `async-game`: one long task that waits for each
// frame through the SDK's scheduler (`console:sdk/tasks`), a component-model
// subtask wlink's async runtime completes, and steps the show in that
// frame's turn, by the time the clock says went by. It plays the same show
// as the `game`, frame for frame.
using System.Threading.Tasks;

namespace Console.Sdk;

public static partial class AsyncGame
{
    public static partial class Main
    {
        public static async partial Task Run()
        {
            Fireworks.Start();
            ulong last = Clock.NowMs();
            while (true)
            {
                await Tasks.Frames(1);
                ulong now = Clock.NowMs();
                if (!Fireworks.Step((uint)(now - last)))
                {
                    return;
                }

                last = now;
            }
        }
    }
}
