// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The component model's async functions (WASI 0.3's callback ABI), under the
// glue witgen generates (docs/WIT.md, "Async functions"). An
// async export is lifted with a callback: the host calls its
// `[async-lift]` function, which starts the gameplay method's task, and then
// its `[callback]` function with each event the task waits for, until the
// task has returned its result (`[task-return]`) and has nothing left to
// wait for. An async import is lowered: the call returns at once with the
// subtask's state, and a subtask that has not returned is joined to the
// component task's waitable set, whose events complete the Task the import
// returned. Each step runs what the frame loop has posted (continuations,
// Task.Yield) until nothing is left, then tells the host what the task
// waits for. The module has one thread and the host drives it, so which
// continuation runs when is the task library's, in the order the host
// delivers events.

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Gameplay.Runtime
{
    /// <summary>
    /// What witgen's glue for the component model's async functions calls.
    /// </summary>
    // A class of static members rather than a static class (see TaskCache).
    public sealed class ComponentTasks
    {
        private ComponentTasks()
        {
        }

        // The canonical ABI's codes.
        private const int EventNone = 0;
        private const int EventSubtask = 1;
        private const int EventStreamRead = 2;
        private const int EventFutureWrite = 5;
        private const int EventTaskCancelled = 6;
        private const int CallbackExit = 0;
        private const int CallbackYield = 1;
        private const int CallbackWait = 2;
        internal const int SubtaskStarting = 0;
        internal const int SubtaskStarted = 1;
        internal const int SubtaskReturned = 2;

        private static readonly List<ComponentTask> s_tasks = new List<ComponentTask>();
        private static readonly List<Waitable> s_waitables = new List<Waitable>();
        private static ComponentTask? s_current;
        private static int s_nextId;

        // The entries of async exports so far: memory an entry's arena
        // holds is free once another has started (see HeldMemory).
        internal static int Serial;

        /// <summary>
        /// The cancellation the host requests of the async export running:
        /// the token of the component task whose export or event is being
        /// handled, canceled when the host cancels that task.
        /// </summary>
        public static CancellationToken Cancellation
        {
            get
            {
                if (s_current is not { } task)
                {
                    return default;
                }

                task.Cancellation ??= new CancellationTokenSource();
                return task.Cancellation.Token;
            }
        }

        // MARK: Imports

        /// <summary>
        /// Memory for an async import's result, which the host writes when
        /// the subtask returns: it outlives the call.
        /// </summary>
        public static int ResultArea(int size, int alignment) => HeldMemory.Allocate(size, alignment);

        /// <summary>
        /// The task of an async-lowered import without a result, from the
        /// status it returned; <paramref name="mark"/> is where its arguments
        /// start in the arena.
        /// </summary>
        public static Task Lowered(int status, int mark)
        {
            if ((status & 0xf) == SubtaskReturned)
            {
                Canonical.Release(mark);
                return Task.CompletedTask;
            }

            var subtask = new VoidSubtask();
            Join(subtask, status, mark, 0);
            return subtask.Completion.Task;
        }

        /// <summary>
        /// The task of an async-lowered import with a result, which
        /// <paramref name="lift"/> reads from <paramref name="area"/> (see
        /// <see cref="ResultArea"/>) once the subtask has returned.
        /// </summary>
        public static Task<T> Lowered<T>(int status, int mark, int area, Func<int, T> lift) => Lowered(status, mark, area, lift, false);

        /// <summary>
        /// The same, for a result the host allocates strings or lists of
        /// (<paramref name="hostMemory"/>): until it returns, what the host
        /// allocates is held (see HeldMemory), and the lift frees what it
        /// reads (<see cref="Consumed"/>).
        /// </summary>
        public static Task<T> Lowered<T>(int status, int mark, int area, Func<int, T> lift, bool hostMemory)
        {
            if ((status & 0xf) == SubtaskReturned)
            {
                var value = lift(area);
                HeldMemory.Free(area);
                Canonical.Release(mark);
                return Task.FromResult(value);
            }

            var subtask = new ResultSubtask<T>(lift);
            if (hostMemory)
            {
                subtask.HoldsHostMemory = true;
                HeldMemory.HoldHost();
            }

            Join(subtask, status, mark, area);
            return subtask.Completion.Task;
        }

        /// <summary>
        /// The glue read the string or list the host allocated at
        /// <paramref name="pointer"/>: where it is held memory (see
        /// HeldMemory), it is free again.
        /// </summary>
        public static void Consumed(int pointer) => HeldMemory.Consume(pointer);

        // A subtask that has not returned waits in its component task's
        // set; the arguments stay in memory until it has started.
        private static void Join(Subtask subtask, int status, int mark, int area)
        {
            if (s_current is not { } task)
            {
                throw new InvalidOperationException("An async import that has not returned needs an async export's task to wait in.");
            }

            subtask.Owner = task;
            subtask.Handle = (int)((uint)status >> 4);
            subtask.Area = area;
            if ((status & 0xf) == SubtaskStarting)
            {
                subtask.Arguments = HeldMemory.HoldArena(mark);
            }
            else
            {
                Canonical.Release(mark);
            }

            Wait(subtask);
        }

        // A waitable (a subtask, or a future's or stream's end with a copy
        // pending) joins the running component task's set: the task waits
        // for its event.
        internal static void Wait(Waitable waitable)
        {
            if (s_current is not { } task)
            {
                throw new InvalidOperationException("Waiting for the host needs an async export's task to wait in.");
            }

            waitable.Owner = task;
            if (task.Set == 0)
            {
                task.Set = WaitableSetNew();
            }

            WaitableJoin(waitable.Handle, task.Set);
            task.Pending++;
            s_waitables.Add(waitable);
        }

        // Its event came, or it is over without one: it leaves the set.
        internal static void Done(Waitable waitable, bool subtask)
        {
            s_waitables.Remove(waitable);
            if (subtask)
            {
                SubtaskDrop(waitable.Handle);
            }
            else
            {
                WaitableJoin(waitable.Handle, 0);
            }

            waitable.Owner!.Pending--;
            waitable.Owner = null;
        }

        // MARK: Futures and streams

        /// <summary>A new stream (`stream.new`): both its ends.</summary>
        public static (StreamReader<T> Reader, StreamWriter<T> Writer) NewStream<T>(ChannelOps<T> ops)
        {
            long ends = ops.New();
            return (new StreamReader<T>((int)ends, ops), new StreamWriter<T>((int)(ends >> 32), ops));
        }

        /// <summary>A new future (`future.new`): both its ends.</summary>
        public static (FutureReader<T> Reader, FutureWriter<T> Writer) NewFuture<T>(ChannelOps<T> ops)
        {
            long ends = ops.New();
            return (new FutureReader<T>((int)ends, ops), new FutureWriter<T>((int)(ends >> 32), ops));
        }

        /// <summary>The readable end the host handed over.</summary>
        public static StreamReader<T> LiftStream<T>(int handle, ChannelOps<T> ops) => new StreamReader<T>(handle, ops);

        /// <summary>The readable end the host handed over.</summary>
        public static FutureReader<T> LiftFuture<T>(int handle, ChannelOps<T> ops) => new FutureReader<T>(handle, ops);

        /// <summary>The readable end handed to the host, which the object no longer holds.</summary>
        public static int LowerStream<T>(StreamReader<T> reader) => reader.Give();

        /// <summary>The readable end handed to the host, which the object no longer holds.</summary>
        public static int LowerFuture<T>(FutureReader<T> reader) => reader.Give();

        // MARK: Exports

        /// <summary>
        /// An async export was called: the task its method starts belongs to
        /// a new component task.
        /// </summary>
        public static void Begin()
        {
            Serial++;
            var task = new ComponentTask(++s_nextId);
            s_tasks.Add(task);
            ContextSet(task.Id);
            s_current = task;
        }

        /// <summary>
        /// The async export's method returned <paramref name="started"/>,
        /// whose result <paramref name="taskReturn"/> hands to the host
        /// (`task.return`); what the host is to do next.
        /// </summary>
        public static int Started<T>(Task<T> started, Action<T> taskReturn)
        {
            var task = s_current!;
            task.User = started;
            task.Returner = new ResultReturner<T>(taskReturn);
            return Step(task);
        }

        /// <summary>The same, for a method without a result.</summary>
        public static int Started(Task started, Action taskReturn)
        {
            var task = s_current!;
            task.User = started;
            task.Returner = new VoidReturner(taskReturn);
            return Step(task);
        }

        /// <summary>
        /// The export's callback: an event for the component task, then
        /// what the host is to do next.
        /// </summary>
        public static int Callback(int eventCode, int waitable, int code)
        {
            Serial++;
            var task = Find(ContextGet());
            s_current = task;
            switch (eventCode)
            {
                case EventNone:
                    break;
                case EventSubtask:
                    ((Subtask)FindWaitable(waitable)).Progress(code);
                    break;
                case >= EventStreamRead and <= EventFutureWrite:
                    FindWaitable(waitable).Event(code);
                    break;
                case EventTaskCancelled:
                    task.CancelRequested = true;
                    task.Cancellation?.Cancel();
                    break;
                default:
                    throw new NotSupportedException("The event is unsupported.");
            }

            return Step(task);
        }

        // Runs what is posted, returns the task's result once it has one,
        // and says what the task waits for: its subtasks (WAIT on its set;
        // a result that came meanwhile from other work is returned at the
        // next of their events), or, with none, work the host has yet to
        // give the module, another export's call (YIELD, to be called back
        // once the host has run what else is ready).
        private static int Step(ComponentTask task)
        {
            s_current = task;
            try
            {
                FrameLoop.Instance.RunPosted();
                if (!task.Returned && task.User!.IsCompleted)
                {
                    task.Returned = true;
                    if (task.User.IsCanceled && task.CancelRequested)
                    {
                        TaskCancel();
                    }
                    else
                    {
                        task.Returner!.Return(task.User);
                    }
                }
            }
            finally
            {
                s_current = null;
            }

            if (task.Pending > 0)
            {
                return CallbackWait | (task.Set << 4);
            }

            if (task.Returned)
            {
                if (task.Set != 0)
                {
                    WaitableSetDrop(task.Set);
                }

                s_tasks.Remove(task);
                ContextSet(0);
                return CallbackExit;
            }

            return CallbackYield;
        }

        private static ComponentTask Find(int id)
        {
            foreach (var task in s_tasks)
            {
                if (task.Id == id)
                {
                    return task;
                }
            }

            throw new InvalidOperationException("The callback's component task is unknown.");
        }

        private static Waitable FindWaitable(int handle)
        {
            foreach (var waitable in s_waitables)
            {
                if (waitable.Handle == handle && waitable.Owner is not null)
                {
                    return waitable;
                }
            }

            throw new InvalidOperationException("The event's waitable is unknown.");
        }

        internal static void Resolved(Subtask subtask) => Done(subtask, true);

        // MARK: The canonical built-ins

        [HostImport("$root", "[waitable-set-new]")]
        private static extern int WaitableSetNew();

        [HostImport("$root", "[waitable-set-drop]")]
        private static extern void WaitableSetDrop(int set);

        [HostImport("$root", "[waitable-join]")]
        private static extern void WaitableJoin(int waitable, int set);

        [HostImport("$root", "[subtask-drop]")]
        private static extern void SubtaskDrop(int subtask);

        [HostImport("$root", "[context-get-0]")]
        private static extern int ContextGet();

        [HostImport("$root", "[context-set-0]")]
        private static extern void ContextSet(int value);

        [HostImport("[export]$root", "[task-cancel]")]
        private static extern void TaskCancel();
    }

    // An async export's call: the task of the method it started, and the
    // subtasks of the imports called while it (or anything) ran in its
    // steps, whose events come to its callback.
    internal sealed class ComponentTask
    {
        internal readonly int Id;
        internal int Set;
        internal int Pending;
        internal Task? User;
        internal TaskReturner? Returner;
        internal bool Returned;
        internal bool CancelRequested;
        internal CancellationTokenSource? Cancellation;

        internal ComponentTask(int id) => Id = id;
    }

    // Hands the method's result to the host (`task.return`), or throws what
    // failed it, which ends the export's call with the exception's fault.
    internal abstract class TaskReturner
    {
        internal abstract void Return(Task task);
    }

    internal sealed class ResultReturner<T> : TaskReturner
    {
        private readonly Action<T> taskReturn;

        internal ResultReturner(Action<T> taskReturn) => this.taskReturn = taskReturn;

        internal override void Return(Task task) => taskReturn(((Task<T>)task).GetAwaiter().GetResult());
    }

    internal sealed class VoidReturner : TaskReturner
    {
        private readonly Action taskReturn;

        internal VoidReturner(Action taskReturn) => this.taskReturn = taskReturn;

        internal override void Return(Task task)
        {
            task.GetAwaiter().GetResult();
            taskReturn();
        }
    }

    // What a component task waits for: a subtask, or a future's or
    // stream's end with a copy pending, whose events come to its callback.
    internal abstract class Waitable
    {
        internal ComponentTask? Owner;
        internal int Handle;

        // A future's or stream's copy: its event's code.
        internal virtual void Event(int code) => throw new InvalidOperationException("The event is not the waitable's.");
    }

    // An async import's call the host has not returned from.
    internal abstract class Subtask : Waitable
    {
        internal int Area;
        // The arguments held in memory until the subtask starts, or 0.
        internal int Arguments;

        internal void Progress(int state)
        {
            if (Arguments != 0 && state >= ComponentTasks.SubtaskStarted)
            {
                HeldMemory.Free(Arguments);
                Arguments = 0;
            }

            if (state == ComponentTasks.SubtaskReturned)
            {
                ComponentTasks.Resolved(this);
                Returned();
            }
            else if (state != ComponentTasks.SubtaskStarted)
            {
                throw new InvalidOperationException("A subtask that was never canceled was canceled.");
            }
        }

        protected abstract void Returned();
    }

    internal sealed class VoidSubtask : Subtask
    {
        internal readonly TaskCompletionSource Completion = new TaskCompletionSource();

        protected override void Returned() => Completion.SetResult();
    }

    internal sealed class ResultSubtask<T> : Subtask
    {
        private readonly Func<int, T> lift;
        internal readonly TaskCompletionSource<T> Completion = new TaskCompletionSource<T>();
        internal bool HoldsHostMemory;

        internal ResultSubtask(Func<int, T> lift) => this.lift = lift;

        protected override void Returned()
        {
            var value = lift(Area);
            HeldMemory.Free(Area);
            if (HoldsHostMemory)
            {
                HeldMemory.ReleaseHost();
            }

            Completion.SetResult(value);
        }
    }

    // Memory that outlives the entry that allocated it: results the host
    // writes when a subtask returns, arguments until it starts, and, while
    // an operation is pending whose results hold strings or lists (which
    // the host allocates, with cabi_realloc, whenever it completes it), every
    // block the host allocates: cabi_realloc puts those below the floor
    // too, chaining their headers from __host_chain, and the CoreLib adopts
    // them into its blocks, freeing each once the glue has read it
    // (Consume); an export's arguments included, which the host may
    // allocate there meanwhile. The
    // boundary memory is an arena its outermost entry empties (see the
    // compiler's Frontend.Memory), down to its floor; held blocks live
    // below the floor, which rises over a block allocated at the arena's
    // end and falls when the highest one is freed. What an entry's arena
    // held below a block it raised the floor over is free once the entry is
    // over (another async export's entry has started); freed blocks are
    // used again, first fit, before the floor rises.
    internal sealed class HeldMemory
    {
        private HeldMemory()
        {
        }

        private const int FreeState = 0;
        private const int LiveState = 1;
        private const int PendingState = 2;

        // The blocks between the arena's first floor and its floor, in
        // address order, tiling it.
        private static readonly List<HeldBlock> s_blocks = new List<HeldBlock>();

        // The operations pending whose results the host allocates, and the
        // floor from which blocks start when there are none.
        private static int s_hostHolders;
        private static int s_base;

        // An operation whose results the host allocates is pending.
        internal static void HoldHost()
        {
            if (s_hostHolders++ == 0)
            {
                Normalize();
                if (s_blocks.Count == 0)
                {
                    s_base = Memory.Floor();
                }

                Memory.SetHostChain(1);
            }
        }

        // It is over.
        internal static void ReleaseHost()
        {
            if (--s_hostHolders == 0)
            {
                Adopt();
                Memory.SetHostChain(0);
                Normalize();
            }
        }

        // The blocks cabi_realloc gave the host since the last adoption,
        // each after a header (its address, its end, the previous header,
        // whether an entry was running; the chain ends at 1), become live
        // blocks. The arena below each is the running entry's, pending until
        // it is over, or, between entries, the last one's, which is free.
        private static void Adopt()
        {
            int chain = Memory.HostChain();
            if (chain <= 1)
            {
                return;
            }

            var headers = new List<int>();
            for (int header = chain; header != 1; header = Memory.Load32(header + 8))
            {
                headers.Add(header);
            }

            Memory.SetHostChain(1);
            int top = s_blocks.Count > 0 ? s_blocks[s_blocks.Count - 1].End : s_base;
            for (int index = headers.Count - 1; index >= 0; index--)
            {
                int start = headers[index];
                if (start > top)
                {
                    bool running = Memory.Load32(start + 12) != 0;
                    s_blocks.Add(new HeldBlock(top, start, running ? PendingState : FreeState) { Serial = ComponentTasks.Serial });
                }

                int end = Memory.Load32(start + 4);
                s_blocks.Add(new HeldBlock(start, end, LiveState) { Pointer = Memory.Load32(start) });
                top = end;
            }
        }

        // The glue read the host's block at `pointer`; nothing when the host
        // allocated it in the arena.
        internal static void Consume(int pointer)
        {
            Adopt();
            foreach (var block in s_blocks)
            {
                if (block.Pointer == pointer && block.State == LiveState)
                {
                    block.State = FreeState;
                    block.Pointer = 0;
                    Normalize();
                    return;
                }
            }
        }

        internal static int Allocate(int size, int alignment)
        {
            Normalize();
            for (int index = 0; index < s_blocks.Count; index++)
            {
                var block = s_blocks[index];
                if (block.State != FreeState)
                {
                    continue;
                }

                int start = (block.Start + alignment - 1) & -alignment;
                if (start + size > block.End)
                {
                    continue;
                }

                // [block.Start, start) and [start + size, block.End) stay free.
                if (start + size < block.End)
                {
                    s_blocks.Insert(index + 1, new HeldBlock(start + size, block.End, FreeState));
                }

                if (start > block.Start)
                {
                    block.End = start;
                    s_blocks.Insert(index + 1, new HeldBlock(start, start + size, LiveState));
                }
                else
                {
                    block.End = start + size;
                    block.State = LiveState;
                }

                return start;
            }

            int floor = Memory.Floor();
            int address = Memory.Allocate(size, alignment);
            Raise(floor, address, address + size);
            return address;
        }

        // Holds what the arena has from `mark` to its end; 0 when that is
        // nothing.
        internal static int HoldArena(int mark)
        {
            Adopt();
            int top = Memory.Top();
            if (top == mark)
            {
                return 0;
            }

            Raise(Memory.Floor(), mark, top);
            return mark;
        }

        // A live block [start, end) at the arena's end; the entry's arena
        // below it is pending.
        private static void Raise(int floor, int start, int end)
        {
            if (start > floor)
            {
                s_blocks.Add(new HeldBlock(floor, start, PendingState) { Serial = ComponentTasks.Serial });
            }

            s_blocks.Add(new HeldBlock(start, end, LiveState));
            Memory.SetFloor(end);
        }

        internal static void Free(int start)
        {
            foreach (var block in s_blocks)
            {
                if (block.Start == start && block.State == LiveState)
                {
                    block.State = FreeState;
                    Normalize();
                    return;
                }
            }

            throw new InvalidOperationException("Freeing memory that is not held.");
        }

        // Pending blocks of entries that are over are free; free neighbours
        // merge; free blocks at the end lower the floor.
        private static void Normalize()
        {
            Adopt();
            for (int index = 0; index < s_blocks.Count; index++)
            {
                var block = s_blocks[index];
                if (block.State == PendingState && block.Serial != ComponentTasks.Serial)
                {
                    block.State = FreeState;
                }

                if (block.State == FreeState && index > 0 && s_blocks[index - 1].State == FreeState)
                {
                    s_blocks[index - 1].End = block.End;
                    s_blocks.RemoveAt(index);
                    index--;
                }
            }

            if (s_blocks.Count > 0 && s_blocks[s_blocks.Count - 1] is { State: FreeState } last)
            {
                s_blocks.RemoveAt(s_blocks.Count - 1);
                Memory.SetFloor(last.Start);
                if (s_blocks.Count == 0)
                {
                    s_base = last.Start;
                }
            }
        }
    }

    internal sealed class HeldBlock
    {
        internal int Start;
        internal int End;
        internal int State;
        internal int Serial;

        // A live block of the host's: the address cabi_realloc returned.
        internal int Pointer;

        internal HeldBlock(int start, int end, int state)
        {
            Start = start;
            End = end;
            State = state;
        }
    }
}
