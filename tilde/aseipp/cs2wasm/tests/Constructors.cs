namespace Tests;

public sealed class ConstructorCounter
{
    public int Value;

    public int Bump() => ++Value;
}

public sealed class ConstructedNode
{
    public int Value;
    public ConstructedNode Next;
    public int[] Items;
    public double Amount;

    public ConstructedNode()
    {
        // Every field must be initialized before the constructor runs.
        if (Value == 0 && Next == null && Items == null && Amount == 0)
            Value = 42;
    }

    public ConstructedNode(int value)
    {
        if (value < 0)
            return;

        AddValue(value);
    }

    public ConstructedNode(int left, int right) => Value = left * 10 + right;

    public ConstructedNode(int value, ConstructedNode next)
    {
        Value = value;
        Next = next;
    }

    public ConstructedNode(ConstructorCounter counter) => Value = counter.Bump();

    public ConstructedNode(int numerator, bool divide) => Value = divide ? 1 / numerator : numerator;

    public ConstructedNode(double scale, float offset, bool positive, int[] values)
        => Amount = scale * offset + (positive ? values[0] : values[1]);

    private void AddValue(int value) => Value = Value + value;
}

public sealed class RecursiveConstruction
{
    public RecursiveConstruction Next;

    public RecursiveConstruction(int remaining)
    {
        if (remaining > 0)
            Next = new RecursiveConstruction(remaining - 1);
    }
}

public sealed class ConstructorWork
{
    public int[] Items;

    public ConstructorWork(bool allocate)
    {
        while (true)
        {
            if (allocate)
                Items = new int[1000];
        }
    }
}

public static class Constructors
{
    public static int DefaultFields() => new ConstructedNode().Value;

    public static int HelperCall() => new ConstructedNode(42).Value;

    public static int EarlyReturn() => new ConstructedNode(-1).Value;

    public static int ImplicitDefault() => new ConstructorCounter().Value;

    public static double TypedArguments(bool positive)
        => new ConstructedNode(2.0, 1.5f, positive, new int[] { 39, 0 }).Amount;

    public static int NestedAllocation()
    {
        var head = new ConstructedNode(1, new ConstructedNode(2, new ConstructedNode(3, null)));
        return head.Value + head.Next.Value + head.Next.Next.Value;
    }

    public static int PositionalArgumentOrder()
    {
        var counter = new ConstructorCounter();
        var node = new ConstructedNode(counter.Bump(), counter.Bump());
        return node.Value * 10 + counter.Value;
    }

    public static int NamedArgumentOrder()
    {
        var counter = new ConstructorCounter();
        var node = new ConstructedNode(right: counter.Bump(), left: counter.Bump());
        return node.Value * 10 + counter.Value;
    }

    public static int InitializerAfterBody()
    {
        var counter = new ConstructorCounter();
        var node = new ConstructedNode(counter) { Value = counter.Bump() };
        return node.Value * 10 + counter.Value;
    }

    public static int ArgumentFaultBeforeAllocation(int zero) => new ConstructedNode(1 / zero).Value;

    public static int BodyFaultBeforeInitializer(int zero)
    {
        var node = new ConstructedNode(zero, true) { Value = new ConstructedNode().Next.Value };
        return node.Value;
    }

    public static int RecursiveDepth(int depth)
    {
        var node = new RecursiveConstruction(depth);
        int count = 0;
        while (node.Next != null)
        {
            node = node.Next;
            count++;
        }

        return count;
    }

    public static int ExhaustFuel()
    {
        var work = new ConstructorWork(false);
        return 0;
    }

    public static int ExhaustAllocation()
    {
        var work = new ConstructorWork(true);
        return 0;
    }
}
