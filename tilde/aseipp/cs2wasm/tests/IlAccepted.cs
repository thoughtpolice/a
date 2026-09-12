// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What the retired IOperation frontend rejected and the compiler compiles
// (tests/rejections.mjs's acceptedCases): each case's code, and what it can go on to do,
// against the CLR.

using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Numerics;
using System.Runtime.CompilerServices;

namespace Tests.IlAccepted
{
    public class Base
    {
        public virtual int Id => 1;
    }

    public sealed class Derived : Base
    {
        public override int Id => 2;
    }

    public sealed class Node
    {
        public Node Next;
        public int Value;
    }

    public struct Meters
    {
        public int Value;

        public static implicit operator Meters(int value) => new Meters { Value = value };

        public static int operator +(Meters left, int right) => left.Value + right;

        public int Add(int more) => Value += more;
    }

    public struct Counter(int value)
    {
        public int Get() => value;

        public int Bump() => ++value;
    }

    public sealed class Located
    {
        public readonly int Line;

        public Located([CallerLineNumber] int line = 0) => Line = line;
    }

    [System.Diagnostics.DebuggerDisplay("marked")]
    public enum Marked
    {
        A = 3,
    }

    // Attribute classes of the program's own, as a source generator's
    // markers are: metadata, never values.
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Method, AllowMultiple = true)]
    public sealed class TagAttribute : Attribute
    {
        public TagAttribute(string name, params Type[] types)
        {
            Name = name;
        }

        public string Name { get; }

        public int Order { get; set; }
    }

    public sealed class TagAttribute<T> : Attribute
    {
    }

    [Tag("tagged", typeof(Node), Order = 2)]
    [Tag<int>]
    public struct Tagged
    {
        public int Value;

        [Tag("method")]
        public int Twice() => Value * 2;
    }

    public class Publisher
    {
        public virtual event Action Changed;

        public void Raise() => Changed?.Invoke();
    }

    public sealed class LoudPublisher : Publisher
    {
        public int Subscribed;

        public override event Action Changed
        {
            add
            {
                Subscribed++;
                base.Changed += value;
            }
            remove
            {
                Subscribed--;
                base.Changed -= value;
            }
        }
    }

    public sealed class Oops : Exception
    {
        public Oops Inner;
    }

    public sealed class Point : IEquatable<Point>
    {
        public int X;

        public bool Equals(Point other) => other is not null && other.X == X;

        public override bool Equals(object obj) => Equals(obj as Point);

        public override int GetHashCode() => X;
    }

    public interface ISignal
    {
        static abstract event Action Fired;

        static abstract void Fire();
    }

    public sealed class Signal : ISignal
    {
        public static event Action Fired;

        public static void Fire() => Fired?.Invoke();
    }

    // (base.ToString() of object is rejected: the runtime type's name is
    // not kept.)
    public sealed class Named
    {
        public int Id;

        public override bool Equals(object obj) => base.Equals(obj) || obj is Named { Id: 0 };

        public override int GetHashCode() => base.GetHashCode() == base.GetHashCode() ? 1 : 0;
    }

    public struct Money : IFormattable
    {
        public int Cents;

        public string ToString(string format, IFormatProvider provider) => (format ?? "none") + ":" + Cents;
    }

    public sealed record Holder(object[] Items);

    public union Either(int, string);

    public record struct Wrapped(Either X);

    public union Anything(object, string);

    public sealed class A
    {
    }

    public sealed class B
    {
    }

    public union AB(A, B)
    {
        public int Count() => 1;
    }

    public union Callback(Action, string);

    // (rejections.mjs's variant_delegate declares it; ArrayCovariance
    // converts arrays of it.)
    public delegate T Maker<out T>();

    [System.Diagnostics.DebuggerDisplay("shared")]
    public sealed class Shared
    {
        public volatile int X;
    }

    // tests/rejections.mjs's variant_interface, and what variance lets code
    // do with it.
    public interface IBad<out T>
    {
        T F();
    }

    public interface ISink<in T>
    {
        int Put(T value);
    }

    public sealed class DerivedSource : IBad<Derived>, ISink<Base>
    {
        public Derived F() => new Derived();

        public int Put(Base value) => value.Id * 10;
    }

    public static class IlAccepted
    {
        private static int Digest(string text)
        {
            int digest = 17;
            foreach (char c in text)
            {
                digest = unchecked(digest * 31 + c);
            }

            return unchecked(digest * 31 + text.Length);
        }

        public static int Boxing(int x)
        {
            // (Only as far as the case goes: ValueType's members are not
            // implemented.)
            ValueType boxed = x;
            object same = boxed;
            return (boxed == null ? 1 : 0) + (same is int ? 4 : 0) + (int)same * 8;
        }

        private static int Line([CallerLineNumber] int line = 0) => line;

        private static string Member([CallerMemberName] string member = "") => member;

        public static int CallerInfo() => Line() * 1000 + Digest(Member()) % 1000 + new Located().Line;

        public static int CaptureLoopCondition(int count)
        {
            Node node = null;
            for (int index = count; index > 0; index--)
            {
                node = new Node { Next = node, Value = index };
            }

            var captured = new List<Func<int>>();
            while (node is Node current)
            {
                captured.Add(() => current.Value);
                node = node.Next;
            }

            int digest = 0;
            foreach (var read in captured)
            {
                digest = digest * 10 + read();
            }

            return digest;
        }

        [System.Diagnostics.DebuggerStepThrough]
        private static int Measure([NotNull] string value) => (int)Marked.A + value.Length;

        [System.Diagnostics.DebuggerStepThrough]
        public static int Attributes(int x) => Measure(new string('a', x));

        public static int SourceAttributes(int x) => new Tagged { Value = x }.Twice();

        public static int CompoundUserConversion(int x)
        {
            Meters distance = default;
            distance += x;
            distance += 2 * x;
            return distance.Value;
        }

        public static int PrimaryConstructor(int start)
        {
            var counter = new Counter(start);
            var copy = counter;
            counter.Bump();
            counter.Bump();
            return counter.Get() * 100 + copy.Get();
        }

        // (Only as far as the case goes: a Delegate is not a type here.)
        public static int DelegateCombine(int which)
        {
            Action a = () => { };
            Action none = null;
            return which switch
            {
                0 => Delegate.Combine(a, a) != null ? 1 : 0,
                1 => Delegate.Combine(a, none) != null ? 1 : 0,
                2 => Delegate.Combine(none, none) != null ? 1 : 0,
                3 => Delegate.Remove(a, a) != null ? 1 : 0,
                _ => Delegate.Remove(Delegate.Combine(a, a), a) != null ? 1 : 0,
            };
        }

        public static int VirtualEvent(int which)
        {
            Publisher publisher = which == 0 ? new Publisher() : new LoudPublisher();
            int calls = 0;
            Action handler = () => calls++;
            publisher.Changed += handler;
            publisher.Changed += handler;
            publisher.Raise();
            publisher.Changed -= handler;
            publisher.Raise();
            return calls * 10 + (publisher is LoudPublisher loud ? loud.Subscribed : 0);
        }

        public static int Filters(int x)
        {
            int result = 0;
            try
            {
                result += 10 / x;
            }
            catch (DivideByZeroException e) when ((e = null) == null)
            {
                result += e == null ? 1 : 2;
            }

            try
            {
                result += 100 / (x - 1);
            }
            catch (DivideByZeroException) when (((Func<int>)(() => x))() == 1)
            {
                result += 1000;
            }

            try
            {
                throw new Oops { Inner = x > 5 ? new Oops() : null };
            }
            catch (Oops e) when (e.Inner is Oops inner)
            {
                result += inner.Inner == null ? 10000 : 20000;
            }
            catch (Oops)
            {
                result += 30000;
            }

            return result;
        }

        public static int CollectionInterface(int count)
        {
            ICollection<int> values = new List<int>();
            for (int index = 0; index < count; index++)
            {
                values.Add(index * 3);
            }

            values.Remove(3);
            var copy = new int[values.Count + 1];
            values.CopyTo(copy, 1);
            int digest = values.Count * 1000 + (values.Contains(6) ? 100 : 0) + (values.IsReadOnly ? 50 : 0);
            foreach (int value in copy)
            {
                digest = digest * 7 + value;
            }

            return digest;
        }

        public static int Equatable(int x)
        {
            var points = new List<Point> { new Point { X = 1 }, new Point { X = x } };
            var set = new HashSet<Point>(points);
            return points.IndexOf(new Point { X = x }) * 100 + set.Count * 10
                   + (EqualityComparer<Point>.Default.Equals(new Point { X = 2 }, new Point { X = 2 }) ? 1 : 0);
        }

        public static int GenericLocalFunctions(int x)
        {
            IEnumerable<T> Twice<T>(T value)
            {
                yield return value;
                yield return value;
            }

            int calls = 0;
            T Same<T>(T value)
            {
                calls++;
                return value;
            }

            int sum = 0;
            foreach (int n in Twice(x))
            {
                sum += n;
            }

            foreach (string s in Twice("ab"))
            {
                sum += s.Length;
            }

            return sum * 100 + Same(x) + Same(1) + calls;
        }

        private static T Zero<T>()
            where T : INumberBase<T> => T.Zero;

        private static int Compare<T>(T left, T right)
            where T : IComparable<T> => left.CompareTo(right);

        public static int GenericConstraints(int x) => Zero<int>() + x + Compare(x, 2) * 10 + (int)Zero<double>();

        private static T Sum<T>(T a, T b)
            where T : INumber<T> => a + b;

        public static int GenericMathDecimal(int x) => (int)Sum(1.5m, x) + (int)(Zero<decimal>() + Sum(x, 0.25m) * 4);

        public static int StructMethodGroup(int x)
        {
            var meters = new Meters { Value = x };
            Func<int, int> add = meters.Add;
            meters.Value = 100;
            return add(3) * 1000 + meters.Value;
        }

        private static void FireAll<T>()
            where T : ISignal => T.Fire();

        public static int StaticInterfaceEvent(int count)
        {
            int calls = 0;
            Action handler = () => calls++;
            Signal.Fired += handler;
            for (int index = 0; index < count; index++)
            {
                FireAll<Signal>();
            }

            Signal.Fired -= handler;
            FireAll<Signal>();
            return calls;
        }

        // (A multidimensional array's Type is rejected.)
        public static int TypeNames(int which) => which switch
        {
            0 => ObjectBase(),
            1 => Digest("a" + new object[1]),
            2 => Digest(new Holder(null).ToString()),
            3 => Digest(new Holder(new object[] { 1 }).ToString()),
            4 => Digest(new Wrapped(1).ToString()),
            5 => Digest(new Wrapped("x").ToString()),
            _ => Digest(((AB)new A()).ToString()),
        };

        private static int ObjectBase()
        {
            var named = new Named { Id = 1 };
            return (named.Equals(named) ? 1 : 0) + (named.Equals(new Named()) ? 2 : 0) + (named.Equals(new Named { Id = 1 }) ? 4 : 0)
                   + named.GetHashCode() * 8;
        }

        // (Interpolating an IFormattable of the module's own is rejected.)
        public static int Formatting(int x)
        {
            var money = new Money { Cents = x };
            return Digest(money.ToString("F2", null)) + Digest(new DateTime(2020, 1, 2).ToString("yyyy-MM-dd"))
                   + DateTime.Now.ToString("yyyy").Length;
        }

        // (Only the case: C# folds the cast of a null constant; testing an
        // object for a delegate type is rejected.)
        public static int Casts()
        {
            object value = null;
            return (Action)value == null ? 1 : 2;
        }

        // (Only as far as the case goes: the non-generic IComparable is
        // not a type here.)
        public static int StructBoxing(int x)
        {
            IComparable comparable = x;
            return comparable == null ? 1 : 0;
        }

        public static int StructBoxingUnbox(int x)
        {
            IComparable comparable = x;
            object same = comparable;
            return (int)same;
        }

        [ThreadStatic]
        private static int counter;

        public static int ThreadStatic(int x)
        {
            checked
            {
                counter += x;
            }

            return counter;
        }

        public static int Unions(int which)
        {
            switch (which)
            {
                case 0:
                    return ((Anything)"x") is string ? 1 : 0;
                case 1:
                    return ((Anything)new object()) is string ? 1 : 2;
                case 2:
                    return ((AB)new B()).Count();
                default:
                    // (Testing a union's value for a delegate type is
                    // rejected.)
                    return ((Callback)"x") is string ? 1 : 0;
            }
        }

        // Variant interfaces: an object of a class implementing one
        // instantiation as another it converts to, arrays as collections
        // of their elements' base types.
        public static int Variance(int which)
        {
            object source = new DerivedSource();
            Derived[] array = [new Derived(), new Derived()];
            switch (which)
            {
                case 0:
                    IBad<Base> bad = (IBad<Base>)source;
                    ISink<Derived> sink = (ISink<Derived>)source;
                    return bad.F().Id + sink.Put(new Derived());
                case 1:
                    return (source is IBad<Base> ? 1 : 0) + (source is IBad<object> ? 10 : 0) + (source is ISink<Derived> ? 100 : 0)
                           + (source is IBad<string> ? 1000 : 0) + (source is ISink<object> ? 10000 : 0);
                case 2:
                    IEnumerable<Base> sequence = new List<Derived>(array);
                    int sum = 0;
                    foreach (var item in sequence)
                    {
                        sum += item.Id;
                    }

                    return sum;
                case 3:
                    IReadOnlyList<Base> list = array;
                    return list[1].Id + list.Count * 10 + (((object)array) is IEnumerable<Base> ? 100 : 0);
                default:
                    IList<Base> writable = array;
                    try
                    {
                        writable[0] = new Base();
                        return 0;
                    }
                    catch (ArrayTypeMismatchException)
                    {
                        return writable.IndexOf(array[1]) + 5;
                    }
            }
        }

        // tests/rejections.mjs's delegate_variance: delegates converted by
        // variance, invoked, combined, compared with null.
        public static int DelegateVariance(int which)
        {
            Func<Derived> make = () => new Derived();
            Action<Base> record = value => recorded += value.Id;
            recorded = 0;
            switch (which)
            {
                case 0:
                    Func<Base> converted = make;
                    return converted().Id + (converted is null ? 10 : 0);
                case 1:
                    Action<Derived> narrowed = record;
                    narrowed(new Derived());
                    try
                    {
                        // Of two types: the CLR does not combine them.
                        narrowed += value => recorded += 100;
                    }
                    catch (ArgumentException error)
                    {
                        return recorded * 1000 + error.Message.Length;
                    }

                    narrowed(new Derived());
                    return recorded;
                case 2:
                    Func<Derived> none = null;
                    Func<Base> converted2 = none;
                    return converted2 == null ? 7 : 0;
                default:
                    var list = new List<Derived> { new Derived(), new Derived() };
                    Predicate<Base> isDerived = value => value.Id == 2;
                    return list.FindAll(isDerived).Count + list.ConvertAll<Base>(value => value).Count * 10;
            }
        }

        private static int recorded;

        // tests/rejections.mjs's array_covariance: arrays of references
        // converted by covariance, read, written (a store of the wrong type
        // throws, of delegates too), tested, copied, sorted and enumerated.
        public static int ArrayCovariance(int which)
        {
            Base[] values = new Derived[] { new Derived(), new Derived() };
            object[] objects = new string[] { "b", "a", "c" };
            try
            {
                switch (which)
                {
                    case 0:
                        return values.Length + values[1].Id * 10 + (values is Derived[] ? 100 : 0) + (objects is string[] ? 1000 : 0);
                    case 1:
                        values[0] = new Base();
                        return 0;
                    case 2:
                        objects[1] = "z";
                        objects[2] = null;
                        return ((string)objects[1]).Length + (objects[2] is null ? 10 : 0);
                    case 3:
                        objects[0] = 1;
                        return 0;
                    case 4:
                        return string.Format("{0}{1}{2}", objects).Length + string.Join("+", objects).Length * 10;
                    case 5:
                        var copy = new object[3];
                        Array.Copy(objects, copy, 3);
                        System.Array.Sort(objects, (x, y) => string.CompareOrdinal((string)x, (string)y));
                        return ((string)copy[0])[0] * 100 + ((string)objects[0])[0];
                    case 6:
                        int sum = 0;
                        foreach (var value in values)
                        {
                            sum += value.Id;
                        }

                        IEnumerable<Base> sequence = values;
                        foreach (var value in sequence)
                        {
                            sum += value.Id * 10;
                        }

                        return sum;
                    case 7:
                        // Arrays of delegates: a delegate's type is its
                        // own, whatever its signature or variance.
                        Maker<object>[] makers = new Maker<string>[2];
                        Maker<string> named = () => "abc";
                        makers[0] = named;
                        object[] callbacks = new Func<int>[1];
                        callbacks[0] = (Func<int>)(() => 4);
                        int caught = 0;
                        try
                        {
                            callbacks[0] = (Maker<int>)(() => 5);
                        }
                        catch (ArrayTypeMismatchException)
                        {
                            caught += 10;
                        }

                        try
                        {
                            makers[1] = () => "d";
                        }
                        catch (ArrayTypeMismatchException)
                        {
                            caught += 100;
                        }

                        return ((string)makers[0]()).Length + caught + (callbacks[0] is null ? 1000 : 0);
                    default:
                        object boxed = values;
                        var back = (Base[])boxed;
                        IList<Base> list = back;
                        list[0] = new Derived();
                        return back.Length + (boxed is object[] ? 10 : 0) + (boxed is Base[] ? 100 : 0) + (boxed.GetType() == typeof(Derived[]) ? 1000 : 0);
                }
            }
            catch (ArrayTypeMismatchException error)
            {
                return -error.Message.Length;
            }
        }

        private static async System.Threading.Tasks.Task<int> Completed(int x) => x + 1;

        // Async methods and lambdas: C#'s state machines over the CoreLib's
        // task library (tests/Async.cs has the rest).
        public static int AsyncMethods(int x)
        {
            Func<System.Threading.Tasks.Task> run = async () => { };
            Func<int, System.Threading.Tasks.Task<int>> twice = async value => await Completed(value) * 2;
            return Completed(x).Result + (run().IsCompleted ? 1000 : 0) + twice(x).Result * 10;
        }

        public static int Volatile(int x)
        {
            var shared = new Shared();
            shared.X = x;
            shared.X += 2;
            return shared.X;
        }

        // float_remainder: Math.IEEERemainder, and MathF's.
        public static double IeeeRemainder(double x, double y) => System.Math.IEEERemainder(x, y) + System.MathF.IEEERemainder((float)x, (float)y);

        // math_pow: Math.FusedMultiplyAdd, rounded once.
        public static double FusedMultiplyAdd(double x, double y, double z) => System.Math.FusedMultiplyAdd(x, y, z);

        public static float FusedMultiplyAddSingle(float x, float y, float z) => System.MathF.FusedMultiplyAdd(x, y, z);
    }
}
