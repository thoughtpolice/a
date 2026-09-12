// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.ExceptionMessages;

public sealed class GameError : Exception
{
    public int Code;

    public GameError(int code)
        : base("game error " + code)
    {
        Code = code;
    }

    public GameError(string message, Exception inner)
        : base(message, inner)
    {
    }
}

public class Plain : Exception
{
}

// Implicit and explicit constructors reaching a BCL base's parameterless
// one, which gives the message.
public sealed class Invalid : InvalidOperationException
{
}

public class Argument : ArgumentException
{
    public Argument()
    {
    }
}

public sealed class Deeper : Argument
{
}

public sealed class Ranged : ArgumentOutOfRangeException
{
    public Ranged(string name)
        : base(name, "custom " + name)
    {
    }
}

public static class Broken
{
    public static int Value = Fail();

    static Broken()
    {
    }

    private static int Fail() => throw new InvalidOperationException("broken on purpose");
}

// Messages stay inside the module, so each test digests them into a number.
// The BCL's default messages are the CLR's English resources; those of
// exceptions the runtime throws are compared where they are its classes'
// own (see README.md).
public static class Messages
{
    public static int OwnDefault(int which)
    {
        Exception error = which switch
        {
            0 => new SystemException(),
            1 => new ApplicationException(),
            2 => new InvalidOperationException(),
            3 => new ArgumentException(),
            4 => new ArgumentNullException(),
            5 => new ArgumentOutOfRangeException(),
            6 => new NullReferenceException(),
            7 => new IndexOutOfRangeException(),
            8 => new ArithmeticException(),
            9 => new DivideByZeroException(),
            10 => new OverflowException(),
            11 => new InvalidCastException(),
            12 => new NotSupportedException(),
            13 => new NotImplementedException(),
            14 => new FormatException(),
            15 => new System.Collections.Generic.KeyNotFoundException(),
            16 => new Exception(),
            17 => new Invalid(),
            18 => new Argument(),
            19 => new Deeper(),
            20 => new Plain(),
            21 => new System.Runtime.CompilerServices.SwitchExpressionException(),
            22 => new InvalidOperationException(null),
            23 => new ArgumentException(null),
            24 => new ArgumentNullException(null, (Exception)null),
            _ => new NotSupportedException(null, new Exception("inner")),
        };
        return Digest(error.Message);
    }

    public static int ParamNames(int which)
    {
        ArgumentException error = which switch
        {
            0 => new ArgumentException("bad", "x"),
            1 => new ArgumentException(null, "x"),
            2 => new ArgumentException("bad", ""),
            3 => new ArgumentNullException("p"),
            4 => new ArgumentNullException("p", "m"),
            5 => new ArgumentNullException("p", (string)null),
            6 => new ArgumentOutOfRangeException("q"),
            7 => new ArgumentOutOfRangeException("q", "m"),
            8 => new ArgumentOutOfRangeException("q", 42, "m"),
            9 => new ArgumentOutOfRangeException("q", null, "m"),
            10 => new Ranged("z"),
            11 => new ArgumentException("bad", "x", new Exception("in")),
            12 => new ArgumentOutOfRangeException(null),
            13 => new ArgumentOutOfRangeException("r", 2.5, null),
            _ => new ArgumentNullException(null),
        };
        return Digest(error.Message) * 7 + Digest(error.ParamName ?? "<null>") + (error.InnerException != null ? 3 : 0);
    }

    public static int Thrown(int which)
    {
        try
        {
            if (which < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(which), which, "negative");
            }

            if (which == 0)
            {
                throw new ArgumentNullException(nameof(which));
            }

            throw new ArgumentException("positive", nameof(which));
        }
        catch (ArgumentException error)
        {
            return Digest(error.Message) + Digest(error.ParamName) * 3;
        }
    }

    // The checks' exceptions whose messages are their classes' own.
    public static int CheckMessage(int which)
    {
        try
        {
            int[] values = new int[2];
            object text = which == 3 ? null : "text";
            return which switch
            {
                0 => values[which + 5],
                1 => 10 / (which - 1),
                2 => checked(int.MaxValue + which),
                3 => text.GetHashCode(),
                _ => int.MinValue / (which - 5),
            };
        }
        catch (Exception error)
        {
            return Digest(error.Message);
        }
    }

    // Exception.ToString of thrown exceptions, and GetBaseException: the
    // CLR's text with its stack traces (the lines of frames, and the ends
    // of rethrown traces) taken out, which the module does not keep.
    private static string WithoutTraces(string text)
    {
        var kept = new System.Text.StringBuilder();
        foreach (string line in text.Split('\n'))
        {
            string trimmed = line.TrimStart();
            if (trimmed.StartsWith("at ", StringComparison.Ordinal)
                || trimmed.StartsWith("--- End of stack trace from previous location", StringComparison.Ordinal))
            {
                continue;
            }

            if (kept.Length > 0)
            {
                kept.Append('\n');
            }

            kept.Append(line);
        }

        return kept.ToString();
    }

    private static Exception Nested(int which) => which switch
    {
        0 => new InvalidOperationException("outer"),
        1 => new InvalidOperationException("outer", new ArgumentException("inner", "name")),
        2 => new GameError("game", new Exception("deep", new FormatException())),
        3 => new AggregateException("many", new Exception("a"), new InvalidOperationException("b")),
        4 => new AggregateException(new AggregateException(new Exception("single"))),
        5 => new AggregateException(),
        6 => new Exception(null, new AggregateException(new Exception("x"), new Exception("y"))),
        _ => new GameError(which),
    };

    public static int ThrownText(int which)
    {
        try
        {
            try
            {
                throw Nested(which);
            }
            catch (Exception caught) when (which % 2 == 0)
            {
                throw new InvalidOperationException("wrapped", caught);
            }
        }
        catch (Exception error)
        {
            string text = WithoutTraces(error.ToString());
            Exception bottom = error.GetBaseException();
            return Digest(text) * 31 + Digest(bottom.Message) + (ReferenceEquals(bottom, error) ? 7 : 0)
                   + Digest(WithoutTraces(Nested(which).ToString())) * 17 + Digest(Nested(which).GetBaseException().Message) * 3;
        }
    }

    public static int Digest(string text)
    {
        if (text == null)
        {
            return -1;
        }

        int digest = text.Length;
        for (int index = 0; index < text.Length; index++)
        {
            digest = unchecked(digest * 31 + text[index]);
        }

        return digest;
    }

    public static int UserMessage(int code)
    {
        try
        {
            throw new GameError(code);
        }
        catch (GameError error)
        {
            return Digest(error.Message) + error.Code;
        }
    }

    public static int FrameworkMessage(int which)
    {
        try
        {
            throw which switch
            {
                0 => new InvalidOperationException("invalid " + which),
                1 => new ArgumentException("argument"),
                2 => new NotSupportedException("não suportado ✓"),
                3 => new Exception(""),
                _ => new KeyNotFoundLike("missing"),
            };
        }
        catch (Exception error)
        {
            return Digest(error.Message) * 10 + (error is InvalidOperationException ? 1 : 0);
        }
    }

    public static int Inner(int code)
    {
        var inner = new GameError(code);
        try
        {
            throw new GameError("outer", inner);
        }
        catch (GameError error)
        {
            return Digest(error.Message) + (error.InnerException == inner ? 1000 : 0)
                   + Digest(error.InnerException.Message) * 7 + (inner.InnerException == null ? 1 : 0);
        }
    }

    public static int Wrapped(int code)
    {
        try
        {
            try
            {
                throw new GameError(code);
            }
            catch (GameError error)
            {
                throw new InvalidOperationException($"wrapped: {error.Message}!", error);
            }
        }
        catch (InvalidOperationException error)
        {
            return Digest(error.Message) + (error.InnerException is GameError inner && inner.Code == code ? 1 : 0);
        }
    }

    public static int NullMessageKeepsDefault()
    {
        var error = new InvalidOperationException(null);
        var plain = new Exception(null, null);
        return (error.Message == new InvalidOperationException(null).Message ? 1 : 0)
               + (plain.Message.Length > 0 ? 10 : 0) + (plain.InnerException == null ? 100 : 0);
    }

    public static int NullReceiver()
    {
        Exception missing = null;
        return missing.Message.Length;
    }

    public static int TypeInitialization()
    {
        try
        {
            return Broken.Value;
        }
        catch (TypeInitializationException error)
        {
            return Digest(error.TypeName) + (error.InnerException is InvalidOperationException ? 1 : 0)
                   + Digest(error.InnerException.Message) * 3;
        }
    }

    // What the module gives exceptions without a message: the CLR's text for
    // an exception class without its own default.
    public static int DefaultMessage(int which)
    {
        try
        {
            if (which == 0)
            {
                throw new Plain();
            }

            int[] values = new int[1];
            return values[which];
        }
        catch (Exception error)
        {
            return Digest(error.Message);
        }
    }

    public static int TypeInitializationMessage()
    {
        try
        {
            return Broken.Value;
        }
        catch (TypeInitializationException error)
        {
            return Digest(error.Message);
        }
    }
}

public sealed class KeyNotFoundLike : Exception
{
    public KeyNotFoundLike(string message)
        : base(message)
    {
    }
}
