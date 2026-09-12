// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The frame loop (docs/IMPORTER.md "Async"), where it is the
// module's own and has no CLR counterpart to compare with
// (tests/frames.mjs checks it): Task.Delay and CancelAfter in game time,
// what runs where no SynchronizationContext is current (the CLR's thread
// pool), a wait that would block the only thread, an async void method's
// exception escaping the frame, and the frame's budgets.

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Gameplay;

namespace Tests.Loop
{
    public sealed class Boom : Exception
    {
        public Boom(string message)
            : base(message)
        {
        }
    }

    public static class FrameLoop
    {
        private static readonly List<int> Log = new List<int>();
        private static Task pending;

        // What was logged since the last read, as the digits of a number.
        public static int Read()
        {
            int value = 0;
            foreach (int entry in Log)
            {
                value = value * 10 + entry;
            }

            Log.Clear();
            return value;
        }

        public static void Frame(int milliseconds) => Frames.Advance(TimeSpan.FromMilliseconds(milliseconds));

        public static long Count() => Frames.Count;

        public static long Time() => (long)Frames.Time.TotalMilliseconds;

        private static async Task After(int milliseconds, int entry)
        {
            await Task.Delay(milliseconds);
            Log.Add(entry);
        }

        // Delays of 50, 20, 50 and 0 ms: the last completes at once; the
        // others on the first frame that reaches them, those due together
        // in the order they started.
        public static int Delays()
        {
            _ = After(50, 1);
            _ = After(20, 2);
            _ = After(50, 3);
            _ = After(0, 4);
            return Log.Count;
        }

        // A delay canceled by a token, and CancelAfter, in game time.
        public static int Cancels()
        {
            var cts = new CancellationTokenSource();
            cts.CancelAfter(30);
            cts.Token.Register(() => Log.Add(5));
            pending = Task.Delay(100, cts.Token);
            pending.ContinueWith(task => Log.Add(task.IsCanceled ? 6 : 7), TaskContinuationOptions.ExecuteSynchronously);
            var timed = new CancellationTokenSource(TimeSpan.FromMilliseconds(40));
            timed.Token.Register(() => Log.Add(8));
            return 0;
        }

        private static async Task Timeout(Task work, int milliseconds)
        {
            var first = await Task.WhenAny(work, Task.Delay(milliseconds));
            Log.Add(first == work ? 1 : 2);
        }

        // WhenAny against a delay: a timeout.
        public static int Timeouts()
        {
            _ = Timeout(new TaskCompletionSource().Task, 30);
            _ = Timeout(Task.Delay(10), 30);
            return 0;
        }

        private static async Task NoContext()
        {
            Log.Add(1);
            await Task.Yield();
            Log.Add(SynchronizationContext.Current is null ? 3 : 4);
        }

        // With no context current, continuations and Task.Yield go to the
        // frame loop's queue, as the CLR's go to its thread pool.
        public static int Unposted()
        {
            var previous = SynchronizationContext.Current;
            SynchronizationContext.SetSynchronizationContext(null);
            try
            {
                pending = NoContext();
                Log.Add(2);
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(previous);
            }

            return 0;
        }

        private static async Task Unconfigured(Task task)
        {
            await task.ConfigureAwait(false);
            Log.Add(SynchronizationContext.Current is null ? 5 : 6);
        }

        // ConfigureAwait(false) and ContinueWith run from the frame loop's
        // queue, after the frame's own continuations.
        public static int Unscheduled()
        {
            var source = new TaskCompletionSource();
            _ = Unconfigured(source.Task);
            source.Task.ContinueWith(_ => Log.Add(7));
            Frames.NextFrame().GetAwaiter().OnCompleted(() =>
            {
                Log.Add(1);
                source.SetResult();
                Log.Add(2);
            });
            return 0;
        }

        // Waiting for a task that has not completed faults (20).
        public static int Blocks() => new TaskCompletionSource<int>().Task.Result;

        public static int Waits()
        {
            new TaskCompletionSource().Task.Wait();
            return 0;
        }

        public static int GetsResult() => new TaskCompletionSource<int>().Task.GetAwaiter().GetResult();

        private static async void Explode()
        {
            await Frames.NextFrame();
            Log.Add(9);
            throw new Boom("async void");
        }

        // An async void method's exception escapes the frame that runs it.
        public static int Explodes()
        {
            Explode();
            return 0;
        }

        private static async Task Spin()
        {
            while (true)
            {
                await Task.Yield();
            }
        }

        // A frame's continuations run under its budget.
        public static int Spins()
        {
            _ = Spin();
            return 0;
        }

        private static async Task Walk()
        {
            for (int i = 1; i <= 3; i++)
            {
                await Frames.NextFrame();
                Log.Add(i);
            }
        }

        public static int Walks()
        {
            pending = Walk();
            return 0;
        }

        public static int PendingDone() => pending is not null && pending.IsCompleted ? 1 : 0;

        private static Task<int> chained;

        private static async Task<int> Next(Task<int> previous) => await previous + 1;

        // A long chain of awaits that complete one another: each
        // continuation runs inline while the call depth has room (as the
        // CLR's while its stack has), the rest from the frame loop.
        public static int Chains()
        {
            var source = new TaskCompletionSource<int>();
            chained = source.Task;
            for (int i = 0; i < 300; i++)
            {
                chained = Next(chained);
            }

            source.SetResult(0);
            return chained.IsCompleted ? 1 : 0;
        }

        public static int Chained() => chained.IsCompleted ? chained.Result : -1;

        private static Task<int> waited;

        // WaitAsync's timeout counts game time; a task that completes first
        // completes it.
        public static int WaitsAsync()
        {
            waited = new TaskCompletionSource<int>().Task.WaitAsync(TimeSpan.FromMilliseconds(30));
            var source = new TaskCompletionSource<int>();
            var first = source.Task.WaitAsync(TimeSpan.FromMilliseconds(30));
            source.SetResult(7);
            Log.Add(first.Result);
            return 0;
        }

        public static int Waited() =>
            waited.IsFaulted && waited.Exception.InnerException is TimeoutException ? 1 : waited.IsCompleted ? 2 : 0;

        // Task.Run and the default scheduler: the frame loop's queue, as the
        // CLR's thread pool; waiting for a queued task runs it, as nothing
        // else would; an async function's task is unwrapped.
        public static int Runs()
        {
            var queued = Task.Run(() => Log.Add(1));
            Log.Add(Task.Run(() => 2).Result);
            pending = Task.Run(async () =>
            {
                await Task.Yield();
                Log.Add(4);
            });
            Task.Factory.StartNew(() => Log.Add(3));
            return queued.IsCompleted ? 1 : 0;
        }

        private static readonly AsyncLocal<int> Local = new AsyncLocal<int>();

        private static async Task Pooled()
        {
            await Task.Yield();
            Log.Add(Local.Value);
        }

        // What runs from the queue (the CLR's thread pool) runs in the
        // default ExecutionContext, or the one it flows: an async method's,
        // a ContinueWith's, a yield awaiter's OnCompleted, and not its
        // UnsafeOnCompleted.
        public static int Pools()
        {
            var previous = SynchronizationContext.Current;
            SynchronizationContext.SetSynchronizationContext(null);
            try
            {
                Local.Value = 1;
                pending = Pooled();
                Local.Value = 2;
                Task.CompletedTask.ContinueWith(_ => Log.Add(Local.Value));
                Local.Value = 3;
                Task.Yield().GetAwaiter().OnCompleted(() => Log.Add(Local.Value));
                Task.Yield().GetAwaiter().UnsafeOnCompleted(() => Log.Add(Local.Value + 4));
                Local.Value = 5;
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(previous);
            }

            return Local.Value;
        }
    }
}
