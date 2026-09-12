// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.GenericTypes;

public sealed class Box<T>
{
    public T Value;

    public Box(T value) => Value = value;

    public T Get() => Value;

    public void Set(T value) => Value = value;

    public Box<T> Copy() => new Box<T>(Value);

    public Box<U> Map<U>(Func<T, U> function) => new Box<U>(function(Value));

    public T Stored { get; set; }
}

public sealed class Pair<TFirst, TSecond>
{
    public TFirst First;
    public TSecond Second;

    public Pair(TFirst first, TSecond second)
    {
        First = first;
        Second = second;
    }

    public Pair<TSecond, TFirst> Swap() => new Pair<TSecond, TFirst>(Second, First);
}

// A linked list over any element type, with field initializers run per
// instantiation.
public sealed class Chain<T>
{
    public sealed class Link
    {
        public T Item;
        public Link Next;
    }

    public Link Head;
    public int Count;
    public int Version = 1;

    public void Push(T item)
    {
        Head = new Link { Item = item, Next = Head };
        Count++;
        Version++;
    }

    public T[] ToArray()
    {
        var items = new T[Count];
        int index = 0;
        for (var link = Head; link != null; link = link.Next)
        {
            items[index++] = link.Item;
        }

        return items;
    }
}

public interface IShape
{
    int Area();
}

public interface IContainer<T>
{
    T Take();

    int Size { get; }
}

public interface ISource<T> : IContainer<T>
{
    void Put(T item);
}

public abstract class Store<T> : ISource<T>
{
    protected T[] items = new T[8];
    protected int count;

    public int Size => count;

    public virtual void Put(T item) => items[count++] = item;

    public abstract T Take();
}

public sealed class LastIn<T> : Store<T>
{
    public override T Take() => items[--count];
}

public sealed class FirstIn<T> : Store<T>
{
    private int next;

    public override void Put(T item)
    {
        base.Put(item);
    }

    public override T Take()
    {
        count--;
        return items[next++];
    }
}

// A non-generic class deriving from an instantiation.
public sealed class IntStore : Store<int>
{
    public override int Take() => items[--count] * 10;
}

// Two instantiations of one interface, one explicitly, one property
// implementing both.
public sealed class Dual : IContainer<int>, IContainer<long>
{
    int IContainer<int>.Take() => 1;

    long IContainer<long>.Take() => 2;

    public int Size => 3;
}

public class Square : IShape
{
    public int Side = 3;

    public virtual int Area() => Side * Side;
}

public sealed class BigSquare : Square
{
    public override int Area() => base.Area() * 100;
}

public sealed class Circle : IShape
{
    public int Area() => 7;
}

// Static state per instantiation, with an initializer and a static
// constructor of its own.
public static class Counter<T>
{
    public static int Count = 100;
    public static int Constructed;

    static Counter()
    {
        Constructed++;
    }

    public static int Next() => ++Count;
}

public delegate TResult Mapper<TIn, TResult>(TIn value);

public sealed class Node<T>
    where T : class
{
    public T Payload;
    public Node<T> Next;
}

public sealed class Factory<T>
    where T : Square, new()
{
    public T Make(int side)
    {
        var made = new T();
        made.Side = side;
        return made;
    }
}

public static class Generics
{
    private static T Identity<T>(T value) => value;

    private static T Choose<T>(bool first, T left, T right) => first ? left : right;

    private static int Total<T>(T[] shapes)
        where T : IShape
    {
        int total = 0;
        foreach (var shape in shapes)
        {
            total += shape.Area();
        }

        return total;
    }

    private static int AreaOf<T>(T shape)
        where T : class, IShape => shape == null ? -1 : shape.Area();

    private static bool IsNull<T>(T value) => value == null;

    private static T OrDefault<T>(bool present, T value) => present ? value : default;

    private static T[] Fill<T>(int count, T value)
    {
        var items = new T[count];
        for (int index = 0; index < count; index++)
        {
            items[index] = value;
        }

        return items;
    }

    private static void Reverse<T>(T[] items)
    {
        for (int left = 0, right = items.Length - 1; left < right; left++, right--)
        {
            T swap = items[left];
            items[left] = items[right];
            items[right] = swap;
        }
    }

    private static TResult Apply<TIn, TResult>(Mapper<TIn, TResult> mapper, TIn value) => mapper(value);

    private static Func<T> Constant<T>(T value) => () => value;

    private static Func<T, T> Twice<T>(Func<T, T> function) => value => function(function(value));

    private static T Cast<T>(Square shape)
        where T : Square => (T)shape;

    private static T As<T>(Square shape)
        where T : Square => shape as T;

    private static bool Is<T>(Square shape)
        where T : Square => shape is T;

    public static int Boxes(int value)
    {
        var number = new Box<int>(value);
        var wide = new Box<long>(value * 3L);
        var real = new Box<double>(value / 2.0);
        var flag = new Box<bool>(value > 0);
        number.Set(number.Get() + 1);
        number.Stored = 5;
        return number.Value * 1000 + (int)wide.Get() * 10 + (int)real.Value + (flag.Get() ? 7 : 0) + number.Stored;
    }

    public static int NestedBoxes(int value)
    {
        var inner = new Box<Box<int>>(new Box<int>(value));
        var copy = inner.Copy();
        copy.Value.Value += 5;
        var array = new Box<int[]>(new[] { value, value * 2 });
        var shape = new Box<IShape>(new Circle());
        Func<int, int> doubler = x => x * 2;
        var function = new Box<Func<int, int>>(doubler);
        return inner.Value.Value + array.Value[1] * 10 + shape.Value.Area() * 100 + function.Get()(value) * 1000;
    }

    public static int Pairs(int value)
    {
        var pair = new Pair<int, Box<long>>(value, new Box<long>(9));
        var swapped = pair.Swap();
        var mixed = new Pair<bool, double>(true, 2.5);
        return (int)swapped.First.Value * 100 + swapped.Second + (mixed.First ? (int)(mixed.Second * 2) : 0);
    }

    public static int GenericMethods(int value)
    {
        int number = Identity(value);
        long wide = Identity(7L);
        var box = Identity(new Box<int>(3));
        var chosen = Choose(value > 0, 1, 10);
        var mapped = new Box<int>(value).Map(x => x * 1.5);
        var mappedAgain = mapped.Map(x => x > 3);
        return number + (int)wide * 10 + box.Value * 100 + chosen * 1000 + (int)mapped.Value * 10000
            + (mappedAgain.Value ? 1 : 0);
    }

    public static int Chains(int count)
    {
        var numbers = new Chain<int>();
        var boxes = new Chain<Box<long>>();
        for (int index = 0; index < count; index++)
        {
            numbers.Push(index * index);
            boxes.Push(new Box<long>(index));
        }

        int total = 0;
        foreach (int item in numbers.ToArray())
        {
            total += item;
        }

        long wide = 0;
        foreach (var box in boxes.ToArray())
        {
            wide = wide * 10 + box.Value;
        }

        return total * 100000 + (int)(wide % 100000) + numbers.Version * 1000000;
    }

    public static int Stores(int value)
    {
        ISource<int> last = new LastIn<int>();
        ISource<int> first = new FirstIn<int>();
        IContainer<long> wide = new LastIn<long>();
        var store = new IntStore();
        for (int index = 1; index <= 3; index++)
        {
            last.Put(index * value);
            first.Put(index * value);
            store.Put(index);
        }

        ((ISource<long>)wide).Put(value * 4L);
        int result = last.Take() * 1000 + first.Take() * 100 + store.Take();
        return result + last.Size * 10000 + (int)wide.Take();
    }

    public static int DualInterfaces()
    {
        var dual = new Dual();
        IContainer<int> narrow = dual;
        IContainer<long> wide = dual;
        return narrow.Take() * 100 + (int)wide.Take() * 10 + narrow.Size + wide.Size
            + (wide is IContainer<int> ? 1000 : 0);
    }

    public static int Constraints(int side)
    {
        var shapes = new IShape[] { new Square(), new Circle(), new BigSquare() };
        var squares = new Square[] { new Square { Side = side }, new BigSquare() };
        var factory = new Factory<BigSquare>();
        var made = factory.Make(side);
        return Total(shapes) + Total(squares) * 10 + AreaOf<Square>(null) + AreaOf(new Circle()) * 1000
            + made.Area() * 100000;
    }

    public static int Casts(int kind)
    {
        Square shape = kind switch
        {
            0 => new Square(),
            1 => new BigSquare(),
            _ => null,
        };
        int result = (Is<BigSquare>(shape) ? 1 : 0) + (As<BigSquare>(shape) == null ? 10 : 20);
        result += Cast<Square>(shape) == null ? 100 : 200;
        return result + (kind == 1 ? Cast<BigSquare>(shape).Area() * 1000 : 0);
    }

    public static int BadCast() => Cast<BigSquare>(new Square()).Side;

    public static int Defaults(int value)
    {
        int number = OrDefault(value > 0, value);
        double real = OrDefault(value > 0, 2.5);
        var box = OrDefault(value > 0, new Box<int>(4));
        bool flag = OrDefault(true, value > 0);
        return number + (int)(real * 10) * 100 + (box == null ? 0 : box.Value * 10000) + (flag ? 100000 : 0)
            + (IsNull(value) ? 1000000 : 0) + (IsNull<Box<int>>(null) ? 2000000 : 0) + (IsNull(box) ? 4000000 : 0);
    }

    public static int Arrays(int count)
    {
        var numbers = Fill(count, 3);
        var boxes = Fill(count, new Box<int>(2));
        Reverse(numbers);
        numbers[0] = 9;
        Reverse(numbers);
        int total = 0;
        foreach (var number in numbers)
        {
            total += number;
        }

        boxes[0].Value = 5;
        return total * 100 + (count > 0 ? boxes[count - 1].Value : 0);
    }

    public static int StaticsPerInstantiation(int step)
    {
        int result = 0;
        for (int index = 0; index < step; index++)
        {
            result = Counter<int>.Next();
        }

        int other = Counter<long>.Next();
        int third = Counter<Box<int>>.Next();
        return result * 10000 + other * 10 + third / 100 + Counter<int>.Constructed + Counter<bool[]>.Count;
    }

    public static int Delegates(int value)
    {
        Mapper<int, long> widen = x => x * 1000L;
        Mapper<Box<int>, int> unbox = box => box.Value;
        var constant = Constant(value);
        var boxConstant = Constant(new Box<int>(value + 1));
        var quad = Twice<int>(x => x * 2);
        var wrap = Twice<Box<int>>(box => new Box<int>(box.Value + 3));
        return (int)Apply(widen, value) + Apply(unbox, new Box<int>(7)) + constant() * 3 + boxConstant().Value
            + quad(value) * 100 + wrap(new Box<int>(0)).Value * 7;
    }

    public static int Closures(int value)
    {
        var counters = new Func<int>[3];
        for (int index = 0; index < counters.Length; index++)
        {
            counters[index] = Accumulate(index, value);
        }

        var longCounter = Accumulate(5L, 2L);
        counters[1]();
        longCounter();
        return counters[0]() * 10000 + counters[1]() * 100 + counters[2]() + (int)longCounter();
    }

    private static Func<int> Accumulate<T>(T start, T step)
    {
        T current = start;
        int calls = 0;
        return () =>
        {
            calls++;
            current = Choose(calls % 2 == 0, step, current);
            return calls;
        };
    }

    public static int LocalFunctions(int value)
    {
        T Pick<T>(bool first, T left, T right) => first ? left : right;
        int Depth<T>(T[] items, int remaining) => remaining == 0 ? items.Length : Depth(items, remaining - 1) + 1;
        var box = Pick(value > 0, new Box<int>(1), new Box<int>(2));
        return Pick(value > 3, 100, 200) + (int)Pick(false, 1L, 2L) * 1000 + box.Value * 10
            + Depth(new long[3], 4) * 100000;
    }

    public static int Nodes(int count)
    {
        Node<Box<int>> head = null;
        for (int index = 0; index < count; index++)
        {
            head = new Node<Box<int>> { Payload = new Box<int>(index), Next = head };
        }

        int total = 0;
        for (var node = head; node != null; node = node.Next)
        {
            total = total * 3 + node.Payload.Value;
        }

        return total;
    }
}
