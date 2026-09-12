// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Unions;

public sealed class Cat
{
    public int Lives;

    public Cat(int lives) => Lives = lives;
}

public sealed class Dog
{
    public int Barks;

    public Dog(int barks) => Barks = barks;
}

public abstract class Bird
{
    public abstract int Wings { get; }
}

public sealed class Crow : Bird
{
    public override int Wings => 2;
}

public union Pet(Cat, Dog, Bird);

public union Payload(string, int[]);

public sealed class Error
{
    public int Code;

    public Error(int code) => Code = code;
}

public union Outcome<T>(T, Error)
    where T : class;

public sealed class Box
{
    public Pet Held;
}

public closed class Shape
{
}

public sealed class Circle : Shape
{
    public int Radius;
}

public sealed class Square : Shape
{
    public int Side;
}

// Unions are compared with the CLR through what their values do.
public static class Unions
{
    private static Pet Make(int kind) => kind switch
    {
        0 => new Cat(9),
        1 => new Dog(3),
        2 => new Crow(),
        3 => new Pet(new Dog(5)),
        _ => default,
    };

    private static int Describe(Pet pet) => pet switch
    {
        Cat cat when cat.Lives > 8 => cat.Lives * 100,
        Cat cat => cat.Lives,
        Dog dog => dog.Barks * 10,
        Bird bird => bird.Wings,
    };

    public static int Switches(int kind) => Describe(Make(kind));

    public static int Patterns(int kind)
    {
        Pet pet = Make(kind);
        int result = 0;
        if (pet is Cat)
        {
            result += 1;
        }

        if (pet is Dog dog && dog.Barks > 4)
        {
            result += 10;
        }

        if (pet is null)
        {
            result += 100;
        }

        if (pet is not Bird)
        {
            result += 1000;
        }

        return result;
    }

    public static int Statements(int kind)
    {
        switch (Make(kind))
        {
            case Cat cat:
                return cat.Lives;
            case Dog:
                return -1;
            case null:
                return -2;
            default:
                return -3;
        }
    }

    public static int Storage(int count)
    {
        count = count < 0 ? -count : count;
        var pets = new List<Pet>();
        var array = new Pet[count];
        var box = new Box();
        for (int index = 0; index < count; index++)
        {
            pets.Add(Make(index % 5));
            array[index] = Make((index + 1) % 5);
            box.Held = pets[index];
        }

        int total = 0;
        foreach (var pet in pets)
        {
            total = total * 3 + (pet is Cat ? 1 : pet is Dog ? 2 : 0);
        }

        return total + (array.Length > 0 && array[0] is Dog ? 100000 : 0) + (box.Held is Bird ? 7 : 0);
    }

    public static int Payloads(int which)
    {
        Payload payload = which == 0 ? "text" : new[] { 1, 2, 3, which };
        return payload switch
        {
            string text => text.Length,
            int[] values => values[values.Length - 1],
        };
    }

    private static Outcome<Cat> Adopt(int lives) => lives > 0 ? new Cat(lives) : new Error(-lives);

    public static int Generic(int lives) => Adopt(lives) switch
    {
        Cat cat => cat.Lives,
        Error error => -error.Code,
    };

    private static Shape MakeShape(int size) => size % 2 == 0 ? new Circle { Radius = size } : new Square { Side = size };

    public static int Closed(int size) => MakeShape(size) switch
    {
        Circle circle => circle.Radius * 10,
        Square square => square.Side,
    };

    // Property patterns test a case's members once its type matched.
    public static int Properties(int kind) => Make(kind) switch
    {
        Cat { Lives: > 8 } => 1,
        Dog { Barks: var barks } when barks > 4 => 10 + barks,
        Dog { } => 2,
        Crow { Wings: 2 } crow => 20 + crow.Wings,
        _ => 0,
    };

    // The default union matches no case: a switch expression over its cases
    // throws.
    public static int Unmatched() => Describe(default);
}
