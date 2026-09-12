// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Tests;

public enum Kind : byte
{
    None,
    Paddle,
    Ball,
    Brick,
}

[System.Flags]
public enum Buttons : uint
{
    None = 0,
    Up = 1,
    Down = 2,
    Left = 4,
    Right = 8,
    A = 16,
}

public enum Level
{
    Debug,
    Info,
    Warn,
    Error,
}

internal static class Host
{
    [Gameplay.WasmImport("features", "read")]
    internal static extern int Read();
}

// Static initializers run on the first exported entry. While the host answers
// zero, the division faults and the next entry starts initialization again.
public static class Lazy
{
    static int hostValue = Host.Read();
    static int inverse = 100 / hostValue;

    public static int Inverse() => inverse;
}

// Static state persists across exported entries.
public static class Counter
{
    static int calls;
    static readonly int[] history = new int[4];
    static int seed = Seed();

    static int Seed() => 7;

    public static int Count { get; set; }

    public static int Calls => calls;

    public static int CallCount() => Calls * 100 + Count;

    public static int Next()
    {
        calls++;
        history[calls & 3] = calls * seed;
        Count += calls;
        return history[calls & 3];
    }
}

// Field initializers run in declaration order, then the static constructor.
public static class InitOrder
{
    static int a = 1;
    static int b = a + 10;
    static int c;

    static InitOrder()
    {
        c = b * 2;
    }

    public static int Sum() => a + b + c;
}

// A static constructor runs after every static field initializer of its
// class, even one declared after it.
public static class StaticConstructorOrder
{
    static StaticConstructorOrder()
    {
        x = x + 1;
        log = log * 10 + 3;
    }

    static int x = 5;
    static int log = 1;
    static int late = log * 10 + 2;

    public static int Get() => x;

    public static int Log() => log * 100 + late;
}

public static class Switches
{
    public static int Classify(int x)
    {
        switch (x)
        {
            case 0:
                return 100;
            case 1:
            case 2:
                return 200;
            default:
                return 900;
            case 3:
            {
                int y = x * 2;
                return y + 300;
            }
            case > 100 when x < 200:
                return 400;
            case < 0:
                return 500;
        }
    }

    public static int SwitchBreak(int n)
    {
        int total = 0;
        for (int i = 0; i < n; i++)
        {
            switch (i % 3)
            {
                case 0:
                    total += 1;
                    break;
                case 1:
                    continue;
                default:
                    total += 10;
                    break;
            }

            total += 100;
        }

        return total;
    }

    public static int SharedDefault(int x)
    {
        switch (x)
        {
            case 1:
                return 10;
            case 2:
            default:
                return 20;
            case 3:
                return 30;
        }
    }

    public static int KindScore(Kind kind) => kind switch
    {
        Kind.Paddle => 1,
        Kind.Ball or Kind.Brick => 2,
        _ => 0,
    };

    // No arm for values past Error: a fault, as the CLR's SwitchExpressionException.
#pragma warning disable CS8524
    public static int LevelWeight(int level) => (Level)level switch
    {
        Level.Debug => 1,
        Level.Info => 2,
        Level.Warn => 4,
        Level.Error => 8,
    };
#pragma warning restore CS8524

    public static int IsPattern(int x) => x is > 10 and < 20 ? 1 : (x is 5 or 6 ? 2 : 0);

    public static bool NotNull(bool useNull)
    {
        Body body = useNull ? null : new Body(1, 2);
        return body is not null;
    }

    public static int DoWhile(int n)
    {
        int i = 0;
        int sum = 0;
        do
        {
            i++;
            if (i == 2)
                continue;
            sum += i;
        }
        while (i < n);
        return sum;
    }

    // The switch block is one scope: a local declared in the default
    // section is assigned and used in a later section.
    public static int DefaultDeclares(int x)
    {
        switch (x)
        {
            default:
                int y = x + 1;
                return y;
            case 2:
                y = 5;
                return y * 10;
            case 3:
                Body body = new Body(x);
                return body.Y;
        }
    }

    public static double NaNCase(double x)
    {
        switch (x)
        {
            case double.NaN:
                return 1;
            case 0:
                return 2;
            default:
                return 3;
        }
    }
}

public static class Flags
{
    public static Buttons Press(Buttons state, Buttons button) => state | button;

    public static bool Held(Buttons state, Buttons button) => (state & button) == button && button != Buttons.None;

    public static Buttons Toggle(Buttons state, Buttons button) => state ^ button;

    public static Buttons Release(Buttons state, Buttons button) => state & ~button;

    // Kind is a byte enum: arithmetic wraps to the underlying type.
    public static Kind NextKind(Kind kind) => kind + 1;

    public static int Underlying(Kind kind) => (int)kind * 100 + (byte)kind;
}

public sealed class Body
{
    private int scale = 2;

    public Body(int x, int y)
    {
        X = x;
        Y = y;
    }

    public Body(int x) : this(x, x * 10)
    {
    }

    public int X { get; set; }

    public int Y { get; private set; }

    public int Sum => X + Y;

    public int Scaled
    {
        get => X * scale;
        set
        {
            X = value / scale;
        }
    }

    public int Fixed { get; } = 42;

    public int Clamped
    {
        get => field;
        set => field = value < 0 ? 0 : value;
    }

    public int Floor
    {
        get;
        set => field = value < 0 ? 0 : value;
    }

    public void Move(int dx)
    {
        X += dx;
    }
}

public static class Properties
{
    public static int Basic()
    {
        var body = new Body(3) { X = 5 };
        body.X++;
        body.Scaled += 4;
        body.Move(1);
        return body.Sum * 1000 + body.Fixed;
    }

    public static int Backed(int value)
    {
        var body = new Body(0);
        body.Clamped = value;
        body.Floor = value;
        body.Floor += 1;
        return body.Clamped * 100 + body.Floor;
    }

    public static int Discard()
    {
        var body = new Body(1);
        _ = body.Scaled;
        _ = new Body(2) { X = 3 };
        return body.X;
    }

    public static int Coalesce(bool useNull)
    {
        Body first = useNull ? null : new Body(1, 2);
        Body second = first ?? new Body(7, 8);
        return second.X;
    }

    public static int NullProperty()
    {
        Body body = null;
        return body.Sum;
    }
}

public static partial class Game
{
    [Gameplay.WasmExport("tick")]
    public static partial int Tick(int dt);

    public static class Inner
    {
        public sealed class Node
        {
            public int Value;
            public Node Next;
        }

        public static int Chain(int n)
        {
            Node head = null;
            for (int i = 1; i <= n; i++)
                head = new Node { Value = i, Next = head };
            int sum = 0;
            for (var node = head; node != null; node = node.Next)
                sum += node.Value;
            return sum;
        }
    }
}

public static partial class Game
{
    static int elapsed;

    public static partial int Tick(int dt)
    {
        elapsed += dt;
        return elapsed;
    }
}

internal static class Hidden
{
    public static int NotExported() => 1;
}

public static class Exposed
{
    internal static int AlsoNotExported() => 2;

    public static int Visible() => 3 + Hidden.NotExported() * 0 + AlsoNotExported() * 0;

    public static Body NotScalar() => null;
}

public static class Numbers
{
    public static long Wide(long a, long b) => a * b + (a >> 3) - (b >>> 1);

    public static ulong Unsigned(ulong a, uint b) => a / b + a % b;

    public static uint UnsignedDivide(uint a, uint b) => a / b;

    public static bool UnsignedLess(uint a, uint b) => a < b;

    public static int Saturate(double value) => (int)value;

    public static uint SaturateUnsigned(float value) => (uint)value;

    public static byte ToByte(int value) => (byte)value;

    public static sbyte ToSByte(int value) => (sbyte)value;

    public static short Shorten(long value) => (short)value;

    public static char NextChar(char character) => (char)(character + 1);

    public static int CharCode(char character) => character;

    public static byte ByteWrap(byte value)
    {
        value++;
        value += 250;
        return value;
    }

    public static long Extend(int value) => value;

    public static ulong ExtendUnsigned(uint value) => value;

    public static long ShiftWide(long value, int count) => value << count;

    public static double Mixed(float single, long wide) => single + wide;

    public static float FromUnsignedLong(ulong value) => value;

    public static int Absolute(int value) => System.Math.Abs(value);

    public static int Clamp(int value, int minimum, int maximum) => System.Math.Clamp(value, minimum, maximum);

    public static double Round(double value) => System.Math.Round(value);

    public static float Sqrt(float value) => System.MathF.Sqrt(value);

    public static double Max(double left, double right) => System.Math.Max(left, right);

    public static int PopCount(uint value) => System.Numerics.BitOperations.PopCount(value);

    public static uint Rotate(uint value, int count) => System.Numerics.BitOperations.RotateLeft(value, count);

    public static bool IsNaN(double value) => double.IsNaN(value);

    public static bool IsFinite(float value) => float.IsFinite(value);
}
