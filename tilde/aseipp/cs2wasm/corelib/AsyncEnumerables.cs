// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What C#'s async iterators and `await foreach` and `await using` call
// (docs/IMPORTER.md, "Async as built"), after dotnet/runtime's
// AsyncIteratorMethodBuilder.cs, ManualResetValueTaskSourceCore.cs,
// ConfiguredCancelableAsyncEnumerable.cs, ConfiguredAsyncDisposable and
// TaskAsyncEnumerableExtensions.cs. An async iterator's state machine is a
// class, which is its own IAsyncEnumerator<T> and the IValueTaskSource of
// each MoveNextAsync; its builder boxes it as an async method's does.

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Threading;
using System.Threading.Tasks;
using System.Threading.Tasks.Sources;
using Gameplay.Runtime;

namespace System.Runtime.CompilerServices
{
    public struct AsyncIteratorMethodBuilder
    {
        private Task<VoidTaskResult>? m_task;

        public static AsyncIteratorMethodBuilder Create() => default;

        public void MoveNext<TStateMachine>(ref TStateMachine stateMachine)
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.Start(ref stateMachine);

        public void AwaitOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : INotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitOnCompleted(ref awaiter, ref stateMachine, ref m_task);

        public void AwaitUnsafeOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : ICriticalNotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitUnsafeOnCompleted(ref awaiter, ref stateMachine, ref m_task);

        public void Complete()
        {
            if (m_task is null)
            {
                m_task = VoidTaskCache.Completed;
            }
            else
            {
                AsyncMethodBuilderCore.SetExistingTaskResult(m_task, default(VoidTaskResult));
            }
        }
    }

    public readonly struct ConfiguredAsyncDisposable
    {
        private readonly IAsyncDisposable _source;
        private readonly bool _continueOnCapturedContext;

        internal ConfiguredAsyncDisposable(IAsyncDisposable source, bool continueOnCapturedContext)
        {
            _source = source;
            _continueOnCapturedContext = continueOnCapturedContext;
        }

        public ConfiguredValueTaskAwaitable DisposeAsync() => _source.DisposeAsync().ConfigureAwait(_continueOnCapturedContext);
    }

    public readonly struct ConfiguredCancelableAsyncEnumerable<T>
    {
        private readonly IAsyncEnumerable<T> _enumerable;
        private readonly CancellationToken _cancellationToken;
        private readonly bool _continueOnCapturedContext;

        internal ConfiguredCancelableAsyncEnumerable(IAsyncEnumerable<T> enumerable, bool continueOnCapturedContext, CancellationToken cancellationToken)
        {
            _enumerable = enumerable;
            _continueOnCapturedContext = continueOnCapturedContext;
            _cancellationToken = cancellationToken;
        }

        public ConfiguredCancelableAsyncEnumerable<T> ConfigureAwait(bool continueOnCapturedContext) =>
            new ConfiguredCancelableAsyncEnumerable<T>(_enumerable, continueOnCapturedContext, _cancellationToken);

        public ConfiguredCancelableAsyncEnumerable<T> WithCancellation(CancellationToken cancellationToken) =>
            new ConfiguredCancelableAsyncEnumerable<T>(_enumerable, _continueOnCapturedContext, cancellationToken);

        public Enumerator GetAsyncEnumerator() =>
            new Enumerator(_enumerable.GetAsyncEnumerator(_cancellationToken), _continueOnCapturedContext);

        public readonly struct Enumerator
        {
            private readonly IAsyncEnumerator<T> _enumerator;
            private readonly bool _continueOnCapturedContext;

            internal Enumerator(IAsyncEnumerator<T> enumerator, bool continueOnCapturedContext)
            {
                _enumerator = enumerator;
                _continueOnCapturedContext = continueOnCapturedContext;
            }

            public ConfiguredValueTaskAwaitable<bool> MoveNextAsync() => _enumerator.MoveNextAsync().ConfigureAwait(_continueOnCapturedContext);

            public T Current => _enumerator.Current;

            public ConfiguredValueTaskAwaitable DisposeAsync() => _enumerator.DisposeAsync().ConfigureAwait(_continueOnCapturedContext);
        }
    }
}

namespace System.Threading.Tasks
{
    // .NET's extension methods, as a class of static members: a CoreLib
    // static class's members are every module's (see TaskCache). Code
    // compiled against .NET's reference assemblies calls them all the same.
    public sealed class TaskAsyncEnumerableExtensions
    {
        private TaskAsyncEnumerableExtensions()
        {
        }

        public static ConfiguredAsyncDisposable ConfigureAwait(IAsyncDisposable source, bool continueOnCapturedContext) =>
            new ConfiguredAsyncDisposable(source, continueOnCapturedContext);

        public static ConfiguredCancelableAsyncEnumerable<T> ConfigureAwait<T>(IAsyncEnumerable<T> source, bool continueOnCapturedContext) =>
            new ConfiguredCancelableAsyncEnumerable<T>(source, continueOnCapturedContext, default);

        public static ConfiguredCancelableAsyncEnumerable<T> WithCancellation<T>(IAsyncEnumerable<T> source, CancellationToken cancellationToken) =>
            new ConfiguredCancelableAsyncEnumerable<T>(source, true, cancellationToken);
    }
}

namespace System.Threading.Tasks.Sources
{
    // The completion an async iterator's MoveNextAsync and DisposeAsync
    // hand out, reset for each: a continuation that captured a
    // SynchronizationContext is posted to it, one that did not runs inline
    // (unless RunContinuationsAsynchronously), as the CLR's.
    public struct ManualResetValueTaskSourceCore<TResult>
    {
        private Action<object?>? _continuation;
        private object? _continuationState;
        private SynchronizationContext? _capturedContext;
        // The ExecutionContext a continuation that flows it runs in (see
        // Task.m_capturedContext).
        private object? _executionContext;
        private ExceptionDispatchInfo? _error;
        private TResult _result;
        private short _version;
        private bool _completed;
        private bool _runContinuationsAsynchronously;

        public bool RunContinuationsAsynchronously
        {
            readonly get => _runContinuationsAsynchronously;
            set => _runContinuationsAsynchronously = value;
        }

        public short Version => _version;

        public void Reset()
        {
            _version++;
            _completed = false;
            _continuation = null;
            _continuationState = null;
            _capturedContext = null;
            _executionContext = null;
            _error = null;
            _result = default!;
        }

        public void SetResult(TResult result)
        {
            _result = result;
            SignalCompletion();
        }

        public void SetException(Exception error)
        {
            _error = ExceptionDispatchInfo.Capture(error);
            SignalCompletion();
        }

        public ValueTaskSourceStatus GetStatus(short token)
        {
            ValidateToken(token);
            return !_completed ? ValueTaskSourceStatus.Pending
                : _error is null ? ValueTaskSourceStatus.Succeeded
                : _error.SourceException is OperationCanceledException ? ValueTaskSourceStatus.Canceled
                : ValueTaskSourceStatus.Faulted;
        }

        public TResult GetResult(short token)
        {
            if (token != _version || !_completed || _error is not null)
            {
                _error?.Throw();
                throw new InvalidOperationException();
            }

            return _result;
        }

        public void OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
        {
            ArgumentNullException.ThrowIfNull(continuation);
            ValidateToken(token);
            if (_continuation is not null)
            {
                throw new InvalidOperationException();
            }

            if ((flags & ValueTaskSourceOnCompletedFlags.FlowExecutionContext) != 0 && Gameplay.Runtime.Intrinsics.FlowsExecutionContext())
            {
                _executionContext = ExecutionContext.Capture();
            }

            if ((flags & ValueTaskSourceOnCompletedFlags.UseSchedulingContext) != 0
                && SynchronizationContext.Current is { } context && context.GetType() != typeof(SynchronizationContext))
            {
                _capturedContext = context;
            }

            if (!_completed)
            {
                _continuation = continuation;
                _continuationState = state;
                return;
            }

            // Completed already: never inline.
            var captured = _capturedContext;
            var executionContext = _executionContext;
            _capturedContext = null;
            _executionContext = null;
            if (captured is null)
            {
                FrameLoop.Queue(!Gameplay.Runtime.Intrinsics.FlowsExecutionContext() || executionContext is null
                    ? new StateWork(continuation, state)
                    : new ContextWork((ExecutionContext)executionContext, continuation, state));
            }
            else
            {
                captured.Post(static posted => ((StateWork)posted!).Execute(), new StateWork(continuation, state));
            }
        }

        private readonly void ValidateToken(short token)
        {
            if (token != _version)
            {
                throw new InvalidOperationException();
            }
        }

        private void SignalCompletion()
        {
            if (_completed)
            {
                throw new InvalidOperationException();
            }

            _completed = true;
            if (_continuation is not { } continuation)
            {
                return;
            }

            object? state = _continuationState;
            var captured = _capturedContext;
            var executionContext = _executionContext;
            _continuation = null;
            _continuationState = null;
            _capturedContext = null;
            _executionContext = null;
            if (!Gameplay.Runtime.Intrinsics.FlowsExecutionContext() || executionContext is null)
            {
                Continue(continuation, state, captured, null);
                return;
            }

            // In the ExecutionContext it flows, as the CLR's. (One handler,
            // whose code a module that flows no context folds away.)
            object? previous = ExecutionContext.s_current;
            ExecutionContext.Restore((ExecutionContext)executionContext);
            try
            {
                Continue(continuation, state, captured, executionContext);
            }
            finally
            {
                if (Gameplay.Runtime.Intrinsics.FlowsExecutionContext())
                {
                    ExecutionContext.RestoreInternal((ExecutionContext?)previous);
                }
            }
        }

        private readonly void Continue(
            Action<object?> continuation, object? state, SynchronizationContext? captured, object? executionContext)
        {
            if (captured is not null)
            {
                captured.Post(static posted => ((StateWork)posted!).Execute(), new StateWork(continuation, state));
            }
            else if (_runContinuationsAsynchronously)
            {
                FrameLoop.Queue(!Gameplay.Runtime.Intrinsics.FlowsExecutionContext() || executionContext is null
                    ? new StateWork(continuation, state)
                    : new ContextWork((ExecutionContext)executionContext, continuation, state));
            }
            else
            {
                var current = SynchronizationContext.Current;
                try
                {
                    continuation(state);
                }
                finally
                {
                    FrameLoop.RestoreContext(current);
                }
            }
        }
    }
}

namespace Gameplay.Runtime
{
    // A continuation with its state, run from the frame loop or posted.
    internal sealed class StateWork : FrameWork
    {
        private readonly Action<object?> continuation;
        private readonly object? state;

        internal StateWork(Action<object?> continuation, object? state)
        {
            this.continuation = continuation;
            this.state = state;
        }

        internal override void Execute() => continuation(state);
    }
}
