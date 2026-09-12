// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// BitOperations' members with bodies here, over the ones the importer
// lowers to Wasm instructions (LeadingZeroCount, PopCount, ...), for the
// imported framework assemblies. The type stays .NET's.

using Gameplay.Runtime;

namespace System.Numerics
{
    [Surface]
    public static partial class BitOperations
    {
        public static int Log2(uint value) => 31 ^ LeadingZeroCount(value | 1);

        public static int Log2(ulong value) => 63 ^ LeadingZeroCount(value | 1);

        public static bool IsPow2(int value) => (value & (value - 1)) == 0 && value > 0;

        public static bool IsPow2(uint value) => (value & (value - 1)) == 0 && value != 0;

        public static bool IsPow2(long value) => (value & (value - 1)) == 0 && value > 0;

        public static bool IsPow2(ulong value) => (value & (value - 1)) == 0 && value != 0;

        public static uint RoundUpToPowerOf2(uint value) => value == 0 ? 0 : 1u << (32 - LeadingZeroCount(value - 1));

        public static ulong RoundUpToPowerOf2(ulong value) => value == 0 ? 0 : 1ul << (64 - LeadingZeroCount(value - 1));

        // The native integers', as the 64-bit ones' (IntPtr.Size is 8).
        public static int Log2(nuint value) => Log2((ulong)value);

        public static bool IsPow2(nint value) => IsPow2((long)value);

        public static bool IsPow2(nuint value) => IsPow2((ulong)value);

        public static nuint RoundUpToPowerOf2(nuint value) => (nuint)RoundUpToPowerOf2((ulong)value);

        public static int LeadingZeroCount(nuint value) => LeadingZeroCount((ulong)value);

        public static int TrailingZeroCount(nint value) => TrailingZeroCount((ulong)value);

        public static int TrailingZeroCount(nuint value) => TrailingZeroCount((ulong)value);

        public static int PopCount(nuint value) => PopCount((ulong)value);

        public static nuint RotateLeft(nuint value, int offset) => (nuint)RotateLeft((ulong)value, offset);

        public static nuint RotateRight(nuint value, int offset) => (nuint)RotateRight((ulong)value, offset);
    }
}
