// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The framework members gameplay code calls that are C# here. A class in
// Gameplay.Runtime.Shims stands for the framework type of its name: its
// static method runs for the framework method of the same name and
// parameters, an instance method's receiver coming first. The compiler
// calls these where code calls the framework's, and compiles only the ones
// code calls.

namespace Gameplay.Runtime.Shims
{
    internal static class SByte
    {
        public static int CompareTo(sbyte value, sbyte other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(sbyte value, object obj) =>
            obj == null ? 1 : obj is sbyte other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type SByte.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is a sbyte.
        public static bool InstanceEquals(sbyte value, sbyte other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(sbyte value, object obj) => obj is sbyte other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for sbyte.
        public static sbyte Abs(sbyte value) => value >= 0 ? value : value == sbyte.MinValue ? throw new System.OverflowException() : (sbyte)(-value);

        public static sbyte Max(sbyte x, sbyte y) => x >= y ? x : y;

        public static sbyte Min(sbyte x, sbyte y) => x <= y ? x : y;

        public static sbyte Clamp(sbyte value, sbyte min, sbyte max) => min > max ? throw new System.ArgumentException() : value < min ? min : value > max ? max : value;

        public static int Sign(sbyte value) => value < 0 ? -1 : value > 0 ? 1 : 0;

        public static bool IsNegative(sbyte value) => value < 0;

        public static bool IsPositive(sbyte value) => value >= 0;

        public static bool IsEvenInteger(sbyte value) => (value & 1) == 0;

        public static bool IsOddInteger(sbyte value) => (value & 1) != 0;

        public static bool IsPow2(sbyte value) => (value & (value - 1)) == 0 && value > 0;

        public static sbyte Log2(sbyte value)
        {
            if (value < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return (sbyte)(31 - (int)System.Numerics.BitOperations.LeadingZeroCount((uint)value | 1u));
        }

        public static sbyte PopCount(sbyte value) => (sbyte)System.Numerics.BitOperations.PopCount((byte)value);

        public static sbyte LeadingZeroCount(sbyte value) => (sbyte)(System.Numerics.BitOperations.LeadingZeroCount((byte)value) - 24);

        public static sbyte TrailingZeroCount(sbyte value) => (sbyte)(System.Numerics.BitOperations.TrailingZeroCount((uint)(value << 24)) - 24);

        public static sbyte RotateLeft(sbyte value, int rotateAmount) => (sbyte)(((byte)value << (rotateAmount & 7)) | ((byte)value >> ((8 - rotateAmount) & 7)));

        public static sbyte RotateRight(sbyte value, int rotateAmount) => (sbyte)(((byte)value >> (rotateAmount & 7)) | ((byte)value << ((8 - rotateAmount) & 7)));

        public static sbyte CopySign(sbyte value, sbyte sign)
        {
            sbyte absolute = value;
            if (absolute < 0)
            {
                absolute = (sbyte)(-absolute);
            }

            if (sign >= 0)
            {
                if (absolute < 0)
                {
                    throw new System.OverflowException();
                }

                return absolute;
            }

            return (sbyte)(-absolute);
        }

        public static sbyte MaxMagnitude(sbyte x, sbyte y)
        {
            sbyte absX = x;
            if (absX < 0)
            {
                absX = (sbyte)(-absX);
                if (absX < 0)
                {
                    return x;
                }
            }

            sbyte absY = y;
            if (absY < 0)
            {
                absY = (sbyte)(-absY);
                if (absY < 0)
                {
                    return y;
                }
            }

            if (absX > absY)
            {
                return x;
            }

            return absX == absY ? (x < 0 ? y : x) : y;
        }

        public static sbyte MinMagnitude(sbyte x, sbyte y)
        {
            sbyte absX = x;
            if (absX < 0)
            {
                absX = (sbyte)(-absX);
                if (absX < 0)
                {
                    return y;
                }
            }

            sbyte absY = y;
            if (absY < 0)
            {
                absY = (sbyte)(-absY);
                if (absY < 0)
                {
                    return x;
                }
            }

            if (absX < absY)
            {
                return x;
            }

            return absX == absY ? (x < 0 ? x : y) : y;
        }

        public static (sbyte Quotient, sbyte Remainder) DivRem(sbyte left, sbyte right)
        {
            sbyte quotient = (sbyte)(left / right);
            return (quotient, (sbyte)(left - quotient * right));
        }

        public static sbyte Parse(string s) => (sbyte)Parsing.Checked(s, false, sbyte.MinValue, (ulong)sbyte.MaxValue);

        public static bool TryParse(string s, out sbyte result)
        {
            bool parsed = Parsing.Integer(s, false, sbyte.MinValue, (ulong)sbyte.MaxValue, out ulong bits) == 0;
            result = parsed ? (sbyte)bits : (sbyte)0;
            return parsed;
        }

        public static string ToString(sbyte value, string format) => Number.FormatInteger(value, false, 8, format);
    }

    internal static class Byte
    {
        public static int CompareTo(byte value, byte other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(byte value, object obj) =>
            obj == null ? 1 : obj is byte other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type Byte.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is a byte.
        public static bool InstanceEquals(byte value, byte other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(byte value, object obj) => obj is byte other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for byte.
        public static byte Abs(byte value) => value;

        public static byte Max(byte x, byte y) => x >= y ? x : y;

        public static byte Min(byte x, byte y) => x <= y ? x : y;

        public static byte Clamp(byte value, byte min, byte max) => min > max ? throw new System.ArgumentException() : value < min ? min : value > max ? max : value;

        public static int Sign(byte value) => value == 0 ? 0 : 1;

        public static bool IsNegative(byte value) => false;

        public static bool IsPositive(byte value) => true;

        public static bool IsEvenInteger(byte value) => (value & 1) == 0;

        public static bool IsOddInteger(byte value) => (value & 1) != 0;

        public static bool IsPow2(byte value) => (value & (value - 1)) == 0 && value != 0;

        public static byte Log2(byte value) => (byte)(31 - (int)System.Numerics.BitOperations.LeadingZeroCount((uint)(value | 1)));

        public static byte PopCount(byte value) => (byte)System.Numerics.BitOperations.PopCount((byte)value);

        public static byte LeadingZeroCount(byte value) => (byte)(System.Numerics.BitOperations.LeadingZeroCount((byte)value) - 24);

        public static byte TrailingZeroCount(byte value) => (byte)(System.Numerics.BitOperations.TrailingZeroCount((uint)(value << 24)) - 24);

        public static byte RotateLeft(byte value, int rotateAmount) => (byte)(((byte)value << (rotateAmount & 7)) | ((byte)value >> ((8 - rotateAmount) & 7)));

        public static byte RotateRight(byte value, int rotateAmount) => (byte)(((byte)value >> (rotateAmount & 7)) | ((byte)value << ((8 - rotateAmount) & 7)));

        public static byte MaxMagnitude(byte x, byte y) => x >= y ? x : y;

        public static byte MinMagnitude(byte x, byte y) => x <= y ? x : y;

        public static (byte Quotient, byte Remainder) DivRem(byte left, byte right)
        {
            byte quotient = (byte)(left / right);
            return (quotient, (byte)(left - quotient * right));
        }

        public static byte Parse(string s) => (byte)Parsing.Checked(s, true, 0, byte.MaxValue);

        public static bool TryParse(string s, out byte result)
        {
            bool parsed = Parsing.Integer(s, true, 0, byte.MaxValue, out ulong bits) == 0;
            result = parsed ? (byte)bits : (byte)0;
            return parsed;
        }

        public static string ToString(byte value, string format) => Number.FormatInteger(value, true, 8, format);
    }

    internal static class Int16
    {
        public static int CompareTo(short value, short other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(short value, object obj) =>
            obj == null ? 1 : obj is short other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type Int16.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is a short.
        public static bool InstanceEquals(short value, short other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(short value, object obj) => obj is short other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for short.
        public static short Abs(short value) => value >= 0 ? value : value == short.MinValue ? throw new System.OverflowException() : (short)(-value);

        public static short Max(short x, short y) => x >= y ? x : y;

        public static short Min(short x, short y) => x <= y ? x : y;

        public static short Clamp(short value, short min, short max) => min > max ? throw new System.ArgumentException() : value < min ? min : value > max ? max : value;

        public static int Sign(short value) => value < 0 ? -1 : value > 0 ? 1 : 0;

        public static bool IsNegative(short value) => value < 0;

        public static bool IsPositive(short value) => value >= 0;

        public static bool IsEvenInteger(short value) => (value & 1) == 0;

        public static bool IsOddInteger(short value) => (value & 1) != 0;

        public static bool IsPow2(short value) => (value & (value - 1)) == 0 && value > 0;

        public static short Log2(short value)
        {
            if (value < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return (short)(31 - (int)System.Numerics.BitOperations.LeadingZeroCount((uint)value | 1u));
        }

        public static short PopCount(short value) => (short)System.Numerics.BitOperations.PopCount((ushort)value);

        public static short LeadingZeroCount(short value) => (short)(System.Numerics.BitOperations.LeadingZeroCount((ushort)value) - 16);

        public static short TrailingZeroCount(short value) => (short)(System.Numerics.BitOperations.TrailingZeroCount((uint)(value << 16)) - 16);

        public static short RotateLeft(short value, int rotateAmount) => (short)(((ushort)value << (rotateAmount & 15)) | ((ushort)value >> ((16 - rotateAmount) & 15)));

        public static short RotateRight(short value, int rotateAmount) => (short)(((ushort)value >> (rotateAmount & 15)) | ((ushort)value << ((16 - rotateAmount) & 15)));

        public static short CopySign(short value, short sign)
        {
            short absolute = value;
            if (absolute < 0)
            {
                absolute = (short)(-absolute);
            }

            if (sign >= 0)
            {
                if (absolute < 0)
                {
                    throw new System.OverflowException();
                }

                return absolute;
            }

            return (short)(-absolute);
        }

        public static short MaxMagnitude(short x, short y)
        {
            short absX = x;
            if (absX < 0)
            {
                absX = (short)(-absX);
                if (absX < 0)
                {
                    return x;
                }
            }

            short absY = y;
            if (absY < 0)
            {
                absY = (short)(-absY);
                if (absY < 0)
                {
                    return y;
                }
            }

            if (absX > absY)
            {
                return x;
            }

            return absX == absY ? (x < 0 ? y : x) : y;
        }

        public static short MinMagnitude(short x, short y)
        {
            short absX = x;
            if (absX < 0)
            {
                absX = (short)(-absX);
                if (absX < 0)
                {
                    return y;
                }
            }

            short absY = y;
            if (absY < 0)
            {
                absY = (short)(-absY);
                if (absY < 0)
                {
                    return x;
                }
            }

            if (absX < absY)
            {
                return x;
            }

            return absX == absY ? (x < 0 ? x : y) : y;
        }

        public static (short Quotient, short Remainder) DivRem(short left, short right)
        {
            short quotient = (short)(left / right);
            return (quotient, (short)(left - quotient * right));
        }

        public static short Parse(string s) => (short)Parsing.Checked(s, false, short.MinValue, (ulong)short.MaxValue);

        public static bool TryParse(string s, out short result)
        {
            bool parsed = Parsing.Integer(s, false, short.MinValue, (ulong)short.MaxValue, out ulong bits) == 0;
            result = parsed ? (short)bits : (short)0;
            return parsed;
        }

        public static string ToString(short value, string format) => Number.FormatInteger(value, false, 16, format);
    }

    internal static class UInt16
    {
        public static int CompareTo(ushort value, ushort other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(ushort value, object obj) =>
            obj == null ? 1 : obj is ushort other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type UInt16.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is a ushort.
        public static bool InstanceEquals(ushort value, ushort other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(ushort value, object obj) => obj is ushort other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for ushort.
        public static ushort Abs(ushort value) => value;

        public static ushort Max(ushort x, ushort y) => x >= y ? x : y;

        public static ushort Min(ushort x, ushort y) => x <= y ? x : y;

        public static ushort Clamp(ushort value, ushort min, ushort max) => min > max ? throw new System.ArgumentException() : value < min ? min : value > max ? max : value;

        public static int Sign(ushort value) => value == 0 ? 0 : 1;

        public static bool IsNegative(ushort value) => false;

        public static bool IsPositive(ushort value) => true;

        public static bool IsEvenInteger(ushort value) => (value & 1) == 0;

        public static bool IsOddInteger(ushort value) => (value & 1) != 0;

        public static bool IsPow2(ushort value) => (value & (value - 1)) == 0 && value != 0;

        public static ushort Log2(ushort value) => (ushort)(31 - (int)System.Numerics.BitOperations.LeadingZeroCount((uint)(value | 1)));

        public static ushort PopCount(ushort value) => (ushort)System.Numerics.BitOperations.PopCount((ushort)value);

        public static ushort LeadingZeroCount(ushort value) => (ushort)(System.Numerics.BitOperations.LeadingZeroCount((ushort)value) - 16);

        public static ushort TrailingZeroCount(ushort value) => (ushort)(System.Numerics.BitOperations.TrailingZeroCount((uint)(value << 16)) - 16);

        public static ushort RotateLeft(ushort value, int rotateAmount) => (ushort)(((ushort)value << (rotateAmount & 15)) | ((ushort)value >> ((16 - rotateAmount) & 15)));

        public static ushort RotateRight(ushort value, int rotateAmount) => (ushort)(((ushort)value >> (rotateAmount & 15)) | ((ushort)value << ((16 - rotateAmount) & 15)));

        public static ushort MaxMagnitude(ushort x, ushort y) => x >= y ? x : y;

        public static ushort MinMagnitude(ushort x, ushort y) => x <= y ? x : y;

        public static (ushort Quotient, ushort Remainder) DivRem(ushort left, ushort right)
        {
            ushort quotient = (ushort)(left / right);
            return (quotient, (ushort)(left - quotient * right));
        }

        public static ushort Parse(string s) => (ushort)Parsing.Checked(s, true, 0, ushort.MaxValue);

        public static bool TryParse(string s, out ushort result)
        {
            bool parsed = Parsing.Integer(s, true, 0, ushort.MaxValue, out ulong bits) == 0;
            result = parsed ? (ushort)bits : (ushort)0;
            return parsed;
        }

        public static string ToString(ushort value, string format) => Number.FormatInteger(value, true, 16, format);
    }

    internal static class Int32
    {
        public static int CompareTo(int value, int other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(int value, object obj) =>
            obj == null ? 1 : obj is int other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type Int32.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is an int.
        public static bool InstanceEquals(int value, int other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(int value, object obj) => obj is int other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for int.
        public static int Abs(int value) => value >= 0 ? value : value == int.MinValue ? throw new System.OverflowException() : -value;

        public static int Max(int x, int y) => x >= y ? x : y;

        public static int Min(int x, int y) => x <= y ? x : y;

        public static int Clamp(int value, int min, int max) => min > max ? throw new System.ArgumentException() : value < min ? min : value > max ? max : value;

        public static int Sign(int value) => value < 0 ? -1 : value > 0 ? 1 : 0;

        public static bool IsNegative(int value) => value < 0;

        public static bool IsPositive(int value) => value >= 0;

        public static bool IsEvenInteger(int value) => (value & 1) == 0;

        public static bool IsOddInteger(int value) => (value & 1) != 0;

        public static bool IsPow2(int value) => (value & (value - 1)) == 0 && value > 0;

        public static int Log2(int value)
        {
            if (value < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return (int)(31 - (int)System.Numerics.BitOperations.LeadingZeroCount((uint)value | 1u));
        }

        public static int PopCount(int value) => (int)System.Numerics.BitOperations.PopCount((uint)value);

        public static int LeadingZeroCount(int value) => (int)System.Numerics.BitOperations.LeadingZeroCount((uint)value);

        public static int TrailingZeroCount(int value) => (int)System.Numerics.BitOperations.TrailingZeroCount(value);

        public static int RotateLeft(int value, int rotateAmount) => (int)System.Numerics.BitOperations.RotateLeft((uint)value, rotateAmount);

        public static int RotateRight(int value, int rotateAmount) => (int)System.Numerics.BitOperations.RotateRight((uint)value, rotateAmount);

        public static int CopySign(int value, int sign)
        {
            int absolute = value;
            if (absolute < 0)
            {
                absolute = (int)(-absolute);
            }

            if (sign >= 0)
            {
                if (absolute < 0)
                {
                    throw new System.OverflowException();
                }

                return absolute;
            }

            return (int)(-absolute);
        }

        public static int MaxMagnitude(int x, int y)
        {
            int absX = x;
            if (absX < 0)
            {
                absX = (int)(-absX);
                if (absX < 0)
                {
                    return x;
                }
            }

            int absY = y;
            if (absY < 0)
            {
                absY = (int)(-absY);
                if (absY < 0)
                {
                    return y;
                }
            }

            if (absX > absY)
            {
                return x;
            }

            return absX == absY ? (x < 0 ? y : x) : y;
        }

        public static int MinMagnitude(int x, int y)
        {
            int absX = x;
            if (absX < 0)
            {
                absX = (int)(-absX);
                if (absX < 0)
                {
                    return y;
                }
            }

            int absY = y;
            if (absY < 0)
            {
                absY = (int)(-absY);
                if (absY < 0)
                {
                    return x;
                }
            }

            if (absX < absY)
            {
                return x;
            }

            return absX == absY ? (x < 0 ? x : y) : y;
        }

        public static (int Quotient, int Remainder) DivRem(int left, int right)
        {
            int quotient = (int)(left / right);
            return (quotient, (int)(left - quotient * right));
        }

        public static int Parse(string s) => (int)Parsing.Checked(s, false, int.MinValue, int.MaxValue);

        public static bool TryParse(string s, out int result)
        {
            bool parsed = Parsing.Integer(s, false, int.MinValue, int.MaxValue, out ulong bits) == 0;
            result = parsed ? (int)bits : (int)0;
            return parsed;
        }

        public static string ToString(int value, string format) => Number.FormatInteger(value, false, 32, format);
    }

    internal static class UInt32
    {
        public static int CompareTo(uint value, uint other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(uint value, object obj) =>
            obj == null ? 1 : obj is uint other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type UInt32.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is a uint.
        public static bool InstanceEquals(uint value, uint other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(uint value, object obj) => obj is uint other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for uint.
        public static uint Abs(uint value) => value;

        public static uint Max(uint x, uint y) => x >= y ? x : y;

        public static uint Min(uint x, uint y) => x <= y ? x : y;

        public static uint Clamp(uint value, uint min, uint max) => min > max ? throw new System.ArgumentException() : value < min ? min : value > max ? max : value;

        public static int Sign(uint value) => value == 0 ? 0 : 1;

        public static bool IsNegative(uint value) => false;

        public static bool IsPositive(uint value) => true;

        public static bool IsEvenInteger(uint value) => (value & 1) == 0;

        public static bool IsOddInteger(uint value) => (value & 1) != 0;

        public static bool IsPow2(uint value) => (value & (value - 1)) == 0 && value != 0;

        public static uint Log2(uint value) => (uint)(31 - (int)System.Numerics.BitOperations.LeadingZeroCount((uint)(value | 1)));

        public static uint PopCount(uint value) => (uint)System.Numerics.BitOperations.PopCount((uint)value);

        public static uint LeadingZeroCount(uint value) => (uint)System.Numerics.BitOperations.LeadingZeroCount((uint)value);

        public static uint TrailingZeroCount(uint value) => (uint)System.Numerics.BitOperations.TrailingZeroCount(value);

        public static uint RotateLeft(uint value, int rotateAmount) => (uint)System.Numerics.BitOperations.RotateLeft((uint)value, rotateAmount);

        public static uint RotateRight(uint value, int rotateAmount) => (uint)System.Numerics.BitOperations.RotateRight((uint)value, rotateAmount);

        public static uint MaxMagnitude(uint x, uint y) => x >= y ? x : y;

        public static uint MinMagnitude(uint x, uint y) => x <= y ? x : y;

        public static (uint Quotient, uint Remainder) DivRem(uint left, uint right)
        {
            uint quotient = (uint)(left / right);
            return (quotient, (uint)(left - quotient * right));
        }

        public static uint Parse(string s) => (uint)Parsing.Checked(s, true, 0, uint.MaxValue);

        public static bool TryParse(string s, out uint result)
        {
            bool parsed = Parsing.Integer(s, true, 0, uint.MaxValue, out ulong bits) == 0;
            result = parsed ? (uint)bits : (uint)0;
            return parsed;
        }

        public static string ToString(uint value, string format) => Number.FormatInteger(value, true, 32, format);
    }

    internal static class Int64
    {
        public static int CompareTo(long value, long other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(long value, object obj) =>
            obj == null ? 1 : obj is long other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type Int64.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is a long.
        public static bool InstanceEquals(long value, long other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(long value, object obj) => obj is long other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for long.
        public static long Abs(long value) => value >= 0 ? value : value == long.MinValue ? throw new System.OverflowException() : -value;

        public static long Max(long x, long y) => x >= y ? x : y;

        public static long Min(long x, long y) => x <= y ? x : y;

        public static long Clamp(long value, long min, long max) => min > max ? throw new System.ArgumentException() : value < min ? min : value > max ? max : value;

        public static int Sign(long value) => value < 0 ? -1 : value > 0 ? 1 : 0;

        public static bool IsNegative(long value) => value < 0;

        public static bool IsPositive(long value) => value >= 0;

        public static bool IsEvenInteger(long value) => (value & 1) == 0;

        public static bool IsOddInteger(long value) => (value & 1) != 0;

        public static bool IsPow2(long value) => (value & (value - 1)) == 0 && value > 0;

        public static long Log2(long value)
        {
            if (value < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return 63 - (long)System.Numerics.BitOperations.LeadingZeroCount((ulong)value | 1ul);
        }

        public static long PopCount(long value) => (long)System.Numerics.BitOperations.PopCount((ulong)value);

        public static long LeadingZeroCount(long value) => (long)System.Numerics.BitOperations.LeadingZeroCount((ulong)value);

        public static long TrailingZeroCount(long value) => (long)System.Numerics.BitOperations.TrailingZeroCount(value);

        public static long RotateLeft(long value, int rotateAmount) => (long)System.Numerics.BitOperations.RotateLeft((ulong)value, rotateAmount);

        public static long RotateRight(long value, int rotateAmount) => (long)System.Numerics.BitOperations.RotateRight((ulong)value, rotateAmount);

        public static long CopySign(long value, long sign)
        {
            long absolute = value;
            if (absolute < 0)
            {
                absolute = (long)(-absolute);
            }

            if (sign >= 0)
            {
                if (absolute < 0)
                {
                    throw new System.OverflowException();
                }

                return absolute;
            }

            return (long)(-absolute);
        }

        public static long MaxMagnitude(long x, long y)
        {
            long absX = x;
            if (absX < 0)
            {
                absX = (long)(-absX);
                if (absX < 0)
                {
                    return x;
                }
            }

            long absY = y;
            if (absY < 0)
            {
                absY = (long)(-absY);
                if (absY < 0)
                {
                    return y;
                }
            }

            if (absX > absY)
            {
                return x;
            }

            return absX == absY ? (x < 0 ? y : x) : y;
        }

        public static long MinMagnitude(long x, long y)
        {
            long absX = x;
            if (absX < 0)
            {
                absX = (long)(-absX);
                if (absX < 0)
                {
                    return y;
                }
            }

            long absY = y;
            if (absY < 0)
            {
                absY = (long)(-absY);
                if (absY < 0)
                {
                    return x;
                }
            }

            if (absX < absY)
            {
                return x;
            }

            return absX == absY ? (x < 0 ? x : y) : y;
        }

        public static (long Quotient, long Remainder) DivRem(long left, long right)
        {
            long quotient = (long)(left / right);
            return (quotient, (long)(left - quotient * right));
        }

        public static long Parse(string s) => (long)Parsing.Checked(s, false, long.MinValue, long.MaxValue);

        public static bool TryParse(string s, out long result)
        {
            bool parsed = Parsing.Integer(s, false, long.MinValue, long.MaxValue, out ulong bits) == 0;
            result = parsed ? (long)bits : (long)0;
            return parsed;
        }

        public static string ToString(long value, string format) => Number.FormatInteger(value, false, 64, format);
    }

    internal static class UInt64
    {
        public static int CompareTo(ulong value, ulong other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(ulong value, object obj) =>
            obj == null ? 1 : obj is ulong other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type UInt64.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is a ulong.
        public static bool InstanceEquals(ulong value, ulong other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(ulong value, object obj) => obj is ulong other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for ulong.
        public static ulong Abs(ulong value) => value;

        public static ulong Max(ulong x, ulong y) => x >= y ? x : y;

        public static ulong Min(ulong x, ulong y) => x <= y ? x : y;

        public static ulong Clamp(ulong value, ulong min, ulong max) => min > max ? throw new System.ArgumentException() : value < min ? min : value > max ? max : value;

        public static int Sign(ulong value) => value == 0 ? 0 : 1;

        public static bool IsNegative(ulong value) => false;

        public static bool IsPositive(ulong value) => true;

        public static bool IsEvenInteger(ulong value) => (value & 1) == 0;

        public static bool IsOddInteger(ulong value) => (value & 1) != 0;

        public static bool IsPow2(ulong value) => (value & (value - 1)) == 0 && value != 0;

        public static ulong Log2(ulong value) => (ulong)(63 - (int)System.Numerics.BitOperations.LeadingZeroCount(value | 1ul));

        public static ulong PopCount(ulong value) => (ulong)System.Numerics.BitOperations.PopCount((ulong)value);

        public static ulong LeadingZeroCount(ulong value) => (ulong)System.Numerics.BitOperations.LeadingZeroCount((ulong)value);

        public static ulong TrailingZeroCount(ulong value) => (ulong)System.Numerics.BitOperations.TrailingZeroCount(value);

        public static ulong RotateLeft(ulong value, int rotateAmount) => (ulong)System.Numerics.BitOperations.RotateLeft((ulong)value, rotateAmount);

        public static ulong RotateRight(ulong value, int rotateAmount) => (ulong)System.Numerics.BitOperations.RotateRight((ulong)value, rotateAmount);

        public static ulong MaxMagnitude(ulong x, ulong y) => x >= y ? x : y;

        public static ulong MinMagnitude(ulong x, ulong y) => x <= y ? x : y;

        public static (ulong Quotient, ulong Remainder) DivRem(ulong left, ulong right)
        {
            ulong quotient = (ulong)(left / right);
            return (quotient, (ulong)(left - quotient * right));
        }

        public static ulong Parse(string s) => (ulong)Parsing.Checked(s, true, 0, ulong.MaxValue);

        public static bool TryParse(string s, out ulong result)
        {
            bool parsed = Parsing.Integer(s, true, 0, ulong.MaxValue, out ulong bits) == 0;
            result = parsed ? (ulong)bits : (ulong)0;
            return parsed;
        }

        public static string ToString(ulong value, string format) => Number.FormatInteger((long)value, true, 64, format);
    }

    // The native integers, which are 64 bits here (IntPtr.Size is 8), as
    // long and ulong's.
    internal static class IntPtr
    {
        public static int CompareTo(nint value, nint other) => Intrinsics.Compare((long)value, (long)other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(nint value, object obj) =>
            obj == null ? 1 : obj is nint other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type IntPtr.");

        public static bool InstanceEquals(nint value, nint other) => value == other;

        public static bool InstanceEquals(nint value, object obj) => obj is nint other && value == other;

        public static nint get_MaxValue() => (nint)long.MaxValue;

        public static nint get_MinValue() => (nint)long.MinValue;

        public static nint Abs(nint value) => (nint)Int64.Abs((long)value);

        public static nint Max(nint x, nint y) => x >= y ? x : y;

        public static nint Min(nint x, nint y) => x <= y ? x : y;

        public static int Sign(nint value) => value < 0 ? -1 : value > 0 ? 1 : 0;

        public static bool IsNegative(nint value) => value < 0;

        public static bool IsPow2(nint value) => (value & (value - 1)) == 0 && value > 0;

        public static nint Log2(nint value) => (nint)Int64.Log2((long)value);

        public static nint PopCount(nint value) => (nint)System.Numerics.BitOperations.PopCount((ulong)value);

        public static nint LeadingZeroCount(nint value) => (nint)System.Numerics.BitOperations.LeadingZeroCount((ulong)value);

        public static nint TrailingZeroCount(nint value) => (nint)System.Numerics.BitOperations.TrailingZeroCount((long)value);

        public static nint RotateLeft(nint value, int rotateAmount) => (nint)System.Numerics.BitOperations.RotateLeft((ulong)value, rotateAmount);

        public static nint RotateRight(nint value, int rotateAmount) => (nint)System.Numerics.BitOperations.RotateRight((ulong)value, rotateAmount);

        public static nint BigMul(nint left, nint right, out nint lower)
        {
            long high = System.Math.BigMul((long)left, (long)right, out long low);
            lower = (nint)low;
            return (nint)high;
        }

        public static nint Clamp(nint value, nint min, nint max) => (nint)Int64.Clamp((long)value, (long)min, (long)max);

        public static bool IsPositive(nint value) => value >= 0;

        public static bool IsEvenInteger(nint value) => (value & 1) == 0;

        public static bool IsOddInteger(nint value) => (value & 1) != 0;

        public static nint CopySign(nint value, nint sign) => (nint)Int64.CopySign((long)value, (long)sign);

        public static nint MaxMagnitude(nint x, nint y) => (nint)Int64.MaxMagnitude((long)x, (long)y);

        public static nint MinMagnitude(nint x, nint y) => (nint)Int64.MinMagnitude((long)x, (long)y);

        public static (nint Quotient, nint Remainder) DivRem(nint left, nint right)
        {
            nint quotient = left / right;
            return (quotient, left - quotient * right);
        }

        public static nint Parse(string s) => (nint)Int64.Parse(s);

        public static bool TryParse(string s, out nint result)
        {
            bool parsed = Int64.TryParse(s, out long value);
            result = (nint)value;
            return parsed;
        }

        public static string ToString(nint value, string format) => Number.FormatInteger((long)value, false, 64, format);
    }

    internal static class UIntPtr
    {
        public static int CompareTo(nuint value, nuint other) => Intrinsics.Compare((ulong)value, (ulong)other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(nuint value, object obj) =>
            obj == null ? 1 : obj is nuint other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type UIntPtr.");

        public static bool InstanceEquals(nuint value, nuint other) => value == other;

        public static bool InstanceEquals(nuint value, object obj) => obj is nuint other && value == other;

        public static nuint get_MaxValue() => (nuint)ulong.MaxValue;

        public static nuint get_MinValue() => 0;

        public static nuint Max(nuint x, nuint y) => x >= y ? x : y;

        public static nuint Min(nuint x, nuint y) => x <= y ? x : y;

        public static bool IsPow2(nuint value) => (value & (value - 1)) == 0 && value != 0;

        public static nuint Log2(nuint value) => (nuint)(63 - (int)System.Numerics.BitOperations.LeadingZeroCount((ulong)value | 1ul));

        public static nuint PopCount(nuint value) => (nuint)System.Numerics.BitOperations.PopCount((ulong)value);

        public static nuint LeadingZeroCount(nuint value) => (nuint)System.Numerics.BitOperations.LeadingZeroCount((ulong)value);

        public static nuint TrailingZeroCount(nuint value) => (nuint)System.Numerics.BitOperations.TrailingZeroCount((ulong)value);

        public static nuint RotateLeft(nuint value, int rotateAmount) => (nuint)System.Numerics.BitOperations.RotateLeft((ulong)value, rotateAmount);

        public static nuint RotateRight(nuint value, int rotateAmount) => (nuint)System.Numerics.BitOperations.RotateRight((ulong)value, rotateAmount);

        public static nuint BigMul(nuint left, nuint right, out nuint lower)
        {
            ulong high = System.Math.BigMul((ulong)left, (ulong)right, out ulong low);
            lower = (nuint)low;
            return (nuint)high;
        }

        public static nuint Abs(nuint value) => value;

        public static nuint Clamp(nuint value, nuint min, nuint max) => (nuint)UInt64.Clamp((ulong)value, (ulong)min, (ulong)max);

        public static int Sign(nuint value) => value == 0 ? 0 : 1;

        public static bool IsNegative(nuint value) => false;

        public static bool IsPositive(nuint value) => true;

        public static bool IsEvenInteger(nuint value) => (value & 1) == 0;

        public static bool IsOddInteger(nuint value) => (value & 1) != 0;

        public static nuint MaxMagnitude(nuint x, nuint y) => x >= y ? x : y;

        public static nuint MinMagnitude(nuint x, nuint y) => x <= y ? x : y;

        public static (nuint Quotient, nuint Remainder) DivRem(nuint left, nuint right)
        {
            nuint quotient = left / right;
            return (quotient, left - quotient * right);
        }

        public static nuint Parse(string s) => (nuint)UInt64.Parse(s);

        public static bool TryParse(string s, out nuint result)
        {
            bool parsed = UInt64.TryParse(s, out ulong value);
            result = (nuint)value;
            return parsed;
        }

        public static string ToString(nuint value, string format) => Number.FormatInteger((long)value, true, 64, format);
    }

    internal static class Single
    {
        // INumberBase's classifications, as .NET's (Complex asks them).
        public static bool IsRealNumber(float value) => value == value;

        public static bool IsImaginaryNumber(float value) => false;

        public static bool IsComplexNumber(float value) => false;

        public static bool IsZero(float value) => value == 0;

        public static int CompareTo(float value, float other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(float value, object obj) =>
            obj == null ? 1 : obj is float other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type Single.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is a float.
        public static bool InstanceEquals(float value, float other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(float value, object obj) => obj is float other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for float.
        public static float Abs(float x) => System.MathF.Abs(x);

        public static float Floor(float x) => System.MathF.Floor(x);

        public static float Ceiling(float x) => System.MathF.Ceiling(x);

        public static float Truncate(float x) => System.MathF.Truncate(x);

        public static float Sqrt(float x) => System.MathF.Sqrt(x);

        public static float Round(float x) => System.MathF.Round(x);

        public static float Round(float x, int digits) => System.MathF.Round(x, digits);

        public static float Round(float x, System.MidpointRounding mode) => System.MathF.Round(x, mode);

        public static float Round(float x, int digits, System.MidpointRounding mode) => System.MathF.Round(x, digits, mode);

        public static float Max(float x, float y) => System.MathF.Max(x, y);

        public static float Min(float x, float y) => System.MathF.Min(x, y);

        public static float CopySign(float x, float y) => System.MathF.CopySign(x, y);

        public static float Atan2(float x, float y) => System.MathF.Atan2(x, y);

        public static float Pow(float x, float y) => System.MathF.Pow(x, y);

        public static float Clamp(float value, float min, float max) => (float)ClampSingle(value, min, max);

        private static float ClampSingle(float value, float min, float max)
        {
            if (min > max)
            {
                throw new System.ArgumentException();
            }

            return value < min ? min : value > max ? max : value;
        }

        public static int Sign(float value) => System.MathF.Sign(value);

        public static float Sin(float x) => System.MathF.Sin(x);

        public static float Cos(float x) => System.MathF.Cos(x);

        public static float Tan(float x) => System.MathF.Tan(x);

        public static float Asin(float x) => System.MathF.Asin(x);

        public static float Acos(float x) => System.MathF.Acos(x);

        public static float Atan(float x) => System.MathF.Atan(x);

        public static float Sinh(float x) => System.MathF.Sinh(x);

        public static float Cosh(float x) => System.MathF.Cosh(x);

        public static float Tanh(float x) => System.MathF.Tanh(x);

        public static float Exp(float x) => System.MathF.Exp(x);

        public static float Log(float x) => System.MathF.Log(x);

        public static float Log2(float x) => System.MathF.Log2(x);

        public static float Log10(float x) => System.MathF.Log10(x);

        public static float Cbrt(float x) => System.MathF.Cbrt(x);

        public static float Log(float x, float newBase) => System.MathF.Log(x, newBase);

        public static float ScaleB(float x, int n) => System.MathF.ScaleB(x, n);

        public static (float Sin, float Cos) SinCos(float x) => (System.MathF.Sin(x), System.MathF.Cos(x));

        public static float Ieee754Remainder(float left, float right) => MathF.IEEERemainder(left, right);

        // .NET's: the squares of floats in doubles, where they are exact.
        public static float Hypot(float x, float y)
        {
            if (float.IsFinite(x) && float.IsFinite(y))
            {
                float ax = System.MathF.Abs(x);
                float ay = System.MathF.Abs(y);
                if (ax == 0.0f)
                {
                    return ay;
                }

                if (ay == 0.0f)
                {
                    return ax;
                }

                double xx = ax;
                xx *= xx;
                double yy = ay;
                yy *= yy;
                return (float)System.Math.Sqrt(xx + yy);
            }

            return float.IsInfinity(x) || float.IsInfinity(y) ? float.PositiveInfinity : float.NaN;
        }

        // Rounded twice: Wasm has no fused multiply-add (see
        // corelib/Vector128.cs).
        public static float MultiplyAddEstimate(float left, float right, float addend) => (left * right) + addend;

        public static float FusedMultiplyAdd(float left, float right, float addend) => FusedMultiply.Add(left, right, addend);

        public static bool IsNegative(float value) => System.BitConverter.SingleToInt32Bits(value) < 0;

        public static bool IsPositive(float value) => System.BitConverter.SingleToInt32Bits(value) >= 0;

        public static bool IsNegativeInfinity(float value) => value == float.NegativeInfinity;

        public static bool IsPositiveInfinity(float value) => value == float.PositiveInfinity;

        public static bool IsInteger(float value) => float.IsFinite(value) && value == System.MathF.Truncate(value);

        public static bool IsEvenInteger(float value) => IsInteger(value) && System.MathF.Abs(value % 2) == 0;

        public static bool IsOddInteger(float value) => IsInteger(value) && System.MathF.Abs(value % 2) == 1;

        public static bool IsNormal(float value)
        {
            int bits = System.BitConverter.SingleToInt32Bits(value) & 0x7FFFFFFF;
            return bits < 0x7F800000 && bits != 0 && (bits & 0x7F800000) != 0;
        }

        public static bool IsSubnormal(float value)
        {
            int bits = System.BitConverter.SingleToInt32Bits(value) & 0x7FFFFFFF;
            return bits < 0x7F800000 && bits != 0 && (bits & 0x7F800000) == 0;
        }

        public static float MaxMagnitude(float x, float y)
        {
            float ax = System.MathF.Abs(x);
            float ay = System.MathF.Abs(y);
            if (ax > ay || float.IsNaN(ax))
            {
                return x;
            }

            return ax == ay ? (IsNegative(x) ? y : x) : y;
        }

        public static float MinMagnitude(float x, float y)
        {
            float ax = System.MathF.Abs(x);
            float ay = System.MathF.Abs(y);
            if (ax < ay || float.IsNaN(ax))
            {
                return x;
            }

            return ax == ay ? (IsNegative(x) ? x : y) : y;
        }

        public static float MaxNumber(float x, float y)
        {
            if (x != y)
            {
                return !float.IsNaN(y) ? (y < x ? x : y) : x;
            }

            return IsNegative(y) ? x : y;
        }

        public static float MinNumber(float x, float y)
        {
            if (x != y)
            {
                return !float.IsNaN(y) ? (x < y ? x : y) : x;
            }

            return IsNegative(x) ? x : y;
        }

        public static float Lerp(float value1, float value2, float amount) => (value1 * (1 - amount)) + (value2 * amount);

        public static float Parse(string s)
        {
            if (s == null)
            {
                throw new System.ArgumentNullException();
            }

            double value = Parsing.Floating(s, true, out bool failed);
            return failed ? throw new System.FormatException() : (float)value;
        }

        public static bool TryParse(string s, out float result)
        {
            double value = Parsing.Floating(s, true, out bool failed);
            result = failed ? 0 : (float)value;
            return !failed;
        }

        public static string ToString(float value) => Number.FormatSingle(value, null);

        public static string ToString(float value, string format) => Number.FormatSingle(value, format);

        // The invariant culture is the only one (runtime/Culture.cs).
        public static string ToString(float value, string format, System.IFormatProvider provider) => ToString(value, format);

        public static string ToString(float value, System.IFormatProvider provider) => ToString(value, (string)null);

        // With a NumberStyles of Float and AllowThousands' flags (.NET's
        // default for floating point), or fewer: what a flag left out
        // allows is refused (Parsing.Floating reads the default's).
        public static bool TryParse(ReadOnlySpan<char> s, System.Globalization.NumberStyles style, System.IFormatProvider provider, out float result) =>
            TryParse(s.ToString(), style, provider, out result);

        public static bool TryParse(string s, System.Globalization.NumberStyles style, System.IFormatProvider provider, out float result)
        {
            result = 0;
            if (s == null || !Parsing.FloatingStyle(s, (int)style))
            {
                return false;
            }

            float value = (float)Parsing.Floating(s, true, out bool failed);
            result = failed ? 0 : value;
            return !failed;
        }
    }

    internal static class Double
    {
        // INumberBase's classifications, as .NET's (Complex asks them).
        public static bool IsRealNumber(double value) => value == value;

        public static bool IsImaginaryNumber(double value) => false;

        public static bool IsComplexNumber(double value) => false;

        public static bool IsZero(double value) => value == 0;

        public static int CompareTo(double value, double other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(double value, object obj) =>
            obj == null ? 1 : obj is double other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type Double.");

        // Equals as the CLR's: NaN equals itself and 0 equals -0; an object
        // only when it is a double.
        public static bool InstanceEquals(double value, double other) => Intrinsics.Equal(value, other);

        public static bool InstanceEquals(double value, object obj) => obj is double other && Intrinsics.Equal(value, other);

        // The generic math statics, as .NET implements them for double.
        public static double Abs(double x) => System.Math.Abs(x);

        public static double Floor(double x) => System.Math.Floor(x);

        public static double Ceiling(double x) => System.Math.Ceiling(x);

        public static double Truncate(double x) => System.Math.Truncate(x);

        public static double Sqrt(double x) => System.Math.Sqrt(x);

        public static double Round(double x) => System.Math.Round(x);

        public static double Round(double x, int digits) => System.Math.Round(x, digits);

        public static double Round(double x, System.MidpointRounding mode) => System.Math.Round(x, mode);

        public static double Round(double x, int digits, System.MidpointRounding mode) => System.Math.Round(x, digits, mode);

        public static double Max(double x, double y) => System.Math.Max(x, y);

        public static double Min(double x, double y) => System.Math.Min(x, y);

        public static double CopySign(double x, double y) => System.Math.CopySign(x, y);

        public static double Atan2(double x, double y) => System.Math.Atan2(x, y);

        public static double Pow(double x, double y) => System.Math.Pow(x, y);

        public static double Clamp(double value, double min, double max) => System.Math.Clamp(value, min, max);

        public static int Sign(double value) => System.Math.Sign(value);

        public static double Sin(double x) => System.Math.Sin(x);

        public static double Cos(double x) => System.Math.Cos(x);

        public static double Tan(double x) => System.Math.Tan(x);

        public static double Asin(double x) => System.Math.Asin(x);

        public static double Acos(double x) => System.Math.Acos(x);

        public static double Atan(double x) => System.Math.Atan(x);

        public static double Sinh(double x) => System.Math.Sinh(x);

        public static double Cosh(double x) => System.Math.Cosh(x);

        public static double Tanh(double x) => System.Math.Tanh(x);

        public static double Exp(double x) => System.Math.Exp(x);

        public static double Log(double x) => System.Math.Log(x);

        public static double Log2(double x) => System.Math.Log2(x);

        public static double Log10(double x) => System.Math.Log10(x);

        public static double Cbrt(double x) => System.Math.Cbrt(x);

        public static double Log(double x, double newBase) => System.Math.Log(x, newBase);

        public static double ScaleB(double x, int n) => System.Math.ScaleB(x, n);

        public static (double Sin, double Cos) SinCos(double x) => (System.Math.Sin(x), System.Math.Cos(x));

        public static double Ieee754Remainder(double left, double right) => Math.IEEERemainder(left, right);

        // .NET's (after hypot of amd/aocl-libm-ose): the sum of the squares
        // with a tail of extra precision, scaled away from overflow and
        // underflow.
        public static double Hypot(double x, double y)
        {
            if (!double.IsFinite(x) || !double.IsFinite(y))
            {
                return double.IsInfinity(x) || double.IsInfinity(y) ? double.PositiveInfinity : double.NaN;
            }

            double ax = System.Math.Abs(x);
            double ay = System.Math.Abs(y);
            if (ax == 0.0)
            {
                return ay;
            }

            if (ay == 0.0)
            {
                return ax;
            }

            ulong xBits = System.BitConverter.DoubleToUInt64Bits(ax);
            ulong yBits = System.BitConverter.DoubleToUInt64Bits(ay);
            uint xExp = (uint)((xBits >> 52) & 0x7FF);
            uint yExp = (uint)((yBits >> 52) & 0x7FF);
            int expDiff = (int)(xExp - yExp);
            if (expDiff > 53 || expDiff < -53)
            {
                return ax + ay;
            }

            double expFix = 1.0;
            if (xExp > 1023 + 500 || yExp > 1023 + 500)
            {
                expFix = 4.149515568880993E+180;
                xBits -= 0x2580000000000000;
                yBits -= 0x2580000000000000;
            }
            else if (xExp < 1023 - 500 || yExp < 1023 - 500)
            {
                expFix = 2.409919865102884E-181;
                xBits += 0x2580000000000000;
                yBits += 0x2580000000000000;
                if (xExp == 0)
                {
                    xBits += 0x0010000000000000;
                    ax = System.BitConverter.UInt64BitsToDouble(xBits);
                    ax -= 9.232978617785736E-128;
                    xBits = System.BitConverter.DoubleToUInt64Bits(ax);
                }

                if (yExp == 0)
                {
                    yBits += 0x0010000000000000;
                    ay = System.BitConverter.UInt64BitsToDouble(yBits);
                    ay -= 9.232978617785736E-128;
                    yBits = System.BitConverter.DoubleToUInt64Bits(ay);
                }
            }

            ax = System.BitConverter.UInt64BitsToDouble(xBits);
            ay = System.BitConverter.UInt64BitsToDouble(yBits);
            if (ax < ay)
            {
                (ax, ay) = (ay, ax);
                (xBits, yBits) = (yBits, xBits);
            }

            double xHead = System.BitConverter.UInt64BitsToDouble(xBits & 0xFFFF_FFFF_F800_0000);
            double yHead = System.BitConverter.UInt64BitsToDouble(yBits & 0xFFFF_FFFF_F800_0000);
            double xTail = ax - xHead;
            double yTail = ay - yHead;
            double xx = ax * ax;
            double yy = ay * ay;
            double rHead = xx + yy;
            double rTail = (xx - rHead) + yy;
            rTail += (xHead * xHead) - xx;
            rTail += 2 * xHead * xTail;
            rTail += xTail * xTail;
            if (expDiff == 0)
            {
                rTail += (yHead * yHead) - yy;
                rTail += 2 * yHead * yTail;
                rTail += yTail * yTail;
            }

            return System.Math.Sqrt(rHead + rTail) * expFix;
        }

        public static double MultiplyAddEstimate(double left, double right, double addend) => (left * right) + addend;

        public static double FusedMultiplyAdd(double left, double right, double addend) => FusedMultiply.Add(left, right, addend);

        public static bool IsNegative(double value) => System.BitConverter.DoubleToInt64Bits(value) < 0;

        public static bool IsPositive(double value) => System.BitConverter.DoubleToInt64Bits(value) >= 0;

        public static bool IsNegativeInfinity(double value) => value == double.NegativeInfinity;

        public static bool IsPositiveInfinity(double value) => value == double.PositiveInfinity;

        public static bool IsInteger(double value) => double.IsFinite(value) && value == System.Math.Truncate(value);

        public static bool IsEvenInteger(double value) => IsInteger(value) && System.Math.Abs(value % 2) == 0;

        public static bool IsOddInteger(double value) => IsInteger(value) && System.Math.Abs(value % 2) == 1;

        public static bool IsNormal(double value)
        {
            long bits = System.BitConverter.DoubleToInt64Bits(value) & 0x7FFFFFFFFFFFFFFF;
            return bits < 0x7FF0000000000000 && bits != 0 && (bits & 0x7FF0000000000000) != 0;
        }

        public static bool IsSubnormal(double value)
        {
            long bits = System.BitConverter.DoubleToInt64Bits(value) & 0x7FFFFFFFFFFFFFFF;
            return bits < 0x7FF0000000000000 && bits != 0 && (bits & 0x7FF0000000000000) == 0;
        }

        public static double MaxMagnitude(double x, double y)
        {
            double ax = System.Math.Abs(x);
            double ay = System.Math.Abs(y);
            if (ax > ay || double.IsNaN(ax))
            {
                return x;
            }

            return ax == ay ? (IsNegative(x) ? y : x) : y;
        }

        public static double MinMagnitude(double x, double y)
        {
            double ax = System.Math.Abs(x);
            double ay = System.Math.Abs(y);
            if (ax < ay || double.IsNaN(ax))
            {
                return x;
            }

            return ax == ay ? (IsNegative(x) ? x : y) : y;
        }

        public static double MaxNumber(double x, double y)
        {
            if (x != y)
            {
                return !double.IsNaN(y) ? (y < x ? x : y) : x;
            }

            return IsNegative(y) ? x : y;
        }

        public static double MinNumber(double x, double y)
        {
            if (x != y)
            {
                return !double.IsNaN(y) ? (x < y ? x : y) : x;
            }

            return IsNegative(x) ? x : y;
        }

        public static double Lerp(double value1, double value2, double amount) => (value1 * (1 - amount)) + (value2 * amount);

        public static double Parse(string s)
        {
            if (s == null)
            {
                throw new System.ArgumentNullException();
            }

            double value = Parsing.Floating(s, false, out bool failed);
            return failed ? throw new System.FormatException() : (double)value;
        }

        public static bool TryParse(string s, out double result)
        {
            double value = Parsing.Floating(s, false, out bool failed);
            result = failed ? 0 : (double)value;
            return !failed;
        }

        public static string ToString(double value) => Number.FormatDouble(value, null);

        public static string ToString(double value, string format) => Number.FormatDouble(value, format);

        // The invariant culture is the only one (runtime/Culture.cs).
        public static string ToString(double value, string format, System.IFormatProvider provider) => ToString(value, format);

        public static string ToString(double value, System.IFormatProvider provider) => ToString(value, (string)null);

        // With a NumberStyles of Float and AllowThousands' flags (.NET's
        // default for floating point), or fewer: what a flag left out
        // allows is refused (Parsing.Floating reads the default's).
        public static bool TryParse(ReadOnlySpan<char> s, System.Globalization.NumberStyles style, System.IFormatProvider provider, out double result) =>
            TryParse(s.ToString(), style, provider, out result);

        public static bool TryParse(string s, System.Globalization.NumberStyles style, System.IFormatProvider provider, out double result)
        {
            result = 0;
            if (s == null || !Parsing.FloatingStyle(s, (int)style))
            {
                return false;
            }

            double value = (double)Parsing.Floating(s, false, out bool failed);
            result = failed ? 0 : value;
            return !failed;
        }
    }

    internal static class Math
    {
        public static double Sin(double a) => Transcendental.Sin(a);

        // As double's, which .NET's are.
        public static double MaxMagnitude(double x, double y) => Double.MaxMagnitude(x, y);

        public static double MinMagnitude(double x, double y) => Double.MinMagnitude(x, y);

        public static double Cos(double d) => Transcendental.Cos(d);

        public static double Tan(double a) => Transcendental.Tan(a);

        public static double Asin(double d) => Transcendental.Asin(d);

        public static double Acos(double d) => Transcendental.Acos(d);

        public static double Atan(double d) => Transcendental.Atan(d);

        public static double Atan2(double y, double x) => Transcendental.Atan2(y, x);

        public static double Sinh(double value) => Transcendental.Sinh(value);

        public static double Cosh(double value) => Transcendental.Cosh(value);

        public static double Tanh(double value) => Transcendental.Tanh(value);

        public static double Exp(double d) => Transcendental.Exp(d);

        public static double Log(double d) => Transcendental.Log(d);

        public static double Log(double a, double newBase) => Transcendental.LogBase(a, newBase);

        public static double Log10(double d) => Transcendental.Log10(d);

        public static double Log2(double x) => Transcendental.Log2(x);

        public static double Pow(double x, double y) => Transcendental.Pow(x, y);

        public static double Cbrt(double d) => Transcendental.Cbrt(d);

        public static double ScaleB(double x, int n) => DoubleDouble.ScaleB(x, n);

        public static (double Sin, double Cos) SinCos(double x) => (Transcendental.Sin(x), Transcendental.Cos(x));

        // .NET's: the remainder of x / y rounded to the nearest (to even),
        // from the truncated remainder.
        public static double IEEERemainder(double x, double y)
        {
            if (double.IsNaN(x))
            {
                return x;
            }

            if (double.IsNaN(y))
            {
                return y;
            }

            double regularMod = x % y;
            if (double.IsNaN(regularMod))
            {
                return double.NaN;
            }

            if (regularMod == 0 && double.IsNegative(x))
            {
                return -0.0;
            }

            double alternativeResult = regularMod - (System.Math.Abs(y) * System.Math.Sign(x));
            if (System.Math.Abs(alternativeResult) == System.Math.Abs(regularMod))
            {
                double divisionResult = x / y;
                double roundedResult = System.Math.Round(divisionResult);
                return System.Math.Abs(roundedResult) > System.Math.Abs(divisionResult) ? alternativeResult : regularMod;
            }

            return System.Math.Abs(alternativeResult) < System.Math.Abs(regularMod) ? alternativeResult : regularMod;
        }

        public static double FusedMultiplyAdd(double x, double y, double z) => FusedMultiply.Add(x, y, z);

        public static double Round(double value, int digits) => Round(value, digits, System.MidpointRounding.ToEven);

        public static double Round(double value, System.MidpointRounding mode)
        {
            switch (mode)
            {
                case System.MidpointRounding.ToEven:
                    return System.Math.Round(value);
                case System.MidpointRounding.AwayFromZero:
                    double whole = System.Math.Truncate(value);
                    return System.Math.Abs(value - whole) >= 0.5 ? whole + (value < 0 ? -1 : 1) : whole;
                case System.MidpointRounding.ToZero:
                    return System.Math.Truncate(value);
                case System.MidpointRounding.ToNegativeInfinity:
                    return System.Math.Floor(value);
                case System.MidpointRounding.ToPositiveInfinity:
                    return System.Math.Ceiling(value);
                default:
                    throw new System.ArgumentException();
            }
        }

        public static double Round(double value, int digits, System.MidpointRounding mode)
        {
            if (digits < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            if (mode < System.MidpointRounding.ToEven || mode > System.MidpointRounding.ToPositiveInfinity)
            {
                throw new System.ArgumentException();
            }

            if (digits == 0)
            {
                return Round(value, mode);
            }

            return System.Math.Abs(value) < 4503599627370496.0
                ? DecimalRounding.Round(value, digits, (int)mode, false)
                : value;
        }

        public static int Sign(double value) =>
            value != value ? throw new System.ArithmeticException() : value > 0 ? 1 : value < 0 ? -1 : 0;

        public static int Sign(float value) =>
            value != value ? throw new System.ArithmeticException() : value > 0 ? 1 : value < 0 ? -1 : 0;

        public static int Sign(int value) => value > 0 ? 1 : value < 0 ? -1 : 0;

        public static int Sign(long value) => value > 0 ? 1 : value < 0 ? -1 : 0;

        public static int Sign(short value) => value > 0 ? 1 : value < 0 ? -1 : 0;

        public static int Sign(sbyte value) => value > 0 ? 1 : value < 0 ? -1 : 0;

        public static decimal Abs(decimal value) => decimal.Abs(value);

        public static decimal Ceiling(decimal d) => decimal.Ceiling(d);

        public static decimal Floor(decimal d) => decimal.Floor(d);

        public static decimal Truncate(decimal d) => decimal.Truncate(d);

        public static decimal Round(decimal d) => decimal.Round(d, 0);

        public static decimal Round(decimal d, int decimals) => decimal.Round(d, decimals);

        public static decimal Round(decimal d, System.MidpointRounding mode) => decimal.Round(d, 0, mode);

        public static decimal Round(decimal d, int decimals, System.MidpointRounding mode) => decimal.Round(d, decimals, mode);

        public static decimal Max(decimal val1, decimal val2) => decimal.Max(val1, val2);

        public static decimal Min(decimal val1, decimal val2) => decimal.Min(val1, val2);

        public static int Sign(decimal value) => decimal.Sign(value);

        public static decimal Clamp(decimal value, decimal min, decimal max) => decimal.Clamp(value, min, max);
    }

    internal static class MathF
    {
        public static float Sin(float x) => (float)Transcendental.Sin(x);

        // As float's, which .NET's are.
        public static float MaxMagnitude(float x, float y) => Single.MaxMagnitude(x, y);

        public static float MinMagnitude(float x, float y) => Single.MinMagnitude(x, y);

        // Exact in a double, so rounded once to a float.
        public static float ScaleB(float x, int n) => (float)DoubleDouble.ScaleB(x, n);

        public static float Cos(float x) => (float)Transcendental.Cos(x);

        public static float Tan(float x) => (float)Transcendental.Tan(x);

        public static float Asin(float x) => (float)Transcendental.Asin(x);

        public static float Acos(float x) => (float)Transcendental.Acos(x);

        public static float Atan(float x) => (float)Transcendental.Atan(x);

        public static float Atan2(float y, float x) => (float)Transcendental.Atan2(y, x);

        public static float Sinh(float x) => (float)Transcendental.Sinh(x);

        public static float Cosh(float x) => (float)Transcendental.Cosh(x);

        public static float Tanh(float x) => (float)Transcendental.Tanh(x);

        public static float Exp(float x) => (float)Transcendental.Exp(x);

        public static float Log(float x) => (float)Transcendental.Log(x);

        public static float Log(float x, float y) => (float)Transcendental.LogBase(x, y);

        public static float Log10(float x) => (float)Transcendental.Log10(x);

        public static float Log2(float x) => (float)Transcendental.Log2(x);

        public static float Pow(float x, float y) => (float)Transcendental.Pow(x, y);

        public static float Cbrt(float x) => (float)Transcendental.Cbrt(x);

        public static (float Sin, float Cos) SinCos(float x) => ((float)Transcendental.Sin(x), (float)Transcendental.Cos(x));

        public static float IEEERemainder(float x, float y)
        {
            if (float.IsNaN(x))
            {
                return x;
            }

            if (float.IsNaN(y))
            {
                return y;
            }

            float regularMod = x % y;
            if (float.IsNaN(regularMod))
            {
                return float.NaN;
            }

            if (regularMod == 0 && float.IsNegative(x))
            {
                return -0.0f;
            }

            float alternativeResult = regularMod - (System.MathF.Abs(y) * System.MathF.Sign(x));
            if (System.MathF.Abs(alternativeResult) == System.MathF.Abs(regularMod))
            {
                float divisionResult = x / y;
                float roundedResult = System.MathF.Round(divisionResult);
                return System.MathF.Abs(roundedResult) > System.MathF.Abs(divisionResult) ? alternativeResult : regularMod;
            }

            return System.MathF.Abs(alternativeResult) < System.MathF.Abs(regularMod) ? alternativeResult : regularMod;
        }

        public static float FusedMultiplyAdd(float x, float y, float z) => FusedMultiply.Add(x, y, z);

        public static int Sign(float x) => Math.Sign(x);

        public static float Round(float x, int digits) => Round(x, digits, System.MidpointRounding.ToEven);

        public static float Round(float x, System.MidpointRounding mode) => (float)Math.Round(x, mode);

        public static float Round(float x, int digits, System.MidpointRounding mode)
        {
            if (digits < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            if (mode < System.MidpointRounding.ToEven || mode > System.MidpointRounding.ToPositiveInfinity)
            {
                throw new System.ArgumentException();
            }

            if (digits == 0)
            {
                return Round(x, mode);
            }

            return System.MathF.Abs(x) < 8388608f ? (float)DecimalRounding.Round(x, digits, (int)mode, true) : x;
        }
    }
}

namespace Gameplay.Runtime
{
    // An object that is only an object: what `new object()` makes.
    internal sealed class PlainObject
    {
        public override string ToString() => "System.Object";
    }
}

namespace Gameplay.Runtime.Shims
{
    // System.Exception's GetBaseException, as .NET's: the innermost of the
    // inner exceptions; an AggregateException's own (its override in
    // .NET, a type test here, where the BCL's virtual members have no
    // slots).
    internal static class Exception
    {
        public static System.Exception GetBaseException(System.Exception exception)
        {
            if (exception is System.AggregateException aggregate)
            {
                return aggregate.AggregateBaseException();
            }

            System.Exception back = exception;
            for (System.Exception inner = exception.InnerException; inner != null; inner = inner.InnerException)
            {
                back = inner;
            }

            return back;
        }
    }
}
