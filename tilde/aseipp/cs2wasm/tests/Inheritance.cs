// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Tests;

public abstract class Shape
{
    public int Id;
    public int Scale = 1;

    protected Shape(int id) => Id = id;

    public abstract int Area();

    public virtual int Sides => 0;

    public virtual int Speed { get; set; }

    // A non-virtual method calling virtual ones.
    public int Describe() => Area() * 100 + Sides;
}

public class Rectangle : Shape
{
    public int Width;
    public int Height;

    public Rectangle(int width, int height) : base(1)
    {
        Width = width;
        Height = height;
    }

    public override int Area() => Width * Height * Scale;

    public override int Sides => 4;

    public override int Speed
    {
        get => base.Speed * 2;
        set => base.Speed = value + 1;
    }
}

public sealed class Square : Rectangle
{
    public Square(int side) : this(side, 0)
    {
    }

    private Square(int side, int unused) : base(side, side + unused)
    {
    }

    public override int Area() => base.Area() + 1;
}

public class Circle : Shape
{
    public int Radius;

    public Circle(int radius) : base(2) => Radius = radius;

    public sealed override int Area() => 3 * Radius * Radius;
}

public sealed class Ring : Circle
{
    public int Inner;

    public Ring(int radius, int inner) : base(radius) => Inner = inner;

    public override int Sides => -1;
}

// C# runs a class's field initializers, then its base constructor, then its
// own constructor body; a virtual call from the base constructor already
// reaches the override, which sees the derived initializers but not the body.
public static class ConstructionLog
{
    public static int Digits;

    public static int Mark(int digit)
    {
        Digits = Digits * 10 + digit;
        return digit;
    }
}

public class OrderBase
{
    public int First = ConstructionLog.Mark(1);
    public int Seen;

    public OrderBase()
    {
        ConstructionLog.Mark(2);
        Seen = Probe();
    }

    public virtual int Probe() => 7;
}

public sealed class OrderDerived : OrderBase
{
    public int Second = ConstructionLog.Mark(3);
    public int Body;

    public OrderDerived()
    {
        ConstructionLog.Mark(4);
        Body = 5;
    }

    public override int Probe() => Second * 10 + Body;
}

// No constructor of its own: the implicit one runs the initializer and the
// base constructor.
public sealed class OrderLeaf : OrderBase
{
    public int Third = ConstructionLog.Mark(6);
}

public class Animal
{
    public int Legs() => 4;

    public virtual int Sound() => 1;
}

public class Bird : Animal
{
    public new int Legs() => 2;

    public new virtual int Sound() => 2;
}

public sealed class Parrot : Bird
{
    public override int Sound() => 3;
}

public abstract class ListNode
{
    public abstract int Sum();

    public abstract int Count { get; }
}

public sealed class Cons : ListNode
{
    public int Head;
    public ListNode Tail;

    public Cons(int head, ListNode tail)
    {
        Head = head;
        Tail = tail;
    }

    public override int Sum() => Head + Tail.Sum();

    public override int Count => 1 + Tail.Count;
}

public sealed class Nil : ListNode
{
    public override int Sum() => 0;

    public override int Count => 0;
}

// An explicit `: base()` to object, beside a property.
public sealed class ExplicitObjectBase
{
    public int X { get; set; }

    public ExplicitObjectBase() : base()
    {
        X = 3;
    }
}

public static class Inheritance
{
    private static Shape Make(int kind) => kind switch
    {
        0 => new Circle(2),
        1 => new Rectangle(2, 3),
        2 => new Square(3),
        3 => new Ring(1, 0),
        _ => null,
    };

    public static int Areas()
    {
        Shape[] shapes = { new Circle(1), new Rectangle(2, 3), new Square(2), new Ring(2, 1) };
        int total = 0;
        foreach (Shape shape in shapes)
            total = total * 100 + shape.Area();
        return total;
    }

    public static int Describe(int kind) => Make(kind).Describe();

    public static int BaseFields(int kind)
    {
        var shape = Make(kind);
        shape.Scale = 2;
        return shape.Id * 1000 + shape.Area();
    }

    public static int VirtualProperty(int value)
    {
        Shape rectangle = new Rectangle(1, 1);
        Shape circle = new Circle(1);
        rectangle.Speed = value;
        circle.Speed = value;
        return rectangle.Speed * 1000 + circle.Speed;
    }

    public static int ConstructorOrder()
    {
        ConstructionLog.Digits = 0;
        var derived = new OrderDerived();
        return ConstructionLog.Digits * 1000 + derived.Seen * 10 + derived.Body;
    }

    public static int ImplicitConstructorOrder()
    {
        ConstructionLog.Digits = 0;
        var leaf = new OrderLeaf();
        return ConstructionLog.Digits * 100 + leaf.Seen;
    }

    public static int Hiding()
    {
        Parrot parrot = new Parrot();
        Animal animal = parrot;
        Bird bird = parrot;
        return animal.Legs() * 1000 + animal.Sound() * 100 + bird.Legs() * 10 + bird.Sound();
    }

    public static int Recursion(int length)
    {
        ListNode list = new Nil();
        for (int index = 1; index <= length; index++)
            list = new Cons(index, list);
        return list.Sum() * 100 + list.Count;
    }

    public static int Downcast(int kind) => ((Rectangle)Make(kind)).Width;

    public static int NullDowncast() => (Rectangle)Make(9) == null ? 1 : 0;

    public static int As(int kind)
    {
        var rectangle = Make(kind) as Rectangle;
        return rectangle == null ? -1 : rectangle.Height;
    }

    public static int IsType(int kind)
    {
        var shape = Make(kind);
        return (shape is Rectangle ? 1 : 0) + (shape is Square ? 10 : 0) + (shape is Circle ? 100 : 0);
    }

    public static int IsPattern(int kind)
    {
        var shape = Make(kind);
        if (shape is Square square)
            return square.Width * 10;
        if (shape is Circle circle && circle.Radius > 1)
            return circle.Radius;
        return shape is not Rectangle ? -1 : -2;
    }

    public static int SwitchExpression(int kind) => Make(kind) switch
    {
        Square square => square.Area(),
        Rectangle rectangle when rectangle.Width > 1 => rectangle.Width + 100,
        Ring => 3,
        Circle circle => circle.Radius + 200,
        null => -1,
        _ => 0,
    };

    public static int SwitchStatement(int kind)
    {
        switch (Make(kind))
        {
            case Ring ring:
                return ring.Inner - 5;
            case Circle circle:
                return circle.Radius;
            case Rectangle:
                return 4;
            default:
                return -1;
        }
    }

    public static int NullReceiver()
    {
        Shape shape = Make(9);
        return shape.Area();
    }

    public static int ObjectInitializer()
    {
        var rectangle = new Rectangle(2, 2) { Id = 9, Width = 5 };
        return rectangle.Id * 100 + rectangle.Area();
    }

    public static int ExplicitObjectBaseConstructor() => new ExplicitObjectBase().X;
}
