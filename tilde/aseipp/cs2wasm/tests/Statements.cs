// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Statements;

public static class Log
{
    public static int Value;

    public static void Add(int step) => Value = Value * 10 + step;
}

public sealed class Resource : IDisposable
{
    private readonly int id;

    public Resource(int id)
    {
        this.id = id;
        Log.Add(id);
    }

    public void Dispose() => Log.Add(id + 5);
}

public class BaseResource : IDisposable
{
    public virtual void Dispose() => Log.Add(1);
}

public sealed class DerivedResource : BaseResource
{
    public override void Dispose() => Log.Add(2);
}

public sealed class Explicit : IDisposable
{
    void IDisposable.Dispose() => Log.Add(3);
}

public struct Handle : IDisposable
{
    public int Id;

    public void Dispose() => Log.Add(Id);
}

public sealed class Countdown
{
    private readonly int start;

    public Countdown(int start)
    {
        this.start = start;
    }

    public Enumerator GetEnumerator() => new Enumerator(start);

    public sealed class Enumerator : IDisposable
    {
        private int value;

        public Enumerator(int value)
        {
            this.value = value + 1;
        }

        public int Current => value;

        public bool MoveNext() => --value > 0;

        public void Dispose() => Log.Add(9);
    }
}

public struct Steps
{
    public int Count;

    public StepEnumerator GetEnumerator() => new StepEnumerator { Left = Count };
}

public struct StepEnumerator : IDisposable
{
    public int Left;

    public int Current => Left;

    public bool MoveNext() => Left-- > 0;

    public void Dispose() => Log.Add(Left + 5);
}

public sealed class Failure : Exception
{
}

public static class Statements
{
    public static int UsingBlock(int a)
    {
        Log.Value = 0;
        using (var resource = new Resource(1))
        {
            Log.Add(a % 10);
        }

        return Log.Value;
    }

    public static int UsingMany(int a)
    {
        Log.Value = 0;
        using (Resource first = new Resource(1), second = new Resource(2))
        {
            Log.Add(a % 10);
        }

        return Log.Value;
    }

    public static int UsingDeclarations(int a)
    {
        Log.Value = 0;
        using var first = new Resource(1);
        Log.Add(8);
        using var second = new Resource(2);
        if (a > 0)
        {
            return Log.Value;
        }

        Log.Add(9);
        return -Log.Value;
    }

    public static int UsingAfterReturn(int a) => UsingDeclarations(a) * 1000 + Log.Value % 1000;

    public static int UsingNull(int a)
    {
        Log.Value = 0;
        using (Resource none = a > 0 ? null : new Resource(1))
        {
            Log.Add(7);
        }

        return Log.Value;
    }

    public static int UsingExpression(int a)
    {
        Log.Value = 0;
        var resource = new Resource(2);
        using (resource)
        {
            Log.Add(a % 10);
        }

        return Log.Value;
    }

    public static int UsingVirtual(int a)
    {
        Log.Value = 0;
        using (BaseResource resource = a > 0 ? new DerivedResource() : new BaseResource())
        {
        }

        using (var explicitly = new Explicit())
        {
        }

        using (var handle = new Handle { Id = 4 })
        {
        }

        return Log.Value;
    }

    public static int UsingThrows(int a)
    {
        Log.Value = 0;
        try
        {
            using var resource = new Resource(1);
            if (a > 0)
            {
                throw new Failure();
            }

            Log.Add(3);
        }
        catch (Failure)
        {
            Log.Add(9);
        }

        return Log.Value;
    }

    public static int UsingLoop(int a)
    {
        Log.Value = 0;
        for (int index = 0; index < 4; index++)
        {
            using var resource = new Resource(index);
            if (index == a)
            {
                break;
            }

            if (index == 1)
            {
                continue;
            }

            Log.Add(9);
        }

        return Log.Value;
    }

    private static readonly object Gate = new object();

    public static int Locked(int a)
    {
        int total = 0;
        lock (Gate)
        {
            total += a;
            lock (Gate)
            {
                total *= 2;
            }
        }

        object none = a > 0 ? null : Gate;
        try
        {
            lock (none)
            {
                total += 1000;
            }
        }
        catch (ArgumentNullException)
        {
            total += 100;
        }

        return total;
    }

    public static int DisposingLoops(int a)
    {
        Log.Value = 0;
        int sum = 0;
        foreach (var value in new Countdown(3))
        {
            sum += value;
            if (value == a)
            {
                break;
            }
        }

        foreach (var step in new Steps { Count = 2 })
        {
            sum += step * 100;
        }

        return Log.Value * 10000 + sum;
    }

    public static int DisposingReturn(int a)
    {
        Log.Value = 0;
        foreach (var value in new Countdown(4))
        {
            if (value == a)
            {
                return Log.Value * 100 + value;
            }
        }

        return Log.Value;
    }

    public static int DisposingReturnAfter(int a) => DisposingReturn(a) * 100 + Log.Value;

    public static int Objects(int a)
    {
        object first = new object();
        object second = new object();
        var list = new List<object> { first, second, first };
        return (first.Equals(second) ? 1 : 0) + (first.Equals(first) ? 2 : 0) + (first == list[2] ? 4 : 0)
            + (first.GetHashCode() == first.GetHashCode() ? 8 : 0) + (first is string ? 16 : 0)
            + list.IndexOf(second) * 100 + first.ToString().Length * 1000 + $"{second}".Length * 100000 + a;
    }

    public static int Characters(int a)
    {
        string text = "a" + a + "z";
        int sum = 0;
        foreach (char character in text)
        {
            sum = sum * 3 + character;
        }

        foreach (int code in text)
        {
            sum += code;
        }

        string none = a > 1000 ? null : text;
        foreach (var character in none)
        {
            sum ^= character;
        }

        return sum;
    }
}
