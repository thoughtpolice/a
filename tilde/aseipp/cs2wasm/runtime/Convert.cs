// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.Convert's conversions between bool, char, the integer types,
// float, double, decimal and string, as .NET 11's Convert.cs has them:
// integers checked with Convert's OverflowException messages, double to
// an int or uint rounded to even by hand and to a long or ulong by
// Math.Round then a checked conversion, float as double, decimal rounded to
// even, strings parsed (null is zero or false, and throws for char), and
// the InvalidCastException IConvertible throws between char and bool,
// float, double and decimal. Generated (by a script, from rules read off
// Convert.cs); tests/Converts.cs compares every pair with the CLR.

namespace Gameplay.Runtime.Shims
{
    internal static class Convert
    {
        private static System.OverflowException Overflow(string type) =>
            new System.OverflowException("Value was either too large or too small for " + type + ".");

        public static bool ToBoolean(bool value)
        {
            return value;
        }

        public static bool ToBoolean(char value)
        {
            throw new System.InvalidCastException("Invalid cast from 'Char' to 'Boolean'.");
        }

        public static bool ToBoolean(sbyte value)
        {
            return value != 0;
        }

        public static bool ToBoolean(byte value)
        {
            return value != 0;
        }

        public static bool ToBoolean(short value)
        {
            return value != 0;
        }

        public static bool ToBoolean(ushort value)
        {
            return value != 0;
        }

        public static bool ToBoolean(int value)
        {
            return value != 0;
        }

        public static bool ToBoolean(uint value)
        {
            return value != 0;
        }

        public static bool ToBoolean(long value)
        {
            return value != 0;
        }

        public static bool ToBoolean(ulong value)
        {
            return value != 0;
        }

        public static bool ToBoolean(float value)
        {
            return value != 0;
        }

        public static bool ToBoolean(double value)
        {
            return value != 0;
        }

        public static bool ToBoolean(decimal value)
        {
            return value != 0;
        }

        public static bool ToBoolean(string value)
        {
            return value == null ? false : bool.Parse(value);
        }

        public static char ToChar(bool value)
        {
            throw new System.InvalidCastException("Invalid cast from 'Boolean' to 'Char'.");
        }

        public static char ToChar(char value)
        {
            return value;
        }

        public static char ToChar(sbyte value)
        {
            if (value < 0)
            {
                throw Overflow("a character");
            }

            return (char)value;
        }

        public static char ToChar(byte value)
        {
            return (char)value;
        }

        public static char ToChar(short value)
        {
            if (value < 0)
            {
                throw Overflow("a character");
            }

            return (char)value;
        }

        public static char ToChar(ushort value)
        {
            return (char)value;
        }

        public static char ToChar(int value)
        {
            if (value < 0 || value > 65535)
            {
                throw Overflow("a character");
            }

            return (char)value;
        }

        public static char ToChar(uint value)
        {
            if (value > 65535)
            {
                throw Overflow("a character");
            }

            return (char)value;
        }

        public static char ToChar(long value)
        {
            if (value < 0 || value > 65535)
            {
                throw Overflow("a character");
            }

            return (char)value;
        }

        public static char ToChar(ulong value)
        {
            if (value > 65535)
            {
                throw Overflow("a character");
            }

            return (char)value;
        }

        public static char ToChar(float value)
        {
            throw new System.InvalidCastException("Invalid cast from 'Single' to 'Char'.");
        }

        public static char ToChar(double value)
        {
            throw new System.InvalidCastException("Invalid cast from 'Double' to 'Char'.");
        }

        public static char ToChar(decimal value)
        {
            throw new System.InvalidCastException("Invalid cast from 'Decimal' to 'Char'.");
        }

        public static char ToChar(string value)
        {
            if (value == null)
            {
                throw new System.ArgumentNullException("value");
            }

            if (value.Length != 1)
            {
                throw new System.FormatException("String must be exactly one character long.");
            }

            return value[0];
        }

        public static sbyte ToSByte(bool value)
        {
            return value ? (sbyte)1 : (sbyte)0;
        }

        public static sbyte ToSByte(char value)
        {
            if (value > 127)
            {
                throw Overflow("a signed byte");
            }

            return (sbyte)value;
        }

        public static sbyte ToSByte(sbyte value)
        {
            return value;
        }

        public static sbyte ToSByte(byte value)
        {
            if (value > 127)
            {
                throw Overflow("a signed byte");
            }

            return (sbyte)value;
        }

        public static sbyte ToSByte(short value)
        {
            if (value < -128 || value > 127)
            {
                throw Overflow("a signed byte");
            }

            return (sbyte)value;
        }

        public static sbyte ToSByte(ushort value)
        {
            if (value > 127)
            {
                throw Overflow("a signed byte");
            }

            return (sbyte)value;
        }

        public static sbyte ToSByte(int value)
        {
            if (value < -128 || value > 127)
            {
                throw Overflow("a signed byte");
            }

            return (sbyte)value;
        }

        public static sbyte ToSByte(uint value)
        {
            if (value > 127)
            {
                throw Overflow("a signed byte");
            }

            return (sbyte)value;
        }

        public static sbyte ToSByte(long value)
        {
            if (value < -128 || value > 127)
            {
                throw Overflow("a signed byte");
            }

            return (sbyte)value;
        }

        public static sbyte ToSByte(ulong value)
        {
            if (value > 127)
            {
                throw Overflow("a signed byte");
            }

            return (sbyte)value;
        }

        public static sbyte ToSByte(float value)
        {
            return ToSByte((double)value);
        }

        public static sbyte ToSByte(double value)
        {
            return ToSByte(ToInt32(value));
        }

        public static sbyte ToSByte(decimal value)
        {
            return (sbyte)decimal.Round(value, 0);
        }

        public static sbyte ToSByte(string value)
        {
            return value == null ? (sbyte)0 : sbyte.Parse(value);
        }

        public static byte ToByte(bool value)
        {
            return value ? (byte)1 : (byte)0;
        }

        public static byte ToByte(char value)
        {
            if (value > 255)
            {
                throw Overflow("an unsigned byte");
            }

            return (byte)value;
        }

        public static byte ToByte(sbyte value)
        {
            if (value < 0)
            {
                throw Overflow("an unsigned byte");
            }

            return (byte)value;
        }

        public static byte ToByte(byte value)
        {
            return value;
        }

        public static byte ToByte(short value)
        {
            if (value < 0 || value > 255)
            {
                throw Overflow("an unsigned byte");
            }

            return (byte)value;
        }

        public static byte ToByte(ushort value)
        {
            if (value > 255)
            {
                throw Overflow("an unsigned byte");
            }

            return (byte)value;
        }

        public static byte ToByte(int value)
        {
            if (value < 0 || value > 255)
            {
                throw Overflow("an unsigned byte");
            }

            return (byte)value;
        }

        public static byte ToByte(uint value)
        {
            if (value > 255)
            {
                throw Overflow("an unsigned byte");
            }

            return (byte)value;
        }

        public static byte ToByte(long value)
        {
            if (value < 0 || value > 255)
            {
                throw Overflow("an unsigned byte");
            }

            return (byte)value;
        }

        public static byte ToByte(ulong value)
        {
            if (value > 255)
            {
                throw Overflow("an unsigned byte");
            }

            return (byte)value;
        }

        public static byte ToByte(float value)
        {
            return ToByte((double)value);
        }

        public static byte ToByte(double value)
        {
            return ToByte(ToInt32(value));
        }

        public static byte ToByte(decimal value)
        {
            return (byte)decimal.Round(value, 0);
        }

        public static byte ToByte(string value)
        {
            return value == null ? (byte)0 : byte.Parse(value);
        }

        public static short ToInt16(bool value)
        {
            return value ? (short)1 : (short)0;
        }

        public static short ToInt16(char value)
        {
            if (value > 32767)
            {
                throw Overflow("an Int16");
            }

            return (short)value;
        }

        public static short ToInt16(sbyte value)
        {
            return (short)value;
        }

        public static short ToInt16(byte value)
        {
            return (short)value;
        }

        public static short ToInt16(short value)
        {
            return value;
        }

        public static short ToInt16(ushort value)
        {
            if (value > 32767)
            {
                throw Overflow("an Int16");
            }

            return (short)value;
        }

        public static short ToInt16(int value)
        {
            if (value < -32768 || value > 32767)
            {
                throw Overflow("an Int16");
            }

            return (short)value;
        }

        public static short ToInt16(uint value)
        {
            if (value > 32767)
            {
                throw Overflow("an Int16");
            }

            return (short)value;
        }

        public static short ToInt16(long value)
        {
            if (value < -32768 || value > 32767)
            {
                throw Overflow("an Int16");
            }

            return (short)value;
        }

        public static short ToInt16(ulong value)
        {
            if (value > 32767)
            {
                throw Overflow("an Int16");
            }

            return (short)value;
        }

        public static short ToInt16(float value)
        {
            return ToInt16((double)value);
        }

        public static short ToInt16(double value)
        {
            return ToInt16(ToInt32(value));
        }

        public static short ToInt16(decimal value)
        {
            return (short)decimal.Round(value, 0);
        }

        public static short ToInt16(string value)
        {
            return value == null ? (short)0 : short.Parse(value);
        }

        public static ushort ToUInt16(bool value)
        {
            return value ? (ushort)1 : (ushort)0;
        }

        public static ushort ToUInt16(char value)
        {
            return (ushort)value;
        }

        public static ushort ToUInt16(sbyte value)
        {
            if (value < 0)
            {
                throw Overflow("a UInt16");
            }

            return (ushort)value;
        }

        public static ushort ToUInt16(byte value)
        {
            return (ushort)value;
        }

        public static ushort ToUInt16(short value)
        {
            if (value < 0)
            {
                throw Overflow("a UInt16");
            }

            return (ushort)value;
        }

        public static ushort ToUInt16(ushort value)
        {
            return value;
        }

        public static ushort ToUInt16(int value)
        {
            if (value < 0 || value > 65535)
            {
                throw Overflow("a UInt16");
            }

            return (ushort)value;
        }

        public static ushort ToUInt16(uint value)
        {
            if (value > 65535)
            {
                throw Overflow("a UInt16");
            }

            return (ushort)value;
        }

        public static ushort ToUInt16(long value)
        {
            if (value < 0 || value > 65535)
            {
                throw Overflow("a UInt16");
            }

            return (ushort)value;
        }

        public static ushort ToUInt16(ulong value)
        {
            if (value > 65535)
            {
                throw Overflow("a UInt16");
            }

            return (ushort)value;
        }

        public static ushort ToUInt16(float value)
        {
            return ToUInt16((double)value);
        }

        public static ushort ToUInt16(double value)
        {
            return ToUInt16(ToInt32(value));
        }

        public static ushort ToUInt16(decimal value)
        {
            return (ushort)decimal.Round(value, 0);
        }

        public static ushort ToUInt16(string value)
        {
            return value == null ? (ushort)0 : ushort.Parse(value);
        }

        public static int ToInt32(bool value)
        {
            return value ? (int)1 : (int)0;
        }

        public static int ToInt32(char value)
        {
            return (int)value;
        }

        public static int ToInt32(sbyte value)
        {
            return (int)value;
        }

        public static int ToInt32(byte value)
        {
            return (int)value;
        }

        public static int ToInt32(short value)
        {
            return (int)value;
        }

        public static int ToInt32(ushort value)
        {
            return (int)value;
        }

        public static int ToInt32(int value)
        {
            return value;
        }

        public static int ToInt32(uint value)
        {
            if (value > 2147483647)
            {
                throw Overflow("an Int32");
            }

            return (int)value;
        }

        public static int ToInt32(long value)
        {
            if (value < -2147483648 || value > 2147483647)
            {
                throw Overflow("an Int32");
            }

            return (int)value;
        }

        public static int ToInt32(ulong value)
        {
            if (value > 2147483647)
            {
                throw Overflow("an Int32");
            }

            return (int)value;
        }

        public static int ToInt32(float value)
        {
            return ToInt32((double)value);
        }

        public static int ToInt32(double value)
        {
            if (value >= 0)
            {
                if (value < 2147483647.5)
                {
                    int result = (int)value;
                    double dif = value - result;
                    if (dif > 0.5 || dif == 0.5 && (result & 1) != 0)
                    {
                        result++;
                    }

                    return result;
                }
            }

            if (value < 0 && value >= -2147483648.5)
            {
                int result = (int)value;
                double dif = value - result;
                if (dif < -0.5 || dif == -0.5 && (result & 1) != 0)
                {
                    result--;
                }

                return result;
            }

            throw Overflow("an Int32");
        }

        public static int ToInt32(decimal value)
        {
            return (int)decimal.Round(value, 0);
        }

        public static int ToInt32(string value)
        {
            return value == null ? (int)0 : int.Parse(value);
        }

        public static uint ToUInt32(bool value)
        {
            return value ? (uint)1 : (uint)0;
        }

        public static uint ToUInt32(char value)
        {
            return (uint)value;
        }

        public static uint ToUInt32(sbyte value)
        {
            if (value < 0)
            {
                throw Overflow("a UInt32");
            }

            return (uint)value;
        }

        public static uint ToUInt32(byte value)
        {
            return (uint)value;
        }

        public static uint ToUInt32(short value)
        {
            if (value < 0)
            {
                throw Overflow("a UInt32");
            }

            return (uint)value;
        }

        public static uint ToUInt32(ushort value)
        {
            return (uint)value;
        }

        public static uint ToUInt32(int value)
        {
            if (value < 0)
            {
                throw Overflow("a UInt32");
            }

            return (uint)value;
        }

        public static uint ToUInt32(uint value)
        {
            return value;
        }

        public static uint ToUInt32(long value)
        {
            if (value < 0 || value > 4294967295)
            {
                throw Overflow("a UInt32");
            }

            return (uint)value;
        }

        public static uint ToUInt32(ulong value)
        {
            if (value > 4294967295)
            {
                throw Overflow("a UInt32");
            }

            return (uint)value;
        }

        public static uint ToUInt32(float value)
        {
            return ToUInt32((double)value);
        }

        public static uint ToUInt32(double value)
        {
            if (value >= -0.5 && value < 4294967295.5)
            {
                uint result = (uint)value;
                double dif = value - result;
                if (dif > 0.5 || dif == 0.5 && (result & 1) != 0)
                {
                    result++;
                }

                return result;
            }

            throw Overflow("a UInt32");
        }

        public static uint ToUInt32(decimal value)
        {
            return (uint)decimal.Round(value, 0);
        }

        public static uint ToUInt32(string value)
        {
            return value == null ? (uint)0 : uint.Parse(value);
        }

        public static long ToInt64(bool value)
        {
            return value ? (long)1 : (long)0;
        }

        public static long ToInt64(char value)
        {
            return (long)value;
        }

        public static long ToInt64(sbyte value)
        {
            return (long)value;
        }

        public static long ToInt64(byte value)
        {
            return (long)value;
        }

        public static long ToInt64(short value)
        {
            return (long)value;
        }

        public static long ToInt64(ushort value)
        {
            return (long)value;
        }

        public static long ToInt64(int value)
        {
            return (long)value;
        }

        public static long ToInt64(uint value)
        {
            return (long)value;
        }

        public static long ToInt64(long value)
        {
            return value;
        }

        public static long ToInt64(ulong value)
        {
            if (value > 9223372036854775807)
            {
                throw Overflow("an Int64");
            }

            return (long)value;
        }

        public static long ToInt64(float value)
        {
            return ToInt64((double)value);
        }

        public static long ToInt64(double value)
        {
            return checked((long)System.Math.Round(value));
        }

        public static long ToInt64(decimal value)
        {
            return (long)decimal.Round(value, 0);
        }

        public static long ToInt64(string value)
        {
            return value == null ? (long)0 : long.Parse(value);
        }

        public static ulong ToUInt64(bool value)
        {
            return value ? (ulong)1 : (ulong)0;
        }

        public static ulong ToUInt64(char value)
        {
            return (ulong)value;
        }

        public static ulong ToUInt64(sbyte value)
        {
            if (value < 0)
            {
                throw Overflow("a UInt64");
            }

            return (ulong)value;
        }

        public static ulong ToUInt64(byte value)
        {
            return (ulong)value;
        }

        public static ulong ToUInt64(short value)
        {
            if (value < 0)
            {
                throw Overflow("a UInt64");
            }

            return (ulong)value;
        }

        public static ulong ToUInt64(ushort value)
        {
            return (ulong)value;
        }

        public static ulong ToUInt64(int value)
        {
            if (value < 0)
            {
                throw Overflow("a UInt64");
            }

            return (ulong)value;
        }

        public static ulong ToUInt64(uint value)
        {
            return (ulong)value;
        }

        public static ulong ToUInt64(long value)
        {
            if (value < 0)
            {
                throw Overflow("a UInt64");
            }

            return (ulong)value;
        }

        public static ulong ToUInt64(ulong value)
        {
            return value;
        }

        public static ulong ToUInt64(float value)
        {
            return ToUInt64((double)value);
        }

        public static ulong ToUInt64(double value)
        {
            return checked((ulong)System.Math.Round(value));
        }

        public static ulong ToUInt64(decimal value)
        {
            return (ulong)decimal.Round(value, 0);
        }

        public static ulong ToUInt64(string value)
        {
            return value == null ? (ulong)0 : ulong.Parse(value);
        }

        public static float ToSingle(bool value)
        {
            return value ? (float)1 : (float)0;
        }

        public static float ToSingle(char value)
        {
            throw new System.InvalidCastException("Invalid cast from 'Char' to 'Single'.");
        }

        public static float ToSingle(sbyte value)
        {
            return (float)value;
        }

        public static float ToSingle(byte value)
        {
            return (float)value;
        }

        public static float ToSingle(short value)
        {
            return (float)value;
        }

        public static float ToSingle(ushort value)
        {
            return (float)value;
        }

        public static float ToSingle(int value)
        {
            return (float)value;
        }

        public static float ToSingle(uint value)
        {
            return (float)value;
        }

        public static float ToSingle(long value)
        {
            return (float)value;
        }

        public static float ToSingle(ulong value)
        {
            return (float)value;
        }

        public static float ToSingle(float value)
        {
            return value;
        }

        public static float ToSingle(double value)
        {
            return (float)value;
        }

        public static float ToSingle(decimal value)
        {
            return (float)value;
        }

        public static float ToSingle(string value)
        {
            return value == null ? (float)0 : float.Parse(value);
        }

        public static double ToDouble(bool value)
        {
            return value ? (double)1 : (double)0;
        }

        public static double ToDouble(char value)
        {
            throw new System.InvalidCastException("Invalid cast from 'Char' to 'Double'.");
        }

        public static double ToDouble(sbyte value)
        {
            return (double)value;
        }

        public static double ToDouble(byte value)
        {
            return (double)value;
        }

        public static double ToDouble(short value)
        {
            return (double)value;
        }

        public static double ToDouble(ushort value)
        {
            return (double)value;
        }

        public static double ToDouble(int value)
        {
            return (double)value;
        }

        public static double ToDouble(uint value)
        {
            return (double)value;
        }

        public static double ToDouble(long value)
        {
            return (double)value;
        }

        public static double ToDouble(ulong value)
        {
            return (double)value;
        }

        public static double ToDouble(float value)
        {
            return (double)value;
        }

        public static double ToDouble(double value)
        {
            return value;
        }

        public static double ToDouble(decimal value)
        {
            return (double)value;
        }

        public static double ToDouble(string value)
        {
            return value == null ? (double)0 : double.Parse(value);
        }

        public static decimal ToDecimal(bool value)
        {
            return value ? (decimal)1 : (decimal)0;
        }

        public static decimal ToDecimal(char value)
        {
            throw new System.InvalidCastException("Invalid cast from 'Char' to 'Decimal'.");
        }

        public static decimal ToDecimal(sbyte value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(byte value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(short value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(ushort value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(int value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(uint value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(long value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(ulong value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(float value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(double value)
        {
            return (decimal)value;
        }

        public static decimal ToDecimal(decimal value)
        {
            return value;
        }

        public static decimal ToDecimal(string value)
        {
            return value == null ? (decimal)0 : decimal.Parse(value);
        }

        public static string ToString(bool value)
        {
            return value.ToString();
        }

        public static string ToString(char value)
        {
            return value.ToString();
        }

        public static string ToString(sbyte value)
        {
            return value.ToString();
        }

        public static string ToString(byte value)
        {
            return value.ToString();
        }

        public static string ToString(short value)
        {
            return value.ToString();
        }

        public static string ToString(ushort value)
        {
            return value.ToString();
        }

        public static string ToString(int value)
        {
            return value.ToString();
        }

        public static string ToString(uint value)
        {
            return value.ToString();
        }

        public static string ToString(long value)
        {
            return value.ToString();
        }

        public static string ToString(ulong value)
        {
            return value.ToString();
        }

        public static string ToString(float value)
        {
            return value.ToString();
        }

        public static string ToString(double value)
        {
            return value.ToString();
        }

        public static string ToString(decimal value)
        {
            return value.ToString();
        }

        public static string ToString(string value)
        {
            return value;
        }
    }
}
