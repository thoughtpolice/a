// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.Enum's generic members as .NET implements them, over the names
// and values the compiler gives each enum (see Intrinsics).

namespace Gameplay.Runtime.Shims
{
    internal static class Enum
    {
        public static TEnum Parse<TEnum>(string value) => Parse<TEnum>(value, false);

        public static TEnum Parse<TEnum>(string value, bool ignoreCase)
        {
            if (value == null)
            {
                throw new System.ArgumentNullException();
            }

            int status = Enums.TryParse<TEnum>(value, ignoreCase, out TEnum result);
            if (status == 1)
            {
                throw new System.ArgumentException();
            }

            if (status == 2)
            {
                throw new System.OverflowException();
            }

            return result;
        }

        public static bool TryParse<TEnum>(string value, out TEnum result) => TryParse(value, false, out result);

        public static bool TryParse<TEnum>(string value, bool ignoreCase, out TEnum result)
        {
            if (value == null)
            {
                result = default;
                return false;
            }

            if (Enums.TryParse(value, ignoreCase, out result) != 0)
            {
                result = default;
                return false;
            }

            return true;
        }

        public static string[] GetNames<TEnum>()
        {
            string[] names = Intrinsics.EnumNames<TEnum>();
            return names;
        }

        public static TEnum[] GetValues<TEnum>()
        {
            ulong[] bits = Intrinsics.EnumValues<TEnum>();
            var values = new TEnum[bits.Length];
            for (int index = 0; index < bits.Length; index++)
            {
                values[index] = Intrinsics.EnumFromBits<TEnum>(bits[index]);
            }

            return values;
        }

        public static string GetName<TEnum>(TEnum value)
        {
            ulong bits = Intrinsics.EnumToBits(value);
            ulong[] values = Intrinsics.EnumValues<TEnum>();
            for (int index = 0; index < values.Length; index++)
            {
                if (values[index] == bits)
                {
                    return Intrinsics.EnumNames<TEnum>()[index];
                }
            }

            return null;
        }

        public static bool IsDefined<TEnum>(TEnum value) => GetName(value) != null;
    }
}

namespace Gameplay.Runtime
{
    internal static class Enums
    {
        // Enum.TryParse's work: 0 with the value, 1 for text that names
        // no value, 2 for a number out of the underlying type's range.
        public static int TryParse<TEnum>(string value, bool ignoreCase, out TEnum result)
        {
            result = default;
            int start = 0;
            int end = value.Length;
            while (start < end && Text.IsWhiteSpace(value[start]))
            {
                start++;
            }

            while (end > start && Text.IsWhiteSpace(value[end - 1]))
            {
                end--;
            }

            if (start == end)
            {
                return 1;
            }

            char first = value[start];
            if ((first >= '0' && first <= '9') || first == '-' || first == '+')
            {
                int status = ParseNumber<TEnum>(value, start, end, out ulong number);
                if (status != 1)
                {
                    if (status == 0)
                    {
                        result = Intrinsics.EnumFromBits<TEnum>(number);
                    }

                    return status;
                }
            }

            string[] names = Intrinsics.EnumNames<TEnum>();
            ulong[] values = Intrinsics.EnumValues<TEnum>();
            ulong combined = 0;
            int position = start;
            while (true)
            {
                int comma = position;
                while (comma < end && value[comma] != ',')
                {
                    comma++;
                }

                int nameStart = position;
                int nameEnd = comma;
                while (nameStart < nameEnd && Text.IsWhiteSpace(value[nameStart]))
                {
                    nameStart++;
                }

                while (nameEnd > nameStart && Text.IsWhiteSpace(value[nameEnd - 1]))
                {
                    nameEnd--;
                }

                bool found = false;
                for (int index = 0; index < names.Length; index++)
                {
                    if (Matches(names[index], value, nameStart, nameEnd, ignoreCase))
                    {
                        combined |= values[index];
                        found = true;
                        break;
                    }
                }

                if (!found)
                {
                    return 1;
                }

                if (comma == end)
                {
                    break;
                }

                position = comma + 1;
            }

            result = Intrinsics.EnumFromBits<TEnum>(combined);
            return 0;
        }

        private static bool Matches(string name, string text, int start, int end, bool ignoreCase)
        {
            if (name.Length != end - start)
            {
                return false;
            }

            for (int index = 0; index < name.Length; index++)
            {
                char left = name[index];
                char right = text[start + index];
                if (left != right && !(ignoreCase && Unicode.ToUpper(left) == Unicode.ToUpper(right)))
                {
                    return false;
                }
            }

            return true;
        }

        // The number in text[start..end) as the underlying type's value's
        // pattern: 0, or 1 when it is no number, 2 when out of range.
        private static int ParseNumber<TEnum>(string text, int start, int end, out ulong bits)
        {
            bits = 0;
            int kind = Intrinsics.EnumKind<TEnum>();
            bool signed = (kind & 1) != 0;
            int width = kind >> 1;
            int position = start;
            bool negative = false;
            if (text[position] == '-' || text[position] == '+')
            {
                negative = text[position] == '-';
                position++;
            }

            if (position == end)
            {
                return 1;
            }

            ulong magnitude = 0;
            bool overflow = false;
            for (; position < end; position++)
            {
                char c = text[position];
                if (c < '0' || c > '9')
                {
                    return 1;
                }

                ulong digit = (ulong)(c - '0');
                if (magnitude > (ulong.MaxValue - digit) / 10)
                {
                    overflow = true;
                }
                else
                {
                    magnitude = magnitude * 10 + digit;
                }
            }

            ulong maximum = width == 64 ? (signed ? (ulong)long.MaxValue : ulong.MaxValue)
                : (signed ? (1UL << (width - 1)) - 1 : (1UL << width) - 1);
            if (negative)
            {
                if (!signed)
                {
                    if (magnitude != 0 || overflow)
                    {
                        return 2;
                    }

                    return 0;
                }

                if (overflow || magnitude > maximum + 1)
                {
                    return 2;
                }

                bits = 0 - magnitude;
                return 0;
            }

            if (overflow || magnitude > maximum)
            {
                return 2;
            }

            bits = magnitude;
            return 0;
        }
    }
}
