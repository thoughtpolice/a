// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// What System.Numerics' vectors and matrices (dotnet/runtime's own sources,
// built on Vector128<float>; docs/IMPORTER.md, "SIMD as built") need here
// in place of their reinterpretations of memory. A matrix's Impl, the
// vectors its implementation works on, has the matrix's fields and shares
// its box ([SameLayout]), so a reference to one is a reference to the
// other as Unsafe.As between them makes it in the CLR; its rows are
// properties over those fields. The members that index a matrix's rows
// or a vector's elements through references to their memory are written
// with the rows and elements instead.

using System;
using System.Runtime.CompilerServices;
using System.Runtime.Intrinsics;
using Gameplay.Runtime;

namespace Gameplay.Runtime
{
    // A struct laid out as another, whose fields it has in the same order,
    // and whose box it shares (Frontend.Structs).
    [AttributeUsage(AttributeTargets.Struct, Inherited = false)]
    internal sealed class SameLayoutAttribute(System.Type type) : Attribute
    {
        public System.Type Type { get; } = type;
    }
}

namespace System.Numerics
{
    public partial struct Matrix4x4
    {
        [SameLayout(typeof(Matrix4x4))]
        internal partial struct Impl
        {
            public float M11;
            public float M12;
            public float M13;
            public float M14;
            public float M21;
            public float M22;
            public float M23;
            public float M24;
            public float M31;
            public float M32;
            public float M33;
            public float M34;
            public float M41;
            public float M42;
            public float M43;
            public float M44;

            public Vector128<float> X
            {
                readonly get => Vector128.Create(M11, M12, M13, M14);
                set
                {
                    M11 = value.GetElement(0);
                    M12 = value.GetElement(1);
                    M13 = value.GetElement(2);
                    M14 = value.GetElement(3);
                }
            }

            public Vector128<float> Y
            {
                readonly get => Vector128.Create(M21, M22, M23, M24);
                set
                {
                    M21 = value.GetElement(0);
                    M22 = value.GetElement(1);
                    M23 = value.GetElement(2);
                    M24 = value.GetElement(3);
                }
            }

            public Vector128<float> Z
            {
                readonly get => Vector128.Create(M31, M32, M33, M34);
                set
                {
                    M31 = value.GetElement(0);
                    M32 = value.GetElement(1);
                    M33 = value.GetElement(2);
                    M34 = value.GetElement(3);
                }
            }

            public Vector128<float> W
            {
                readonly get => Vector128.Create(M41, M42, M43, M44);
                set
                {
                    M41 = value.GetElement(0);
                    M42 = value.GetElement(1);
                    M43 = value.GetElement(2);
                    M44 = value.GetElement(3);
                }
            }
        }

        public Vector4 this[int row]
        {
            readonly get
            {
                ref readonly Impl impl = ref AsROImpl();
                switch (row)
                {
                    case 0:
                        return impl.X.AsVector4();
                    case 1:
                        return impl.Y.AsVector4();
                    case 2:
                        return impl.Z.AsVector4();
                    case 3:
                        return impl.W.AsVector4();
                    default:
                        ThrowHelper.ThrowArgumentOutOfRangeException();
                        return default;
                }
            }

            set
            {
                ref Impl impl = ref AsImpl();
                switch (row)
                {
                    case 0:
                        impl.X = value.AsVector128();
                        break;
                    case 1:
                        impl.Y = value.AsVector128();
                        break;
                    case 2:
                        impl.Z = value.AsVector128();
                        break;
                    case 3:
                        impl.W = value.AsVector128();
                        break;
                    default:
                        ThrowHelper.ThrowArgumentOutOfRangeException();
                        break;
                }
            }
        }

        public float this[int row, int column]
        {
            readonly get
            {
                if (((uint)row >= RowCount) || ((uint)column >= ColumnCount))
                {
                    ThrowHelper.ThrowArgumentOutOfRangeException();
                }

                return this[row].AsVector128().GetElement(column);
            }

            set
            {
                if (((uint)row >= RowCount) || ((uint)column >= ColumnCount))
                {
                    ThrowHelper.ThrowArgumentOutOfRangeException();
                }

                this[row] = this[row].AsVector128().WithElement(column, value).AsVector4();
            }
        }

        // dotnet/runtime's, with arrays where it takes pointers to the
        // rows of matTemp, whose rows follow the basis as it changes.
        internal static bool Decompose(in Impl matrix, out Vector3 scale, out Quaternion rotation, out Vector3 translation)
        {
            Impl matTemp = Identity.AsImpl();

            Vector128<float>[] canonicalBasis =
            [
                Vector128.Create(1.0f, 0.0f, 0.0f, 0.0f),
                Vector128.Create(0.0f, 1.0f, 0.0f, 0.0f),
                Vector128.Create(0.0f, 0.0f, 1.0f, 0.0f),
            ];

            translation = matrix.W.AsVector3();

            Vector128<float>[] vectorBasis =
            [
                matrix.X.WithElement(3, 0.0f),
                matrix.Y.WithElement(3, 0.0f),
                matrix.Z.WithElement(3, 0.0f),
            ];

            float[] scales =
            [
                Vector128.Length(vectorBasis[0]),
                Vector128.Length(vectorBasis[1]),
                Vector128.Length(vectorBasis[2]),
            ];

            int a = 0;
            int b = 1;
            int c = 2;

            float x = scales[0];
            float y = scales[1];
            float z = scales[2];

            if (x < y)
            {
                if (y < z)
                {
                    (a, c) = (c, a);
                }
                else if (x < z)
                {
                    (a, b) = (b, a);
                }
                else
                {
                    (a, b) = (b, a);
                    (b, c) = (c, b);
                }
            }
            else if (x < z)
            {
                (b, c) = (c, b);
                (a, c) = (c, a);
            }
            else if (y < z)
            {
                (b, c) = (c, b);
            }

            if (scales[a] < DecomposeEpsilon)
            {
                vectorBasis[a] = canonicalBasis[a];
            }

            vectorBasis[a] = Vector128.Normalize(vectorBasis[a]);

            if (scales[b] < DecomposeEpsilon)
            {
                Vector128<float> fAbs = Vector128.Abs(vectorBasis[a]);

                float fAbsX = fAbs.GetElement(0);
                float fAbsY = fAbs.GetElement(1);
                float fAbsZ = fAbs.GetElement(2);

                int cc;
                if (fAbsX < fAbsY)
                {
                    cc = ((fAbsY < fAbsZ) || (fAbsX < fAbsZ)) ? 0 : 2;
                }
                else
                {
                    cc = ((fAbsX < fAbsZ) || (fAbsY < fAbsZ)) ? 1 : 2;
                }

                vectorBasis[b] = Vector3.Cross(vectorBasis[a], canonicalBasis[cc]);
            }

            vectorBasis[b] = Vector128.Normalize(vectorBasis[b]);

            if (scales[c] < DecomposeEpsilon)
            {
                vectorBasis[c] = Vector3.Cross(vectorBasis[a], vectorBasis[b]);
            }

            vectorBasis[c] = Vector128.Normalize(vectorBasis[c]);

            matTemp.X = vectorBasis[0];
            matTemp.Y = vectorBasis[1];
            matTemp.Z = vectorBasis[2];
            float det = GetDeterminant(in matTemp);

            if (float.IsNegative(det))
            {
                scales[a] = -scales[a];
                vectorBasis[a] = -vectorBasis[a];
                matTemp.X = vectorBasis[0];
                matTemp.Y = vectorBasis[1];
                matTemp.Z = vectorBasis[2];

                det = -det;
            }

            det -= 1.0f;
            det *= det;

            bool result;

            if (DecomposeEpsilon < det)
            {
                rotation = Vector128.Create(0.0f, 0.0f, 0.0f, 1.0f).AsQuaternion();
                result = false;
            }
            else
            {
                rotation = Quaternion.CreateFromRotationMatrix(in matTemp).AsQuaternion();
                result = true;
            }

            scale = new Vector3(scales[0], scales[1], scales[2]);
            return result;
        }

        // [lower[x], lower[y], upper[z], upper[w]], as the CLR's shuffle
        // instructions make it.
        private static Vector128<float> Shuffle2(Vector128<float> lower, Vector128<float> upper, byte xIndex, byte yIndex, byte zIndex, byte wIndex) =>
            Vector128.Create(lower.GetElement(xIndex), lower.GetElement(yIndex), upper.GetElement(zIndex), upper.GetElement(wIndex));
    }

    public partial struct Matrix3x2
    {
        [SameLayout(typeof(Matrix3x2))]
        internal partial struct Impl
        {
            public float M11;
            public float M12;
            public float M21;
            public float M22;
            public float M31;
            public float M32;

            public Vector2 X
            {
                readonly get => new(M11, M12);
                set
                {
                    M11 = value.X;
                    M12 = value.Y;
                }
            }

            public Vector2 Y
            {
                readonly get => new(M21, M22);
                set
                {
                    M21 = value.X;
                    M22 = value.Y;
                }
            }

            public Vector2 Z
            {
                readonly get => new(M31, M32);
                set
                {
                    M31 = value.X;
                    M32 = value.Y;
                }
            }
        }

        public Vector2 this[int row]
        {
            readonly get
            {
                ref readonly Impl impl = ref AsROImpl();
                switch (row)
                {
                    case 0:
                        return impl.X;
                    case 1:
                        return impl.Y;
                    case 2:
                        return impl.Z;
                    default:
                        ThrowHelper.ThrowArgumentOutOfRangeException();
                        return default;
                }
            }

            set
            {
                ref Impl impl = ref AsImpl();
                switch (row)
                {
                    case 0:
                        impl.X = value;
                        break;
                    case 1:
                        impl.Y = value;
                        break;
                    case 2:
                        impl.Z = value;
                        break;
                    default:
                        ThrowHelper.ThrowArgumentOutOfRangeException();
                        break;
                }
            }
        }

        public float this[int row, int column]
        {
            readonly get
            {
                if (((uint)row >= RowCount) || ((uint)column >= ColumnCount))
                {
                    ThrowHelper.ThrowArgumentOutOfRangeException();
                }

                Vector2 selected = this[row];
                return column == 0 ? selected.X : selected.Y;
            }

            set
            {
                if (((uint)row >= RowCount) || ((uint)column >= ColumnCount))
                {
                    ThrowHelper.ThrowArgumentOutOfRangeException();
                }

                Vector2 selected = this[row];
                if (column == 0)
                {
                    selected.X = value;
                }
                else
                {
                    selected.Y = value;
                }

                this[row] = selected;
            }
        }
    }

    public partial struct Vector2
    {
        // In the invariant culture, the only one here.
        public override readonly string ToString() => ToString("G", null);

        public readonly string ToString(string? format) => ToString(format, null);

        // Any provider is the invariant culture's here, whose group
        // separator is ",".
        public readonly string ToString(string? format, IFormatProvider? formatProvider) => "<" + X.ToString(format) + ", " + Y.ToString(format) + ">";

        public static Vector2 Create(ReadOnlySpan<float> values)
        {
            if (values.Length < ElementCount)
            {
                ThrowHelper.ThrowArgumentOutOfRangeException(ExceptionArgument.values);
            }

            return Create(values[0], values[1]);
        }

        public static Vector2 LoadUnsafe(ref readonly float source) =>
            Create(source, Unsafe.Add(ref Unsafe.AsRef(in source), 1));

        public readonly void CopyTo(float[] array)
        {
            if (array.Length < ElementCount)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            array[0] = X;
            array[1] = Y;
        }

        public readonly void CopyTo(float[] array, int index)
        {
            if ((uint)index >= (uint)array.Length)
            {
                ThrowHelper.ThrowStartIndexArgumentOutOfRange_ArgumentOutOfRange_IndexMustBeLess();
            }

            if ((array.Length - index) < ElementCount)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            array[index] = X;
            array[index + 1] = Y;
        }

        public readonly void CopyTo(Span<float> destination)
        {
            if (destination.Length < ElementCount)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            destination[0] = X;
            destination[1] = Y;
        }

        public readonly bool TryCopyTo(Span<float> destination)
        {
            if (destination.Length < ElementCount)
            {
                return false;
            }

            destination[0] = X;
            destination[1] = Y;
            return true;
        }
    }

    public partial struct Vector3
    {
        // In the invariant culture, the only one here.
        public override readonly string ToString() => ToString("G", null);

        public readonly string ToString(string? format) => ToString(format, null);

        // Any provider is the invariant culture's here, whose group
        // separator is ",".
        public readonly string ToString(string? format, IFormatProvider? formatProvider) => "<" + X.ToString(format) + ", " + Y.ToString(format) + ", " + Z.ToString(format) + ">";

        public static Vector3 Create(ReadOnlySpan<float> values)
        {
            if (values.Length < ElementCount)
            {
                ThrowHelper.ThrowArgumentOutOfRangeException(ExceptionArgument.values);
            }

            return Create(values[0], values[1], values[2]);
        }

        public static Vector3 LoadUnsafe(ref readonly float source)
        {
            ref float first = ref Unsafe.AsRef(in source);
            return Create(first, Unsafe.Add(ref first, 1), Unsafe.Add(ref first, 2));
        }

        public readonly void CopyTo(float[] array)
        {
            if (array.Length < ElementCount)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            array[0] = X;
            array[1] = Y;
            array[2] = Z;
        }

        public readonly void CopyTo(float[] array, int index)
        {
            if ((uint)index >= (uint)array.Length)
            {
                ThrowHelper.ThrowStartIndexArgumentOutOfRange_ArgumentOutOfRange_IndexMustBeLess();
            }

            if ((array.Length - index) < ElementCount)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            array[index] = X;
            array[index + 1] = Y;
            array[index + 2] = Z;
        }

        public readonly void CopyTo(Span<float> destination)
        {
            if (destination.Length < ElementCount)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            destination[0] = X;
            destination[1] = Y;
            destination[2] = Z;
        }

        public readonly bool TryCopyTo(Span<float> destination)
        {
            if (destination.Length < ElementCount)
            {
                return false;
            }

            destination[0] = X;
            destination[1] = Y;
            destination[2] = Z;
            return true;
        }
    }

    public partial struct Vector4
    {
        // In the invariant culture, the only one here.
        public override readonly string ToString() => ToString("G", null);

        public readonly string ToString(string? format) => ToString(format, null);

        // Any provider is the invariant culture's here, whose group
        // separator is ",".
        public readonly string ToString(string? format, IFormatProvider? formatProvider) => "<" + X.ToString(format) + ", " + Y.ToString(format) + ", " + Z.ToString(format) + ", " + W.ToString(format) + ">";

        public static Vector4 Create(ReadOnlySpan<float> values)
        {
            if (values.Length < ElementCount)
            {
                ThrowHelper.ThrowArgumentOutOfRangeException(ExceptionArgument.values);
            }

            return Create(values[0], values[1], values[2], values[3]);
        }

        public static Vector4 LoadUnsafe(ref readonly float source)
        {
            ref float first = ref Unsafe.AsRef(in source);
            return Create(first, Unsafe.Add(ref first, 1), Unsafe.Add(ref first, 2), Unsafe.Add(ref first, 3));
        }

        public readonly void CopyTo(float[] array)
        {
            if (array.Length < ElementCount)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            array[0] = X;
            array[1] = Y;
            array[2] = Z;
            array[3] = W;
        }

        public readonly void CopyTo(float[] array, int index)
        {
            if ((uint)index >= (uint)array.Length)
            {
                ThrowHelper.ThrowStartIndexArgumentOutOfRange_ArgumentOutOfRange_IndexMustBeLess();
            }

            if ((array.Length - index) < ElementCount)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            array[index] = X;
            array[index + 1] = Y;
            array[index + 2] = Z;
            array[index + 3] = W;
        }

        public readonly void CopyTo(Span<float> destination)
        {
            if (destination.Length < ElementCount)
            {
                ThrowHelper.ThrowArgumentException_DestinationTooShort();
            }

            destination[0] = X;
            destination[1] = Y;
            destination[2] = Z;
            destination[3] = W;
        }

        public readonly bool TryCopyTo(Span<float> destination)
        {
            if (destination.Length < ElementCount)
            {
                return false;
            }

            destination[0] = X;
            destination[1] = Y;
            destination[2] = Z;
            destination[3] = W;
            return true;
        }
    }

    public static partial class Vector
    {
        public static void StoreUnsafe(this Vector2 source, ref float destination)
        {
            destination = source.X;
            Unsafe.Add(ref destination, 1) = source.Y;
        }

        public static void StoreUnsafe(this Vector3 source, ref float destination)
        {
            destination = source.X;
            Unsafe.Add(ref destination, 1) = source.Y;
            Unsafe.Add(ref destination, 2) = source.Z;
        }

        public static void StoreUnsafe(this Vector4 source, ref float destination)
        {
            destination = source.X;
            Unsafe.Add(ref destination, 1) = source.Y;
            Unsafe.Add(ref destination, 2) = source.Z;
            Unsafe.Add(ref destination, 3) = source.W;
        }
    }
}
