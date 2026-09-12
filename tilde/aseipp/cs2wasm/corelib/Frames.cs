// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The frame loop async code runs on (docs/IMPORTER.md, "Async"). A module
// has one thread, and the host drives it a frame at a time: the module's
// frame export calls Gameplay.Frames.Advance, which starts the next frame
// (game time moves on by what the host says elapsed), completes what waits
// for that frame (Frames.NextFrame, then the delays that are due, in the
// order they are due) and runs everything posted to the loop until nothing
// is left. Posted work is what the CLR posts to a SynchronizationContext or
// queues to its thread pool (which runs here with no context current, as
// on a thread of the pool): continuations, Task.Yield, ContinueWith, async
// void exceptions. The loop's SynchronizationContext is the current one unless
// code sets another, so await continuations come back to the loop, as a
// game engine's main-thread context brings them back to its main thread.
// Everything runs inside the frame export's call, under its budgets.

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Gameplay.Runtime;

namespace Gameplay
{
    /// <summary>
    /// The frames async gameplay code waits for: <c>await Frames.NextFrame()</c>
    /// resumes on the next frame, and <c>Task.Delay</c> counts game time. The
    /// module's frame export advances them with <see cref="Advance"/>.
    /// </summary>
    // A class of static members rather than a static class: a CoreLib
    // static class's members are every module's (see TaskCache).
    public sealed class Frames
    {
        private Frames()
        {
        }

        /// <summary>A task that completes when the next frame starts.</summary>
        public static Task NextFrame() => FrameLoop.Instance.NextFrame();

        /// <summary>
        /// Starts the next frame, <paramref name="elapsed"/> of game time after
        /// the last: completes what waits for it and runs what is posted until
        /// nothing is left. Called by the module's frame export, never from
        /// inside a frame.
        /// </summary>
        public static void Advance(TimeSpan elapsed) => FrameLoop.Instance.Advance(elapsed);

        /// <summary>The frames advanced so far.</summary>
        public static long Count => FrameLoop.Instance.Frame;

        /// <summary>The game time: what the frames have advanced it by.</summary>
        public static TimeSpan Time => new TimeSpan(FrameLoop.Instance.Time);
    }
}

namespace Gameplay.Runtime
{
    // Work posted to the loop.
    internal abstract class FrameWork
    {
        internal abstract void Execute();
    }

    // A delay's or CancelAfter's timer, in game time; the loop's timers are
    // a list in the order they are due.
    internal sealed class FrameTimer
    {
        internal readonly long Due;
        private readonly Action<object?> callback;
        private readonly object? state;
        internal FrameTimer? Next;
        internal bool Stopped;

        internal FrameTimer(long due, Action<object?> callback, object? state)
        {
            Due = due;
            this.callback = callback;
            this.state = state;
        }

        internal void Stop()
        {
            if (!Stopped)
            {
                Stopped = true;
                FrameLoop.Instance.Remove(this);
            }
        }

        internal void Fire()
        {
            Stopped = true;
            callback(state);
        }
    }

    internal sealed class FrameLoop
    {
        private static FrameLoop? s_instance;

        internal static FrameLoop Instance => s_instance ??= new FrameLoop();

        // The current SynchronizationContext: the loop's, until code sets
        // another (or none).
        private static SynchronizationContext? s_current;
        private static bool s_currentSet;

        internal static SynchronizationContext? CurrentContext =>
            s_currentSet ? s_current : Instance.context;

        internal static void SetCurrentContext(SynchronizationContext? context)
        {
            s_current = context;
            s_currentSet = true;
        }

        internal static void RestoreContext(SynchronizationContext? context)
        {
            if (CurrentContext != context)
            {
                SetCurrentContext(context);
            }
        }

        private readonly FrameSynchronizationContext context = new FrameSynchronizationContext();
        // The posted work.
        private readonly FrameQueue work = new FrameQueue();
        // The tasks waiting for the next frame.
        private readonly FrameQueue nextFrame = new FrameQueue();
        private FrameTimer? timers;
        // The call depth of the frame running, or -1: a frame a trap
        // abandoned (a module recovering after traps goes on) is not one
        // running, since any call inside it would be deeper.
        private int runningDepth = -1;

        internal long Frame;
        internal long Time;

        internal static void Queue(FrameWork item) => Instance.work.Enqueue(item);

        // Whether what runs is what the CLR would run on its thread pool.
        internal static bool InPoolWork;

        internal static void Queue(Action action) => Instance.work.Enqueue(new ActionWork(action));

        // Waiting for a task that has not completed: the only thread would
        // wait for ever (the CLR's deadlocks), so the module faults.
        internal static void Deadlock() => Intrinsics.Trap(20);


        internal Task NextFrame()
        {
            var task = new Task();
            nextFrame.Enqueue(task);
            return task;
        }

        // Timers fire in the order they are due, and those due together in
        // the order they started.
        internal FrameTimer StartTimer(long ticks, Action<object?> callback, object? state)
        {
            var timer = new FrameTimer(Time + ticks, callback, state);
            if (timers is null || timers.Due > timer.Due)
            {
                timer.Next = timers;
                timers = timer;
                return timer;
            }

            var before = timers;
            while (before.Next is { } next && next.Due <= timer.Due)
            {
                before = next;
            }

            timer.Next = before.Next;
            before.Next = timer;
            return timer;
        }

        internal void Remove(FrameTimer timer)
        {
            if (timers == timer)
            {
                timers = timer.Next;
                return;
            }

            for (var before = timers; before is not null; before = before.Next)
            {
                if (before.Next == timer)
                {
                    before.Next = timer.Next;
                    return;
                }
            }
        }

        // Each waiting task, due timer and posted item is taken off its
        // queue before it runs, so what a trap interrupts is where the next
        // frame finds it.
        internal void Advance(TimeSpan elapsed)
        {
            int depth = Intrinsics.CallDepth();
            if (runningDepth >= 0 && depth > runningDepth)
            {
                throw new InvalidOperationException("Frames.Advance was called inside a frame.");
            }

            if (elapsed.Ticks < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(elapsed), SR.ArgumentOutOfRange_NeedNonNegNum);
            }

            runningDepth = depth;
            try
            {
                Frame++;
                Time += elapsed.Ticks;
                for (int waiting = nextFrame.Count; waiting > 0; waiting--)
                {
                    ((Task)nextFrame.Dequeue()).TrySetResult();
                }

                while (timers is { } timer && timer.Due <= Time)
                {
                    timers = timer.Next;
                    timer.Fire();
                }

                Drain();
            }
            finally
            {
                runningDepth = -1;
            }
        }

        // Runs what is posted until nothing is left, outside a frame: the
        // component model's async exports (ComponentTasks) run their
        // continuations so, in the call the host made.
        internal void RunPosted()
        {
            int depth = Intrinsics.CallDepth();
            if (runningDepth >= 0 && depth > runningDepth)
            {
                // Inside a frame, which runs it all anyway.
                return;
            }

            runningDepth = depth;
            try
            {
                Drain();
            }
            finally
            {
                runningDepth = -1;
            }
        }

        private void Drain()
        {
            while (work.Count > 0)
            {
                object item = work.Dequeue();
                if (item is PostedCallback posted)
                {
                    posted.Execute();
                    continue;
                }

                // What the CLR queues to its thread pool runs where no
                // SynchronizationContext is current, in the default
                // ExecutionContext (or the one it flows), as on a thread of
                // the pool.
                var current = s_current;
                bool set = s_currentSet;
                bool inPool = InPoolWork;
                SetCurrentContext(null);
                InPoolWork = true;
                object? executionContext = null;
                if (Intrinsics.FlowsExecutionContext())
                {
                    executionContext = ExecutionContext.s_current;
                    ExecutionContext.RestoreInternal(null);
                }

                try
                {
                    ((FrameWork)item).Execute();
                }
                finally
                {
                    s_current = current;
                    s_currentSet = set;
                    InPoolWork = inPool;
                    if (Intrinsics.FlowsExecutionContext())
                    {
                        ExecutionContext.RestoreInternal((ExecutionContext?)executionContext);
                    }
                }
            }
        }

        // Posting queues, sending runs now: the loop runs on the only
        // thread there is.
        private sealed class FrameSynchronizationContext : SynchronizationContext
        {
            public override void Post(SendOrPostCallback d, object? state)
            {
                ArgumentNullException.ThrowIfNull(d);
                Instance.work.Enqueue(new PostedCallback(d, state));
            }

            public override void Send(SendOrPostCallback d, object? state) => d(state);

            public override SynchronizationContext CreateCopy() => this;
        }
    }

    // A ring of objects, first in first out.
    internal sealed class FrameQueue
    {
        private object?[] items = new object?[8];
        private int head;
        private int count;

        internal int Count => count;

        internal void Enqueue(object item)
        {
            if (count == items.Length)
            {
                var grown = new object?[count * 2];
                for (int i = 0; i < count; i++)
                {
                    grown[i] = items[(head + i) % items.Length];
                }

                items = grown;
                head = 0;
            }

            items[(head + count) % items.Length] = item;
            count++;
        }

        internal object Dequeue()
        {
            var item = items[head]!;
            items[head] = null;
            head = (head + 1) % items.Length;
            count--;
            return item;
        }
    }

    internal sealed class ActionWork : FrameWork
    {
        private readonly Action action;

        internal ActionWork(Action action) => this.action = action;

        internal override void Execute() => action();

        // What escapes it is thrown again from the queue (a scheduler's
        // await continuation task, as the CLR's).
        internal void ExecuteCatching()
        {
            try
            {
                action();
            }
            catch (Exception exception)
            {
                Task.ThrowAsync(exception, null);
            }
        }
    }

    // The base SynchronizationContext's post: what the CLR queues to its
    // thread pool.
    internal sealed class PooledCallback : FrameWork
    {
        private readonly SendOrPostCallback callback;
        private readonly object? state;

        internal PooledCallback(SendOrPostCallback callback, object? state)
        {
            this.callback = callback;
            this.state = state;
        }

        internal override void Execute() => callback(state);
    }

    // Work posted to the loop's SynchronizationContext, which runs on the
    // loop's thread as it is.
    internal sealed class PostedCallback : FrameWork
    {
        private readonly SendOrPostCallback callback;
        private readonly object? state;

        internal PostedCallback(SendOrPostCallback callback, object? state)
        {
            this.callback = callback;
            this.state = state;
        }

        internal override void Execute() => callback(state);
    }
}

namespace System.Threading
{
    public delegate void SendOrPostCallback(object? state);

    // The base class posts to the frame loop, where the CLR's queues to its
    // thread pool.
    public class SynchronizationContext
    {
        private bool _requireWaitNotification;

        public SynchronizationContext()
        {
        }

        public static SynchronizationContext? Current => Gameplay.Runtime.FrameLoop.CurrentContext;

        public static void SetSynchronizationContext(SynchronizationContext? syncContext) =>
            Gameplay.Runtime.FrameLoop.SetCurrentContext(syncContext);

        protected void SetWaitNotificationRequired() => _requireWaitNotification = true;

        public bool IsWaitNotificationRequired() => _requireWaitNotification;

        public virtual void Send(SendOrPostCallback d, object? state) => d(state);

        public virtual void Post(SendOrPostCallback d, object? state) =>
            Gameplay.Runtime.FrameLoop.Queue(new Gameplay.Runtime.PooledCallback(d, state));

        public virtual void OperationStarted()
        {
        }

        public virtual void OperationCompleted()
        {
        }

        public virtual SynchronizationContext CreateCopy() => new SynchronizationContext();
    }
}
