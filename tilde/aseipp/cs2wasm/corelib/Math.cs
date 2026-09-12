// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Math's integer members with bodies here (the rest stay .NET's, which the
// importer implements), and the internal members dotnet/runtime's sources
// call. X86Base stands in, unsupported, for the x64 division
// dotnet-runtime/UInt128.cs asks for.

using Gameplay.Runtime;

namespace System
{
    [Surface]
    public static partial class Math
    {
        public static long BigMul(int a, int b) => (long)a * b;

        public static ulong BigMul(uint a, uint b) => (ulong)a * b;

        public static ulong BigMul(ulong a, ulong b, out ulong low)
        {
            low = a * b;
            ulong aLow = (uint)a;
            ulong aHigh = a >> 32;
            ulong bLow = (uint)b;
            ulong bHigh = b >> 32;
            ulong lowLow = aLow * bLow;
            ulong highLow = aHigh * bLow + (lowLow >> 32);
            ulong lowHigh = aLow * bHigh + (uint)highLow;
            return aHigh * bHigh + (highLow >> 32) + (lowHigh >> 32);
        }

        public static long BigMul(long a, long b, out long low)
        {
            ulong high = BigMul((ulong)a, (ulong)b, out ulong unsignedLow);
            low = (long)unsignedLow;
            return (long)high - ((a >> 63) & b) - ((b >> 63) & a);
        }

        public static UInt128 BigMul(ulong a, ulong b)
        {
            ulong high = BigMul(a, b, out ulong low);
            return new UInt128(high, low);
        }

        public static Int128 BigMul(long a, long b)
        {
            long high = BigMul(a, b, out long low);
            return new Int128((ulong)high, (ulong)low);
        }

        public static (sbyte Quotient, sbyte Remainder) DivRem(sbyte left, sbyte right)
        {
            sbyte quotient = (sbyte)(left / right);
            return (quotient, (sbyte)(left - quotient * right));
        }

        public static (byte Quotient, byte Remainder) DivRem(byte left, byte right)
        {
            byte quotient = (byte)(left / right);
            return (quotient, (byte)(left - quotient * right));
        }

        public static (short Quotient, short Remainder) DivRem(short left, short right)
        {
            short quotient = (short)(left / right);
            return (quotient, (short)(left - quotient * right));
        }

        public static (ushort Quotient, ushort Remainder) DivRem(ushort left, ushort right)
        {
            ushort quotient = (ushort)(left / right);
            return (quotient, (ushort)(left - quotient * right));
        }

        public static (int Quotient, int Remainder) DivRem(int left, int right)
        {
            int quotient = left / right;
            return (quotient, left - quotient * right);
        }

        public static (uint Quotient, uint Remainder) DivRem(uint left, uint right)
        {
            uint quotient = left / right;
            return (quotient, left - quotient * right);
        }

        public static (long Quotient, long Remainder) DivRem(long left, long right)
        {
            long quotient = left / right;
            return (quotient, left - quotient * right);
        }

        public static (ulong Quotient, ulong Remainder) DivRem(ulong left, ulong right)
        {
            ulong quotient = left / right;
            return (quotient, left - quotient * right);
        }

        public static int DivRem(int a, int b, out int result)
        {
            int quotient = a / b;
            result = a - quotient * b;
            return quotient;
        }

        public static long DivRem(long a, long b, out long result)
        {
            long quotient = a / b;
            result = a - quotient * b;
            return quotient;
        }

        internal static void ThrowMinMaxException<T>(T min, T max) =>
            throw new ArgumentException(SR.Format(SR.Argument_MinMaxValue, min, max));

        internal static void ThrowNegateTwosCompOverflow() => throw new OverflowException(SR.Overflow_NegateTwosCompNum);
    }
}

namespace System.Runtime.Intrinsics.X86
{
    internal static class X86Base
    {
        internal static class X64
        {
            public static bool IsSupported => false;

            public static (ulong Quotient, ulong Remainder) DivRem(ulong lower, ulong upper, ulong divisor) =>
                throw new PlatformNotSupportedException();
        }
    }
}
