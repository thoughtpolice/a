// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.Filters;

public sealed class FilterError : Exception
{
    public int Code;

    public FilterError(int code) => Code = code;
}

public abstract class Thrower
{
    public abstract int Run(int value);
}

public sealed class Direct : Thrower
{
    public override int Run(int value) => value < 0 ? throw new FilterError(value) : value;
}

public sealed class Guarded : Thrower
{
    public override int Run(int value)
    {
        try
        {
            return value < 0 ? throw new FilterError(-value) : value;
        }
        finally
        {
            Filters.Note(4);
        }
    }
}

public struct Counter
{
    public int Value;
}

public sealed class Scoreboard
{
    public int Threshold;

    public int Hits;

    // A filter on `this`: fields read and written through the instance.
    public int Check(int code)
    {
        try
        {
            Filters.Deep(2, code);
            return 0;
        }
        catch (FilterError error) when (Hits++ >= 0 && error.Code > Threshold)
        {
            return Hits * 10 + 1;
        }
        catch (FilterError)
        {
            return Hits * 10 + 2;
        }
    }
}

// A static constructor is a boundary for the first pass: filters outside
// never see what it throws, only the TypeInitializationException.
public static class Unready
{
    public static int Value = 1;

    static Unready()
    {
        Filters.Note(3);
        throw new FilterError(3);
    }
}

// Every test clears the log, notes digits in the order things happen, and
// returns it: filters, in the CLR, run before the finally blocks between the
// throw and the clause that takes the exception.
public static class Filters
{
    private static long log;
    private static int flag;

    public static long LastLog() => log;

    public static void Note(int digit) => log = log * 10 + digit;

    // Notes a digit; the filter's answer.
    private static bool Say(int digit, bool answer)
    {
        Note(digit);
        return answer;
    }

    // Throws from `depth` frames down, each with a finally block noting its
    // depth on the way out.
    public static int Deep(int depth, int code)
    {
        if (depth <= 0)
        {
            throw new FilterError(code);
        }

        try
        {
            return Deep(depth - 1, code);
        }
        finally
        {
            Note(depth);
        }
    }

    public static long BeforeFinally(int depth)
    {
        log = 0;
        try
        {
            Deep(depth, 5);
        }
        catch (FilterError error) when (Say(8, error.Code == 5))
        {
            Note(9);
        }

        return log;
    }

    // Each level filters for its own code, noting its level; finally blocks
    // note 9 below them, so the log shows every filter, from the innermost
    // out, before any finally block runs.
    private static int Level(int level, int code)
    {
        if (level == 0)
        {
            throw new FilterError(code);
        }

        try
        {
            try
            {
                return Level(level - 1, code);
            }
            finally
            {
                Note(9);
            }
        }
        catch (FilterError error) when (Say(level, error.Code == level))
        {
            Note(0);
            return level;
        }
    }

    public static long Levels(int code)
    {
        log = 0;
        try
        {
            Note(Level(4, code));
        }
        catch (FilterError) when (Say(7, true))
        {
            Note(8);
        }

        return log;
    }

    // A finally block that runs before the clause sees what the filter did
    // not: the filter reads the flag first.
    public static long SeesStateBeforeFinally(int value)
    {
        log = 0;
        flag = 0;
        try
        {
            try
            {
                throw new FilterError(value);
            }
            finally
            {
                flag = 1;
                Note(1);
            }
        }
        catch (FilterError) when (Say(2, flag == 0))
        {
            Note(3);
        }
        catch (FilterError)
        {
            Note(4);
        }

        return log * 10 + flag;
    }

    // Filters that throw are false; one that catches its own exception
    // inside goes on normally.
    private static bool Throwing(int code)
    {
        Note(3);
        if (code == 1)
        {
            throw new InvalidOperationException();
        }

        if (code == 2)
        {
            int[] missing = null;
            return missing.Length == 0;
        }

        return code == 3;
    }

    private static bool CatchesInside(int code)
    {
        try
        {
            return Deep(1, code) == 0;
        }
        catch (FilterError inner) when (Say(5, inner.Code == code))
        {
            return code > 3;
        }
    }

    public static long ThrowingFilters(int code)
    {
        log = 0;
        try
        {
            try
            {
                Deep(2, code);
            }
            catch (FilterError error) when (Throwing(error.Code))
            {
                Note(6);
            }
            catch (FilterError error) when (CatchesInside(error.Code))
            {
                Note(7);
            }
        }
        catch (Exception) when (Say(8, true))
        {
            Note(9);
        }

        return log;
    }

    // Exceptions from virtual calls, delegates and closures; filters that
    // call them too.
    public static long AcrossCalls(int value)
    {
        log = 0;
        var throwers = new Thrower[] { new Direct(), new Guarded() };
        int seen = 0;
        Func<int, bool> accept = code =>
        {
            seen++;
            Note(6);
            return code % 2 == 0;
        };
        Func<int, int> call = input => throwers[input & 1].Run(input);
        for (int round = 0; round < 3; round++)
        {
            try
            {
                try
                {
                    call(value - round);
                    Note(1);
                }
                finally
                {
                    Note(2);
                }
            }
            catch (FilterError error) when (accept(error.Code))
            {
                Note(7);
            }
            catch (FilterError error) when (throwers[0].Run(error.Code) == 0)
            {
                Note(8);
            }
            catch (FilterError)
            {
                Note(9);
            }
        }

        return log * 10 + seen;
    }

    // `throw;` starts over: outer filters run again, after the finally
    // blocks the first exception left.
    public static long Rethrows(int value)
    {
        log = 0;
        try
        {
            try
            {
                try
                {
                    Deep(1, value);
                }
                catch (FilterError error) when (Say(2, error.Code > 0))
                {
                    Note(3);
                    throw;
                }
                finally
                {
                    Note(4);
                }
            }
            catch (FilterError error) when (Say(5, error.Code > 1))
            {
                Note(6);
                throw new FilterError(error.Code - 1);
            }
        }
        catch (FilterError error) when (Say(7, error.Code >= 0))
        {
            Note(8);
            return log * 10 + error.Code;
        }

        return log;
    }

    // Filters see and change variables of their function, `this`, struct
    // locals, and variables of the loop that runs them.
    public static long Variables(int value)
    {
        log = 0;
        int attempts = 0;
        var counter = new Counter { Value = value };
        for (int index = 0; index < 3; index++)
        {
            int local = index * 10;
            try
            {
                local++;
                Deep(1, index);
            }
            catch (FilterError error) when ((attempts += 1) > 0 && local == index * 10 + 1 && counter.Value++ >= 0
                                            && error.Code == index)
            {
                Note(local % 10);
            }
        }

        var board = new Scoreboard { Threshold = value };
        return (log * 100 + attempts * 10 + counter.Value - value) * 1000 + board.Check(value + 1) * 10 + board.Check(value);
    }

    // Leaving a filtered try by return, break and continue takes its record
    // off the stack: later exceptions skip it.
    public static long Leaving(int value)
    {
        log = 0;
        for (int index = 0; index < 4; index++)
        {
            try
            {
                if (index == 1)
                {
                    continue;
                }

                if (index == value)
                {
                    break;
                }

                Note(index);
            }
            catch (FilterError) when (Say(9, true))
            {
                Note(8);
            }
        }

        try
        {
            Deep(0, value);
        }
        catch (FilterError error) when (Say(7, error.Code == value))
        {
            Note(6);
        }

        return log * 10 + Returns(value);
    }

    private static int Returns(int value)
    {
        try
        {
            return value;
        }
        catch (FilterError) when (Say(9, true))
        {
            return -1;
        }
    }

    // A finally block, run while an exception unwinds toward its chosen
    // clause, throws and catches exceptions of its own, even the same
    // object; the first exception still reaches its clause.
    public static long FinallyThrowsInside(int value)
    {
        log = 0;
        var shared = new FilterError(value);
        try
        {
            try
            {
                throw shared;
            }
            finally
            {
                try
                {
                    throw shared;
                }
                catch (FilterError inner) when (Say(3, inner == shared))
                {
                    Note(4);
                }
            }
        }
        catch (FilterError error) when (Say(1, error == shared))
        {
            Note(5);
        }

        return log;
    }

    // What no clause takes ends the entry; the filters ran first, then the
    // finally blocks. LastLog shows them.
    public static int Escapes(int code)
    {
        log = 0;
        try
        {
            try
            {
                Deep(2, code);
            }
            catch (FilterError error) when (Say(7, error.Code == 100))
            {
                Note(0);
            }
            finally
            {
                Note(8);
            }
        }
        catch (FilterError error) when (Say(9, error.Code == 200))
        {
            Note(0);
        }

        return 1;
    }

    // Compiler checks throw through filters too.
    public static long Checks(int index)
    {
        log = 0;
        int[] values = { 1, 2, 3 };
        try
        {
            try
            {
                return values[index];
            }
            finally
            {
                Note(2);
            }
        }
        catch (IndexOutOfRangeException) when (Say(1, index > 3))
        {
            Note(3);
        }
        catch (Exception) when (Say(4, true))
        {
            Note(5);
        }

        return log;
    }

    public static long InitializerBoundary(int value)
    {
        log = 0;
        for (int round = 0; round < 2; round++)
        {
            try
            {
                try
                {
                    value += Unready.Value;
                }
                finally
                {
                    Note(4);
                }
            }
            catch (FilterError) when (Say(1, true))
            {
                Note(5);
            }
            catch (TypeInitializationException) when (Say(2, value >= 0))
            {
                Note(6);
            }
            catch (TypeInitializationException)
            {
                Note(7);
            }
        }

        return log;
    }

    // Deeper than the handler stack's first array: it grows, and every
    // record is found.
    private static int Nest(int depth, int wanted)
    {
        try
        {
            return depth == 0 ? throw new FilterError(wanted) : Nest(depth - 1, wanted) + 1;
        }
        catch (FilterError error) when (Say(depth % 10, error.Code == depth))
        {
            return 1000 * depth;
        }
    }

    public static long DeepRecords(int wanted)
    {
        log = 0;
        long first = Nest(40, wanted);
        long again = Nest(20, wanted);
        return first * 100000 + again + log % 1000;
    }

    private static T Pick<T>(T[] items, int index, T fallback)
    {
        try
        {
            return items[index];
        }
        catch (IndexOutOfRangeException) when (Say(items.Length, index >= 0))
        {
            return fallback;
        }
    }

    // Selectors per instantiation of a generic method, and in a lambda.
    public static long Generic(int index)
    {
        log = 0;
        int number = Pick(new[] { 1, 2, 3 }, index, -1);
        long wide = Pick(new[] { 10L, 20L }, index, -2L);
        Func<int, int> lambda = input =>
        {
            try
            {
                return Deep(1, input);
            }
            catch (FilterError error) when (Say(9, error.Code == index))
            {
                return 100;
            }
        };
        return (log * 1000 + number * 10 + wide) * 1000 + lambda(index);
    }
}
