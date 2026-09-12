// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Tests;

public sealed class Node
{
    public int Value;
    public Node Next;

    public int Bump()
    {
        Value++;
        return Value;
    }
}

public static class Cases
{
    public static int Add(int x, int y) => x + y;

    public static int IntNeg(int x) => -x;

    public static int Shift(int x, int y) => (x >> y) ^ (x >>> y);

    public static int Div(int x, int y) => x / y;

    public static int Rem(int x, int y) => x % y;

    public static float FloatMath(float x, float y) => x * y + 1.5f;

    public static double DoubleMath(int x, double y) => x + y;

    public static bool Compare(double x, double y) => x < y || x != y;

    public static bool BoolIdentity(bool b) => b;

    public static int Fib(int n) => n < 2 ? n : Fib(n - 1) + Fib(n - 2);

    public static int Infinite()
    {
        while (true)
        {
        }
    }

    public static int Recursion() => Recursion();

    public static int Loop(int n)
    {
        int total = 0;
        for (int i = 0; i < n; i++)
        {
            if (i == 2)
                continue;
            if (i == 6)
                break;

            total = total + i;
        }

        return total;
    }

    public static int WhileLoop(int n)
    {
        int i = 0;
        while (i < n)
        {
            i++;
            if (i == 3)
                break;
        }

        return i;
    }

    public static int GcFields(int x)
    {
        var tail = new Node { Value = x };
        var head = new Node { Value = 2, Next = tail };
        head.Next.Value = head.Next.Value + head.Value;
        return tail.Bump();
    }

    public static int GcArray(int n)
    {
        int[] array = new int[n];
        for (int i = 0; i < n; i++)
            array[i] = i;

        int sum = 0;
        for (int i = 0; i < array.Length; i++)
            sum = sum + array[i];

        return sum;
    }

    public static int ArrayInit()
    {
        var a = new int[] { 3, 5, 7 };
        return a[0] + a[2];
    }

    public static int ArrayRefs()
    {
        var nodes = new Node[2];
        nodes[1] = new Node { Value = 23 };
        return nodes[1].Value;
    }

    public static int Jagged()
    {
        var arrays = new int[1][];
        arrays[0] = new int[] { 17 };
        return arrays[0][0];
    }

    public static bool RefEquality()
    {
        var a = new Node();
        var b = a;
        return a == b && a != null;
    }

    public static bool RefInequality()
    {
        var a = new Node();
        var b = new Node();
        return a != b && null != a;
    }

    public static bool NullEquality()
    {
        Node a = null;
        return a == null && null == a;
    }

    public static bool ArrayEquality()
    {
        var a = new int[1];
        var b = a;
        return a == b && a != new int[1] && null != a;
    }

    public static int ShortCircuit()
    {
        var n = new Node();
        bool a = false && n.Bump() == 1;
        bool b = true || n.Bump() == 1;
        return n.Value;
    }

    private static int Digits(int left, int right) => left * 10 + right;

    public static int NamedArgumentOrder()
    {
        var n = new Node();
        return Digits(right: n.Bump(), left: n.Bump());
    }

    public static int PostIncrement()
    {
        var n = new Node { Value = 4 };
        int old = n.Value++;
        return old * 10 + n.Value;
    }

    public static int IndexEvaluatedOnce()
    {
        var n = new Node();
        var a = new int[] { 0, 9, 0 };
        int old = a[n.Bump()]++;
        return old * 100 + a[1] * 10 + n.Value;
    }

    public static int NullField()
    {
        Node n = null;
        return n.Value;
    }

    // The right-hand side must run before the invalid assignment traps.
    public static int NullAssignmentOrder(int zero)
    {
        Node n = null;
        n.Value = 1 / zero;
        return 0;
    }

    public static int BoundsAssignmentOrder(int zero)
    {
        var a = new int[1];
        a[2] = 1 / zero;
        return 0;
    }

    public static int Bounds(int i)
    {
        var a = new int[2];
        return a[i];
    }

    public static int NewLength(int n)
    {
        var a = new int[n];
        return a.Length;
    }

    // Locals no operation touches still need their heap types: a jagged
    // array type that appears nowhere else, in a block, a loop and a switch
    // section.
    public static int UnusedLocals(int n)
    {
        long[][] unused;
        for (int i = 0; i < n; i++)
        {
            float[][][] deeper;
        }

        switch (n)
        {
            case 1:
                ushort[][] section;
                return 2;
        }

        return 1;
    }

    public static int AllocateForever()
    {
        int n = 0;
        while (true)
        {
            var a = new int[1000];
            n = n + a.Length;
        }
    }
}
