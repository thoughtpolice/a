// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The component model's futures and streams (WASI 0.3's), under the glue
// witgen generates (docs/WIT.md, "Futures and streams"): the ends a module
// holds of a `future<T>` or `stream<T>`, whose reads and writes are copies
// between the two ends' memories that the host completes when the other
// end is ready. A copy that cannot complete at once waits in the running
// component task's waitable set (see ComponentTasks), and its Task
// completes when its event comes. What a read copies in is written by the
// host into memory the CoreLib holds (see HeldMemory), and so are the
// strings and lists it holds, which the host allocates with cabi_realloc;
// what a write copies out stays in memory the CoreLib holds until the host
// has taken it. A cancel is async too: when the other end's holder has
// yet to stop the copy, it stays pending until its event, and an end
// disposed meanwhile is dropped then. witgen generates a ChannelOps<T> per
// payload type: the canonical built-ins of that type and how a value of it
// is laid out.

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Gameplay.Runtime
{
    /// <summary>
    /// The canonical built-ins of one future or stream payload type, and its
    /// values' layout, which witgen generates.
    /// </summary>
    public abstract class ChannelOps<T>
    {
        /// <summary>Creates the ops.</summary>
        protected ChannelOps()
        {
        }

        /// <summary>`future.new` or `stream.new`: the readable end, then the writable one's in the high bits.</summary>
        public abstract long New();

        /// <summary>`future.read` or `stream.read`, async-lowered: its copy's code.</summary>
        public abstract int Read(int handle, int buffer, int count);

        /// <summary>`future.write` or `stream.write`, async-lowered: its copy's code.</summary>
        public abstract int Write(int handle, int buffer, int count);

        /// <summary>`cancel-read`, async-lowered: the canceled copy's code, or BLOCKED until its event.</summary>
        public abstract int CancelRead(int handle);

        /// <summary>`cancel-write`, async-lowered: the canceled copy's code, or BLOCKED until its event.</summary>
        public abstract int CancelWrite(int handle);

        /// <summary>`drop-readable`.</summary>
        public abstract void DropReadable(int handle);

        /// <summary>`drop-writable`.</summary>
        public abstract void DropWritable(int handle);

        /// <summary>A value's size in memory.</summary>
        public abstract int ElementSize();

        /// <summary>A value's alignment in memory.</summary>
        public abstract int ElementAlignment();

        /// <summary>Whether a value holds strings or lists, which the host allocates.</summary>
        public abstract bool HostMemory();

        /// <summary>Lifts a value from memory.</summary>
        public abstract T Load(int address);

        /// <summary>Lowers a value into memory.</summary>
        public abstract void Store(int address, T value);
    }

    // One copy of a future's or stream's end, pending or not.
    internal sealed class Copy : Waitable
    {
        internal const int Blocked = -1;
        internal const int Completed = 0;
        internal const int Dropped = 1;
        internal const int Cancelled = 2;

        private readonly Action<int> finish;
        private readonly Func<int> cancel;
        private CancellationTokenRegistration registration;
        private bool cancelling;
        internal bool Pending;

        internal Copy(int handle, Action<int> finish, Func<int> cancel)
        {
            Handle = handle;
            this.finish = finish;
            this.cancel = cancel;
        }

        // The code a copy returned: at once, or its event's.
        internal void Started(int code)
        {
            if (code == Blocked)
            {
                Pending = true;
                ComponentTasks.Wait(this);
            }
            else
            {
                finish(code);
            }
        }

        // Cancels the copy pending when the token is.
        internal void CancelWhen(CancellationToken cancellationToken)
        {
            if (Pending && cancellationToken.CanBeCanceled)
            {
                registration = cancellationToken.UnsafeRegister(static state => ((Copy)state!).Cancel(), this);
            }
        }

        // Cancels the copy pending, once: it finishes with what it copied
        // by then, at once, or at its event when the other end's holder
        // has yet to stop it.
        internal void Cancel()
        {
            if (!Pending || cancelling)
            {
                return;
            }

            cancelling = true;
            int code = cancel();
            if (code != Blocked)
            {
                Finish(code);
            }
        }

        internal override void Event(int code) => Finish(code);

        private void Finish(int code)
        {
            if (Pending)
            {
                Pending = false;
                registration.Dispose();
                ComponentTasks.Done(this, false);
            }

            finish(code);
        }
    }

    /// <summary>
    /// The readable end of a WIT <c>stream&lt;T&gt;</c>: values the writer
    /// sends, read into arrays, or enumerated with <c>await foreach</c>.
    /// </summary>
    public sealed class StreamReader<T> : IAsyncEnumerable<T>, IDisposable
    {
        private readonly ChannelOps<T> ops;
        private int handle;
        private bool dropped;
        private bool dropWhenDone;
        private Copy? copy;

        internal StreamReader(int handle, ChannelOps<T> ops)
        {
            this.handle = handle;
            this.ops = ops;
        }

        /// <summary>Whether the writer has dropped its end: nothing more will come.</summary>
        public bool IsCompleted => dropped;

        /// <summary>
        /// Reads at most <paramref name="count"/> values into
        /// <paramref name="buffer"/> from <paramref name="start"/>, once the
        /// writer has sent some: how many, 0 once the writer has dropped its
        /// end. Canceled, it reads what the writer had sent by then, or is
        /// canceled if that was nothing.
        /// </summary>
        public Task<int> ReadAsync(T[] buffer, int start, int count, CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(buffer);
            if ((uint)start > (uint)buffer.Length || (uint)count > (uint)(buffer.Length - start))
            {
                throw new ArgumentOutOfRangeException(nameof(count));
            }

            Check();
            if (dropped || count == 0)
            {
                return Task.FromResult(0);
            }

            int size = ops.ElementSize();
            int area = HeldMemory.Allocate(Math.Max(size * count, 1), ops.ElementAlignment());
            bool host = ops.HostMemory();
            if (host)
            {
                HeldMemory.HoldHost();
            }

            var completion = new TaskCompletionSource<int>();
            var read = new Copy(handle, code =>
            {
                copy = null;
                int copied = (int)((uint)code >> 4);
                for (int index = 0; index < copied; index++)
                {
                    buffer[start + index] = ops.Load(area + index * size);
                }

                HeldMemory.Free(area);
                if (host)
                {
                    HeldMemory.ReleaseHost();
                }

                if ((code & 0xf) == Copy.Dropped)
                {
                    dropped = true;
                }

                if (dropWhenDone)
                {
                    Drop();
                }

                if ((code & 0xf) == Copy.Cancelled && copied == 0)
                {
                    completion.TrySetCanceled(cancellationToken);
                }
                else
                {
                    completion.TrySetResult(copied);
                }
            }, () => ops.CancelRead(handle));
            copy = read;
            read.Started(ops.Read(handle, area, count));
            read.CancelWhen(cancellationToken);
            return completion.Task;
        }

        /// <summary>Reads into the whole of <paramref name="buffer"/>.</summary>
        public Task<int> ReadAsync(T[] buffer, CancellationToken cancellationToken = default) =>
            ReadAsync(buffer, 0, buffer?.Length ?? 0, cancellationToken);

        /// <summary>The values, until the writer drops its end.</summary>
        public async IAsyncEnumerator<T> GetAsyncEnumerator(CancellationToken cancellationToken = default)
        {
            var buffer = new T[64];
            while (true)
            {
                int count = await ReadAsync(buffer, 0, buffer.Length, cancellationToken);
                if (count == 0)
                {
                    yield break;
                }

                for (int index = 0; index < count; index++)
                {
                    yield return buffer[index];
                }
            }
        }

        /// <summary>
        /// Drops the end: a read pending is canceled first, completing
        /// with what it had read by then, and the end is dropped once the
        /// read has stopped.
        /// </summary>
        public void Dispose()
        {
            if (handle == 0 || dropWhenDone)
            {
                return;
            }

            if (copy is { } pending)
            {
                dropWhenDone = true;
                pending.Cancel();
                return;
            }

            Drop();
        }

        private void Drop()
        {
            ops.DropReadable(handle);
            handle = 0;
        }

        private void Check()
        {
            if (handle == 0)
            {
                throw new ObjectDisposedException(nameof(StreamReader<T>));
            }

            if (copy is not null)
            {
                throw new InvalidOperationException("A read of the stream is already pending.");
            }
        }

        // The end given to the host (a parameter or a result).
        internal int Give()
        {
            Check();
            int given = handle;
            handle = 0;
            return given;
        }
    }

    /// <summary>
    /// The writable end of a WIT <c>stream&lt;T&gt;</c>.
    /// </summary>
    public sealed class StreamWriter<T> : IDisposable
    {
        private readonly ChannelOps<T> ops;
        private int handle;
        private bool dropped;
        private bool dropWhenDone;
        private Copy? copy;

        internal StreamWriter(int handle, ChannelOps<T> ops)
        {
            this.handle = handle;
            this.ops = ops;
        }

        /// <summary>Whether the reader has dropped its end: nothing more is taken.</summary>
        public bool IsClosed => dropped;

        /// <summary>
        /// Writes the values, as the reader takes them: how many it took,
        /// fewer than all when it dropped its end first.
        /// </summary>
        public async Task<int> WriteAsync(T[] values, CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(values);
            int written = 0;
            while (written < values.Length && !dropped)
            {
                written += await WriteOnce(values, written, values.Length - written, cancellationToken);
            }

            return written;
        }

        private Task<int> WriteOnce(T[] values, int start, int count, CancellationToken cancellationToken)
        {
            if (handle == 0)
            {
                throw new ObjectDisposedException(nameof(StreamWriter<T>));
            }

            if (copy is not null)
            {
                throw new InvalidOperationException("A write of the stream is already pending.");
            }

            int size = ops.ElementSize();
            int mark = Canonical.Mark();
            int area = Canonical.Allocate(Math.Max(size * count, 1), ops.ElementAlignment());
            for (int index = 0; index < count; index++)
            {
                ops.Store(area + index * size, values[start + index]);
            }

            var completion = new TaskCompletionSource<int>();
            int held = 0;
            var write = new Copy(handle, code =>
            {
                copy = null;
                if (held != 0)
                {
                    HeldMemory.Free(held);
                }

                if ((code & 0xf) == Copy.Dropped)
                {
                    dropped = true;
                }

                if (dropWhenDone)
                {
                    Drop();
                }

                int copied = (int)((uint)code >> 4);
                if ((code & 0xf) == Copy.Cancelled && copied == 0)
                {
                    completion.TrySetCanceled(cancellationToken);
                }
                else
                {
                    completion.TrySetResult(copied);
                }
            }, () => ops.CancelWrite(handle));
            copy = write;
            int status = ops.Write(handle, area, count);
            if (status == Copy.Blocked)
            {
                // What the host has yet to take outlives the call.
                held = HeldMemory.HoldArena(mark);
            }
            else
            {
                Canonical.Release(mark);
            }

            write.Started(status);
            write.CancelWhen(cancellationToken);
            return completion.Task;
        }

        /// <summary>
        /// Drops the end, which tells the reader nothing more comes: a write
        /// pending is canceled first, and the end is dropped once the write
        /// has stopped.
        /// </summary>
        public void Dispose()
        {
            if (handle == 0 || dropWhenDone)
            {
                return;
            }

            if (copy is { } pending)
            {
                dropWhenDone = true;
                pending.Cancel();
                return;
            }

            Drop();
        }

        private void Drop()
        {
            ops.DropWritable(handle);
            handle = 0;
        }
    }

    /// <summary>
    /// The readable end of a WIT <c>future&lt;T&gt;</c>: one value, once the
    /// writer has sent it.
    /// </summary>
    public sealed class FutureReader<T> : IDisposable
    {
        private readonly ChannelOps<T> ops;
        private int handle;
        private bool dropWhenDone;
        private Copy? copy;

        internal FutureReader(int handle, ChannelOps<T> ops)
        {
            this.handle = handle;
            this.ops = ops;
        }

        /// <summary>
        /// The value, once the writer has sent it; an
        /// InvalidOperationException when it dropped its end without one.
        /// </summary>
        public Task<T> ReadAsync(CancellationToken cancellationToken = default)
        {
            Check();
            int area = HeldMemory.Allocate(Math.Max(ops.ElementSize(), 1), ops.ElementAlignment());
            bool host = ops.HostMemory();
            if (host)
            {
                HeldMemory.HoldHost();
            }

            var completion = new TaskCompletionSource<T>();
            var read = new Copy(handle, code =>
            {
                copy = null;
                T value = default!;
                bool completed = (code & 0xf) == Copy.Completed;
                if (completed)
                {
                    value = ops.Load(area);
                }

                HeldMemory.Free(area);
                if (host)
                {
                    HeldMemory.ReleaseHost();
                }

                if (dropWhenDone || completed)
                {
                    // A future's end is done with once its value is read.
                    Drop();
                }

                if (completed)
                {
                    completion.TrySetResult(value);
                }
                else if ((code & 0xf) == Copy.Cancelled)
                {
                    completion.TrySetCanceled(cancellationToken);
                }
                else
                {
                    completion.TrySetException(new InvalidOperationException("The future's writer dropped its end without a value."));
                }
            }, () => ops.CancelRead(handle));
            copy = read;
            read.Started(ops.Read(handle, area, 1));
            read.CancelWhen(cancellationToken);
            return completion.Task;
        }

        /// <summary>Drops the end, once a read pending, canceled first, has stopped.</summary>
        public void Dispose()
        {
            if (handle == 0 || dropWhenDone)
            {
                return;
            }

            if (copy is { } pending)
            {
                dropWhenDone = true;
                pending.Cancel();
                return;
            }

            Drop();
        }

        private void Drop()
        {
            if (handle != 0)
            {
                ops.DropReadable(handle);
                handle = 0;
            }
        }

        private void Check()
        {
            if (handle == 0)
            {
                throw new ObjectDisposedException(nameof(FutureReader<T>));
            }

            if (copy is not null)
            {
                throw new InvalidOperationException("A read of the future is already pending.");
            }
        }

        internal int Give()
        {
            Check();
            int given = handle;
            handle = 0;
            return given;
        }
    }

    /// <summary>
    /// The writable end of a WIT <c>future&lt;T&gt;</c>.
    /// </summary>
    public sealed class FutureWriter<T> : IDisposable
    {
        private readonly ChannelOps<T> ops;
        private int handle;
        private bool dropWhenDone;
        private Copy? copy;

        internal FutureWriter(int handle, ChannelOps<T> ops)
        {
            this.handle = handle;
            this.ops = ops;
        }

        /// <summary>
        /// Sends the value, once the reader takes it: whether it did, false
        /// when it dropped its end first. The end is done with either way.
        /// </summary>
        public Task<bool> WriteAsync(T value, CancellationToken cancellationToken = default)
        {
            if (handle == 0)
            {
                throw new ObjectDisposedException(nameof(FutureWriter<T>));
            }

            if (copy is not null)
            {
                throw new InvalidOperationException("A write of the future is already pending.");
            }

            int mark = Canonical.Mark();
            int area = Canonical.Allocate(Math.Max(ops.ElementSize(), 1), ops.ElementAlignment());
            ops.Store(area, value);
            var completion = new TaskCompletionSource<bool>();
            int held = 0;
            var write = new Copy(handle, code =>
            {
                copy = null;
                if (held != 0)
                {
                    HeldMemory.Free(held);
                }

                if ((code & 0xf) == Copy.Cancelled && !dropWhenDone)
                {
                    completion.TrySetCanceled(cancellationToken);
                    return;
                }

                Drop();
                completion.TrySetResult((code & 0xf) == Copy.Completed);
            }, () => ops.CancelWrite(handle));
            copy = write;
            int status = ops.Write(handle, area, 1);
            if (status == Copy.Blocked)
            {
                held = HeldMemory.HoldArena(mark);
            }
            else
            {
                Canonical.Release(mark);
            }

            write.Started(status);
            write.CancelWhen(cancellationToken);
            return completion.Task;
        }

        /// <summary>Drops the end without a value, once a write pending, canceled first, has stopped.</summary>
        public void Dispose()
        {
            if (handle == 0 || dropWhenDone)
            {
                return;
            }

            if (copy is { } pending)
            {
                dropWhenDone = true;
                pending.Cancel();
                return;
            }

            Drop();
        }

        private void Drop()
        {
            if (handle != 0)
            {
                ops.DropWritable(handle);
                handle = 0;
            }
        }
    }
}
