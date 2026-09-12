// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Differential;

public sealed class Cell
{
    public int Value;
    public Cell Next;

    public Cell(int value) => Value = value;

    public int Bump() => ++Value;
}

// These methods are compiled from the same file by Roslyn/.NET and gameplayc.
// Inputs and expected outcomes come from the differential runner, not constants
// embedded in a second implementation of the algorithms.
public static class Operations
{
    public static int Add(int left, int right) => left + right;
    public static int Subtract(int left, int right) => left - right;
    public static int Multiply(int left, int right) => left * right;
    public static int Negate(int value) => -value;
    public static int Divide(int left, int right) => left / right;
    public static int Remainder(int left, int right) => left % right;
    public static int ShiftLeft(int value, int count) => value << count;
    public static int ShiftRight(int value, int count) => value >> count;
    public static int ShiftUnsigned(int value, int count) => value >>> count;
    public static bool IntegerCompare(int left, int right) => left < right;
    public static bool BooleanExpression(bool left, bool right) => left && !right;

    public static float FloatAdd(float left, float right) => left + right;
    public static float FloatMultiply(float left, float right) => left * right;
    public static float FloatDivide(float left, float right) => left / right;
    public static float FloatNegate(float value) => -value;
    public static double DoubleAdd(double left, double right) => left + right;
    public static double DoubleMultiply(double left, double right) => left * right;
    public static double DoubleDivide(double left, double right) => left / right;
    public static double DoubleNegate(double value) => -value;
    public static bool DoubleLess(double left, double right) => left < right;
    public static bool DoubleEqual(double left, double right) => left == right;
    public static bool DoubleNotEqual(double left, double right) => left != right;
    public static float Narrow(double value) => (float)value;
    public static double Widen(float value) => value;
    public static float IntegerToFloat(int value) => value;
    public static double IntegerToDouble(int value) => value;

    public static int ArrayLength(int length) => new int[length].Length;

    public static int ArrayRead(int index)
    {
        var values = new int[] { 11, 22, 33 };
        return values[index];
    }

    // Wider index and size types: C# indexes arrays with uint, long and
    // ulong directly, not through int.
    public static int LongArrayLength(long length) => new int[length].Length;

    public static int ULongArrayLength(ulong length) => new byte[length].Length;

    public static int UIntArrayRead(uint index)
    {
        var values = new int[] { 11, 22, 33 };
        return values[index];
    }

    public static int LongArrayRead(long index)
    {
        var values = new int[] { 11, 22, 33 };
        return values[index];
    }

    public static int ULongArrayRead(ulong index)
    {
        var values = new int[] { 11, 22, 33 };
        return values[index];
    }

    public static int LongArrayWrite(long index, int value)
    {
        var values = new int[4];
        values[index] = value;
        values[index] += 2;
        values[index]++;
        return values[index] * 10 + values.Length;
    }

    // The CLR converts a long index without overflow on a 64-bit machine,
    // so the null check comes first; a ulong index past long.MaxValue
    // overflows before the array is looked at.
    public static int LongNullRead(long index)
    {
        int[] values = null;
        return values[index];
    }

    public static int ULongNullRead(ulong index)
    {
        int[] values = null;
        return values[index];
    }

    public static int NullRead()
    {
        Cell cell = null;
        return cell.Value;
    }

    public static int NullAssignmentOrder(int denominator)
    {
        Cell cell = null;
        cell.Value = 1 / denominator;
        return 0;
    }

    public static int BoundsAssignmentOrder(int denominator)
    {
        var values = new int[1];
        values[2] = 1 / denominator;
        return 0;
    }

    public static int AssignmentOrder()
    {
        var counter = new Cell(0);
        var values = new int[4];
        values[counter.Bump()] = counter.Bump();
        return counter.Value * 100 + values[1];
    }

    public static int PostIncrementOrder(int initial)
    {
        var counter = new Cell(0);
        var values = new int[] { 0, initial };
        int previous = values[counter.Bump()]++;
        return previous * 100 + values[1] * 10 + counter.Value;
    }

    public static int HeapAliases(int value)
    {
        var head = new Cell(value);
        var tail = new Cell(value + 1) { Next = head };
        head.Next = tail;
        Cell alias = tail.Next;
        alias.Value = alias.Value + 3;
        return head.Value * 10 + head.Next.Value;
    }
}

public enum Level
{
    Debug,
    Info,
    Warn,
    Error,
}

public enum Kind : byte
{
    None,
    Paddle,
    Ball,
    Brick,
}

// The wider scalar types, their conversions, the Math intrinsics and the
// control flow the CLR can also run. Every input comes from the runner.
public static class Numerics
{
    public static int DoubleToInt(double value) => (int)value;
    public static uint DoubleToUInt(double value) => (uint)value;
    public static long DoubleToLong(double value) => (long)value;
    public static ulong DoubleToULong(double value) => (ulong)value;
    public static byte DoubleToByte(double value) => (byte)value;
    public static sbyte DoubleToSByte(double value) => (sbyte)value;
    public static short DoubleToShort(double value) => (short)value;
    public static ushort DoubleToUShort(double value) => (ushort)value;
    public static char DoubleToChar(double value) => (char)value;
    public static int FloatToInt(float value) => (int)value;
    public static uint FloatToUInt(float value) => (uint)value;
    public static long FloatToLong(float value) => (long)value;
    public static ulong FloatToULong(float value) => (ulong)value;
    public static byte FloatToByte(float value) => (byte)value;
    public static short FloatToShort(float value) => (short)value;
    public static float LongToFloat(long value) => value;
    public static double LongToDouble(long value) => value;
    public static float ULongToFloat(ulong value) => value;
    public static double ULongToDouble(ulong value) => value;
    public static float UIntToFloat(uint value) => value;
    public static double UIntToDouble(uint value) => value;
    public static byte IntToByte(int value) => (byte)value;
    public static sbyte IntToSByte(int value) => (sbyte)value;
    public static short IntToShort(int value) => (short)value;
    public static ushort IntToUShort(int value) => (ushort)value;
    public static char IntToChar(int value) => (char)value;
    public static long IntToLong(int value) => value;
    public static ulong IntToULong(int value) => (ulong)value;
    public static long UIntToLong(uint value) => value;
    public static ulong UIntToULong(uint value) => value;
    public static int LongToInt(long value) => (int)value;
    public static uint LongToUInt(long value) => (uint)value;
    public static short LongToShort(long value) => (short)value;
    public static byte ULongToByte(ulong value) => (byte)value;
    public static short SByteToShort(sbyte value) => value;
    public static int UShortToInt(ushort value) => value;
    public static sbyte UShortToSByte(ushort value) => (sbyte)value;
    public static short UShortToShort(ushort value) => (short)value;
    public static ushort ShortToUShort(short value) => (ushort)value;
    public static byte ShortToByte(short value) => (byte)value;
    public static ushort CharToUShort(char character) => character;
    public static char UShortToChar(ushort value) => (char)value;
    public static float ByteToFloat(byte value) => value;
    public static double SByteToDouble(sbyte value) => value;

    public static long LongAdd(long left, long right) => left + right;
    public static long LongSubtract(long left, long right) => left - right;
    public static long LongMultiply(long left, long right) => left * right;
    public static long LongDivide(long left, long right) => left / right;
    public static long LongRemainder(long left, long right) => left % right;
    public static long LongAnd(long left, long right) => left & right;
    public static long LongOr(long left, long right) => left | right;
    public static long LongXor(long left, long right) => left ^ right;
    public static long LongShiftLeft(long value, int count) => value << count;
    public static long LongShiftRight(long value, int count) => value >> count;
    public static long LongShiftUnsigned(long value, int count) => value >>> count;
    public static long LongNegate(long value) => -value;
    public static long LongComplement(long value) => ~value;
    public static bool LongLess(long left, long right) => left < right;
    public static bool LongGreaterOrEqual(long left, long right) => left >= right;
    public static ulong ULongDivide(ulong left, ulong right) => left / right;
    public static ulong ULongRemainder(ulong left, ulong right) => left % right;
    public static ulong ULongShiftRight(ulong value, int count) => value >> count;
    public static bool ULongLess(ulong left, ulong right) => left < right;
    public static uint UIntDivide(uint left, uint right) => left / right;
    public static uint UIntRemainder(uint left, uint right) => left % right;
    public static uint UIntMultiply(uint left, uint right) => left * right;
    public static uint UIntShiftRight(uint value, int count) => value >> count;
    public static bool UIntLess(uint left, uint right) => left < right;
    public static bool UIntGreater(uint left, uint right) => left > right;

    public static byte ByteCompound(byte value, int operand)
    {
        value += (byte)operand;
        value -= 3;
        value *= 2;
        value <<= 1;
        value >>= 2;
        value |= 1;
        return value;
    }

    public static sbyte SByteIncrement(sbyte value)
    {
        value++;
        ++value;
        return value;
    }

    public static char CharIncrement(char character)
    {
        character++;
        return character;
    }

    public static short ShortDecrement(short value) => --value;

    public static ushort UShortMultiply(ushort left, ushort right) => (ushort)(left * right);

    public static long LongIncrement(long value) => value++ + value;

    public static double DoubleIncrement(double value) => ++value;

    public static int AbsInt(int value) => System.Math.Abs(value);
    public static long AbsLong(long value) => System.Math.Abs(value);
    public static float AbsFloat(float value) => System.Math.Abs(value);
    public static double AbsDouble(double value) => System.Math.Abs(value);
    public static double Floor(double value) => System.Math.Floor(value);
    public static double Ceiling(double value) => System.Math.Ceiling(value);
    public static double Truncate(double value) => System.Math.Truncate(value);
    public static double Round(double value) => System.Math.Round(value);
    public static double Sqrt(double value) => System.Math.Sqrt(value);
    public static float FloorSingle(float value) => System.MathF.Floor(value);
    public static float CeilingSingle(float value) => System.MathF.Ceiling(value);
    public static float TruncateSingle(float value) => System.MathF.Truncate(value);
    public static float RoundSingle(float value) => System.MathF.Round(value);
    public static float SqrtSingle(float value) => System.MathF.Sqrt(value);
    public static int MinInt(int left, int right) => System.Math.Min(left, right);
    public static int MaxInt(int left, int right) => System.Math.Max(left, right);
    public static uint MinUInt(uint left, uint right) => System.Math.Min(left, right);
    public static long MaxLong(long left, long right) => System.Math.Max(left, right);
    public static ulong MinULong(ulong left, ulong right) => System.Math.Min(left, right);
    public static double MinDouble(double left, double right) => System.Math.Min(left, right);
    public static double MaxDouble(double left, double right) => System.Math.Max(left, right);
    public static float MinSingle(float left, float right) => System.MathF.Min(left, right);
    public static float MaxSingle(float left, float right) => System.MathF.Max(left, right);
    public static int ClampInt(int value, int minimum, int maximum) => System.Math.Clamp(value, minimum, maximum);
    public static uint ClampUInt(uint value, uint minimum, uint maximum) => System.Math.Clamp(value, minimum, maximum);
    public static double ClampDouble(double value, double minimum, double maximum) => System.Math.Clamp(value, minimum, maximum);
    public static double CopySign(double magnitude, double sign) => System.Math.CopySign(magnitude, sign);
    public static float CopySignSingle(float magnitude, float sign) => System.MathF.CopySign(magnitude, sign);
    public static bool IsNaN(double value) => double.IsNaN(value);
    public static bool IsInfinity(double value) => double.IsInfinity(value);
    public static bool IsFinite(double value) => double.IsFinite(value);
    public static bool IsNaNSingle(float value) => float.IsNaN(value);
    public static bool IsFiniteSingle(float value) => float.IsFinite(value);
    public static int PopCount(uint value) => System.Numerics.BitOperations.PopCount(value);
    public static int PopCountLong(ulong value) => System.Numerics.BitOperations.PopCount(value);
    public static int LeadingZeros(uint value) => System.Numerics.BitOperations.LeadingZeroCount(value);
    public static int LeadingZerosLong(ulong value) => System.Numerics.BitOperations.LeadingZeroCount(value);
    public static int TrailingZeros(int value) => System.Numerics.BitOperations.TrailingZeroCount(value);
    public static int TrailingZerosLong(long value) => System.Numerics.BitOperations.TrailingZeroCount(value);
    public static uint RotateLeft(uint value, int count) => System.Numerics.BitOperations.RotateLeft(value, count);
    public static uint RotateRight(uint value, int count) => System.Numerics.BitOperations.RotateRight(value, count);
    public static ulong RotateLeftLong(ulong value, int count) => System.Numerics.BitOperations.RotateLeft(value, count);

    public static Level NextLevel(Level level) => level + 1;
    public static Kind NextKind(Kind kind) => kind + 1;
    public static Kind PreviousKind(Kind kind) => kind - 1;
    public static int KindCompare(Kind left, Kind right) => left < right ? 1 : left == right ? 0 : -1;
    public static Kind KindMask(Kind left, Kind right) => left & ~right;
    public static int LevelValue(Level level) => (int)level * 10 + (byte)level;

    public static int Classify(int value)
    {
        switch (value)
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
                int doubled = value * 2;
                return doubled + 300;
            }
            case > 100 when value < 200:
                return 400;
            case < 0:
                return 500;
        }
    }

    // Deliberately not exhaustive: an unnamed value throws on the CLR and faults in Wasm.
#pragma warning disable CS8524
    public static int LevelWeight(int level) => (Level)level switch
    {
        Level.Debug => 1,
        Level.Info => 2,
        Level.Warn => 4,
        Level.Error => 8,
    };
#pragma warning restore CS8524

    public static int Patterns(int value) => value is > 10 and < 20 or -1 ? 1 : value is not (5 or 6) ? 2 : 3;

    public static double NaNSwitch(double value)
    {
        switch (value)
        {
            case double.NaN:
                return 1;
            case 0:
                return 2;
            case < 0:
                return 3;
            default:
                return 4;
        }
    }

    public static int DoWhile(int count)
    {
        int index = 0;
        int sum = 0;
        do
        {
            index++;
            if (index == 2)
                continue;
            sum += index;
        }
        while (index < count);
        return sum;
    }

    static int counter;
    static readonly int[] history = new int[3];
    static int stride = 3;

    public static int StaticCounter(int step)
    {
        counter += step * stride;
        history[counter % 3] = counter;
        return counter * 10 + history[0];
    }

    public static int ForeachNarrowing()
    {
        int sum = 0;
        foreach (int value in new double[] { 1.5, -2.5, 1e10 })
            sum += value;
        return sum;
    }
}
