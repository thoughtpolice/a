// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.InterfaceEvents
{
    public interface IBus
    {
        event Action<int> Fired;

        void Raise(int value);
    }

    public interface ICounted
    {
        event Action Changed;
    }

    public interface IBoth : IBus, ICounted
    {
        event Func<int, int> Mapped;
    }

    public interface IChannel<T>
    {
        event Action<T> Sent;
    }

    // A default accessor pair: the interface's own bodies.
    public interface ITallied
    {
        static int Tally;

        event Action<string> Noted
        {
            add => Tally += 10;
            remove => Tally -= 1;
        }
    }

    // Field-like events implementing the interfaces' events.
    public class FieldBus : IBus
    {
        public event Action<int> Fired;

        public void Raise(int value) => Fired?.Invoke(value);
    }

    // Accessors of its own, and explicit implementations.
    public sealed class AccessorBus : IBoth, IChannel<int>, IChannel<string>, ITallied
    {
        private Action<int> fired;
        private Action changed;
        private Func<int, int> mapped;
        private Action<int> ints;

        public int Adds;
        public int Removes;

        public event Action<int> Fired
        {
            add
            {
                Adds++;
                fired += value;
            }

            remove
            {
                Removes++;
                fired -= value;
            }
        }

        event Action ICounted.Changed
        {
            add => changed += value;
            remove => changed -= value;
        }

        public event Func<int, int> Mapped
        {
            add => mapped += value;
            remove => mapped -= value;
        }

        event Action<int> IChannel<int>.Sent
        {
            add => ints += value;
            remove => ints -= value;
        }

        public event Action<string> Sent;

        public void Raise(int value)
        {
            fired?.Invoke(value);
            changed?.Invoke();
            ints?.Invoke(value * 2);
            Sent?.Invoke("s" + value);
        }

        public int Map(int value) => mapped == null ? -1 : mapped(value);
    }

    public sealed class DerivedBus : FieldBus, ICounted
    {
        public event Action Changed;

        public void Change() => Changed?.Invoke();
    }

    // Interface events: field-like implementations (whose accessors the
    // itables call), accessor and explicit implementations, generic
    // interfaces implemented twice, inherited interfaces, default accessor
    // bodies, and subscription through type parameters, against the CLR.
    public static class InterfaceEvents
    {
        private static List<int> log = new List<int>();

        private static int Digest()
        {
            int digest = log.Count;
            foreach (int value in log)
            {
                digest = unchecked(digest * 31 + value);
            }

            log = new List<int>();
            return digest;
        }

        private static void Subscribe<T>(T bus, int x)
            where T : IBus
        {
            bus.Fired += value => log.Add(value * 3 + x);
        }

        public static int Field(int x)
        {
            IBus bus = new FieldBus();
            Action<int> first = value => log.Add(value);
            bus.Fired += first;
            bus.Fired += value => log.Add(-value);
            bus.Fired += first;
            bus.Raise(x);
            bus.Fired -= first;
            bus.Raise(x + 1);
            Subscribe(bus, x);
            Subscribe((FieldBus)bus, x);
            bus.Raise(2);
            return Digest();
        }

        public static int Accessors(int x)
        {
            var bus = new AccessorBus();
            IBoth both = bus;
            ICounted counted = bus;
            IChannel<int> ints = bus;
            IChannel<string> strings = bus;
            Action<int> handler = value => log.Add(value + 1000);
            both.Fired += handler;
            counted.Changed += () => log.Add(7);
            both.Mapped += value => value * x;
            ints.Sent += value => log.Add(value);
            strings.Sent += text => log.Add(text.Length);
            bus.Raise(x);
            both.Fired -= handler;
            bus.Raise(x - 1);
            log.Add(bus.Map(5));
            log.Add(bus.Adds * 10 + bus.Removes);
            return Digest();
        }

        public static int Inherited(int x)
        {
            var bus = new DerivedBus();
            ICounted counted = bus;
            IBus plain = bus;
            counted.Changed += () => log.Add(x);
            plain.Fired += value => log.Add(value * 100);
            bus.Change();
            bus.Raise(x);
            return Digest();
        }

        public static int Defaults(int x)
        {
            ITallied.Tally = 0;
            ITallied tallied = new AccessorBus();
            for (int i = 0; i < (x & 7); i++)
            {
                tallied.Noted += text => log.Add(text.Length);
            }

            tallied.Noted -= text => { };
            return ITallied.Tally * 100 + Digest();
        }

        public static int Missing(int x)
        {
            IBus bus = x == 0 ? null : new FieldBus();
            bus.Fired += value => log.Add(value);
            return 1;
        }
    }
}
