// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Task.ContinueWith, after dotnet/runtime's Task.cs and TaskContinuation.cs
// (docs/IMPORTER.md, "Async"): the continuation is a delegate task of its
// own (corelib/DelegateTasks.cs) that runs once the antecedent completes,
// on the scheduler it was given (TaskScheduler.Current by default; the
// frame loop's queue, the CLR's thread pool, in a module without
// schedulers), inline when it asked to run synchronously and the
// scheduler lets it; the options that exclude a kind of completion cancel
// it instead, as does its token.

using System.Threading;
using System.Threading.Tasks;
using Gameplay.Runtime;

namespace System.Threading.Tasks
{
    public partial class Task
    {
        public Task ContinueWith(Action<Task> continuationAction) =>
            ContinueAction(continuationAction, CurrentScheduler(), default, TaskContinuationOptions.None);

        public Task ContinueWith(Action<Task> continuationAction, CancellationToken cancellationToken) =>
            ContinueAction(continuationAction, CurrentScheduler(), cancellationToken, TaskContinuationOptions.None);

        public Task ContinueWith(Action<Task> continuationAction, TaskContinuationOptions continuationOptions) =>
            ContinueAction(continuationAction, CurrentScheduler(), default, continuationOptions);

        public Task ContinueWith(Action<Task> continuationAction, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueAction(continuationAction, scheduler, default, TaskContinuationOptions.None);
        }

        public Task ContinueWith(
            Action<Task> continuationAction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueAction(continuationAction, scheduler, cancellationToken, continuationOptions);
        }

        private Task ContinueAction(
            Action<Task> continuationAction, object? scheduler, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            var task = new ContinueWithTask(this, continuationAction, null, null, ContinuationCreationOptions(continuationOptions));
            ContinueWithCore(task, scheduler, cancellationToken, continuationOptions);
            return task;
        }

        public Task ContinueWith(Action<Task, object?> continuationAction, object? state) =>
            ContinueStateAction(continuationAction, state, CurrentScheduler(), default, TaskContinuationOptions.None);

        public Task ContinueWith(Action<Task, object?> continuationAction, object? state, CancellationToken cancellationToken) =>
            ContinueStateAction(continuationAction, state, CurrentScheduler(), cancellationToken, TaskContinuationOptions.None);

        public Task ContinueWith(Action<Task, object?> continuationAction, object? state, TaskContinuationOptions continuationOptions) =>
            ContinueStateAction(continuationAction, state, CurrentScheduler(), default, continuationOptions);

        public Task ContinueWith(Action<Task, object?> continuationAction, object? state, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueStateAction(continuationAction, state, scheduler, default, TaskContinuationOptions.None);
        }

        public Task ContinueWith(
            Action<Task, object?> continuationAction, object? state, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueStateAction(continuationAction, state, scheduler, cancellationToken, continuationOptions);
        }

        private Task ContinueStateAction(
            Action<Task, object?> continuationAction, object? state, object? scheduler, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            var task = new ContinueWithTask(this, null, continuationAction, state, ContinuationCreationOptions(continuationOptions));
            ContinueWithCore(task, scheduler, cancellationToken, continuationOptions);
            return task;
        }

        public Task<TResult> ContinueWith<TResult>(Func<Task, TResult> continuationFunction) =>
            ContinueFunction(continuationFunction, CurrentScheduler(), default, TaskContinuationOptions.None);

        public Task<TResult> ContinueWith<TResult>(Func<Task, TResult> continuationFunction, CancellationToken cancellationToken) =>
            ContinueFunction(continuationFunction, CurrentScheduler(), cancellationToken, TaskContinuationOptions.None);

        public Task<TResult> ContinueWith<TResult>(Func<Task, TResult> continuationFunction, TaskContinuationOptions continuationOptions) =>
            ContinueFunction(continuationFunction, CurrentScheduler(), default, continuationOptions);

        public Task<TResult> ContinueWith<TResult>(Func<Task, TResult> continuationFunction, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueFunction(continuationFunction, scheduler, default, TaskContinuationOptions.None);
        }

        public Task<TResult> ContinueWith<TResult>(
            Func<Task, TResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueFunction(continuationFunction, scheduler, cancellationToken, continuationOptions);
        }

        private Task<TResult> ContinueFunction<TResult>(
            Func<Task, TResult> continuationFunction, object? scheduler, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            var task = new ContinueWithTask<TResult>(this, continuationFunction, null, null, ContinuationCreationOptions(continuationOptions));
            ContinueWithCore(task, scheduler, cancellationToken, continuationOptions);
            return task;
        }

        public Task<TResult> ContinueWith<TResult>(Func<Task, object?, TResult> continuationFunction, object? state) =>
            ContinueStateFunction(continuationFunction, state, CurrentScheduler(), default, TaskContinuationOptions.None);

        public Task<TResult> ContinueWith<TResult>(Func<Task, object?, TResult> continuationFunction, object? state, CancellationToken cancellationToken) =>
            ContinueStateFunction(continuationFunction, state, CurrentScheduler(), cancellationToken, TaskContinuationOptions.None);

        public Task<TResult> ContinueWith<TResult>(Func<Task, object?, TResult> continuationFunction, object? state, TaskContinuationOptions continuationOptions) =>
            ContinueStateFunction(continuationFunction, state, CurrentScheduler(), default, continuationOptions);

        public Task<TResult> ContinueWith<TResult>(Func<Task, object?, TResult> continuationFunction, object? state, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueStateFunction(continuationFunction, state, scheduler, default, TaskContinuationOptions.None);
        }

        public Task<TResult> ContinueWith<TResult>(
            Func<Task, object?, TResult> continuationFunction, object? state, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueStateFunction(continuationFunction, state, scheduler, cancellationToken, continuationOptions);
        }

        private Task<TResult> ContinueStateFunction<TResult>(
            Func<Task, object?, TResult> continuationFunction, object? state, object? scheduler, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            var task = new ContinueWithTask<TResult>(this, null, continuationFunction, state, ContinuationCreationOptions(continuationOptions));
            ContinueWithCore(task, scheduler, cancellationToken, continuationOptions);
            return task;
        }

        // The creation options a continuation's options carry, checked as
        // the CLR checks them.
        internal static TaskCreationOptions ContinuationCreationOptions(TaskContinuationOptions continuationOptions)
        {
            const TaskContinuationOptions NotOnAnything =
                TaskContinuationOptions.NotOnCanceled | TaskContinuationOptions.NotOnFaulted | TaskContinuationOptions.NotOnRanToCompletion;
            const TaskContinuationOptions CreationOptionsMask =
                TaskContinuationOptions.PreferFairness | TaskContinuationOptions.LongRunning | TaskContinuationOptions.DenyChildAttach
                | TaskContinuationOptions.HideScheduler | TaskContinuationOptions.AttachedToParent
                | TaskContinuationOptions.RunContinuationsAsynchronously;
            const TaskContinuationOptions IllegalMask = TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.LongRunning;
            if ((continuationOptions & IllegalMask) == IllegalMask)
            {
                throw new ArgumentOutOfRangeException(nameof(continuationOptions), SR.Task_ContinueWith_ESandLR);
            }

            if ((continuationOptions & ~(CreationOptionsMask | NotOnAnything | TaskContinuationOptions.LazyCancellation
                                         | TaskContinuationOptions.ExecuteSynchronously)) != 0)
            {
                throw new ArgumentOutOfRangeException(nameof(continuationOptions));
            }

            if ((continuationOptions & NotOnAnything) == NotOnAnything)
            {
                throw new ArgumentOutOfRangeException(nameof(continuationOptions), SR.Task_ContinueWith_NotOnAnything);
            }

            return (TaskCreationOptions)(continuationOptions & CreationOptionsMask);
        }

        internal void ContinueWithCore(Task continuationTask, object? scheduler, CancellationToken cancellationToken, TaskContinuationOptions options)
        {
            // Its delegate runs in the ExecutionContext current now.
            if (Gameplay.Runtime.Intrinsics.FlowsExecutionContext())
            {
                continuationTask.m_capturedContext = ExecutionContext.Capture();
            }

            var continuation = new ContinueWithTaskContinuation(continuationTask, options, scheduler);
            if (cancellationToken.CanBeCanceled)
            {
                continuationTask.m_cancellationToken = cancellationToken;
                if ((options & TaskContinuationOptions.LazyCancellation) == 0)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        continuationTask.InternalCancel();
                    }
                    else
                    {
                        continuationTask.m_cancellationRegistration = cancellationToken.UnsafeRegister(
                            static state => ((ContinueWithTaskContinuation)state!).Cancel(),
                            continuation.WithAntecedent(IsCompleted ? null : this));
                    }
                }
            }

            if (!continuationTask.IsCompleted && !AddTaskContinuation(continuation))
            {
                continuation.Run(this, true);
            }
        }

        private CancellationTokenRegistration m_cancellationRegistration;
    }

    internal sealed class ContinueWithTask : Task
    {
        private readonly Task antecedent;
        private readonly Action<Task>? action;
        private readonly Action<Task, object?>? actionWithState;

        internal ContinueWithTask(Task antecedent, Action<Task>? action, Action<Task, object?>? actionWithState, object? state, TaskCreationOptions options)
        {
            this.antecedent = antecedent;
            this.action = action;
            this.actionWithState = actionWithState;
            m_stateObject = state;
            m_options = options;
            InitializeContinuationTask(options);
        }

        internal override void InvokeDelegate()
        {
            if (action is not null)
            {
                action(antecedent);
            }
            else
            {
                actionWithState!(antecedent, m_stateObject);
            }
        }
    }

    internal sealed class ContinueWithTask<TResult> : Task<TResult>
    {
        private readonly Task antecedent;
        private readonly Func<Task, TResult>? function;
        private readonly Func<Task, object?, TResult>? functionWithState;

        internal ContinueWithTask(Task antecedent, Func<Task, TResult>? function, Func<Task, object?, TResult>? functionWithState, object? state, TaskCreationOptions options)
        {
            this.antecedent = antecedent;
            this.function = function;
            this.functionWithState = functionWithState;
            m_stateObject = state;
            m_options = options;
            InitializeContinuationTask(options);
        }

        internal override void InvokeDelegate() =>
            m_result = function is not null ? function(antecedent) : functionWithState!(antecedent, m_stateObject);
    }

    internal sealed class ContinueWithResultTask<TAntecedentResult> : Task
    {
        private readonly Task<TAntecedentResult> antecedent;
        private readonly Action<Task<TAntecedentResult>>? action;
        private readonly Action<Task<TAntecedentResult>, object?>? actionWithState;

        internal ContinueWithResultTask(
            Task<TAntecedentResult> antecedent, Action<Task<TAntecedentResult>>? action, Action<Task<TAntecedentResult>, object?>? actionWithState,
            object? state, TaskCreationOptions options)
        {
            this.antecedent = antecedent;
            this.action = action;
            this.actionWithState = actionWithState;
            m_stateObject = state;
            m_options = options;
            InitializeContinuationTask(options);
        }

        internal override void InvokeDelegate()
        {
            if (action is not null)
            {
                action(antecedent);
            }
            else
            {
                actionWithState!(antecedent, m_stateObject);
            }
        }
    }

    internal sealed class ContinueWithResultTask<TAntecedentResult, TResult> : Task<TResult>
    {
        private readonly Task<TAntecedentResult> antecedent;
        private readonly Func<Task<TAntecedentResult>, TResult>? function;
        private readonly Func<Task<TAntecedentResult>, object?, TResult>? functionWithState;

        internal ContinueWithResultTask(
            Task<TAntecedentResult> antecedent, Func<Task<TAntecedentResult>, TResult>? function,
            Func<Task<TAntecedentResult>, object?, TResult>? functionWithState, object? state, TaskCreationOptions options)
        {
            this.antecedent = antecedent;
            this.function = function;
            this.functionWithState = functionWithState;
            m_stateObject = state;
            m_options = options;
            InitializeContinuationTask(options);
        }

        internal override void InvokeDelegate() =>
            m_result = function is not null ? function(antecedent) : functionWithState!(antecedent, m_stateObject);
    }

    public partial class Task<TResult>
    {
        public Task ContinueWith(Action<Task<TResult>> continuationAction) =>
            ContinueAction(continuationAction, CurrentScheduler(), default, TaskContinuationOptions.None);

        public Task ContinueWith(Action<Task<TResult>> continuationAction, CancellationToken cancellationToken) =>
            ContinueAction(continuationAction, CurrentScheduler(), cancellationToken, TaskContinuationOptions.None);

        public Task ContinueWith(Action<Task<TResult>> continuationAction, TaskContinuationOptions continuationOptions) =>
            ContinueAction(continuationAction, CurrentScheduler(), default, continuationOptions);

        public Task ContinueWith(Action<Task<TResult>> continuationAction, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueAction(continuationAction, scheduler, default, TaskContinuationOptions.None);
        }

        public Task ContinueWith(
            Action<Task<TResult>> continuationAction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueAction(continuationAction, scheduler, cancellationToken, continuationOptions);
        }

        private Task ContinueAction(
            Action<Task<TResult>> continuationAction, object? scheduler, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            var task = new ContinueWithResultTask<TResult>(this, continuationAction, null, null, ContinuationCreationOptions(continuationOptions));
            ContinueWithCore(task, scheduler, cancellationToken, continuationOptions);
            return task;
        }

        public Task ContinueWith(Action<Task<TResult>, object?> continuationAction, object? state) =>
            ContinueStateAction(continuationAction, state, CurrentScheduler(), default, TaskContinuationOptions.None);

        public Task ContinueWith(Action<Task<TResult>, object?> continuationAction, object? state, CancellationToken cancellationToken) =>
            ContinueStateAction(continuationAction, state, CurrentScheduler(), cancellationToken, TaskContinuationOptions.None);

        public Task ContinueWith(Action<Task<TResult>, object?> continuationAction, object? state, TaskContinuationOptions continuationOptions) =>
            ContinueStateAction(continuationAction, state, CurrentScheduler(), default, continuationOptions);

        public Task ContinueWith(Action<Task<TResult>, object?> continuationAction, object? state, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueStateAction(continuationAction, state, scheduler, default, TaskContinuationOptions.None);
        }

        public Task ContinueWith(
            Action<Task<TResult>, object?> continuationAction, object? state, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueStateAction(continuationAction, state, scheduler, cancellationToken, continuationOptions);
        }

        private Task ContinueStateAction(
            Action<Task<TResult>, object?> continuationAction, object? state, object? scheduler, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            var task = new ContinueWithResultTask<TResult>(this, null, continuationAction, state, ContinuationCreationOptions(continuationOptions));
            ContinueWithCore(task, scheduler, cancellationToken, continuationOptions);
            return task;
        }

        public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, TNewResult> continuationFunction) =>
            ContinueFunction(continuationFunction, CurrentScheduler(), default, TaskContinuationOptions.None);

        public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, TNewResult> continuationFunction, CancellationToken cancellationToken) =>
            ContinueFunction(continuationFunction, CurrentScheduler(), cancellationToken, TaskContinuationOptions.None);

        public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, TNewResult> continuationFunction, TaskContinuationOptions continuationOptions) =>
            ContinueFunction(continuationFunction, CurrentScheduler(), default, continuationOptions);

        public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, TNewResult> continuationFunction, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueFunction(continuationFunction, scheduler, default, TaskContinuationOptions.None);
        }

        public Task<TNewResult> ContinueWith<TNewResult>(
            Func<Task<TResult>, TNewResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueFunction(continuationFunction, scheduler, cancellationToken, continuationOptions);
        }

        private Task<TNewResult> ContinueFunction<TNewResult>(
            Func<Task<TResult>, TNewResult> continuationFunction, object? scheduler, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            var task = new ContinueWithResultTask<TResult, TNewResult>(this, continuationFunction, null, null, ContinuationCreationOptions(continuationOptions));
            ContinueWithCore(task, scheduler, cancellationToken, continuationOptions);
            return task;
        }

        public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, object?, TNewResult> continuationFunction, object? state) =>
            ContinueStateFunction(continuationFunction, state, CurrentScheduler(), default, TaskContinuationOptions.None);

        public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, object?, TNewResult> continuationFunction, object? state, CancellationToken cancellationToken) =>
            ContinueStateFunction(continuationFunction, state, CurrentScheduler(), cancellationToken, TaskContinuationOptions.None);

        public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, object?, TNewResult> continuationFunction, object? state, TaskContinuationOptions continuationOptions) =>
            ContinueStateFunction(continuationFunction, state, CurrentScheduler(), default, continuationOptions);

        public Task<TNewResult> ContinueWith<TNewResult>(Func<Task<TResult>, object?, TNewResult> continuationFunction, object? state, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueStateFunction(continuationFunction, state, scheduler, default, TaskContinuationOptions.None);
        }

        public Task<TNewResult> ContinueWith<TNewResult>(
            Func<Task<TResult>, object?, TNewResult> continuationFunction, object? state, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            ArgumentNullException.ThrowIfNull(scheduler);
            return ContinueStateFunction(continuationFunction, state, scheduler, cancellationToken, continuationOptions);
        }

        private Task<TNewResult> ContinueStateFunction<TNewResult>(
            Func<Task<TResult>, object?, TNewResult> continuationFunction, object? state, object? scheduler, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            var task = new ContinueWithResultTask<TResult, TNewResult>(this, null, continuationFunction, state, ContinuationCreationOptions(continuationOptions));
            ContinueWithCore(task, scheduler, cancellationToken, continuationOptions);
            return task;
        }
    }

    // ContinueWith's: on the antecedent's completion, starts its task on
    // its scheduler (inline when it asked to run synchronously and the
    // scheduler lets it, else queued), or cancels it if the options exclude
    // that kind of completion.
    internal sealed class ContinueWithTaskContinuation : TaskContinuation
    {
        internal Task? m_task;
        internal readonly TaskContinuationOptions m_options;
        private readonly object? scheduler;
        private Task? antecedent;

        internal ContinueWithTaskContinuation(Task task, TaskContinuationOptions options, object? scheduler)
        {
            m_task = task;
            m_options = options;
            this.scheduler = scheduler;
        }

        internal override int ContinueWithKind => (m_options & TaskContinuationOptions.ExecuteSynchronously) != 0 ? 1 : 2;

        internal ContinueWithTaskContinuation WithAntecedent(Task? antecedent)
        {
            this.antecedent = antecedent;
            return this;
        }

        // The continuation's token was canceled before it ran.
        internal void Cancel()
        {
            if (m_task is { } task)
            {
                antecedent?.RemoveContinuation(this);
                task.InternalCancel();
            }
        }

        internal override void Run(Task completedTask, bool canInlineContinuationTask)
        {
            var task = m_task;
            if (task is null || task.IsCompleted)
            {
                return;
            }

            m_task = null;
            var options = m_options;
            bool isRightKind = completedTask.IsCompletedSuccessfully
                ? (options & TaskContinuationOptions.NotOnRanToCompletion) == 0
                : completedTask.IsCanceled
                    ? (options & TaskContinuationOptions.NotOnCanceled) == 0
                    : (options & TaskContinuationOptions.NotOnFaulted) == 0;
            if (!isRightKind)
            {
                task.InternalCancel();
                return;
            }

            task.AssignScheduler(scheduler);
            if (canInlineContinuationTask && (options & TaskContinuationOptions.ExecuteSynchronously) != 0)
            {
                task.InlineIfPossibleOrElseQueue(true);
            }
            else
            {
                try
                {
                    task.ScheduleAndStart(true);
                }
                catch (TaskSchedulerException)
                {
                    // The task is faulted with it already.
                }
            }
        }
    }
}
