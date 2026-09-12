// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What strings do, compiled with every program that uses strings. A string
// is an array of UTF-16 code units; the compiler lowers literals, Length and
// the indexer itself and calls these for the rest. Integers and bools format
// as the CLR's ToString does with the invariant culture.

namespace Gameplay.Runtime
{
    internal static class StringIntrinsics
    {
        // A string of `length` code units, each 0, which only the runtime
        // writes before handing it out.
        public static extern string Allocate(int length);

        public static extern void Set(string text, int index, char value);

        public static extern bool Same(string left, string right);
    }

    internal static class Strings
    {
        public static bool Equal(string left, string right)
        {
            if (StringIntrinsics.Same(left, right))
            {
                return true;
            }

            if (left is null || right is null || left.Length != right.Length)
            {
                return false;
            }

            for (int index = 0; index < left.Length; index++)
            {
                if (left[index] != right[index])
                {
                    return false;
                }
            }

            return true;
        }

        public static bool NotEqual(string left, string right) => !Equal(left, right);

        // FNV-1a over the code units; any hash consistent with Equal does.
        public static int Hash(string text)
        {
            uint hash = 2166136261;
            for (int index = 0; index < text.Length; index++)
            {
                hash = (hash ^ text[index]) * 16777619;
            }

            return (int)hash;
        }

        public static bool IsNullOrEmpty(string text) => text is null || text.Length == 0;

        public static string Concat(string first, string second)
        {
            first = first is null ? "" : first;
            second = second is null ? "" : second;
            var result = StringIntrinsics.Allocate(first.Length + second.Length);
            Copy(result, 0, first);
            Copy(result, first.Length, second);
            return result;
        }

        public static string Concat(string first, string second, string third) =>
            Concat(Concat(first, second), third);

        public static string Concat(string first, string second, string third, string fourth) =>
            Concat(Concat(first, second), Concat(third, fourth));

        private static void Copy(string target, int start, string source)
        {
            for (int index = 0; index < source.Length; index++)
            {
                StringIntrinsics.Set(target, start + index, source[index]);
            }
        }

        public static string FromChar(char value)
        {
            var result = StringIntrinsics.Allocate(1);
            StringIntrinsics.Set(result, 0, value);
            return result;
        }

        public static string FromBool(bool value) => value ? "True" : "False";

        public static string FromUInt64(ulong value)
        {
            int digits = 1;
            for (ulong rest = value / 10; rest != 0; rest /= 10)
            {
                digits++;
            }

            var result = StringIntrinsics.Allocate(digits);
            for (int index = digits - 1; index >= 0; index--)
            {
                StringIntrinsics.Set(result, index, (char)('0' + (int)(value % 10)));
                value /= 10;
            }

            return result;
        }

        public static string FromInt64(long value)
        {
            if (value >= 0)
            {
                return FromUInt64((ulong)value);
            }

            // The magnitude of long.MinValue does not fit a long.
            return Concat("-", FromUInt64((ulong)(-(value + 1)) + 1));
        }

        public static string Substring(string text, int start, int length)
        {
            if (start < 0 || length < 0 || start > text.Length - length)
            {
                throw new System.ArgumentOutOfRangeException();
            }

            var result = StringIntrinsics.Allocate(length);
            for (int index = 0; index < length; index++)
            {
                StringIntrinsics.Set(result, index, text[start + index]);
            }

            return result;
        }

        public static string Substring(string text, int start) =>
            start < 0 || start > text.Length
                ? throw new System.ArgumentOutOfRangeException()
                : Substring(text, start, text.Length - start);

        public static int IndexOf(string text, char value)
        {
            for (int index = 0; index < text.Length; index++)
            {
                if (text[index] == value)
                {
                    return index;
                }
            }

            return -1;
        }

        public static bool Contains(string text, char value) => IndexOf(text, value) >= 0;

        public static int CompareOrdinal(string left, string right)
        {
            if (StringIntrinsics.Same(left, right))
            {
                return 0;
            }

            if (left is null)
            {
                return -1;
            }

            if (right is null)
            {
                return 1;
            }

            // As the CLR: the first two chars decide first, a shorter
            // string's terminator (or an empty one's padding) taking part
            // (so "a" against "ab" is -'b'); past them, the first differing
            // char, then the length difference.
            for (int index = 0; index < 2; index++)
            {
                int difference = CharOrTerminator(left, index) - CharOrTerminator(right, index);
                if (difference != 0)
                {
                    return difference;
                }
            }

            int shorter = left.Length < right.Length ? left.Length : right.Length;
            for (int index = 2; index < shorter; index++)
            {
                int difference = left[index] - right[index];
                if (difference != 0)
                {
                    return difference;
                }
            }

            return left.Length - right.Length;
        }

        private static int CharOrTerminator(string text, int index) => index < text.Length ? text[index] : 0;
    }
}
