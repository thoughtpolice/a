// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;

namespace Tests.Converts
{
    // System.Convert against the CLR: every pair of bool, char, the integer
    // types, float, double, decimal and string, over boundary values:
    // results as text, and the exceptions (with their messages, but for the
    // parsers' FormatException and OverflowException).
    public static class Converts
    {
        private static readonly bool[] BooleanValues = { true, false };
        private static readonly char[] CharValues = { 'A', '\0', '\uffff', (char)200, '7' };
        private static readonly sbyte[] SByteValues = { -128, -1, 0, 100, 127 };
        private static readonly byte[] ByteValues = { 0, 200, 255, 65 };
        private static readonly short[] Int16Values = { -32768, -129, 255, 32767, -1 };
        private static readonly ushort[] UInt16Values = { 0, 256, 65535, 128 };
        private static readonly int[] Int32Values = { int.MinValue, -1, 0, 65536, int.MaxValue, 97 };
        private static readonly uint[] UInt32Values = { 0, 128, uint.MaxValue, 2147483648 };
        private static readonly long[] Int64Values = { long.MinValue, -1, 4294967296, long.MaxValue, 300 };
        private static readonly ulong[] UInt64Values = { 0, 9223372036854775808UL, ulong.MaxValue, 255 };
        private static readonly float[] SingleValues = { 0.5f, 1.5f, 2.5f, -2.5f, 1e10f, float.NaN, -0.5f, 255.5f, 3.4e38f, 65535.4f, 0.1f };
        private static readonly double[] DoubleValues = { 0.5, 1.5, 2.5, -2.5, 2147483647.4, 2147483647.5, -2147483648.5, 4294967295.4, 9.2e18, 1e19, double.NaN, 1e300, -0.49999, -0.5, 127.5, 1e-300 };
        private static readonly decimal[] DecimalValues = { 2.5m, 3.5m, -2.5m, 127.5m, 255.49m, 79228162514264337593543950335m, 0.5m, -0.5m, 65535.5m, 1.10m };
        private static readonly string[] StringValues = { null, "12", "-5", " 7 ", "1.5", "true", "False", "x", "", "300", "1e3", "A", "  -0  " };

        public static readonly int[] Counts =
        {
            2, 5, 5, 4, 5, 4, 6, 4, 5, 4, 11, 16, 10, 13
        };

        private static int Digest(string text)
        {
            if (text == null)
            {
                return -7;
            }

            int digest = text.Length;
            foreach (char c in text)
            {
                digest = unchecked(digest * 31 + c);
            }

            return digest;
        }

        public static int Run(int target, int source, int index)
        {
            try
            {
                return Convert1(target, source, index);
            }
            catch (Exception exception)
            {
                int kind = exception is OverflowException ? 1
                    : exception is FormatException ? 2
                    : exception is InvalidCastException ? 3
                    : exception is ArgumentNullException ? 4
                    : 5;
                return source == 13 && kind <= 2 ? -kind : unchecked(-kind * 1000003 + Digest(exception.Message));
            }
        }

        private static int Convert1(int target, int source, int index)
        {
            switch (source)
            {
                case 0:
                {
                    bool value = BooleanValues[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 1:
                {
                    char value = CharValues[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 2:
                {
                    sbyte value = SByteValues[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 3:
                {
                    byte value = ByteValues[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 4:
                {
                    short value = Int16Values[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 5:
                {
                    ushort value = UInt16Values[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 6:
                {
                    int value = Int32Values[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 7:
                {
                    uint value = UInt32Values[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 8:
                {
                    long value = Int64Values[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 9:
                {
                    ulong value = UInt64Values[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 10:
                {
                    float value = SingleValues[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 11:
                {
                    double value = DoubleValues[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 12:
                {
                    decimal value = DecimalValues[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }

                case 13:
                {
                    string value = StringValues[index];
                    switch (target)
                    {
                        case 0:
                            return Digest(Convert.ToBoolean(value).ToString());
                        case 1:
                            return Digest(Convert.ToChar(value).ToString());
                        case 2:
                            return Digest(Convert.ToSByte(value).ToString());
                        case 3:
                            return Digest(Convert.ToByte(value).ToString());
                        case 4:
                            return Digest(Convert.ToInt16(value).ToString());
                        case 5:
                            return Digest(Convert.ToUInt16(value).ToString());
                        case 6:
                            return Digest(Convert.ToInt32(value).ToString());
                        case 7:
                            return Digest(Convert.ToUInt32(value).ToString());
                        case 8:
                            return Digest(Convert.ToInt64(value).ToString());
                        case 9:
                            return Digest(Convert.ToUInt64(value).ToString());
                        case 10:
                            return Digest(Convert.ToSingle(value).ToString());
                        case 11:
                            return Digest(Convert.ToDouble(value).ToString());
                        case 12:
                            return Digest(Convert.ToDecimal(value).ToString());
                        case 13:
                            return Digest(Convert.ToString(value).ToString());
                    }

                    return -1;
                }
            }

            return -1;
        }
    }
}
