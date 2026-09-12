// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// `new` of a struct, made in place where its constructor only stores its
// arguments and constants, or assigns a factory's value to `this`
// (Frontend.Construction), and made through its constructor otherwise:
// every shape against the CLR, and (compiled with --alloc-units 16 in the
// behavior suite) the in-place ones in loops that would exhaust that
// budget if each value were a box.
using System;
using System.Collections.Generic;
using System.Numerics;

namespace Tests.Construction
{
    public struct Stored
    {
        public int A;
        public long B;
        public double C;
        public string Name;

        public Stored(double c, int a, string name)
        {
            // Out of the fields' order, one left at zero.
            C = c;
            Name = name;
            A = a;
        }
    }

    public struct Constants
    {
        public int A;
        public float B;
        public bool C;
        public long D;
        public string E;

        public Constants(int a)
        {
            this = default;
            A = a;
            B = 2.5f;
            C = true;
            E = null;
        }
    }

    public struct Built
    {
        public float X;
        public float Y;

        public Built(float x, float y)
        {
            this = Make(x, y);
        }

        public static Built Make(float x, float y) => new Built { X = x * 2, Y = y + 1 };
    }

    public readonly record struct Pair(int Left, string Right);

    public struct Holder<T>
    {
        public T Value;
        public int Count;

        public Holder(T value, int count)
        {
            Value = value;
            Count = count;
        }
    }

    public struct Nested
    {
        public Stored Inner;
        public int Tag;

        public Nested(Stored inner, int tag)
        {
            Inner = inner;
            Tag = tag;
        }
    }

    // Not in place: its constructor computes.
    public struct Computed
    {
        public int Value;

        public Computed(int value)
        {
            Value = value * 3 + 1;
        }
    }

    // Not in place: making one is what initializes the type.
    public struct Initialized
    {
        public static int Made;
        public int Value;

        static Initialized()
        {
            Made = 100;
        }

        public Initialized(int value)
        {
            Value = value;
        }
    }

    public static class Construction
    {
        public static int Fields(int x)
        {
            var stored = new Stored(x * 0.5, x + 1, "n" + x);
            return stored.A * 1000 + (int)stored.B * 100 + (int)(stored.C * 10) + stored.Name.Length;
        }

        public static int ConstantFields(int x)
        {
            var value = new Constants(x);
            return value.A * 100 + (int)(value.B * 10) + (value.C ? 1 : 0) + (int)value.D + (value.E is null ? 7 : 0);
        }

        public static int Factory(int x)
        {
            var built = new Built(x, x - 1);
            return (int)(built.X * 10 + built.Y);
        }

        public static int Records(int x)
        {
            var pair = new Pair(x, "r" + x);
            var other = pair with { Left = x + 1 };
            return pair.Left * 100 + pair.Right.Length * 10 + (pair == other ? 1 : 0) + other.Left;
        }

        public static int Generic(int x)
        {
            var numbers = new Holder<int>(x, 2);
            var words = new Holder<string>("w" + x, 3);
            return numbers.Value * numbers.Count + words.Value.Length * words.Count;
        }

        public static int NestedValues(int x)
        {
            var nested = new Nested(new Stored(1.5, x, "abc"), x * 2);
            return nested.Inner.A + nested.Tag * 10 + nested.Inner.Name.Length * 100;
        }

        public static int Tuples(int x)
        {
            var tuple = (x, "t", 2.0);
            var pairs = new List<KeyValuePair<int, int>> { new KeyValuePair<int, int>(x, x * 2) };
            return tuple.Item1 + tuple.Item2.Length * 10 + (int)tuple.Item3 * 100 + pairs[0].Value;
        }

        public static int Numerics(int x)
        {
            var sum = Vector2.Zero;
            for (int index = 0; index < 5; index++)
            {
                sum += new Vector2(index, x) * 0.5f;
            }

            var three = new Vector3(x, 1, 2);
            return (int)(sum.X * 100 + sum.Y + three.Length());
        }

        public static int ComputedValue(int x) => new Computed(x).Value;

        public static int StaticConstructor(int x)
        {
            var made = new Initialized(x);
            return Initialized.Made + made.Value;
        }

        // In loops of a thousand: made in place, nothing allocated.
        public static int ManyVectors(int count)
        {
            var sum = Vector2.Zero;
            for (int index = 0; index < count; index++)
            {
                sum += new Vector2(index, 1) * 0.5f;
            }

            return (int)sum.X;
        }

        public static int ManyStructs(int count)
        {
            long total = 0;
            for (int index = 0; index < count; index++)
            {
                var stored = new Stored(index, index, null);
                var pair = new Pair(index, null);
                var tuple = (index, index * 2);
                total += stored.A + pair.Left + tuple.Item2;
            }

            return (int)total;
        }

        // `in` arguments of locals, which the callee takes as values: a
        // local passed `in` needs no box, so a function doing it allocates
        // nothing each time it is called.
        private static float Length(in Vector3 vector) => vector.X * vector.X + vector.Y * vector.Y + vector.Z * vector.Z;

        private static long Weigh(in Stored stored, in int scale) => stored.A * scale + (long)stored.C;

        private static float Step(int index)
        {
            var vector = new Vector3(index, 1, 2);
            int scale = index % 7;
            var stored = new Stored(index * 0.5, index, null);
            return Length(in vector) + Length(vector) + Weigh(in stored, in scale) + Weigh(stored, scale);
        }

        public static int ManyInArguments(int count)
        {
            float total = 0;
            for (int index = 0; index < count; index++)
            {
                total += Step(index);
            }

            return (int)(total / 1000);
        }

        public static int ManySines(int count)
        {
            float total = 0;
            for (int index = 0; index < count; index++)
            {
                total += MathF.Sin(index * 0.1f) + MathF.Cos(index * 0.2f) + MathF.Exp(-index * 0.01f);
            }

            return (int)(total * 1000);
        }
    }
}
