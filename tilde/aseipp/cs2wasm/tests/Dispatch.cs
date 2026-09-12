// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Dispatch;

// Covariant returns.
public abstract class Animal
{
    public int Legs;

    public abstract Animal Parent();

    public virtual Animal Self => this;

    public virtual string Kind() => "animal";
}

public class Dog : Animal
{
    public int Barks = 2;

    public override Dog Parent() => new Dog { Legs = 4, Barks = Barks + 1 };

    public override Dog Self => this;

    public override string Kind() => "dog";
}

public sealed class Puppy : Dog
{
    public override Puppy Parent() => new Puppy { Legs = 4, Barks = 100 };

    public override Puppy Self => this;
}

// Default interface members, statics and explicit overrides in interfaces.
public interface IShape
{
    static int Created;

    static IShape()
    {
        Created = 100;
    }

    int Sides { get; }

    string Name => "shape with " + Sides;

    int Perimeter(int side) => Sides * side + Bonus();

    private int Bonus() => Sides > 3 ? 1 : 0;

    static int Twice(int value) => value * 2;

    static int Counter { get; set; }
}

public interface IPolygon : IShape
{
    string IShape.Name => "polygon " + Sides;
}

public sealed class Triangle : IShape
{
    public int Sides => 3;
}

public sealed class Square : IPolygon
{
    public int Sides => 4;

    public int Perimeter(int side) => side * 4 + 10;
}

public struct Hexagon : IShape
{
    public int Scale;

    public int Sides => 6 * Scale;
}

public interface IGeneric<T>
{
    T Value { get; }

    T Twice(Func<T, T, T> combine) => combine(Value, Value);
}

public sealed class Box<T> : IGeneric<T>
{
    public T Value { get; set; }
}

// Static abstract and virtual members.
public interface IMonoid<T>
    where T : IMonoid<T>
{
    static abstract T Zero { get; }

    static abstract T operator +(T left, T right);

    static virtual int Rank => 1;

    static abstract T Parse(int value);

    static abstract explicit operator int(T value);
}

public struct Money : IMonoid<Money>
{
    public int Cents;

    public static Money Zero => new Money { Cents = 0 };

    public static Money operator +(Money left, Money right) => new Money { Cents = left.Cents + right.Cents };

    public static Money Parse(int value) => new Money { Cents = value * 100 };

    public static explicit operator int(Money value) => value.Cents;
}

public sealed class Tally : IMonoid<Tally>
{
    public int Count;

    public static Tally Zero => new Tally();

    public static Tally operator +(Tally left, Tally right) => new Tally { Count = left.Count + right.Count + 1 };

    public static int Rank => 5;

    public static Tally Parse(int value) => new Tally { Count = value };

    public static explicit operator int(Tally value) => value.Count;
}

// Generic virtual methods.
public class Converter
{
    public virtual string Convert<T>(T value) => "base:" + value;

    public virtual int Count<T>(T[] values) => values.Length;
}

public class Loud : Converter
{
    public override string Convert<T>(T value) => "loud:" + base.Convert(value);
}

public sealed class Quiet : Loud
{
    public override string Convert<T>(T value) => "quiet";

    public override int Count<T>(T[] values) => values.Length * 10;
}

public abstract class Maker
{
    public abstract T Make<T>()
        where T : new();
}

public sealed class Factory : Maker
{
    public override T Make<T>() => new T();
}

public class Holder<U>
{
    public virtual string Pair<T>(U first, T second) => first + "," + second;
}

public sealed class Swapped<U> : Holder<U>
{
    public override string Pair<T>(U first, T second) => second + ";" + first;
}

public interface IPicker
{
    T Pick<T>(T left, T right);
}

public class First : IPicker
{
    public virtual T Pick<T>(T left, T right) => left;
}

public sealed class Second : First
{
    public override T Pick<T>(T left, T right) => right;
}

// A struct without fields, boxed as the interface.
public struct Neutral : IPicker
{
    public T Pick<T>(T left, T right) => left;
}

// User-defined true, false, & and |, which && and || use.
public struct Fuzzy
{
    public int Level;

    public static bool operator true(Fuzzy value) => value.Level > 50;

    public static bool operator false(Fuzzy value) => value.Level < 20;

    public static Fuzzy operator &(Fuzzy left, Fuzzy right) => new Fuzzy { Level = Math.Min(left.Level, right.Level) + 1 };

    public static Fuzzy operator |(Fuzzy left, Fuzzy right) => new Fuzzy { Level = Math.Max(left.Level, right.Level) + 2 };
}

public sealed class Gate
{
    public bool Open;
    public int Evaluations;

    public static bool operator true(Gate gate) => gate.Open;

    public static bool operator false(Gate gate) => !gate.Open;

    public static Gate operator &(Gate left, Gate right) => new Gate { Open = left.Open && right.Open, Evaluations = 1 };

    public static Gate operator |(Gate left, Gate right) => new Gate { Open = left.Open || right.Open, Evaluations = 2 };
}

public sealed class Counted
{
    public int Id = 7;
}

public static class Dispatch
{
    private static int Digest(string text)
    {
        int digest = text.Length;
        foreach (char c in text)
        {
            digest = unchecked(digest * 31 + c);
        }

        return digest;
    }

    public static int Covariant(int which)
    {
        Animal animal = which switch
        {
            0 => new Dog { Legs = 4 },
            _ => new Puppy { Legs = 3 },
        };
        Dog dog = new Dog { Barks = which };
        Puppy puppy = new Puppy();
        Func<Dog> parent = dog.Parent;
        return animal.Parent().Legs * 1000 + dog.Parent().Barks * 100 + puppy.Parent().Barks
               + (ReferenceEquals(animal.Self, animal) ? 10000 : 0) + dog.Self.Barks * 7 + parent().Barks * 3
               + Digest(animal.Kind()) % 97;
    }

    public static int Defaults(int side)
    {
        IShape[] shapes = [new Triangle(), new Square(), new Hexagon { Scale = 1 }, new Hexagon { Scale = 2 }];
        int result = 0;
        foreach (var shape in shapes)
        {
            result = unchecked(result * 31 + shape.Perimeter(side) + Digest(shape.Name) % 1000);
        }

        return result;
    }

    public static int Statics(int value)
    {
        IShape.Counter = value;
        IShape.Counter++;
        IShape.Created += 1;
        return IShape.Twice(value) + IShape.Counter * 100 + IShape.Created * 10000;
    }

    public static int GenericDefault(int value)
    {
        IGeneric<int> numbers = new Box<int> { Value = value };
        IGeneric<string> texts = new Box<string> { Value = "ab" };
        return numbers.Twice((a, b) => a * 10 + b) + texts.Twice((a, b) => a + b).Length * 1000;
    }

    private static T Sum<T>(T[] values)
        where T : IMonoid<T>
    {
        T total = T.Zero;
        foreach (var value in values)
        {
            total += value;
        }

        return total + T.Parse(1);
    }

    private static int RankOf<T>()
        where T : IMonoid<T> => T.Rank;

    private static int AsInt<T>(T value)
        where T : IMonoid<T> => (int)value;

    public static int StaticAbstract(int value)
    {
        var money = Sum([new Money { Cents = value }, new Money { Cents = 3 }]);
        var tally = Sum([new Tally { Count = value }, new Tally { Count = 2 }, new Tally()]);
        return money.Cents * 1000 + tally.Count + RankOf<Money>() * 100000 + RankOf<Tally>() * 1000000
               + AsInt(money) * 7 + AsInt(tally) * 3;
    }

    public static int GenericVirtual(int which)
    {
        Converter converter = which switch
        {
            0 => new Converter(),
            1 => new Loud(),
            _ => new Quiet(),
        };
        return Digest(converter.Convert(which)) % 1000 + Digest(converter.Convert("x")) % 1000 * 1000
               + converter.Count(new[] { 1, 2, 3 }) * 1000000 + converter.Count(new[] { "a" }) * 100000000;
    }

    public static int AbstractGeneric(int value)
    {
        Maker maker = new Factory();
        return maker.Make<Counted>().Id + maker.Make<int>() + value;
    }

    public static int GenericClassVirtual(int which)
    {
        Holder<int> holder = which > 0 ? new Swapped<int>() : new Holder<int>();
        Holder<string> other = which > 1 ? new Swapped<string>() : new Holder<string>();
        return Digest(holder.Pair(which, "t")) % 10000 + Digest(other.Pair("s", 2.5)) % 10000 * 10000;
    }

    public static int Truth(int a, int b)
    {
        var left = new Fuzzy { Level = a };
        var right = new Fuzzy { Level = b };
        int evaluated = 0;
        Fuzzy Count(Fuzzy value)
        {
            evaluated++;
            return value;
        }

        var both = left && Count(right);
        var either = left || Count(right);
        int result = both.Level * 1000 + either.Level + evaluated * 1000000;
        result += left ? 10000000 : 0;
        var gate = new Gate { Open = a > b };
        var other = new Gate { Open = b > 10 };
        result += ((gate && other) ? 100000000 : 0) + (gate || other).Evaluations * 3;
        return result;
    }

    public static int InterfaceGeneric(int which)
    {
        IPicker picker = which > 2 ? new Neutral() : which > 0 ? new Second() : new First();
        First first = new Second();
        return picker.Pick(1, 2) * 100 + picker.Pick("left", "right").Length * 10 + first.Pick(3, 4);
    }
}
