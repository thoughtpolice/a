// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Gameplay.Frames for ordinary .NET projects: IDE support, and the CLR
// oracle of the differential tests (tests/reference). gameplayc does not
// take this file: its gameplay CoreLib implements Frames itself
// (corelib/Frames.cs), and this is the same loop written over the CLR's
// SynchronizationContext, so that the same code runs the same way on both.
// Its context becomes the current one on the thread that first uses
// Frames, as the CoreLib's is the module's from the start. What the CoreLib
// does beyond it: Task.Delay and CancellationTokenSource.CancelAfter count
// the frames' time there, and wall time here.
namespace Gameplay
{
    using System;
    using System.Collections.Generic;
    using System.Threading;
    using System.Threading.Tasks;

    /// <summary>
    /// The frames async gameplay code waits for: <c>await Frames.NextFrame()</c>
    /// resumes on the next frame. The module's frame export advances them
    /// with <see cref="Advance"/>.
    /// </summary>
    public static class Frames
    {
        private static readonly FrameContext Context = Install();
        private static readonly Queue<(SendOrPostCallback Callback, object State)> Work = new Queue<(SendOrPostCallback, object)>();
        private static List<TaskCompletionSource> nextFrame;
        private static bool running;

        // Precise: the context is installed before any member runs.
        static Frames()
        {
        }

        private static FrameContext Install()
        {
            var context = new FrameContext();
            SynchronizationContext.SetSynchronizationContext(context);
            return context;
        }

        /// <summary>A task that completes when the next frame starts.</summary>
        public static Task NextFrame()
        {
            var source = new TaskCompletionSource();
            (nextFrame ??= new List<TaskCompletionSource>()).Add(source);
            return source.Task;
        }

        /// <summary>
        /// Starts the next frame, <paramref name="elapsed"/> of game time after
        /// the last: completes what waits for it and runs what is posted until
        /// nothing is left. Called by the module's frame export, never from
        /// inside a frame.
        /// </summary>
        public static void Advance(TimeSpan elapsed)
        {
            if (running)
            {
                throw new InvalidOperationException("Frames.Advance was called inside a frame.");
            }

            if (elapsed.Ticks < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(elapsed), "Non-negative number required.");
            }

            running = true;
            try
            {
                Count++;
                Time += elapsed;
                if (nextFrame is { } waiting)
                {
                    nextFrame = null;
                    foreach (var source in waiting)
                    {
                        source.TrySetResult();
                    }
                }

                while (Work.Count > 0)
                {
                    var (callback, state) = Work.Dequeue();
                    callback(state);
                }
            }
            finally
            {
                running = false;
            }
        }

        /// <summary>The frames advanced so far.</summary>
        public static long Count { get; private set; }

        /// <summary>The game time: what the frames have advanced it by.</summary>
        public static TimeSpan Time { get; private set; }

        private sealed class FrameContext : SynchronizationContext
        {
            public override void Post(SendOrPostCallback d, object state)
            {
                ArgumentNullException.ThrowIfNull(d);
                Work.Enqueue((d, state));
            }

            public override void Send(SendOrPostCallback d, object state) => d(state);

            public override SynchronizationContext CreateCopy() => this;
        }
    }
}
