// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// ExecutionContext and AsyncLocal<T> (docs/IMPORTER.md, "Async as built"),
// after dotnet/runtime's ExecutionContext.cs and AsyncLocal.cs. The module
// has one thread, so the current context is a static field; a context is
// immutable, and setting an AsyncLocal<T> makes a new one current. Where
// the CLR's flows, this one does: an await captures it and the async
// method's next step runs in it, what an async method sets before its
// first await does not outlast the call, ContinueWith,
// CancellationToken.Register, an awaiter's OnCompleted (not
// UnsafeOnCompleted) and Task.Yield run their callbacks in the context
// they were made in, and the frame loop runs what the CLR queues to its
// thread pool in the default context.

using System;
using System.Runtime.ExceptionServices;
using System.Threading;
using Gameplay.Runtime;

namespace System.Threading
{
    public delegate void ContextCallback(object? state);

    public sealed class ExecutionContext : IDisposable
    {
        internal static readonly ExecutionContext Default = new ExecutionContext([], null, isFlowSuppressed: false, isDefault: true);
        private static readonly ExecutionContext DefaultFlowSuppressed = new ExecutionContext([], null, isFlowSuppressed: true, isDefault: false);

        // The thread's context; null is the default.
        internal static ExecutionContext? s_current;

        // Never current: what a resumed runtime-async step leaves as it
        // found it (RuntimeAsync.EnterContext).
        internal static readonly ExecutionContext Untouched = new ExecutionContext([], null, isFlowSuppressed: false, isDefault: false);

        // The values set, by AsyncLocal<T>. A local that tells of changes
        // keeps its entry from its first value on, null or not, and is
        // among the notifiers.
        private readonly LocalValue[] values;
        private readonly AsyncLocalNotifier[]? notifiers;
        private readonly bool isFlowSuppressed;
        private readonly bool isDefault;

        private ExecutionContext(LocalValue[] values, AsyncLocalNotifier[]? notifiers, bool isFlowSuppressed, bool isDefault)
        {
            this.values = values;
            this.notifiers = notifiers;
            this.isFlowSuppressed = isFlowSuppressed;
            this.isDefault = isDefault;
        }

        internal bool IsDefault => isDefault;

        // The current context, or null when its flow is suppressed.
        public static ExecutionContext? Capture()
        {
            var context = s_current;
            return context is null ? Default : context.isFlowSuppressed ? null : context;
        }

        public ExecutionContext CreateCopy() => this;

        public void Dispose()
        {
        }

        public static bool IsFlowSuppressed() => s_current is { isFlowSuppressed: true };

        // Suppressing it again does nothing, and gives a control whose
        // Undo does nothing.
        public static AsyncFlowControl SuppressFlow()
        {
            var context = s_current ?? Default;
            if (context.isFlowSuppressed)
            {
                return default;
            }

            s_current = context.ShallowClone(isFlowSuppressed: true);
            return new AsyncFlowControl(true);
        }

        public static void RestoreFlow()
        {
            var context = s_current;
            if (context is not { isFlowSuppressed: true })
            {
                throw new InvalidOperationException(SR.InvalidOperation_CannotRestoreUnsuppressedFlow);
            }

            s_current = context.ShallowClone(isFlowSuppressed: false);
        }

        public static void Run(ExecutionContext executionContext, ContextCallback callback, object? state)
        {
            if (executionContext is null)
            {
                throw new InvalidOperationException(SR.InvalidOperation_NullContext);
            }

            RunInternal(executionContext, callback, state);
        }

        public static void Restore(ExecutionContext executionContext)
        {
            if (executionContext is null)
            {
                throw new InvalidOperationException(SR.InvalidOperation_NullContext);
            }

            RestoreInternal(executionContext.isDefault ? null : executionContext);
        }

        // Runs `callback` in `context` (the default for null), and leaves
        // the context and the SynchronizationContext what they were,
        // whatever it did to them.
        internal static void RunInternal(ExecutionContext? context, ContextCallback callback, object? state)
        {
            var previous = s_current is { isDefault: true } ? null : s_current;
            var previousSynchronization = SynchronizationContext.Current;
            if (context is { isDefault: true })
            {
                context = null;
            }

            RestoreInternal(context);
            ExceptionDispatchInfo? thrown = null;
            try
            {
                callback(state);
            }
            catch (Exception exception)
            {
                thrown = ExceptionDispatchInfo.Capture(exception);
            }

            FrameLoop.RestoreContext(previousSynchronization);
            RestoreInternal(previous);
            thrown?.Throw();
        }

        // Makes `next` (null: the default) current, telling the locals that
        // tell of changes whose values it changes.
        internal static void RestoreInternal(ExecutionContext? next)
        {
            var previous = s_current;
            if (previous == next)
            {
                return;
            }

            s_current = next;
            if (previous?.notifiers is not null || next?.notifiers is not null)
            {
                OnValuesChanged(previous, next);
            }
        }

        private static void OnValuesChanged(ExecutionContext? previous, ExecutionContext? next)
        {
            var before = previous?.notifiers;
            var after = next?.notifiers;
            try
            {
                if (before is not null)
                {
                    foreach (var notifier in before)
                    {
                        object? previousValue = previous!.ValueOf(notifier.Local);
                        object? nextValue = next is null ? null : next.ValueOf(notifier.Local);
                        if (previousValue != nextValue)
                        {
                            notifier.Changed(previousValue, nextValue, true);
                        }
                    }
                }

                if (after is not null && after != before)
                {
                    foreach (var notifier in after)
                    {
                        // Those of both contexts were told above.
                        if (previous is not null && previous.Has(notifier.Local))
                        {
                            continue;
                        }

                        object? nextValue = next!.ValueOf(notifier.Local);
                        if (nextValue is not null)
                        {
                            notifier.Changed(null, nextValue, true);
                        }
                    }
                }
            }
            catch (Exception)
            {
                // A handler that throws on a change of context: the CLR
                // fails fast.
                Intrinsics.Trap(17);
            }
        }

        private ExecutionContext? ShallowClone(bool isFlowSuppressed)
        {
            if (values.Length == 0)
            {
                return isFlowSuppressed ? DefaultFlowSuppressed : null;
            }

            return new ExecutionContext(values, notifiers, isFlowSuppressed, isDefault: false);
        }

        private bool Has(object local)
        {
            foreach (var entry in values)
            {
                if (entry.Local == local)
                {
                    return true;
                }
            }

            return false;
        }

        private object? ValueOf(object local)
        {
            foreach (var entry in values)
            {
                if (entry.Local == local)
                {
                    return entry.Value;
                }
            }

            return null;
        }

        internal static object? GetLocalValue(object local) => s_current?.ValueOf(local);

        // `notifier` is the local's when it tells of changes.
        internal static void SetLocalValue(object local, object? newValue, AsyncLocalNotifier? notifier)
        {
            var current = s_current;
            bool hadPrevious = current is not null && current.Has(local);
            object? previousValue = hadPrevious ? current!.ValueOf(local) : null;
            if (previousValue == newValue)
            {
                return;
            }

            // Without notifications a null value is no value; with them,
            // its entry says the local is among the notifiers.
            var updated = With(current?.values ?? [], local, newValue, removeNull: notifier is null);
            var notifiers = current?.notifiers;
            if (notifier is not null && !hadPrevious)
            {
                notifiers = notifiers is null ? [notifier] : [.. notifiers, notifier];
            }

            bool suppressed = current is { isFlowSuppressed: true };
            s_current = !suppressed && updated.Length == 0
                ? null
                : new ExecutionContext(updated, notifiers, suppressed, isDefault: false);
            notifier?.Changed(previousValue, newValue, false);
        }

        private static LocalValue[] With(LocalValue[] values, object local, object? value, bool removeNull)
        {
            for (int index = 0; index < values.Length; index++)
            {
                if (values[index].Local != local)
                {
                    continue;
                }

                if (value is null && removeNull)
                {
                    var removed = new LocalValue[values.Length - 1];
                    Array.Copy(values, 0, removed, 0, index);
                    Array.Copy(values, index + 1, removed, index, values.Length - index - 1);
                    return removed;
                }

                var replaced = new LocalValue[values.Length];
                Array.Copy(values, replaced, values.Length);
                replaced[index] = new LocalValue(local, value);
                return replaced;
            }

            if (value is null && removeNull)
            {
                return values;
            }

            var added = new LocalValue[values.Length + 1];
            Array.Copy(values, added, values.Length);
            added[values.Length] = new LocalValue(local, value);
            return added;
        }

        private readonly struct LocalValue
        {
            internal readonly object Local;
            internal readonly object? Value;

            internal LocalValue(object local, object? value)
            {
                Local = local;
                Value = value;
            }
        }
    }

    public struct AsyncFlowControl : IDisposable, IEquatable<AsyncFlowControl>
    {
        private bool _suppressed;

        internal AsyncFlowControl(bool suppressed) => _suppressed = suppressed;

        public void Undo()
        {
            if (!_suppressed)
            {
                return;
            }

            // Only the context it suppressed the flow of.
            if (!ExecutionContext.IsFlowSuppressed())
            {
                throw new InvalidOperationException(SR.InvalidOperation_AsyncFlowCtrlCtxMismatch);
            }

            _suppressed = false;
            ExecutionContext.RestoreFlow();
        }

        public void Dispose() => Undo();

        public override bool Equals(object? obj) => obj is AsyncFlowControl other && Equals(other);

        public bool Equals(AsyncFlowControl obj) => _suppressed == obj._suppressed;

        public override int GetHashCode() => _suppressed ? 1 : 0;

        public static bool operator ==(AsyncFlowControl a, AsyncFlowControl b) => a.Equals(b);

        public static bool operator !=(AsyncFlowControl a, AsyncFlowControl b) => !(a == b);
    }

    public sealed class AsyncLocal<T>
    {
        private readonly AsyncLocalNotifier? _notifier;

        public AsyncLocal()
        {
        }

        public AsyncLocal(Action<AsyncLocalValueChangedArgs<T>>? valueChangedHandler)
        {
            if (valueChangedHandler is not null)
            {
                _notifier = new AsyncLocalNotifier(this, (previous, current, contextChanged) => valueChangedHandler(
                    new AsyncLocalValueChangedArgs<T>(
                        previous is null ? default! : (T)previous, current is null ? default! : (T)current, contextChanged)));
            }
        }

        public T Value
        {
            get => ExecutionContext.GetLocalValue(this) is { } value ? (T)value : default!;
            set => ExecutionContext.SetLocalValue(this, value, _notifier);
        }
    }

    public readonly struct AsyncLocalValueChangedArgs<T>
    {
        internal AsyncLocalValueChangedArgs(T previousValue, T currentValue, bool contextChanged)
        {
            PreviousValue = previousValue;
            CurrentValue = currentValue;
            ThreadContextChanged = contextChanged;
        }

        public T PreviousValue { get; }

        public T CurrentValue { get; }

        public bool ThreadContextChanged { get; }
    }
}

namespace Gameplay.Runtime
{
    // An AsyncLocal<T> that tells of changes, with what it tells them by
    // (the CLR's IAsyncLocal; a class, since the CoreLib's non-generic
    // interfaces are every module's).
    internal sealed class AsyncLocalNotifier
    {
        internal readonly object Local;
        internal readonly Action<object?, object?, bool> Changed;

        internal AsyncLocalNotifier(object local, Action<object?, object?, bool> changed)
        {
            Local = local;
            Changed = changed;
        }
    }

    // Work the frame loop runs in a context it was queued in (the CLR's
    // ThreadPool.QueueUserWorkItem, which flows it).
    internal sealed class ContextWork : FrameWork
    {
        private readonly ExecutionContext context;
        private readonly Action<object?> callback;
        private readonly object? state;

        internal ContextWork(ExecutionContext context, Action action)
            : this(context, static state => ((ActionWork)state!).Execute(), new ActionWork(action))
        {
        }

        internal ContextWork(ExecutionContext context, Action<object?> callback, object? state)
        {
            this.context = context;
            this.callback = callback;
            this.state = state;
        }

        internal override void Execute() =>
            ExecutionContext.RunInternal(context, static work => ((ContextWork)work!).Invoke(), this);

        private void Invoke() => callback(state);
    }
}
