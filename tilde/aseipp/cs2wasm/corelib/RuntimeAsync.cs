// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the importer's splitter of runtime-async methods calls
// (docs/IMPORTER.md, "Async as built"; src/Gameplay.Compiler/Il.RuntimeAsync.cs).
// A method compiled with MethodImplAttributes.Async awaits by calling
// AsyncHelpers.Await; the splitter makes it a resumable function over a
// frame of its locals, whose task is a RuntimeAsyncTask and whose
// continuation (the Action every await registers) resumes it. These are
// the builder protocol's steps as the method's own IL performs them: the
// same awaiters, the same continuations, the same completions as an async
// method's state machine and AsyncTaskMethodBuilder.

using System;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;

namespace Gameplay.Runtime
{
    // A runtime-async method's task; VoidTaskResult for one returning Task
    // or ValueTask.
    internal sealed class RuntimeAsyncTask<TResult> : Task<TResult>
    {
        // Whether the method has suspended: until then, its completion is
        // returned as an async method's would be (Task.FromResult's cache).
        internal bool Suspended;
    }

    // A class of static members rather than a static class (see TaskCache).
    internal sealed class RuntimeAsync
    {
        private RuntimeAsync()
        {
        }

        // A step starts: the current SynchronizationContext, which the
        // step's end restores, as AsyncMethodBuilderCore.Start and the
        // state machine box's MoveNext do.
        public static SynchronizationContext? EnterStep() => SynchronizationContext.Current;

        public static void LeaveStep(SynchronizationContext? context) => FrameLoop.RestoreContext(context);

        // And the ExecutionContext, which the first step's end restores too
        // (as AsyncMethodBuilderCore.Start): what the method sets before it
        // first suspends does not outlast the call. A later step runs in
        // the context its await captured (InContext), or, with the flow
        // suppressed there, in the current one, which it leaves as it is,
        // as the state machine box's MoveNext does.
        // (An object, not an ExecutionContext: see Task.m_capturedContext.)
        public static object? EnterContext(int state) =>
            !Intrinsics.FlowsExecutionContext() ? null : state == 0 ? ExecutionContext.s_current : ExecutionContext.Untouched;

        public static void LeaveContext(object? context)
        {
            if (Intrinsics.FlowsExecutionContext() && context != ExecutionContext.Untouched)
            {
                ExecutionContext.RestoreInternal((ExecutionContext?)context);
            }
        }

        // An await that does not complete: the continuation registered with
        // the awaiter (AwaitUnsafeOnCompleted's), which resumes the method
        // in the ExecutionContext current now, then the method suspends.
        public static void Suspend<TAwaiter, TResult>(ref TAwaiter awaiter, Action resume, RuntimeAsyncTask<TResult> task)
            where TAwaiter : ICriticalNotifyCompletion
        {
            task.Suspended = true;
            try
            {
                awaiter.UnsafeOnCompleted(InContext(resume));
            }
            catch (Exception exception)
            {
                Task.ThrowAsync(exception, null);
            }
        }

        // AwaitAwaiter's: through INotifyCompletion.OnCompleted.
        public static void SuspendSafe<TAwaiter, TResult>(ref TAwaiter awaiter, Action resume, RuntimeAsyncTask<TResult> task)
            where TAwaiter : INotifyCompletion
        {
            task.Suspended = true;
            try
            {
                awaiter.OnCompleted(InContext(resume));
            }
            catch (Exception exception)
            {
                Task.ThrowAsync(exception, null);
            }
        }

        private static Action InContext(Action resume) =>
            Intrinsics.FlowsExecutionContext() && ExecutionContext.Capture() is not null
                ? new ContextResume(ExecutionContext.Capture()!, resume).Run
                : resume;

        private sealed class ContextResume
        {
            private readonly ExecutionContext context;
            private readonly Action resume;

            internal ContextResume(ExecutionContext context, Action resume)
            {
                this.context = context;
                this.resume = resume;
            }

            // ExecutionContext.RunInternal's work, without its calls (see
            // AsyncStateMachineBox.MoveNext).
            internal void Run()
            {
                var previous = ExecutionContext.s_current;
                var synchronization = SynchronizationContext.Current;
                ExecutionContext.RestoreInternal(context.IsDefault ? null : context);
                try
                {
                    resume();
                }
                finally
                {
                    FrameLoop.RestoreContext(synchronization);
                    ExecutionContext.RestoreInternal(previous);
                }
            }
        }

        public static void Complete<TResult>(RuntimeAsyncTask<TResult> task, TResult result)
        {
            if (!task.TrySetResult(result))
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        public static void CompleteVoid(RuntimeAsyncTask<VoidTaskResult> task) => Complete(task, default(VoidTaskResult));

        // What escapes the method: an OperationCanceledException cancels
        // its task, anything else faults it.
        public static void Fail<TResult>(RuntimeAsyncTask<TResult> task, Exception exception)
        {
            bool set = exception is OperationCanceledException canceled
                ? task.TrySetCanceled(canceled.CancellationToken, canceled)
                : task.TrySetException(exception);
            if (!set)
            {
                throw new InvalidOperationException(SR.TaskT_TransitionToFinal_AlreadyCompleted);
            }
        }

        // What the method returns once its first step is over, as an async
        // method's builder returns it: a result it completed with before
        // suspending as Task.FromResult's (or ValueTask's own) result.
        public static Task<TResult> ReturnTask<TResult>(RuntimeAsyncTask<TResult> task) =>
            !task.Suspended && task.IsCompletedSuccessfully ? Task.FromResult(task.ResultOnSuccess) : task;

        public static Task ReturnVoidTask(RuntimeAsyncTask<VoidTaskResult> task) =>
            !task.Suspended && task.IsCompletedSuccessfully ? Task.CompletedTask : task;

        public static ValueTask<TResult> ReturnValueTask<TResult>(RuntimeAsyncTask<TResult> task) =>
            !task.Suspended && task.IsCompletedSuccessfully ? new ValueTask<TResult>(task.ResultOnSuccess) : new ValueTask<TResult>(task);

        public static ValueTask ReturnVoidValueTask(RuntimeAsyncTask<VoidTaskResult> task) =>
            !task.Suspended && task.IsCompletedSuccessfully ? default : new ValueTask(task);
    }
}
