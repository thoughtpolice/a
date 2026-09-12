// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Complex's and Complex<T>'s text (docs/IMPORTER.md, "System.Runtime.Numerics
// as built"): their arithmetic is dotnet/runtime's (dotnet-runtime/Complex.cs
// and Complex.Generic.cs), but .NET formats and parses them over spans of its
// UTF-16 and UTF-8 character structs reinterpreted from spans of chars and
// bytes, and reinterprets a Complex as a Complex<double>. These are .NET's
// algorithms over strings: "<real; imaginary>" with each part formatted and
// parsed as T formats and parses it.

namespace System.Numerics
{
    using System.Globalization;
    using Utf8Text = Gameplay.Runtime.Utf8Text;

    public readonly partial struct Complex
    {
        public string ToString(string? format, IFormatProvider? provider) =>
            new Complex<double>(m_real, m_imaginary).ToString(format, provider);

        public bool TryFormat(Span<char> destination, out int charsWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            new Complex<double>(m_real, m_imaginary).TryFormat(destination, out charsWritten, format, provider);

        public bool TryFormat(Span<byte> utf8Destination, out int bytesWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null) =>
            new Complex<double>(m_real, m_imaginary).TryFormat(utf8Destination, out bytesWritten, format, provider);

        public static bool TryParse(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out Complex result)
        {
            bool parsed = Complex<double>.TryParse(s, style, provider, out Complex<double> value);
            result = new Complex(value.Real, value.Imaginary);
            return parsed;
        }

        public static bool TryParse(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out Complex result)
        {
            bool parsed = Complex<double>.TryParse(utf8Text, style, provider, out Complex<double> value);
            result = new Complex(value.Real, value.Imaginary);
            return parsed;
        }

        public static bool TryParsePartial(string? s, NumberStyles style, IFormatProvider? provider, out Complex result, out int charsConsumed)
        {
            bool parsed = Complex<double>.TryParsePartial(s, style, provider, out Complex<double> value, out charsConsumed);
            result = new Complex(value.Real, value.Imaginary);
            return parsed;
        }

        public static bool TryParsePartial(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out Complex result, out int bytesConsumed)
        {
            bool parsed = Complex<double>.TryParsePartial(utf8Text, style, provider, out Complex<double> value, out bytesConsumed);
            result = new Complex(value.Real, value.Imaginary);
            return parsed;
        }

        public static bool TryParsePartial(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out Complex result, out int charsConsumed)
        {
            bool parsed = Complex<double>.TryParsePartial(s, style, provider, out Complex<double> value, out charsConsumed);
            result = new Complex(value.Real, value.Imaginary);
            return parsed;
        }
    }

    public readonly partial struct Complex<T>
    {
        public string ToString(string? format, IFormatProvider? provider) =>
            "<" + m_real.ToString(format, provider) + "; " + m_imaginary.ToString(format, provider) + ">";

        // .NET's writes the parts into the destination and succeeds where
        // all of "<real; imaginary>" fits, as this does.
        public bool TryFormat(Span<char> destination, out int charsWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null)
        {
            string text = ToString(format.Length == 0 ? null : format.ToString(), provider);
            if (text.Length > destination.Length)
            {
                charsWritten = 0;
                return false;
            }

            for (int index = 0; index < text.Length; index++)
            {
                destination[index] = text[index];
            }

            charsWritten = text.Length;
            return true;
        }

        public bool TryFormat(Span<byte> utf8Destination, out int bytesWritten, ReadOnlySpan<char> format = default, IFormatProvider? provider = null)
        {
            byte[] bytes = Utf8Text.Encode(ToString(format.Length == 0 ? null : format.ToString(), provider));
            if (bytes.Length > utf8Destination.Length)
            {
                bytesWritten = 0;
                return false;
            }

            for (int index = 0; index < bytes.Length; index++)
            {
                utf8Destination[index] = bytes[index];
            }

            bytesWritten = bytes.Length;
            return true;
        }

        public static bool TryParse(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out Complex<T> result)
        {
            ValidateParseStyle(style);
            return TryParseText(s.ToString(), style, false, provider, out result, out _);
        }

        public static bool TryParse(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out Complex<T> result)
        {
            ValidateParseStyle(style);
            if (!Utf8Text.TryDecode(utf8Text, out string text))
            {
                result = default;
                return false;
            }

            return TryParseText(text, style, false, provider, out result, out _);
        }

        public static bool TryParsePartial(string? s, NumberStyles style, IFormatProvider? provider, out Complex<T> result, out int charsConsumed)
        {
            ValidateParseStyle(style);
            return TryParseText(s ?? "", style, true, provider, out result, out charsConsumed);
        }

        public static bool TryParsePartial(ReadOnlySpan<byte> utf8Text, NumberStyles style, IFormatProvider? provider, out Complex<T> result, out int bytesConsumed)
        {
            ValidateParseStyle(style);

            // What is consumed of ASCII text is what is consumed of its
            // chars; a partial parse stops at the first byte beyond it.
            int ascii = 0;
            while (ascii < utf8Text.Length && utf8Text[ascii] < 0x80)
            {
                ascii++;
            }

            var chars = new char[ascii];
            for (int index = 0; index < ascii; index++)
            {
                chars[index] = (char)utf8Text[index];
            }

            return TryParseText(new string(chars), style, true, provider, out result, out bytesConsumed);
        }

        public static bool TryParsePartial(ReadOnlySpan<char> s, NumberStyles style, IFormatProvider? provider, out Complex<T> result, out int charsConsumed)
        {
            ValidateParseStyle(style);
            return TryParseText(s.ToString(), style, true, provider, out result, out charsConsumed);
        }

        // .NET's ValidateParseStyleFloatingPoint.
        private static void ValidateParseStyle(NumberStyles style)
        {
            if ((style & (Complex.InvalidNumberStyles | NumberStyles.AllowHexSpecifier)) != 0)
            {
                if ((style & Complex.InvalidNumberStyles) != 0)
                {
                    throw new ArgumentException(SR.Argument_InvalidNumberStyles, nameof(style));
                }

                throw new ArgumentException(SR.Arg_HexStyleNotSupported);
            }
        }

        private static int WhiteLength(string text, int start, int end)
        {
            int index = start;
            while (index < end && char.IsWhiteSpace(text[index]))
            {
                index++;
            }

            return index - start;
        }

        // .NET's TryParseCore: "<", the real part up to ";", one white
        // space allowed whatever the style, the imaginary part up to ">",
        // each part parsed as T parses it with the style.
        private static bool TryParseText(string text, NumberStyles style, bool partial, IFormatProvider? provider, out Complex<T> result, out int consumed)
        {
            result = default;
            consumed = 0;
            int openBracket = text.IndexOf('<');
            int semicolon = text.IndexOf(';');
            int closeBracket = text.IndexOf('>');
            if (text.Length < 5 || openBracket == -1 || semicolon == -1 || closeBracket == -1
                || openBracket > semicolon || openBracket > closeBracket || semicolon > closeBracket)
            {
                return false;
            }

            if (openBracket != 0 && ((style & NumberStyles.AllowLeadingWhite) == 0 || WhiteLength(text, 0, openBracket) != openBracket))
            {
                return false;
            }

            if (!T.TryParse(text.AsSpan(openBracket + 1, semicolon - openBracket - 1), style, provider, out T? real))
            {
                return false;
            }

            if (semicolon + 1 < text.Length && char.IsWhiteSpace(text[semicolon + 1]))
            {
                semicolon++;
            }

            if (!T.TryParse(text.AsSpan(semicolon + 1, closeBracket - semicolon - 1), style, provider, out T? imaginary))
            {
                return false;
            }

            int trailingWhiteLength = 0;
            if (closeBracket != text.Length - 1)
            {
                bool invalid = true;
                if ((style & NumberStyles.AllowTrailingWhite) != 0)
                {
                    // Counted as consumed even where something else
                    // follows it, as .NET counts it.
                    trailingWhiteLength = WhiteLength(text, closeBracket + 1, text.Length);
                    invalid = closeBracket + 1 + trailingWhiteLength != text.Length;
                }

                if (invalid && !partial)
                {
                    return false;
                }
            }

            result = new Complex<T>(real!, imaginary!);
            consumed = closeBracket + 1 + trailingWhiteLength;
            return true;
        }
    }
}
