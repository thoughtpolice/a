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
