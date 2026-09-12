// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Interlocked, Monitor and Volatile for a module's one thread: what C#
// lowers field-like events (Interlocked.CompareExchange) and `lock`
// (Monitor.Enter and Exit) to, with nothing to synchronize. Monitor.Wait,
// Pulse and IsEntered, which need a second thread or lock ownership, stay
// out.

using Gameplay.Runtime;

namespace System.Threading
{
    public static partial class Interlocked
    {
        public static int Add(ref int location1, int value) => location1 += value;

        public static long Add(ref long location1, long value) => location1 += value;

        public static uint Add(ref uint location1, uint value) => location1 += value;

        public static ulong Add(ref ulong location1, ulong value) => location1 += value;

        public static int And(ref int location1, int value) => Swap(ref location1, location1 & value);

        public static long And(ref long location1, long value) => Swap(ref location1, location1 & value);

        public static uint And(ref uint location1, uint value) => Swap(ref location1, location1 & value);

        public static ulong And(ref ulong location1, ulong value) => Swap(ref location1, location1 & value);

        public static int Or(ref int location1, int value) => Swap(ref location1, location1 | value);

        public static long Or(ref long location1, long value) => Swap(ref location1, location1 | value);

        public static uint Or(ref uint location1, uint value) => Swap(ref location1, location1 | value);

        public static ulong Or(ref ulong location1, ulong value) => Swap(ref location1, location1 | value);

        public static int Increment(ref int location) => ++location;

        public static long Increment(ref long location) => ++location;

        public static uint Increment(ref uint location) => ++location;

        public static ulong Increment(ref ulong location) => ++location;

        public static int Decrement(ref int location) => --location;

        public static long Decrement(ref long location) => --location;

        public static uint Decrement(ref uint location) => --location;

        public static ulong Decrement(ref ulong location) => --location;

        public static byte Exchange(ref byte location1, byte value) => Swap(ref location1, value);

        public static sbyte Exchange(ref sbyte location1, sbyte value) => Swap(ref location1, value);

        public static short Exchange(ref short location1, short value) => Swap(ref location1, value);

        public static ushort Exchange(ref ushort location1, ushort value) => Swap(ref location1, value);

        public static int Exchange(ref int location1, int value) => Swap(ref location1, value);

        public static uint Exchange(ref uint location1, uint value) => Swap(ref location1, value);

        public static long Exchange(ref long location1, long value) => Swap(ref location1, value);

        public static ulong Exchange(ref ulong location1, ulong value) => Swap(ref location1, value);

        public static float Exchange(ref float location1, float value) => Swap(ref location1, value);

        public static double Exchange(ref double location1, double value) => Swap(ref location1, value);

        public static object Exchange(ref object location1, object value) => Swap(ref location1, value);

        public static T Exchange<T>(ref T location1, T value) => Swap(ref location1, value);

        public static byte CompareExchange(ref byte location1, byte value, byte comparand) =>
            location1 == comparand ? Swap(ref location1, value) : location1;

        public static sbyte CompareExchange(ref sbyte location1, sbyte value, sbyte comparand) =>
            location1 == comparand ? Swap(ref location1, value) : location1;

        public static short CompareExchange(ref short location1, short value, short comparand) =>
            location1 == comparand ? Swap(ref location1, value) : location1;

        public static ushort CompareExchange(ref ushort location1, ushort value, ushort comparand) =>
            location1 == comparand ? Swap(ref location1, value) : location1;

        public static int CompareExchange(ref int location1, int value, int comparand) =>
            location1 == comparand ? Swap(ref location1, value) : location1;

        public static uint CompareExchange(ref uint location1, uint value, uint comparand) =>
            location1 == comparand ? Swap(ref location1, value) : location1;

        public static long CompareExchange(ref long location1, long value, long comparand) =>
            location1 == comparand ? Swap(ref location1, value) : location1;

        public static ulong CompareExchange(ref ulong location1, ulong value, ulong comparand) =>
            location1 == comparand ? Swap(ref location1, value) : location1;

        // Bit patterns, as .NET compares them: a NaN matches a NaN of its
        // bits, 0 does not match -0.
        public static float CompareExchange(ref float location1, float value, float comparand) =>
            BitConverter.SingleToInt32Bits(location1) == BitConverter.SingleToInt32Bits(comparand) ? Swap(ref location1, value) : location1;

        public static double CompareExchange(ref double location1, double value, double comparand) =>
            BitConverter.DoubleToInt64Bits(location1) == BitConverter.DoubleToInt64Bits(comparand) ? Swap(ref location1, value) : location1;

        public static object CompareExchange(ref object location1, object value, object comparand) =>
            ReferenceEquals(location1, comparand) ? Swap(ref location1, value) : location1;

        public static T CompareExchange<T>(ref T location1, T value, T comparand) =>
            Intrinsics.Equal(location1, comparand) ? Swap(ref location1, value) : location1;

        public static long Read(ref readonly long location) => location;

        public static ulong Read(ref readonly ulong location) => location;

        public static void MemoryBarrier()
        {
        }

        public static void MemoryBarrierProcessWide()
        {
        }

        private static T Swap<T>(ref T location, T value)
        {
            T original = location;
            location = value;
            return original;
        }
    }

    public static partial class Monitor
    {
        public static void Enter(object obj)
        {
            if (obj == null)
            {
                throw new ArgumentNullException(nameof(obj));
            }
        }

        public static void Enter(object obj, ref bool lockTaken)
        {
            if (lockTaken)
            {
                throw new ArgumentException("The lockTaken argument must be set to false before calling this method.", nameof(lockTaken));
            }

            Enter(obj);
            lockTaken = true;
        }

        public static void Exit(object obj)
        {
            if (obj == null)
            {
                throw new ArgumentNullException(nameof(obj));
            }
        }

        public static bool TryEnter(object obj)
        {
            Enter(obj);
            return true;
        }

        public static void TryEnter(object obj, ref bool lockTaken) => Enter(obj, ref lockTaken);

        public static bool TryEnter(object obj, int millisecondsTimeout)
        {
            if (millisecondsTimeout < -1)
            {
                throw new ArgumentOutOfRangeException(nameof(millisecondsTimeout));
            }

            return TryEnter(obj);
        }

        public static void TryEnter(object obj, int millisecondsTimeout, ref bool lockTaken)
        {
            if (millisecondsTimeout < -1)
            {
                throw new ArgumentOutOfRangeException(nameof(millisecondsTimeout));
            }

            Enter(obj, ref lockTaken);
        }
    }

    // SpinWait with nothing to wait for: each spin only counts.
    public struct SpinWait
    {
        private int count;

        public readonly int Count => count;

        public readonly bool NextSpinWillYield => count >= 10;

        public void SpinOnce() => count = count == int.MaxValue ? 10 : count + 1;

        public void SpinOnce(int sleep1Threshold)
        {
            if (sleep1Threshold < -1)
            {
                throw new ArgumentOutOfRangeException(nameof(sleep1Threshold));
            }

            SpinOnce();
        }

        public void Reset() => count = 0;
    }

    public static partial class Volatile
    {
        public static bool Read(ref readonly bool location) => location;

        public static byte Read(ref readonly byte location) => location;

        public static sbyte Read(ref readonly sbyte location) => location;

        public static short Read(ref readonly short location) => location;

        public static ushort Read(ref readonly ushort location) => location;

        public static int Read(ref readonly int location) => location;

        public static uint Read(ref readonly uint location) => location;

        public static long Read(ref readonly long location) => location;

        public static ulong Read(ref readonly ulong location) => location;

        public static float Read(ref readonly float location) => location;

        public static double Read(ref readonly double location) => location;

        public static T Read<T>(ref readonly T location)
            where T : class? => location;

        public static void Write(ref bool location, bool value) => location = value;

        public static void Write(ref byte location, byte value) => location = value;

        public static void Write(ref sbyte location, sbyte value) => location = value;

        public static void Write(ref short location, short value) => location = value;

        public static void Write(ref ushort location, ushort value) => location = value;

        public static void Write(ref int location, int value) => location = value;

        public static void Write(ref uint location, uint value) => location = value;

        public static void Write(ref long location, long value) => location = value;

        public static void Write(ref ulong location, ulong value) => location = value;

        public static void Write(ref float location, float value) => location = value;

        public static void Write(ref double location, double value) => location = value;

        public static void Write<T>([System.Diagnostics.CodeAnalysis.NotNullIfNotNull(nameof(value))] ref T location, T value)
            where T : class? => location = value;
    }
}
