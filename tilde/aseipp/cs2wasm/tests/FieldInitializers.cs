// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Tests;

public sealed class InitializedLeaf
{
    public int Value = 7;
    public int DefaultValue;
    public int[] Items = new int[] { 2, 4, 6 };
}

public sealed class InitializedValues
{
    public int First = 2, Second = 3;
    public bool Enabled = true;
    public float Scale = 1.5f;
    public double Amount = 2.25;
    public InitializedLeaf Leaf = new InitializedLeaf { Value = 9 };
    public InitializedLeaf Missing;
    public int[] Items = InitializerHelpers.CreateItems();
    // This temporary array type appears only in an initializer expression.
    public bool ArrayExists = new InitializedLeaf[1] != null;
}

public sealed class InitializedConstructor
{
    public int Value = InitializerHelpers.Seven();
    public int DefaultValue;
    public InitializedLeaf Missing;

    public InitializedConstructor(int argument)
    {
        if (argument < 0)
            return;

        Value = Value * 10 + argument;
        if (DefaultValue != 0 || Missing != null)
            Value = -1;
    }

    public InitializedConstructor(bool ignored) => Value = Value + 2;
}

internal static class InitializerHelpers
{
    internal static int Seven() => 7;

    internal static int[] CreateItems() => new int[] { 10, 20 };

    internal static int DivideByZero()
    {
        int zero = 0;
        return 1 / zero;
    }

    internal static int ReadNull()
    {
        InitializedLeaf missing = null;
        return missing.Value;
    }

    internal static int NeverFinish()
    {
        while (true)
        {
        }
    }
}

public sealed class DivideFirstInitializer
{
    public int First = InitializerHelpers.DivideByZero();
    public int Second = InitializerHelpers.ReadNull();

    public DivideFirstInitializer(int ignored) => First = new int[-ignored].Length;
}

public sealed class NullFirstInitializer
{
    public int First = InitializerHelpers.ReadNull(), Second = InitializerHelpers.DivideByZero();
}

public sealed class RecursiveInitializer
{
    public RecursiveInitializer Next = new RecursiveInitializer();
}

public sealed class ExplicitRecursiveInitializer
{
    public ExplicitRecursiveInitializer Next = new ExplicitRecursiveInitializer();

    public ExplicitRecursiveInitializer()
    {
    }
}

public sealed class InfiniteInitializer
{
    public int Value = InitializerHelpers.NeverFinish();
}

public static class FieldInitializers
{
    public static int Healthy() => 42;

    public static int ImplicitConstructor()
    {
        var leaf = new InitializedLeaf();
        return leaf.Value * 100 + leaf.Items[1] * 10 + leaf.DefaultValue;
    }

    public static double TypedInitializers()
    {
        var values = new InitializedValues();
        if (!values.Enabled || values.Missing != null || !values.ArrayExists)
            return -1;

        return values.First + values.Second + values.Scale + values.Amount
            + values.Leaf.Value + values.Items[1];
    }

    public static int FreshReferences()
    {
        var left = new InitializedValues();
        var right = new InitializedValues();
        left.Leaf.Value = 99;
        left.Items[0] = 100;
        if (left.Leaf == right.Leaf || left.Items == right.Items)
            return -1;

        return right.Leaf.Value * 10 + right.Items[0];
    }

    public static int ExplicitConstructor(int value) => new InitializedConstructor(value).Value;

    public static int ExpressionConstructor() => new InitializedConstructor(true).Value;

    public static int ObjectInitializer(int value) => new InitializedConstructor(3) { Value = value }.Value;

    public static int DeclarationOrder(int value) => new DivideFirstInitializer(value).First;

    public static int MultiDeclarationOrder() => new NullFirstInitializer().First;

    public static int ArgumentBeforeInitializer(int zero) => new DivideFirstInitializer(1 / zero).First;

    public static int NullArgumentBeforeInitializer() => new DivideFirstInitializer(InitializerHelpers.ReadNull()).First;

    public static int InitializerBeforeObjectInitializer()
        => new DivideFirstInitializer(0) { First = InitializerHelpers.ReadNull() }.First;

    public static int ImplicitRecursiveDepth() => new RecursiveInitializer().Next == null ? 0 : 1;

    public static int ExplicitRecursiveDepth() => new ExplicitRecursiveInitializer().Next == null ? 0 : 1;

    public static int InitializerFuel() => new InfiniteInitializer().Value;
}
