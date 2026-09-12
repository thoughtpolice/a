// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

namespace Tests.Jumps;

public sealed class Tracker : IDisposable
{
    public static int Disposed;

    public void Dispose() => Disposed++;
}

// goto, goto case and goto default, against the CLR: loops made of labels,
// forward and backward jumps, jumps out of loops, switches, try blocks
// with finally, using statements and lambdas' own labels.
public static class Jumps
{
    public static int Backward(int n)
    {
        int i = 0;
        int sum = 0;
    top:
        sum += i;
        i++;
        if (i < n)
        {
            goto top;
        }

        return sum;
    }

    public static int Forward(int x)
    {
        int result = 1;
        if (x > 5)
        {
            goto big;
        }

        result += 10;
        if (x < 0)
        {
            goto negative;
        }

        result += 100;
        goto done;
    big:
        result += 1000;
    negative:
        result += 10000;
    done:
        return result * 3 + x;
    }

    // Nested loops left by goto, and a label inside a loop body.
    public static int NestedExit(int n)
    {
        int found = -1;
        for (int i = 0; i < n; i++)
        {
            for (int j = 0; j < n; j++)
            {
                if (i * j == n + 3)
                {
                    found = i * 100 + j;
                    goto after;
                }
            }
        }

        found -= 7;
    after:
        return found;
    }

    public static int InLoop(int n)
    {
        int total = 0;
        for (int i = 0; i < n; i++)
        {
            int k = i;
        again:
            total += k;
            k -= 3;
            if (k > 0)
            {
                goto again;
            }

            if (total > 1000)
            {
                goto leave;
            }
        }

    leave:
        return total;
    }

    // A label at the very start and one at the very end of a block.
    public static int Edges(int n)
    {
    start:
        n += 7;
        if (n < 50)
        {
            goto start;
        }

        if (n % 2 == 0)
        {
            goto end;
        }

        n *= 3;
    end:
        ;
        return n;
    }

    public static int Finally(int n)
    {
        int log = 0;
        int round = 0;
    retry:
        round++;
        try
        {
            log = log * 10 + 1;
            if (round < n)
            {
                goto retry;
            }

            if (n > 3)
            {
                goto out_;
            }
        }
        finally
        {
            log = log * 10 + 2;
        }

        log = log * 10 + 3;
    out_:
        return log % 1000000007 + round;
    }

    public static int Using(int n)
    {
        Tracker.Disposed = 0;
        int count = 0;
    loop:
        using (new Tracker())
        {
            count++;
            if (count < n)
            {
                goto loop;
            }
        }

        return count * 100 + Tracker.Disposed;
    }

    public static int UsingDeclaration(int n)
    {
        Tracker.Disposed = 0;
        int count = 0;
        {
            using var tracker = new Tracker();
            int local = 0;
        spin:
            local++;
            count += local;
            if (local < n)
            {
                goto spin;
            }
        }

        return count * 100 + Tracker.Disposed;
    }

    public static int Catch(int n)
    {
        int log = 0;
    again:
        try
        {
            log++;
            if (log < n)
            {
                throw new InvalidOperationException();
            }
        }
        catch (InvalidOperationException)
        {
            goto again;
        }

        return log;
    }

    public static int Lambda(int n)
    {
        Func<int, int> f = x =>
        {
            int acc = 0;
        next:
            acc += x;
            x--;
            if (x > 0)
            {
                goto next;
            }

            return acc;
        };
        int local(int y)
        {
            if (y > 3)
            {
                goto big;
            }

            return y;
        big:
            return -y;
        }

        return f(n) * 10 + local(n);
    }

    public static int Captured(int n)
    {
        var actions = new List<Func<int>>();
        int i = 0;
    top:
        int copy = i;
        actions.Add(() => copy * 2);
        i++;
        if (i < n)
        {
            goto top;
        }

        int sum = 0;
        foreach (var action in actions)
        {
            sum = sum * 3 + action();
        }

        return sum;
    }

    public static int Case(int x)
    {
        int trail = 0;
        switch (x)
        {
            case 0:
                trail = trail * 10 + 1;
                goto case 2;
            case 1:
                trail = trail * 10 + 2;
                goto default;
            case 2:
                trail = trail * 10 + 3;
                break;
            case 3:
            case 4:
                trail = trail * 10 + 4;
                goto case 1;
            default:
                trail = trail * 10 + 5;
                break;
        }

        return trail;
    }

    public static int CaseLoop(int x)
    {
        int count = 0;
        switch (x % 4)
        {
            case 0:
                count += 1;
                if (count < 20)
                {
                    goto case 1;
                }

                break;
            case 1:
                count += 2;
                goto case 0;
            default:
                count = -1;
                break;
        }

        return count;
    }

    public static int CaseStrings(string s)
    {
        switch (s)
        {
            case "a":
                return 1;
            case "b":
                goto case "a";
            case null:
                goto default;
            default:
                return s == null ? -2 : s.Length;
        }
    }

    public static int CaseStringEntry(int which) =>
        CaseStrings(which switch { 0 => "a", 1 => "b", 2 => null, _ => "hello" });

    public static int CaseEnum(int x)
    {
        var day = (DayOfWeek)(x % 7);
        int value = 0;
        switch (day)
        {
            case DayOfWeek.Saturday:
                value += 100;
                goto case DayOfWeek.Sunday;
            case DayOfWeek.Sunday:
                value += 10;
                break;
            default:
                value += 1;
                goto case DayOfWeek.Saturday;
        }

        return value;
    }

    // A switch without a default whose value matches nothing.
    public static int CaseNoDefault(int x)
    {
        int value = 5;
        switch (x)
        {
            case 1:
                goto case 2;
            case 2:
                value = 7;
                break;
        }

        return value;
    }

    // A goto from a switch section to a label outside the switch, and a
    // label inside a section.
    public static int SectionLabels(int x)
    {
        int value = 0;
    restart:
        switch (x)
        {
            case 0:
                value += 1;
                x = 1;
                goto restart;
            case 1:
            inner:
                value += 10;
                if (value < 50)
                {
                    goto inner;
                }

                break;
            default:
                x = 0;
                goto restart;
        }

        return value;
    }

    public static int Fuel(int n)
    {
        int i = 0;
    spin:
        i++;
        if (i != n)
        {
            goto spin;
        }

        return i;
    }
}
