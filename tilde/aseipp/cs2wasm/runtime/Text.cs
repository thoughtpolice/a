// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The string and char members gameplay code calls, and parsing, as .NET
// has them with the invariant culture: ordinal comparison and searching,
// invariant casing, splitting, trimming and joining, and the Parse and
// TryParse of the numbers, bool and char. Culture-sensitive comparisons
// throw NotSupportedException; their overloads without a StringComparison
// are not shims at all, so the compiler rejects them. Like every shim,
// a member reaches a module only where code calls it.

namespace Gameplay.Runtime
{
    internal static class Text
    {
        // .NET's char.IsWhiteSpace.
        public static bool IsWhiteSpace(char value)
        {
            if (value < 256)
            {
                return value == ' ' || (value >= '\t' && value <= '\r') || value == ' ' || value == '\u0085';
            }

            int category = Unicode.Category(value);
            return category >= 11 && category <= 13;
        }

        public static string Slice(string text, int start, int length)
        {
            if (start == 0 && length == text.Length)
            {
                return text;
            }

            var result = StringIntrinsics.Allocate(length);
            for (int index = 0; index < length; index++)
            {
                StringIntrinsics.Set(result, index, text[start + index]);
            }

            return result;
        }

        public static bool IsCulture(System.StringComparison comparison)
        {
            if (comparison < System.StringComparison.CurrentCulture || comparison > System.StringComparison.OrdinalIgnoreCase)
            {
                throw new System.ArgumentException();
            }

            if (comparison < System.StringComparison.Ordinal)
            {
                // Linguistic comparison is the culture data's, which a module
                // does not have.
                throw new System.NotSupportedException();
            }

            return false;
        }

        // Code units equal under the comparison, a case-blind one comparing
        // their invariant upper cases.
        public static bool Same(char left, char right, bool ignoreCase) =>
            left == right || (ignoreCase && Unicode.ToUpper(left) == Unicode.ToUpper(right));

        public static bool MatchesAt(string text, int start, string value, bool ignoreCase)
        {
            for (int index = 0; index < value.Length; index++)
            {
                if (!Same(text[start + index], value[index], ignoreCase))
                {
                    return false;
                }
            }

            return true;
        }

        public static int Find(string text, string value, int start, int end, bool ignoreCase)
        {
            for (int index = start; index <= end - value.Length; index++)
            {
                if (MatchesAt(text, index, value, ignoreCase))
                {
                    return index;
                }
            }

            return -1;
        }

        // OrdinalIgnoreCase as .NET's invariant mode compares: by code
        // point (a surrogate pair is one), each uppercased, the first
        // difference deciding, then the lengths.
        public static int CompareIgnoreCase(string left, string right)
        {
            int a = 0;
            int b = 0;
            while (a < left.Length && b < right.Length)
            {
                if (left[a] == right[b])
                {
                    a++;
                    b++;
                    continue;
                }

                int pointA = CodePointAt(left, a);
                int pointB = CodePointAt(right, b);
                a += pointA > 0xFFFF ? 2 : 1;
                b += pointB > 0xFFFF ? 2 : 1;
                if (pointA == pointB)
                {
                    continue;
                }

                int difference = UpperCodePoint(pointA) - UpperCodePoint(pointB);
                if (difference != 0)
                {
                    return difference;
                }
            }

            return left.Length - right.Length;
        }

        private static int CodePointAt(string text, int index)
        {
            char c = text[index];
            if (c >= 0xD800 && c <= 0xDBFF && index + 1 < text.Length && text[index + 1] >= 0xDC00 && text[index + 1] <= 0xDFFF)
            {
                return 0x10000 + ((c - 0xD800) << 10) + (text[index + 1] - 0xDC00);
            }

            return c;
        }

        // Simple uppercase mapping, the supplementary planes' cased scripts
        // included.
        private static int UpperCodePoint(int point)
        {
            if (point <= 0xFFFF)
            {
                return Unicode.ToUpper((char)point);
            }

            if (point >= 0x10428 && point <= 0x1044F)
            {
                return point - 0x28; // Deseret
            }

            if (point >= 0x104D8 && point <= 0x104FB)
            {
                return point - 0x28; // Osage
            }

            if (point >= 0x10CC0 && point <= 0x10CF2)
            {
                return point - 0x40; // Old Hungarian
            }

            if (point >= 0x118C0 && point <= 0x118DF)
            {
                return point - 0x20; // Warang Citi
            }

            if (point >= 0x16E60 && point <= 0x16E7F)
            {
                return point - 0x20; // Medefaidrin
            }

            if (point >= 0x1E922 && point <= 0x1E943)
            {
                return point - 0x22; // Adlam
            }

            return point;
        }

        public static bool InSet(char value, char[] set)
        {
            if (set == null || set.Length == 0)
            {
                return IsWhiteSpace(value);
            }

            for (int index = 0; index < set.Length; index++)
            {
                if (set[index] == value)
                {
                    return true;
                }
            }

            return false;
        }

        // Trims both ends (1), the start (2) or the end (3) of what is in
        // the set, whitespace for none.
        public static string Trim(string text, char[] set, int ends)
        {
            int start = 0;
            int end = text.Length - 1;
            if (ends != 3)
            {
                while (start <= end && InSet(text[start], set))
                {
                    start++;
                }
            }

            if (ends != 2)
            {
                while (end >= start && InSet(text[end], set))
                {
                    end--;
                }
            }

            return Slice(text, start, end - start + 1);
        }

        public static string ChangeCase(string text, bool upper)
        {
            string result = null;
            for (int index = 0; index < text.Length; index++)
            {
                char value = text[index];
                char changed = value;
                if (value >= '\uD800' && value <= '\uDBFF' && index + 1 < text.Length
                    && text[index + 1] >= '\uDC00' && text[index + 1] <= '\uDFFF')
                {
                    int point = 0x10000 + ((value - 0xD800) << 10) + (text[index + 1] - 0xDC00);
                    int mapped = upper ? Unicode.ToUpperSupplementary(point) : Unicode.ToLowerSupplementary(point);
                    if (mapped != point)
                    {
                        result ??= Copy(text, index);
                        StringIntrinsics.Set(result, index, (char)(0xD800 + ((mapped - 0x10000) >> 10)));
                        StringIntrinsics.Set(result, index + 1, (char)(0xDC00 + ((mapped - 0x10000) & 0x3FF)));
                    }
                    else if (result != null)
                    {
                        StringIntrinsics.Set(result, index, value);
                        StringIntrinsics.Set(result, index + 1, text[index + 1]);
                    }

                    index++;
                    continue;
                }

                changed = upper ? Unicode.ToUpper(value) : Unicode.ToLower(value);
                if (changed != value && result == null)
                {
                    result = Copy(text, index);
                }

                if (result != null)
                {
                    StringIntrinsics.Set(result, index, changed);
                }
            }

            return result ?? text;
        }

        // A new string of text's length holding its first `count` units.
        private static string Copy(string text, int count)
        {
            var result = StringIntrinsics.Allocate(text.Length);
            for (int index = 0; index < count; index++)
            {
                StringIntrinsics.Set(result, index, text[index]);
            }

            return result;
        }

        public static string Join(string separator, string[] values, int start, int count)
        {
            separator ??= "";
            int length = 0;
            for (int index = start; index < start + count; index++)
            {
                length += (values[index] ?? "").Length;
            }

            if (count > 0)
            {
                length += separator.Length * (count - 1);
            }

            var result = StringIntrinsics.Allocate(length);
            int position = 0;
            for (int index = start; index < start + count; index++)
            {
                if (index > start)
                {
                    position = Put(result, position, separator);
                }

                position = Put(result, position, values[index] ?? "");
            }

            return result;
        }

        public static int Put(string target, int position, string source)
        {
            for (int index = 0; index < source.Length; index++)
            {
                StringIntrinsics.Set(target, position + index, source[index]);
            }

            return position + source.Length;
        }

        // .NET's String.Split: the separators' positions and lengths, then
        // the pieces, as SplitWithoutPostProcessing and
        // SplitWithPostProcessing make them.
        public static string[] Split(string text, char[] characters, string[] strings, bool whitespace, int count, System.StringSplitOptions options)
        {
            if (count < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            if (options < System.StringSplitOptions.None || options > (System.StringSplitOptions)3)
            {
                throw new System.ArgumentException();
            }

            bool trim = (options & (System.StringSplitOptions)2) != 0;
            bool removeEmpty = (options & System.StringSplitOptions.RemoveEmptyEntries) != 0;
            if (count <= 1 || text.Length == 0)
            {
                string candidate = text;
                if (trim && count > 0)
                {
                    candidate = Trim(candidate, null, 1);
                }

                if (removeEmpty && candidate.Length == 0)
                {
                    count = 0;
                }

                return count == 0 ? new string[0] : new[] { candidate };
            }

            var positions = new System.Collections.Generic.List<int>();
            var lengths = new System.Collections.Generic.List<int>();
            for (int index = 0; index < text.Length; index++)
            {
                char value = text[index];
                if (whitespace)
                {
                    if (IsWhiteSpace(value))
                    {
                        positions.Add(index);
                        lengths.Add(1);
                    }
                }
                else if (characters != null)
                {
                    for (int candidate = 0; candidate < characters.Length; candidate++)
                    {
                        if (characters[candidate] == value)
                        {
                            positions.Add(index);
                            lengths.Add(1);
                            break;
                        }
                    }
                }
                else
                {
                    for (int candidate = 0; candidate < strings.Length; candidate++)
                    {
                        string separator = strings[candidate];
                        if (separator == null || separator.Length == 0)
                        {
                            continue;
                        }

                        if (value == separator[0] && separator.Length <= text.Length - index
                            && MatchesAt(text, index, separator, false))
                        {
                            positions.Add(index);
                            lengths.Add(separator.Length);
                            index += separator.Length - 1;
                            break;
                        }
                    }
                }
            }

            if (positions.Count == 0)
            {
                string candidate = trim ? Trim(text, null, 1) : text;
                return removeEmpty && candidate.Length == 0 ? new string[0] : new[] { candidate };
            }

            int current = 0;
            if (!trim && !removeEmpty)
            {
                count--;
                int replaces = positions.Count < count ? positions.Count : count;
                var pieces = new string[replaces + 1];
                int slot = 0;
                for (int index = 0; index < replaces; index++)
                {
                    pieces[slot++] = Slice(text, current, positions[index] - current);
                    current = positions[index] + lengths[index];
                }

                if (current < text.Length && replaces >= 0)
                {
                    pieces[slot] = Slice(text, current, text.Length - current);
                }
                else if (slot == replaces)
                {
                    pieces[slot] = "";
                }

                return pieces;
            }

            int maximum = positions.Count < count ? positions.Count + 1 : count;
            var results = new string[maximum];
            int filled = 0;
            string entry;
            for (int index = 0; index < positions.Count; index++)
            {
                entry = Slice(text, current, positions[index] - current);
                if (trim)
                {
                    entry = Trim(entry, null, 1);
                }

                if (entry.Length != 0 || !removeEmpty)
                {
                    results[filled++] = entry;
                }

                current = positions[index] + lengths[index];
                if (filled == count - 1)
                {
                    if (removeEmpty)
                    {
                        while (++index < positions.Count)
                        {
                            entry = Slice(text, current, positions[index] - current);
                            if (trim)
                            {
                                entry = Trim(entry, null, 1);
                            }

                            if (entry.Length != 0)
                            {
                                break;
                            }

                            current = positions[index] + lengths[index];
                        }
                    }

                    break;
                }
            }

            entry = Slice(text, current, text.Length - current);
            if (trim)
            {
                entry = Trim(entry, null, 1);
            }

            if (entry.Length != 0 || !removeEmpty)
            {
                results[filled++] = entry;
            }

            if (filled == results.Length)
            {
                return results;
            }

            var trimmed = new string[filled];
            for (int index = 0; index < filled; index++)
            {
                trimmed[index] = results[index];
            }

            return trimmed;
        }
    }

    // Integers, floats and bools from text, as .NET's Parse and TryParse
    // read them with the invariant culture: NumberStyles.Integer for the
    // integers and Float | AllowThousands for the floats.
    internal static class Parsing
    {
        private static bool IsSpace(char value) => value == ' ' || (value >= '\t' && value <= '\r');

        // The end of the text without its trailing whitespace and nulls,
        // as .NET tolerates them.
        private static int End(string text, int start)
        {
            int end = text.Length;
            while (end > start && text[end - 1] == '\0')
            {
                end--;
            }

            while (end > start && IsSpace(text[end - 1]))
            {
                end--;
            }

            return end;
        }

        // 0 parsed, 1 badly formed, 2 out of the range [minimum, maximum]
        // of the type (the unsigned ones taking magnitudes to ulong).
        public static int Integer(string text, bool unsigned, long minimum, ulong maximum, out ulong bits)
        {
            bits = 0;
            if (text == null)
            {
                return 1;
            }

            int index = 0;
            while (index < text.Length && IsSpace(text[index]))
            {
                index++;
            }

            int end = End(text, index);
            bool negative = false;
            if (index < end && (text[index] == '-' || text[index] == '+'))
            {
                negative = text[index] == '-';
                index++;
            }

            if (index >= end)
            {
                return 1;
            }

            ulong magnitude = 0;
            bool overflow = false;
            for (; index < end; index++)
            {
                uint digit = (uint)(text[index] - '0');
                if (digit > 9)
                {
                    return 1;
                }

                if (magnitude > (ulong.MaxValue - digit) / 10)
                {
                    overflow = true;
                }
                else
                {
                    magnitude = magnitude * 10 + digit;
                }
            }

            if (overflow)
            {
                return 2;
            }

            if (negative)
            {
                if (magnitude == 0)
                {
                    return 0;
                }

                if (unsigned || magnitude > (ulong)(-(minimum + 1)) + 1)
                {
                    return 2;
                }

                bits = (ulong)(-(long)(magnitude - 1) - 1);
                return 0;
            }

            if (magnitude > maximum)
            {
                return 2;
            }

            bits = magnitude;
            return 0;
        }

        public static long Checked(string text, bool unsigned, long minimum, ulong maximum)
        {
            if (text == null)
            {
                throw new System.ArgumentNullException();
            }

            int outcome = Integer(text, unsigned, minimum, maximum, out ulong bits);
            if (outcome == 1)
            {
                throw new System.FormatException();
            }

            if (outcome == 2)
            {
                throw new System.OverflowException();
            }

            return (long)bits;
        }

        private static bool Matches(string text, int start, int end, string word)
        {
            if (end - start != word.Length)
            {
                return false;
            }

            for (int index = 0; index < word.Length; index++)
            {
                if (Unicode.ToUpper(text[start + index]) != Unicode.ToUpper(word[index]))
                {
                    return false;
                }
            }

            return true;
        }

        // A float or double, or NaN with `failed` set.
        // Whether text uses only what a floating point NumberStyles allows
        // of Float | AllowThousands (Floating's), after .NET's validation
        // of the style (NumberFormatInfo.ValidateParseStyleFloatingPoint).
        public static bool FloatingStyle(string text, int style)
        {
            if ((style & ~0x7FF) != 0)
            {
                throw new System.ArgumentException("An undefined NumberStyles value is being used.", "style");
            }

            if ((style & 0x600) != 0)
            {
                throw new System.ArgumentException("The number styles AllowHexSpecifier and AllowBinarySpecifier are not supported on floating point data types.");
            }

            int start = 0;
            while (start < text.Length && IsSpace(text[start]))
            {
                start++;
            }

            int end = text.Length;
            while (end > start && (IsSpace(text[end - 1]) || text[end - 1] == '\0'))
            {
                end--;
            }

            if ((start != 0 && (style & 0x01) == 0) || (end != text.Length && (style & 0x02) == 0))
            {
                return false;
            }

            for (int index = start; index < end; index++)
            {
                char c = text[index];
                if ((c == ',' && (style & 0x40) == 0) || (c == '.' && (style & 0x20) == 0)
                    || ((c == 'e' || c == 'E') && (style & 0x80) == 0 && index > start && (uint)(text[index - 1] - '0') <= 9)
                    || ((c == '+' || c == '-') && index == start && (style & 0x04) == 0))
                {
                    return false;
                }
            }

            return true;
        }

        public static double Floating(string text, bool single, out bool failed)
        {
            failed = false;
            if (text == null)
            {
                failed = true;
                return 0;
            }

            int index = 0;
            while (index < text.Length && IsSpace(text[index]))
            {
                index++;
            }

            int end = End(text, index);
            int start = index;
            bool negative = false;
            if (index < end && (text[index] == '-' || text[index] == '+'))
            {
                negative = text[index] == '-';
                index++;
            }

            var digits = new Big();
            int count = 0;
            int scale = 0;
            bool anyDigit = false;
            bool point = false;
            for (; index < end; index++)
            {
                char value = text[index];
                if (value >= '0' && value <= '9')
                {
                    anyDigit = true;
                    if (count > 0 || value != '0')
                    {
                        digits.MultiplySmall(10);
                        digits.AddSmall((uint)(value - '0'));
                        count++;
                    }

                    if (point)
                    {
                        scale--;
                    }
                }
                else if (value == '.' && !point)
                {
                    point = true;
                }
                else if (value == ',' && anyDigit && !point)
                {
                }
                else
                {
                    break;
                }
            }

            if (anyDigit && index < end && (text[index] == 'e' || text[index] == 'E'))
            {
                int mark = index;
                index++;
                bool negativeExponent = false;
                if (index < end && (text[index] == '+' || text[index] == '-'))
                {
                    negativeExponent = text[index] == '-';
                    index++;
                }

                if (index < end && text[index] >= '0' && text[index] <= '9')
                {
                    int exponent = 0;
                    for (; index < end && text[index] >= '0' && text[index] <= '9'; index++)
                    {
                        if (exponent < 100000)
                        {
                            exponent = exponent * 10 + (text[index] - '0');
                        }
                    }

                    scale += negativeExponent ? -exponent : exponent;
                }
                else
                {
                    index = mark;
                }
            }

            if (!anyDigit || index != end)
            {
                double special = Special(text, start, end);
                failed = double.IsNaN(special) && !Matches(text, start, end, "NaN")
                    && !Matches(text, start, end, "+NaN") && !Matches(text, start, end, "-NaN");
                return special;
            }

            double magnitude;
            if (count == 0 || count + scale < -350)
            {
                magnitude = 0;
            }
            else if (count + scale > 350)
            {
                magnitude = double.PositiveInfinity;
            }
            else if (scale >= 0)
            {
                digits.MultiplyPow10(scale);
                var one = new Big();
                one.Set(1);
                magnitude = DecimalRounding.Nearest(digits, one, single);
            }
            else
            {
                magnitude = DecimalRounding.Nearest(digits, -scale, single);
            }

            if (single)
            {
                magnitude = (float)magnitude;
            }

            return negative ? -magnitude : magnitude;
        }

        private static double Special(string text, int start, int end)
        {
            if (Matches(text, start, end, "Infinity") || Matches(text, start, end, "+Infinity"))
            {
                return double.PositiveInfinity;
            }

            if (Matches(text, start, end, "-Infinity"))
            {
                return double.NegativeInfinity;
            }

            return double.NaN;
        }

        public static int Boolean(string text)
        {
            if (text == null)
            {
                return -1;
            }

            int index = 0;
            while (index < text.Length && Text.IsWhiteSpace(text[index]))
            {
                index++;
            }

            int end = text.Length;
            while (end > index && (Text.IsWhiteSpace(text[end - 1]) || text[end - 1] == '\0'))
            {
                end--;
            }

            return Matches(text, index, end, "True") ? 1 : Matches(text, index, end, "False") ? 0 : -1;
        }
    }
}

namespace Gameplay.Runtime.Shims
{
    internal static class String
    {
        // A hash consistent with string equality: the collections' (FNV-1a
        // over the code units), where the CLR's is randomized per process.
        public static int InstanceGetHashCode(string self)
        {
            _ = self.Length;
            return Intrinsics.Hash(self);
        }

        // string.GetEnumerator's CharEnumerator is the runtime's
        // StringEnumerator.
        public static StringEnumerator InstanceGetEnumerator(string self)
        {
            _ = self.Length;
            return new StringEnumerator(self);
        }

        public static bool Contains(string self, string value)
        {
            _ = self.Length;
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            return Text.Find(self, value, 0, self.Length, false) >= 0;
        }

        public static bool Contains(string self, string value, System.StringComparison comparison)
        {
            _ = self.Length;
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            Text.IsCulture(comparison);
            return Text.Find(self, value, 0, self.Length, comparison == System.StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static bool Contains(string self, char value, System.StringComparison comparison)
        {
            _ = self.Length;
            Text.IsCulture(comparison);
            bool ignoreCase = comparison == System.StringComparison.OrdinalIgnoreCase;
            for (int index = 0; index < self.Length; index++)
            {
                if (Text.Same(self[index], value, ignoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        public static bool StartsWith(string self, char value) => self.Length != 0 && self[0] == value;

        public static bool EndsWith(string self, char value) => self.Length != 0 && self[self.Length - 1] == value;

        public static bool StartsWith(string self, string value, System.StringComparison comparison)
        {
            _ = self.Length;
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            Text.IsCulture(comparison);
            return value.Length <= self.Length
                && Text.MatchesAt(self, 0, value, comparison == System.StringComparison.OrdinalIgnoreCase);
        }

        public static bool EndsWith(string self, string value, System.StringComparison comparison)
        {
            _ = self.Length;
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            Text.IsCulture(comparison);
            return value.Length <= self.Length
                && Text.MatchesAt(self, self.Length - value.Length, value, comparison == System.StringComparison.OrdinalIgnoreCase);
        }

        public static bool InstanceEquals(string self, string value, System.StringComparison comparison)
        {
            _ = self.Length;
            Text.IsCulture(comparison);
            if (value == null || value.Length != self.Length)
            {
                return false;
            }

            return Text.MatchesAt(self, 0, value, comparison == System.StringComparison.OrdinalIgnoreCase);
        }

        public static bool Equals(string left, string right, System.StringComparison comparison)
        {
            Text.IsCulture(comparison);
            if (left == null || right == null)
            {
                return (object)left == right;
            }

            return left.Length == right.Length
                && Text.MatchesAt(left, 0, right, comparison == System.StringComparison.OrdinalIgnoreCase);
        }

        public static int Compare(string left, string right, System.StringComparison comparison)
        {
            Text.IsCulture(comparison);
            if (comparison == System.StringComparison.Ordinal || left == null || right == null)
            {
                return Strings.CompareOrdinal(left, right);
            }

            return Text.CompareIgnoreCase(left, right);
        }

        public static int IndexOf(string self, char value, int start)
        {
            if (start < 0 || start > self.Length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return IndexOf(self, value, start, self.Length - start);
        }

        public static int IndexOf(string self, char value, int start, int count)
        {
            if (start < 0 || start > self.Length || count < 0 || count > self.Length - start)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            for (int index = start; index < start + count; index++)
            {
                if (self[index] == value)
                {
                    return index;
                }
            }

            return -1;
        }

        public static int IndexOf(string self, char value, System.StringComparison comparison)
        {
            _ = self.Length;
            Text.IsCulture(comparison);
            bool ignoreCase = comparison == System.StringComparison.OrdinalIgnoreCase;
            for (int index = 0; index < self.Length; index++)
            {
                if (Text.Same(self[index], value, ignoreCase))
                {
                    return index;
                }
            }

            return -1;
        }

        public static int IndexOf(string self, string value, System.StringComparison comparison) =>
            IndexOf(self, value, 0, self.Length, comparison);

        public static int IndexOf(string self, string value, int start, System.StringComparison comparison)
        {
            if (start < 0 || start > self.Length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return IndexOf(self, value, start, self.Length - start, comparison);
        }

        public static int IndexOf(string self, string value, int start, int count, System.StringComparison comparison)
        {
            _ = self.Length;
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            if (start < 0 || start > self.Length || count < 0 || count > self.Length - start)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            Text.IsCulture(comparison);
            return Text.Find(self, value, start, start + count, comparison == System.StringComparison.OrdinalIgnoreCase);
        }

        public static int LastIndexOf(string self, char value)
        {
            for (int index = self.Length - 1; index >= 0; index--)
            {
                if (self[index] == value)
                {
                    return index;
                }
            }

            return -1;
        }

        public static int LastIndexOf(string self, char value, int start)
        {
            if (self.Length == 0)
            {
                return -1;
            }

            if (start < 0 || start >= self.Length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            for (int index = start; index >= 0; index--)
            {
                if (self[index] == value)
                {
                    return index;
                }
            }

            return -1;
        }

        public static int LastIndexOf(string self, string value, System.StringComparison comparison)
        {
            _ = self.Length;
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            Text.IsCulture(comparison);
            bool ignoreCase = comparison == System.StringComparison.OrdinalIgnoreCase;
            for (int index = self.Length - value.Length; index >= 0; index--)
            {
                if (Text.MatchesAt(self, index, value, ignoreCase))
                {
                    return index;
                }
            }

            return value.Length == 0 ? self.Length : -1;
        }

        public static int IndexOfAny(string self, char[] values) => IndexOfAny(self, values, 0);

        public static int IndexOfAny(string self, char[] values, int start)
        {
            _ = self.Length;
            if (values == null)
            {
                throw new System.ArgumentNullException();
            }

            if (start < 0 || start > self.Length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            for (int index = start; index < self.Length; index++)
            {
                for (int candidate = 0; candidate < values.Length; candidate++)
                {
                    if (self[index] == values[candidate])
                    {
                        return index;
                    }
                }
            }

            return -1;
        }

        public static int LastIndexOfAny(string self, char[] values)
        {
            _ = self.Length;
            if (values == null)
            {
                throw new System.ArgumentNullException();
            }

            for (int index = self.Length - 1; index >= 0; index--)
            {
                for (int candidate = 0; candidate < values.Length; candidate++)
                {
                    if (self[index] == values[candidate])
                    {
                        return index;
                    }
                }
            }

            return -1;
        }

        public static string Replace(string self, char oldValue, char newValue)
        {
            int first = Strings.IndexOf(self, oldValue);
            if (first < 0)
            {
                return self;
            }

            var result = StringIntrinsics.Allocate(self.Length);
            for (int index = 0; index < self.Length; index++)
            {
                char value = self[index];
                StringIntrinsics.Set(result, index, index >= first && value == oldValue ? newValue : value);
            }

            return result;
        }

        public static string Replace(string self, string oldValue, string newValue)
        {
            _ = self.Length;
            if (oldValue == null)
            {
                throw new System.ArgumentNullException();
            }

            if (oldValue.Length == 0)
            {
                throw new System.ArgumentException();
            }

            newValue ??= "";
            int found = Text.Find(self, oldValue, 0, self.Length, false);
            if (found < 0)
            {
                return self;
            }

            int matches = 0;
            for (int index = found; index >= 0; index = Text.Find(self, oldValue, index + oldValue.Length, self.Length, false))
            {
                matches++;
            }

            var result = StringIntrinsics.Allocate(self.Length + matches * (newValue.Length - oldValue.Length));
            int position = 0;
            int copied = 0;
            for (int index = found; index >= 0; index = Text.Find(self, oldValue, index + oldValue.Length, self.Length, false))
            {
                position = Text.Put(result, position, Text.Slice(self, copied, index - copied));
                position = Text.Put(result, position, newValue);
                copied = index + oldValue.Length;
            }

            Text.Put(result, position, Text.Slice(self, copied, self.Length - copied));
            return result;
        }

        public static string Trim(string self) => Text.Trim(self, null, 1);

        public static string Trim(string self, char value) => Text.Trim(self, new[] { value }, 1);

        public static string Trim(string self, char[] values) => Text.Trim(self, values, 1);

        public static string TrimStart(string self) => Text.Trim(self, null, 2);

        public static string TrimStart(string self, char value) => Text.Trim(self, new[] { value }, 2);

        public static string TrimStart(string self, char[] values) => Text.Trim(self, values, 2);

        public static string TrimEnd(string self) => Text.Trim(self, null, 3);

        public static string TrimEnd(string self, char value) => Text.Trim(self, new[] { value }, 3);

        public static string TrimEnd(string self, char[] values) => Text.Trim(self, values, 3);

        // The current culture is the invariant one here.
        public static string ToUpper(string self) => Text.ChangeCase(self, true);

        public static string ToLower(string self) => Text.ChangeCase(self, false);

        public static string ToUpperInvariant(string self) => Text.ChangeCase(self, true);

        public static string ToLowerInvariant(string self) => Text.ChangeCase(self, false);

        public static string PadLeft(string self, int totalWidth) => PadLeft(self, totalWidth, ' ');

        public static string PadLeft(string self, int totalWidth, char padding)
        {
            _ = self.Length;
            if (totalWidth < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            if (totalWidth <= self.Length)
            {
                return self;
            }

            var result = StringIntrinsics.Allocate(totalWidth);
            int pad = totalWidth - self.Length;
            for (int index = 0; index < pad; index++)
            {
                StringIntrinsics.Set(result, index, padding);
            }

            Text.Put(result, pad, self);
            return result;
        }

        public static string PadRight(string self, int totalWidth) => PadRight(self, totalWidth, ' ');

        public static string PadRight(string self, int totalWidth, char padding)
        {
            _ = self.Length;
            if (totalWidth < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            if (totalWidth <= self.Length)
            {
                return self;
            }

            var result = StringIntrinsics.Allocate(totalWidth);
            Text.Put(result, 0, self);
            for (int index = self.Length; index < totalWidth; index++)
            {
                StringIntrinsics.Set(result, index, padding);
            }

            return result;
        }

        public static string Insert(string self, int startIndex, string value)
        {
            _ = self.Length;
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            if (startIndex < 0 || startIndex > self.Length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            var result = StringIntrinsics.Allocate(self.Length + value.Length);
            int position = Text.Put(result, 0, Text.Slice(self, 0, startIndex));
            position = Text.Put(result, position, value);
            Text.Put(result, position, Text.Slice(self, startIndex, self.Length - startIndex));
            return result;
        }

        public static string Remove(string self, int startIndex)
        {
            if (startIndex < 0 || startIndex >= self.Length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return Text.Slice(self, 0, startIndex);
        }

        public static string Remove(string self, int startIndex, int count)
        {
            if (startIndex < 0 || count < 0 || count > self.Length - startIndex)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            var result = StringIntrinsics.Allocate(self.Length - count);
            int position = Text.Put(result, 0, Text.Slice(self, 0, startIndex));
            Text.Put(result, position, Text.Slice(self, startIndex + count, self.Length - startIndex - count));
            return result;
        }

        public static char[] ToCharArray(string self)
        {
            var result = new char[self.Length];
            for (int index = 0; index < self.Length; index++)
            {
                result[index] = self[index];
            }

            return result;
        }

        public static char[] ToCharArray(string self, int startIndex, int length)
        {
            if (startIndex < 0 || startIndex > self.Length || length < 0 || startIndex > self.Length - length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            var result = new char[length];
            for (int index = 0; index < length; index++)
            {
                result[index] = self[startIndex + index];
            }

            return result;
        }

        public static string[] Split(string self, char[] separator) =>
            Text.Split(self, separator, null, separator == null || separator.Length == 0, int.MaxValue, System.StringSplitOptions.None);

        public static string[] Split(string self, char separator, System.StringSplitOptions options) =>
            Text.Split(self, new[] { separator }, null, false, int.MaxValue, options);

        public static string[] Split(string self, char separator, int count, System.StringSplitOptions options) =>
            Text.Split(self, new[] { separator }, null, false, count, options);

        public static string[] Split(string self, char[] separator, int count) =>
            Text.Split(self, separator, null, separator == null || separator.Length == 0, count, System.StringSplitOptions.None);

        public static string[] Split(string self, char[] separator, System.StringSplitOptions options) =>
            Text.Split(self, separator, null, separator == null || separator.Length == 0, int.MaxValue, options);

        public static string[] Split(string self, char[] separator, int count, System.StringSplitOptions options) =>
            Text.Split(self, separator, null, separator == null || separator.Length == 0, count, options);

        public static string[] Split(string self, string separator, System.StringSplitOptions options) =>
            Split(self, separator, int.MaxValue, options);

        public static string[] Split(string self, string separator, int count, System.StringSplitOptions options) =>
            Text.Split(self, null, new[] { separator ?? "" }, false, count, options);

        public static string[] Split(string self, string[] separator, System.StringSplitOptions options) =>
            Split(self, separator, int.MaxValue, options);

        public static string[] Split(string self, string[] separator, int count, System.StringSplitOptions options) =>
            Text.Split(self, null, separator, separator == null || separator.Length == 0, count, options);

        public static bool IsNullOrEmpty(string value) => Strings.IsNullOrEmpty(value);

        public static bool IsNullOrWhiteSpace(string value)
        {
            if (value == null)
            {
                return true;
            }

            for (int index = 0; index < value.Length; index++)
            {
                if (!Text.IsWhiteSpace(value[index]))
                {
                    return false;
                }
            }

            return true;
        }

        public static string Join(string separator, string[] value)
        {
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            return Text.Join(separator, value, 0, value.Length);
        }

        public static string Join(char separator, string[] value)
        {
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            return Text.Join(Strings.FromChar(separator), value, 0, value.Length);
        }

        public static string Join(string separator, string[] value, int startIndex, int count)
        {
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            if (startIndex < 0 || count < 0 || startIndex > value.Length - count)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return Text.Join(separator, value, startIndex, count);
        }

        public static string Join(string separator, object[] values)
        {
            if (values == null)
            {
                throw new System.ArgumentNullException();
            }

            var texts = new string[values.Length];
            for (int index = 0; index < values.Length; index++)
            {
                texts[index] = values[index]?.ToString();
            }

            return Text.Join(separator, texts, 0, texts.Length);
        }

        public static string Join(string separator, System.Collections.Generic.IEnumerable<string> values)
        {
            if (values == null)
            {
                throw new System.ArgumentNullException();
            }

            var texts = new System.Collections.Generic.List<string>();
            foreach (string value in values)
            {
                texts.Add(value);
            }

            return Text.Join(separator, texts.ToArray(), 0, texts.Count);
        }

        public static string Join<T>(string separator, System.Collections.Generic.IEnumerable<T> values)
        {
            if (values == null)
            {
                throw new System.ArgumentNullException();
            }

            var texts = new System.Collections.Generic.List<string>();
            foreach (T value in values)
            {
                texts.Add(value?.ToString());
            }

            return Text.Join(separator, texts.ToArray(), 0, texts.Count);
        }

        public static string Join<T>(char separator, System.Collections.Generic.IEnumerable<T> values) =>
            Join(Strings.FromChar(separator), values);

        public static string Concat(System.Collections.Generic.IEnumerable<string> values) => Join("", values);

        public static string Concat<T>(System.Collections.Generic.IEnumerable<T> values) => Join("", values);

        public static string Concat(string[] values)
        {
            if (values == null)
            {
                throw new System.ArgumentNullException();
            }

            return Text.Join("", values, 0, values.Length);
        }

        public static string Concat(object value) => value?.ToString() ?? "";

        public static string Concat(object first, object second) => Strings.Concat(first?.ToString(), second?.ToString());

        public static string Concat(object first, object second, object third) =>
            Strings.Concat(first?.ToString(), second?.ToString(), third?.ToString());

        public static string Concat(object[] values)
        {
            if (values == null)
            {
                throw new System.ArgumentNullException();
            }

            var texts = new string[values.Length];
            for (int index = 0; index < values.Length; index++)
            {
                texts[index] = values[index]?.ToString();
            }

            return Text.Join("", texts, 0, texts.Length);
        }

        public static string Format(string format, object arg0) => Composite.Format(format, new[] { arg0 });

        public static string Format(string format, object arg0, object arg1) =>
            Composite.Format(format, new[] { arg0, arg1 });

        public static string Format(string format, object arg0, object arg1, object arg2) =>
            Composite.Format(format, new[] { arg0, arg1, arg2 });

        public static string Format(string format, object[] args) => Composite.Format(format, args);

        // The invariant culture's (the only one here), which anonymous
        // types' ToString passes as null.
        public static string Format(System.IFormatProvider provider, string format, object[] args) =>
            Composite.Format(format, args);

        // Constructors, which the compiler calls for `new string(...)`.
        public static string New(char c, int count)
        {
            if (count < 0)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            var result = StringIntrinsics.Allocate(count);
            for (int index = 0; index < count; index++)
            {
                StringIntrinsics.Set(result, index, c);
            }

            return result;
        }

        public static string New(char[] value) => value == null ? "" : New(value, 0, value.Length);

        public static string New(Gameplay.Runtime.ReadOnlySpan<char> value) => value.ToString();

        public static string Concat(Gameplay.Runtime.ReadOnlySpan<char> first, Gameplay.Runtime.ReadOnlySpan<char> second) =>
            Strings.Concat(first.ToString(), second.ToString());

        public static string Concat(
            Gameplay.Runtime.ReadOnlySpan<char> first,
            Gameplay.Runtime.ReadOnlySpan<char> second,
            Gameplay.Runtime.ReadOnlySpan<char> third) =>
            Strings.Concat(first.ToString(), second.ToString(), third.ToString());

        // C# concatenates four operands with chars among them so.
        public static string Concat(
            Gameplay.Runtime.ReadOnlySpan<char> first,
            Gameplay.Runtime.ReadOnlySpan<char> second,
            Gameplay.Runtime.ReadOnlySpan<char> third,
            Gameplay.Runtime.ReadOnlySpan<char> fourth) =>
            Strings.Concat(first.ToString(), second.ToString(), third.ToString(), fourth.ToString());

        public static string New(char[] value, int startIndex, int length)
        {
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            if (startIndex < 0 || length < 0 || startIndex > value.Length - length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            var result = StringIntrinsics.Allocate(length);
            for (int index = 0; index < length; index++)
            {
                StringIntrinsics.Set(result, index, value[startIndex + index]);
            }

            return result;
        }
    }

    internal static class Char
    {
        public static int CompareTo(char value, char other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(char value, object obj) =>
            obj == null ? 1 : obj is char other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type Char.");

        public static bool InstanceEquals(char value, char other) => value == other;

        public static bool InstanceEquals(char value, object obj) => obj is char other && value == other;

        public static bool IsDigit(char c) => c < 256 ? (uint)(c - '0') <= 9 : Unicode.Category(c) == 8;

        public static bool IsLetter(char c) => Unicode.Category(c) <= 4;

        public static bool IsLetterOrDigit(char c)
        {
            int category = Unicode.Category(c);
            return category <= 4 || category == 8;
        }

        public static bool IsUpper(char c) => Unicode.Category(c) == 0;

        public static bool IsLower(char c) => Unicode.Category(c) == 1;

        public static bool IsNumber(char c)
        {
            int category = Unicode.Category(c);
            return category >= 8 && category <= 10;
        }

        public static bool IsPunctuation(char c)
        {
            int category = Unicode.Category(c);
            return category >= 18 && category <= 24;
        }

        public static bool IsSymbol(char c)
        {
            int category = Unicode.Category(c);
            return category >= 25 && category <= 28;
        }

        public static bool IsSeparator(char c)
        {
            int category = Unicode.Category(c);
            return category >= 11 && category <= 13;
        }

        public static bool IsControl(char c) => Unicode.Category(c) == 14;

        public static bool IsWhiteSpace(char c) => Text.IsWhiteSpace(c);

        public static bool IsSurrogate(char c) => c >= '\uD800' && c <= '\uDFFF';

        public static bool IsHighSurrogate(char c) => c >= '\uD800' && c <= '\uDBFF';

        public static bool IsLowSurrogate(char c) => c >= '\uDC00' && c <= '\uDFFF';

        public static bool IsSurrogatePair(char highSurrogate, char lowSurrogate) =>
            IsHighSurrogate(highSurrogate) && IsLowSurrogate(lowSurrogate);

        public static bool IsAscii(char c) => c <= '\u007F';

        public static bool IsAsciiDigit(char c) => (uint)(c - '0') <= 9;

        public static bool IsAsciiLetter(char c) => (uint)((c | 0x20) - 'a') <= 'z' - 'a';

        public static bool IsAsciiLetterLower(char c) => (uint)(c - 'a') <= 'z' - 'a';

        public static bool IsAsciiLetterUpper(char c) => (uint)(c - 'A') <= 'Z' - 'A';

        public static bool IsAsciiLetterOrDigit(char c) => IsAsciiLetter(c) || IsAsciiDigit(c);

        public static bool IsAsciiHexDigit(char c) => IsAsciiDigit(c) || (uint)((c | 0x20) - 'a') <= 'f' - 'a';

        public static bool IsBetween(char c, char minInclusive, char maxInclusive) =>
            (uint)(c - minInclusive) <= (uint)(maxInclusive - minInclusive);

        public static System.Globalization.UnicodeCategory GetUnicodeCategory(char c) =>
            (System.Globalization.UnicodeCategory)Unicode.Category(c);

        public static char ToUpper(char c) => Unicode.ToUpper(c);

        public static char ToLower(char c) => Unicode.ToLower(c);

        public static char ToUpperInvariant(char c) => Unicode.ToUpper(c);

        public static char ToLowerInvariant(char c) => Unicode.ToLower(c);

        public static string ToString(char c) => Strings.FromChar(c);

        public static string ConvertFromUtf32(int utf32)
        {
            if ((uint)utf32 > 0x10FFFF || (utf32 >= 0xD800 && utf32 <= 0xDFFF))
            {
                throw new System.ArgumentOutOfRangeException();
            }

            if (utf32 < 0x10000)
            {
                return Strings.FromChar((char)utf32);
            }

            var result = StringIntrinsics.Allocate(2);
            StringIntrinsics.Set(result, 0, (char)(0xD800 + ((utf32 - 0x10000) >> 10)));
            StringIntrinsics.Set(result, 1, (char)(0xDC00 + ((utf32 - 0x10000) & 0x3FF)));
            return result;
        }

        public static int ConvertToUtf32(char highSurrogate, char lowSurrogate)
        {
            if (!IsHighSurrogate(highSurrogate) || !IsLowSurrogate(lowSurrogate))
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return 0x10000 + ((highSurrogate - 0xD800) << 10) + (lowSurrogate - 0xDC00);
        }

        public static int ConvertToUtf32(string s, int index)
        {
            char first = At(s, index);
            if (!IsSurrogate(first))
            {
                return first;
            }

            if (IsHighSurrogate(first) && index + 1 < s.Length && IsLowSurrogate(s[index + 1]))
            {
                return ConvertToUtf32(first, s[index + 1]);
            }

            throw new System.ArgumentException();
        }

        private static char At(string s, int index)
        {
            if (s == null)
            {
                throw new System.ArgumentNullException();
            }

            if ((uint)index >= (uint)s.Length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            return s[index];
        }

        public static bool IsDigit(string s, int index) => IsDigit(At(s, index));

        public static bool IsLetter(string s, int index) => IsLetter(At(s, index));

        public static bool IsLetterOrDigit(string s, int index) => IsLetterOrDigit(At(s, index));

        public static bool IsUpper(string s, int index) => IsUpper(At(s, index));

        public static bool IsLower(string s, int index) => IsLower(At(s, index));

        public static bool IsWhiteSpace(string s, int index) => IsWhiteSpace(At(s, index));

        public static bool IsPunctuation(string s, int index) => IsPunctuation(At(s, index));

        public static char Parse(string s)
        {
            if (s == null)
            {
                throw new System.ArgumentNullException();
            }

            if (s.Length != 1)
            {
                throw new System.FormatException();
            }

            return s[0];
        }

        public static bool TryParse(string s, out char result)
        {
            if (s == null || s.Length != 1)
            {
                result = '\0';
                return false;
            }

            result = s[0];
            return true;
        }
    }

    internal static class Boolean
    {
        public static int CompareTo(bool value, bool other) => Intrinsics.Compare(value, other);

        // IComparable's, as .NET's: null is less, another type throws.
        public static int CompareTo(bool value, object obj) =>
            obj == null ? 1 : obj is bool other ? CompareTo(value, other) : throw new System.ArgumentException("Object must be of type Boolean.");

        public static bool InstanceEquals(bool value, bool other) => value == other;

        public static bool InstanceEquals(bool value, object obj) => obj is bool other && value == other;

        public static bool Parse(string value)
        {
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            int parsed = Parsing.Boolean(value);
            return parsed < 0 ? throw new System.FormatException() : parsed == 1;
        }

        public static bool TryParse(string value, out bool result)
        {
            int parsed = Parsing.Boolean(value);
            result = parsed == 1;
            return parsed >= 0;
        }
    }
}

namespace Gameplay.Runtime
{
    // The text the argument exceptions' Message adds, as the CLR's.
    internal static class ExceptionText
    {
        public static string WithParameter(string message, string paramName) =>
            string.IsNullOrEmpty(paramName) ? message : message + " (Parameter '" + paramName + "')";

        public static string WithActualValue(string message, object actualValue) =>
            actualValue == null ? message : message + "\nActual value was " + actualValue.ToString() + ".";
    }

    // Composite formatting (string.Format, StringBuilder.AppendFormat) of a
    // format the compiler did not see: its items' arguments are objects, so
    // a format string applies to boxed numbers; strings, bools and chars
    // ignore one, as the CLR's do. Any other object with a format string
    // throws NotSupportedException, since an enum's box is not told apart
    // here (a constant format is lowered by the compiler instead).
    internal static class Composite
    {
        public static string Format(string format, object[] args)
        {
            if (format == null || args == null)
            {
                throw new System.ArgumentNullException();
            }

            var result = new TextBuilder();
            int position = 0;
            while (position < format.Length)
            {
                char c = format[position++];
                if (c == '}')
                {
                    if (position < format.Length && format[position] == '}')
                    {
                        result.Append('}');
                        position++;
                        continue;
                    }

                    throw new System.FormatException();
                }

                if (c != '{')
                {
                    result.Append(c);
                    continue;
                }

                if (position < format.Length && format[position] == '{')
                {
                    result.Append('{');
                    position++;
                    continue;
                }

                int index = Number(format, ref position);
                while (position < format.Length && format[position] == ' ')
                {
                    position++;
                }

                int alignment = 0;
                if (position < format.Length && format[position] == ',')
                {
                    position++;
                    while (position < format.Length && format[position] == ' ')
                    {
                        position++;
                    }

                    bool left = position < format.Length && format[position] == '-';
                    if (left)
                    {
                        position++;
                    }

                    alignment = Number(format, ref position);
                    if (left)
                    {
                        alignment = -alignment;
                    }

                    while (position < format.Length && format[position] == ' ')
                    {
                        position++;
                    }
                }

                string itemFormat = null;
                if (position < format.Length && format[position] == ':')
                {
                    position++;
                    int start = position;
                    while (position < format.Length && format[position] != '}')
                    {
                        if (format[position] == '{')
                        {
                            throw new System.FormatException();
                        }

                        position++;
                    }

                    if (position > start)
                    {
                        itemFormat = Text.Slice(format, start, position - start);
                    }
                }

                if (position >= format.Length || format[position] != '}' || index >= args.Length)
                {
                    throw new System.FormatException();
                }

                position++;
                string text = Item(args[index], itemFormat);
                result.Append(alignment == 0 ? text : Gameplay.Runtime.Number.Align(text, alignment));
            }

            return result.Text();
        }

        private static int Number(string format, ref int position)
        {
            if (position >= format.Length || (uint)(format[position] - '0') > 9)
            {
                throw new System.FormatException();
            }

            int value = 0;
            while (position < format.Length && (uint)(format[position] - '0') <= 9)
            {
                value = value * 10 + (format[position++] - '0');
                if (value >= 1000000)
                {
                    throw new System.FormatException();
                }
            }

            return value;
        }

        private static string Item(object value, string format)
        {
            if (value == null)
            {
                return "";
            }

            if (format == null || value is string || value is bool || value is char)
            {
                return value.ToString();
            }

            if (value is int i32)
            {
                return Gameplay.Runtime.Number.FormatInteger(i32, false, 32, format);
            }

            if (value is long i64)
            {
                return Gameplay.Runtime.Number.FormatInteger(i64, false, 64, format);
            }

            if (value is double f64)
            {
                return Gameplay.Runtime.Number.FormatDouble(f64, format);
            }

            if (value is float f32)
            {
                return Gameplay.Runtime.Number.FormatSingle(f32, format);
            }

            if (value is uint u32)
            {
                return Gameplay.Runtime.Number.FormatInteger(u32, true, 32, format);
            }

            if (value is ulong u64)
            {
                return Gameplay.Runtime.Number.FormatInteger((long)u64, true, 64, format);
            }

            if (value is short i16)
            {
                return Gameplay.Runtime.Number.FormatInteger(i16, false, 16, format);
            }

            if (value is ushort u16)
            {
                return Gameplay.Runtime.Number.FormatInteger(u16, true, 16, format);
            }

            if (value is sbyte i8)
            {
                return Gameplay.Runtime.Number.FormatInteger(i8, false, 8, format);
            }

            if (value is byte u8)
            {
                return Gameplay.Runtime.Number.FormatInteger(u8, true, 8, format);
            }

            throw new System.NotSupportedException();
        }
    }
}

namespace System.Text
{
    // The BCL's StringBuilder, for the members gameplay code uses; its
    // capacity is its own business, so Capacity is not offered.
    public sealed class StringBuilder
    {
        private char[] chars;
        private int length;

        public StringBuilder()
        {
            chars = new char[16];
        }

        public StringBuilder(int capacity)
        {
            if (capacity < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            chars = new char[capacity < 16 ? 16 : capacity];
        }

        public StringBuilder(string value)
            : this(16)
        {
            Append(value);
        }

        public StringBuilder(string value, int capacity)
            : this(capacity)
        {
            Append(value);
        }

        public int Length
        {
            get => length;
            set
            {
                if (value < 0)
                {
                    throw new ArgumentOutOfRangeException();
                }

                Reserve(value);
                for (int index = length; index < value; index++)
                {
                    chars[index] = '\0';
                }

                length = value;
            }
        }

        // .NET's name, which IL calls it by (get_Chars).
        [System.Runtime.CompilerServices.IndexerName("Chars")]
        public char this[int index]
        {
            get => (uint)index < (uint)length ? chars[index] : throw new IndexOutOfRangeException();
            set
            {
                if ((uint)index >= (uint)length)
                {
                    throw new ArgumentOutOfRangeException();
                }

                chars[index] = value;
            }
        }

        private void Reserve(int needed)
        {
            if (needed <= chars.Length)
            {
                return;
            }

            int size = chars.Length * 2;
            if (size < needed)
            {
                size = needed;
            }

            var larger = new char[size];
            for (int index = 0; index < length; index++)
            {
                larger[index] = chars[index];
            }

            chars = larger;
        }

        public StringBuilder Append(char value)
        {
            Reserve(length + 1);
            chars[length++] = value;
            return this;
        }

        public StringBuilder Append(char value, int repeatCount)
        {
            if (repeatCount < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            Reserve(length + repeatCount);
            for (int index = 0; index < repeatCount; index++)
            {
                chars[length++] = value;
            }

            return this;
        }

        public StringBuilder Append(string value)
        {
            if (value != null)
            {
                Reserve(length + value.Length);
                for (int index = 0; index < value.Length; index++)
                {
                    chars[length++] = value[index];
                }
            }

            return this;
        }

        public StringBuilder Append(string value, int startIndex, int count)
        {
            if (startIndex < 0 || count < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (value == null)
            {
                return startIndex == 0 && count == 0 ? this : throw new ArgumentNullException();
            }

            if (startIndex > value.Length - count)
            {
                throw new ArgumentOutOfRangeException();
            }

            Reserve(length + count);
            for (int index = 0; index < count; index++)
            {
                chars[length++] = value[startIndex + index];
            }

            return this;
        }

        public StringBuilder Append(char[] value)
        {
            if (value != null)
            {
                Reserve(length + value.Length);
                for (int index = 0; index < value.Length; index++)
                {
                    chars[length++] = value[index];
                }
            }

            return this;
        }

        public StringBuilder Append(char[] value, int startIndex, int charCount)
        {
            if (startIndex < 0 || charCount < 0)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (value == null)
            {
                return startIndex == 0 && charCount == 0 ? this : throw new ArgumentNullException();
            }

            if (charCount > value.Length - startIndex)
            {
                throw new ArgumentOutOfRangeException();
            }

            Reserve(length + charCount);
            for (int index = 0; index < charCount; index++)
            {
                chars[length++] = value[startIndex + index];
            }

            return this;
        }

        public StringBuilder Append(StringBuilder value)
        {
            if (value != null)
            {
                int count = value.length;
                Reserve(length + count);
                for (int index = 0; index < count; index++)
                {
                    chars[length++] = value.chars[index];
                }
            }

            return this;
        }

        public StringBuilder Append(bool value) => Append(value.ToString());

        public StringBuilder Append(sbyte value) => Append(value.ToString());

        public StringBuilder Append(byte value) => Append(value.ToString());

        public StringBuilder Append(short value) => Append(value.ToString());

        public StringBuilder Append(ushort value) => Append(value.ToString());

        public StringBuilder Append(int value) => Append(value.ToString());

        public StringBuilder Append(uint value) => Append(value.ToString());

        public StringBuilder Append(long value) => Append(value.ToString());

        public StringBuilder Append(ulong value) => Append(value.ToString());

        public StringBuilder Append(float value) => Append(value.ToString());

        public StringBuilder Append(double value) => Append(value.ToString());

        public StringBuilder Append(object value) => value == null ? this : Append(value.ToString());

        public StringBuilder AppendLine() => Append('\n');

        public StringBuilder AppendLine(string value) => Append(value).Append('\n');

        public StringBuilder AppendFormat(string format, object arg0) =>
            Append(Gameplay.Runtime.Composite.Format(format, new[] { arg0 }));

        public StringBuilder AppendFormat(string format, object arg0, object arg1) =>
            Append(Gameplay.Runtime.Composite.Format(format, new[] { arg0, arg1 }));

        public StringBuilder AppendFormat(string format, object arg0, object arg1, object arg2) =>
            Append(Gameplay.Runtime.Composite.Format(format, new[] { arg0, arg1, arg2 }));

        public StringBuilder AppendFormat(string format, params object[] args) =>
            Append(Gameplay.Runtime.Composite.Format(format, args));

        public StringBuilder AppendJoin(string separator, params string[] values) =>
            Append(string.Join(separator, values));

        public StringBuilder AppendJoin(char separator, params string[] values) =>
            Append(string.Join(separator, values));

        public StringBuilder Insert(int index, string value)
        {
            if ((uint)index > (uint)length)
            {
                throw new ArgumentOutOfRangeException();
            }

            if (value == null || value.Length == 0)
            {
                return this;
            }

            Reserve(length + value.Length);
            for (int position = length - 1; position >= index; position--)
            {
                chars[position + value.Length] = chars[position];
            }

            for (int position = 0; position < value.Length; position++)
            {
                chars[index + position] = value[position];
            }

            length += value.Length;
            return this;
        }

        public StringBuilder Insert(int index, char value) => Insert(index, value.ToString());

        public StringBuilder Insert(int index, int value) => Insert(index, value.ToString());

        public StringBuilder Insert(int index, object value) => value == null ? this : Insert(index, value.ToString());

        public StringBuilder Remove(int startIndex, int length)
        {
            if (length < 0 || startIndex < 0 || length > this.length - startIndex)
            {
                throw new ArgumentOutOfRangeException();
            }

            for (int position = startIndex; position + length < this.length; position++)
            {
                chars[position] = chars[position + length];
            }

            this.length -= length;
            return this;
        }

        public StringBuilder Clear()
        {
            length = 0;
            return this;
        }

        public StringBuilder Replace(char oldChar, char newChar)
        {
            for (int index = 0; index < length; index++)
            {
                if (chars[index] == oldChar)
                {
                    chars[index] = newChar;
                }
            }

            return this;
        }

        public StringBuilder Replace(string oldValue, string newValue)
        {
            string replaced = ToString().Replace(oldValue, newValue);
            length = 0;
            return Append(replaced);
        }

        public override string ToString() => ToString(0, length);

        public string ToString(int startIndex, int length)
        {
            if (startIndex < 0 || length < 0 || startIndex > this.length - length)
            {
                throw new ArgumentOutOfRangeException();
            }

            return new string(chars, startIndex, length);
        }

        public bool Equals(StringBuilder sb)
        {
            if (sb == null || sb.length != length)
            {
                return false;
            }

            for (int index = 0; index < length; index++)
            {
                if (chars[index] != sb.chars[index])
                {
                    return false;
                }
            }

            return true;
        }
    }
}
