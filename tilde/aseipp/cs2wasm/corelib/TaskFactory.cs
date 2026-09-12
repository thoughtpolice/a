// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// TaskFactory and TaskFactory<TResult> (docs/IMPORTER.md, "Async as
// built"), after dotnet/runtime's TaskFactory.cs and TaskFactory_T.cs:
// StartNew queues a delegate task to the factory's scheduler (the current
// one when it has none: the delegate task running's, else the default),
// and ContinueWhenAll and ContinueWhenAny continue a set of tasks. The
// APM adapters (FromAsync) are left out: a module has no IAsyncResult
// producers.

using System.Collections.Generic;
using Gameplay.Runtime;

namespace System.Threading.Tasks
{
    public class TaskFactory
    {
        internal static readonly TaskFactory Shared = new TaskFactory();

        private readonly CancellationToken m_defaultCancellationToken;
        private readonly TaskScheduler? m_defaultScheduler;
        private readonly TaskCreationOptions m_defaultCreationOptions;
        private readonly TaskContinuationOptions m_defaultContinuationOptions;

        public TaskFactory()
        {
        }

        public TaskFactory(CancellationToken cancellationToken) => m_defaultCancellationToken = cancellationToken;

        public TaskFactory(TaskScheduler? scheduler) => m_defaultScheduler = scheduler;

        public TaskFactory(TaskCreationOptions creationOptions, TaskContinuationOptions continuationOptions)
        {
            TaskFactory.CheckMultiTaskContinuationOptions(continuationOptions);
            TaskFactory.CheckCreationOptions(creationOptions);
            m_defaultCreationOptions = creationOptions;
            m_defaultContinuationOptions = continuationOptions;
        }

        public TaskFactory(
            CancellationToken cancellationToken, TaskCreationOptions creationOptions, TaskContinuationOptions continuationOptions,
            TaskScheduler? scheduler)
            : this(creationOptions, continuationOptions)
        {
            m_defaultCancellationToken = cancellationToken;
            m_defaultScheduler = scheduler;
        }

        public CancellationToken CancellationToken => m_defaultCancellationToken;

        public TaskScheduler? Scheduler => m_defaultScheduler;

        public TaskCreationOptions CreationOptions => m_defaultCreationOptions;

        public TaskContinuationOptions ContinuationOptions => m_defaultContinuationOptions;

        private TaskScheduler DefaultScheduler => m_defaultScheduler ?? TaskScheduler.Current;

        // The factory's scheduler, else the delegate task running's, else
        // the default.
        private TaskScheduler GetDefaultScheduler(Task? current) =>
            m_defaultScheduler
            ?? (current is not null && (current.CreationOptions & TaskCreationOptions.HideScheduler) == 0
                ? current.ExecutingTaskScheduler!
                : TaskScheduler.Default);

        public Task StartNew(Action action)
        {
            ArgumentNullException.ThrowIfNull(action);
            return TaskFactory.StartNew(new DelegateTaskState { Action = action }, null, m_defaultCancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task StartNew(Action action, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(action);
            return TaskFactory.StartNew(new DelegateTaskState { Action = action }, null, cancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task StartNew(Action action, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(action);
            return TaskFactory.StartNew(new DelegateTaskState { Action = action }, null, m_defaultCancellationToken, creationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task StartNew(
            Action action, CancellationToken cancellationToken, TaskCreationOptions creationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(action);
            ArgumentNullException.ThrowIfNull(scheduler);
            return TaskFactory.StartNew(new DelegateTaskState { Action = action }, null, cancellationToken, creationOptions, scheduler);
        }

        public Task StartNew(Action<object?> action, object? state)
        {
            ArgumentNullException.ThrowIfNull(action);
            return TaskFactory.StartNew(new DelegateTaskState { StateAction = action }, state, m_defaultCancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task StartNew(Action<object?> action, object? state, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(action);
            return TaskFactory.StartNew(new DelegateTaskState { StateAction = action }, state, cancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task StartNew(Action<object?> action, object? state, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(action);
            return TaskFactory.StartNew(new DelegateTaskState { StateAction = action }, state, m_defaultCancellationToken, creationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task StartNew(
            Action<object?> action, object? state, CancellationToken cancellationToken, TaskCreationOptions creationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(action);
            ArgumentNullException.ThrowIfNull(scheduler);
            return TaskFactory.StartNew(new DelegateTaskState { StateAction = action }, state, cancellationToken, creationOptions, scheduler);
        }

        public Task<TResult> StartNew<TResult>(Func<TResult> function)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { Function = function }, null, m_defaultCancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew<TResult>(Func<TResult> function, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { Function = function }, null, cancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew<TResult>(Func<TResult> function, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { Function = function }, null, m_defaultCancellationToken, creationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew<TResult>(
            Func<TResult> function, CancellationToken cancellationToken, TaskCreationOptions creationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(function);
            ArgumentNullException.ThrowIfNull(scheduler);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { Function = function }, null, cancellationToken, creationOptions, scheduler);
        }

        public Task<TResult> StartNew<TResult>(Func<object?, TResult> function, object? state)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { StateFunction = function }, state, m_defaultCancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew<TResult>(Func<object?, TResult> function, object? state, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { StateFunction = function }, state, cancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew<TResult>(Func<object?, TResult> function, object? state, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { StateFunction = function }, state, m_defaultCancellationToken, creationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew<TResult>(
            Func<object?, TResult> function, object? state, CancellationToken cancellationToken, TaskCreationOptions creationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(function);
            ArgumentNullException.ThrowIfNull(scheduler);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { StateFunction = function }, state, cancellationToken, creationOptions, scheduler);
        }

        public Task ContinueWhenAll(Task[] tasks, Action<Task[]> continuationAction)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAllImpl<VoidTaskResult>(tasks, null, continuationAction, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAll(Task[] tasks, Action<Task[]> continuationAction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAllImpl<VoidTaskResult>(tasks, null, continuationAction, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAll(Task[] tasks, Action<Task[]> continuationAction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAllImpl<VoidTaskResult>(tasks, null, continuationAction, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAll(
            Task[] tasks, Action<Task[]> continuationAction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAllImpl<VoidTaskResult>(tasks, null, continuationAction, continuationOptions, cancellationToken, scheduler);
        }

        public Task ContinueWhenAll<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Action<Task<TAntecedentResult>[]> continuationAction)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, VoidTaskResult>(tasks, null, continuationAction, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAll<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Action<Task<TAntecedentResult>[]> continuationAction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, VoidTaskResult>(tasks, null, continuationAction, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAll<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Action<Task<TAntecedentResult>[]> continuationAction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, VoidTaskResult>(tasks, null, continuationAction, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAll<TAntecedentResult>(
            Task<TAntecedentResult>[] tasks, Action<Task<TAntecedentResult>[]> continuationAction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, VoidTaskResult>(tasks, null, continuationAction, continuationOptions, cancellationToken, scheduler);
        }

        public Task<TResult> ContinueWhenAll<TResult>(Task[] tasks, Func<Task[], TResult> continuationFunction)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll<TResult>(Task[] tasks, Func<Task[], TResult> continuationFunction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll<TResult>(Task[] tasks, Func<Task[], TResult> continuationFunction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TResult>(tasks, continuationFunction, null, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll<TResult>(
            Task[] tasks, Func<Task[], TResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TResult>(tasks, continuationFunction, null, continuationOptions, cancellationToken, scheduler);
        }

        public Task<TResult> ContinueWhenAll<TAntecedentResult, TResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>[], TResult> continuationFunction)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll<TAntecedentResult, TResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>[], TResult> continuationFunction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll<TAntecedentResult, TResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>[], TResult> continuationFunction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll<TAntecedentResult, TResult>(
            Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>[], TResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, continuationOptions, cancellationToken, scheduler);
        }

        public Task ContinueWhenAny(Task[] tasks, Action<Task> continuationAction)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAnyImpl<VoidTaskResult>(tasks, null, continuationAction, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAny(Task[] tasks, Action<Task> continuationAction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAnyImpl<VoidTaskResult>(tasks, null, continuationAction, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAny(Task[] tasks, Action<Task> continuationAction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAnyImpl<VoidTaskResult>(tasks, null, continuationAction, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAny(
            Task[] tasks, Action<Task> continuationAction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAnyImpl<VoidTaskResult>(tasks, null, continuationAction, continuationOptions, cancellationToken, scheduler);
        }

        public Task ContinueWhenAny<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Action<Task<TAntecedentResult>> continuationAction)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, VoidTaskResult>(tasks, null, continuationAction, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAny<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Action<Task<TAntecedentResult>> continuationAction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, VoidTaskResult>(tasks, null, continuationAction, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAny<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Action<Task<TAntecedentResult>> continuationAction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, VoidTaskResult>(tasks, null, continuationAction, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task ContinueWhenAny<TAntecedentResult>(
            Task<TAntecedentResult>[] tasks, Action<Task<TAntecedentResult>> continuationAction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationAction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, VoidTaskResult>(tasks, null, continuationAction, continuationOptions, cancellationToken, scheduler);
        }

        public Task<TResult> ContinueWhenAny<TResult>(Task[] tasks, Func<Task, TResult> continuationFunction)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny<TResult>(Task[] tasks, Func<Task, TResult> continuationFunction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny<TResult>(Task[] tasks, Func<Task, TResult> continuationFunction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TResult>(tasks, continuationFunction, null, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny<TResult>(
            Task[] tasks, Func<Task, TResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TResult>(tasks, continuationFunction, null, continuationOptions, cancellationToken, scheduler);
        }

        public Task<TResult> ContinueWhenAny<TAntecedentResult, TResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>, TResult> continuationFunction)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny<TAntecedentResult, TResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>, TResult> continuationFunction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny<TAntecedentResult, TResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>, TResult> continuationFunction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny<TAntecedentResult, TResult>(
            Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>, TResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, continuationOptions, cancellationToken, scheduler);
        }

        // StartNew's: queued at once.
        internal static Task StartNew(
            DelegateTaskState state, object? stateObject, CancellationToken cancellationToken, TaskCreationOptions creationOptions,
            TaskScheduler scheduler)
        {
            state.StateObject = stateObject;
            var task = new Task(state, cancellationToken, creationOptions, scheduler);
            task.ScheduleAndStart(false);
            return task;
        }

        internal static void CheckCreationOptions(TaskCreationOptions creationOptions)
        {
            if ((creationOptions & ~(TaskCreationOptions.AttachedToParent | TaskCreationOptions.DenyChildAttach | TaskCreationOptions.HideScheduler
                                     | TaskCreationOptions.LongRunning | TaskCreationOptions.PreferFairness
                                     | TaskCreationOptions.RunContinuationsAsynchronously)) != 0)
            {
                throw new ArgumentOutOfRangeException(nameof(creationOptions));
            }
        }

        internal static void CheckMultiTaskContinuationOptions(TaskContinuationOptions continuationOptions)
        {
            const TaskContinuationOptions NotOnAny =
                TaskContinuationOptions.NotOnCanceled | TaskContinuationOptions.NotOnFaulted | TaskContinuationOptions.NotOnRanToCompletion;
            const TaskContinuationOptions IllegalMask = TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.LongRunning;
            if ((continuationOptions & IllegalMask) == IllegalMask)
            {
                throw new ArgumentOutOfRangeException(nameof(continuationOptions), SR.Task_ContinueWith_ESandLR);
            }

            if ((continuationOptions & ~(TaskContinuationOptions.LongRunning | TaskContinuationOptions.PreferFairness
                                         | TaskContinuationOptions.AttachedToParent | TaskContinuationOptions.DenyChildAttach
                                         | TaskContinuationOptions.HideScheduler | TaskContinuationOptions.LazyCancellation | NotOnAny
                                         | TaskContinuationOptions.ExecuteSynchronously)) != 0)
            {
                throw new ArgumentOutOfRangeException(nameof(continuationOptions));
            }

            if ((continuationOptions & NotOnAny) != 0)
            {
                throw new ArgumentOutOfRangeException(nameof(continuationOptions), SR.Task_MultiTaskContinuation_FireOptions);
            }
        }

        private static TTask[] CheckMultiContinuationTasksAndCopy<TTask>(TTask[] tasks)
            where TTask : Task
        {
            ArgumentNullException.ThrowIfNull(tasks);
            if (tasks.Length == 0)
            {
                throw new ArgumentException(SR.Task_MultiTaskContinuation_EmptyTaskList, nameof(tasks));
            }

            var copy = new TTask[tasks.Length];
            for (int i = 0; i < tasks.Length; i++)
            {
                copy[i] = tasks[i] ?? throw new ArgumentException(SR.Task_MultiTaskContinuation_NullTask, nameof(tasks));
            }

            return copy;
        }

        // A continuation that is canceled before it starts (its token was).
        private static Task<TResult> CanceledContinuation<TResult>(TaskContinuationOptions continuationOptions, CancellationToken token)
        {
            var task = new Task<TResult>((object?)null, Task.ContinuationCreationOptions(continuationOptions));
            task.TrySetCanceled(token);
            return task;
        }

        // A multi-task continuation's function, or action (a class: a
        // module does not tell delegates apart by casting an object).
        private sealed class Continuation<TArgument, TResult>
        {
            private readonly Func<TArgument, TResult>? function;
            private readonly Action<TArgument>? action;

            internal Continuation(Func<TArgument, TResult>? function, Action<TArgument>? action)
            {
                this.function = function;
                this.action = action;
            }

            internal TResult Invoke(TArgument argument)
            {
                if (function is not null)
                {
                    return function(argument);
                }

                action!(argument);
                return default!;
            }
        }

        // When every task has completed, however it did: their array.
        private sealed class CompleteOnCountdownPromise<TTask> : CompletionAction
            where TTask : Task
        {
            internal readonly Task<TTask[]> Promise = new Task<TTask[]>();
            private readonly TTask[] tasks;
            private int count;

            internal CompleteOnCountdownPromise(TTask[] tasks)
            {
                this.tasks = tasks;
                count = tasks.Length;
                foreach (var task in tasks)
                {
                    if (task.IsCompleted)
                    {
                        Invoke(task);
                    }
                    else
                    {
                        task.AddCompletionAction(this);
                    }
                }
            }

            internal override void Invoke(Task completingTask)
            {
                if (--count == 0)
                {
                    Promise.TrySetResult(tasks);
                }
            }
        }

        internal static Task<TResult> ContinueWhenAllImpl<TResult>(
            Task[] tasks, Func<Task[], TResult>? continuationFunction, Action<Task[]>? continuationAction,
            TaskContinuationOptions continuationOptions, CancellationToken cancellationToken, TaskScheduler scheduler) =>
            ContinueWhenAllCore(tasks, continuationFunction, continuationAction, continuationOptions, cancellationToken, scheduler);

        internal static Task<TResult> ContinueWhenAllImpl<TAntecedentResult, TResult>(
            Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>[], TResult>? continuationFunction,
            Action<Task<TAntecedentResult>[]>? continuationAction, TaskContinuationOptions continuationOptions,
            CancellationToken cancellationToken, TaskScheduler scheduler) =>
            ContinueWhenAllCore(tasks, continuationFunction, continuationAction, continuationOptions, cancellationToken, scheduler);

        private static Task<TResult> ContinueWhenAllCore<TTask, TResult>(
            TTask[] tasks, Func<TTask[], TResult>? continuationFunction, Action<TTask[]>? continuationAction,
            TaskContinuationOptions continuationOptions, CancellationToken cancellationToken, TaskScheduler scheduler)
            where TTask : Task
        {
            CheckMultiTaskContinuationOptions(continuationOptions);
            ArgumentNullException.ThrowIfNull(tasks);
            ArgumentNullException.ThrowIfNull(scheduler);
            var copy = CheckMultiContinuationTasksAndCopy(tasks);
            if (cancellationToken.IsCancellationRequested && (continuationOptions & TaskContinuationOptions.LazyCancellation) == 0)
            {
                return CanceledContinuation<TResult>(continuationOptions, cancellationToken);
            }

            var starter = new CompleteOnCountdownPromise<TTask>(copy).Promise;
            return starter.ContinueWith(
                static (completed, continuation) => ((Continuation<TTask[], TResult>)continuation!).Invoke(completed.ResultOnSuccess),
                new Continuation<TTask[], TResult>(continuationFunction, continuationAction), cancellationToken, continuationOptions, scheduler);
        }

        internal static Task<TResult> ContinueWhenAnyImpl<TResult>(
            Task[] tasks, Func<Task, TResult>? continuationFunction, Action<Task>? continuationAction,
            TaskContinuationOptions continuationOptions, CancellationToken cancellationToken, TaskScheduler scheduler) =>
            ContinueWhenAnyCore(tasks, continuationFunction, continuationAction, continuationOptions, cancellationToken, scheduler);

        internal static Task<TResult> ContinueWhenAnyImpl<TAntecedentResult, TResult>(
            Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>, TResult>? continuationFunction,
            Action<Task<TAntecedentResult>>? continuationAction, TaskContinuationOptions continuationOptions,
            CancellationToken cancellationToken, TaskScheduler scheduler) =>
            ContinueWhenAnyCore(tasks, continuationFunction, continuationAction, continuationOptions, cancellationToken, scheduler);

        private static Task<TResult> ContinueWhenAnyCore<TTask, TResult>(
            TTask[] tasks, Func<TTask, TResult>? continuationFunction, Action<TTask>? continuationAction,
            TaskContinuationOptions continuationOptions, CancellationToken cancellationToken, TaskScheduler scheduler)
            where TTask : Task
        {
            CheckMultiTaskContinuationOptions(continuationOptions);
            ArgumentNullException.ThrowIfNull(tasks);
            if (tasks.Length == 0)
            {
                throw new ArgumentException(SR.Task_MultiTaskContinuation_EmptyTaskList, nameof(tasks));
            }

            ArgumentNullException.ThrowIfNull(scheduler);
            var copy = CheckMultiContinuationTasksAndCopy(tasks);
            var starter = Task.WhenAnyCore(copy);
            if (cancellationToken.IsCancellationRequested && (continuationOptions & TaskContinuationOptions.LazyCancellation) == 0)
            {
                return CanceledContinuation<TResult>(continuationOptions, cancellationToken);
            }

            return starter.ContinueWith(
                static (completed, continuation) => ((Continuation<TTask, TResult>)continuation!).Invoke(completed.ResultOnSuccess),
                new Continuation<TTask, TResult>(continuationFunction, continuationAction), cancellationToken, continuationOptions, scheduler);
        }
    }

    public class TaskFactory<TResult>
    {
        internal static readonly TaskFactory<TResult> Shared = new TaskFactory<TResult>();

        private readonly CancellationToken m_defaultCancellationToken;
        private readonly TaskScheduler? m_defaultScheduler;
        private readonly TaskCreationOptions m_defaultCreationOptions;
        private readonly TaskContinuationOptions m_defaultContinuationOptions;

        public TaskFactory()
        {
        }

        public TaskFactory(CancellationToken cancellationToken) => m_defaultCancellationToken = cancellationToken;

        public TaskFactory(TaskScheduler? scheduler) => m_defaultScheduler = scheduler;

        public TaskFactory(TaskCreationOptions creationOptions, TaskContinuationOptions continuationOptions)
        {
            TaskFactory.CheckMultiTaskContinuationOptions(continuationOptions);
            TaskFactory.CheckCreationOptions(creationOptions);
            m_defaultCreationOptions = creationOptions;
            m_defaultContinuationOptions = continuationOptions;
        }

        public TaskFactory(
            CancellationToken cancellationToken, TaskCreationOptions creationOptions, TaskContinuationOptions continuationOptions,
            TaskScheduler? scheduler)
            : this(creationOptions, continuationOptions)
        {
            m_defaultCancellationToken = cancellationToken;
            m_defaultScheduler = scheduler;
        }

        public CancellationToken CancellationToken => m_defaultCancellationToken;

        public TaskScheduler? Scheduler => m_defaultScheduler;

        public TaskCreationOptions CreationOptions => m_defaultCreationOptions;

        public TaskContinuationOptions ContinuationOptions => m_defaultContinuationOptions;

        private TaskScheduler DefaultScheduler => m_defaultScheduler ?? TaskScheduler.Current;

        // The factory's scheduler, else the delegate task running's, else
        // the default.
        private TaskScheduler GetDefaultScheduler(Task? current) =>
            m_defaultScheduler
            ?? (current is not null && (current.CreationOptions & TaskCreationOptions.HideScheduler) == 0
                ? current.ExecutingTaskScheduler!
                : TaskScheduler.Default);

        public Task<TResult> StartNew(Func<TResult> function)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { Function = function }, null, m_defaultCancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew(Func<TResult> function, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { Function = function }, null, cancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew(Func<TResult> function, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { Function = function }, null, m_defaultCancellationToken, creationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew(
            Func<TResult> function, CancellationToken cancellationToken, TaskCreationOptions creationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(function);
            ArgumentNullException.ThrowIfNull(scheduler);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { Function = function }, null, cancellationToken, creationOptions, scheduler);
        }

        public Task<TResult> StartNew(Func<object?, TResult> function, object? state)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { StateFunction = function }, state, m_defaultCancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew(Func<object?, TResult> function, object? state, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { StateFunction = function }, state, cancellationToken, m_defaultCreationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew(Func<object?, TResult> function, object? state, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { StateFunction = function }, state, m_defaultCancellationToken, creationOptions, GetDefaultScheduler(Task.InternalCurrent));
        }

        public Task<TResult> StartNew(
            Func<object?, TResult> function, object? state, CancellationToken cancellationToken, TaskCreationOptions creationOptions, TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(function);
            ArgumentNullException.ThrowIfNull(scheduler);
            return Task<TResult>.StartNew(new FunctionTaskState<TResult> { StateFunction = function }, state, cancellationToken, creationOptions, scheduler);
        }

        public Task<TResult> ContinueWhenAll(Task[] tasks, Func<Task[], TResult> continuationFunction)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll(Task[] tasks, Func<Task[], TResult> continuationFunction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll(Task[] tasks, Func<Task[], TResult> continuationFunction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TResult>(tasks, continuationFunction, null, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll(
            Task[] tasks, Func<Task[], TResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TResult>(tasks, continuationFunction, null, continuationOptions, cancellationToken, scheduler);
        }

        public Task<TResult> ContinueWhenAll<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>[], TResult> continuationFunction)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>[], TResult> continuationFunction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>[], TResult> continuationFunction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAll<TAntecedentResult>(
            Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>[], TResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAllImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, continuationOptions, cancellationToken, scheduler);
        }

        public Task<TResult> ContinueWhenAny(Task[] tasks, Func<Task, TResult> continuationFunction)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny(Task[] tasks, Func<Task, TResult> continuationFunction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny(Task[] tasks, Func<Task, TResult> continuationFunction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TResult>(tasks, continuationFunction, null, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny(
            Task[] tasks, Func<Task, TResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TResult>(tasks, continuationFunction, null, continuationOptions, cancellationToken, scheduler);
        }

        public Task<TResult> ContinueWhenAny<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>, TResult> continuationFunction)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>, TResult> continuationFunction, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, m_defaultContinuationOptions, cancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny<TAntecedentResult>(Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>, TResult> continuationFunction, TaskContinuationOptions continuationOptions)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, continuationOptions, m_defaultCancellationToken, DefaultScheduler);
        }

        public Task<TResult> ContinueWhenAny<TAntecedentResult>(
            Task<TAntecedentResult>[] tasks, Func<Task<TAntecedentResult>, TResult> continuationFunction, CancellationToken cancellationToken, TaskContinuationOptions continuationOptions,
            TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(continuationFunction);
            return TaskFactory.ContinueWhenAnyImpl<TAntecedentResult, TResult>(tasks, continuationFunction, null, continuationOptions, cancellationToken, scheduler);
        }
    }
}
