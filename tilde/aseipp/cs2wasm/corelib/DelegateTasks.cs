// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Delegate tasks (docs/IMPORTER.md, "Async as built"), after
// dotnet/runtime's Task.cs: tasks that run a delegate, made by Task's
// constructors (then Start or RunSynchronously), Task.Run, TaskFactory's
// StartNew and ContinueWith, and queued to a TaskScheduler; without one in
// the module (Intrinsics.HasTaskSchedulers), to the frame loop's queue,
// which is the default scheduler's. A delegate task runs once; one created
// AttachedToParent inside another's delegate keeps that one from completing
// until it has, and gives it its exceptions; a thread waiting for a queued
// task runs it, as nothing else would.

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Gameplay.Runtime;

namespace System.Threading.Tasks
{
    public partial class Task
    {
        // A delegate task's DelegateTaskState, null for a promise (an
        // object, so that a module with promises only has no
        // DelegateTaskState: see m_capturedContext).
        internal object? m_delegateTask;

        // The task a delegate is running for: Task.CurrentId, and
        // TaskScheduler.Current.
        private static Task? s_currentTask;

        public static int? CurrentId => s_currentTask?.Id;

        internal static Task? InternalCurrent => s_currentTask;

        private DelegateTaskState State => (DelegateTaskState)m_delegateTask!;

        internal bool IsDelegateTask => m_delegateTask is not null;

        internal void AssignScheduler(object? scheduler) => State.Scheduler = scheduler;

        internal bool IsDelegateInvoked => m_delegateTask is not null && State.Invoked;

        internal TaskScheduler? ExecutingTaskScheduler => m_delegateTask is null ? null : (TaskScheduler?)State.Scheduler;

        public Task(Action action)
            : this(action, default, TaskCreationOptions.None)
        {
        }

        public Task(Action action, CancellationToken cancellationToken)
            : this(action, cancellationToken, TaskCreationOptions.None)
        {
        }

        public Task(Action action, TaskCreationOptions creationOptions)
            : this(action, default, creationOptions)
        {
        }

        public Task(Action action, CancellationToken cancellationToken, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(action);
            InitializeDelegateTask(new DelegateTaskState { Action = action }, null, cancellationToken, creationOptions, false, null);
        }

        public Task(Action<object?> action, object? state)
            : this(action, state, default, TaskCreationOptions.None)
        {
        }

        public Task(Action<object?> action, object? state, CancellationToken cancellationToken)
            : this(action, state, cancellationToken, TaskCreationOptions.None)
        {
        }

        public Task(Action<object?> action, object? state, TaskCreationOptions creationOptions)
            : this(action, state, default, creationOptions)
        {
        }

        public Task(Action<object?> action, object? state, CancellationToken cancellationToken, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(action);
            InitializeDelegateTask(new DelegateTaskState { StateAction = action }, state, cancellationToken, creationOptions, false, null);
        }

        // A delegate task's construction, as the CLR's TaskConstructorCore:
        // attached to the delegate task running when it asks to be and that
        // one lets it, canceled by its token while it has not started (one
        // the runtime queues itself, StartNew's and Task.Run's, at once
        // instead, where its delegate would start), and run in the
        // ExecutionContext current now.
        internal void InitializeDelegateTask(
            DelegateTaskState state, object? stateObject, CancellationToken cancellationToken, TaskCreationOptions creationOptions,
            bool queuedByRuntime, object? scheduler)
        {
            if ((creationOptions & ~(TaskCreationOptions.AttachedToParent | TaskCreationOptions.LongRunning | TaskCreationOptions.DenyChildAttach
                                     | TaskCreationOptions.HideScheduler | TaskCreationOptions.PreferFairness
                                     | TaskCreationOptions.RunContinuationsAsynchronously)) != 0)
            {
                throw new ArgumentOutOfRangeException(nameof(creationOptions));
            }

            m_delegateTask = state;
            m_stateObject = stateObject;
            m_options = creationOptions;
            m_status = TaskStatus.Created;
            state.Scheduler = scheduler;
            AttachToParent(state, creationOptions);
            if (cancellationToken.CanBeCanceled)
            {
                m_cancellationToken = cancellationToken;
                if (!queuedByRuntime)
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        InternalCancel();
                    }
                    else
                    {
                        m_cancellationRegistration = cancellationToken.UnsafeRegister(static task => ((Task)task!).InternalCancel(), this);
                    }
                }
            }

            if (Gameplay.Runtime.Intrinsics.FlowsExecutionContext())
            {
                m_capturedContext = ExecutionContext.Capture();
            }
        }

        // A continuation task's (ContinueWith's) state: started only when
        // its antecedent completes.
        internal void InitializeContinuationTask(TaskCreationOptions creationOptions)
        {
            var state = new DelegateTaskState { Continuation = true };
            m_delegateTask = state;
            AttachToParent(state, creationOptions);
        }

        private static void AttachToParent(DelegateTaskState state, TaskCreationOptions creationOptions)
        {
            if ((creationOptions & TaskCreationOptions.AttachedToParent) != 0 && s_currentTask is { } parent
                && (parent.CreationOptions & TaskCreationOptions.DenyChildAttach) == 0)
            {
                state.Parent = parent;
                parent.State.Countdown++;
            }
        }

        // The scheduler a task without one of its own runs on: the current
        // one, or, in a module without schedulers, the frame loop (null).
        internal static object? CurrentScheduler() =>
            Gameplay.Runtime.Intrinsics.HasTaskSchedulers() ? TaskScheduler.Current : null;

        public void Start()
        {
            if (Gameplay.Runtime.Intrinsics.HasTaskSchedulers())
            {
                Start(TaskScheduler.Current);
            }
            else
            {
                StartCore(null);
            }
        }

        public void Start(TaskScheduler scheduler)
        {
            if (IsCompleted)
            {
                throw new InvalidOperationException(SR.Task_Start_TaskCompleted);
            }

            ArgumentNullException.ThrowIfNull(scheduler);
            StartCore(scheduler);
        }

        private void StartCore(object? scheduler)
        {
            if (IsCompleted)
            {
                throw new InvalidOperationException(SR.Task_Start_TaskCompleted);
            }

            if (m_delegateTask is null)
            {
                throw new InvalidOperationException(SR.Task_Start_Promise);
            }

            var state = State;
            if (state.Continuation)
            {
                throw new InvalidOperationException(SR.Task_Start_ContinuationTask);
            }

            if (state.Started || state.Assigned)
            {
                throw new InvalidOperationException(SR.Task_Start_AlreadyStarted);
            }

            state.Assigned = true;
            state.Scheduler = scheduler;
            ScheduleAndStart(true);
        }

        public void RunSynchronously()
        {
            if (Gameplay.Runtime.Intrinsics.HasTaskSchedulers())
            {
                RunSynchronously(TaskScheduler.Current);
            }
            else
            {
                InternalRunSynchronously(null);
            }
        }

        public void RunSynchronously(TaskScheduler scheduler)
        {
            ArgumentNullException.ThrowIfNull(scheduler);
            InternalRunSynchronously(scheduler);
        }

        // Inline if the scheduler lets it, else queued and waited for, as the
        // CLR's.
        private void InternalRunSynchronously(object? scheduler)
        {
            if (m_delegateTask is DelegateTaskState { Continuation: true })
            {
                throw new InvalidOperationException(SR.Task_RunSynchronously_Continuation);
            }

            if (m_delegateTask is null)
            {
                throw new InvalidOperationException(SR.Task_RunSynchronously_Promise);
            }

            if (IsCompleted)
            {
                throw new InvalidOperationException(SR.Task_RunSynchronously_TaskCompleted);
            }

            var state = State;
            if (state.Started || state.Assigned)
            {
                throw new InvalidOperationException(SR.Task_RunSynchronously_AlreadyStarted);
            }

            state.Assigned = true;
            state.Scheduler = scheduler;
            state.Started = true;
            m_status = TaskStatus.WaitingToRun;
            bool queued = false;
            try
            {
                queued = TryRunInlineOn(false);
                if (!queued)
                {
                    QueueToScheduler();
                    queued = true;
                }

                if (!IsCompleted)
                {
                    WaitForCompletion();
                }
            }
            catch (Exception exception) when (!queued)
            {
                var wrapped = new TaskSchedulerException(exception);
                FaultDelegateTask(wrapped);
                throw wrapped;
            }
        }

        // Task.Run: the delegate on the default scheduler, its children
        // denied; a function's task unwrapped.
        public static Task Run(Action action) => Run(action, default);

        public static Task Run(Action action, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(action);
            var task = new Task(new DelegateTaskState { Action = action }, cancellationToken, TaskCreationOptions.DenyChildAttach, DefaultScheduler());
            task.ScheduleAndStart(false);
            return task;
        }

        public static Task<TResult> Run<TResult>(Func<TResult> function) => Run(function, default(CancellationToken));

        public static Task<TResult> Run<TResult>(Func<TResult> function, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(function);
            return Task<TResult>.StartNew(
                new FunctionTaskState<TResult> { Function = function }, null, cancellationToken, TaskCreationOptions.DenyChildAttach,
                DefaultScheduler());
        }

        public static Task Run(Func<Task?> function) => Run(function, default(CancellationToken));

        public static Task Run(Func<Task?> function, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(function);
            if (cancellationToken.IsCancellationRequested)
            {
                return FromCanceled(cancellationToken);
            }

            var outer = Task<Task?>.StartNew(
                new FunctionTaskState<Task?> { Function = function }, null, cancellationToken, TaskCreationOptions.DenyChildAttach,
                DefaultScheduler());
            return new UnwrapPromise<VoidTaskResult>(outer, null, lookForOce: true);
        }

        public static Task<TResult> Run<TResult>(Func<Task<TResult>?> function) => Run(function, default(CancellationToken));

        public static Task<TResult> Run<TResult>(Func<Task<TResult>?> function, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(function);
            if (cancellationToken.IsCancellationRequested)
            {
                return FromCanceled<TResult>(cancellationToken);
            }

            var outer = Task<Task<TResult>?>.StartNew(
                new FunctionTaskState<Task<TResult>?> { Function = function }, null, cancellationToken, TaskCreationOptions.DenyChildAttach,
                DefaultScheduler());
            return new UnwrapPromise<TResult>(null, outer, lookForOce: true);
        }

        // TaskScheduler.Default, or, in a module without schedulers, the
        // frame loop (null).
        internal static object? DefaultScheduler() =>
            Gameplay.Runtime.Intrinsics.HasTaskSchedulers() ? TaskScheduler.Default : null;

        // A delegate task the runtime queues itself (StartNew's, Task.Run's).
        internal Task(DelegateTaskState state, CancellationToken cancellationToken, TaskCreationOptions creationOptions, object? scheduler)
        {
            InitializeDelegateTask(state, state.StateObject, cancellationToken, creationOptions, true, scheduler);
            state.Assigned = true;
        }

        public static TaskFactory Factory => TaskFactory.Shared;

        // Queues a delegate task to its scheduler, which faults it with a
        // TaskSchedulerException if it throws, as the CLR's ScheduleAndStart;
        // `protect`ion leaves one started or canceled meanwhile alone.
        internal void ScheduleAndStart(bool protect)
        {
            var state = State;
            if (protect && (state.Started || IsCanceled))
            {
                return;
            }

            state.Started = true;
            if (m_status < TaskStatus.WaitingToRun)
            {
                m_status = TaskStatus.WaitingToRun;
            }

            try
            {
                QueueToScheduler();
            }
            catch (Exception exception)
            {
                var wrapped = new TaskSchedulerException(exception);
                FaultDelegateTask(wrapped);
                throw wrapped;
            }
        }

        private void QueueToScheduler()
        {
            if (Gameplay.Runtime.Intrinsics.HasTaskSchedulers() && State.Scheduler is not null)
            {
                ((TaskScheduler)State.Scheduler).InternalQueueTask(this);
            }
            else
            {
                FrameLoop.Queue(new QueuedDelegateTask(this));
            }
        }

        // Runs it inline where its scheduler lets it (the CLR's
        // TaskScheduler.TryRunInline); the frame loop's queue always does,
        // but where the call-depth budget is running out.
        private bool TryRunInlineOn(bool taskWasPreviouslyQueued)
        {
            if (Gameplay.Runtime.Intrinsics.HasTaskSchedulers() && State.Scheduler is not null)
            {
                return ((TaskScheduler)State.Scheduler).TryRunInline(this, taskWasPreviouslyQueued);
            }

            if (State.Invoked || IsCanceled || Gameplay.Runtime.Intrinsics.CallDepth() + 16 > Gameplay.Runtime.Intrinsics.CallDepthLimit())
            {
                return false;
            }

            ExecuteEntry();
            return true;
        }

        // Starts a continuation or a scheduler's own task: inline where its
        // scheduler lets it, else queued (the CLR's
        // InlineIfPossibleOrElseQueue); what the scheduler throws faults it.
        internal void InlineIfPossibleOrElseQueue(bool protect)
        {
            var state = State;
            if (protect && (state.Started || IsCanceled))
            {
                return;
            }

            state.Started = true;
            if (m_status < TaskStatus.WaitingToRun)
            {
                m_status = TaskStatus.WaitingToRun;
            }

            try
            {
                if (!TryRunInlineOn(false))
                {
                    QueueToScheduler();
                }
            }
            catch (Exception exception)
            {
                FaultDelegateTask(new TaskSchedulerException(exception));
            }
        }

        // A thread waiting for a queued delegate task runs it, if its
        // scheduler lets it (the CLR's WrappedTryRunInline): the CLR's
        // only for a wait without a timeout or a token, the frame loop's
        // queue for any, since a thread of the CLR's pool would have run it
        // meanwhile.
        internal void TryRunInlineForWait(bool unbounded)
        {
            // Through DelegateTaskHooks' slot, so that a module without
            // delegate tasks keeps none of their code, nor their state's
            // type.
            if (m_delegateTask is not null)
            {
                ((DelegateTaskHooks)m_delegateTask).RunInlineForWait(this, unbounded);
            }
        }

        internal void RunInlineForWait(DelegateTaskState state, bool unbounded)
        {
            if (!state.Started || state.Invoked)
            {
                return;
            }

            if (Gameplay.Runtime.Intrinsics.HasTaskSchedulers() && state.Scheduler is not null)
            {
                if (!unbounded && state.Scheduler != (object)TaskScheduler.Default)
                {
                    return;
                }

                try
                {
                    ((TaskScheduler)state.Scheduler).TryRunInline(this, true);
                }
                catch (Exception exception)
                {
                    throw new TaskSchedulerException(exception);
                }
            }
            else
            {
                TryRunInlineOn(true);
            }
        }

        // Runs a delegate task's delegate, as the CLR's ExecuteEntry: once
        // (false for one run already, unless it was canceled); an
        // OperationCanceledException of its own canceled token cancels it.
        internal bool ExecuteEntry()
        {
            var state = State;
            if (state.Invoked || IsCompleted)
            {
                return IsCanceled;
            }

            state.Invoked = true;
            m_cancellationRegistration.Dispose();
            if (m_cancellationToken.IsCancellationRequested)
            {
                FinishCanceledDelegateTask();
                return true;
            }

            var previous = s_currentTask;
            s_currentTask = this;
            m_status = TaskStatus.Running;
            try
            {
                if (Gameplay.Runtime.Intrinsics.FlowsExecutionContext() && m_capturedContext is not null)
                {
                    ExecutionContext.RunInternal((ExecutionContext)m_capturedContext, static task => ((Task)task!).InvokeDelegate(), this);
                }
                else
                {
                    InvokeDelegate();
                }
            }
            catch (Exception exception)
            {
                if (exception is OperationCanceledException canceled && m_cancellationToken.IsCancellationRequested
                    && m_cancellationToken == canceled.CancellationToken)
                {
                    state.CancellationAcknowledged = true;
                    m_canceledBy = canceled;
                }
                else
                {
                    (m_faults ??= new List<Exception>()).Add(exception);
                }
            }
            finally
            {
                s_currentTask = previous;
            }

            FinishDelegateTask(true);
            return true;
        }

        // A constructor's, StartNew's or Task.Run's delegate, through its
        // state's slot (ContinueWith's tasks override this): a slot
        // every task's vtable has, whose code names no delegate task type.
        internal virtual void InvokeDelegate() => ((DelegateTaskHooks)m_delegateTask!).Invoke(this);

        // Its delegate ran: done, unless attached children are still
        // running, the last of which completes it (the CLR's Finish).
        private void FinishDelegateTask(bool invoked)
        {
            var state = State;
            if (invoked && state.Countdown > 1)
            {
                state.Countdown--;
                m_status = TaskStatus.WaitingForChildrenToComplete;
                return;
            }

            FinishStageTwo();
        }

        // Faulted, canceled or run to completion, with its children's
        // exceptions (each an AggregateException of them), then its parent
        // told and its continuations run.
        private void FinishStageTwo()
        {
            var state = State;
            if (state.FaultedChildren is { } children)
            {
                state.FaultedChildren = null;
                foreach (var child in children)
                {
                    if (!child.State.ObservedByParent)
                    {
                        (m_faults ??= new List<Exception>()).Add(child.GetExceptions(false)!);
                    }
                }
            }

            m_status = m_faults is not null ? TaskStatus.Faulted
                : state.CancellationAcknowledged && m_cancellationToken.IsCancellationRequested ? TaskStatus.Canceled
                : TaskStatus.RanToCompletion;
            m_cancellationRegistration.Dispose();
            FinishStageThree();
        }

        private void FinishStageThree()
        {
            if (State.Parent is { } parent)
            {
                parent.ProcessChildCompletion(this);
            }

            FinishContinuations();
        }

        private void ProcessChildCompletion(Task child)
        {
            var state = State;
            if (child.IsFaulted && !child.State.ObservedByParent)
            {
                (state.FaultedChildren ??= new List<Task>()).Add(child);
            }

            if (--state.Countdown == 0)
            {
                FinishStageTwo();
            }
        }

        // Canceled before its delegate ran.
        private void FinishCanceledDelegateTask()
        {
            if (IsCompleted)
            {
                return;
            }

            m_status = TaskStatus.Canceled;
            m_cancellationRegistration.Dispose();
            FinishStageThree();
        }

        // Faulted by its scheduler.
        private void FaultDelegateTask(Exception exception)
        {
            if (IsCompleted)
            {
                return;
            }

            (m_faults ??= new List<Exception>()).Add(exception);
            FinishDelegateTask(false);
        }

        // A child whose exception its parent's delegate observed (by
        // waiting for it) does not give the parent the exception too.
        internal void UpdateExceptionObservedStatus()
        {
            if (m_delegateTask is not null)
            {
                ((DelegateTaskHooks)m_delegateTask).UpdateExceptionObservedStatus();
            }
        }

        // Cancels a delegate task that has not started: at once if it is
        // not queued, or its scheduler takes it back, else when its turn
        // comes.
        internal void InternalCancel()
        {
            if (IsCompleted)
            {
                return;
            }

            if (m_status < TaskStatus.WaitingToRun
                || (Gameplay.Runtime.Intrinsics.HasTaskSchedulers() && m_status == TaskStatus.WaitingToRun && !State.Invoked
                    && State.Scheduler is not null && ((TaskScheduler)State.Scheduler).TryDequeue(this)))
            {
                if (m_delegateTask is not null)
                {
                    FinishCanceledDelegateTask();
                }
                else
                {
                    TrySetCanceled(m_cancellationToken);
                }
            }
        }
    }

    public partial class Task<TResult>
    {
        public Task(Func<TResult> function)
            : this(function, default, TaskCreationOptions.None)
        {
        }

        public Task(Func<TResult> function, CancellationToken cancellationToken)
            : this(function, cancellationToken, TaskCreationOptions.None)
        {
        }

        public Task(Func<TResult> function, TaskCreationOptions creationOptions)
            : this(function, default, creationOptions)
        {
        }

        public Task(Func<TResult> function, CancellationToken cancellationToken, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(function);
            InitializeDelegateTask(new FunctionTaskState<TResult> { Function = function }, null, cancellationToken, creationOptions, false, null);
        }

        public Task(Func<object?, TResult> function, object? state)
            : this(function, state, default, TaskCreationOptions.None)
        {
        }

        public Task(Func<object?, TResult> function, object? state, CancellationToken cancellationToken)
            : this(function, state, cancellationToken, TaskCreationOptions.None)
        {
        }

        public Task(Func<object?, TResult> function, object? state, TaskCreationOptions creationOptions)
            : this(function, state, default, creationOptions)
        {
        }

        public Task(Func<object?, TResult> function, object? state, CancellationToken cancellationToken, TaskCreationOptions creationOptions)
        {
            ArgumentNullException.ThrowIfNull(function);
            InitializeDelegateTask(
                new FunctionTaskState<TResult> { StateFunction = function }, state, cancellationToken, creationOptions, false, null);
        }

        internal Task(FunctionTaskState<TResult> state, CancellationToken cancellationToken, TaskCreationOptions creationOptions, object? scheduler)
        {
            InitializeDelegateTask(state, state.StateObject, cancellationToken, creationOptions, true, scheduler);
            state.Assigned = true;
        }

        // StartNew's and Task.Run's: queued at once.
        internal static Task<TResult> StartNew(
            FunctionTaskState<TResult> state, object? stateObject, CancellationToken cancellationToken, TaskCreationOptions creationOptions,
            object? scheduler)
        {
            state.StateObject = stateObject;
            var task = new Task<TResult>(state, cancellationToken, creationOptions, scheduler);
            task.ScheduleAndStart(false);
            return task;
        }

        public static new TaskFactory<TResult> Factory => TaskFactory<TResult>.Shared;
    }

    // The task of a task a function returned (Task.Run's, Unwrap's),
    // completed as the inner task completes, or as the outer one if it
    // faults or is canceled; one whose function returned null is canceled.
    internal sealed class UnwrapPromise<TResult> : Task<TResult>
    {
        private readonly bool lookForOce;
        private bool waitingOnInner;

        internal UnwrapPromise(Task<Task?>? outerOfTask, Task<Task<TResult>?>? outerOfResult, bool lookForOce)
            : base((object?)null, ((Task?)outerOfTask ?? outerOfResult)!.CreationOptions & TaskCreationOptions.AttachedToParent)
        {
            this.lookForOce = lookForOce;
            var outer = ((Task?)outerOfTask ?? outerOfResult)!;
            if (outer.IsCompleted)
            {
                ProcessOuter(outer, outerOfTask, outerOfResult);
            }
            else
            {
                outer.AddCompletionAction(new Completion(this, outerOfTask, outerOfResult));
            }
        }

        private void ProcessOuter(Task outer, Task<Task?>? outerOfTask, Task<Task<TResult>?>? outerOfResult)
        {
            waitingOnInner = true;
            if (!outer.IsCompletedSuccessfully)
            {
                SetFrom(outer, lookForOce);
                return;
            }

            Task? inner = outerOfTask is not null ? outerOfTask.ResultOnSuccess : outerOfResult!.ResultOnSuccess;
            if (inner is null)
            {
                TrySetCanceled(default);
            }
            else if (inner.IsCompleted)
            {
                SetFrom(inner, false);
            }
            else
            {
                inner.AddCompletionAction(new Completion(this, null, null));
            }
        }

        // An OperationCanceledException the outer delegate threw cancels
        // Task.Run's task, as a token's would.
        private void SetFrom(Task task, bool lookForOce)
        {
            if (task.IsFaulted && lookForOce && task.Faults[0] is OperationCanceledException canceled)
            {
                TrySetCanceled(canceled.CancellationToken, canceled);
            }
            else if (task.IsCompletedSuccessfully && task is not Task<TResult>)
            {
                TrySetResult(default!);
            }
            else
            {
                TrySetFromTask(task);
            }
        }

        private sealed class Completion : CompletionAction
        {
            private readonly UnwrapPromise<TResult> promise;
            private readonly Task<Task?>? outerOfTask;
            private readonly Task<Task<TResult>?>? outerOfResult;

            internal Completion(UnwrapPromise<TResult> promise, Task<Task?>? outerOfTask, Task<Task<TResult>?>? outerOfResult)
            {
                this.promise = promise;
                this.outerOfTask = outerOfTask;
                this.outerOfResult = outerOfResult;
            }

            // On the queue where the call-depth budget is running out, as
            // the CLR's where its stack is.
            internal override void Invoke(Task completingTask)
            {
                if (Gameplay.Runtime.Intrinsics.CallDepth() + 16 <= Gameplay.Runtime.Intrinsics.CallDepthLimit())
                {
                    Run(completingTask);
                }
                else
                {
                    FrameLoop.Queue(new CompletionActionInvoker(new Deferred(this), completingTask));
                }
            }

            private void Run(Task completingTask)
            {
                if (!promise.waitingOnInner)
                {
                    promise.ProcessOuter(completingTask, outerOfTask, outerOfResult);
                }
                else
                {
                    promise.SetFrom(completingTask, false);
                }
            }

            private sealed class Deferred : CompletionAction
            {
                private readonly Completion completion;

                internal Deferred(Completion completion) => this.completion = completion;

                internal override void Invoke(Task completingTask) => completion.Run(completingTask);
            }
        }
    }

    public static class TaskExtensions
    {
        public static Task Unwrap(this Task<Task> task)
        {
            ArgumentNullException.ThrowIfNull(task);
            return !task.IsCompletedSuccessfully ? new UnwrapPromise<VoidTaskResult>(task!, null, lookForOce: false)
                : task.ResultOnSuccess ?? Task.FromCanceled(new CancellationToken(true));
        }

        public static Task<TResult> Unwrap<TResult>(this Task<Task<TResult>> task)
        {
            ArgumentNullException.ThrowIfNull(task);
            return !task.IsCompletedSuccessfully ? new UnwrapPromise<TResult>(null, task!, lookForOce: false)
                : task.ResultOnSuccess ?? Task.FromCanceled<TResult>(new CancellationToken(true));
        }
    }
}

namespace Gameplay.Runtime
{
    // What a delegate task has that a promise has not: its scheduler (a
    // TaskScheduler, or null for the frame loop's queue, an object so that
    // a module without schedulers has no TaskScheduler), its progress, its
    // attached parent and children, and the delegate a constructor gave it
    // (ContinueWith's tasks keep theirs themselves).
    // What a task's code that every module has asks of a delegate task,
    // by slot (see Task.TryRunInlineForWait).
    internal abstract class DelegateTaskHooks
    {
        internal abstract void Invoke(Task task);

        internal abstract void RunInlineForWait(Task task, bool unbounded);

        internal abstract void UpdateExceptionObservedStatus();
    }

    internal class DelegateTaskState : DelegateTaskHooks
    {
        internal object? Scheduler;
        // A scheduler was given (Start, RunSynchronously, the runtime's own).
        internal bool Assigned;
        internal bool Started;
        internal bool Invoked;
        internal bool Continuation;
        internal bool CancellationAcknowledged;
        internal bool ObservedByParent;
        internal Task? Parent;
        // Itself, and each attached child still running.
        internal int Countdown = 1;
        internal List<Task>? FaultedChildren;
        internal Action? Action;
        internal Action<object?>? StateAction;
        internal object? StateObject;

        internal override void Invoke(Task task)
        {
            if (Action is { } action)
            {
                action();
            }
            else
            {
                StateAction!(task.AsyncState);
            }
        }

        internal override void RunInlineForWait(Task task, bool unbounded) => task.RunInlineForWait(this, unbounded);

        internal override void UpdateExceptionObservedStatus()
        {
            if (Parent is { } parent && Task.InternalCurrent == parent)
            {
                ObservedByParent = true;
            }
        }
    }

    internal sealed class FunctionTaskState<TResult> : DelegateTaskState
    {
        internal Func<TResult>? Function;
        internal Func<object?, TResult>? StateFunction;

        internal override void Invoke(Task task) =>
            ((Task<TResult>)task).m_result = Function is { } function ? function() : StateFunction!(task.AsyncState);
    }

    // A delegate task's turn on the frame loop's queue.
    internal sealed class QueuedDelegateTask : FrameWork
    {
        private readonly Task task;

        internal QueuedDelegateTask(Task task) => this.task = task;

        internal override void Execute() => task.ExecuteEntry();
    }
}
