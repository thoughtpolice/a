// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.Guid, as .NET's: the same layout and byte order, formats (D, N,
// B, P, X), parsing, ordering and hash, with NewGuid's version 4 bits from
// the host's randomness (Host.Random) and CreateVersion7's timestamp from its
// clock. dotnet/runtime's own is SIMD and unsafe span code throughout, so
// this one is written anew.

using System.Text;
using Gameplay.Runtime;

namespace System
{
    public readonly struct Guid : IFormattable, IComparable, IComparable<Guid>, IEquatable<Guid>, IParsable<Guid>
    {
        public static readonly Guid Empty;

        private readonly int _a;
        private readonly short _b;
        private readonly short _c;
        private readonly byte _d;
        private readonly byte _e;
        private readonly byte _f;
        private readonly byte _g;
        private readonly byte _h;
        private readonly byte _i;
        private readonly byte _j;
        private readonly byte _k;

        public Guid(byte[] b)
            : this(new ReadOnlySpan<byte>(b ?? throw new ArgumentNullException(nameof(b))))
        {
        }

        public Guid(ReadOnlySpan<byte> b)
            : this(b, bigEndian: false)
        {
        }

        public Guid(ReadOnlySpan<byte> b, bool bigEndian)
        {
            if (b.Length != 16)
            {
                throw new ArgumentException("Byte array for Guid must be exactly 16 bytes long.", nameof(b));
            }

            if (bigEndian)
            {
                _a = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
                _b = (short)((b[4] << 8) | b[5]);
                _c = (short)((b[6] << 8) | b[7]);
            }
            else
            {
                _a = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
                _b = (short)(b[4] | (b[5] << 8));
                _c = (short)(b[6] | (b[7] << 8));
            }

            _d = b[8];
            _e = b[9];
            _f = b[10];
            _g = b[11];
            _h = b[12];
            _i = b[13];
            _j = b[14];
            _k = b[15];
        }

        public Guid(uint a, ushort b, ushort c, byte d, byte e, byte f, byte g, byte h, byte i, byte j, byte k)
        {
            _a = (int)a;
            _b = (short)b;
            _c = (short)c;
            _d = d;
            _e = e;
            _f = f;
            _g = g;
            _h = h;
            _i = i;
            _j = j;
            _k = k;
        }

        public Guid(int a, short b, short c, byte[] d)
        {
            if (d == null)
            {
                throw new ArgumentNullException(nameof(d));
            }

            if (d.Length != 8)
            {
                throw new ArgumentException("Byte array for Guid must be exactly 8 bytes long.", nameof(d));
            }

            _a = a;
            _b = b;
            _c = c;
            _d = d[0];
            _e = d[1];
            _f = d[2];
            _g = d[3];
            _h = d[4];
            _i = d[5];
            _j = d[6];
            _k = d[7];
        }

        public Guid(int a, short b, short c, byte d, byte e, byte f, byte g, byte h, byte i, byte j, byte k)
        {
            _a = a;
            _b = b;
            _c = c;
            _d = d;
            _e = e;
            _f = f;
            _g = g;
            _h = h;
            _i = i;
            _j = j;
            _k = k;
        }

        public Guid(string g)
        {
            this = Parse(g);
        }

        public static Guid AllBitsSet => new Guid(uint.MaxValue, ushort.MaxValue, ushort.MaxValue, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF);

        public int Version => (ushort)_c >> 12;

        public int Variant => _d >> 4;

        // A version 4 (random) Guid, from the host's randomness.
        public static Guid NewGuid()
        {
            long high = Host.Random();
            long low = Host.Random();
            var bytes = new byte[16];
            for (int index = 0; index < 8; index++)
            {
                bytes[index] = (byte)(high >> (8 * index));
                bytes[8 + index] = (byte)(low >> (8 * index));
            }

            bytes[7] = (byte)((bytes[7] & 0x0F) | 0x40);
            bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
            return new Guid(bytes);
        }

        // A version 7 Guid: the Unix time in milliseconds, then randomness.
        public static Guid CreateVersion7() => CreateVersion7(DateTimeOffset.UtcNow);

        public static Guid CreateVersion7(DateTimeOffset timestamp)
        {
            long milliseconds = timestamp.ToUnixTimeMilliseconds();
            if (milliseconds < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(timestamp), "The value must be greater than or equal to the Unix epoch.");
            }

            Guid random = NewGuid();
            var bytes = random.ToByteArray(bigEndian: true);
            for (int index = 0; index < 6; index++)
            {
                bytes[index] = (byte)(milliseconds >> (8 * (5 - index)));
            }

            bytes[6] = (byte)((bytes[6] & 0x0F) | 0x70);
            return new Guid(bytes, bigEndian: true);
        }

        public byte[] ToByteArray() => ToByteArray(bigEndian: false);

        public byte[] ToByteArray(bool bigEndian)
        {
            var bytes = new byte[16];
            if (bigEndian)
            {
                bytes[0] = (byte)(_a >> 24);
                bytes[1] = (byte)(_a >> 16);
                bytes[2] = (byte)(_a >> 8);
                bytes[3] = (byte)_a;
                bytes[4] = (byte)(_b >> 8);
                bytes[5] = (byte)_b;
                bytes[6] = (byte)(_c >> 8);
                bytes[7] = (byte)_c;
            }
            else
            {
                bytes[0] = (byte)_a;
                bytes[1] = (byte)(_a >> 8);
                bytes[2] = (byte)(_a >> 16);
                bytes[3] = (byte)(_a >> 24);
                bytes[4] = (byte)_b;
                bytes[5] = (byte)(_b >> 8);
                bytes[6] = (byte)_c;
                bytes[7] = (byte)(_c >> 8);
            }

            bytes[8] = _d;
            bytes[9] = _e;
            bytes[10] = _f;
            bytes[11] = _g;
            bytes[12] = _h;
            bytes[13] = _i;
            bytes[14] = _j;
            bytes[15] = _k;
            return bytes;
        }

        public bool TryWriteBytes(Span<byte> destination) => TryWriteBytes(destination, bigEndian: false, out _);

        public bool TryWriteBytes(Span<byte> destination, bool bigEndian, out int bytesWritten)
        {
            if (destination.Length < 16)
            {
                bytesWritten = 0;
                return false;
            }

            var bytes = ToByteArray(bigEndian);
            for (int index = 0; index < 16; index++)
            {
                destination[index] = bytes[index];
            }

            bytesWritten = 16;
            return true;
        }

        // The four 32-bit words of its memory, as .NET combines them.
        public override int GetHashCode() =>
            _a ^ ((ushort)_b | (_c << 16)) ^ (_d | (_e << 8) | (_f << 16) | (_g << 24)) ^ (_h | (_i << 8) | (_j << 16) | (_k << 24));

        public override bool Equals(object? o) => o is Guid other && Equals(other);

        public bool Equals(Guid g) =>
            _a == g._a && _b == g._b && _c == g._c && _d == g._d && _e == g._e && _f == g._f && _g == g._g && _h == g._h
            && _i == g._i && _j == g._j && _k == g._k;

        public int CompareTo(object? value)
        {
            if (value == null)
            {
                return 1;
            }

            if (value is not Guid other)
            {
                throw new ArgumentException("Object must be of type GUID.", nameof(value));
            }

            return CompareTo(other);
        }

        public int CompareTo(Guid value)
        {
            if (value._a != _a)
            {
                return (uint)_a < (uint)value._a ? -1 : 1;
            }

            if (value._b != _b)
            {
                return (ushort)_b < (ushort)value._b ? -1 : 1;
            }

            if (value._c != _c)
            {
                return (ushort)_c < (ushort)value._c ? -1 : 1;
            }

            var mine = ToByteArray();
            var theirs = value.ToByteArray();
            for (int index = 8; index < 16; index++)
            {
                if (mine[index] != theirs[index])
                {
                    return mine[index] < theirs[index] ? -1 : 1;
                }
            }

            return 0;
        }

        public static bool operator ==(Guid a, Guid b) => a.Equals(b);

        public static bool operator !=(Guid a, Guid b) => !a.Equals(b);

        public static bool operator <(Guid left, Guid right) => left.CompareTo(right) < 0;

        public static bool operator <=(Guid left, Guid right) => left.CompareTo(right) <= 0;

        public static bool operator >(Guid left, Guid right) => left.CompareTo(right) > 0;

        public static bool operator >=(Guid left, Guid right) => left.CompareTo(right) >= 0;

        public override string ToString() => ToString("D");

        public string ToString(string? format) => ToString(format, null);

        public string ToString(string? format, IFormatProvider? provider)
        {
            if (string.IsNullOrEmpty(format))
            {
                format = "D";
            }

            if (format.Length != 1)
            {
                throw new FormatException("Format string can be only \"D\", \"d\", \"N\", \"n\", \"P\", \"p\", \"B\", \"b\", \"X\" or \"x\".");
            }

            var bytes = ToByteArray(bigEndian: true);
            var text = new StringBuilder(68);
            switch (format[0])
            {
                case 'D':
                case 'd':
                    Hex(text, bytes, 0, 4);
                    text.Append('-');
                    Hex(text, bytes, 4, 2);
                    text.Append('-');
                    Hex(text, bytes, 6, 2);
                    text.Append('-');
                    Hex(text, bytes, 8, 2);
                    text.Append('-');
                    Hex(text, bytes, 10, 6);
                    break;
                case 'N':
                case 'n':
                    Hex(text, bytes, 0, 16);
                    break;
                case 'B':
                case 'b':
                    text.Append('{');
                    text.Append(ToString("D"));
                    text.Append('}');
                    break;
                case 'P':
                case 'p':
                    text.Append('(');
                    text.Append(ToString("D"));
                    text.Append(')');
                    break;
                case 'X':
                case 'x':
                    text.Append("{0x");
                    Hex(text, bytes, 0, 4);
                    text.Append(",0x");
                    Hex(text, bytes, 4, 2);
                    text.Append(",0x");
                    Hex(text, bytes, 6, 2);
                    text.Append(",{");
                    for (int index = 8; index < 16; index++)
                    {
                        text.Append(index == 8 ? "0x" : ",0x");
                        Hex(text, bytes, index, 1);
                    }

                    text.Append("}}");
                    break;
                default:
                    throw new FormatException("Format string can be only \"D\", \"d\", \"N\", \"n\", \"P\", \"p\", \"B\", \"b\", \"X\" or \"x\".");
            }

            return text.ToString();
        }

        private static void Hex(StringBuilder text, byte[] bytes, int start, int count)
        {
            const string digits = "0123456789abcdef";
            for (int index = start; index < start + count; index++)
            {
                text.Append(digits[bytes[index] >> 4]);
                text.Append(digits[bytes[index] & 0xF]);
            }
        }

        public static Guid Parse(string input) =>
            Parse(input ?? throw new ArgumentNullException(nameof(input)), null);

        public static Guid Parse(string s, IFormatProvider? provider)
        {
            if (s == null)
            {
                throw new ArgumentNullException(nameof(s));
            }

            return TryParseAny(s.Trim(), out Guid result, out string? error) ? result : throw new FormatException(error);
        }

        public static bool TryParse(string? input, out Guid result)
        {
            if (input == null)
            {
                result = default;
                return false;
            }

            return TryParseAny(input.Trim(), out result, out _);
        }

        public static bool TryParse(string? s, IFormatProvider? provider, out Guid result) => TryParse(s, out result);

        public static Guid ParseExact(string input, string format)
        {
            if (input == null)
            {
                throw new ArgumentNullException(nameof(input));
            }

            if (format == null)
            {
                throw new ArgumentNullException(nameof(format));
            }

            return TryParseExactCore(input.Trim(), format, out Guid result, out string? error) ? result : throw new FormatException(error);
        }

        public static bool TryParseExact(string? input, string? format, out Guid result)
        {
            if (input == null || format == null)
            {
                result = default;
                return false;
            }

            return TryParseExactCore(input.Trim(), format, out result, out _);
        }

        private static bool TryParseExactCore(string input, string format, out Guid result, out string? error)
        {
            result = default;
            if (format.Length != 1)
            {
                throw new FormatException("Format string can be only \"D\", \"d\", \"N\", \"n\", \"P\", \"p\", \"B\", \"b\", \"X\" or \"x\".");
            }

            switch (format[0])
            {
                case 'D':
                case 'd':
                    return TryParseDashes(input, out result, out error);
                case 'N':
                case 'n':
                    return TryParseDigits(input, out result, out error);
                case 'B':
                case 'b':
                    return TryParseBraced(input, '{', '}', out result, out error);
                case 'P':
                case 'p':
                    return TryParseBraced(input, '(', ')', out result, out error);
                case 'X':
                case 'x':
                    return TryParseHexGroups(input, out result, out error);
                default:
                    throw new FormatException("Format string can be only \"D\", \"d\", \"N\", \"n\", \"P\", \"p\", \"B\", \"b\", \"X\" or \"x\".");
            }
        }

        private static bool TryParseAny(string input, out Guid result, out string? error)
        {
            result = default;
            if (input.Length == 0)
            {
                error = "Unrecognized Guid format.";
                return false;
            }

            return input[0] switch
            {
                '(' => TryParseBraced(input, '(', ')', out result, out error),
                '{' => input.Contains('-')
                    ? TryParseBraced(input, '{', '}', out result, out error)
                    : TryParseHexGroups(input, out result, out error),
                _ => input.Contains('-') ? TryParseDashes(input, out result, out error) : TryParseDigits(input, out result, out error),
            };
        }

        private static bool TryParseBraced(string input, char open, char close, out Guid result, out string? error)
        {
            result = default;
            if (input.Length != 38 || input[0] != open || input[37] != close)
            {
                error = "Unrecognized Guid format.";
                return false;
            }

            return TryParseDashes(input.Substring(1, 36), out result, out error);
        }

        private static bool TryParseDashes(string input, out Guid result, out string? error)
        {
            result = default;
            if (input.Length != 36 || input[8] != '-' || input[13] != '-' || input[18] != '-' || input[23] != '-')
            {
                error = input.Length != 36 ? "Unrecognized Guid format." : "Dashes are in the wrong position for GUID parsing.";
                return false;
            }

            return TryParseDigits(input.Remove(23, 1).Remove(18, 1).Remove(13, 1).Remove(8, 1), out result, out error);
        }

        private static bool TryParseDigits(string input, out Guid result, out string? error)
        {
            result = default;
            if (input.Length != 32)
            {
                error = "Unrecognized Guid format.";
                return false;
            }

            var bytes = new byte[16];
            for (int index = 0; index < 16; index++)
            {
                int high = HexValue(input[2 * index]);
                int low = HexValue(input[2 * index + 1]);
                if (high < 0 || low < 0)
                {
                    error = "Guid string should only contain hexadecimal characters.";
                    return false;
                }

                bytes[index] = (byte)((high << 4) | low);
            }

            result = new Guid(bytes, bigEndian: true);
            error = null;
            return true;
        }

        // {0xdddddddd,0xdddd,0xdddd,{0xdd,0xdd,0xdd,0xdd,0xdd,0xdd,0xdd,0xdd}}
        private static bool TryParseHexGroups(string input, out Guid result, out string? error)
        {
            result = default;
            string compact = input.Replace(" ", string.Empty);
            if (!compact.StartsWith('{') || !compact.EndsWith("}}", StringComparison.Ordinal))
            {
                error = "Unrecognized Guid format.";
                return false;
            }

            string[] parts = compact.Substring(1, compact.Length - 3).Replace("{", string.Empty).Split(',');
            int[] widths = [8, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2];
            if (parts.Length != 11)
            {
                error = "Unrecognized Guid format.";
                return false;
            }

            var digits = new StringBuilder(32);
            for (int index = 0; index < 11; index++)
            {
                string part = parts[index];
                if (part.Length < 3 || part[0] != '0' || (part[1] != 'x' && part[1] != 'X') || part.Length - 2 > widths[index])
                {
                    error = "Unrecognized Guid format.";
                    return false;
                }

                digits.Append('0', widths[index] - (part.Length - 2));
                digits.Append(part, 2, part.Length - 2);
            }

            return TryParseDigits(digits.ToString(), out result, out error);
        }

        private static int HexValue(char c) =>
            c >= '0' && c <= '9' ? c - '0'
            : c >= 'a' && c <= 'f' ? c - 'a' + 10
            : c >= 'A' && c <= 'F' ? c - 'A' + 10
            : -1;
    }
}
