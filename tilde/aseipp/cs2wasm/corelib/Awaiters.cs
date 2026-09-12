// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What `await` calls (docs/IMPORTER.md, "Async"): the awaiters of Task,
// Task<T>, ValueTask and ValueTask<T>, their ConfigureAwait forms and
// Task.Yield's, after dotnet/runtime's TaskAwaiter.cs, YieldAwaitable.cs,
// ValueTask.cs and ValueTaskAwaiter.cs. Getting the result of a task that
// has not completed is a fault (Gameplay.Runtime.FrameLoop.Deadlock); an
// await never does that, since it only asks for the result once the task
// has completed.

using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using System.Threading.Tasks.Sources;
using Gameplay.Runtime;

namespace System.Runtime.CompilerServices
{
    public readonly struct TaskAwaiter : ICriticalNotifyCompletion
    {
        internal readonly Task m_task;

        internal TaskAwaiter(Task task) => m_task = task;

        public bool IsCompleted => m_task.IsCompleted;

        public void OnCompleted(Action continuation) => OnCompletedInternal(m_task, continuation, true, true);

        public void UnsafeOnCompleted(Action continuation) => OnCompletedInternal(m_task, continuation, true, false);

        public void GetResult() => ValidateEnd(m_task);

        // The first of a faulted task's exceptions as itself, a canceled
        // task's OperationCanceledException (or a new TaskCanceledException).
        internal static void ValidateEnd(Task task, ConfigureAwaitOptions options = ConfigureAwaitOptions.None)
        {
            if (task.IsCompletedSuccessfully)
            {
                return;
            }

            task.WaitForCompletion();
            if ((options & ConfigureAwaitOptions.SuppressThrowing) != 0)
            {
                return;
            }

            if (task.IsCanceled)
            {
                throw task.CanceledBy ?? new TaskCanceledException(task);
            }

            throw task.Faults[0];
        }

        internal static void OnCompletedInternal(Task task, Action continuation, bool continueOnCapturedContext, bool flowExecutionContext)
        {
            ArgumentNullException.ThrowIfNull(continuation);
            task.SetContinuationForAwait(continuation, continueOnCapturedContext, flowExecutionContext);
        }
    }

    public readonly struct TaskAwaiter<TResult> : ICriticalNotifyCompletion
    {
        private readonly Task<TResult> m_task;

        internal TaskAwaiter(Task<TResult> task) => m_task = task;

        public bool IsCompleted => m_task.IsCompleted;

        public void OnCompleted(Action continuation) => TaskAwaiter.OnCompletedInternal(m_task, continuation, true, true);

        public void UnsafeOnCompleted(Action continuation) => TaskAwaiter.OnCompletedInternal(m_task, continuation, true, false);

        public TResult GetResult()
        {
            TaskAwaiter.ValidateEnd(m_task);
            return m_task.ResultOnSuccess;
        }
    }

    public readonly struct ConfiguredTaskAwaitable
    {
        private readonly ConfiguredTaskAwaiter m_configuredTaskAwaiter;

        internal ConfiguredTaskAwaitable(Task task, ConfigureAwaitOptions options) =>
            m_configuredTaskAwaiter = new ConfiguredTaskAwaiter(task, options);

        public ConfiguredTaskAwaiter GetAwaiter() => m_configuredTaskAwaiter;

        public readonly struct ConfiguredTaskAwaiter : ICriticalNotifyCompletion
        {
            private readonly Task m_task;
            private readonly ConfigureAwaitOptions m_options;

            internal ConfiguredTaskAwaiter(Task task, ConfigureAwaitOptions options)
            {
                m_task = task;
                m_options = options;
            }

            public bool IsCompleted => (m_options & ConfigureAwaitOptions.ForceYielding) == 0 && m_task.IsCompleted;

            public void OnCompleted(Action continuation) =>
                TaskAwaiter.OnCompletedInternal(m_task, continuation, (m_options & ConfigureAwaitOptions.ContinueOnCapturedContext) != 0, true);

            public void UnsafeOnCompleted(Action continuation) =>
                TaskAwaiter.OnCompletedInternal(m_task, continuation, (m_options & ConfigureAwaitOptions.ContinueOnCapturedContext) != 0, false);

            public void GetResult() => TaskAwaiter.ValidateEnd(m_task, m_options);
        }
    }

    public readonly struct ConfiguredTaskAwaitable<TResult>
    {
        private readonly ConfiguredTaskAwaiter m_configuredTaskAwaiter;

        internal ConfiguredTaskAwaitable(Task<TResult> task, ConfigureAwaitOptions options) =>
            m_configuredTaskAwaiter = new ConfiguredTaskAwaiter(task, options);

        public ConfiguredTaskAwaiter GetAwaiter() => m_configuredTaskAwaiter;

        public readonly struct ConfiguredTaskAwaiter : ICriticalNotifyCompletion
        {
            private readonly Task<TResult> m_task;
            private readonly ConfigureAwaitOptions m_options;

            internal ConfiguredTaskAwaiter(Task<TResult> task, ConfigureAwaitOptions options)
            {
                m_task = task;
                m_options = options;
            }

            public bool IsCompleted => (m_options & ConfigureAwaitOptions.ForceYielding) == 0 && m_task.IsCompleted;

            public void OnCompleted(Action continuation) =>
                TaskAwaiter.OnCompletedInternal(m_task, continuation, (m_options & ConfigureAwaitOptions.ContinueOnCapturedContext) != 0, true);

            public void UnsafeOnCompleted(Action continuation) =>
                TaskAwaiter.OnCompletedInternal(m_task, continuation, (m_options & ConfigureAwaitOptions.ContinueOnCapturedContext) != 0, false);

            public TResult GetResult()
            {
                TaskAwaiter.ValidateEnd(m_task);
                return m_task.ResultOnSuccess;
            }
        }
    }

    // Task.Yield: posted to the current SynchronizationContext (not the
    // base class), else queued.
    public readonly struct YieldAwaitable
    {
        public YieldAwaiter GetAwaiter() => default;

        public readonly struct YieldAwaiter : ICriticalNotifyCompletion
        {
            public bool IsCompleted => false;

            public void OnCompleted(Action continuation) => QueueContinuation(continuation, true);

            public void UnsafeOnCompleted(Action continuation) => QueueContinuation(continuation, false);

            public void GetResult()
            {
            }

            // To the current scheduler, if it is not the default: whether it
            // was (only a module with schedulers has this method).
            private static bool QueueToScheduler(Action continuation)
            {
                var scheduler = TaskScheduler.Current;
                if (scheduler == TaskScheduler.Default)
                {
                    return false;
                }

                Task.Factory.StartNew(continuation, default, TaskCreationOptions.PreferFairness, scheduler);
                return true;
            }

            // Posted to the current context, as is, or queued, in the
            // ExecutionContext current now if it flows (the CLR's
            // QueueUserWorkItem, against UnsafeQueueUserWorkItem).
            private static void QueueContinuation(Action continuation, bool flowContext)
            {
                ArgumentNullException.ThrowIfNull(continuation);
                if (SynchronizationContext.Current is { } context && context.GetType() != typeof(SynchronizationContext))
                {
                    context.Post(static state => ((ActionWork)state!).Execute(), new ActionWork(continuation));
                }
                else if (Gameplay.Runtime.Intrinsics.HasTaskSchedulers() && QueueToScheduler(continuation))
                {
                    // On the scheduler of the delegate task running.
                }
                else if (flowContext && Gameplay.Runtime.Intrinsics.FlowsExecutionContext() && ExecutionContext.Capture() is not null)
                {
                    FrameLoop.Queue(new ContextWork(ExecutionContext.Capture()!, continuation));
                }
                else
                {
                    FrameLoop.Queue(continuation);
                }
            }
        }
    }

    public readonly struct ValueTaskAwaiter : ICriticalNotifyCompletion
    {
        private readonly ValueTask _value;

        internal ValueTaskAwaiter(in ValueTask value) => _value = value;

        public bool IsCompleted => _value.IsCompleted;

        public void GetResult() => _value.ThrowIfCompletedUnsuccessfully();

        public void OnCompleted(Action continuation) => _value.OnCompleted(continuation, true, true);

        public void UnsafeOnCompleted(Action continuation) => _value.OnCompleted(continuation, true, false);
    }

    public readonly struct ValueTaskAwaiter<TResult> : ICriticalNotifyCompletion
    {
        private readonly ValueTask<TResult> _value;

        internal ValueTaskAwaiter(in ValueTask<TResult> value) => _value = value;

        public bool IsCompleted => _value.IsCompleted;

        public TResult GetResult() => _value.Result;

        public void OnCompleted(Action continuation) => _value.OnCompleted(continuation, true, true);

        public void UnsafeOnCompleted(Action continuation) => _value.OnCompleted(continuation, true, false);
    }

    public readonly struct ConfiguredValueTaskAwaitable
    {
        private readonly ValueTask _value;
        private readonly bool _continueOnCapturedContext;

        internal ConfiguredValueTaskAwaitable(in ValueTask value, bool continueOnCapturedContext)
        {
            _value = value;
            _continueOnCapturedContext = continueOnCapturedContext;
        }

        public ConfiguredValueTaskAwaiter GetAwaiter() => new ConfiguredValueTaskAwaiter(_value, _continueOnCapturedContext);

        public readonly struct ConfiguredValueTaskAwaiter : ICriticalNotifyCompletion
        {
            private readonly ValueTask _value;
            private readonly bool _continueOnCapturedContext;

            internal ConfiguredValueTaskAwaiter(in ValueTask value, bool continueOnCapturedContext)
            {
                _value = value;
                _continueOnCapturedContext = continueOnCapturedContext;
            }

            public bool IsCompleted => _value.IsCompleted;

            public void GetResult() => _value.ThrowIfCompletedUnsuccessfully();

            public void OnCompleted(Action continuation) => _value.OnCompleted(continuation, _continueOnCapturedContext, true);

            public void UnsafeOnCompleted(Action continuation) => _value.OnCompleted(continuation, _continueOnCapturedContext, false);
        }
    }

    public readonly struct ConfiguredValueTaskAwaitable<TResult>
    {
        private readonly ValueTask<TResult> _value;
        private readonly bool _continueOnCapturedContext;

        internal ConfiguredValueTaskAwaitable(in ValueTask<TResult> value, bool continueOnCapturedContext)
        {
            _value = value;
            _continueOnCapturedContext = continueOnCapturedContext;
        }

        public ConfiguredValueTaskAwaiter GetAwaiter() => new ConfiguredValueTaskAwaiter(_value, _continueOnCapturedContext);

        public readonly struct ConfiguredValueTaskAwaiter : ICriticalNotifyCompletion
        {
            private readonly ValueTask<TResult> _value;
            private readonly bool _continueOnCapturedContext;

            internal ConfiguredValueTaskAwaiter(in ValueTask<TResult> value, bool continueOnCapturedContext)
            {
                _value = value;
                _continueOnCapturedContext = continueOnCapturedContext;
            }

            public bool IsCompleted => _value.IsCompleted;

            public TResult GetResult() => _value.Result;

            public void OnCompleted(Action continuation) => _value.OnCompleted(continuation, _continueOnCapturedContext, true);

            public void UnsafeOnCompleted(Action continuation) => _value.OnCompleted(continuation, _continueOnCapturedContext, false);
        }
    }
}

namespace System.Threading.Tasks
{
    // A result, a Task, or an IValueTaskSource and its token, as the CLR's.
    public readonly struct ValueTask : IEquatable<ValueTask>
    {
        internal readonly object? _obj;
        internal readonly short _token;

        private static Task? s_canceledTask;

        public ValueTask(Task task)
        {
            ArgumentNullException.ThrowIfNull(task);
            _obj = task;
            _token = 0;
        }

        public ValueTask(IValueTaskSource source, short token)
        {
            ArgumentNullException.ThrowIfNull(source);
            _obj = source;
            _token = token;
        }

        public static ValueTask CompletedTask => default;

        public static ValueTask<TResult> FromResult<TResult>(TResult result) => new ValueTask<TResult>(result);

        public static ValueTask FromCanceled(CancellationToken cancellationToken) => new ValueTask(Task.FromCanceled(cancellationToken));

        public static ValueTask<TResult> FromCanceled<TResult>(CancellationToken cancellationToken) =>
            new ValueTask<TResult>(Task.FromCanceled<TResult>(cancellationToken));

        public static ValueTask FromException(Exception exception) => new ValueTask(Task.FromException(exception));

        public static ValueTask<TResult> FromException<TResult>(Exception exception) =>
            new ValueTask<TResult>(Task.FromException<TResult>(exception));

        public override int GetHashCode() => _obj?.GetHashCode() ?? 0;

        public override bool Equals(object? obj) => obj is ValueTask other && Equals(other);

        public bool Equals(ValueTask other) => ReferenceEquals(_obj, other._obj) && _token == other._token;

        public static bool operator ==(ValueTask left, ValueTask right) => left.Equals(right);

        public static bool operator !=(ValueTask left, ValueTask right) => !left.Equals(right);

        public Task AsTask()
        {
            object? obj = _obj;
            if (obj is null)
            {
                return Task.CompletedTask;
            }

            if (obj is Task task)
            {
                return task;
            }

            return GetTaskForValueTaskSource((IValueTaskSource)obj);
        }

        public ValueTask Preserve() => _obj is null ? this : new ValueTask(AsTask());

        private Task GetTaskForValueTaskSource(IValueTaskSource source)
        {
            ValueTaskSourceStatus status = source.GetStatus(_token);
            if (status != ValueTaskSourceStatus.Pending)
            {
                try
                {
                    source.GetResult(_token);
                    return Task.CompletedTask;
                }
                catch (Exception exception)
                {
                    if (status == ValueTaskSourceStatus.Canceled)
                    {
                        if (exception is OperationCanceledException canceled)
                        {
                            return Task.FromCanceled(canceled);
                        }

                        return s_canceledTask ??= Task.FromCanceled(new CancellationToken(true));
                    }

                    return Task.FromException(exception);
                }
            }

            return new ValueTaskSourceAsTask(source, _token);
        }

        private sealed class ValueTaskSourceAsTask : Task
        {
            private IValueTaskSource? _source;
            private readonly short _token;

            internal ValueTaskSourceAsTask(IValueTaskSource source, short token)
            {
                _token = token;
                _source = source;
                source.OnCompleted(static state => ((ValueTaskSourceAsTask)state!).Complete(), this, token, ValueTaskSourceOnCompletedFlags.None);
            }

            private void Complete()
            {
                var source = _source!;
                _source = null;
                ValueTaskSourceStatus status = source.GetStatus(_token);
                try
                {
                    source.GetResult(_token);
                    TrySetResult();
                }
                catch (Exception exception)
                {
                    if (status == ValueTaskSourceStatus.Canceled)
                    {
                        if (exception is OperationCanceledException canceled)
                        {
                            TrySetCanceled(canceled.CancellationToken, canceled);
                        }
                        else
                        {
                            TrySetCanceled(new CancellationToken(true));
                        }
                    }
                    else
                    {
                        TrySetException(exception);
                    }
                }
            }
        }

        public bool IsCompleted
        {
            get
            {
                object? obj = _obj;
                if (obj is null)
                {
                    return true;
                }

                if (obj is Task task)
                {
                    return task.IsCompleted;
                }

                return ((IValueTaskSource)obj).GetStatus(_token) != ValueTaskSourceStatus.Pending;
            }
        }

        public bool IsCompletedSuccessfully
        {
            get
            {
                object? obj = _obj;
                if (obj is null)
                {
                    return true;
                }

                if (obj is Task task)
                {
                    return task.IsCompletedSuccessfully;
                }

                return ((IValueTaskSource)obj).GetStatus(_token) == ValueTaskSourceStatus.Succeeded;
            }
        }

        public bool IsFaulted
        {
            get
            {
                object? obj = _obj;
                if (obj is null)
                {
                    return false;
                }

                if (obj is Task task)
                {
                    return task.IsFaulted;
                }

                return ((IValueTaskSource)obj).GetStatus(_token) == ValueTaskSourceStatus.Faulted;
            }
        }

        public bool IsCanceled
        {
            get
            {
                object? obj = _obj;
                if (obj is null)
                {
                    return false;
                }

                if (obj is Task task)
                {
                    return task.IsCanceled;
                }

                return ((IValueTaskSource)obj).GetStatus(_token) == ValueTaskSourceStatus.Canceled;
            }
        }

        internal void ThrowIfCompletedUnsuccessfully()
        {
            object? obj = _obj;
            if (obj is null)
            {
                return;
            }

            if (obj is Task task)
            {
                TaskAwaiter.ValidateEnd(task);
            }
            else
            {
                ((IValueTaskSource)obj).GetResult(_token);
            }
        }

        public ValueTaskAwaiter GetAwaiter() => new ValueTaskAwaiter(in this);

        public ConfiguredValueTaskAwaitable ConfigureAwait(bool continueOnCapturedContext) =>
            new ConfiguredValueTaskAwaitable(in this, continueOnCapturedContext);

        internal void OnCompleted(Action continuation, bool continueOnCapturedContext, bool flowExecutionContext)
        {
            object? obj = _obj;
            if (obj is Task task)
            {
                TaskAwaiter.OnCompletedInternal(task, continuation, continueOnCapturedContext, flowExecutionContext);
            }
            else if (obj is not null)
            {
                ArgumentNullException.ThrowIfNull(continuation);
                ((IValueTaskSource)obj).OnCompleted(
                    static state => ((ActionWork)state!).Execute(),
                    new ActionWork(continuation),
                    _token,
                    (continueOnCapturedContext ? ValueTaskSourceOnCompletedFlags.UseSchedulingContext : ValueTaskSourceOnCompletedFlags.None)
                    | (flowExecutionContext ? ValueTaskSourceOnCompletedFlags.FlowExecutionContext : ValueTaskSourceOnCompletedFlags.None));
            }
            else
            {
                TaskAwaiter.OnCompletedInternal(Task.CompletedTask, continuation, continueOnCapturedContext, flowExecutionContext);
            }
        }
    }

    public readonly struct ValueTask<TResult> : IEquatable<ValueTask<TResult>>
    {
        internal readonly object? _obj;
        internal readonly TResult? _result;
        internal readonly short _token;

        private static Task<TResult>? s_canceledTask;

        public ValueTask(TResult result)
        {
            _result = result;
            _obj = null;
            _token = 0;
        }

        public ValueTask(Task<TResult> task)
        {
            ArgumentNullException.ThrowIfNull(task);
            _obj = task;
            _result = default;
            _token = 0;
        }

        public ValueTask(IValueTaskSource<TResult> source, short token)
        {
            ArgumentNullException.ThrowIfNull(source);
            _obj = source;
            _token = token;
            _result = default;
        }

        public override int GetHashCode() =>
            _obj is not null ? _obj.GetHashCode() : _result is not null ? _result.GetHashCode() : 0;

        public override bool Equals(object? obj) => obj is ValueTask<TResult> other && Equals(other);

        public bool Equals(ValueTask<TResult> other) =>
            _obj is not null || other._obj is not null
                ? ReferenceEquals(_obj, other._obj) && _token == other._token
                : System.Collections.Generic.EqualityComparer<TResult>.Default.Equals(_result, other._result);

        public static bool operator ==(ValueTask<TResult> left, ValueTask<TResult> right) => left.Equals(right);

        public static bool operator !=(ValueTask<TResult> left, ValueTask<TResult> right) => !left.Equals(right);

        public Task<TResult> AsTask()
        {
            object? obj = _obj;
            if (obj is null)
            {
                return Task.FromResult(_result!);
            }

            if (obj is Task<TResult> task)
            {
                return task;
            }

            return GetTaskForValueTaskSource((IValueTaskSource<TResult>)obj);
        }

        public ValueTask<TResult> Preserve() => _obj is null ? this : new ValueTask<TResult>(AsTask());

        private Task<TResult> GetTaskForValueTaskSource(IValueTaskSource<TResult> source)
        {
            ValueTaskSourceStatus status = source.GetStatus(_token);
            if (status != ValueTaskSourceStatus.Pending)
            {
                try
                {
                    return Task.FromResult(source.GetResult(_token));
                }
                catch (Exception exception)
                {
                    if (status == ValueTaskSourceStatus.Canceled)
                    {
                        if (exception is OperationCanceledException canceled)
                        {
                            var task = new Task<TResult>();
                            task.TrySetCanceled(canceled.CancellationToken, canceled);
                            return task;
                        }

                        return s_canceledTask ??= Task.FromCanceled<TResult>(new CancellationToken(true));
                    }

                    return Task.FromException<TResult>(exception);
                }
            }

            return new ValueTaskSourceAsTask(source, _token);
        }

        private sealed class ValueTaskSourceAsTask : Task<TResult>
        {
            private IValueTaskSource<TResult>? _source;
            private readonly short _token;

            internal ValueTaskSourceAsTask(IValueTaskSource<TResult> source, short token)
            {
                _source = source;
                _token = token;
                source.OnCompleted(static state => ((ValueTaskSourceAsTask)state!).Complete(), this, token, ValueTaskSourceOnCompletedFlags.None);
            }

            private void Complete()
            {
                var source = _source!;
                _source = null;
                ValueTaskSourceStatus status = source.GetStatus(_token);
                try
                {
                    TrySetResult(source.GetResult(_token));
                }
                catch (Exception exception)
                {
                    if (status == ValueTaskSourceStatus.Canceled)
                    {
                        if (exception is OperationCanceledException canceled)
                        {
                            TrySetCanceled(canceled.CancellationToken, canceled);
                        }
                        else
                        {
                            TrySetCanceled(new CancellationToken(true));
                        }
                    }
                    else
                    {
                        TrySetException(exception);
                    }
                }
            }
        }

        public bool IsCompleted
        {
            get
            {
                object? obj = _obj;
                if (obj is null)
                {
                    return true;
                }

                if (obj is Task<TResult> task)
                {
                    return task.IsCompleted;
                }

                return ((IValueTaskSource<TResult>)obj).GetStatus(_token) != ValueTaskSourceStatus.Pending;
            }
        }

        public bool IsCompletedSuccessfully
        {
            get
            {
                object? obj = _obj;
                if (obj is null)
                {
                    return true;
                }

                if (obj is Task<TResult> task)
                {
                    return task.IsCompletedSuccessfully;
                }

                return ((IValueTaskSource<TResult>)obj).GetStatus(_token) == ValueTaskSourceStatus.Succeeded;
            }
        }

        public bool IsFaulted
        {
            get
            {
                object? obj = _obj;
                if (obj is null)
                {
                    return false;
                }

                if (obj is Task<TResult> task)
                {
                    return task.IsFaulted;
                }

                return ((IValueTaskSource<TResult>)obj).GetStatus(_token) == ValueTaskSourceStatus.Faulted;
            }
        }

        public bool IsCanceled
        {
            get
            {
                object? obj = _obj;
                if (obj is null)
                {
                    return false;
                }

                if (obj is Task<TResult> task)
                {
                    return task.IsCanceled;
                }

                return ((IValueTaskSource<TResult>)obj).GetStatus(_token) == ValueTaskSourceStatus.Canceled;
            }
        }

        // The result of a completed ValueTask; a Task's blocks (faults) if
        // it has not completed, as Task<T>.Result does.
        public TResult Result
        {
            get
            {
                object? obj = _obj;
                if (obj is null)
                {
                    return _result!;
                }

                if (obj is Task<TResult> task)
                {
                    TaskAwaiter.ValidateEnd(task);
                    return task.ResultOnSuccess;
                }

                return ((IValueTaskSource<TResult>)obj).GetResult(_token);
            }
        }

        public ValueTaskAwaiter<TResult> GetAwaiter() => new ValueTaskAwaiter<TResult>(in this);

        public ConfiguredValueTaskAwaitable<TResult> ConfigureAwait(bool continueOnCapturedContext) =>
            new ConfiguredValueTaskAwaitable<TResult>(in this, continueOnCapturedContext);

        internal void OnCompleted(Action continuation, bool continueOnCapturedContext, bool flowExecutionContext)
        {
            object? obj = _obj;
            if (obj is Task<TResult> task)
            {
                TaskAwaiter.OnCompletedInternal(task, continuation, continueOnCapturedContext, flowExecutionContext);
            }
            else if (obj is not null)
            {
                ArgumentNullException.ThrowIfNull(continuation);
                ((IValueTaskSource<TResult>)obj).OnCompleted(
                    static state => ((ActionWork)state!).Execute(),
                    new ActionWork(continuation),
                    _token,
                    (continueOnCapturedContext ? ValueTaskSourceOnCompletedFlags.UseSchedulingContext : ValueTaskSourceOnCompletedFlags.None)
                    | (flowExecutionContext ? ValueTaskSourceOnCompletedFlags.FlowExecutionContext : ValueTaskSourceOnCompletedFlags.None));
            }
            else
            {
                TaskAwaiter.OnCompletedInternal(Task.CompletedTask, continuation, continueOnCapturedContext, flowExecutionContext);
            }
        }

        public override string? ToString()
        {
            if (IsCompletedSuccessfully)
            {
                TResult result = Result;
                if (result is not null)
                {
                    return result.ToString();
                }
            }

            return string.Empty;
        }
    }
}
