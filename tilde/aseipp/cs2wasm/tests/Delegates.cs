// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests;

public delegate int Combine(int left, int right);

public delegate void Notify(Tally counter);

public sealed class Tally
{
    public int Count;

    public void Add(int amount) => Count += amount;

    public int Get() => Count;
}

public class Greeter
{
    public int Base = 10;

    public virtual int Greet(int value) => Base + value;
}

public sealed class LoudGreeter : Greeter
{
    public override int Greet(int value) => base.Greet(value) * 2;

    public Func<int, int> Plain() => base.Greet;
}

public interface ITransform
{
    int Apply(int value);
}

public sealed class Negate : ITransform
{
    public int Apply(int value) => -value;
}

public sealed class Handlers
{
    public Func<int, int> Transform;
    public Action<Tally> OnTick;
}

// Closures over `this`, alone and with a parameter.
public sealed class Accumulator
{
    public int Total;
    public int Step = 3;

    public Func<int> Adder() => () => Total += Step;

    public Func<int, int> Scaled(int bias) => x => x * Step + bias;
}

// Captures in a constructor, in a field initializer, and through a local
// function that uses `this` and a parameter.
public sealed class Recorder
{
    public Func<int> Report;
    public int Value;
    public Func<int, Func<int>> Deferred = x => () => x + 1;

    public Recorder(int start)
    {
        int doubled = start * 2;
        Report = () => doubled + Value;
    }

    public int Compute(int n)
    {
        int Scale(int x) => x * Value + n;
        Func<int> later = () => Scale(2);
        Value = 10;
        return later();
    }
}

// A struct whose methods become delegates: each over its own box of the
// value, which the methods then read and write.
public struct Meter
{
    public int Reading;
    public long Scale;

    public Meter(int reading, long scale)
    {
        Reading = reading;
        Scale = scale;
    }

    public void Advance(int by) => Reading += by;

    public int Read() => Reading;

    public long Scaled(int factor) => Reading * Scale * factor;

    public Meter Doubled() => new Meter(Reading * 2, Scale);

    public readonly int Peek() => Reading + 1;

    public Func<int> Self() => Read;

    public T Tagged<T>(T tag) => tag;
}

public readonly struct Pair<T>(T first, T second)
{
    public T First() => first;

    public T Pick(bool second2) => second2 ? second : first;
}

// Receivers of method groups over System.Object's virtual members
// (Delegates.ObjectMethodGroups).
public class GroupShape
{
    public int Sides;

    public override string ToString() => "shape " + Sides;

    public override bool Equals(object other) => other is GroupShape shape && shape.Sides == Sides;

    public override int GetHashCode() => Sides * 17;
}

public sealed class GroupSquare : GroupShape
{
    public override string ToString() => "square";
}

public class GroupPlain
{
}

public struct GroupTagged
{
    public int Tag;

    public override string ToString() => "tag" + Tag;
}

public struct GroupBare
{
    public int A;
    public int B;
}

public record GroupNamed(string Name, int Age);

public interface IGroupMarked
{
}

public sealed class GroupMarked : IGroupMarked
{
    public override string ToString() => "marked";
}

public enum GroupHue
{
    Red,
    Green = 5,
}

public static class Delegates
{
    private static int Add(int left, int right) => left + right;

    private static int Twice(int value) => value * 2;

    private static int Apply(Func<int, int> function, int value) => function(value);

    public static int StaticMethodGroup(int value)
    {
        Func<int, int> twice = Twice;
        Combine add = Add;
        return add(twice(value), 1);
    }

    public static int Lambdas(int value)
    {
        Func<int, int> square = x => x * x;
        Combine subtract = (left, right) => left - right;
        Func<int> constant = () => 7;
        Func<int, int> block = delegate (int x)
        {
            int total = 0;
            for (int index = 0; index < x; index++)
                total += index;
            return total;
        };
        return subtract(square(value), constant()) * 1000 + block(value);
    }

    public static int InstanceMethodGroup(int value)
    {
        var counter = new Tally();
        Action<int> add = counter.Add;
        Func<int> get = counter.Get;
        add(value);
        add.Invoke(3);
        return get();
    }

    // Method groups over a struct's methods: C# boxes the value, so the
    // delegates share one copy and the original is left alone.
    public static long StructMethodGroup(int value)
    {
        var meter = new Meter(value, 3);
        Action<int> advance = meter.Advance;
        Func<int> read = meter.Read;
        advance(5);
        advance.Invoke(2);
        Func<int, long> scaled = meter.Scaled;
        Func<Meter> doubled = meter.Doubled;
        Func<int> peek = meter.Peek;
        Func<int> self = meter.Self();
        Func<string, string> tagged = meter.Tagged;
        meter.Advance(1000);
        var pair = new Pair<int>(value, value * 7);
        Func<bool, int> pick = pair.Pick;
        Func<int> first = pair.First;
        return (read() + meter.Reading) * 7 + scaled(2) + doubled().Reading * 11 + peek() * 13 + self() * 17
               + tagged("ab").Length + meter.ToString().Length * 19 + pick(true) * 23 + first() * 29;
    }

    public static int VirtualMethodGroup(int value)
    {
        Greeter greeter = new LoudGreeter();
        Func<int, int> greet = greeter.Greet;
        Func<int, int> plain = ((LoudGreeter)greeter).Plain();
        return greet(value) * 1000 + plain(value);
    }

    public static int InterfaceMethodGroup(int value)
    {
        ITransform transform = new Negate();
        return Apply(transform.Apply, value);
    }

    public static int NullInvoke(int which)
    {
        Func<int> function = which == 0 ? null : () => 5;
        return function();
    }

    public static int NullInstanceTarget(int which)
    {
        Tally counter = which == 0 ? null : new Tally();
        Func<int> get = counter.Get;
        return get();
    }

    public static int NullVirtualTarget(int which)
    {
        Greeter greeter = which == 0 ? null : new Greeter();
        Func<int, int> greet = greeter.Greet;
        return greet(1);
    }

    public static int ConditionalInvoke(int which)
    {
        var counter = new Tally();
        Action<Tally> tick = which == 0 ? null : c => c.Count += 5;
        tick?.Invoke(counter);
        Notify notify = which == 0 ? null : new Notify(c => c.Count *= 3);
        notify?.Invoke(counter);
        return counter.Count;
    }

    public static int NullChecks(int which)
    {
        Func<int, int> function = which == 0 ? null : Twice;
        int result = function == null ? 1 : 0;
        result += function != null ? 10 : 0;
        result += function is null ? 100 : 0;
        result += function is not null ? 1000 : 0;
        return result;
    }

    public static int Fields(int value)
    {
        var handlers = new Handlers { Transform = x => x + 1, OnTick = c => c.Add(2) };
        var counter = new Tally();
        handlers.OnTick(counter);
        handlers.OnTick(counter);
        return handlers.Transform(value) * 100 + counter.Count;
    }

    public static int Arrays(int value)
    {
        Func<int, int>[] steps = { x => x + 1, Twice, x => x - 3 };
        foreach (var step in steps)
            value = step(value);
        return value;
    }

    public static int HigherOrder(int value)
    {
        Func<Func<int, int>, int, int> apply = (function, argument) => function(argument);
        return apply(Twice, value) + apply(x => x + 100, value);
    }

    public static int Folding(int count) => Fold(count, (accumulator, index) => accumulator * 2 + index);

    // A closure shares the variable with the method that declares it.
    public static int ClosureMutation(int start)
    {
        int count = start;
        Action increment = () => count++;
        increment();
        increment();
        Func<int> read = () => count;
        count += 10;
        return read() * 1000 + count;
    }

    public static int ParameterCapture(int value)
    {
        Func<int> doubled = () => value * 2;
        value += 7;
        return doubled();
    }

    public static int AnonymousMethodCapture()
    {
        int count = 0;
        Action add = delegate { count += 2; };
        add();
        add();
        return count;
    }

    // A for loop's variable is one variable for every iteration; a foreach
    // variable and a loop body's local are fresh in each.
    public static int LoopCaptureFor()
    {
        var functions = new Func<int>[3];
        for (int index = 0; index < 3; index++)
            functions[index] = () => index;
        return functions[0]() * 100 + functions[1]() * 10 + functions[2]();
    }

    public static int LoopCaptureForeach()
    {
        int[] values = { 1, 2, 3 };
        var functions = new Func<int>[3];
        int slot = 0;
        foreach (int value in values)
            functions[slot++] = () => value;
        return functions[0]() * 100 + functions[1]() * 10 + functions[2]();
    }

    public static int LoopCaptureBodyLocal()
    {
        var functions = new Func<int>[3];
        for (int index = 0; index < 3; index++)
        {
            int copy = index * 2;
            functions[index] = () => copy;
        }

        return functions[0]() * 100 + functions[1]() * 10 + functions[2]();
    }

    public static int NestedClosures(int seed)
    {
        int outer = seed;
        Func<int, Func<int>> make = step =>
        {
            int inner = step * 10;
            return () => outer + inner + step;
        };
        var first = make(1);
        outer += 100;
        var second = make(2);
        return first() * 1000 + second();
    }

    public static int CaptureThis()
    {
        var accumulator = new Accumulator();
        var add = accumulator.Adder();
        add();
        add();
        accumulator.Step = 10;
        add();
        var scaled = accumulator.Scaled(5);
        return accumulator.Total * 1000 + scaled(2);
    }

    public static int PatternCapture(int kind)
    {
        Greeter greeter = kind == 0 ? new Greeter() : new LoudGreeter();
        Func<int> function = greeter is LoudGreeter loud ? () => loud.Greet(1) : () => greeter.Base;
        return function();
    }

    public static int SwitchCapture(int value)
    {
        Func<int> function;
        switch (value)
        {
            case > 10:
                int big = value * 2;
                function = () => big;
                break;
            default:
                function = () => -value;
                break;
        }

        return function();
    }

    public static int LocalFunctions(int n)
    {
        int calls = 0;
        int Fibonacci(int k)
        {
            calls++;
            return k < 2 ? k : Fibonacci(k - 1) + Fibonacci(k - 2);
        }

        static int Square(int x) => x * x;
        int Cube(int x) => x * x * x;
        return Fibonacci(n) * 1000 + calls + Square(3) + Cube(2);
    }

    public static int LocalFunctionDelegates(int value)
    {
        int offset = value;
        int Add(int x) => x + offset;
        static int Negate(int x) => -x;
        Func<int, int> add = Add;
        Func<int, int> negate = Negate;
        offset = 100;
        return add(1) * 1000 + negate(value);
    }

    public static int ConstructorCapture(int start)
    {
        var recorder = new Recorder(start);
        recorder.Value = 5;
        return recorder.Report() * 100 + recorder.Deferred(start)();
    }

    public static int LocalFunctionThis(int n) => new Recorder(0).Compute(n);

    public static int ArmCapture(int value)
    {
        Greeter greeter = value == 0 ? new Greeter() : new LoudGreeter();
        Func<int> function = greeter switch
        {
            LoudGreeter loud => () => loud.Greet(value),
            _ => () => greeter.Base,
        };
        return function();
    }

    // Method groups over System.Object's virtual members (ldvirtftn of
    // object's ToString, Equals and GetHashCode, the value boxed first):
    // each runs the target's override, as a virtual call would.
    private static int Text(Func<string> text) => text().Length * 31 + text()[0];

    private static string Of<T>(T value)
    {
        Func<string> text = value.ToString;
        Func<object, bool> equals = value.Equals;
        Func<int> hash = value.GetHashCode;
        return text() + (equals(value) ? "=" : "!") + (hash() == value.GetHashCode() ? "#" : "?");
    }

    public static int ObjectMethodGroups(int which)
    {
        GroupShape shape = which % 2 == 0 ? new GroupShape { Sides = which } : new GroupSquare { Sides = which };
        var tagged = new GroupTagged { Tag = which };
        Func<string> taggedText = tagged.ToString;
        tagged.Tag = 99;
        var named = new GroupNamed("n" + which, which);
        IGroupMarked marked = new GroupMarked();
        object boxed = which;
        GroupHue hue = which % 2 == 0 ? GroupHue.Red : GroupHue.Green;
        try
        {
            switch (which % 8)
            {
                case 0:
                {
                    Func<string> text = shape.ToString;
                    Func<object, bool> equals = shape.Equals;
                    Func<int> hash = shape.GetHashCode;
                    return Text(text) + (equals(new GroupShape { Sides = which }) ? 1000 : 0) + hash();
                }
                case 1:
                {
                    var square = (GroupSquare)shape;
                    Func<string> text = square.ToString;
                    Func<GroupShape, bool> equals = square.Equals;
                    return Text(text) + (equals(new GroupSquare { Sides = which }) ? 1000 : 0);
                }
                case 2:
                {
                    Func<object, bool> equals = tagged.Equals;
                    return Text(taggedText) + (equals(tagged) ? 1000 : 0) + (equals(new GroupTagged { Tag = 99 }) ? 2000 : 0);
                }
                case 3:
                {
                    var bare = new GroupBare { A = which, B = 2 };
                    Func<object, bool> equals = bare.Equals;
                    Func<int> hash = bare.GetHashCode;
                    return (equals(new GroupBare { A = which, B = 2 }) ? 1 : 0) + (equals(bare) ? 10 : 0) + (hash() == bare.GetHashCode() ? 100 : 0);
                }
                case 4:
                {
                    Func<string> text = named.ToString;
                    Func<object, bool> equals = named.Equals;
                    Func<int> hash = named.GetHashCode;
                    return Text(text) + (equals(new GroupNamed("n" + which, which)) ? 1000 : 0) + (hash() == named.GetHashCode() ? 10000 : 0);
                }
                case 5:
                {
                    Func<string> text = marked.ToString;
                    Func<object, bool> equals = marked.Equals;
                    Func<string> integer = boxed.ToString;
                    Func<string> color = hue.ToString;
                    Func<int, bool> same = which.Equals;
                    return Text(text) + (equals(marked) ? 1000 : 0) + Text(integer) * 3 + Text(color) * 7 + (same(which) ? 5 : 0);
                }
                case 6:
                {
                    string all = Of(which) + Of("s" + which) + Of(tagged) + Of(shape) + Of(named) + Of(hue) + Of(2.5) + Of(new GroupPlain());
                    return all.Length * 31 + all[all.Length / 2];
                }
                default:
                {
                    // Two groups of one method over one target are equal, as
                    // the CLR's; over another target they are not; a null
                    // target throws when the group is made.
                    Func<string> first = shape.ToString;
                    Func<string> again = shape.ToString;
                    Func<string> other = new GroupShape().ToString;
                    int result = (first == again ? 1 : 0) + (first.Equals(again) ? 10 : 0) + (first == other ? 100 : 0);
                    GroupShape nothing = which > 100 ? shape : null;
                    Func<string> broken = nothing.ToString;
                    return result + broken().Length;
                }
            }
        }
        catch (NullReferenceException)
        {
            return -1;
        }
    }

    private static int Fold(int count, Combine step)
    {
        int accumulator = 0;
        for (int index = 0; index < count; index++)
            accumulator = step(accumulator, index);
        return accumulator;
    }
}
