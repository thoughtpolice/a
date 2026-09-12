// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;

// A switch expression without a matching arm throws, on purpose here.
#pragma warning disable CS8509

namespace Tests.ExceptionTypes;

public class GameException : Exception
{
    public int Code;

    public GameException()
    {
    }

    public GameException(int code) => Code = code;

    public virtual int Severity => 1;
}

public sealed class FatalError : GameException
{
    public FatalError(int code)
        : base(code)
    {
    }

    public override int Severity => 9;
}

public sealed class BadMove : InvalidOperationException
{
    public int Square;
}

public abstract class Piece
{
    public abstract int Move(int square);
}

public sealed class Rook : Piece
{
    public override int Move(int square) => square < 0 ? throw new BadMove { Square = square } : square * 2;
}

public interface IValidator
{
    int Check(int value);
}

public sealed class Positive : IValidator
{
    public int Check(int value)
    {
        if (value <= 0)
        {
            throw new GameException(value);
        }

        return value;
    }
}

public struct Tally
{
    public int Count;

    public void BumpThenFail(bool fail)
    {
        Count++;
        if (fail)
        {
            throw new GameException(Count);
        }
    }
}

public sealed class Guarded
{
    public int Built;

    public Guarded(int value)
    {
        Built = 1;
        if (value < 0)
        {
            throw new GameException(value);
        }

        Built = 2;
    }
}

// Every test resets the log first; each step appends a digit, so the order
// of catch and finally blocks shows in one number.
public static class Exceptions
{
    private static int log;

    private static void Log(int step) => log = unchecked(log * 10 + step);

    private static int Fail(int code) => throw new GameException(code);

    public static int CatchTypes(int kind)
    {
        log = 0;
        try
        {
            Log(1);
            switch (kind)
            {
                case 0:
                    throw new FatalError(5);
                case 1:
                    throw new GameException(3);
                case 2:
                    throw new BadMove { Square = 7 };
                case 3:
                    throw new InvalidOperationException();
                case 4:
                    throw new Exception();
            }

            Log(2);
        }
        catch (FatalError error)
        {
            Log(3);
            return log * 100 + error.Code * 10 + error.Severity;
        }
        catch (GameException error) when (error.Code > 2)
        {
            Log(4);
            return log * 100 + error.Code * 10 + error.Severity;
        }
        catch (InvalidOperationException error)
        {
            Log(5);
            return log * 100 + (error is BadMove move ? move.Square : 0);
        }
        catch (Exception)
        {
            Log(6);
        }

        return log;
    }

    public static int FinallyOrder(int mode)
    {
        log = 0;
        try
        {
            Nested(mode);
        }
        catch (GameException error)
        {
            Log(9);
            return log * 10 + error.Code;
        }

        return log;
    }

    private static void Nested(int mode)
    {
        try
        {
            Log(1);
            try
            {
                Log(2);
                if (mode == 1)
                {
                    Fail(1);
                }

                if (mode == 2)
                {
                    return;
                }

                Log(3);
            }
            finally
            {
                Log(4);
                if (mode == 3)
                {
                    Fail(3);
                }
            }

            Log(5);
        }
        catch (GameException error) when (error.Code == 3)
        {
            Log(6);
            throw;
        }
        finally
        {
            Log(7);
        }

        Log(8);
    }

    public static int ReturnThroughFinally(int value)
    {
        log = 0;
        int result = Returns(value);
        return result * 1000 + log;
    }

    private static int Returns(int value)
    {
        try
        {
            Log(1);
            return value;
        }
        finally
        {
            value = -1;
            Log(2);
        }
    }

    public static int LoopsThroughFinally(int count)
    {
        log = 0;
        int total = 0;
        for (int index = 0; index < count; index++)
        {
            try
            {
                if (index == 1)
                {
                    continue;
                }

                if (index == 4)
                {
                    break;
                }

                total += index;
            }
            finally
            {
                Log(index % 10);
            }
        }

        return total * 100000 + log;
    }

    public static int FinallyReplacesException(int mode)
    {
        log = 0;
        try
        {
            try
            {
                Fail(1);
            }
            finally
            {
                Log(2);
                if (mode == 1)
                {
                    Fail(2);
                }
            }
        }
        catch (GameException error)
        {
            Log(error.Code + 4);
        }

        return log;
    }

    public static int Rethrow(int mode)
    {
        log = 0;
        GameException first = null;
        try
        {
            try
            {
                throw new FatalError(4);
            }
            catch (GameException error)
            {
                first = error;
                Log(1);
                if (mode == 0)
                {
                    throw;
                }

                if (mode == 1)
                {
                    throw error;
                }

                throw new GameException(7);
            }
        }
        catch (GameException error)
        {
            Log(2);
            return log * 100 + (error == first ? 10 : 0) + error.Code;
        }
    }

    public static int Filters(int value)
    {
        log = 0;
        try
        {
            Fail(value);
        }
        catch (GameException error) when (Record(error.Code, 1) > 3)
        {
            Log(5);
        }
        catch (GameException error) when (ThrowingFilter(error.Code))
        {
            Log(6);
        }
        catch (GameException) when (Record(0, 2) == 0)
        {
            Log(7);
        }

        return log;
    }

    private static int Record(int value, int step)
    {
        Log(step);
        return value;
    }

    private static bool ThrowingFilter(int code)
    {
        Log(3);
        if (code < 0)
        {
            throw new InvalidOperationException();
        }

        return code == 2;
    }

    public static int AcrossCalls(int value)
    {
        log = 0;
        Piece piece = new Rook();
        IValidator validator = new Positive();
        Func<int, int> twice = x => validator.Check(x) * 2;
        int local = 0;
        int ViaLocal(int x)
        {
            local = x;
            return piece.Move(x);
        }

        int result = 0;
        try
        {
            result += piece.Move(value);
            result += twice(value + 1);
        }
        catch (BadMove move)
        {
            Log(1);
            result = move.Square;
        }
        catch (GameException error)
        {
            Log(2);
            result = error.Code * 100;
        }

        try
        {
            result += ViaLocal(value - 5);
        }
        catch (InvalidOperationException)
        {
            Log(3);
        }

        var list = new List<int> { 1, value, 3 };
        try
        {
            list.ForEach(item => validator.Check(item));
            Log(4);
        }
        catch (GameException error)
        {
            Log(5);
            result += error.Code;
        }

        return result * 100000 + log * 10 + local;
    }

    public static int Checks(int kind)
    {
        int[] array = new int[2];
        Rook rook = null;
        Piece piece = new Rook();
        var dictionary = new Dictionary<int, int>();
        var list = new List<int> { 1 };
        try
        {
            switch (kind)
            {
                case 0:
                    return rook.Move(1);
                case 1:
                    return array[kind + 5];
                case 2:
                    return 10 / (kind - 2);
                case 3:
                    return Divide(int.MinValue, -1);
                case 4:
                    return ((Rook)(Piece)new Knight()).Move(1);
                case 5:
                    return kind switch { 0 => 1 };
                case 6:
                    return dictionary[kind];
                case 7:
                    foreach (int item in list)
                    {
                        list.Add(item);
                    }

                    return 0;
                case 8:
                    return list[5];
                case 9:
                    return new int[kind - 20].Length;
                case 10:
                    return Math.Clamp(1, 5, 0);
                case 11:
                    dictionary.Add(1, 1);
                    dictionary.Add(1, 2);
                    return 0;
                case 12:
                    return piece.Move(-1);
                default:
                    return Math.Abs(int.MinValue);
            }
        }
        catch (NullReferenceException)
        {
            return 1;
        }
        catch (IndexOutOfRangeException)
        {
            return 2;
        }
        catch (DivideByZeroException)
        {
            return 3;
        }
        catch (OverflowException)
        {
            return 4;
        }
        catch (InvalidCastException)
        {
            return 5;
        }
        catch (KeyNotFoundException)
        {
            return 6;
        }
        catch (ArgumentOutOfRangeException)
        {
            return 7;
        }
        catch (ArgumentException)
        {
            return 8;
        }
        catch (InvalidOperationException error)
        {
            return error is BadMove ? 9 : 10;
        }
    }

    private static int Divide(int left, int right) => left / right;

    public static int Hierarchy(int kind)
    {
        try
        {
            switch (kind)
            {
                case 0:
                    return Divide(1, 0);
                case 1:
                    return Divide(int.MinValue, -1);
                case 2:
                    Rook rook = null;
                    return rook.Move(0);
                default:
                    var dictionary = new Dictionary<Rook, int>();
                    return dictionary.ContainsKey(null) ? 1 : 0;
            }
        }
        catch (ArithmeticException)
        {
            return 10;
        }
        catch (SystemException error) when (error is not ArgumentException)
        {
            return 20;
        }
        catch (ArgumentException error)
        {
            return error is ArgumentNullException ? 30 : 40;
        }
    }

    public static int Escapes(int kind)
    {
        switch (kind)
        {
            case 0:
                throw new GameException(kind);
            case 1:
                throw new InvalidOperationException();
            case 2:
                return new Guarded(-1).Built;
            case 3:
                GameException missing = null;
                throw missing;
            default:
                return kind;
        }
    }

    public static int ThrowExpressions(int value)
    {
        Rook rook = value > 0 ? new Rook() : null;
        try
        {
            var used = rook ?? throw new GameException(1);
            return used.Move(value) + (value > 5 ? throw new GameException(2) : 0);
        }
        catch (GameException error)
        {
            return -error.Code;
        }
    }

    public static int Constructors(int value)
    {
        Guarded guarded = null;
        try
        {
            guarded = new Guarded(value);
        }
        catch (GameException error)
        {
            return error.Code;
        }

        return guarded.Built;
    }

    // The CLR passes storage by reference: what a callee wrote before it
    // threw is there when the caller catches.
    private static void WriteThenFail(ref int target, out Tally tally)
    {
        target = 5;
        tally = new Tally { Count = 3 };
        tally.BumpThenFail(false);
        throw new GameException(target);
    }

    public static int MutationsSurvive(int value)
    {
        int target = value;
        Tally tally = default;
        var local = new Tally();
        var holder = new Tally[1];
        try
        {
            WriteThenFail(ref target, out tally);
        }
        catch (GameException)
        {
            Log(0);
        }

        try
        {
            local.BumpThenFail(value > 0);
        }
        catch (GameException)
        {
            Log(0);
        }

        try
        {
            holder[0].BumpThenFail(true);
        }
        catch (GameException)
        {
            Log(0);
        }

        return target * 1000 + tally.Count * 100 + local.Count * 10 + holder[0].Count;
    }

    public static int Generic(int kind)
    {
        int CatchOf<T>(Action action)
            where T : Exception
        {
            try
            {
                action();
                return 0;
            }
            catch (T)
            {
                return 1;
            }
        }

        try
        {
            return kind switch
            {
                0 => CatchOf<GameException>(() => Fail(1)),
                1 => CatchOf<FatalError>(() => Fail(1)),
                2 => CatchOf<ArithmeticException>(() => Divide(1, 0)),
                _ => CatchOf<Exception>(() => { }),
            };
        }
        catch (GameException)
        {
            return 2;
        }
    }

    public static int CapturedCatchVariable(int value)
    {
        Func<int> later = null;
        for (int index = 0; index < 2; index++)
        {
            try
            {
                Fail(value + index);
            }
            catch (GameException error)
            {
                Func<int> code = () => error.Code;
                later = later == null ? code : later;
            }
        }

        return later();
    }

    public static int CatchAll(int kind)
    {
        int caught = 0;
        try
        {
            if (kind == 0)
            {
                Fail(0);
            }

            if (kind == 1)
            {
                Divide(1, 0);
            }
        }
        catch
        {
            caught = 1;
        }

        return caught;
    }

    // Budgets are not exceptions: nothing catches running out of fuel or
    // call depth (the CLR would loop forever or overflow its stack).
    public static int CatchFuel()
    {
        log = 0;
        try
        {
            while (log >= 0)
            {
                log |= 1;
            }
        }
        catch
        {
            return -1;
        }
        finally
        {
            log = 0;
        }

        return log;
    }

    private static int Deeper(int depth) => Deeper(depth + 1) + 1;

    public static int CatchDepth()
    {
        try
        {
            return Deeper(0);
        }
        catch
        {
            return -1;
        }
    }

    public static int Log() => log;

    public static int InsideCatch(int value)
    {
        log = 0;
        try
        {
            try
            {
                Fail(value);
            }
            catch (GameException)
            {
                Log(1);
                try
                {
                    Fail(value + 1);
                }
                catch (GameException inner) when (inner.Code > 5)
                {
                    Log(2);
                }
                finally
                {
                    Log(3);
                }

                Log(4);
            }
        }
        catch (GameException error)
        {
            Log(5);
            return log * 100 + error.Code;
        }

        return log;
    }
}

public sealed class Knight : Piece
{
    public override int Move(int square) => square + 3;
}
