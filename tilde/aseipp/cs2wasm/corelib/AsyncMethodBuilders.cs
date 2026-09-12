// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The builders the state machines of C#'s async methods call
// (docs/IMPORTER.md, "Async"), after dotnet/runtime's
// AsyncTaskMethodBuilderT.cs, AsyncMethodBuilderCore.cs,
// AsyncVoidMethodBuilder.cs and AsyncValueTaskMethodBuilderT.cs. At its
// first await that does not complete synchronously, a method's state
// machine (a struct, as csc compiles it) is copied into a box, which is
// the method's task, and resumes there.

using System.Threading;
using System.Threading.Tasks;
using Gameplay.Runtime;

namespace System.Runtime.CompilerServices
{
    // A state machine's box: the task an async method returns, and what
    // resumes it (MoveNextAction, the continuation of each await).
    internal sealed class AsyncStateMachineBox<TStateMachine, TResult> : Task<TResult>
        where TStateMachine : IAsyncStateMachine
    {
        public TStateMachine StateMachine = default!;
        private Action? moveNextAction;

        public Action MoveNextAction => moveNextAction ??= new Action(MoveNext);

        // In the ExecutionContext the await captured, and, as the CLR's
        // ExecutionContext.RunInternal, what the step does to it and to the
        // current SynchronizationContext does not outlast it. An await
        // with the context's flow suppressed captured none: the step runs
        // in the current one.
        // (RunInternal's work, without its calls: each counts toward the
        // call-depth budget that a chain of awaits resuming one another
        // spends.)
        public void MoveNext()
        {
            // Objects, not ExecutionContexts: a body's locals are its
            // module's types, wherever they are used (see
            // Task.m_capturedContext); and one handler, whose code a
            // module that flows no context folds away.
            var context = SynchronizationContext.Current;
            object? captured = null;
            object? previous = null;
            if (Gameplay.Runtime.Intrinsics.FlowsExecutionContext() && m_capturedContext is not null)
            {
                captured = m_capturedContext;
                previous = ExecutionContext.s_current;
                ExecutionContext.RestoreInternal(((ExecutionContext)captured).IsDefault ? null : (ExecutionContext)captured);
            }

            try
            {
                StateMachine.MoveNext();
            }
            finally
            {
                FrameLoop.RestoreContext(context);
                if (Gameplay.Runtime.Intrinsics.FlowsExecutionContext() && captured is not null)
                {
                    ExecutionContext.RestoreInternal((ExecutionContext?)previous);
                }
            }

            if (IsCompleted)
            {
                StateMachine = default!;
            }
        }
    }

    // Not a static class (see TaskCache).
    internal sealed class AsyncMethodBuilderCore
    {
        private AsyncMethodBuilderCore()
        {
        }

        public static void Start<TStateMachine>(ref TStateMachine stateMachine)
            where TStateMachine : IAsyncStateMachine
        {
            if (stateMachine is null)
            {
                throw new ArgumentNullException(nameof(stateMachine));
            }

            // What the method's synchronous part does to the
            // ExecutionContext and the SynchronizationContext does not
            // outlast the call, as the CLR's.
            var context = SynchronizationContext.Current;
            object? executionContext = Gameplay.Runtime.Intrinsics.FlowsExecutionContext() ? ExecutionContext.s_current : null;
            try
            {
                stateMachine.MoveNext();
            }
            finally
            {
                FrameLoop.RestoreContext(context);
                if (Gameplay.Runtime.Intrinsics.FlowsExecutionContext())
                {
                    ExecutionContext.RestoreInternal((ExecutionContext?)executionContext);
                }
            }
        }

        public static void SetStateMachine(IAsyncStateMachine stateMachine, Task? task)
        {
            ArgumentNullException.ThrowIfNull(stateMachine);
            if (task is not null)
            {
                throw new InvalidOperationException(SR.AsyncMethodBuilder_InstanceNotInitialized);
            }
        }

        // The box of a state machine, made at its first suspension: the
        // task field is set first, so that the copy in the box has it.
        // Each await captures the ExecutionContext its continuation runs
        // in.
        public static AsyncStateMachineBox<TStateMachine, TResult> GetStateMachineBox<TStateMachine, TResult>(
            ref TStateMachine stateMachine, ref Task<TResult>? taskField)
            where TStateMachine : IAsyncStateMachine
        {
            object? context = Gameplay.Runtime.Intrinsics.FlowsExecutionContext() ? ExecutionContext.Capture() : null;
            if (taskField is AsyncStateMachineBox<TStateMachine, TResult> existing)
            {
                existing.m_capturedContext = context;
                return existing;
            }

            var box = new AsyncStateMachineBox<TStateMachine, TResult>();
            taskField = box;
            box.m_capturedContext = context;
            box.StateMachine = stateMachine;
            return box;
        }

        public static void AwaitOnCompleted<TAwaiter, TStateMachine, TResult>(
            ref TAwaiter awaiter, ref TStateMachine stateMachine, ref Task<TResult>? taskField)
            where TAwaiter : INotifyCompletion
            where TStateMachine : IAsyncStateMachine
        {
            try
            {
                awaiter.OnCompleted(GetStateMachineBox(ref stateMachine, ref taskField).MoveNextAction);
            }
            catch (Exception exception)
            {
                Task.ThrowAsync(exception, null);
            }
        }

        public static void AwaitUnsafeOnCompleted<TAwaiter, TStateMachine, TResult>(
            ref TAwaiter awaiter, ref TStateMachine stateMachine, ref Task<TResult>? taskField)
            where TAwaiter : ICriticalNotifyCompletion
            where TStateMachine : IAsyncStateMachine
        {
            var box = GetStateMachineBox(ref stateMachine, ref taskField);
            try
            {
                awaiter.UnsafeOnCompleted(box.MoveNextAction);
            }
            catch (Exception exception)
            {
                Task.ThrowAsync(exception, null);
            }
        }

        public static void SetExistingTaskResult<TResult>(Task<TResult> task, TResult result)
        {
            if (!task.TrySetResult(result))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        // An OperationCanceledException cancels the task, anything else
        // faults it.
        public static void SetException<TResult>(Exception exception, ref Task<TResult>? taskField)
        {
            ArgumentNullException.ThrowIfNull(exception);
            var task = taskField ??= new Task<TResult>();
            bool set = exception is OperationCanceledException canceled
                ? task.TrySetCanceled(canceled.CancellationToken, canceled)
                : task.TrySetException(exception);
            if (!set)
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }
    }

    public struct AsyncTaskMethodBuilder<TResult>
    {
        private Task<TResult>? m_task;

        public static AsyncTaskMethodBuilder<TResult> Create() => default;

        public void Start<TStateMachine>(ref TStateMachine stateMachine)
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.Start(ref stateMachine);

        public void SetStateMachine(IAsyncStateMachine stateMachine) =>
            AsyncMethodBuilderCore.SetStateMachine(stateMachine, m_task);

        public void AwaitOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : INotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitOnCompleted(ref awaiter, ref stateMachine, ref m_task);

        public void AwaitUnsafeOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : ICriticalNotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitUnsafeOnCompleted(ref awaiter, ref stateMachine, ref m_task);

        public Task<TResult> Task => m_task ??= new Task<TResult>();

        public void SetResult(TResult result)
        {
            if (m_task is null)
            {
                m_task = System.Threading.Tasks.Task.FromResult(result);
            }
            else
            {
                AsyncMethodBuilderCore.SetExistingTaskResult(m_task, result);
            }
        }

        public void SetException(Exception exception) => AsyncMethodBuilderCore.SetException(exception, ref m_task);
    }

    public struct AsyncTaskMethodBuilder
    {
        private Task<VoidTaskResult>? m_task;

        public static AsyncTaskMethodBuilder Create() => default;

        public void Start<TStateMachine>(ref TStateMachine stateMachine)
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.Start(ref stateMachine);

        public void SetStateMachine(IAsyncStateMachine stateMachine) =>
            AsyncMethodBuilderCore.SetStateMachine(stateMachine, m_task);

        public void AwaitOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : INotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitOnCompleted(ref awaiter, ref stateMachine, ref m_task);

        public void AwaitUnsafeOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : ICriticalNotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitUnsafeOnCompleted(ref awaiter, ref stateMachine, ref m_task);

        public Task Task => m_task ??= new Task<VoidTaskResult>();

        // A method that completes without awaiting returns the completed
        // task, as the CLR's does.
        public void SetResult()
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

        public void SetException(Exception exception) => AsyncMethodBuilderCore.SetException(exception, ref m_task);
    }

    // Task.CompletedTask, which an async method that completes without
    // awaiting returns, as the CLR's. Not a static class (see TaskCache).
    internal sealed class VoidTaskCache
    {
        private VoidTaskCache()
        {
        }

        private static Task<VoidTaskResult>? s_completed;

        internal static Task<VoidTaskResult> Completed => s_completed ??= new Task<VoidTaskResult>(default(VoidTaskResult));
    }

    public struct AsyncVoidMethodBuilder
    {
        private SynchronizationContext? _synchronizationContext;
        private AsyncTaskMethodBuilder _builder;

        public static AsyncVoidMethodBuilder Create()
        {
            SynchronizationContext? context = SynchronizationContext.Current;
            context?.OperationStarted();
            return new AsyncVoidMethodBuilder { _synchronizationContext = context };
        }

        public void Start<TStateMachine>(ref TStateMachine stateMachine)
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.Start(ref stateMachine);

        public void SetStateMachine(IAsyncStateMachine stateMachine) => _builder.SetStateMachine(stateMachine);

        public void AwaitOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : INotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            _builder.AwaitOnCompleted(ref awaiter, ref stateMachine);

        public void AwaitUnsafeOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : ICriticalNotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            _builder.AwaitUnsafeOnCompleted(ref awaiter, ref stateMachine);

        public void SetResult()
        {
            SynchronizationContext? context = _synchronizationContext;
            _builder.SetResult();
            if (context is not null)
            {
                NotifySynchronizationContextOfCompletion(context);
            }
        }

        // What escapes an async void method is thrown again in its context
        // (else the frame loop's queue), as the CLR throws it.
        public void SetException(Exception exception)
        {
            ArgumentNullException.ThrowIfNull(exception);
            SynchronizationContext? context = _synchronizationContext;
            if (context is not null)
            {
                try
                {
                    System.Threading.Tasks.Task.ThrowAsync(exception, context);
                }
                finally
                {
                    NotifySynchronizationContextOfCompletion(context);
                }
            }
            else
            {
                System.Threading.Tasks.Task.ThrowAsync(exception, null);
            }

            _builder.SetResult();
        }

        private static void NotifySynchronizationContextOfCompletion(SynchronizationContext context)
        {
            try
            {
                context.OperationCompleted();
            }
            catch (Exception exception)
            {
                System.Threading.Tasks.Task.ThrowAsync(exception, null);
            }
        }
    }

    public struct AsyncValueTaskMethodBuilder
    {
        private Task<VoidTaskResult>? m_task;
        private bool m_completedSynchronously;

        public static AsyncValueTaskMethodBuilder Create() => default;

        public void Start<TStateMachine>(ref TStateMachine stateMachine)
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.Start(ref stateMachine);

        public void SetStateMachine(IAsyncStateMachine stateMachine) =>
            AsyncMethodBuilderCore.SetStateMachine(stateMachine, null);

        public void SetResult()
        {
            if (m_task is null)
            {
                m_completedSynchronously = true;
            }
            else
            {
                AsyncMethodBuilderCore.SetExistingTaskResult(m_task, default(VoidTaskResult));
            }
        }

        public void SetException(Exception exception) => AsyncMethodBuilderCore.SetException(exception, ref m_task);

        public ValueTask Task
        {
            get
            {
                if (m_completedSynchronously)
                {
                    return default;
                }

                return new ValueTask(m_task ??= new Task<VoidTaskResult>());
            }
        }

        public void AwaitOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : INotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitOnCompleted(ref awaiter, ref stateMachine, ref m_task);

        public void AwaitUnsafeOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : ICriticalNotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitUnsafeOnCompleted(ref awaiter, ref stateMachine, ref m_task);
    }

    public struct AsyncValueTaskMethodBuilder<TResult>
    {
        private Task<TResult>? m_task;
        private bool m_completedSynchronously;
        private TResult _result;

        public static AsyncValueTaskMethodBuilder<TResult> Create() => default;

        public void Start<TStateMachine>(ref TStateMachine stateMachine)
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.Start(ref stateMachine);

        public void SetStateMachine(IAsyncStateMachine stateMachine) =>
            AsyncMethodBuilderCore.SetStateMachine(stateMachine, null);

        public void SetResult(TResult result)
        {
            if (m_task is null)
            {
                _result = result;
                m_completedSynchronously = true;
            }
            else
            {
                AsyncMethodBuilderCore.SetExistingTaskResult(m_task, result);
            }
        }

        public void SetException(Exception exception) => AsyncMethodBuilderCore.SetException(exception, ref m_task);

        public ValueTask<TResult> Task
        {
            get
            {
                if (m_completedSynchronously)
                {
                    return new ValueTask<TResult>(_result);
                }

                return new ValueTask<TResult>(m_task ??= new Task<TResult>());
            }
        }

        public void AwaitOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : INotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitOnCompleted(ref awaiter, ref stateMachine, ref m_task);

        public void AwaitUnsafeOnCompleted<TAwaiter, TStateMachine>(ref TAwaiter awaiter, ref TStateMachine stateMachine)
            where TAwaiter : ICriticalNotifyCompletion
            where TStateMachine : IAsyncStateMachine =>
            AsyncMethodBuilderCore.AwaitUnsafeOnCompleted(ref awaiter, ref stateMachine, ref m_task);
    }
}
