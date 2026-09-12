// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The task library of a module's one thread (docs/IMPORTER.md, "Async"),
// written after dotnet/runtime's Task.cs, Task_T.cs, TaskContinuation.cs
// and TaskCompletionSource.cs: the same states, the same order of
// continuations (the first await continuation of a completing task runs
// inline where the CLR's would, the others are posted or queued), the same
// exceptions and messages. What the CLR runs on its thread pool runs on
// the frame loop's queue (Gameplay.Runtime.FrameLoop), which Frames.Advance
// drains; waiting for a task that is not complete would block the only
// thread for ever, so it is a fault (FrameLoop.Deadlock). There is no
// TaskScheduler but the default, no ExecutionContext and no thread pool.

using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using Gameplay.Runtime;

namespace System.Threading.Tasks
{
    public partial class Task : IDisposable
    {
        internal TaskStatus m_status;
        internal TaskCreationOptions m_options;
        internal object? m_stateObject;

        // Null, one continuation, or a ContinuationList of them: a
        // TaskContinuation (an await's, or ContinueWith's) or a
        // CompletionAction (a combinator's).
        private object? m_continuation;
        private List<Exception>? m_faults;
        private OperationCanceledException? m_canceledBy;
        internal CancellationToken m_cancellationToken;
        private int m_id;

        // The ExecutionContext a delegate task's delegate, or an async
        // method's next step (its box), runs in; null where flow was
        // suppressed, or the module flows none (an object, so that a
        // module without has no ExecutionContext).
        internal object? m_capturedContext;

        private static int s_nextId;

        // A promise: completed by the code that made it.
        internal Task()
        {
            m_status = TaskStatus.WaitingForActivation;
        }

        internal Task(object? state, TaskCreationOptions creationOptions)
        {
            if ((creationOptions & ~(TaskCreationOptions.AttachedToParent | TaskCreationOptions.RunContinuationsAsynchronously)) != 0)
            {
                throw new ArgumentOutOfRangeException(nameof(creationOptions));
            }

            m_status = TaskStatus.WaitingForActivation;
            m_stateObject = state;
            m_options = creationOptions;
        }

        // A task completed already: canceled by the token, or run to
        // completion.
        internal Task(bool canceled, CancellationToken cancellationToken)
        {
            if (canceled)
            {
                m_status = TaskStatus.Canceled;
                m_cancellationToken = cancellationToken;
            }
            else
            {
                m_status = TaskStatus.RanToCompletion;
            }
        }

        public static Task CompletedTask => VoidTaskCache.Completed;

        public object? AsyncState => m_stateObject;

        public TaskCreationOptions CreationOptions => m_options;

        public int Id
        {
            get
            {
                if (m_id == 0)
                {
                    m_id = NewId();
                }

                return m_id;
            }
        }

        internal static int NewId()
        {
            int id;
            do
            {
                id = ++s_nextId;
            }
            while (id == 0);
            return id;
        }

        public TaskStatus Status => m_status;

        public bool IsCompleted => m_status >= TaskStatus.RanToCompletion;

        public bool IsCompletedSuccessfully => m_status == TaskStatus.RanToCompletion;

        public bool IsCanceled => m_status == TaskStatus.Canceled;

        public bool IsFaulted => m_status == TaskStatus.Faulted;

        internal CancellationToken CancellationToken => m_cancellationToken;

        // A new aggregate of the task's exceptions each time, as the CLR's.
        public AggregateException? Exception => IsFaulted ? GetExceptions(false) : null;

        internal AggregateException? GetExceptions(bool includeTaskCanceledExceptions)
        {
            Exception? canceled = null;
            if (includeTaskCanceledExceptions && IsCanceled)
            {
                canceled = new TaskCanceledException(this);
            }

            if (m_faults is { } faults)
            {
                var all = new Exception[faults.Count + (canceled is null ? 0 : 1)];
                for (int i = 0; i < faults.Count; i++)
                {
                    all[i] = faults[i];
                }

                if (canceled is not null)
                {
                    all[faults.Count] = canceled;
                }

                return new AggregateException(all, true);
            }

            return canceled is null ? null : new AggregateException([canceled], true);
        }

        internal List<Exception> Faults => m_faults!;

        internal OperationCanceledException? CanceledBy => m_canceledBy;

        internal void ThrowIfExceptional(bool includeTaskCanceledExceptions)
        {
            if (GetExceptions(includeTaskCanceledExceptions) is { } exception)
            {
                UpdateExceptionObservedStatus();
                throw exception;
            }
        }

        public void Dispose()
        {
            Dispose(true);
        }

        protected virtual void Dispose(bool disposing)
        {
            if (disposing && !IsCompleted)
            {
                throw new InvalidOperationException(SR.Task_Dispose_NotCompleted);
            }
        }

        // MARK: Completion

        internal bool TrySetResult()
        {
            if (IsCompleted)
            {
                return false;
            }

            m_status = TaskStatus.RanToCompletion;
            FinishContinuations();
            return true;
        }

        // An Exception, or an IEnumerable<Exception> (checked by the
        // caller).
        internal bool TrySetException(object exceptionObject)
        {
            if (IsCompleted)
            {
                return false;
            }

            var faults = m_faults ??= new List<Exception>();
            if (exceptionObject is Exception exception)
            {
                faults.Add(exception);
            }
            else
            {
                foreach (var each in (IEnumerable<Exception>)exceptionObject)
                {
                    faults.Add(each);
                }
            }

            m_status = TaskStatus.Faulted;
            FinishContinuations();
            return true;
        }

        internal bool TrySetCanceled(CancellationToken token, OperationCanceledException? exception = null)
        {
            if (IsCompleted)
            {
                return false;
            }

            m_cancellationToken = token;
            m_canceledBy = exception;
            m_status = TaskStatus.Canceled;
            FinishContinuations();
            return true;
        }

        // Completes this task as another completed one did.
        internal bool TrySetFromTask(Task task)
        {
            if (task.IsFaulted)
            {
                return TrySetException(new List<Exception>(task.Faults));
            }

            if (task.IsCanceled)
            {
                return TrySetCanceled(task.m_cancellationToken, task.m_canceledBy);
            }

            return TrySetCompletedResultFrom(task);
        }

        internal virtual bool TrySetCompletedResultFrom(Task task) => TrySetResult();

        // MARK: Continuations

        // Adds a continuation, or false if the task has completed already.
        internal bool AddTaskContinuation(object continuation)
        {
            if (IsCompleted)
            {
                return false;
            }

            if (m_continuation is null)
            {
                m_continuation = continuation;
            }
            else if (m_continuation is ContinuationList list)
            {
                list.Add(continuation);
            }
            else
            {
                var added = new ContinuationList();
                added.Add(m_continuation);
                added.Add(continuation);
                m_continuation = added;
            }

            return true;
        }

        internal void RemoveContinuation(object continuation)
        {
            if (ReferenceEquals(m_continuation, continuation))
            {
                m_continuation = null;
            }
            else if (m_continuation is ContinuationList list)
            {
                list.Remove(continuation);
            }
        }

        internal void AddCompletionAction(CompletionAction action)
        {
            if (!AddTaskContinuation(action))
            {
                action.Invoke(this);
            }
        }

        // The continuations of a task that has just completed, in the order
        // dotnet/runtime's RunContinuations runs them.
        private void FinishContinuations()
        {
            object? continuations = m_continuation;
            m_continuation = null;
            if (continuations is null)
            {
                return;
            }

            // Inline only while the call-depth budget has room for one more
            // await's continuation and, past that, for queuing the next (16
            // calls: an await's resumption takes about nine, posting one
            // about four), as the CLR's only while
            // RuntimeHelpers.TryEnsureSufficientExecutionStack says its
            // stack has room: a long chain of awaits completing one another
            // goes on from the queue rather than exceeding the budget,
            // whatever it is. (The intrinsics, not a call: a call would
            // count.)
            bool canInline = (m_options & TaskCreationOptions.RunContinuationsAsynchronously) == 0
                             && Gameplay.Runtime.Intrinsics.CallDepth() + 16 <= Gameplay.Runtime.Intrinsics.CallDepthLimit();
            if (continuations is not ContinuationList list)
            {
                RunContinuation(continuations, canInline);
                return;
            }

            int count = list.Count;
            // The ones that must run asynchronously first: ContinueWith's
            // without ExecuteSynchronously, and every await continuation
            // after the first, so that an await is not run behind other
            // continuations' code.
            if (canInline)
            {
                bool forceAsync = false;
                for (int i = 0; i < count; i++)
                {
                    object? continuation = list[i];
                    if (continuation is null)
                    {
                        continue;
                    }

                    if (continuation is TaskContinuation { ContinueWithKind: not 0 } withTask)
                    {
                        if (withTask.ContinueWithKind == 2)
                        {
                            list[i] = null;
                            withTask.Run(this, false);
                        }
                    }
                    else if (continuation is not CompletionAction)
                    {
                        if (forceAsync)
                        {
                            list[i] = null;
                            RunContinuation(continuation, false);
                        }

                        forceAsync = true;
                    }
                }
            }

            for (int i = 0; i < count; i++)
            {
                object? continuation = list[i];
                if (continuation is null)
                {
                    continue;
                }

                list[i] = null;
                RunContinuation(continuation, canInline);
            }
        }

        private void RunContinuation(object continuation, bool canInline)
        {
            if (continuation is TaskContinuation taskContinuation)
            {
                taskContinuation.Run(this, canInline);
                return;
            }

            var completionAction = (CompletionAction)continuation;
            if (canInline || !completionAction.InvokeMayRunArbitraryCode)
            {
                completionAction.Invoke(this);
            }
            else
            {
                FrameLoop.Queue(new CompletionActionInvoker(completionAction, this));
            }
        }

        // An await's continuation: to the captured SynchronizationContext
        // when there is one (not the base class), else run where it may.
        // To the scheduler of the delegate task running, if it is not the
        // default: whether it was. (Its own method, which only a module with
        // schedulers has: see Intrinsics.HasTaskSchedulers.)
        private bool SetContinuationForScheduler(Action continuationAction, object? captured)
        {
            if (TaskScheduler.InternalCurrent is not { } scheduler || scheduler == TaskScheduler.Default)
            {
                return false;
            }

            var continuation = new TaskSchedulerAwaitTaskContinuation(scheduler, continuationAction, captured);
            if (!AddTaskContinuation(continuation))
            {
                continuation.Run(this, false);
            }

            return true;
        }

        // With `flowExecutionContext` (an awaiter's OnCompleted, not
        // UnsafeOnCompleted), the continuation runs in the ExecutionContext
        // current now.
        internal void SetContinuationForAwait(Action continuationAction, bool continueOnCapturedContext, bool flowExecutionContext)
        {
            object? captured = flowExecutionContext && Gameplay.Runtime.Intrinsics.FlowsExecutionContext() ? ExecutionContext.Capture() : null;
            if (continueOnCapturedContext
                && SynchronizationContext.Current is { } context
                && context.GetType() != typeof(SynchronizationContext))
            {
                var continuation = new SynchronizationContextAwaitTaskContinuation(context, continuationAction, captured);
                if (!AddTaskContinuation(continuation))
                {
                    continuation.Run(this, false);
                }
            }
            else if (continueOnCapturedContext && Gameplay.Runtime.Intrinsics.HasTaskSchedulers()
                     && SetContinuationForScheduler(continuationAction, captured))
            {
                // Back to the scheduler the awaiting delegate task runs on.
            }
            else
            {
                var continuation = new AwaitTaskContinuation(continuationAction, captured);
                if (!AddTaskContinuation(continuation))
                {
                    continuation.Run(this, false);
                }
            }
        }

        // Throws, in the frame loop's queue: what escapes a continuation or
        // an async void method (the CLR's thread pool crashes the process
        // with it); to the context, when one is given.
        internal static void ThrowAsync(Exception exception, SynchronizationContext? targetContext)
        {
            var info = ExceptionDispatchInfo.Capture(exception);
            if (targetContext is not null)
            {
                try
                {
                    targetContext.Post(static state => ((ExceptionDispatchInfo)state!).Throw(), info);
                    return;
                }
                catch (Exception postException)
                {
                    info = ExceptionDispatchInfo.Capture(new AggregateException(exception, postException));
                }
            }

            FrameLoop.Queue(new ThrowingWorkItem(info));
        }

        // MARK: Waiting

        // The module's one thread is the one waiting, so nothing completes
        // a task meanwhile: a wait with a timeout of one that has not
        // completed returns at once, as the CLR's does once the timeout has
        // passed, and one without would wait for ever, as the CLR's does on
        // a single-threaded context, and faults instead (20).
        internal void WaitForCompletion()
        {
            if (!IsCompleted)
            {
                TryRunInlineForWait(true);
                if (!IsCompleted)
                {
                    FrameLoop.Deadlock();
                }
            }
        }

        public void Wait()
        {
            WaitForCompletion();
            ThrowIfExceptional(true);
        }

        public void Wait(CancellationToken cancellationToken) => Wait(Timeout.Infinite, cancellationToken);

        public bool Wait(int millisecondsTimeout) => Wait(millisecondsTimeout, default);

        public bool Wait(int millisecondsTimeout, CancellationToken cancellationToken)
        {
            if (millisecondsTimeout < -1)
            {
                throw new ArgumentOutOfRangeException(nameof(millisecondsTimeout));
            }

            if (!IsCompleted)
            {
                TryRunInlineForWait(millisecondsTimeout == Timeout.Infinite && !cancellationToken.CanBeCanceled);
            }

            if (!IsCompleted)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (millisecondsTimeout != Timeout.Infinite)
                {
                    return false;
                }

                FrameLoop.Deadlock();
            }

            // A canceled wait of a canceled task throws the wait's
            // cancellation, as the CLR's.
            if (IsCanceled)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }

            ThrowIfExceptional(true);
            return true;
        }

        public bool Wait(TimeSpan timeout) => Wait(TimeoutMilliseconds(timeout, nameof(timeout)));

        public bool Wait(TimeSpan timeout, CancellationToken cancellationToken) =>
            Wait(TimeoutMilliseconds(timeout, nameof(timeout)), cancellationToken);

        private static int TimeoutMilliseconds(TimeSpan timeout, string name)
        {
            long milliseconds = (long)timeout.TotalMilliseconds;
            if (milliseconds < -1 || milliseconds > int.MaxValue)
            {
                throw new ArgumentOutOfRangeException(name);
            }

            return (int)milliseconds;
        }

        public static void WaitAll(params Task[] tasks)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            WaitAllCore(tasks, Timeout.Infinite, default);
        }

        public static void WaitAll(params ReadOnlySpan<Task> tasks) => WaitAllCore(tasks.ToArray(), Timeout.Infinite, default);

        public static void WaitAll(IEnumerable<Task> tasks, CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            cancellationToken.ThrowIfCancellationRequested();
            WaitAllCore(new List<Task>(tasks).ToArray(), Timeout.Infinite, cancellationToken);
        }

        public static void WaitAll(Task[] tasks, CancellationToken cancellationToken) =>
            WaitAll(tasks, Timeout.Infinite, cancellationToken);

        public static bool WaitAll(Task[] tasks, int millisecondsTimeout) => WaitAll(tasks, millisecondsTimeout, default);

        public static bool WaitAll(Task[] tasks, TimeSpan timeout) =>
            WaitAll(tasks, TimeoutMilliseconds(timeout, nameof(timeout)), default);

        public static bool WaitAll(Task[] tasks, int millisecondsTimeout, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            if (millisecondsTimeout < -1)
            {
                throw new ArgumentOutOfRangeException(nameof(millisecondsTimeout));
            }

            cancellationToken.ThrowIfCancellationRequested();
            return WaitAllCore(tasks, millisecondsTimeout, cancellationToken);
        }

        private static bool WaitAllCore(Task[] tasks, int millisecondsTimeout, CancellationToken cancellationToken)
        {
            bool completed = true;
            foreach (var task in tasks)
            {
                if (task is null)
                {
                    throw new ArgumentException(SR.Task_WaitMulti_NullTask, nameof(tasks));
                }

                if (!task.IsCompleted)
                {
                    task.TryRunInlineForWait(millisecondsTimeout == Timeout.Infinite && !cancellationToken.CanBeCanceled);
                }

                completed &= task.IsCompleted;
            }

            if (!completed)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (millisecondsTimeout != Timeout.Infinite)
                {
                    return false;
                }

                FrameLoop.Deadlock();
            }

            // A wait canceled while tasks were canceled but none faulted
            // throws its own cancellation, as the CLR's does.
            List<Exception>? exceptions = null;
            bool faulted = false;
            foreach (var task in tasks)
            {
                if (task.IsFaulted)
                {
                    faulted = true;
                    (exceptions ??= new List<Exception>()).AddRange(task.Faults);
                }
                else if (task.IsCanceled)
                {
                    (exceptions ??= new List<Exception>()).Add(new TaskCanceledException(task));
                }
            }

            if (exceptions is not null)
            {
                if (!faulted)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                }

                throw new AggregateException(exceptions);
            }

            return true;
        }

        public static int WaitAny(params Task[] tasks) => WaitAny(tasks, Timeout.Infinite, default);

        public static int WaitAny(Task[] tasks, CancellationToken cancellationToken) =>
            WaitAny(tasks, Timeout.Infinite, cancellationToken);

        public static int WaitAny(Task[] tasks, int millisecondsTimeout) => WaitAny(tasks, millisecondsTimeout, default);

        public static int WaitAny(Task[] tasks, TimeSpan timeout) =>
            WaitAny(tasks, TimeoutMilliseconds(timeout, nameof(timeout)), default);

        // The index of the first completed task, or -1 once the timeout
        // has passed.
        public static int WaitAny(Task[] tasks, int millisecondsTimeout, CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            if (millisecondsTimeout < -1)
            {
                throw new ArgumentOutOfRangeException(nameof(millisecondsTimeout));
            }

            cancellationToken.ThrowIfCancellationRequested();
            int completed = -1;
            for (int i = 0; i < tasks.Length; i++)
            {
                if (tasks[i] is not { } task)
                {
                    throw new ArgumentException(SR.Task_WaitMulti_NullTask, nameof(tasks));
                }

                if (completed == -1 && task.IsCompleted)
                {
                    completed = i;
                }
            }

            // Nothing else runs what is queued: the first of the default
            // scheduler's that runs to completion here, as a thread of the
            // CLR's pool would have.
            for (int i = 0; completed == -1 && i < tasks.Length; i++)
            {
                tasks[i].TryRunInlineForWait(false);
                if (tasks[i].IsCompleted)
                {
                    completed = i;
                }
            }

            if (completed == -1 && millisecondsTimeout == Timeout.Infinite)
            {
                FrameLoop.Deadlock();
            }

            return completed;
        }

        // A task of this one's outcome that faults with a TimeoutException
        // once the timeout has passed in game time, or is canceled with the
        // token, whichever comes first.
        public Task WaitAsync(CancellationToken cancellationToken) => WaitAsync(uint.MaxValue, cancellationToken);

        public Task WaitAsync(TimeSpan timeout) => WaitAsync(ValidateTimeout(timeout, nameof(timeout)), default);

        public Task WaitAsync(TimeSpan timeout, CancellationToken cancellationToken) =>
            WaitAsync(ValidateTimeout(timeout, nameof(timeout)), cancellationToken);

        private Task WaitAsync(uint milliseconds, CancellationToken cancellationToken)
        {
            if (IsCompleted || (!cancellationToken.CanBeCanceled && milliseconds == uint.MaxValue))
            {
                return this;
            }

            if (cancellationToken.IsCancellationRequested)
            {
                return FromCanceled(cancellationToken);
            }

            if (milliseconds == 0)
            {
                return FromException(new TimeoutException());
            }

            var promise = new Task();
            new WaitPromise(promise, this, milliseconds, cancellationToken);
            return promise;
        }

        // Completes a WaitAsync's task: as its source does, or with a
        // TimeoutException, or canceled.
        private protected sealed class WaitPromise : CompletionAction
        {
            private readonly Task promise;
            private readonly Task source;
            private readonly FrameTimer? timer;
            private readonly CancellationTokenRegistration registration;

            internal WaitPromise(Task promise, Task source, uint milliseconds, CancellationToken cancellationToken)
            {
                this.promise = promise;
                this.source = source;
                source.AddCompletionAction(this);
                if (milliseconds != uint.MaxValue)
                {
                    timer = FrameLoop.Instance.StartTimer(
                        milliseconds * TimeSpan.TicksPerMillisecond, static state => ((WaitPromise)state!).Elapsed(), this);
                }

                if (cancellationToken.CanBeCanceled)
                {
                    registration = cancellationToken.UnsafeRegister(static (state, token) => ((WaitPromise)state!).Canceled(token), this);
                }
            }

            internal override void Invoke(Task completingTask)
            {
                if (promise.TrySetFromTask(completingTask))
                {
                    timer?.Stop();
                    registration.Dispose();
                }
            }

            private void Elapsed()
            {
                if (promise.TrySetException(new TimeoutException()))
                {
                    registration.Dispose();
                    source.RemoveContinuation(this);
                }
            }

            private void Canceled(CancellationToken token)
            {
                if (promise.TrySetCanceled(token))
                {
                    timer?.Stop();
                    source.RemoveContinuation(this);
                }
            }
        }

        // MARK: Awaiting

        public TaskAwaiter GetAwaiter() => new TaskAwaiter(this);

        public ConfiguredTaskAwaitable ConfigureAwait(bool continueOnCapturedContext) =>
            new ConfiguredTaskAwaitable(this, continueOnCapturedContext ? ConfigureAwaitOptions.ContinueOnCapturedContext : ConfigureAwaitOptions.None);

        public ConfiguredTaskAwaitable ConfigureAwait(ConfigureAwaitOptions options)
        {
            if ((options & ~(ConfigureAwaitOptions.ContinueOnCapturedContext | ConfigureAwaitOptions.SuppressThrowing
                             | ConfigureAwaitOptions.ForceYielding)) != 0)
            {
                throw new ArgumentOutOfRangeException(nameof(options));
            }

            return new ConfiguredTaskAwaitable(this, options);
        }

        public static YieldAwaitable Yield() => default;

        // MARK: Factories

        public static Task<TResult> FromResult<TResult>(TResult result) => Task<TResult>.ForResult(result);

        public static Task FromException(Exception exception)
        {
            ArgumentNullException.ThrowIfNull(exception);
            var task = new Task();
            task.TrySetException(exception);
            return task;
        }

        public static Task<TResult> FromException<TResult>(Exception exception)
        {
            ArgumentNullException.ThrowIfNull(exception);
            var task = new Task<TResult>();
            task.TrySetException(exception);
            return task;
        }

        public static Task FromCanceled(CancellationToken cancellationToken)
        {
            if (!cancellationToken.IsCancellationRequested)
            {
                throw new ArgumentOutOfRangeException(nameof(cancellationToken));
            }

            return new Task(true, cancellationToken);
        }

        public static Task<TResult> FromCanceled<TResult>(CancellationToken cancellationToken)
        {
            if (!cancellationToken.IsCancellationRequested)
            {
                throw new ArgumentOutOfRangeException(nameof(cancellationToken));
            }

            var task = new Task<TResult>();
            task.TrySetCanceled(cancellationToken);
            return task;
        }

        internal static Task FromCanceled(OperationCanceledException exception)
        {
            var task = new Task();
            task.TrySetCanceled(exception.CancellationToken, exception);
            return task;
        }

        // MARK: Delay

        // Game time: a delay completes on the first frame (Frames.Advance)
        // whose time has reached it.
        public static Task Delay(int millisecondsDelay) => Delay(millisecondsDelay, default);

        public static Task Delay(int millisecondsDelay, CancellationToken cancellationToken)
        {
            if (millisecondsDelay < -1)
            {
                throw new ArgumentOutOfRangeException(nameof(millisecondsDelay), SR.Task_Delay_InvalidMillisecondsDelay);
            }

            return DelayCore((uint)millisecondsDelay, cancellationToken);
        }

        public static Task Delay(TimeSpan delay) => Delay(delay, default);

        // Whole milliseconds, as the CLR's timers count them.
        public static Task Delay(TimeSpan delay, CancellationToken cancellationToken) =>
            DelayCore(ValidateTimeout(delay, nameof(delay)), cancellationToken);

        internal static uint ValidateTimeout(TimeSpan timeout, string name)
        {
            long milliseconds = (long)timeout.TotalMilliseconds;
            if (milliseconds < -1 || milliseconds > 0xfffffffe)
            {
                throw new ArgumentOutOfRangeException(name, SR.Task_InvalidTimerTimeSpan);
            }

            return (uint)milliseconds;
        }

        private static Task DelayCore(uint milliseconds, CancellationToken cancellationToken)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                return FromCanceled(cancellationToken);
            }

            if (milliseconds == 0)
            {
                return CompletedTask;
            }

            return new DelayPromise(milliseconds == uint.MaxValue ? -1 : milliseconds * TimeSpan.TicksPerMillisecond, cancellationToken);
        }

        private sealed class DelayPromise : Task
        {
            private readonly FrameTimer? timer;
            private readonly CancellationTokenRegistration registration;

            internal DelayPromise(long ticks, CancellationToken cancellationToken)
            {
                if (ticks != -1)
                {
                    timer = FrameLoop.Instance.StartTimer(ticks, static state => ((DelayPromise)state!).Elapsed(), this);
                }

                if (cancellationToken.CanBeCanceled)
                {
                    registration = cancellationToken.UnsafeRegister(static (state, token) => ((DelayPromise)state!).Canceled(token), this);
                }
            }

            private void Elapsed()
            {
                if (TrySetResult())
                {
                    registration.Dispose();
                }
            }

            private void Canceled(CancellationToken token)
            {
                if (TrySetCanceled(token))
                {
                    timer?.Stop();
                    registration.Dispose();
                }
            }
        }

        // MARK: WhenAll and WhenAny

        public static Task WhenAll(IEnumerable<Task> tasks)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            if (tasks is Task[] array)
            {
                return WhenAll((ReadOnlySpan<Task>)array);
            }

            return WhenAll((ReadOnlySpan<Task>)new List<Task>(tasks).ToArray());
        }

        public static Task WhenAll(params Task[] tasks)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            return WhenAll((ReadOnlySpan<Task>)tasks);
        }

        public static Task WhenAll(params ReadOnlySpan<Task> tasks)
        {
            switch (tasks.Length)
            {
                case 0:
                    return CompletedTask;
                case 1:
                    return tasks[0] ?? throw new ArgumentException(SR.Task_MultiTaskContinuation_NullTask, nameof(tasks));
                default:
                    return new WhenAllPromise(tasks.ToArray()).Task;
            }
        }

        public static Task<TResult[]> WhenAll<TResult>(IEnumerable<Task<TResult>> tasks)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            if (tasks is Task<TResult>[] array)
            {
                return WhenAll((ReadOnlySpan<Task<TResult>>)array);
            }

            return WhenAll((ReadOnlySpan<Task<TResult>>)new List<Task<TResult>>(tasks).ToArray());
        }

        public static Task<TResult[]> WhenAll<TResult>(params Task<TResult>[] tasks)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            return WhenAll((ReadOnlySpan<Task<TResult>>)tasks);
        }

        public static Task<TResult[]> WhenAll<TResult>(params ReadOnlySpan<Task<TResult>> tasks)
        {
            if (tasks.IsEmpty)
            {
                var empty = new Task<TResult[]>();
                empty.TrySetResult(Array.Empty<TResult>());
                return empty;
            }

            var copy = tasks.ToArray();
            foreach (var task in copy)
            {
                if (task is null)
                {
                    throw new ArgumentException(SR.Task_MultiTaskContinuation_NullTask, nameof(tasks));
                }
            }

            return new WhenAllPromise<TResult>(copy).Task;
        }

        // The faulted and canceled tasks in the order they completed, as
        // the CLR's collects them.
        private sealed class WhenAllPromise : CompletionAction
        {
            internal readonly Task Task = new Task();
            private int remaining;
            private List<Task>? failedOrCanceled;

            internal WhenAllPromise(Task[] tasks)
            {
                foreach (var task in tasks)
                {
                    if (task is null)
                    {
                        throw new ArgumentException(SR.Task_MultiTaskContinuation_NullTask, nameof(tasks));
                    }
                }

                remaining = tasks.Length;
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

            internal override void Invoke(Task completedTask)
            {
                if (!completedTask.IsCompletedSuccessfully)
                {
                    (failedOrCanceled ??= new List<Task>()).Add(completedTask);
                }

                if (--remaining != 0)
                {
                    return;
                }

                if (failedOrCanceled is null)
                {
                    Task.TrySetResult();
                    return;
                }

                List<Exception>? exceptions = null;
                Task? canceled = null;
                foreach (var task in failedOrCanceled)
                {
                    if (task.IsFaulted)
                    {
                        (exceptions ??= new List<Exception>()).AddRange(task.Faults);
                    }
                    else if (task.IsCanceled)
                    {
                        canceled ??= task;
                    }
                }

                if (exceptions is not null)
                {
                    Task.TrySetException(exceptions);
                }
                else if (canceled is not null)
                {
                    Task.TrySetCanceled(canceled.m_cancellationToken, canceled.m_canceledBy);
                }
            }
        }

        private sealed class WhenAllPromise<T> : CompletionAction
        {
            internal readonly Task<T[]> Task = new Task<T[]>();
            private readonly Task<T>[] tasks;
            private int remaining;

            internal WhenAllPromise(Task<T>[] tasks)
            {
                this.tasks = tasks;
                remaining = tasks.Length;
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

            internal override void Invoke(Task ignored)
            {
                if (--remaining != 0)
                {
                    return;
                }

                var results = new T[tasks.Length];
                List<Exception>? exceptions = null;
                Task? canceled = null;
                for (int i = 0; i < tasks.Length; i++)
                {
                    var task = tasks[i];
                    if (task.IsFaulted)
                    {
                        (exceptions ??= new List<Exception>()).AddRange(task.Faults);
                    }
                    else if (task.IsCanceled)
                    {
                        canceled ??= task;
                    }
                    else
                    {
                        results[i] = task.ResultOnSuccess;
                    }
                }

                if (exceptions is not null)
                {
                    Task.TrySetException(exceptions);
                }
                else if (canceled is not null)
                {
                    Task.TrySetCanceled(canceled.m_cancellationToken, canceled.m_canceledBy);
                }
                else
                {
                    Task.TrySetResult(results);
                }
            }
        }

        public static Task<Task> WhenAny(params Task[] tasks)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            return WhenAnyCore<Task>(tasks);
        }

        public static Task<Task> WhenAny(params ReadOnlySpan<Task> tasks) => WhenAnyCore<Task>(tasks.ToArray());

        public static Task<Task> WhenAny(Task task1, Task task2) => WhenAnyOfTwo<Task>(task1, task2);

        public static Task<Task> WhenAny(IEnumerable<Task> tasks)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            return WhenAnyCore<Task>(new List<Task>(tasks).ToArray());
        }

        public static Task<Task<TResult>> WhenAny<TResult>(params Task<TResult>[] tasks)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            return WhenAnyCore<Task<TResult>>(tasks);
        }

        public static Task<Task<TResult>> WhenAny<TResult>(params ReadOnlySpan<Task<TResult>> tasks) =>
            WhenAnyCore<Task<TResult>>(tasks.ToArray());

        public static Task<Task<TResult>> WhenAny<TResult>(Task<TResult> task1, Task<TResult> task2) =>
            WhenAnyOfTwo<Task<TResult>>(task1, task2);

        public static Task<Task<TResult>> WhenAny<TResult>(IEnumerable<Task<TResult>> tasks)
        {
            ArgumentNullException.ThrowIfNull(tasks);
            return WhenAnyCore<Task<TResult>>(new List<Task<TResult>>(tasks).ToArray());
        }

        internal static Task<TTask> WhenAnyCore<TTask>(TTask[] tasks)
            where TTask : Task
        {
            if (tasks.Length == 2)
            {
                return WhenAnyOfTwo<TTask>(tasks[0], tasks[1]);
            }

            if (tasks.Length == 0)
            {
                throw new ArgumentException(SR.Task_MultiTaskContinuation_EmptyTaskList, nameof(tasks));
            }

            var copy = new TTask[tasks.Length];
            Array.Copy(tasks, copy, tasks.Length);
            foreach (var task in copy)
            {
                if (task is null)
                {
                    throw new ArgumentException(SR.Task_MultiTaskContinuation_NullTask, nameof(tasks));
                }
            }

            var promise = new WhenAnyPromise<TTask>(copy);
            foreach (var task in copy)
            {
                if (promise.Task.IsCompleted)
                {
                    break;
                }

                if (task.IsCompleted)
                {
                    promise.Invoke(task);
                    break;
                }

                task.AddCompletionAction(promise);
            }

            return promise.Task;
        }

        private static Task<TTask> WhenAnyOfTwo<TTask>(TTask task1, TTask task2)
            where TTask : Task
        {
            ArgumentNullException.ThrowIfNull(task1);
            ArgumentNullException.ThrowIfNull(task2);
            if (task1.IsCompleted || task2.IsCompleted)
            {
                var completed = new Task<TTask>();
                completed.TrySetResult(task1.IsCompleted ? task1 : task2);
                return completed;
            }

            var promise = new WhenAnyPromise<TTask>([task1, task2]);
            task1.AddCompletionAction(promise);
            task2.AddCompletionAction(promise);
            return promise.Task;
        }

        private sealed class WhenAnyPromise<TTask> : CompletionAction
            where TTask : Task
        {
            internal readonly Task<TTask> Task = new Task<TTask>();
            private TTask[]? tasks;

            internal WhenAnyPromise(TTask[] tasks)
            {
                this.tasks = tasks;
            }

            internal override void Invoke(Task completingTask)
            {
                if (tasks is not { } all)
                {
                    return;
                }

                tasks = null;
                foreach (var task in all)
                {
                    if (!ReferenceEquals(task, completingTask))
                    {
                        task.RemoveContinuation(this);
                    }
                }

                Task.TrySetResult((TTask)completingTask);
            }
        }
    }

    public partial class Task<TResult> : Task
    {
        internal TResult m_result = default!;

        private static Task<TResult>? s_defaultResultTask;

        internal Task()
        {
        }

        internal Task(object? state, TaskCreationOptions creationOptions)
            : base(state, creationOptions)
        {
        }

        internal Task(TResult result)
            : base(false, default)
        {
            m_result = result;
        }

        // Task.FromResult's cache, as the CLR's: one task for every null or
        // zero result, for each bool and for the ints from -1 to 8, whose
        // identity code could compare.
        internal static Task<TResult> ForResult(TResult result)
        {
            if (result is null)
            {
                return s_defaultResultTask ??= new Task<TResult>(default(TResult)!);
            }

            if (typeof(TResult) == typeof(bool))
            {
                return (Task<TResult>)(object)((bool)(object)result! ? TaskCache.True : TaskCache.False);
            }

            if (typeof(TResult) == typeof(int))
            {
                int value = (int)(object)result!;
                if ((uint)(value + 1) < 10)
                {
                    return (Task<TResult>)(object)TaskCache.Int32(value);
                }

                return new Task<TResult>(result);
            }

            if (IsDefaultBits(result))
            {
                return s_defaultResultTask ??= new Task<TResult>(default(TResult)!);
            }

            return new Task<TResult>(result);
        }

        // Whether a primitive result is all zero bits, which the CLR's
        // FromResult compares for value types of 1, 2, 4, 8 and 16 bytes
        // without references.
        private static bool IsDefaultBits(TResult result)
        {
            if (typeof(TResult) == typeof(long))
            {
                return (long)(object)result! == 0;
            }

            if (typeof(TResult) == typeof(uint))
            {
                return (uint)(object)result! == 0;
            }

            if (typeof(TResult) == typeof(ulong))
            {
                return (ulong)(object)result! == 0;
            }

            if (typeof(TResult) == typeof(short))
            {
                return (short)(object)result! == 0;
            }

            if (typeof(TResult) == typeof(ushort))
            {
                return (ushort)(object)result! == 0;
            }

            if (typeof(TResult) == typeof(byte))
            {
                return (byte)(object)result! == 0;
            }

            if (typeof(TResult) == typeof(sbyte))
            {
                return (sbyte)(object)result! == 0;
            }

            if (typeof(TResult) == typeof(char))
            {
                return (char)(object)result! == 0;
            }

            if (typeof(TResult) == typeof(float))
            {
                return BitConverter.SingleToInt32Bits((float)(object)result!) == 0;
            }

            if (typeof(TResult) == typeof(double))
            {
                return BitConverter.DoubleToInt64Bits((double)(object)result!) == 0;
            }

            return false;
        }

        public TResult Result
        {
            get
            {
                WaitForCompletion();
                if (!IsCompletedSuccessfully)
                {
                    ThrowIfExceptional(true);
                }

                return m_result;
            }
        }

        internal TResult ResultOnSuccess => m_result;

        internal bool TrySetResult(TResult result)
        {
            if (IsCompleted)
            {
                return false;
            }

            m_result = result;
            return TrySetResult();
        }

        internal override bool TrySetCompletedResultFrom(Task task) => TrySetResult(((Task<TResult>)task).m_result);

        public new Task<TResult> WaitAsync(CancellationToken cancellationToken) => WaitAsync(uint.MaxValue, cancellationToken);

        public new Task<TResult> WaitAsync(TimeSpan timeout) => WaitAsync(ValidateTimeout(timeout, nameof(timeout)), default);

        public new Task<TResult> WaitAsync(TimeSpan timeout, CancellationToken cancellationToken) =>
            WaitAsync(ValidateTimeout(timeout, nameof(timeout)), cancellationToken);

        private Task<TResult> WaitAsync(uint milliseconds, CancellationToken cancellationToken)
        {
            if (IsCompleted || (!cancellationToken.CanBeCanceled && milliseconds == uint.MaxValue))
            {
                return this;
            }

            if (cancellationToken.IsCancellationRequested)
            {
                return FromCanceled<TResult>(cancellationToken);
            }

            if (milliseconds == 0)
            {
                return FromException<TResult>(new TimeoutException());
            }

            var promise = new Task<TResult>();
            new WaitPromise(promise, this, milliseconds, cancellationToken);
            return promise;
        }

        public new TaskAwaiter<TResult> GetAwaiter() => new TaskAwaiter<TResult>(this);

        public new ConfiguredTaskAwaitable<TResult> ConfigureAwait(bool continueOnCapturedContext) =>
            new ConfiguredTaskAwaitable<TResult>(this, continueOnCapturedContext ? ConfigureAwaitOptions.ContinueOnCapturedContext : ConfigureAwaitOptions.None);

        public new ConfiguredTaskAwaitable<TResult> ConfigureAwait(ConfigureAwaitOptions options)
        {
            if ((options & ~(ConfigureAwaitOptions.ContinueOnCapturedContext | ConfigureAwaitOptions.ForceYielding)) != 0)
            {
                throw (options & ConfigureAwaitOptions.SuppressThrowing) == 0
                    ? new ArgumentOutOfRangeException(nameof(options))
                    : new ArgumentOutOfRangeException(nameof(options), SR.TaskT_ConfigureAwait_InvalidOptions);
            }

            return new ConfiguredTaskAwaitable<TResult>(this, options);
        }
    }

    // The CLR's cached tasks of Task.FromResult and the async methods that
    // return without awaiting. Not a static class: a CoreLib static class's
    // members are every module's (its static fields, the types its
    // signatures name), a class's only once code uses it.
    internal sealed class TaskCache
    {
        private TaskCache()
        {
        }

        private static Task<bool>? s_true;
        private static Task<bool>? s_false;
        private static Task<int>?[]? s_int32;

        internal static Task<bool> True => s_true ??= new Task<bool>(true);

        internal static Task<bool> False => s_false ??= new Task<bool>(false);

        internal static Task<int> Int32(int value)
        {
            var tasks = s_int32 ??= new Task<int>?[10];
            return tasks[value + 1] ??= new Task<int>(value);
        }
    }

    // A task's continuations once there is more than one; a removed one is
    // null.
    internal sealed class ContinuationList
    {
        private object?[] items = new object?[4];
        private int count;

        internal int Count => count;

        internal object? this[int index]
        {
            get => items[index];
            set => items[index] = value;
        }

        internal void Add(object continuation)
        {
            if (count == items.Length)
            {
                var grown = new object?[count * 2];
                for (int i = 0; i < count; i++)
                {
                    grown[i] = items[i];
                }

                items = grown;
            }

            items[count++] = continuation;
        }

        internal void Remove(object continuation)
        {
            for (int i = 0; i < count; i++)
            {
                if (ReferenceEquals(items[i], continuation))
                {
                    items[i] = null;
                    return;
                }
            }
        }
    }

    // The result type of a Task that has none (AsyncTaskMethodBuilder's).
    internal struct VoidTaskResult
    {
    }

    // What completes a combinator's task when another task completes; runs
    // synchronously, as the CLR runs its own. (A class, not an interface:
    // the CoreLib's non-generic interfaces are every module's.)
    internal abstract class CompletionAction
    {
        internal abstract void Invoke(Task completingTask);

        internal virtual bool InvokeMayRunArbitraryCode => true;
    }

    internal sealed class CompletionActionInvoker : FrameWork
    {
        private readonly CompletionAction action;
        private readonly Task completingTask;

        internal CompletionActionInvoker(CompletionAction action, Task completingTask)
        {
            this.action = action;
            this.completingTask = completingTask;
        }

        internal override void Execute() => action.Invoke(completingTask);
    }

    internal sealed class ThrowingWorkItem : FrameWork
    {
        private readonly ExceptionDispatchInfo info;

        internal ThrowingWorkItem(ExceptionDispatchInfo info) => this.info = info;

        internal override void Execute() => info.Throw();
    }

    internal abstract class TaskContinuation
    {
        internal abstract void Run(Task completedTask, bool canInlineContinuationTask);

        // 0 for an await's; ContinueWith's, 1 if it asked to run
        // synchronously, else 2. (Virtual, so that a module without
        // ContinueWith keeps none of its code.)
        internal virtual int ContinueWithKind => 0;
    }

    // An await continuation without a context: inline where the CLR's
    // would inline it (no SynchronizationContext of a derived type is
    // current), else queued. What it throws is thrown again in the queue.
    internal sealed class AwaitTaskContinuation : TaskContinuation
    {
        private readonly Action action;
        // The ExecutionContext it runs in, or null: where it runs.
        private readonly object? context;

        internal AwaitTaskContinuation(Action action, object? context)
        {
            this.action = action;
            this.context = context;
        }

        internal override void Run(Task completedTask, bool canInlineContinuationTask)
        {
            if (!Gameplay.Runtime.Intrinsics.FlowsExecutionContext() || context is null)
            {
                RunOrScheduleAction(action, canInlineContinuationTask);
            }
            else if (!canInlineContinuationTask || !IsValidLocationForInlining)
            {
                FrameLoop.Queue(new ContextWork((ExecutionContext)context, action));
            }
            else
            {
                try
                {
                    ExecutionContext.RunInternal(
                        (ExecutionContext)context, static state => ((ActionWork)state!).Execute(), new ActionWork(action));
                }
                catch (Exception exception)
                {
                    Task.ThrowAsync(exception, null);
                }
            }
        }

        internal static bool IsValidLocationForInlining =>
            SynchronizationContext.Current is not { } context || context.GetType() == typeof(SynchronizationContext);

        internal static void RunOrScheduleAction(Action action, bool allowInlining)
        {
            if (!allowInlining || !IsValidLocationForInlining)
            {
                FrameLoop.Queue(action);
                return;
            }

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

    internal sealed class SynchronizationContextAwaitTaskContinuation : TaskContinuation
    {
        private readonly SynchronizationContext context;
        private readonly Action action;
        private readonly object? executionContext;

        internal SynchronizationContextAwaitTaskContinuation(SynchronizationContext context, Action action, object? executionContext)
        {
            this.context = context;
            this.action = action;
            this.executionContext = executionContext;
        }

        // Inline when allowed and the context is current, else posted to
        // it; either in the ExecutionContext it flows, if it flows one.
        internal override void Run(Task completedTask, bool canInlineContinuationTask)
        {
            try
            {
                if (!Gameplay.Runtime.Intrinsics.FlowsExecutionContext() || executionContext is null)
                {
                    if (canInlineContinuationTask && context == SynchronizationContext.Current)
                    {
                        action();
                    }
                    else
                    {
                        context.Post(static state => ((ActionWork)state!).Execute(), new ActionWork(action));
                    }
                }
                else if (canInlineContinuationTask && context == SynchronizationContext.Current)
                {
                    ExecutionContext.RunInternal(
                        (ExecutionContext)executionContext, static state => ((ActionWork)state!).Execute(), new ActionWork(action));
                }
                else
                {
                    ExecutionContext.RunInternal(
                        (ExecutionContext)executionContext,
                        static state => ((SynchronizationContextAwaitTaskContinuation)state!).Post(),
                        this);
                }
            }
            catch (Exception exception)
            {
                Task.ThrowAsync(exception, null);
            }
        }

        private void Post() => context.Post(static state => ((ActionWork)state!).Execute(), new ActionWork(action));
    }

    // An await continuation to the scheduler of the delegate task that
    // awaited: a task of its own there, run inline if the caller lets it
    // and the scheduler does, as the CLR's.
    internal sealed class TaskSchedulerAwaitTaskContinuation : TaskContinuation
    {
        private readonly TaskScheduler scheduler;
        private readonly Action action;
        private readonly object? context;

        internal TaskSchedulerAwaitTaskContinuation(TaskScheduler scheduler, Action action, object? context)
        {
            this.scheduler = scheduler;
            this.action = action;
            this.context = context;
        }

        internal override void Run(Task completedTask, bool canInlineContinuationTask) =>
            RunOrScheduleAction(action, scheduler, context, canInlineContinuationTask);

        internal static void RunOrScheduleAction(Action action, TaskScheduler scheduler, object? context, bool allowInlining)
        {
            bool inlineIfPossible = allowInlining && (TaskScheduler.InternalCurrent == scheduler || FrameLoop.InPoolWork);
            var task = new Task(
                new DelegateTaskState { StateAction = static state => ((ActionWork)state!).ExecuteCatching() },
                default, TaskCreationOptions.None, scheduler);
            task.m_stateObject = new ActionWork(action);
            task.m_capturedContext = context;
            if (inlineIfPossible)
            {
                task.InlineIfPossibleOrElseQueue(false);
            }
            else
            {
                try
                {
                    task.ScheduleAndStart(false);
                }
                catch (TaskSchedulerException)
                {
                    // The task is faulted with it already.
                }
            }
        }
    }

    public class TaskCompletionSource
    {
        private readonly Task task;

        public TaskCompletionSource()
        {
            task = new Task();
        }

        public TaskCompletionSource(TaskCreationOptions creationOptions)
            : this(null, creationOptions)
        {
        }

        public TaskCompletionSource(object? state)
            : this(state, TaskCreationOptions.None)
        {
        }

        public TaskCompletionSource(object? state, TaskCreationOptions creationOptions)
        {
            task = new Task(state, creationOptions);
        }

        public Task Task => task;

        public void SetException(Exception exception)
        {
            if (!TrySetException(exception))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public void SetException(IEnumerable<Exception> exceptions)
        {
            if (!TrySetException(exceptions))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public bool TrySetException(Exception exception)
        {
            ArgumentNullException.ThrowIfNull(exception);
            return task.TrySetException(exception);
        }

        public bool TrySetException(IEnumerable<Exception> exceptions) =>
            task.TrySetException(TaskCompletionSourceChecks.Exceptions(exceptions));

        public void SetResult()
        {
            if (!TrySetResult())
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public bool TrySetResult() => task.TrySetResult();

        public void SetCanceled() => SetCanceled(default);

        public void SetCanceled(CancellationToken cancellationToken)
        {
            if (!TrySetCanceled(cancellationToken))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public bool TrySetCanceled() => TrySetCanceled(default);

        public bool TrySetCanceled(CancellationToken cancellationToken) => task.TrySetCanceled(cancellationToken);

        public void SetFromTask(Task completedTask)
        {
            if (!TrySetFromTask(completedTask))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public bool TrySetFromTask(Task completedTask)
        {
            TaskCompletionSourceChecks.Completed(completedTask);
            return !task.IsCompleted && task.TrySetFromTask(completedTask);
        }
    }

    public class TaskCompletionSource<TResult>
    {
        private readonly Task<TResult> task;

        public TaskCompletionSource()
        {
            task = new Task<TResult>();
        }

        public TaskCompletionSource(TaskCreationOptions creationOptions)
            : this(null, creationOptions)
        {
        }

        public TaskCompletionSource(object? state)
            : this(state, TaskCreationOptions.None)
        {
        }

        public TaskCompletionSource(object? state, TaskCreationOptions creationOptions)
        {
            task = new Task<TResult>(state, creationOptions);
        }

        public Task<TResult> Task => task;

        public void SetException(Exception exception)
        {
            if (!TrySetException(exception))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public void SetException(IEnumerable<Exception> exceptions)
        {
            if (!TrySetException(exceptions))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public bool TrySetException(Exception exception)
        {
            ArgumentNullException.ThrowIfNull(exception);
            return task.TrySetException(exception);
        }

        public bool TrySetException(IEnumerable<Exception> exceptions) =>
            task.TrySetException(TaskCompletionSourceChecks.Exceptions(exceptions));

        public void SetResult(TResult result)
        {
            if (!TrySetResult(result))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public bool TrySetResult(TResult result) => task.TrySetResult(result);

        public void SetCanceled() => SetCanceled(default);

        public void SetCanceled(CancellationToken cancellationToken)
        {
            if (!TrySetCanceled(cancellationToken))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public bool TrySetCanceled() => TrySetCanceled(default);

        public bool TrySetCanceled(CancellationToken cancellationToken) => task.TrySetCanceled(cancellationToken);

        public void SetFromTask(Task<TResult> completedTask)
        {
            if (!TrySetFromTask(completedTask))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public bool TrySetFromTask(Task<TResult> completedTask)
        {
            TaskCompletionSourceChecks.Completed(completedTask);
            return !task.IsCompleted && task.TrySetFromTask(completedTask);
        }
    }

    // Not a static class (see TaskCache).
    internal sealed class TaskCompletionSourceChecks
    {
        private TaskCompletionSourceChecks()
        {
        }

        // A copy of the exceptions, checked as the CLR checks them.
        internal static List<Exception> Exceptions(IEnumerable<Exception> exceptions)
        {
            ArgumentNullException.ThrowIfNull(exceptions);
            var list = new List<Exception>();
            foreach (var exception in exceptions)
            {
                if (exception is null)
                {
                    throw new ArgumentException(SR.TaskCompletionSourceT_TrySetException_NullException, nameof(exceptions));
                }

                list.Add(exception);
            }

            if (list.Count == 0)
            {
                throw new ArgumentException(SR.TaskCompletionSourceT_TrySetException_NoExceptions, nameof(exceptions));
            }

            return list;
        }

        internal static void Completed(Task completedTask)
        {
            ArgumentNullException.ThrowIfNull(completedTask);
            if (!completedTask.IsCompleted)
            {
                throw new ArgumentException(SR.Task_MustBeCompleted, nameof(completedTask));
            }
        }
    }

    public class TaskCanceledException : OperationCanceledException
    {
        private readonly Task? canceledTask;

        public TaskCanceledException()
            : base(SR.TaskCanceledException_ctor_DefaultMessage)
        {
        }

        public TaskCanceledException(string? message)
            : base(message ?? SR.TaskCanceledException_ctor_DefaultMessage)
        {
        }

        public TaskCanceledException(string? message, Exception? innerException)
            : base(message ?? SR.TaskCanceledException_ctor_DefaultMessage, innerException)
        {
        }

        public TaskCanceledException(string? message, Exception? innerException, CancellationToken token)
            : base(message ?? SR.TaskCanceledException_ctor_DefaultMessage, innerException, token)
        {
        }

        public TaskCanceledException(Task? task)
            : base(SR.TaskCanceledException_ctor_DefaultMessage, task is not null ? task.CancellationToken : CancellationToken.None)
        {
            canceledTask = task;
        }

        public Task? Task => canceledTask;
    }
}
