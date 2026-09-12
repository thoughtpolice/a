// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Types;

public class Vehicle
{
    public class Part
    {
    }
}

public class Car : Vehicle
{
}

public sealed class Racer : Car
{
}

public abstract class Shape
{
}

public sealed class Circle : Shape
{
}

public interface IThing
{
}

public struct Point : IThing
{
    public int X;
}

public enum Color
{
    Red,
    Green,
}

public static class Utility
{
}

public sealed class Pair<T>
{
    public T Value;
}

public record Named(string Name);

public delegate int Transform(int value);

// typeof, GetType and System.Type's members, against the CLR.
public static class Types
{
    private static int Digest(string text)
    {
        if (text == null)
        {
            return -1;
        }

        int digest = text.Length;
        foreach (char c in text)
        {
            digest = unchecked(digest * 31 + c);
        }

        return digest;
    }

    private static Type Pick(int which) => which switch
    {
        0 => typeof(int),
        1 => typeof(string),
        2 => typeof(Vehicle),
        3 => typeof(Vehicle.Part),
        4 => typeof(Racer),
        5 => typeof(Shape),
        6 => typeof(IThing),
        7 => typeof(Point),
        8 => typeof(Color),
        9 => typeof(Utility),
        10 => typeof(int[]),
        11 => typeof(Point[][]),
        12 => typeof(object),
        13 => typeof(List<int>),
        14 => typeof(Pair<string>),
        15 => typeof(int?),
        16 => typeof(Named),
        17 => typeof((int, string)),
        18 => typeof(Transform),
        19 => typeof(double),
        20 => typeof(char),
        21 => typeof(Dictionary<string, List<int>>),
        22 => typeof(Index),
        23 => typeof(Type),
        _ => typeof(ValueType),
    };

    public const int TypeCount = 25;

    public static int Flags(int which)
    {
        var type = Pick(which);
        return (type.IsValueType ? 1 : 0) | (type.IsClass ? 2 : 0) | (type.IsInterface ? 4 : 0)
               | (type.IsEnum ? 8 : 0) | (type.IsArray ? 16 : 0) | (type.IsPrimitive ? 32 : 0)
               | (type.IsSealed ? 64 : 0) | (type.IsAbstract ? 128 : 0) | (type.IsGenericType ? 256 : 0);
    }

    public static int Texts(int which)
    {
        var type = Pick(which);
        return Digest(type.ToString()) % 100000 * 1000 + Digest(type.Name) % 1000 + Digest(type.Namespace) % 7;
    }

    public static int FullName(int which) => Digest(Pick(which).FullName);

    public static int BaseTypes(int which)
    {
        int digest = 17;
        for (var type = Pick(which); type != null; type = type.BaseType)
        {
            digest = unchecked(digest * 31 + Digest(type.ToString()));
        }

        return digest;
    }

    public static int Identity(int left, int right)
    {
        var a = Pick(left);
        var b = Pick(right);
        return (a == b ? 1 : 0) + (a != b ? 2 : 0) + (a.Equals(b) ? 4 : 0) + (a.Equals((object)b) ? 8 : 0)
               + (a.GetHashCode() == Pick(left).GetHashCode() ? 16 : 0) + (ReferenceEquals(a, Pick(left)) ? 32 : 0);
    }

    public static int GetTypes(int which)
    {
        object value = which switch
        {
            0 => new Vehicle(),
            1 => new Car(),
            2 => new Racer(),
            3 => new Circle(),
            4 => 5,
            5 => "text",
            6 => new[] { 1, 2 },
            7 => new Point(),
            8 => Color.Green,
            9 => 2.5,
            10 => new Pair<int>(),
            11 => new List<string>(),
            12 => new Named("n"),
            13 => new object(),
            14 => (5, "t"),
            _ => new Vehicle.Part(),
        };
        return Digest(value.GetType().ToString()) + (value.GetType() == Pick(which % TypeCount) ? 1 : 0);
    }

    public static int StaticGetType(int which)
    {
        Vehicle vehicle = which > 0 ? new Racer() : new Car();
        IThing thing = new Point { X = which };
        int? maybe = which;
        Shape shape = new Circle();
        return Digest(vehicle.GetType().Name) % 1000 + Digest(thing.GetType().Name) % 1000 * 1000
               + Digest(which.GetType().Name) % 100 * 1000000 + Digest(maybe.GetType().Name) % 10
               + (shape.GetType() == typeof(Circle) ? 100000000 : 0);
    }

    private static string NameOf<T>() => typeof(T).Name;

    private static bool Same<T, U>() => typeof(T) == typeof(U);

    public static int Generic(int which) =>
        Digest(NameOf<Pair<Color>>()) % 1000 + (Same<int, int>() ? 1000 : 0) + (Same<int, long>() ? 2000 : 0)
        + (Same<string, string>() ? 4000 : 0) + which;

    public static int Keyed(int which)
    {
        var counts = new Dictionary<Type, int>();
        for (int index = 0; index < 20; index++)
        {
            var type = Pick((index * 7 + which) % 5);
            counts[type] = counts.TryGetValue(type, out int count) ? count + 1 : 1;
        }

        return counts.Count * 100 + counts[typeof(int)];
    }

    public static int Faults(int which)
    {
        object nothing = null;
        int? none = null;
        return which switch
        {
            0 => nothing.GetType().Name.Length,
            1 => none.GetType().Name.Length,
            _ => typeof(List<int>).FullName.Length,
        };
    }
}
