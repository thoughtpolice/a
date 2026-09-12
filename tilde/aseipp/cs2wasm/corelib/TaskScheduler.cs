// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// TaskScheduler (docs/IMPORTER.md, "Async as built"), after dotnet/runtime's
// TaskScheduler.cs and ThreadPoolTaskScheduler.cs. The default scheduler is
// the frame loop's queue, which stands for the CLR's thread pool: what it
// queues runs from the queue, with no SynchronizationContext current, and a
// thread waiting for a task it queued runs the task itself, as nothing else
// would. TaskScheduler.Current is the scheduler of the delegate task
// running, as the CLR's; FromCurrentSynchronizationContext posts to the
// current context; and code's own schedulers queue and run tasks as they
// choose. UnobservedTaskException is left out: a module has no
// finalizers to find a task's exceptions unobserved, and no
// EventHandler<T>.

using System.Collections.Generic;
using Gameplay.Runtime;

namespace System.Threading.Tasks
{
    public abstract class TaskScheduler
    {
        private static readonly TaskScheduler s_defaultTaskScheduler = new ThreadPoolTaskScheduler();
        private static int s_taskSchedulerIdCounter;
        private int m_taskSchedulerId;

        protected TaskScheduler()
        {
        }

        protected internal abstract void QueueTask(Task task);

        protected abstract bool TryExecuteTaskInline(Task task, bool taskWasPreviouslyQueued);

        protected abstract IEnumerable<Task>? GetScheduledTasks();

        public virtual int MaximumConcurrencyLevel => int.MaxValue;

        protected internal virtual bool TryDequeue(Task task) => false;

        public static TaskScheduler Default => s_defaultTaskScheduler;

        public static TaskScheduler Current => InternalCurrent ?? Default;

        // The scheduler of the delegate task running, unless it hides it.
        internal static TaskScheduler? InternalCurrent =>
            Task.InternalCurrent is { } current && (current.CreationOptions & TaskCreationOptions.HideScheduler) == 0
                ? current.ExecutingTaskScheduler
                : null;

        public static TaskScheduler FromCurrentSynchronizationContext() => new SynchronizationContextTaskScheduler();

        public int Id
        {
            get
            {
                if (m_taskSchedulerId == 0)
                {
                    int id;
                    do
                    {
                        id = ++s_taskSchedulerIdCounter;
                    }
                    while (id == 0);
                    m_taskSchedulerId = id;
                }

                return m_taskSchedulerId;
            }
        }

        protected bool TryExecuteTask(Task task)
        {
            if (task.ExecutingTaskScheduler != this)
            {
                throw new InvalidOperationException(SR.TaskScheduler_ExecuteTask_WrongTaskScheduler);
            }

            return task.ExecuteEntry();
        }

        internal void InternalQueueTask(Task task) => QueueTask(task);

        // Runs a task here rather than where it was (or would be) queued,
        // if its scheduler lets it, as the CLR's: never a task not started,
        // run already or canceled, nor where the call-depth budget is
        // running out.
        internal bool TryRunInline(Task task, bool taskWasPreviouslyQueued)
        {
            var scheduler = task.ExecutingTaskScheduler;
            if (scheduler != this && scheduler is not null)
            {
                return scheduler.TryRunInline(task, taskWasPreviouslyQueued);
            }

            if (scheduler is null || !task.IsDelegateTask || task.IsDelegateInvoked || task.IsCanceled
                || Intrinsics.CallDepth() + 16 > Intrinsics.CallDepthLimit())
            {
                return false;
            }

            bool inlined = TryExecuteTaskInline(task, taskWasPreviouslyQueued);
            if (inlined && !(task.IsDelegateInvoked || task.IsCanceled))
            {
                throw new InvalidOperationException(SR.TaskScheduler_InconsistentStateAfterTryExecuteTaskInline);
            }

            return inlined;
        }
    }

    // The default scheduler: the frame loop's queue, the CLR's thread pool
    // here. A task a thread waits for runs inline whether it was queued or
    // not, since the queue's item, when the loop comes to it, finds it run.
    internal sealed class ThreadPoolTaskScheduler : TaskScheduler
    {
        protected internal override void QueueTask(Task task) => FrameLoop.Queue(new QueuedDelegateTask(task));

        protected override bool TryExecuteTaskInline(Task task, bool taskWasPreviouslyQueued) => TryExecuteTask(task);

        protected override IEnumerable<Task>? GetScheduledTasks() => null;
    }

    internal sealed class SynchronizationContextTaskScheduler : TaskScheduler
    {
        private readonly SynchronizationContext m_synchronizationContext;

        internal SynchronizationContextTaskScheduler()
        {
            m_synchronizationContext = SynchronizationContext.Current
                ?? throw new InvalidOperationException(SR.TaskScheduler_FromCurrentSynchronizationContext_NoCurrent);
        }

        protected internal override void QueueTask(Task task) =>
            m_synchronizationContext.Post(static state => ((Task)state!).ExecuteEntry(), task);

        protected override bool TryExecuteTaskInline(Task task, bool taskWasPreviouslyQueued) =>
            SynchronizationContext.Current == m_synchronizationContext && TryExecuteTask(task);

        protected override IEnumerable<Task>? GetScheduledTasks() => null;

        public override int MaximumConcurrencyLevel => 1;
    }

    public class TaskSchedulerException : Exception
    {
        public TaskSchedulerException()
            : base(SR.TaskSchedulerException_ctor_DefaultMessage)
        {
        }

        public TaskSchedulerException(string? message)
            : base(message)
        {
        }

        public TaskSchedulerException(Exception? innerException)
            : base(SR.TaskSchedulerException_ctor_DefaultMessage, innerException)
        {
        }

        public TaskSchedulerException(string? message, Exception? innerException)
            : base(message, innerException)
        {
        }
    }
}
