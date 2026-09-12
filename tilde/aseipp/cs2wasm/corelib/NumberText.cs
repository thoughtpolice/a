// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// .NET's number parser (Number.Parsing.Common.cs's TryParseNumber) for the
// invariant culture's symbols, which BigInteger (corelib/BigInteger.cs) and
// the 128-bit integers (corelib/Int128.cs) read their NumberStyles beyond
// the integer ones with: the digits, the decimal scale and the sign, each
// type's own conversion deciding what of it fits.

namespace Gameplay.Runtime
{
    using System.Globalization;

    internal sealed class NumberText
    {
        internal static bool IsWhite(char ch) => ch == 0x20 || (uint)(ch - 0x09) <= 0x0D - 0x09;

        // The text's digits (without leading zeros; the significant ones end
        // at digEnd), the decimal exponent of the digits' point (scale; an
        // exponent past nine digits is int.MaxValue, or its negation, with
        // the digits' scale dropped) and the sign, or false when the text is
        // not a number of the styles. With `partial`, what follows the
        // number is left unread, and consumed says how much was read. An
        // integer's zero is never negative, but after a decimal point; a
        // floating-point one keeps its sign.
        internal static bool Scan(string text, NumberStyles styles, bool partial, bool integer, out char[] digits, out int digEnd, out int scale, out bool negative, out int consumed)
        {
            const int StateSign = 0x0001;
            const int StateParens = 0x0002;
            const int StateDigits = 0x0004;
            const int StateNonZero = 0x0008;
            const int StateDecimal = 0x0010;
            const int StateCurrency = 0x0020;

            digits = new char[text.Length];
            digEnd = 0;
            scale = 0;
            negative = false;
            consumed = 0;
            if (text.Length == 0)
            {
                return false;
            }

            int state = 0;
            int end = text.Length;
            int p = 0;
            bool currency = (styles & NumberStyles.AllowCurrencySymbol) != 0;
            char ch = p < end ? text[p] : '\0';

            while (true)
            {
                if (!IsWhite(ch) || (styles & NumberStyles.AllowLeadingWhite) == 0 || ((state & StateSign) != 0 && (state & StateCurrency) == 0))
                {
                    if ((styles & NumberStyles.AllowLeadingSign) != 0 && (state & StateSign) == 0 && (ch == '+' || ch == '-'))
                    {
                        negative |= ch == '-';
                        state |= StateSign;
                    }
                    else if (ch == '(' && (styles & NumberStyles.AllowParentheses) != 0 && (state & StateSign) == 0)
                    {
                        state |= StateSign | StateParens;
                        negative = true;
                    }
                    else if (currency && ch == '¤')
                    {
                        state |= StateCurrency;
                        currency = false;
                    }
                    else
                    {
                        break;
                    }
                }

                ch = ++p < end ? text[p] : '\0';
            }

            int digCount = 0;
            while (true)
            {
                if ((uint)(ch - '0') <= 9)
                {
                    state |= StateDigits;
                    if (ch != '0' || (state & StateNonZero) != 0)
                    {
                        digits[digCount] = ch;
                        if (ch != '0')
                        {
                            digEnd = digCount + 1;
                        }

                        if ((state & StateDecimal) == 0)
                        {
                            scale++;
                        }

                        digCount++;
                        state |= StateNonZero;
                    }
                    else if ((state & StateDecimal) != 0)
                    {
                        scale--;
                    }
                }
                else if ((styles & NumberStyles.AllowDecimalPoint) != 0 && (state & StateDecimal) == 0 && ch == '.')
                {
                    state |= StateDecimal;
                }
                else if ((styles & NumberStyles.AllowThousands) != 0 && (state & StateDigits) != 0 && (state & StateDecimal) == 0 && ch == ',')
                {
                }
                else
                {
                    break;
                }

                ch = ++p < end ? text[p] : '\0';
            }

            if ((state & StateDigits) == 0)
            {
                return false;
            }

            if ((ch == 'E' || ch == 'e') && (styles & NumberStyles.AllowExponent) != 0)
            {
                int mark = p;
                ch = ++p < end ? text[p] : '\0';
                bool negativeExponent = false;
                if (ch == '+')
                {
                    ch = ++p < end ? text[p] : '\0';
                }
                else if (ch == '-')
                {
                    ch = ++p < end ? text[p] : '\0';
                    negativeExponent = true;
                }

                if ((uint)(ch - '0') <= 9)
                {
                    int exponent = 0;
                    do
                    {
                        if (exponent >= 100_000_000)
                        {
                            exponent = int.MaxValue;
                            scale = 0;
                            while ((uint)(ch - '0') <= 9)
                            {
                                ch = ++p < end ? text[p] : '\0';
                            }

                            break;
                        }

                        exponent = exponent * 10 + (ch - '0');
                        ch = ++p < end ? text[p] : '\0';
                    }
                    while ((uint)(ch - '0') <= 9);

                    // An exponent past nine digits is int.MaxValue with the
                    // digits' scale dropped: an overflow, or a fraction.
                    scale += negativeExponent ? -exponent : exponent;
                }
                else
                {
                    p = mark;
                    ch = p < end ? text[p] : '\0';
                }
            }

            while (true)
            {
                if (!IsWhite(ch) || (styles & NumberStyles.AllowTrailingWhite) == 0)
                {
                    if ((styles & NumberStyles.AllowTrailingSign) != 0 && (state & StateSign) == 0 && (ch == '+' || ch == '-'))
                    {
                        negative |= ch == '-';
                        state |= StateSign;
                    }
                    else if (ch == ')' && (state & StateParens) != 0)
                    {
                        state &= ~StateParens;
                    }
                    else if (currency && ch == '¤')
                    {
                        currency = false;
                    }
                    else
                    {
                        break;
                    }
                }

                ch = ++p < end ? text[p] : '\0';
            }

            if ((state & StateParens) != 0)
            {
                return false;
            }

            if ((state & StateNonZero) == 0)
            {
                scale = 0;
                if (integer && (state & StateDecimal) == 0)
                {
                    negative = false;
                }
            }

            // Trailing nulls count as consumed.
            while (p < end && text[p] == '\0')
            {
                p++;
            }

            if (p != end && !partial)
            {
                return false;
            }

            consumed = p;
            return true;
        }
    }
}
