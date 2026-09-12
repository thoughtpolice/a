// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Tests;

public sealed class SyntaxState
{
    public int Trace;
    public int Value;
    public int[] Items;

    public SyntaxState Receiver()
    {
        Trace = Trace * 10 + 1;
        return this;
    }

    public int[] Collection()
    {
        Trace = Trace * 10 + 1;
        return Items;
    }

    public int Index()
    {
        Trace = Trace * 10 + 2;
        return 0;
    }

    public int Right()
    {
        Trace = Trace * 10 + 3;
        Value = 100;
        Items[0] = 100;
        return 5;
    }

    public bool BooleanRight(bool value)
    {
        Trace = Trace * 10 + 3;
        return value;
    }
}

public static class Syntax
{
    public static int Arithmetic(int value, int operand)
    {
        value += operand;
        value -= 2;
        value *= 3;
        value /= 2;
        value %= 17;
        return value;
    }

    public static int AddAssignment(int value, int operand) => value += operand;

    public static int DivideAssignment(int value, int operand) => value /= operand;

    public static int RemainderAssignment(int value, int operand) => value %= operand;

    public static int LeftShiftAssignment(int value, int count) => value <<= count;

    public static int RightShiftAssignment(int value, int count) => value >>= count;

    public static int UnsignedShiftAssignment(int value, int count) => value >>>= count;

    public static int Bitwise(int value, int operand)
    {
        value &= operand;
        value |= 0x400;
        value ^= operand;
        return value;
    }

    public static int AssignmentValue(int left, int right)
    {
        int result = left += left = right;
        return result * 100 + left;
    }

    public static float FloatArithmetic(float value, float operand)
    {
        value += operand;
        value -= 1;
        value *= 2;
        value /= 4;
        return value;
    }

    public static double DoubleArithmetic(double value, double operand)
    {
        value += operand;
        value -= 1;
        value *= 2;
        value /= 4;
        return value;
    }

    public static float MixedArithmetic(float value, int operand)
    {
        value += operand;
        return value;
    }

    public static int BooleanEager(bool value)
    {
        var state = new SyntaxState();
        bool left = false;
        left &= state.BooleanRight(value);
        left |= state.BooleanRight(true);
        left ^= state.BooleanRight(value);
        return state.Trace * 10 + (left ? 1 : 0);
    }

    public static int FieldEvaluationOrder()
    {
        var state = new SyntaxState { Value = 7, Items = new int[] { 7 } };
        int result = state.Receiver().Value += state.Right();
        return state.Trace * 1000 + state.Value * 10 + result;
    }

    public static int ArrayEvaluationOrder()
    {
        var state = new SyntaxState { Value = 7, Items = new int[] { 7 } };
        int result = state.Collection()[state.Index()] += state.Right();
        return state.Trace * 1000 + state.Items[0] * 10 + result;
    }

    public static int NestedAssignment()
    {
        var items = new int[] { 2, 3 };
        items[0] += items[1] *= 4;
        return items[0] * 100 + items[1];
    }

    public static int NullCompoundOrder(int zero)
    {
        SyntaxState state = null;
        return state.Value += 1 / zero;
    }

    public static int NullArrayCompoundOrder(int zero)
    {
        int[] items = null;
        return items[0] += 1 / zero;
    }

    public static int BoundsCompoundOrder(int zero)
    {
        var items = new int[0];
        return items[0] += 1 / zero;
    }

    public static int IndexFaultBeforeNull(int zero)
    {
        int[] items = null;
        return items[1 / zero] += 1;
    }

    public static int ForeachSum(int length)
    {
        var items = new int[length];
        for (int i = 0; i < length; i++)
        {
            items[i] = i + 1;
        }

        int sum = 0;
        foreach (int item in items)
        {
            sum += item;
        }

        return sum;
    }

    public static int ForeachControl()
    {
        int sum = 0;
        foreach (var item in new int[] { 1, 2, 3, 4, 5 })
        {
            if (item == 2)
                continue;
            if (item == 5)
                break;

            sum += item;
        }

        return sum;
    }

    public static int ForeachNested()
    {
        int sum = 0;
        foreach (int outer in new int[] { 1, 2, 3 })
        {
            if (outer == 2)
                continue;

            foreach (int inner in new int[] { 1, 2, 3, 4 })
            {
                if (inner == 2)
                    continue;
                if (inner == 4)
                    break;

                sum += outer * 10 + inner;
            }
        }

        return sum;
    }

    public static int ForeachCollectionOnce()
    {
        var state = new SyntaxState { Items = new int[] { 1, 2, 3 } };
        int sum = 0;
        foreach (int item in state.Collection())
        {
            sum += item;
            state.Items = new int[] { 100 };
        }

        return state.Trace * 100 + sum;
    }

    public static int ForeachMutation()
    {
        var items = new int[] { 1, 2, 3 };
        int sum = 0;
        foreach (int item in items)
        {
            sum += item;
            items[1] = 20;
            items[2] = 30;
        }

        return sum;
    }

    public static int ForeachReferences()
    {
        var state = new SyntaxState { Value = 2 };
        var items = new SyntaxState[] { state, null, state };
        foreach (var item in items)
        {
            if (item != null)
                item.Value *= 3;
        }

        return state.Value;
    }

    public static int ForeachJagged()
    {
        var rows = new int[][] { new int[] { 1, 2 }, new int[0], new int[] { 3, 4 } };
        int sum = 0;
        foreach (int[] row in rows)
        {
            foreach (int item in row)
            {
                sum += item;
            }
        }

        return sum;
    }

    public static double ForeachWidening()
    {
        double sum = 0;
        foreach (double item in new int[] { 1, 2, 3 })
        {
            sum += item / 2;
        }

        return sum;
    }

    public static float ForeachFloatConversion()
    {
        float sum = 0;
        foreach (float item in new double[] { 1.5, 2.25, 3.125 })
        {
            sum += item;
        }

        return sum;
    }

    public static int ForeachBooleans()
    {
        int count = 0;
        foreach (bool item in new bool[] { true, false, true })
        {
            if (item)
                count++;
        }

        return count;
    }

    public static int ForeachEarlyReturn(int wanted)
    {
        foreach (int item in new int[] { 3, 7, 11 })
        {
            if (item == wanted)
                return item;
        }

        return -1;
    }

    public static int ForeachNull()
    {
        int[] items = null;
        foreach (int item in items)
        {
            return item;
        }

        return 0;
    }

    public static int ForeachFuel()
    {
        var items = new int[60_000];
        int sum = 0;
        foreach (int pass in new int[] { 1, 2 })
        {
            foreach (int item in items)
            {
                sum += item + pass;
            }
        }

        return sum;
    }
}
