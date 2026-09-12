// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Diagnostics;

namespace Gameplay.Compiler;

// For the compiler's own measurements: GAMEPLAYC_TIMINGS=1 prints how long
// each phase of a compilation took, in milliseconds, to standard error.
internal static class Timings
{
    private static readonly bool Enabled = Environment.GetEnvironmentVariable("GAMEPLAYC_TIMINGS") == "1";

    // Times `phase` from here until the result is disposed.
    public static Phase Start(string phase) => new(Enabled ? phase : null, Enabled ? Stopwatch.GetTimestamp() : 0);

    public static void Note(string text)
    {
        if (Enabled)
        {
            Console.Error.WriteLine("timing " + text);
        }
    }

    public readonly struct Phase(string? name, long started) : IDisposable
    {
        public void Dispose()
        {
            if (name is not null)
            {
                Console.Error.WriteLine($"timing {name} {Stopwatch.GetElapsedTime(started).TotalMilliseconds:F0}");
            }
        }
    }
}
