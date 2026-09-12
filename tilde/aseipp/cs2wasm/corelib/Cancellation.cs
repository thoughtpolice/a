// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// CancellationToken and its source for one thread (docs/IMPORTER.md,
// "Async"), after dotnet/runtime's CancellationToken.cs,
// CancellationTokenSource.cs and CancellationTokenRegistration.cs: callbacks
// run when the source is canceled, the last registered first, each through
// the SynchronizationContext it captured (Send) if it asked to; what they
// throw is aggregated afterwards, or the first thrown at once. CancelAfter
// and the delayed constructors count game time, as Task.Delay does.

using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Gameplay.Runtime;

namespace System.Threading
{
    public readonly struct CancellationToken : IEquatable<CancellationToken>
    {
        internal readonly CancellationTokenSource? _source;

        internal CancellationToken(CancellationTokenSource? source) => _source = source;

        public CancellationToken(bool canceled)
            : this(canceled ? CancellationTokenSource.CanceledSource : null)
        {
        }

        public static CancellationToken None => default;

        public bool IsCancellationRequested => _source is not null && _source.IsCancellationRequested;

        public bool CanBeCanceled => _source is not null;

        public CancellationTokenRegistration Register(Action callback) => Register(callback, false);

        public CancellationTokenRegistration Register(Action callback, bool useSynchronizationContext)
        {
            ArgumentNullException.ThrowIfNull(callback);
            return Register(static state => ((ActionWork)state!).Execute(), new ActionWork(callback), useSynchronizationContext);
        }

        public CancellationTokenRegistration Register(Action<object?> callback, object? state) => Register(callback, state, false);

        public CancellationTokenRegistration Register(Action<object?, CancellationToken> callback, object? state)
        {
            ArgumentNullException.ThrowIfNull(callback);
            return RegisterCore(null, callback, state, false, true);
        }

        public CancellationTokenRegistration Register(Action<object?> callback, object? state, bool useSynchronizationContext)
        {
            ArgumentNullException.ThrowIfNull(callback);
            return RegisterCore(callback, null, state, useSynchronizationContext, true);
        }

        public CancellationTokenRegistration UnsafeRegister(Action<object?> callback, object? state)
        {
            ArgumentNullException.ThrowIfNull(callback);
            return RegisterCore(callback, null, state, false, false);
        }

        public CancellationTokenRegistration UnsafeRegister(Action<object?, CancellationToken> callback, object? state)
        {
            ArgumentNullException.ThrowIfNull(callback);
            return RegisterCore(null, callback, state, false, false);
        }

        // One of the callbacks: with the state, or with the state and the
        // token; Register's runs in the ExecutionContext current now,
        // UnsafeRegister's where the cancellation is.
        private CancellationTokenRegistration RegisterCore(
            Action<object?>? callback, Action<object?, CancellationToken>? withToken, object? state, bool useSynchronizationContext,
            bool useExecutionContext) =>
            _source is { } source
                ? source.Register(
                    new CancellationCallback(
                        callback, withToken, state, useExecutionContext && Gameplay.Runtime.Intrinsics.FlowsExecutionContext() ? ExecutionContext.Capture() : null),
                    useSynchronizationContext ? SynchronizationContext.Current : null)
                : default;

        public bool Equals(CancellationToken other) => ReferenceEquals(_source, other._source);

        public override bool Equals(object? other) => other is CancellationToken token && Equals(token);

        public override int GetHashCode() => (_source ?? CancellationTokenSource.NeverCanceledSource).GetHashCode();

        public static bool operator ==(CancellationToken left, CancellationToken right) => left.Equals(right);

        public static bool operator !=(CancellationToken left, CancellationToken right) => !left.Equals(right);

        public void ThrowIfCancellationRequested()
        {
            if (IsCancellationRequested)
            {
                throw new OperationCanceledException(SR.OperationCanceled, this);
            }
        }
    }

    internal readonly struct CancellationCallback
    {
        private readonly Action<object?>? callback;
        private readonly Action<object?, CancellationToken>? withToken;
        private readonly object? state;
        // The ExecutionContext it runs in (see Task.m_capturedContext).
        private readonly object? context;

        internal CancellationCallback(
            Action<object?>? callback, Action<object?, CancellationToken>? withToken, object? state, object? context)
        {
            this.callback = callback;
            this.withToken = withToken;
            this.state = state;
            this.context = context;
        }

        internal void Invoke(CancellationTokenSource source)
        {
            if (!Gameplay.Runtime.Intrinsics.FlowsExecutionContext() || context is null)
            {
                if (withToken is not null)
                {
                    withToken(state, new CancellationToken(source));
                }
                else
                {
                    callback!(state);
                }
            }
            else
            {
                ExecutionContext.RunInternal(
                    (ExecutionContext)context, static invocation => ((CallbackInvocation)invocation!).Run(), new CallbackInvocation(this, source));
            }
        }

        private void InvokeCallback(CancellationTokenSource source)
        {
            if (withToken is not null)
            {
                withToken(state, new CancellationToken(source));
            }
            else
            {
                callback!(state);
            }
        }

        private sealed class CallbackInvocation
        {
            private readonly CancellationCallback callback;
            private readonly CancellationTokenSource source;

            internal CallbackInvocation(CancellationCallback callback, CancellationTokenSource source)
            {
                this.callback = callback;
                this.source = source;
            }

            internal void Run() => callback.InvokeCallback(source);
        }
    }

    public readonly struct CancellationTokenRegistration : IEquatable<CancellationTokenRegistration>, IDisposable
    {
        private readonly long _id;
        private readonly CancellationTokenSource.CallbackNode? _node;

        internal CancellationTokenRegistration(long id, CancellationTokenSource.CallbackNode node)
        {
            _id = id;
            _node = node;
        }

        public CancellationToken Token => _node is { } node ? new CancellationToken(node.Registrations.Source) : default;

        public void Dispose() => Unregister();

        public bool Unregister() => _node is { } node && node.Registrations.Unregister(_id, node);

        public ValueTask DisposeAsync()
        {
            Dispose();
            return default;
        }

        public bool Equals(CancellationTokenRegistration other) => ReferenceEquals(_node, other._node) && _id == other._id;

        public override bool Equals(object? obj) => obj is CancellationTokenRegistration other && Equals(other);

        public override int GetHashCode() => _node is not null ? _node.GetHashCode() ^ _id.GetHashCode() : _id.GetHashCode();

        public static bool operator ==(CancellationTokenRegistration left, CancellationTokenRegistration right) => left.Equals(right);

        public static bool operator !=(CancellationTokenRegistration left, CancellationTokenRegistration right) => !left.Equals(right);
    }

    public class CancellationTokenSource : IDisposable
    {
        private const int NotCanceled = 0;
        private const int Notifying = 1;
        private const int NotifyingComplete = 2;

        private int _state;
        private bool _disposed;
        private FrameTimer? _timer;
        private Registrations? _registrations;

        private static CancellationTokenSource? s_canceledSource;
        private static CancellationTokenSource? s_neverCanceledSource;

        internal static CancellationTokenSource CanceledSource => s_canceledSource ??= new CancellationTokenSource { _state = NotifyingComplete };

        internal static CancellationTokenSource NeverCanceledSource => s_neverCanceledSource ??= new CancellationTokenSource();

        public CancellationTokenSource()
        {
        }

        public CancellationTokenSource(TimeSpan delay)
        {
            long milliseconds = (long)delay.TotalMilliseconds;
            if (milliseconds < -1 || milliseconds > 0xfffffffe)
            {
                throw new ArgumentOutOfRangeException(nameof(delay));
            }

            InitializeWithTimer((uint)milliseconds);
        }

        public CancellationTokenSource(int millisecondsDelay)
        {
            if (millisecondsDelay < -1)
            {
                throw new ArgumentOutOfRangeException(nameof(millisecondsDelay));
            }

            InitializeWithTimer((uint)millisecondsDelay);
        }

        private void InitializeWithTimer(uint milliseconds)
        {
            if (milliseconds == 0)
            {
                _state = NotifyingComplete;
            }
            else if (milliseconds != uint.MaxValue)
            {
                _timer = StartTimer(milliseconds);
            }
        }

        private FrameTimer StartTimer(uint milliseconds) =>
            FrameLoop.Instance.StartTimer(milliseconds * TimeSpan.TicksPerMillisecond, static state => ((CancellationTokenSource)state!).NotifyCancellation(false), this);

        public bool IsCancellationRequested => _state != NotCanceled;

        public CancellationToken Token
        {
            get
            {
                ThrowIfDisposed();
                return new CancellationToken(this);
            }
        }

        public void Cancel() => Cancel(false);

        public void Cancel(bool throwOnFirstException)
        {
            ThrowIfDisposed();
            NotifyCancellation(throwOnFirstException);
        }

        // The callbacks run in the frame loop's queue, as the CLR runs them
        // on its pool; the task completes once they have.
        public Task CancelAsync()
        {
            if (_disposed)
            {
                return Task.FromException(new ObjectDisposedException(GetType().FullName, SR.CancellationTokenSource_Disposed));
            }

            if (TransitionToCancellationRequested())
            {
                if (_registrations is { Callbacks: not null })
                {
                    var task = new Task();
                    FrameLoop.Queue(new CancelWorkItem(this, task));
                    return task;
                }

                ExecuteCallbackHandlers(false);
            }

            return Task.CompletedTask;
        }

        private sealed class CancelWorkItem : FrameWork
        {
            private readonly CancellationTokenSource source;
            private readonly Task task;

            internal CancelWorkItem(CancellationTokenSource source, Task task)
            {
                this.source = source;
                this.task = task;
            }

            internal override void Execute()
            {
                try
                {
                    source.ExecuteCallbackHandlers(false);
                }
                catch (Exception exception)
                {
                    task.TrySetException(exception);
                    return;
                }

                task.TrySetResult();
            }
        }

        public void CancelAfter(TimeSpan delay)
        {
            long milliseconds = (long)delay.TotalMilliseconds;
            if (milliseconds < -1 || milliseconds > 0xfffffffe)
            {
                throw new ArgumentOutOfRangeException(nameof(delay));
            }

            CancelAfter((uint)milliseconds);
        }

        public void CancelAfter(int millisecondsDelay)
        {
            if (millisecondsDelay < -1)
            {
                throw new ArgumentOutOfRangeException(nameof(millisecondsDelay));
            }

            CancelAfter((uint)millisecondsDelay);
        }

        private void CancelAfter(uint milliseconds)
        {
            ThrowIfDisposed();
            if (IsCancellationRequested)
            {
                return;
            }

            _timer?.Stop();
            _timer = milliseconds == uint.MaxValue ? null : StartTimer(milliseconds);
        }

        public bool TryReset()
        {
            ThrowIfDisposed();
            if (_state != NotCanceled)
            {
                return false;
            }

            _timer?.Stop();
            _timer = null;
            _registrations?.UnregisterAll();
            return true;
        }

        public void Dispose()
        {
            Dispose(true);
        }

        protected virtual void Dispose(bool disposing)
        {
            if (disposing && !_disposed)
            {
                _timer?.Stop();
                _timer = null;
                _registrations = null;
                _disposed = true;
            }
        }

        private void ThrowIfDisposed()
        {
            if (_disposed)
            {
                throw new ObjectDisposedException(null, SR.CancellationTokenSource_Disposed);
            }
        }

        internal CancellationTokenRegistration Register(CancellationCallback callback, SynchronizationContext? context)
        {
            if (!IsCancellationRequested)
            {
                if (_disposed)
                {
                    return default;
                }

                var registrations = _registrations ??= new Registrations(this);
                var node = new CallbackNode(registrations, registrations.NextId++, callback, context);
                node.Next = registrations.Callbacks;
                if (node.Next is not null)
                {
                    node.Next.Previous = node;
                }

                registrations.Callbacks = node;
                return new CancellationTokenRegistration(node.Id, node);
            }

            callback.Invoke(this);
            return default;
        }

        internal void NotifyCancellation(bool throwOnFirstException)
        {
            if (TransitionToCancellationRequested())
            {
                ExecuteCallbackHandlers(throwOnFirstException);
            }
        }

        private bool TransitionToCancellationRequested()
        {
            if (_state != NotCanceled)
            {
                return false;
            }

            _state = Notifying;
            _timer?.Stop();
            _timer = null;
            return true;
        }

        private void ExecuteCallbackHandlers(bool throwOnFirstException)
        {
            var registrations = _registrations;
            _registrations = null;
            if (registrations is null)
            {
                _state = NotifyingComplete;
                return;
            }

            List<Exception>? exceptions = null;
            try
            {
                while (registrations.Callbacks is { } node)
                {
                    registrations.Callbacks = node.Next;
                    if (node.Next is not null)
                    {
                        node.Next.Previous = null;
                    }

                    registrations.ExecutingId = node.Id;
                    node.Id = 0;
                    try
                    {
                        if (node.Context is { } context)
                        {
                            context.Send(static state => ((CallbackNode)state!).Execute(), node);
                        }
                        else
                        {
                            node.Execute();
                        }
                    }
                    catch (Exception exception)
                    {
                        if (throwOnFirstException)
                        {
                            throw;
                        }

                        (exceptions ??= new List<Exception>()).Add(exception);
                    }
                }
            }
            finally
            {
                _state = NotifyingComplete;
                registrations.ExecutingId = 0;
            }

            if (exceptions is not null)
            {
                throw new AggregateException(exceptions);
            }
        }

        public static CancellationTokenSource CreateLinkedTokenSource(CancellationToken token1, CancellationToken token2) =>
            !token1.CanBeCanceled ? CreateLinkedTokenSource(token2)
            : token2.CanBeCanceled ? new LinkedCancellationTokenSource([token1, token2])
            : new LinkedCancellationTokenSource([token1]);

        public static CancellationTokenSource CreateLinkedTokenSource(CancellationToken token) =>
            token.CanBeCanceled ? new LinkedCancellationTokenSource([token]) : new CancellationTokenSource();

        public static CancellationTokenSource CreateLinkedTokenSource(params CancellationToken[] tokens)
        {
            ArgumentNullException.ThrowIfNull(tokens);
            return CreateLinkedTokenSource((ReadOnlySpan<CancellationToken>)tokens);
        }

        public static CancellationTokenSource CreateLinkedTokenSource(params ReadOnlySpan<CancellationToken> tokens) =>
            tokens.Length switch
            {
                0 => throw new ArgumentException(SR.CancellationToken_CreateLinkedToken_TokensIsEmpty),
                1 => CreateLinkedTokenSource(tokens[0]),
                2 => CreateLinkedTokenSource(tokens[0], tokens[1]),
                _ => new LinkedCancellationTokenSource(tokens.ToArray()),
            };

        private sealed class LinkedCancellationTokenSource : CancellationTokenSource
        {
            private CancellationTokenRegistration[]? links;

            internal LinkedCancellationTokenSource(CancellationToken[] tokens)
            {
                links = new CancellationTokenRegistration[tokens.Length];
                for (int i = 0; i < tokens.Length; i++)
                {
                    if (tokens[i].CanBeCanceled)
                    {
                        links[i] = tokens[i].UnsafeRegister(static state => ((CancellationTokenSource)state!).NotifyCancellation(false), this);
                    }
                }
            }

            protected override void Dispose(bool disposing)
            {
                if (!disposing || _disposed)
                {
                    return;
                }

                if (links is { } all)
                {
                    links = null;
                    foreach (var link in all)
                    {
                        link.Dispose();
                    }
                }

                base.Dispose(disposing);
            }
        }

        // A source's callbacks, the most recently registered first; what a
        // registration unregisters from even once the source has let go of
        // it (canceled or disposed).
        internal sealed class Registrations
        {
            internal readonly CancellationTokenSource Source;
            internal CallbackNode? Callbacks;
            internal long NextId = 1;
            internal long ExecutingId;

            internal Registrations(CancellationTokenSource source) => Source = source;

            // Whether the callback was removed before it ran.
            internal bool Unregister(long id, CallbackNode node)
            {
                if (id == 0 || node.Id != id)
                {
                    return false;
                }

                if (Callbacks == node)
                {
                    Callbacks = node.Next;
                }
                else
                {
                    node.Previous!.Next = node.Next;
                }

                if (node.Next is not null)
                {
                    node.Next.Previous = node.Previous;
                }

                node.Id = 0;
                node.Previous = null;
                node.Next = null;
                return true;
            }

            internal void UnregisterAll()
            {
                var node = Callbacks;
                Callbacks = null;
                while (node is not null)
                {
                    var next = node.Next;
                    node.Id = 0;
                    node.Previous = null;
                    node.Next = null;
                    node = next;
                }
            }
        }

        internal sealed class CallbackNode
        {
            internal readonly Registrations Registrations;
            internal long Id;
            internal readonly CancellationCallback Callback;
            internal readonly SynchronizationContext? Context;
            internal CallbackNode? Previous;
            internal CallbackNode? Next;

            internal CallbackNode(Registrations registrations, long id, CancellationCallback callback, SynchronizationContext? context)
            {
                Registrations = registrations;
                Id = id;
                Callback = callback;
                Context = context;
            }

            internal void Execute() => Callback.Invoke(Registrations.Source);
        }
    }
}

namespace System
{
    public class OperationCanceledException : SystemException
    {
        private CancellationToken _cancellationToken;

        public OperationCanceledException()
            : base(SR.OperationCanceled)
        {
        }

        public OperationCanceledException(string? message)
            : base(message)
        {
        }

        public OperationCanceledException(string? message, Exception? innerException)
            : base(message, innerException)
        {
        }

        public OperationCanceledException(CancellationToken token)
            : this()
        {
            _cancellationToken = token;
        }

        public OperationCanceledException(string? message, CancellationToken token)
            : this(message)
        {
            _cancellationToken = token;
        }

        public OperationCanceledException(string? message, Exception? innerException, CancellationToken token)
            : this(message, innerException)
        {
            _cancellationToken = token;
        }

        public CancellationToken CancellationToken => _cancellationToken;
    }

    public class ObjectDisposedException : InvalidOperationException
    {
        private readonly string? _objectName;

        public ObjectDisposedException(string? objectName)
            : this(objectName, SR.ObjectDisposed_Generic)
        {
        }

        public ObjectDisposedException(string? objectName, string? message)
            : base(WithObjectName(objectName, message))
        {
            _objectName = objectName;
        }

        public ObjectDisposedException(string? message, Exception? innerException)
            : base(message ?? SR.ObjectDisposed_Generic, innerException)
        {
        }

        public string ObjectName => _objectName ?? string.Empty;

        // Message as the CLR's composes it, fixed at construction: this
        // module's exceptions keep their message in a field.
        private static string WithObjectName(string? objectName, string? message)
        {
            message ??= SR.ObjectDisposed_Generic;
            return string.IsNullOrEmpty(objectName)
                ? message
                : message + "\n" + SR.ObjectDisposed_ObjectName_Name.Replace("{0}", objectName);
        }

        public static void ThrowIf(bool condition, object instance)
        {
            if (condition)
            {
                throw new ObjectDisposedException(instance?.GetType().FullName);
            }
        }
    }
}
