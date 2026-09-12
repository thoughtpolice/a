// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The module side of world `worker` in tasks.wit, which
// tests/wit-tasks.mjs runs as a component model host would.
using System;
using System.Collections.Generic;
using System.Runtime.Intrinsics;
using System.Threading;
using System.Threading.Tasks;
using Gameplay.Runtime;

namespace Test.Tasks;

public static partial class Worker
{
    public static partial async Task<ulong> Run(uint n)
    {
        await Task.Yield();
        var first = Host.Add(n, 1);
        var second = Host.Sum5(n, n, n, n, n);
        var both = await Task.WhenAll(first, second);
        ulong found = await Jobs.Find(n);
        return (ulong)both[0] * 1000 + both[1] + found * 1000000;
    }

    // Through Wasm SIMD (Vector128's v128), which the component wraps and
    // wlink links like any code.
    public static partial uint Plain(uint x) =>
        Vector128.Sum(Vector128.Create(x) * Vector128.Create(1u, 1u, 1u, 0u));

    public static partial uint Measure(string text) => (uint)text.Length;

    public static partial class Jobs
    {
        private static TaskCompletionSource<uint> held = new TaskCompletionSource<uint>();

        public static partial async Task<uint> Total(uint[] values)
        {
            uint sum = 0;
            foreach (uint value in values)
            {
                sum = await Host.Add(sum, value);
            }

            return sum;
        }

        public static partial async Task<string> Greet(string who)
        {
            await Host.Note("greeting " + who);
            return "hello, " + who + "!";
        }

        public static partial async Task<Host.Point> Both(string a, string b)
        {
            var points = await Task.WhenAll(Host.Measure(a, 1), Host.Measure(b, 10));
            return new Host.Point(points[0].X + points[1].X, points[0].Y + points[1].Y);
        }

        public static partial async Task<ulong> Find(uint key)
        {
            var found = await Host.Lookup(key);
            return found.HasValue ? found.Value : (ulong)key * key;
        }

        public static partial async Task<uint> Hold()
        {
            uint value = await held.Task;
            held = new TaskCompletionSource<uint>();
            return value + 1;
        }

        public static partial async Task Release(uint value)
        {
            await Task.Yield();
            held.SetResult(value);
        }

        public static partial Task<uint> Early(uint value)
        {
            _ = Host.Note("after " + value);
            return Task.FromResult(value * 2);
        }

        public static partial async Task<uint> Cancelable(uint value)
        {
            var token = ComponentTasks.Cancellation;
            var canceled = new TaskCompletionSource<uint>();
            using (token.Register(() => canceled.TrySetCanceled(token)))
            {
                var first = await Task.WhenAny(Host.Add(value, 1), canceled.Task);
                return await first;
            }
        }

        public static partial async Task<uint> Fail(uint value)
        {
            await Host.Add(value, value);
            throw new InvalidOperationException("failed after " + value);
        }

        public static partial async Task<string> Card(uint id)
        {
            var name = Host.NameOf(id);
            var names = Host.Names(id % 4);
            var profile = Host.Profile(id);
            string label = Host.Label(id);
            byte[] bytes = await Host.BytesOf(await name);
            var person = await profile;
            return label + ":" + await name + "/" + string.Join(",", await names) + "/" + person.Name + "["
                   + string.Join(",", person.Tags) + "]" + person.Age + "/" + bytes.Length;
        }

        public static partial async Task<string> Tally(uint start, uint by)
        {
            var counter = new Host.Counter(start);
            uint first = await counter.Bump(by);
            var made = await Host.Counter.Make(first * 10);
            uint second = await made.Bump(by);
            string text = await counter.Describe() + "|" + await made.Describe();
            counter.Dispose();
            made.Dispose();
            return first + "," + second + "," + text;
        }

        public static partial Task<StreamReader<uint>> CountTo(uint n)
        {
            var (reader, writer) = Worker.NewStreamU32();
            _ = Produce(writer, n);
            return Task.FromResult(reader);
        }

        // Three at a time, as the host reads them.
        private static async Task Produce(StreamWriter<uint> writer, uint n)
        {
            for (uint next = 1; next <= n; next += 3)
            {
                var chunk = new uint[Math.Min(3, (int)(n - next + 1))];
                for (int index = 0; index < chunk.Length; index++)
                {
                    chunk[index] = next + (uint)index;
                }

                if (await writer.WriteAsync(chunk) < chunk.Length)
                {
                    break;
                }
            }

            writer.Dispose();
        }

        public static partial async Task<string> Concat(StreamReader<string> parts)
        {
            var joined = new List<string>();
            await foreach (string part in parts)
            {
                joined.Add(part);
            }

            parts.Dispose();
            return string.Join("+", joined);
        }

        public static partial Task<FutureReader<ulong>> Delayed(uint value)
        {
            var (reader, writer) = Worker.NewFutureU64();
            _ = Resolve(writer, value);
            return Task.FromResult(reader);
        }

        private static async Task Resolve(FutureWriter<ulong> writer, uint value)
        {
            uint doubled = await Host.Add(value, value);
            await writer.WriteAsync((ulong)doubled * 1000);
        }

        public static partial async Task<string> Pipes(uint n)
        {
            var (numbers, sink) = Worker.NewStreamU32();
            var sum = Host.SumStream(numbers);
            var values = new uint[n];
            for (uint index = 0; index < n; index++)
            {
                values[index] = index + 1;
            }

            int written = await sink.WriteAsync(values);
            sink.Dispose();
            uint total = await sum;

            var words = new List<string>();
            var stream = Host.Words(n);
            var buffer = new string[2];
            int count;
            while ((count = await stream.ReadAsync(buffer)) > 0)
            {
                for (int index = 0; index < count; index++)
                {
                    words.Add(buffer[index]);
                }
            }

            stream.Dispose();
            var later = await Host.Later(n);
            string text = await later.ReadAsync();

            var (future, promise) = Worker.NewFutureU32();
            var waited = Host.WaitFor(future);
            bool taken = await promise.WriteAsync(n * 7);
            uint echoed = await waited;
            return written + ":" + total + ":" + string.Join(",", words) + ":" + text + ":" + taken + ":" + echoed;
        }

        public static partial async Task<string> Abandon(StreamReader<uint> numbers)
        {
            var source = new CancellationTokenSource();
            var first = numbers.ReadAsync(new uint[4], source.Token);
            await Host.Add(1, 2);
            source.Cancel();
            string canceled = await Outcome(first);
            var second = numbers.ReadAsync(new uint[4]);
            numbers.Dispose();
            return canceled + ":" + await Outcome(second) + ":" + numbers.IsCompleted;
        }

        private static async Task<string> Outcome(Task<int> read)
        {
            try
            {
                return "read " + await read;
            }
            catch (OperationCanceledException)
            {
                return "canceled";
            }
        }

        public static partial uint Combined(Account a, Account b) => a.Balance + b.Balance;

        public static partial string[] Closed() => Account.ClosedOwners.ToArray();

        public sealed partial class Account
        {
            internal static readonly List<string> ClosedOwners = new List<string>();
            private static Account last;
            private readonly string owner;
            internal uint Balance;

            public partial Account(string owner)
            {
                this.owner = owner;
                last = this;
            }

            public partial async Task<uint> Deposit(uint amount)
            {
                Balance = await Host.Add(Balance, amount);
                return Balance;
            }

            public partial string Statement() => owner + ":" + Balance;

            public partial void Absorb(Account other)
            {
                Balance += other.Balance;
                other.Balance = 0;
            }

            internal static partial async Task<Account> Open(string owner, uint a, uint b)
            {
                uint opening = await Host.Add(a, b);
                return new Account(owner) { Balance = opening };
            }

            internal static partial Account Latest() => last;

            partial void OnDropped() => ClosedOwners.Add(owner);
        }
    }
}
