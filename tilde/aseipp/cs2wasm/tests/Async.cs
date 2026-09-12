// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Async (docs/IMPORTER.md "Async"): async methods, awaits and
// the task library (the gameplay CoreLib's), against the CLR's. Each case
// runs under a single-threaded SynchronizationContext of its own (Pump),
// installed on the CLR's thread and in the module alike, so continuations
// run in the order the task library decides on both, never on a thread
// pool; what the CLR would run on its pool (continuations with no context
// to return to, ContinueWith without ExecuteSynchronously) is left to
// tests/Frames.cs. A case's result is the hash of what it traced, so any
// difference in order, value, message or identity shows.

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using System.Threading.Tasks.Sources;
using Gameplay;

namespace Tests.Async
{
    // Posted work runs when the case drains it, in order.
    internal sealed class Pump : SynchronizationContext
    {
        private readonly Queue<KeyValuePair<SendOrPostCallback, object>> work = new Queue<KeyValuePair<SendOrPostCallback, object>>();
        public int Posted;
        public int Started;
        public int Completed;

        public override void Post(SendOrPostCallback d, object state)
        {
            Posted++;
            work.Enqueue(new KeyValuePair<SendOrPostCallback, object>(d, state));
        }

        public override void Send(SendOrPostCallback d, object state) => d(state);

        public override SynchronizationContext CreateCopy() => this;

        public override void OperationStarted() => Started++;

        public override void OperationCompleted() => Completed++;

        public void Drain() => Drain(int.MaxValue);

        // At most `steps` of what is posted, for a producer that never
        // stops.
        public void Drain(int steps)
        {
            while (work.Count > 0 && steps-- > 0)
            {
                var item = work.Dequeue();
                item.Key(item.Value);
            }
        }
    }

    // What a case did, in order.
    internal sealed class Trace
    {
        private readonly List<string> events = new List<string>();

        public void Add(string text) => events.Add(text);

        public void Add(int value) => events.Add(value.ToString());

        public void Add(bool value) => events.Add(value ? "true" : "false");

        public int Hash()
        {
            Async.Last = string.Join("|", events);
            uint hash = 2166136261;
            foreach (var text in events)
            {
                foreach (char c in text)
                {
                    hash = (hash ^ c) * 16777619;
                }

                hash = (hash ^ '|') * 16777619;
            }

            return (int)hash;
        }
    }

    public sealed class Boom : Exception
    {
        public Boom(string message)
            : base(message)
        {
        }
    }

    public static class Async
    {
        // What the last case traced, for looking into a difference: the
        // harness compares hashes, and these read the text on either side.
        internal static string Last = "";

        public static int LastLength() => Last.Length;

        public static int LastChar(int index) => Last[index];

        // Runs a case under its own pump and drains it afterwards.
        private static int Run(Action<Pump, Trace> test)
        {
            var previous = SynchronizationContext.Current;
            var pump = new Pump();
            SynchronizationContext.SetSynchronizationContext(pump);
            var trace = new Trace();
            try
            {
                test(pump, trace);
                pump.Drain();
                trace.Add("posted " + pump.Posted);
            }
            catch (Exception exception)
            {
                trace.Add("escaped " + exception.GetType().Name + ": " + exception.Message);
            }
            finally
            {
                SynchronizationContext.SetSynchronizationContext(previous);
            }

            return trace.Hash();
        }

        private static async Task<int> Sync(int x) => x + 1;

        private static async Task SyncVoid()
        {
        }

        private static async Task<int> Yielding(Trace trace, int x)
        {
            trace.Add("yield " + x);
            await Task.Yield();
            trace.Add("resumed " + x);
            return x * 2;
        }

        private static async Task<int> Awaiting(Trace trace, string name, Task<int> task)
        {
            trace.Add(name + " awaits");
            int value = await task;
            trace.Add(name + " got " + value);
            return value + 1;
        }

        private static async Task Chain(Trace trace, int depth, Task<int> task)
        {
            if (depth == 0)
            {
                trace.Add("leaf " + await task);
                return;
            }

            trace.Add("enter " + depth);
            await Chain(trace, depth - 1, task);
            trace.Add("leave " + depth);
        }

        private static async ValueTask<int> ValueSync(int x) => x * 3;

        private static async ValueTask<int> ValueYielding(Trace trace, int x)
        {
            await Task.Yield();
            trace.Add("value resumed");
            return x * 5;
        }

        private static async ValueTask ValueVoid(Trace trace)
        {
            await Task.Yield();
            trace.Add("value void");
        }

        private static async void Fire(Trace trace, Task task, bool fail)
        {
            trace.Add("fire");
            await task;
            trace.Add("fired");
            if (fail)
            {
                throw new Boom("from async void");
            }
        }

        private static async Task<int> Guarded(Trace trace, Task<int> task)
        {
            try
            {
                trace.Add("try");
                return await task;
            }
            catch (Boom boom)
            {
                trace.Add("caught " + boom.Message);
                return -1;
            }
            finally
            {
                trace.Add("finally");
            }
        }

        private static async Task<int> Summing(Trace trace, int count)
        {
            int sum = 0;
            for (int i = 0; i < count; i++)
            {
                sum += await Yielding(trace, i);
            }

            return sum;
        }

        private static async Task SwitchesContext(Trace trace)
        {
            SynchronizationContext.SetSynchronizationContext(null);
            trace.Add(SynchronizationContext.Current is null);
            await Task.CompletedTask;
        }

        private static async Task Throws(bool before)
        {
            if (before)
            {
                throw new Boom("before");
            }

            await Task.Yield();
            throw new Boom("after");
        }

        private static async Task<int> CancelsWith(CancellationToken token)
        {
            await Task.Yield();
            token.ThrowIfCancellationRequested();
            return 1;
        }

        private static string Describe(Task task) =>
            task.Status + (task.IsCompleted ? " completed" : "") + (task.IsCompletedSuccessfully ? " ok" : "")
            + (task.IsFaulted ? " faulted" : "") + (task.IsCanceled ? " canceled" : "");

        private static string Describe(Exception exception) =>
            exception is null ? "null" : exception.GetType().Name + ": " + exception.Message;

        // Awaits, results and the order continuations run in.
        public static int Basics(int which) => Run((pump, trace) =>
        {
            switch (which)
            {
                case 0:
                {
                    var task = Sync(4);
                    trace.Add(Describe(task));
                    trace.Add(task.Result);
                    trace.Add(ReferenceEquals(SyncVoid(), Task.CompletedTask));
                    break;
                }

                case 1:
                {
                    var task = Yielding(trace, 3);
                    trace.Add("returned " + Describe(task));
                    pump.Drain();
                    trace.Add(Describe(task) + " " + task.Result);
                    break;
                }

                case 2:
                {
                    var source = new TaskCompletionSource<int>();
                    var awaiting = Awaiting(trace, "a", source.Task);
                    trace.Add("setting");
                    source.SetResult(7);
                    trace.Add("set " + Describe(awaiting) + " " + awaiting.Result);
                    break;
                }

                case 3:
                {
                    // The first await continuation runs inline, the others
                    // are posted.
                    var source = new TaskCompletionSource<int>();
                    var first = Awaiting(trace, "a", source.Task);
                    var second = Awaiting(trace, "b", source.Task);
                    var third = Awaiting(trace, "c", source.Task);
                    source.SetResult(1);
                    trace.Add("set " + Describe(first) + " / " + Describe(second));
                    pump.Drain();
                    trace.Add(first.Result + second.Result + third.Result);
                    break;
                }

                case 4:
                {
                    var source = new TaskCompletionSource<int>();
                    var chain = Chain(trace, 4, source.Task);
                    trace.Add("chained " + Describe(chain));
                    source.SetResult(9);
                    trace.Add("done " + Describe(chain));
                    break;
                }

                case 5:
                {
                    var value = ValueSync(2);
                    trace.Add(value.IsCompletedSuccessfully);
                    trace.Add(value.Result);
                    var later = ValueYielding(trace, 2);
                    trace.Add(later.IsCompleted);
                    var nothing = ValueVoid(trace);
                    pump.Drain();
                    trace.Add(later.Result);
                    trace.Add(nothing.IsCompleted);
                    trace.Add(ValueTask.CompletedTask.IsCompleted);
                    trace.Add(new ValueTask<int>(4).Result);
                    trace.Add(ValueTask.FromResult(6).Result);
                    trace.Add(new ValueTask<int>(Task.FromResult(8)).AsTask().Result);
                    break;
                }

                case 6:
                {
                    var source = new TaskCompletionSource();
                    Fire(trace, source.Task, false);
                    Fire(trace, source.Task, true);
                    trace.Add("started " + pump.Started);
                    source.SetResult();
                    trace.Add("completed " + pump.Completed);
                    try
                    {
                        pump.Drain();
                    }
                    catch (Boom boom)
                    {
                        trace.Add("drained " + boom.Message);
                    }

                    trace.Add("completed " + pump.Completed);
                    break;
                }

                case 7:
                {
                    var task = Guarded(trace, Task.FromResult(4));
                    trace.Add(task.Result);
                    var source = new TaskCompletionSource<int>();
                    var failing = Guarded(trace, source.Task);
                    source.SetException(new Boom("guarded"));
                    trace.Add(failing.Result);
                    break;
                }

                case 8:
                {
                    var task = Summing(trace, 4);
                    pump.Drain();
                    trace.Add(Describe(task) + " " + task.Result);
                    break;
                }

                case 9:
                {
                    // What an async method does to the current context does
                    // not outlast its first step.
                    var task = SwitchesContext(trace);
                    trace.Add(ReferenceEquals(SynchronizationContext.Current, pump));
                    trace.Add(Describe(task));
                    break;
                }

                case 10:
                {
                    trace.Add(ReferenceEquals(Task.FromResult(true), Task.FromResult(true)));
                    trace.Add(ReferenceEquals(Task.FromResult(false), Task.FromResult(true)));
                    trace.Add(ReferenceEquals(Task.FromResult(5), Task.FromResult(5)));
                    trace.Add(ReferenceEquals(Task.FromResult(-1), Task.FromResult(-1)));
                    trace.Add(ReferenceEquals(Task.FromResult(9), Task.FromResult(9)));
                    trace.Add(ReferenceEquals(Task.FromResult<string>(null), Task.FromResult<string>(null)));
                    trace.Add(ReferenceEquals(Task.FromResult(0L), Task.FromResult(0L)));
                    trace.Add(ReferenceEquals(Task.FromResult(0.0), Task.FromResult(0.0)));
                    trace.Add(ReferenceEquals(Task.FromResult(-0.0), Task.FromResult(-0.0)));
                    trace.Add(ReferenceEquals(Task.FromResult("x"), Task.FromResult("x")));
                    trace.Add(ReferenceEquals(Sync(-1), Sync(-1)));
                    trace.Add(ReferenceEquals(Sync(100), Sync(100)));
                    break;
                }

                case 11:
                {
                    var source = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
                    var awaiting = Awaiting(trace, "async", source.Task);
                    source.SetResult(2);
                    trace.Add("set " + Describe(awaiting));
                    pump.Drain();
                    trace.Add(Describe(awaiting));
                    trace.Add(source.Task.CreationOptions.ToString());
                    break;
                }

                case 12:
                {
                    // ConfigureAwait(false) of a completed task goes on
                    // synchronously; ForceYielding never does.
                    var completed = Task.FromResult(3);
                    trace.Add(completed.ConfigureAwait(false).GetAwaiter().IsCompleted);
                    trace.Add(completed.ConfigureAwait(ConfigureAwaitOptions.ForceYielding).GetAwaiter().IsCompleted);
                    trace.Add(Task.CompletedTask.ConfigureAwait(ConfigureAwaitOptions.None).GetAwaiter().IsCompleted);
                    trace.Add(completed.ConfigureAwait(false).GetAwaiter().GetResult());
                    break;
                }

                case 13:
                {
                    // An awaiter's OnCompleted of a completed task posts.
                    Task.CompletedTask.GetAwaiter().OnCompleted(() => trace.Add("on completed"));
                    trace.Add("registered " + pump.Posted);
                    Task.Yield().GetAwaiter().UnsafeOnCompleted(() => trace.Add("yielded"));
                    trace.Add("yield " + pump.Posted);
                    break;
                }

                case 14:
                {
                    var one = Yielding(trace, 1);
                    var two = Yielding(trace, 2);
                    trace.Add(one.Id != two.Id);
                    trace.Add(one.Id > 0);
                    trace.Add(one.Id == one.Id);
                    trace.Add(one.AsyncState is null);
                    trace.Add(new TaskCompletionSource(5).Task.AsyncState.ToString());
                    break;
                }

                default:
                {
                    trace.Add(Task.Delay(0) == Task.CompletedTask);
                    trace.Add(Task.Delay(TimeSpan.Zero).IsCompleted);
                    trace.Add(Task.Delay(TimeSpan.FromTicks(5000)).IsCompleted);
                    var canceled = new CancellationTokenSource();
                    canceled.Cancel();
                    trace.Add(Describe(Task.Delay(100, canceled.Token)));
                    trace.Add(Describe(Task.Delay(-1, canceled.Token)));
                    try
                    {
                        Task.Delay(-2);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(Describe(exception) + " " + exception.ParamName);
                    }

                    try
                    {
                        Task.Delay(TimeSpan.FromMilliseconds(-2));
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(Describe(exception) + " " + exception.ParamName);
                    }

                    break;
                }
            }
        });

        // Exceptions through awaits, results, waits and the task's state.
        public static int Exceptions(int which) => Run((pump, trace) =>
        {
            switch (which)
            {
                case 0:
                {
                    var boom = new Boom("original");
                    var source = new TaskCompletionSource<int>();
                    var awaiting = Guarded(trace, source.Task);
                    source.SetException(boom);
                    trace.Add(awaiting.Result);
                    var faulted = Task.FromException<int>(boom);
                    try
                    {
                        faulted.GetAwaiter().GetResult();
                    }
                    catch (Boom caught)
                    {
                        trace.Add(ReferenceEquals(caught, boom));
                    }

                    break;
                }

                case 1:
                {
                    var boom = new Boom("result");
                    var task = Task.FromException<int>(boom);
                    trace.Add(Describe(task));
                    try
                    {
                        _ = task.Result;
                    }
                    catch (AggregateException aggregate)
                    {
                        trace.Add(Describe(aggregate));
                        trace.Add(ReferenceEquals(aggregate.InnerException, boom));
                        trace.Add(aggregate.InnerExceptions.Count);
                    }

                    try
                    {
                        task.Wait();
                    }
                    catch (AggregateException aggregate)
                    {
                        trace.Add(Describe(aggregate));
                    }

                    break;
                }

                case 2:
                {
                    var task = Throws(false);
                    trace.Add(Describe(task));
                    pump.Drain();
                    trace.Add(Describe(task));
                    trace.Add(ReferenceEquals(task.Exception, task.Exception));
                    trace.Add(Describe(task.Exception));
                    trace.Add(Describe(task.Exception.InnerException));
                    var before = Throws(true);
                    trace.Add(Describe(before) + " " + Describe(before.Exception.InnerExceptions[0]));
                    break;
                }

                case 3:
                {
                    var source = new TaskCompletionSource<int>();
                    var awaiting = Awaiting(trace, "canceled", source.Task);
                    source.SetCanceled();
                    trace.Add(Describe(source.Task));
                    trace.Add(Describe(awaiting));
                    trace.Add(source.Task.Exception is null);
                    try
                    {
                        source.Task.GetAwaiter().GetResult();
                    }
                    catch (TaskCanceledException canceled)
                    {
                        trace.Add(Describe(canceled));
                        trace.Add(ReferenceEquals(canceled.Task, source.Task));
                        trace.Add(canceled.CancellationToken == CancellationToken.None);
                    }

                    try
                    {
                        _ = source.Task.Result;
                    }
                    catch (AggregateException aggregate)
                    {
                        trace.Add(Describe(aggregate) + " / " + Describe(aggregate.InnerException));
                    }

                    break;
                }

                case 4:
                {
                    var cts = new CancellationTokenSource();
                    var task = CancelsWith(cts.Token);
                    cts.Cancel();
                    pump.Drain();
                    trace.Add(Describe(task));
                    try
                    {
                        task.GetAwaiter().GetResult();
                    }
                    catch (OperationCanceledException canceled)
                    {
                        trace.Add(Describe(canceled));
                        trace.Add(canceled.CancellationToken == cts.Token);
                        trace.Add(canceled is TaskCanceledException);
                    }

                    try
                    {
                        task.GetAwaiter().GetResult();
                    }
                    catch (OperationCanceledException first)
                    {
                        try
                        {
                            task.GetAwaiter().GetResult();
                        }
                        catch (OperationCanceledException second)
                        {
                            trace.Add(ReferenceEquals(first, second));
                        }
                    }

                    break;
                }

                case 5:
                {
                    var one = new Boom("one");
                    var two = new InvalidOperationException("two");
                    var source = new TaskCompletionSource();
                    source.SetException(new Exception[] { one, two });
                    trace.Add(Describe(source.Task));
                    try
                    {
                        source.Task.GetAwaiter().GetResult();
                    }
                    catch (Exception first)
                    {
                        trace.Add(ReferenceEquals(first, one));
                    }

                    var aggregate = source.Task.Exception;
                    trace.Add(aggregate.InnerExceptions.Count);
                    trace.Add(Describe(aggregate));
                    try
                    {
                        aggregate.Handle(exception => exception is Boom);
                    }
                    catch (AggregateException rest)
                    {
                        trace.Add(Describe(rest));
                        trace.Add(ReferenceEquals(rest.InnerExceptions[0], two));
                    }

                    var nested = new AggregateException("outer", aggregate, new Boom("three"));
                    var flat = nested.Flatten();
                    trace.Add(Describe(nested));
                    trace.Add(Describe(flat));
                    trace.Add(flat.InnerExceptions.Count);
                    break;
                }

                case 6:
                {
                    var source = new TaskCompletionSource<int>();
                    trace.Add(source.TrySetResult(1));
                    trace.Add(source.TrySetResult(2));
                    trace.Add(source.TrySetException(new Boom("late")));
                    trace.Add(source.TrySetCanceled());
                    try
                    {
                        source.SetResult(3);
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    trace.Add(source.Task.Result);
                    break;
                }

                case 7:
                {
                    var source = new TaskCompletionSource();
                    try
                    {
                        source.SetException(new Exception[0]);
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(Describe(exception) + " " + exception.ParamName);
                    }

                    try
                    {
                        source.SetException(new Exception[] { new Boom("x"), null });
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(Describe(exception) + " " + exception.ParamName);
                    }

                    try
                    {
                        source.SetException((Exception)null);
                    }
                    catch (ArgumentNullException exception)
                    {
                        trace.Add(exception.ParamName);
                    }

                    trace.Add(Describe(source.Task));
                    break;
                }

                case 8:
                {
                    try
                    {
                        Task.FromCanceled(CancellationToken.None);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(exception.ParamName);
                    }

                    var token = new CancellationToken(true);
                    var canceled = Task.FromCanceled<int>(token);
                    trace.Add(Describe(canceled));
                    try
                    {
                        canceled.GetAwaiter().GetResult();
                    }
                    catch (TaskCanceledException exception)
                    {
                        trace.Add(exception.CancellationToken == token);
                        trace.Add(ReferenceEquals(exception.Task, canceled));
                    }

                    trace.Add(Describe(Task.FromException(new Boom("f"))));
                    trace.Add(Describe(Task.FromCanceled(token)));
                    break;
                }

                case 9:
                {
                    trace.Add(Describe(new AggregateException()));
                    trace.Add(Describe(new AggregateException("message")));
                    trace.Add(Describe(new AggregateException((string)null)));
                    trace.Add(Describe(new AggregateException("two", new Boom("a"), new Boom("b"))));
                    trace.Add(Describe(new AggregateException(new List<Exception> { new Boom("c") })));
                    trace.Add(Describe(new AggregateException("inner", new Boom("d")).InnerException));
                    trace.Add(new AggregateException(new Boom("e"), new Boom("f")).InnerExceptions.Count);
                    try
                    {
                        new AggregateException(new Boom("g"), null);
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    break;
                }

                case 10:
                {
                    var source = new TaskCompletionSource<int>();
                    source.SetException(new Boom("suppressed"));
                    var awaiter = ((Task)source.Task).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing).GetAwaiter();
                    awaiter.GetResult();
                    trace.Add("suppressed");
                    try
                    {
                        source.Task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(Describe(exception) + " " + exception.ParamName);
                    }

                    try
                    {
                        Task.CompletedTask.ConfigureAwait((ConfigureAwaitOptions)8);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(exception.ParamName);
                    }

                    break;
                }

                case 11:
                {
                    var task = Throws(true);
                    try
                    {
                        task.Wait(0);
                    }
                    catch (AggregateException aggregate)
                    {
                        trace.Add(Describe(aggregate));
                    }

                    var pending = new TaskCompletionSource().Task;
                    trace.Add(pending.Wait(0));
                    trace.Add(Describe(pending));
                    try
                    {
                        Task.WaitAll(Task.CompletedTask, Task.FromException(new Boom("w1")), Task.FromCanceled(new CancellationToken(true)));
                    }
                    catch (AggregateException aggregate)
                    {
                        trace.Add(Describe(aggregate));
                        trace.Add(aggregate.InnerExceptions.Count);
                    }

                    trace.Add(Task.WaitAny(pending, Task.CompletedTask));
                    break;
                }

                default:
                {
                    // Disposal: of a completed task only.
                    Task.CompletedTask.Dispose();
                    var pending = new TaskCompletionSource().Task;
                    try
                    {
                        pending.Dispose();
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    break;
                }
            }
        });

        // WhenAll, WhenAny and ContinueWith.
        public static int Combinators(int which) => Run((pump, trace) =>
        {
            switch (which)
            {
                case 0:
                {
                    var all = Task.WhenAll(Task.FromResult(1), Task.FromResult(2), Sync(3));
                    trace.Add(Describe(all));
                    trace.Add(string.Join(",", all.Result));
                    var a = new TaskCompletionSource<int>();
                    var b = new TaskCompletionSource<int>();
                    var pending = Task.WhenAll(a.Task, b.Task);
                    b.SetResult(20);
                    trace.Add(Describe(pending));
                    a.SetResult(10);
                    trace.Add(string.Join(",", pending.Result));
                    var listed = Task.WhenAll(new List<Task<int>> { Task.FromResult(4), Task.FromResult(5) });
                    trace.Add(string.Join(",", listed.Result));
                    break;
                }

                case 1:
                {
                    // The generic WhenAll's exceptions in the tasks' order,
                    // the other's in the order they completed.
                    var a = new TaskCompletionSource<int>();
                    var b = new TaskCompletionSource<int>();
                    var generic = Task.WhenAll(a.Task, b.Task);
                    var plain = Task.WhenAll((Task)a.Task, b.Task);
                    b.SetException(new Boom("b"));
                    a.SetException(new Boom("a"));
                    trace.Add(Describe(generic.Exception));
                    trace.Add(Describe(plain.Exception));
                    try
                    {
                        generic.GetAwaiter().GetResult();
                    }
                    catch (Boom boom)
                    {
                        trace.Add(boom.Message);
                    }

                    break;
                }

                case 2:
                {
                    var canceled = Task.FromCanceled(new CancellationToken(true));
                    var faulted = Task.FromException(new Boom("f"));
                    trace.Add(Describe(Task.WhenAll(canceled, faulted)));
                    trace.Add(Describe(Task.WhenAll(canceled, Task.CompletedTask)));
                    trace.Add(Describe(Task.WhenAll(Task.CompletedTask, Task.CompletedTask)));
                    break;
                }

                case 3:
                {
                    trace.Add(ReferenceEquals(Task.WhenAll(), Task.CompletedTask));
                    var one = new TaskCompletionSource().Task;
                    trace.Add(ReferenceEquals(Task.WhenAll(one), one));
                    trace.Add(Task.WhenAll(new Task<int>[0]).Result.Length);
                    try
                    {
                        Task.WhenAll(Task.CompletedTask, null);
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(Describe(exception) + " " + exception.ParamName);
                    }

                    break;
                }

                case 4:
                {
                    var a = new TaskCompletionSource<int>();
                    var b = new TaskCompletionSource<int>();
                    var any = Task.WhenAny(a.Task, b.Task);
                    trace.Add(Describe(any));
                    b.SetResult(2);
                    trace.Add(Describe(any));
                    trace.Add(ReferenceEquals(any.Result, b.Task));
                    a.SetResult(1);
                    var three = Task.WhenAny(new TaskCompletionSource().Task, Task.FromResult(5), Task.FromResult(6));
                    trace.Add(((Task<int>)three.Result).Result);
                    var c = new TaskCompletionSource();
                    var d = new TaskCompletionSource();
                    var e = new TaskCompletionSource();
                    var many = Task.WhenAny(c.Task, d.Task, e.Task);
                    e.SetException(new Boom("e"));
                    trace.Add(ReferenceEquals(many.Result, e.Task));
                    trace.Add(Describe(many.Result));
                    break;
                }

                case 5:
                {
                    try
                    {
                        Task.WhenAny(new Task[0]);
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(Describe(exception) + " " + exception.ParamName);
                    }

                    try
                    {
                        Task.WhenAny(Task.CompletedTask, null, Task.CompletedTask);
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(Describe(exception) + " " + exception.ParamName);
                    }

                    try
                    {
                        Task.WhenAny(Task.CompletedTask, null);
                    }
                    catch (ArgumentNullException exception)
                    {
                        trace.Add(exception.ParamName);
                    }

                    break;
                }

                case 6:
                {
                    // Await continuations of a WhenAll: inline after the last.
                    var a = new TaskCompletionSource<int>();
                    var b = new TaskCompletionSource<int>();
                    var awaiting = Awaiting(trace, "sum", Sum(Task.WhenAll(a.Task, b.Task)));
                    a.SetResult(1);
                    trace.Add("a set");
                    b.SetResult(2);
                    trace.Add("b set " + Describe(awaiting));
                    break;
                }

                case 7:
                {
                    // ContinueWith that runs synchronously, and the kinds of
                    // completion its options exclude.
                    var source = new TaskCompletionSource<int>();
                    var next = source.Task.ContinueWith(task => { trace.Add("continued " + task.Result); return task.Result * 2; },
                        TaskContinuationOptions.ExecuteSynchronously);
                    var skipped = source.Task.ContinueWith(_ => trace.Add("never"),
                        TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously);
                    var state = ((Task)source.Task).ContinueWith((task, s) => trace.Add("state " + s),
                        "s", TaskContinuationOptions.ExecuteSynchronously);
                    trace.Add(Describe(next));
                    source.SetResult(4);
                    trace.Add(Describe(next) + " " + next.Result);
                    trace.Add(Describe(skipped));
                    trace.Add(Describe(state) + " " + state.AsyncState);
                    var failing = Task.FromException(new Boom("c")).ContinueWith(task => { throw new Boom("continuation"); },
                        TaskContinuationOptions.ExecuteSynchronously);
                    trace.Add(Describe(failing) + " " + Describe(failing.Exception.InnerException));
                    try
                    {
                        Task.CompletedTask.ContinueWith(_ => { }, TaskContinuationOptions.NotOnRanToCompletion | TaskContinuationOptions.NotOnFaulted
                                                                  | TaskContinuationOptions.NotOnCanceled);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    break;
                }

                default:
                {
                    // A continuation's token cancels it before it runs.
                    var source = new TaskCompletionSource();
                    var cts = new CancellationTokenSource();
                    var continuation = source.Task.ContinueWith(_ => trace.Add("never"), cts.Token);
                    trace.Add(Describe(continuation));
                    cts.Cancel();
                    trace.Add(Describe(continuation));
                    source.SetResult();
                    trace.Add(Describe(continuation));
                    break;
                }
            }
        });

        private static async Task<int> Sum(Task<int[]> all)
        {
            int sum = 0;
            foreach (int value in await all)
            {
                sum += value;
            }

            return sum;
        }

        // CancellationToken and its source.
        public static int Cancellation(int which) => Run((pump, trace) =>
        {
            switch (which)
            {
                case 0:
                {
                    var cts = new CancellationTokenSource();
                    var token = cts.Token;
                    token.Register(() => trace.Add("first"));
                    token.Register(state => trace.Add("second " + state), "s");
                    token.Register((state, t) => trace.Add("third " + state + " " + (t == token)), "t");
                    trace.Add(token.IsCancellationRequested);
                    cts.Cancel();
                    trace.Add(token.IsCancellationRequested);
                    token.Register(() => trace.Add("late"));
                    cts.Cancel();
                    trace.Add("done");
                    break;
                }

                case 1:
                {
                    var cts = new CancellationTokenSource();
                    var one = cts.Token.Register(() => trace.Add("one"));
                    var two = cts.Token.Register(() => trace.Add("two"));
                    var three = cts.Token.Register(() => trace.Add("three"));
                    trace.Add(two.Unregister());
                    trace.Add(two.Unregister());
                    one.Dispose();
                    trace.Add(three.Token == cts.Token);
                    trace.Add(one.Equals(two));
                    cts.Cancel();
                    trace.Add(three.Unregister());
                    trace.Add(default(CancellationTokenRegistration).Unregister());
                    break;
                }

                case 2:
                {
                    var cts = new CancellationTokenSource();
                    cts.Token.Register(() => { trace.Add("a"); throw new Boom("a"); });
                    cts.Token.Register(() => trace.Add("b"));
                    cts.Token.Register(() => { trace.Add("c"); throw new Boom("c"); });
                    try
                    {
                        cts.Cancel();
                    }
                    catch (AggregateException aggregate)
                    {
                        trace.Add(Describe(aggregate));
                    }

                    var first = new CancellationTokenSource();
                    first.Token.Register(() => trace.Add("x"));
                    first.Token.Register(() => { trace.Add("y"); throw new Boom("y"); });
                    first.Token.Register(() => trace.Add("z"));
                    try
                    {
                        first.Cancel(true);
                    }
                    catch (Boom boom)
                    {
                        trace.Add("first " + boom.Message + " " + first.IsCancellationRequested);
                    }

                    first.Cancel();
                    trace.Add("again");
                    break;
                }

                case 3:
                {
                    var a = new CancellationTokenSource();
                    var b = new CancellationTokenSource();
                    var linked = CancellationTokenSource.CreateLinkedTokenSource(a.Token, b.Token);
                    linked.Token.Register(() => trace.Add("linked"));
                    b.Token.Register(() => trace.Add("b"));
                    b.Cancel();
                    trace.Add(linked.IsCancellationRequested + " " + a.IsCancellationRequested);
                    var single = CancellationTokenSource.CreateLinkedTokenSource(CancellationToken.None);
                    trace.Add(single.Token.CanBeCanceled);
                    var three = CancellationTokenSource.CreateLinkedTokenSource(a.Token, CancellationToken.None, new CancellationToken(true));
                    trace.Add(three.IsCancellationRequested);
                    var disposed = CancellationTokenSource.CreateLinkedTokenSource(a.Token);
                    disposed.Dispose();
                    a.Cancel();
                    trace.Add(disposed.IsCancellationRequested);
                    try
                    {
                        CancellationTokenSource.CreateLinkedTokenSource(new CancellationToken[0]);
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    break;
                }

                case 4:
                {
                    var cts = new CancellationTokenSource();
                    cts.Cancel();
                    try
                    {
                        cts.Token.ThrowIfCancellationRequested();
                    }
                    catch (OperationCanceledException exception)
                    {
                        trace.Add(Describe(exception));
                        trace.Add(exception.CancellationToken == cts.Token);
                    }

                    trace.Add(CancellationToken.None.CanBeCanceled);
                    trace.Add(CancellationToken.None.IsCancellationRequested);
                    trace.Add(new CancellationToken(true).IsCancellationRequested);
                    trace.Add(new CancellationToken(true).CanBeCanceled);
                    trace.Add(new CancellationToken(false) == CancellationToken.None);
                    trace.Add(new CancellationToken(true) == new CancellationToken(true));
                    trace.Add(cts.Token.Equals((object)cts.Token));
                    trace.Add(Describe(new OperationCanceledException()));
                    trace.Add(Describe(new OperationCanceledException("m")));
                    trace.Add(Describe(new TaskCanceledException()));
                    trace.Add(Describe(new TaskCanceledException("t", new Boom("i")).InnerException));
                    break;
                }

                case 5:
                {
                    var cts = new CancellationTokenSource();
                    cts.Token.Register(() => trace.Add("reset away"));
                    trace.Add(cts.TryReset());
                    cts.Token.Register(() => trace.Add("kept"));
                    cts.Cancel();
                    trace.Add(cts.TryReset());
                    break;
                }

                case 6:
                {
                    var cts = new CancellationTokenSource();
                    var token = cts.Token;
                    cts.Dispose();
                    cts.Dispose();
                    try
                    {
                        _ = cts.Token;
                    }
                    catch (ObjectDisposedException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    try
                    {
                        cts.Cancel();
                    }
                    catch (ObjectDisposedException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    trace.Add(token.Register(() => trace.Add("disposed")) == default);
                    trace.Add(cts.IsCancellationRequested);
                    trace.Add(Describe(new ObjectDisposedException("Thing")));
                    trace.Add(Describe(new ObjectDisposedException("Thing", "custom")));
                    trace.Add(new ObjectDisposedException("Name").ObjectName);
                    break;
                }

                case 7:
                {
                    // A token ends an await on a promise.
                    var cts = new CancellationTokenSource();
                    var source = new TaskCompletionSource<int>();
                    cts.Token.Register(() => source.TrySetCanceled(cts.Token));
                    var awaiting = Awaiting(trace, "until canceled", source.Task);
                    cts.Cancel();
                    trace.Add(Describe(awaiting));
                    try
                    {
                        awaiting.GetAwaiter().GetResult();
                    }
                    catch (TaskCanceledException exception)
                    {
                        trace.Add(exception.CancellationToken == cts.Token);
                        trace.Add(ReferenceEquals(exception.Task, source.Task));
                    }

                    break;
                }

                default:
                {
                    // A callback that asked for the context runs through it
                    // (Send).
                    var cts = new CancellationTokenSource();
                    cts.Token.Register(() => trace.Add("through the context " + (SynchronizationContext.Current == pump)), true);
                    cts.Token.Register(state => trace.Add("plain " + state), 1, false);
                    cts.Cancel();
                    try
                    {
                        new CancellationTokenSource(-2);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(exception.ParamName);
                    }

                    try
                    {
                        new CancellationTokenSource().CancelAfter(-2);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(exception.ParamName);
                    }

                    trace.Add(new CancellationTokenSource(0).IsCancellationRequested);
                    break;
                }
            }
        });

        private static async IAsyncEnumerable<int> Numbers(Trace trace, int count, bool yielding)
        {
            try
            {
                for (int i = 0; i < count; i++)
                {
                    trace.Add("produce " + i);
                    if (yielding)
                    {
                        await Task.Yield();
                    }

                    yield return i;
                    trace.Add("resume " + i);
                }
            }
            finally
            {
                trace.Add("iterator finally");
            }
        }

        private static async IAsyncEnumerable<int> Failing(Trace trace)
        {
            yield return 1;
            await Task.Yield();
            throw new Boom("iterator");
        }

        private static async IAsyncEnumerable<int> Cancelable(Trace trace, [EnumeratorCancellation] CancellationToken token = default)
        {
            for (int i = 0; ; i++)
            {
                await Task.Yield();
                token.ThrowIfCancellationRequested();
                yield return i;
            }
        }

        private static async Task<int> Sum(Trace trace, IAsyncEnumerable<int> items, int stopAt = int.MaxValue)
        {
            int sum = 0;
            await foreach (int item in items)
            {
                trace.Add("got " + item);
                if (item == stopAt)
                {
                    break;
                }

                sum += item;
            }

            trace.Add("sum " + sum);
            return sum;
        }

        private static async Task<int> Sum(Trace trace, ConfiguredCancelableAsyncEnumerable<int> items, int stopAt = int.MaxValue)
        {
            int sum = 0;
            await foreach (int item in items)
            {
                trace.Add("got " + item);
                if (item == stopAt)
                {
                    break;
                }

                sum += item;
            }

            trace.Add("configured sum " + sum);
            return sum;
        }

        private sealed class Resource : IAsyncDisposable
        {
            private readonly Trace trace;
            private readonly string name;

            public Resource(Trace trace, string name)
            {
                this.trace = trace;
                this.name = name;
            }

            public async ValueTask DisposeAsync()
            {
                trace.Add("disposing " + name);
                await Task.Yield();
                trace.Add("disposed " + name);
            }
        }

        private static async Task Uses(Trace trace)
        {
            await using (var first = new Resource(trace, "first"))
            {
                await using var second = new Resource(trace, "second");
                trace.Add("using");
            }

            trace.Add("used");
        }

        // A source of its own, over ManualResetValueTaskSourceCore.
        private sealed class Signal : IValueTaskSource<int>
        {
            private ManualResetValueTaskSourceCore<int> core;

            public ValueTask<int> Wait()
            {
                core.Reset();
                return new ValueTask<int>(this, core.Version);
            }

            public void Set(int value) => core.SetResult(value);

            public void Fail(Exception exception) => core.SetException(exception);

            public int GetResult(short token) => core.GetResult(token);

            public ValueTaskSourceStatus GetStatus(short token) => core.GetStatus(token);

            public void OnCompleted(Action<object> continuation, object state, short token, ValueTaskSourceOnCompletedFlags flags) =>
                core.OnCompleted(continuation, state, token, flags);
        }

        private static async Task<int> AwaitsSignal(Trace trace, Signal signal)
        {
            int first = await signal.Wait();
            trace.Add("first " + first);
            try
            {
                return first + await signal.Wait();
            }
            catch (Boom boom)
            {
                trace.Add("signal " + boom.Message);
                return -1;
            }
        }

        // Async iterators, await foreach and await using.
        public static int Iterators(int which) => Run((pump, trace) =>
        {
            switch (which)
            {
                case 0:
                {
                    var task = Sum(trace, Numbers(trace, 3, true));
                    trace.Add("started " + Describe(task));
                    pump.Drain();
                    trace.Add(Describe(task) + " " + task.Result);
                    break;
                }

                case 1:
                {
                    var task = Sum(trace, Numbers(trace, 3, false));
                    trace.Add(Describe(task) + " " + task.Result);
                    var broken = Sum(trace, Numbers(trace, 5, true), 2);
                    pump.Drain();
                    trace.Add(Describe(broken) + " " + broken.Result);
                    break;
                }

                case 2:
                {
                    var task = Sum(trace, Failing(trace));
                    pump.Drain();
                    trace.Add(Describe(task) + " " + Describe(task.Exception.InnerException));
                    break;
                }

                case 3:
                {
                    var cts = new CancellationTokenSource();
                    var task = Sum(trace, Cancelable(trace).WithCancellation(cts.Token), -1);
                    pump.Drain(7);
                    trace.Add(Describe(task));
                    cts.Cancel();
                    pump.Drain();
                    trace.Add(Describe(task));
                    break;
                }

                case 4:
                {
                    // An enumerator by hand: completed MoveNextAsyncs are
                    // results already.
                    var enumerator = Numbers(trace, 2, false).GetAsyncEnumerator();
                    var next = enumerator.MoveNextAsync();
                    trace.Add(next.IsCompletedSuccessfully + " " + next.Result + " " + enumerator.Current);
                    next = enumerator.MoveNextAsync();
                    trace.Add(next.Result + " " + enumerator.Current);
                    next = enumerator.MoveNextAsync();
                    trace.Add(next.Result);
                    var disposed = enumerator.DisposeAsync();
                    trace.Add(disposed.IsCompletedSuccessfully);
                    var early = Numbers(trace, 3, false).GetAsyncEnumerator();
                    trace.Add(early.MoveNextAsync().Result);
                    trace.Add(early.DisposeAsync().IsCompleted);
                    break;
                }

                case 5:
                {
                    var task = Uses(trace);
                    pump.Drain();
                    trace.Add(Describe(task));
                    break;
                }

                case 6:
                {
                    // An iterator enumerated twice starts again.
                    var numbers = Numbers(trace, 2, false);
                    var first = Sum(trace, numbers);
                    var second = Sum(trace, numbers);
                    trace.Add(first.Result + second.Result);
                    var synchronous = Sum(trace, Numbers(trace, 3, false).ConfigureAwait(false).WithCancellation(default));
                    trace.Add(synchronous.Result);
                    break;
                }

                case 7:
                {
                    var signal = new Signal();
                    var task = AwaitsSignal(trace, signal);
                    trace.Add(Describe(task));
                    signal.Set(4);
                    trace.Add(Describe(task));
                    pump.Drain();
                    signal.Set(5);
                    pump.Drain();
                    trace.Add(Describe(task) + " " + task.Result);
                    var failing = AwaitsSignal(trace, signal);
                    signal.Set(1);
                    pump.Drain();
                    signal.Fail(new Boom("failed"));
                    pump.Drain();
                    trace.Add(failing.Result);
                    try
                    {
                        signal.GetResult((short)(signal.Wait().GetHashCode() + 100));
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    break;
                }

                default:
                {
                    // The iterator's token and the enumeration's, linked.
                    var mine = new CancellationTokenSource();
                    var theirs = new CancellationTokenSource();
                    var task = Sum(trace, Cancelable(trace, mine.Token).WithCancellation(theirs.Token), -1);
                    pump.Drain(5);
                    theirs.Cancel();
                    pump.Drain();
                    trace.Add(Describe(task));
                    var other = Sum(trace, Cancelable(trace, mine.Token).WithCancellation(mine.Token), -1);
                    pump.Drain(4);
                    mine.Cancel();
                    pump.Drain();
                    trace.Add(Describe(other));
                    break;
                }
            }
        });

        private static async IAsyncEnumerable<long> Ticks(int count)
        {
            for (int i = 0; i < count; i++)
            {
                await Frames.NextFrame();
                yield return Frame;
            }
        }

        // The frame a case started at, which what it traces counts from.
        private static long origin;

        private static long Frame => Frames.Count - origin;

        private static async Task Walk(Trace trace, string name, int frames)
        {
            for (int i = 0; i < frames; i++)
            {
                trace.Add(name + " frame " + Frame);
                await Frames.NextFrame();
            }

            trace.Add(name + " done " + Frame);
        }

        private static async Task YieldsInFrames(Trace trace)
        {
            await Frames.NextFrame();
            trace.Add("frame " + Frame);
            await Task.Yield();
            trace.Add("yielded in " + Frame);
            await Frames.NextFrame();
            trace.Add("next " + Frame);
        }

        private static async Task Consume(Trace trace)
        {
            await foreach (long tick in Ticks(3))
            {
                trace.Add("tick " + tick);
            }
        }

        // Shapes of async method bodies (for the runtime-async splitter,
        // which rewrites each: see the "async-runtime" module of
        // tests/differential.mjs).
        private static async Task<T> Echo<T>(Trace trace, T value, bool yielding)
        {
            if (yielding)
            {
                await Task.Yield();
            }

            trace.Add("echo " + value);
            return value;
        }

        private static async Task<int> InHandlers(Trace trace, Task<int> task, bool fail)
        {
            try
            {
                if (fail)
                {
                    throw new Boom("in try");
                }

                return await task;
            }
            catch (Boom boom)
            {
                trace.Add("catch " + boom.Message);
                return await task + 100;
            }
            finally
            {
                trace.Add("finally awaits");
                await Task.Yield();
                trace.Add("finally resumed");
            }
        }

        private static async Task Nested(Trace trace, int depth)
        {
            try
            {
                try
                {
                    await Task.Yield();
                    trace.Add("inner " + depth);
                    if (depth > 1)
                    {
                        throw new Boom("depth " + depth);
                    }
                }
                finally
                {
                    await Task.Yield();
                    trace.Add("inner finally " + depth);
                }
            }
            catch (Boom boom) when (boom.Message == "depth 2")
            {
                await Task.Yield();
                trace.Add("filtered " + boom.Message);
            }
            finally
            {
                trace.Add("outer finally " + depth);
            }
        }

        private static async Task<int> Fibonacci(Trace trace, int n)
        {
            if (n < 2)
            {
                await Task.Yield();
                return n;
            }

            return await Fibonacci(trace, n - 1) + await Fibonacci(trace, n - 2);
        }

        private static int Combine(int a, int b, int c, string d) => a * 100 + b * 10 + c + d.Length * 1000;

        // What is on the stack across an await: arguments, operands,
        // an array element's address.
        private static async Task<int> Spills(Trace trace, Task<int> task)
        {
            int[] cells = { 1, 2, 3 };
            cells[1] += await task;
            int value = Combine(cells[0], await task, cells[2], "ab" + await Echo(trace, "c", true));
            return value + (cells[1] > 3 ? await Echo(trace, 5, false) : 0);
        }

        private static async Task Loops(Trace trace, int count)
        {
            for (int i = 0; i < count; i++)
            {
                foreach (int j in new[] { i, i * 2 })
                {
                    if (j == 2)
                    {
                        continue;
                    }

                    await Task.Yield();
                    trace.Add("loop " + i + " " + j);
                    if (j > 4)
                    {
                        return;
                    }
                }
            }

            trace.Add("loops done");
        }

        private struct Counter
        {
            public int Value;

            // An async method of a struct works on a copy of it.
            public async Task<int> AddAfter(Trace trace, Task<int> task)
            {
                Value += 1;
                int before = Value;
                Value += await task;
                trace.Add("counter " + before + " " + Value);
                return Value;
            }
        }

        private sealed class Holder
        {
            public int Value;

            public async ValueTask<int> Bump(Trace trace)
            {
                await Task.Yield();
                Value++;
                trace.Add("holder " + Value);
                return Value;
            }
        }

        public static int Shapes(int which) => Run((pump, trace) =>
        {
            switch (which)
            {
                case 0:
                {
                    var a = Echo(trace, 3, true);
                    var b = Echo(trace, "s", false);
                    var c = Echo<object>(trace, null, true);
                    trace.Add(Describe(a) + " / " + Describe(b));
                    pump.Drain();
                    trace.Add(a.Result + b.Result);
                    trace.Add(c.Result is null);
                    break;
                }

                case 1:
                {
                    var source = new TaskCompletionSource<int>();
                    var ok = InHandlers(trace, source.Task, false);
                    var failed = InHandlers(trace, source.Task, true);
                    trace.Add(Describe(ok) + " / " + Describe(failed));
                    source.SetResult(4);
                    pump.Drain();
                    trace.Add(ok.Result + " " + failed.Result);
                    break;
                }

                case 2:
                {
                    var one = Nested(trace, 1);
                    var two = Nested(trace, 2);
                    var three = Nested(trace, 3);
                    pump.Drain();
                    trace.Add(Describe(one) + " / " + Describe(two) + " / " + Describe(three));
                    trace.Add(Describe(three.Exception.InnerException));
                    break;
                }

                case 3:
                {
                    var task = Fibonacci(trace, 5);
                    pump.Drain();
                    trace.Add(task.Result);
                    break;
                }

                case 4:
                {
                    var source = new TaskCompletionSource<int>();
                    var task = Spills(trace, source.Task);
                    source.SetResult(6);
                    pump.Drain();
                    trace.Add(task.Result);
                    var completed = Spills(trace, Task.FromResult(1));
                    pump.Drain();
                    trace.Add(completed.Result);
                    break;
                }

                case 5:
                {
                    var short_ = Loops(trace, 2);
                    var long_ = Loops(trace, 9);
                    pump.Drain();
                    trace.Add(Describe(short_) + " / " + Describe(long_));
                    break;
                }

                case 6:
                {
                    var source = new TaskCompletionSource<int>();
                    var counter = new Counter { Value = 10 };
                    var task = counter.AddAfter(trace, source.Task);
                    trace.Add("caller " + counter.Value);
                    source.SetResult(5);
                    trace.Add(task.Result + " caller " + counter.Value);
                    break;
                }

                default:
                {
                    var holder = new Holder();
                    var first = holder.Bump(trace);
                    var second = holder.Bump(trace);
                    pump.Drain();
                    trace.Add(first.Result + second.Result + holder.Value);
                    Func<int, Task<int>> lambda = async x =>
                    {
                        await Task.Yield();
                        return x + holder.Value;
                    };
                    var third = lambda(40);
                    pump.Drain();
                    trace.Add(third.Result);
                    break;
                }
            }
        });

        private static async Task Flows(Trace trace, AsyncLocal<int> local, string name)
        {
            trace.Add(name + " before " + local.Value);
            await Task.Yield();
            trace.Add(name + " after " + local.Value);
            local.Value += 100;
            await Task.Yield();
            trace.Add(name + " later " + local.Value);
        }

        private static async Task<int> SetsFirst(Trace trace, AsyncLocal<int> local)
        {
            local.Value = 5;
            trace.Add("set " + local.Value);
            await Task.Yield();
            trace.Add("resumed " + local.Value);
            return local.Value;
        }

        private static async IAsyncEnumerable<int> Locals(Trace trace, AsyncLocal<int> local)
        {
            for (int i = 0; i < 3; i++)
            {
                trace.Add("iterator " + i + " sees " + local.Value);
                local.Value = 50 + i;
                await Task.Yield();
                trace.Add("iterator " + i + " keeps " + local.Value);
                yield return i;
            }
        }

        private static async Task Iterates(Trace trace, AsyncLocal<int> local)
        {
            local.Value = 7;
            await foreach (int i in Locals(trace, local))
            {
                trace.Add("loop " + i + " sees " + local.Value);
                local.Value = 70 + i;
            }

            trace.Add("loop done " + local.Value);
        }

        private static async Task Notified(Trace trace, AsyncLocal<string> local)
        {
            local.Value = "inner";
            await Task.Yield();
            trace.Add("notified resumed " + local.Value);
        }

        // ExecutionContext and AsyncLocal<T>: what flows where.
        public static int Contexts(int which) => Run((pump, trace) =>
        {
            switch (which)
            {
                case 0:
                {
                    // Across awaits, and an async method's changes stay
                    // its own.
                    var local = new AsyncLocal<int>();
                    local.Value = 1;
                    var one = Flows(trace, local, "one");
                    local.Value = 2;
                    var two = Flows(trace, local, "two");
                    trace.Add("caller " + local.Value);
                    local.Value = 3;
                    pump.Drain();
                    trace.Add("caller after " + local.Value + " " + Describe(one) + " " + Describe(two));
                    break;
                }

                case 1:
                {
                    // What a method sets before its first await does not
                    // outlast the call; after it, its continuation has it.
                    var local = new AsyncLocal<int>();
                    local.Value = 1;
                    var task = SetsFirst(trace, local);
                    trace.Add("caller " + local.Value);
                    pump.Drain();
                    trace.Add("result " + task.Result + " caller " + local.Value);
                    break;
                }

                case 2:
                {
                    // Capture and Run, and Restore.
                    var local = new AsyncLocal<string>();
                    local.Value = "a";
                    var captured = ExecutionContext.Capture();
                    local.Value = "b";
                    ExecutionContext.Run(captured, state =>
                    {
                        trace.Add("run " + local.Value + " " + state);
                        local.Value = "c";
                        trace.Add("run set " + local.Value);
                    }, "s");
                    trace.Add("after run " + local.Value);
                    var defaults = ExecutionContext.Capture();
                    local.Value = null;
                    trace.Add("cleared " + (local.Value is null) + " " + ReferenceEquals(ExecutionContext.Capture(), defaults));
                    ExecutionContext.Restore(captured);
                    trace.Add("restored " + local.Value);
                    trace.Add(ReferenceEquals(captured, captured.CreateCopy()));
                    try
                    {
                        ExecutionContext.Run(null, _ => { }, null);
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    try
                    {
                        ExecutionContext.Run(captured, _ => throw new Boom("in run"), null);
                    }
                    catch (Boom boom)
                    {
                        trace.Add("thrown " + boom.Message + " " + local.Value);
                    }

                    break;
                }

                case 3:
                {
                    // Suppressing the flow.
                    var local = new AsyncLocal<int>();
                    local.Value = 1;
                    Task task;
                    using (ExecutionContext.SuppressFlow())
                    {
                        trace.Add(ExecutionContext.IsFlowSuppressed());
                        trace.Add(ExecutionContext.Capture() is null);
                        var again = ExecutionContext.SuppressFlow();
                        trace.Add(again == default(AsyncFlowControl));
                        again.Undo();
                        trace.Add(ExecutionContext.IsFlowSuppressed());
                        task = Flows(trace, local, "suppressed");
                    }

                    trace.Add(ExecutionContext.IsFlowSuppressed());
                    local.Value = 7;
                    pump.Drain();
                    trace.Add("caller " + local.Value);
                    try
                    {
                        ExecutionContext.RestoreFlow();
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    var control = ExecutionContext.SuppressFlow();
                    ExecutionContext.RestoreFlow();
                    try
                    {
                        control.Undo();
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    var first = ExecutionContext.SuppressFlow();
                    trace.Add(first == ExecutionContext.SuppressFlow());
                    first.Dispose();
                    first.Dispose();
                    trace.Add(ExecutionContext.IsFlowSuppressed());
                    break;
                }

                case 4:
                {
                    // Change notifications: set, and each change of context
                    // that changes the value.
                    var local = new AsyncLocal<string>(args => trace.Add(
                        "changed " + (args.PreviousValue ?? "null") + " -> " + (args.CurrentValue ?? "null") + " " + args.ThreadContextChanged));
                    var plain = new AsyncLocal<int>();
                    local.Value = "outer";
                    local.Value = "outer";
                    plain.Value = 4;
                    var task = Notified(trace, local);
                    trace.Add("caller " + local.Value);
                    var captured = ExecutionContext.Capture();
                    local.Value = null;
                    ExecutionContext.Run(captured, _ => trace.Add("in run " + local.Value), null);
                    pump.Drain();
                    trace.Add("caller after " + (local.Value ?? "null") + " " + plain.Value + " " + Describe(task));
                    break;
                }

                case 5:
                {
                    // ContinueWith and Register flow; UnsafeRegister does
                    // not.
                    var local = new AsyncLocal<int>();
                    local.Value = 1;
                    var source = new TaskCompletionSource();
                    var continuation = source.Task.ContinueWith(
                        _ => trace.Add("continuation " + local.Value), TaskContinuationOptions.ExecuteSynchronously);
                    var cts = new CancellationTokenSource();
                    cts.Token.Register(() => trace.Add("registered " + local.Value));
                    cts.Token.UnsafeRegister(_ => trace.Add("unsafe " + local.Value), null);
                    cts.Token.Register(state => trace.Add("with state " + state + " " + local.Value), "s");
                    local.Value = 2;
                    source.SetResult();
                    cts.Cancel();
                    trace.Add("caller " + local.Value + " " + Describe(continuation));
                    break;
                }

                case 6:
                {
                    // An awaiter's OnCompleted flows; UnsafeOnCompleted
                    // does not, and a post runs where the pump does.
                    var local = new AsyncLocal<int>();
                    local.Value = 1;
                    var source = new TaskCompletionSource();
                    var awaiter = source.Task.GetAwaiter();
                    awaiter.OnCompleted(() => trace.Add("on " + local.Value));
                    awaiter.UnsafeOnCompleted(() => trace.Add("unsafe " + local.Value));
                    source.Task.ConfigureAwait(true).GetAwaiter().OnCompleted(() => trace.Add("configured " + local.Value));
                    Task.Yield().GetAwaiter().OnCompleted(() => trace.Add("yield " + local.Value));
                    local.Value = 2;
                    source.SetResult();
                    trace.Add("set");
                    local.Value = 3;
                    pump.Drain();
                    break;
                }

                case 7:
                {
                    // Async iteration: the iterator runs in its caller's
                    // context at each MoveNextAsync, and keeps its own.
                    var local = new AsyncLocal<int>();
                    local.Value = 1;
                    var task = Iterates(trace, local);
                    trace.Add("caller " + local.Value);
                    pump.Drain();
                    trace.Add("caller after " + local.Value + " " + Describe(task));
                    break;
                }

                case 8:
                {
                    // ValueTask over an IValueTaskSource: OnCompleted flows.
                    var local = new AsyncLocal<int>();
                    local.Value = 1;
                    var signal = new Signal();
                    var awaiter = signal.Wait().GetAwaiter();
                    awaiter.OnCompleted(() => trace.Add("value on " + local.Value));
                    local.Value = 2;
                    signal.Set(5);
                    trace.Add("caller " + local.Value);
                    pump.Drain();
                    break;
                }
            }
        });

        // A scheduler of the case's own: it queues in order, runs what it
        // queued when the case drains it, and runs a task inline only when
        // it lets it. (The CLR's default scheduler is its thread pool, which
        // orders nothing: these cases never let a task reach it.)
        internal sealed class Lane : TaskScheduler
        {
            private readonly List<Task> queue = new List<Task>();
            private readonly Trace trace;
            private readonly string name;
            public bool Inline;
            public bool Refuse;

            public Lane(Trace trace, string name)
            {
                this.trace = trace;
                this.name = name;
            }

            protected override void QueueTask(Task task)
            {
                if (Refuse)
                {
                    throw new Boom(name + " refuses");
                }

                trace.Add(name + " queues " + task.Status);
                queue.Add(task);
            }

            protected override bool TryExecuteTaskInline(Task task, bool taskWasPreviouslyQueued)
            {
                trace.Add(name + " inline? " + taskWasPreviouslyQueued + " " + Inline);
                if (!Inline || (taskWasPreviouslyQueued && !queue.Remove(task)))
                {
                    return false;
                }

                return TryExecuteTask(task);
            }

            protected override bool TryDequeue(Task task)
            {
                bool removed = queue.Remove(task);
                trace.Add(name + " dequeue " + removed);
                return removed;
            }

            protected override IEnumerable<Task> GetScheduledTasks() => queue;

            public override int MaximumConcurrencyLevel => 1;

            public int Count => queue.Count;

            public void RunOne()
            {
                var task = queue[0];
                queue.RemoveAt(0);
                trace.Add(name + " runs " + TryExecuteTask(task));
            }

            public void Drain()
            {
                while (queue.Count > 0)
                {
                    RunOne();
                }
            }
        }

        private static string Where() =>
            (TaskScheduler.Current is Lane ? "lane" : TaskScheduler.Current == TaskScheduler.Default ? "default" : "other")
            + (Task.CurrentId is null ? " no task" : " in task");

        private static async Task OnLane(Trace trace, Task before)
        {
            trace.Add("async starts " + Where());
            await before;
            trace.Add("async resumes " + Where());
            await Task.Yield();
            trace.Add("async yields back " + Where());
        }

        // TaskScheduler, TaskFactory, Task's constructors, Start and
        // RunSynchronously, ContinueWith on a scheduler, attached children
        // and Unwrap.
        public static int Schedulers(int which) => Run((pump, trace) =>
        {
            var lane = new Lane(trace, "lane");
            switch (which)
            {
                case 0:
                {
                    // StartNew queues to the factory's scheduler; what runs
                    // there sees it current, and ContinueWith and StartNew
                    // inside it use it.
                    var factory = new TaskFactory(lane);
                    trace.Add(factory.Scheduler == lane);
                    trace.Add(Where());
                    var first = factory.StartNew(() =>
                    {
                        trace.Add("first " + Where());
                        Task.Factory.StartNew(() => trace.Add("inner " + Where()));
                        Task.CompletedTask.ContinueWith(_ => trace.Add("continued " + Where()));
                    });
                    var second = factory.StartNew(state => trace.Add("second " + state), "s");
                    var third = factory.StartNew(() => 3);
                    var fourth = Task.Factory.StartNew(s => (int)s! * 2, 2, CancellationToken.None, TaskCreationOptions.None, lane);
                    trace.Add(Describe(first) + " " + lane.Count);
                    lane.Drain();
                    trace.Add(Describe(first) + " " + Describe(second) + " " + third.Result + " " + fourth.Result);
                    trace.Add(TaskScheduler.Default.MaximumConcurrencyLevel == int.MaxValue);
                    break;
                }

                case 1:
                {
                    // Unstarted tasks: Start, RunSynchronously, and what they
                    // refuse.
                    var task = new Task(() => trace.Add("ran " + Where()));
                    trace.Add(Describe(task));
                    task.Start(lane);
                    trace.Add(Describe(task));
                    try
                    {
                        task.Start(lane);
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    lane.Drain();
                    trace.Add(Describe(task));
                    try
                    {
                        task.Start(lane);
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    var function = new Task<int>(s => (int)s! + 1, 41);
                    lane.Inline = true;
                    function.RunSynchronously(lane);
                    trace.Add(Describe(function) + " " + function.Result + " " + function.AsyncState);
                    try
                    {
                        new TaskCompletionSource().Task.Start(lane);
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    try
                    {
                        Task.CompletedTask.ContinueWith(_ => { }, lane).RunSynchronously(lane);
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    var canceled = new Task(() => trace.Add("never"), new CancellationToken(true));
                    trace.Add(Describe(canceled));
                    try
                    {
                        canceled.Start(lane);
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    try
                    {
                        new Task(() => { }, (TaskCreationOptions)1024);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(exception.ParamName);
                    }

                    lane.Drain();
                    break;
                }

                case 2:
                {
                    // A delegate's exception faults its task; a canceled
                    // token's own OperationCanceledException cancels it; a
                    // token canceled before the task runs cancels it.
                    var cts = new CancellationTokenSource();
                    var faulted = Task.Factory.StartNew(() => throw new Boom("delegate"), CancellationToken.None, TaskCreationOptions.None, lane);
                    var canceled = Task.Factory.StartNew(() =>
                    {
                        cts.Cancel();
                        cts.Token.ThrowIfCancellationRequested();
                    }, cts.Token, TaskCreationOptions.None, lane);
                    var other = new CancellationTokenSource();
                    var unrelated = Task.Factory.StartNew(() => throw new OperationCanceledException(other.Token), CancellationToken.None,
                        TaskCreationOptions.None, lane);
                    var queuedThenCanceled = Task.Factory.StartNew(() => trace.Add("never"), cts.Token, TaskCreationOptions.None, lane);
                    var unstarted = new Task(() => trace.Add("never"), other.Token);
                    other.Cancel();
                    trace.Add(Describe(unstarted));
                    lane.Drain();
                    trace.Add(Describe(faulted) + " " + Describe(faulted.Exception.InnerException));
                    trace.Add(Describe(canceled) + " " + Describe(unrelated) + " " + Describe(queuedThenCanceled));
                    try
                    {
                        canceled.Wait();
                    }
                    catch (AggregateException aggregate)
                    {
                        trace.Add(Describe(aggregate.InnerException));
                    }

                    break;
                }

                case 3:
                {
                    // Attached children keep their parent from completing
                    // and give it their exceptions; DenyChildAttach and an
                    // observed child do not.
                    var parent = Task.Factory.StartNew(() =>
                    {
                        Task.Factory.StartNew(() => trace.Add("child ran"), CancellationToken.None, TaskCreationOptions.AttachedToParent, lane);
                        Task.Factory.StartNew(() => throw new Boom("child"), CancellationToken.None, TaskCreationOptions.AttachedToParent, lane);
                        Task.Factory.StartNew(() => throw new Boom("detached"), CancellationToken.None, TaskCreationOptions.None, lane);
                        trace.Add("parent ran");
                    }, CancellationToken.None, TaskCreationOptions.None, lane);
                    lane.RunOne();
                    trace.Add(Describe(parent));
                    lane.RunOne();
                    trace.Add(Describe(parent));
                    lane.Drain();
                    trace.Add(Describe(parent) + " " + parent.Exception.InnerExceptions.Count);
                    trace.Add(Describe(parent.Exception.InnerException) + " " + Describe(parent.Exception.InnerException.InnerException));
                    var denying = Task.Factory.StartNew(() =>
                    {
                        Task.Factory.StartNew(() => throw new Boom("denied"), CancellationToken.None, TaskCreationOptions.AttachedToParent, lane);
                    }, CancellationToken.None, TaskCreationOptions.DenyChildAttach, lane);
                    lane.RunOne();
                    trace.Add(Describe(denying));
                    lane.Drain();
                    lane.Inline = true;
                    var observing = Task.Factory.StartNew(() =>
                    {
                        var child = Task.Factory.StartNew(
                            () => throw new Boom("observed"), CancellationToken.None, TaskCreationOptions.AttachedToParent, lane);
                        try
                        {
                            child.Wait();
                        }
                        catch (AggregateException aggregate)
                        {
                            trace.Add("waited " + Describe(aggregate.InnerException));
                        }
                    }, CancellationToken.None, TaskCreationOptions.None, lane);
                    lane.Drain();
                    trace.Add(Describe(observing));
                    break;
                }

                case 4:
                {
                    // ContinueWith on a scheduler: queued, or inline when it
                    // asks to run synchronously and the scheduler lets it.
                    var source = new TaskCompletionSource<int>();
                    var queued = source.Task.ContinueWith(task => trace.Add("queued " + task.Result + " " + Where()), lane);
                    var inline = source.Task.ContinueWith(
                        task => task.Result * 10, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, lane);
                    var refused = source.Task.ContinueWith(
                        (task, state) => trace.Add("refused " + state), "s", CancellationToken.None,
                        TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.OnlyOnFaulted, lane);
                    lane.Inline = true;
                    source.SetResult(4);
                    trace.Add(Describe(queued) + " " + Describe(inline) + " " + inline.Result + " " + Describe(refused));
                    lane.Drain();
                    trace.Add(Describe(queued));
                    break;
                }

                case 5:
                {
                    // ContinueWhenAll and ContinueWhenAny, and what they
                    // refuse.
                    var factory = new TaskFactory<int>(lane);
                    var a = new TaskCompletionSource<int>();
                    var b = new TaskCompletionSource<int>();
                    var all = factory.ContinueWhenAll(new Task[] { a.Task, b.Task }, tasks => tasks.Length);
                    var any = Task.Factory.ContinueWhenAny(new[] { a.Task, b.Task }, task => trace.Add("any " + task.Result), CancellationToken.None,
                        TaskContinuationOptions.None, lane);
                    var allOfResults = Task.Factory.ContinueWhenAll(new[] { a.Task, b.Task }, tasks => tasks[0].Result + tasks[1].Result,
                        CancellationToken.None, TaskContinuationOptions.None, lane);
                    b.SetResult(2);
                    trace.Add(Describe(all) + " " + Describe(any));
                    lane.Drain();
                    a.SetException(new Boom("a"));
                    lane.Drain();
                    trace.Add(all.Result + " " + Describe(allOfResults) + " " + Describe(allOfResults.Exception.InnerException));
                    try
                    {
                        Task.Factory.ContinueWhenAll(new Task[0], tasks => { });
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    try
                    {
                        Task.Factory.ContinueWhenAny(new Task[] { null }, task => { });
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    try
                    {
                        Task.Factory.ContinueWhenAll(new[] { Task.CompletedTask }, tasks => { }, TaskContinuationOptions.NotOnFaulted);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(exception.ParamName);
                    }

                    var canceled = Task.Factory.ContinueWhenAll(new[] { Task.CompletedTask }, tasks => { }, new CancellationToken(true));
                    trace.Add(Describe(canceled));
                    break;
                }

                case 6:
                {
                    // An await in a task on a scheduler continues there, and
                    // Task.Yield yields to it, when no SynchronizationContext
                    // is current.
                    var previous = SynchronizationContext.Current;
                    SynchronizationContext.SetSynchronizationContext(null);
                    try
                    {
                        var source = new TaskCompletionSource();
                        var outer = Task.Factory.StartNew(() => OnLane(trace, source.Task), CancellationToken.None, TaskCreationOptions.None, lane)
                            .Unwrap();
                        lane.Drain();
                        trace.Add(Describe(outer));
                        source.SetResult();
                        trace.Add("set " + lane.Count);
                        lane.Drain();
                        trace.Add(Describe(outer));
                    }
                    finally
                    {
                        SynchronizationContext.SetSynchronizationContext(previous);
                    }

                    break;
                }

                case 7:
                {
                    // FromCurrentSynchronizationContext posts to the context;
                    // a scheduler that throws faults the task with a
                    // TaskSchedulerException.
                    var posting = TaskScheduler.FromCurrentSynchronizationContext();
                    trace.Add(posting.MaximumConcurrencyLevel);
                    var task = Task.Factory.StartNew(() => trace.Add("posted " + (SynchronizationContext.Current == pump)), CancellationToken.None,
                        TaskCreationOptions.None, posting);
                    trace.Add(Describe(task) + " " + pump.Posted);
                    pump.Drain();
                    trace.Add(Describe(task));
                    lane.Refuse = true;
                    try
                    {
                        Task.Factory.StartNew(() => { }, CancellationToken.None, TaskCreationOptions.None, lane);
                    }
                    catch (TaskSchedulerException exception)
                    {
                        trace.Add(exception.GetType().Name + " " + Describe(exception.InnerException));
                    }

                    var unstarted = new Task(() => { });
                    try
                    {
                        unstarted.Start(lane);
                    }
                    catch (TaskSchedulerException exception)
                    {
                        trace.Add(Describe(unstarted) + " " + Describe(exception.InnerException));
                    }

                    var previous = SynchronizationContext.Current;
                    SynchronizationContext.SetSynchronizationContext(null);
                    try
                    {
                        TaskScheduler.FromCurrentSynchronizationContext();
                    }
                    catch (InvalidOperationException exception)
                    {
                        trace.Add(Describe(exception));
                    }
                    finally
                    {
                        SynchronizationContext.SetSynchronizationContext(previous);
                    }

                    break;
                }

                case 8:
                {
                    // Waiting for a queued task runs it if its scheduler
                    // lets it (without a timeout or token, as the CLR's);
                    // Unwrap's task completes as the inner task does.
                    lane.Inline = true;
                    var queued = Task.Factory.StartNew(() => 8, CancellationToken.None, TaskCreationOptions.None, lane);
                    trace.Add(queued.Wait(1) + " " + Describe(queued));
                    trace.Add(queued.Result + " " + lane.Count);
                    var inner = new TaskCompletionSource<int>();
                    var unwrapped = Task.Factory.StartNew(() => inner.Task, CancellationToken.None, TaskCreationOptions.None, lane).Unwrap();
                    var empty = Task.Factory.StartNew(() => (Task)null, CancellationToken.None, TaskCreationOptions.None, lane).Unwrap();
                    lane.Drain();
                    trace.Add(Describe(unwrapped) + " " + Describe(empty));
                    inner.SetResult(5);
                    trace.Add(Describe(unwrapped) + " " + unwrapped.Result);
                    var done = Task.FromResult(Task.FromResult(6)).Unwrap();
                    trace.Add(done.Result);
                    break;
                }
            }

            lane.Drain();
        });

        // Waiting with timeouts, and WaitAsync with a token.
        public static int Waits(int which) => Run((pump, trace) =>
        {
            switch (which)
            {
                case 0:
                {
                    // Nothing else runs while the thread waits: a timeout
                    // passes.
                    var waiting = new TaskCompletionSource().Task;
                    var done = Task.CompletedTask;
                    trace.Add(waiting.Wait(5));
                    trace.Add(waiting.Wait(TimeSpan.FromMilliseconds(2)));
                    trace.Add(waiting.Wait(0));
                    trace.Add(Task.WaitAll([done, waiting], 5));
                    trace.Add(Task.WaitAll([done], 5));
                    trace.Add(Task.WaitAny([waiting, done], 5));
                    trace.Add(Task.WaitAny([waiting], 5));
                    trace.Add(Task.WaitAny([waiting], TimeSpan.FromMilliseconds(1)));
                    trace.Add(done.Wait(5));
                    trace.Add(Task.WaitAll([done, Task.FromResult(1)], TimeSpan.FromMilliseconds(5)));
                    break;
                }

                case 1:
                {
                    // Completed tasks: exceptions, and canceled tokens.
                    var faulted = Task.FromException(new Boom("waited"));
                    var canceled = Task.FromCanceled(new CancellationToken(true));
                    try
                    {
                        faulted.Wait(5);
                    }
                    catch (AggregateException aggregate)
                    {
                        trace.Add(Describe(aggregate.InnerException));
                    }

                    try
                    {
                        Task.WaitAll([faulted, canceled], 5);
                    }
                    catch (AggregateException aggregate)
                    {
                        trace.Add(aggregate.InnerExceptions.Count + " " + Describe(aggregate.InnerExceptions[1]));
                    }

                    var cts = new CancellationTokenSource();
                    cts.Cancel();
                    trace.Add(Task.CompletedTask.Wait(5, cts.Token));
                    try
                    {
                        new TaskCompletionSource().Task.Wait(5, cts.Token);
                    }
                    catch (OperationCanceledException exception)
                    {
                        trace.Add(Describe(exception));
                    }

                    try
                    {
                        Task.WaitAll([canceled], 5, cts.Token);
                    }
                    catch (OperationCanceledException exception)
                    {
                        trace.Add("all " + Describe(exception));
                    }

                    try
                    {
                        Task.WaitAny([canceled], 5, cts.Token);
                    }
                    catch (OperationCanceledException exception)
                    {
                        trace.Add("any " + Describe(exception));
                    }

                    trace.Add(Task.WaitAny([canceled], 5));
                    try
                    {
                        Task.WaitAll([null], 5);
                    }
                    catch (ArgumentException exception)
                    {
                        trace.Add(exception.GetType().Name);
                    }

                    try
                    {
                        faulted.Wait(-2);
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(exception.GetType().Name);
                    }

                    break;
                }

                case 2:
                {
                    // WaitAsync with a token: the task's outcome, or
                    // canceled.
                    var source = new TaskCompletionSource<int>();
                    var cts = new CancellationTokenSource();
                    var waited = source.Task.WaitAsync(cts.Token);
                    var unbounded = source.Task.WaitAsync(CancellationToken.None);
                    trace.Add(ReferenceEquals(unbounded, source.Task));
                    trace.Add(ReferenceEquals(Task.CompletedTask.WaitAsync(cts.Token), Task.CompletedTask));
                    waited.ContinueWith(task => trace.Add("waited " + Describe(task)), TaskContinuationOptions.ExecuteSynchronously);
                    source.SetResult(3);
                    trace.Add(waited.Result);
                    var other = new TaskCompletionSource();
                    var canceledWait = other.Task.WaitAsync(cts.Token);
                    canceledWait.ContinueWith(task => trace.Add("canceled " + Describe(task)), TaskContinuationOptions.ExecuteSynchronously);
                    cts.Cancel();
                    trace.Add(Describe(canceledWait) + " " + Describe(other.Task));
                    trace.Add(Describe(new TaskCompletionSource().Task.WaitAsync(cts.Token)));
                    var failing = new TaskCompletionSource();
                    var failed = failing.Task.WaitAsync(new CancellationTokenSource().Token);
                    var boom = new Boom("through");
                    failing.SetException(boom);
                    trace.Add(Describe(failed) + " " + ReferenceEquals(failed.Exception.InnerException, boom));
                    trace.Add(Describe(Task.CompletedTask.WaitAsync(TimeSpan.Zero)));
                    trace.Add(Describe(new TaskCompletionSource().Task.WaitAsync(TimeSpan.Zero)));
                    trace.Add(Describe(new TaskCompletionSource<int>().Task.WaitAsync(TimeSpan.Zero).Exception.InnerException));
                    break;
                }
            }
        });

        // The frame loop (Gameplay.Frames): the CoreLib's, and on the CLR
        // sdk/Frames.cs.
        public static int FrameLoop(int which)
        {
            var trace = new Trace();
            origin = Frames.Count;
            var elapsed = Frames.Time;
            switch (which)
            {
                case 0:
                {
                    var a = Walk(trace, "a", 2);
                    var b = Walk(trace, "b", 1);
                    for (int i = 0; i < 3; i++)
                    {
                        trace.Add("advance");
                        Frames.Advance(TimeSpan.FromMilliseconds(16));
                    }

                    trace.Add(a.IsCompleted && b.IsCompleted);
                    break;
                }

                case 1:
                {
                    var task = YieldsInFrames(trace);
                    Frames.Advance(TimeSpan.FromMilliseconds(10));
                    trace.Add("after first");
                    Frames.Advance(TimeSpan.FromMilliseconds(10));
                    trace.Add(task.IsCompleted);
                    break;
                }

                case 2:
                {
                    var source = new TaskCompletionSource<int>();
                    var awaiting = Awaiting(trace, "frame", source.Task);
                    Frames.NextFrame().GetAwaiter().OnCompleted(() => source.SetResult(3));
                    Frames.Advance(TimeSpan.Zero);
                    trace.Add(awaiting.Result);
                    try
                    {
                        Frames.Advance(TimeSpan.FromTicks(-1));
                    }
                    catch (ArgumentOutOfRangeException exception)
                    {
                        trace.Add(exception.ParamName);
                    }

                    break;
                }

                case 3:
                {
                    // An async iterator over frames.
                    var task = Consume(trace);
                    for (int i = 0; i < 4; i++)
                    {
                        Frames.Advance(TimeSpan.FromMilliseconds(5));
                    }

                    trace.Add(task.IsCompleted);
                    break;
                }

                default:
                {
                    // Advancing from inside a frame is refused.
                    Frames.NextFrame().GetAwaiter().OnCompleted(() =>
                    {
                        try
                        {
                            Frames.Advance(TimeSpan.Zero);
                        }
                        catch (InvalidOperationException exception)
                        {
                            trace.Add(exception.Message);
                        }
                    });
                    Frames.Advance(TimeSpan.FromSeconds(1));
                    break;
                }
            }

            trace.Add("frames " + Frame + " time " + (Frames.Time - elapsed).TotalMilliseconds);
            return trace.Hash();
        }
    }
}
