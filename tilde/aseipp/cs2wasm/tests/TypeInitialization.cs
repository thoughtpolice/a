// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.TypeInitialization;

// Static initialization as the CLR does it. A class with a static
// constructor is initialized at the first access to a static field, call
// of a static method or run of an instance constructor; what escapes the
// initializer becomes a TypeInitializationException, thrown there and at
// every later use. Each test uses classes of its own and runs once, in the
// order tests/differential.mjs lists them, since initialization happens
// once per module (and process).
public static class Trace
{
    public static long Log;

    public static void Note(int digit) => Log = Log * 10 + digit;

    public static int Step(int digit)
    {
        Note(digit);
        return digit;
    }

    public static long Take()
    {
        long log = Log;
        Log = 0;
        return log;
    }
}

// A static field initializer that throws, without a static constructor.
public static class Broken
{
    public static readonly int Value = Compute();

    private static int Compute() => throw new InvalidOperationException();

    public static int Read() => Value;

    public static int Catch()
    {
        try
        {
            return Value;
        }
        catch (TypeInitializationException)
        {
            return -1;
        }
    }
}

// Field initializers in order, then the static constructor, triggered by
// a static method call after its arguments.
public static class Ordered
{
    public static int First = Trace.Step(2) * 10;
    public static int Second;

    static Ordered()
    {
        Trace.Note(4);
        Second = First + 1;
    }

    public static int Third = Trace.Step(3);

    public static int Get(int argument)
    {
        Trace.Note(5);
        return Second * 100 + Third + argument;
    }
}

public static class Stored
{
    public static int Value;

    static Stored() => Trace.Note(2);
}

public static class Loaded
{
    public static int Value = 40;

    static Loaded() => Trace.Note(3);
}

public class Base
{
    static Base() => Trace.Note(1);

    public Base() => Trace.Note(2);

    public static int Shared;
}

public class Derived : Base
{
    private readonly int step = Trace.Step(5);

    static Derived() => Trace.Note(3);

    public Derived() => Trace.Note(4);

    public static int Own;

    public int Field => step;
}

public class Leaf : Base
{
    static Leaf() => Trace.Note(6);

    public static int Own = 1;
}

public static class CycleA
{
    public static int X = CycleB.Y + 1;

    static CycleA() => Trace.Note(1);
}

public static class CycleB
{
    public static int Y = CycleA.X + 10;

    static CycleB() => Trace.Note(2);
}

public static class Failing
{
    public static int Value = 1;

    static Failing()
    {
        Trace.Note(5);
        throw new InvalidOperationException();
    }

    public static int Get() => Value;
}

public static class FailingLater
{
    public static int Value = Trace.Step(1);

    static FailingLater()
    {
        Trace.Note(2);
        if (Value == 1)
        {
            throw new ArgumentException();
        }
    }
}

public static class Outer
{
    public static int Value = Inner.Value + 1;

    static Outer() => Trace.Note(3);
}

public static class Inner
{
    public static int Value;

    static Inner()
    {
        Trace.Note(4);
        throw new NotSupportedException();
    }
}

public struct Unit
{
    public int Value;

    public static int Made;

    static Unit() => Trace.Note(7);

    public Unit(int value)
    {
        Value = value;
        Made++;
    }

    public readonly int Twice() => Value * 2;
}

public static class PerType<T>
{
    public static int Id = Initialization.Next();

    static PerType() => Trace.Note(8);

    public static int Get() => Id;
}

public sealed class Instance
{
    public static int Count;

    static Instance() => Trace.Note(9);

    public int Read() => Count;
}

public static class Initialization
{
    private static int counter;

    public static int Next() => ++counter;

    public static long StaticMethod()
    {
        Trace.Log = 0;
        Trace.Note(1);
        int value = Ordered.Get(Trace.Step(6));
        return Trace.Take() * 10000 + value;
    }

    // A store evaluates its value first; a load or compound assignment
    // reads first.
    public static long FieldAccess()
    {
        Trace.Log = 0;
        Stored.Value = Trace.Step(1);
        Loaded.Value += Trace.Step(4);
        return Trace.Take() * 1000 + Stored.Value * 100 + Loaded.Value;
    }

    // Constructing a derived class initializes it, then its base when the
    // base constructor runs; a derived class's static access does not
    // initialize its base.
    public static long Construction()
    {
        Trace.Log = 0;
        Leaf.Own++;
        Trace.Note(0);
        var derived = new Derived();
        Derived.Own++;
        Base.Shared++;
        return Trace.Take() * 10 + derived.Field;
    }

    // A class used while it is being initialized is seen partly initialized.
    public static long Cycles()
    {
        Trace.Log = 0;
        int x = CycleA.X;
        return Trace.Take() * 10000 + x * 100 + CycleB.Y;
    }

    // The TypeInitializationException is thrown at every use, the same
    // object each time; the initializer does not run again.
    public static long Failures()
    {
        Trace.Log = 0;
        TypeInitializationException first = null;
        int result = 0;
        try
        {
            Failing.Get();
        }
        catch (TypeInitializationException error)
        {
            first = error;
            result += 1;
        }

        try
        {
            result += Failing.Value;
        }
        catch (TypeInitializationException error)
        {
            result += error == first ? 10 : 20;
        }

        return Trace.Take() * 100 + result;
    }

    public static long FailuresLater()
    {
        Trace.Log = 0;
        try
        {
            return Failing.Get();
        }
        catch (TypeInitializationException)
        {
            return Trace.Take() * 10 + 7;
        }
    }

    public static int FailureEscapes() => Failing.Get();

    // A failing initializer the next entry sees failed too.
    public static long FailingFirstUse()
    {
        Trace.Log = 0;
        try
        {
            FailingLater.Value++;
        }
        catch (TypeInitializationException)
        {
            Trace.Note(3);
        }

        return Trace.Take();
    }

    public static long FailingAgain()
    {
        Trace.Log = 0;
        try
        {
            return FailingLater.Value;
        }
        catch (TypeInitializationException)
        {
            return Trace.Take() * 10 + 9;
        }
    }

    // An initializer that uses a class whose initializer fails fails too.
    public static long Nested()
    {
        Trace.Log = 0;
        try
        {
            return Outer.Value;
        }
        catch (TypeInitializationException)
        {
            Trace.Note(5);
        }

        try
        {
            return Inner.Value;
        }
        catch (TypeInitializationException)
        {
            Trace.Note(6);
        }

        return Trace.Take();
    }

    // A struct's static constructor runs at a static member or an
    // explicit constructor, not for a default value or an instance method.
    public static long Structs()
    {
        Trace.Log = 0;
        Unit empty = default;
        int twice = empty.Twice();
        Trace.Note(1);
        var unit = new Unit(3);
        Trace.Note(2);
        return Trace.Take() * 1000 + twice * 100 + unit.Twice() * 10 + Unit.Made;
    }

    public static long Generics()
    {
        Trace.Log = 0;
        int ints = PerType<int>.Get();
        int longs = PerType<long>.Get();
        return Trace.Take() * 1000 + ints * 100 + longs * 10 + PerType<int>.Get();
    }

    public static long InstanceConstruction()
    {
        Trace.Log = 0;
        Trace.Note(1);
        var instance = new Instance();
        Trace.Note(2);
        return Trace.Take() * 10 + instance.Read();
    }
}
