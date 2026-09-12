// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Array's static members the imported framework assemblies call that are
// C# here (the type stays .NET's; the importer implements the rest).

using Gameplay.Runtime;

namespace System
{
    [Surface]
    public abstract partial class Array
    {
        // The CLR's limit on an array's length.
        public static int MaxLength => 0x7FFFFFC7;

        // dotnet/runtime's (Array.cs), over EqualityComparer<T>.Default.
        public static int LastIndexOf<T>(T[] array, T value, int startIndex)
        {
            if (array == null)
            {
                ThrowHelper.ThrowArgumentNullException(ExceptionArgument.array);
            }

            return LastIndexOf(array, value, startIndex, (array.Length == 0) ? 0 : (startIndex + 1));
        }

        public static int LastIndexOf<T>(T[] array, T value, int startIndex, int count)
        {
            if (array == null)
            {
                ThrowHelper.ThrowArgumentNullException(ExceptionArgument.array);
            }

            if (array.Length == 0)
            {
                if (startIndex != -1 && startIndex != 0)
                {
                    throw new ArgumentOutOfRangeException("startIndex", SR.ArgumentOutOfRange_IndexMustBeLess);
                }

                if (count != 0)
                {
                    ThrowHelper.ThrowCountArgumentOutOfRange_ArgumentOutOfRange_Count();
                }

                return -1;
            }

            if ((uint)startIndex >= (uint)array.Length)
            {
                throw new ArgumentOutOfRangeException("startIndex", SR.ArgumentOutOfRange_IndexMustBeLess);
            }

            if (count < 0 || startIndex - count + 1 < 0)
            {
                ThrowHelper.ThrowCountArgumentOutOfRange_ArgumentOutOfRange_Count();
            }

            var comparer = System.Collections.Generic.EqualityComparer<T>.Default;
            int end = startIndex - count + 1;
            for (int index = startIndex; index >= end; index--)
            {
                if (comparer.Equals(array[index], value))
                {
                    return index;
                }
            }

            return -1;
        }
    }
}

namespace Gameplay.Runtime
{
    // System.Array's members that take any array (Array.Copy, Array.Clear),
    // for one-dimensional arrays of an element type: the importer calls
    // these where IL passes such an array (Frontend.ArrayRedirect), as
    // dotnet/runtime's Array.cs behaves on them.
    internal static class ArrayMethods
    {
        internal static void Clear<T>(T[] array)
        {
            if (array == null)
            {
                System.ThrowHelper.ThrowArgumentNullException(System.ExceptionArgument.array);
            }

            for (int index = 0; index < array.Length; index++)
            {
                array[index] = default!;
            }
        }

        internal static void Clear<T>(T[] array, int index, int length)
        {
            if (array == null)
            {
                System.ThrowHelper.ThrowArgumentNullException(System.ExceptionArgument.array);
            }

            if (index < 0 || length < 0 || (uint)(index + length) > (uint)array.Length)
            {
                System.ThrowHelper.ThrowIndexOutOfRangeException();
            }

            for (int end = index + length; index < end; index++)
            {
                array[index] = default!;
            }
        }

        internal static void Copy<T>(T[] sourceArray, T[] destinationArray, int length) =>
            Copy(sourceArray, 0, destinationArray, 0, length);

        internal static void Copy<T>(T[] sourceArray, int sourceIndex, T[] destinationArray, int destinationIndex, int length)
        {
            System.ArgumentNullException.ThrowIfNull(sourceArray);
            System.ArgumentNullException.ThrowIfNull(destinationArray);
            System.ArgumentOutOfRangeException.ThrowIfNegative(length);
            System.ArgumentOutOfRangeException.ThrowIfLessThan(sourceIndex, 0);
            if ((uint)(sourceIndex + length) > (uint)sourceArray.Length)
            {
                throw new System.ArgumentException(System.SR.Arg_LongerThanSrcArray, nameof(sourceArray));
            }

            System.ArgumentOutOfRangeException.ThrowIfLessThan(destinationIndex, 0);
            if ((uint)(destinationIndex + length) > (uint)destinationArray.Length)
            {
                throw new System.ArgumentException(System.SR.Arg_LongerThanDestArray, nameof(destinationArray));
            }

            // A memmove: overlapping ranges of one array copy as if through
            // a buffer.
            if (sourceArray == destinationArray && sourceIndex < destinationIndex)
            {
                for (int offset = length - 1; offset >= 0; offset--)
                {
                    destinationArray[destinationIndex + offset] = sourceArray[sourceIndex + offset];
                }

                return;
            }

            for (int offset = 0; offset < length; offset++)
            {
                destinationArray[destinationIndex + offset] = sourceArray[sourceIndex + offset];
            }
        }
    }
}

namespace Gameplay.Runtime
{
    // A store into an array of references whose exact element type the
    // value is not (covariant arrays, see Frontend.Arrays).
    internal static class ArrayChecks
    {
        internal static void Mismatch() => throw new System.ArrayTypeMismatchException();
    }
}
