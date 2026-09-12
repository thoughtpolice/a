// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Numerics;
using System.Runtime.Intrinsics;

namespace Tests.Vectors;

// System.Numerics' vectors, quaternions, planes and matrices (dotnet/runtime's
// own sources, on Vector128<float>) against the CLR's. The
// operations built on Vector128.MultiplyAddEstimate (transforms, matrix
// products, Lerp, Cross of Vector4) round once where the CLR's hardware
// fuses them and twice here, which .NET allows of an estimate: their
// inputs are multiples of a quarter no larger than 8, whose products and
// sums are exact either way. What takes a sine, a cosine or a tangent
// returns one component, which tests/differential.mjs compares within ulps.
public static class Vectors
{
    private static float Q(int k) => ((k % 61) - 30) * 0.25f;

    private static Vector2 V2(int i) => new(Q(i), Q((i * 7) + 3));

    private static Vector3 V3(int i) => new(Q(i), Q((i * 7) + 3), Q((i * 13) + 5));

    private static Vector4 V4(int i) => new(Q(i), Q((i * 7) + 3), Q((i * 13) + 5), Q((i * 17) + 11));

    private static Quaternion Qu(int i) => new(Q(i + 1), Q((i * 3) + 2), Q((i * 5) + 7), Q((i * 11) + 13));

    private static Matrix4x4 M4(int i) => new(
        Q(i), Q(i + 1), Q(i + 2), Q(i + 3),
        Q((i * 3) + 4), Q((i * 3) + 5), Q((i * 3) + 6), Q((i * 3) + 7),
        Q((i * 5) + 8), Q((i * 5) + 9), Q((i * 5) + 10), Q((i * 5) + 11),
        Q((i * 7) + 12), Q((i * 7) + 13), Q((i * 7) + 14), Q((i * 7) + 15));

    private static Matrix3x2 M3(int i) => new(Q(i), Q(i + 2), Q((i * 3) + 4), Q((i * 3) + 5), Q((i * 5) + 8), Q((i * 5) + 9));

    private static long Bits(float value) => float.IsNaN(value) ? 0x7FC0_0000 : BitConverter.SingleToInt32Bits(value);

    private static long Hash(params ReadOnlySpan<float> values)
    {
        long hash = 17;
        foreach (float value in values)
        {
            hash = (hash * 1_000_003) + Bits(value);
        }

        return hash;
    }

    private static long Hash(Vector2 v) => Hash(v.X, v.Y);

    private static long Hash(Vector3 v) => Hash(v.X, v.Y, v.Z);

    private static long Hash(Vector4 v) => Hash(v.X, v.Y, v.Z, v.W);

    private static long Hash(Quaternion q) => Hash(q.X, q.Y, q.Z, q.W);

    private static long Hash(Plane p) => Hash(p.Normal) + Bits(p.D);

    private static long Hash(Matrix3x2 m) => Hash(m.M11, m.M12, m.M21, m.M22, m.M31, m.M32);

    private static long Hash(Matrix4x4 m) => Hash(
        m.M11, m.M12, m.M13, m.M14, m.M21, m.M22, m.M23, m.M24, m.M31, m.M32, m.M33, m.M34, m.M41, m.M42, m.M43, m.M44);

    // Vector2: op 0 to 39.
    public static long Vector2Ops(int op, int i, int j)
    {
        var a = V2(i);
        var b = V2(j);
        return op switch
        {
            0 => Hash(a + b),
            1 => Hash(a - b),
            2 => Hash(a * b),
            3 => Hash(a / b),
            4 => Hash(a * Q(j)),
            5 => Hash(Q(j) * a),
            6 => Hash(a / 0.5f),
            7 => Hash(-a),
            8 => Hash(Vector2.Abs(a)),
            9 => Hash(Vector2.Min(a, b)),
            10 => Hash(Vector2.Max(a, b)),
            11 => Hash(Vector2.Clamp(a, Vector2.Min(b, V2(i + j)), Vector2.Max(b, V2(i + j)))),
            12 => Bits(Vector2.Distance(a, b)),
            13 => Bits(Vector2.DistanceSquared(a, b)),
            14 => Bits(Vector2.Dot(a, b)),
            15 => Bits(a.Length()),
            16 => Bits(a.LengthSquared()),
            17 => Hash(Vector2.Normalize(a)),
            18 => Hash(Vector2.Lerp(a, b, 0.25f)),
            19 => Hash(Vector2.Reflect(a, b)),
            20 => Hash(Vector2.SquareRoot(Vector2.Abs(a))),
            21 => Hash(Vector2.Transform(a, M3(j))),
            22 => Hash(Vector2.Transform(a, M4(j))),
            23 => Hash(Vector2.TransformNormal(a, M3(j))),
            24 => Hash(Vector2.TransformNormal(a, M4(j))),
            25 => (a == b ? 1 : 0) + (a != b ? 2 : 0) + (a.Equals(b) ? 4 : 0) + (a.Equals((object)V2(i)) ? 8 : 0)
                  + (a.GetHashCode() == V2(i).GetHashCode() ? 16 : 0),
            26 => Bits(a[1]) + Bits(a.GetElement(0)) + Hash(a.WithElement(1, 9.5f)),
            27 => Hash(Vector2.Zero) + Hash(Vector2.One) + Hash(Vector2.UnitX) + Hash(Vector2.UnitY),
            28 => Hash(new Vector2(Q(i))) + Hash(Vector2.Create(Q(i), Q(j))),
            29 => Hash(Vector2.Round(a * 0.3f)) + Hash(Vector2.Truncate(a * 0.3f)),
            30 => Hash(Vector2.MinNumber(a, b)) + Hash(Vector2.MaxMagnitude(a, b)),
            31 => Hash(Vector2.CopySign(a, b)),
            32 => Hash(Vector2.MultiplyAddEstimate(a, b, V2(i + j))),
            33 => Hash(Vector2.FusedMultiplyAdd(a * 0.3f, b * 0.7f, V2(i + j))),
            34 => Bits(Vector2.Cross(a, b)),
            35 => (Vector2.All(a, a.X) ? 1 : 0) + (Vector2.Any(a, b.Y) ? 2 : 0) + (Vector2.Count(a, a.Y) * 4) + (Vector2.IndexOf(a, b.X) * 16),
            36 => Hash(Vector2.Transform(a, Quaternion.Normalize(Qu(j)))),
            37 => Hash(a.AsVector4()) + Hash(a.AsVector3()),
            38 => Hash(Vector2.Negate(Vector2.Subtract(Vector2.Add(a, b), Vector2.Multiply(a, 2f)))),
            39 => Hash(Vector2.Divide(a, b)) + Hash(Vector2.Divide(a, 4f)),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // Vector3: op 0 to 29.
    public static long Vector3Ops(int op, int i, int j)
    {
        var a = V3(i);
        var b = V3(j);
        return op switch
        {
            0 => Hash(a + b),
            1 => Hash(a - b),
            2 => Hash(a * b),
            3 => Hash(a / b),
            4 => Hash(a * Q(j)),
            5 => Hash(-a),
            6 => Hash(Vector3.Abs(a)),
            7 => Hash(Vector3.Min(a, b)),
            8 => Hash(Vector3.Max(a, b)),
            9 => Hash(Vector3.Clamp(a, Vector3.Min(b, V3(i + j)), Vector3.Max(b, V3(i + j)))),
            10 => Bits(Vector3.Distance(a, b)),
            11 => Bits(Vector3.DistanceSquared(a, b)),
            12 => Bits(Vector3.Dot(a, b)),
            13 => Bits(a.Length()),
            14 => Hash(Vector3.Normalize(a)),
            15 => Hash(Vector3.Cross(a, b)),
            16 => Hash(Vector3.Lerp(a, b, 0.75f)),
            17 => Hash(Vector3.Reflect(a, b)),
            18 => Hash(Vector3.Transform(a, M4(j))),
            19 => Hash(Vector3.TransformNormal(a, M4(j))),
            20 => Hash(Vector3.Transform(a, Qu(j))),
            21 => (a == b ? 1 : 0) + (a != b ? 2 : 0) + (a.Equals(b) ? 4 : 0) + (a.Equals((object)V3(i)) ? 8 : 0),
            22 => Bits(a[2]) + Hash(a.WithElement(0, -1f)) + Bits(a.GetElement(1)),
            23 => Hash(Vector3.UnitX + Vector3.UnitY * 2f + Vector3.UnitZ * 3f) + Hash(Vector3.One),
            24 => Hash(new Vector3(V2(i), Q(j))) + Hash(Vector3.Create(Q(i))),
            25 => Hash(Vector3.SquareRoot(Vector3.Abs(a))),
            26 => Hash(Vector3.MultiplyAddEstimate(a, b, V3(i + j))),
            27 => Hash(Vector3.FusedMultiplyAdd(a * 0.3f, b * 0.7f, V3(i + j))),
            28 => Hash(a.AsVector128().AsVector4()),
            29 => (Vector3.EqualsAll(a, b) ? 1 : 0) + (Vector3.LessThanAny(a, b) ? 2 : 0) + Hash(Vector3.MaxNumber(a, b)),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // Vector4: op 0 to 21.
    public static long Vector4Ops(int op, int i, int j)
    {
        var a = V4(i);
        var b = V4(j);
        return op switch
        {
            0 => Hash(a + b),
            1 => Hash(a - b),
            2 => Hash(a * b),
            3 => Hash(a / b),
            4 => Hash(a * Q(j)),
            5 => Hash(-a),
            6 => Hash(Vector4.Min(a, b)),
            7 => Hash(Vector4.Max(a, b)),
            8 => Bits(Vector4.Dot(a, b)),
            9 => Bits(a.Length()),
            10 => Hash(Vector4.Normalize(a)),
            11 => Hash(Vector4.Lerp(a, b, 0.5f)),
            12 => Hash(Vector4.Transform(a, M4(j))),
            13 => Hash(Vector4.Transform(V3(i), M4(j))),
            14 => Hash(Vector4.Transform(V2(i), M4(j))),
            15 => Hash(Vector4.Transform(a, Qu(j))),
            16 => Hash(Vector4.Cross(a, b)),
            17 => (a == b ? 1 : 0) + (a.Equals((object)V4(i)) ? 2 : 0) + (a.GetHashCode() == V4(i).GetHashCode() ? 4 : 0),
            18 => Hash(new Vector4(V3(i), Q(j))) + Hash(new Vector4(V2(i), Q(j), Q(i))) + Hash(Vector4.UnitW),
            19 => Bits(a[3]) + Bits(Vector4.Distance(a, b)),
            20 => Hash(Vector4.Clamp(a, Vector4.Min(b, V4(i + j)), Vector4.Max(b, V4(i + j)))),
            21 => Hash(a.AsQuaternion()) + Hash(a.AsPlane()),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // Quaternions and planes: op 0 to 21.
    public static long Rotations(int op, int i, int j)
    {
        var a = Qu(i);
        var b = Qu(j);
        var plane = new Plane(V3(i), Q(j));
        return op switch
        {
            0 => Hash(a + b),
            1 => Hash(a - b),
            2 => Hash(a * b),
            3 => Hash(a * Q(j)),
            4 => Hash(-a),
            5 => Hash(Quaternion.Conjugate(a)),
            6 => Hash(Quaternion.Concatenate(a, b)),
            7 => Bits(Quaternion.Dot(a, b)),
            8 => Bits(a.Length()) + Bits(a.LengthSquared()),
            9 => Hash(Quaternion.Normalize(a)),
            10 => Hash(Quaternion.Inverse(a)),
            11 => Hash(a / b),
            12 => Hash(Quaternion.Lerp(a, b, 0.25f)) + Hash(Quaternion.Lerp(a, -b, 0.5f)),
            13 => (a == b ? 1 : 0) + (a.Equals((object)Qu(i)) ? 2 : 0) + (Quaternion.Identity.IsIdentity ? 4 : 0) + (a.IsIdentity ? 8 : 0),
            14 => Hash(Quaternion.CreateFromRotationMatrix(Matrix4x4.CreateFromQuaternion(Quaternion.Normalize(a)))),
            15 => Hash(Plane.Normalize(plane)),
            16 => Bits(Plane.Dot(plane, V4(j))) + Bits(Plane.DotCoordinate(plane, V3(j))) + Bits(Plane.DotNormal(plane, V3(j))),
            17 => Hash(Plane.CreateFromVertices(V3(i), V3(j), V3(i + j))),
            18 => Hash(Plane.Transform(plane, Qu(j))),
            19 => Hash(Plane.Transform(plane, Matrix4x4.CreateTranslation(V3(j)))),
            20 => (plane == new Plane(V3(i), Q(j)) ? 1 : 0) + (plane.Equals((object)new Plane(V4(i))) ? 2 : 0) + Hash(new Plane(V4(i))),
            21 => Hash(Quaternion.Zero) + Hash(Quaternion.Identity) + Hash(new Quaternion(V3(i), Q(j))),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
    }

    // Matrix3x2: op 0 to 17.
    public static long Matrix3x2Ops(int op, int i, int j)
    {
        var a = M3(i);
        var b = M3(j);
        switch (op)
        {
            case 0:
                return Hash(a + b);
            case 1:
                return Hash(a - b);
            case 2:
                return Hash(a * b);
            case 3:
                return Hash(a * Q(j));
            case 4:
                return Hash(-a);
            case 5:
                return Bits(a.GetDeterminant());
            case 6:
                return Matrix3x2.Invert(a, out var inverse) ? Hash(inverse) : -Hash(inverse);
            case 7:
                return Hash(Matrix3x2.Lerp(a, b, 0.25f));
            case 8:
                return Hash(Matrix3x2.CreateScale(Q(i), Q(j))) + Hash(Matrix3x2.CreateScale(V2(i), V2(j)));
            case 9:
                return Hash(Matrix3x2.CreateTranslation(V2(i))) + Hash(Matrix3x2.CreateScale(Q(j)));
            case 10:
                return (a == b ? 1 : 0) + (a.Equals((object)M3(i)) ? 2 : 0) + (Matrix3x2.Identity.IsIdentity ? 4 : 0) + (a.IsIdentity ? 8 : 0);
            case 11:
                return Bits(a[1, 0]) + Hash(a[2]) + Hash(a.Translation) + Hash(a.X) + Hash(a.Y) + Hash(a.Z);
            case 12:
                a[1, 1] = 9.5f;
                a[0] = V2(j);
                a.Translation = V2(i + j);
                a.M12 = -3f;
                return Hash(a);
            case 13:
                return Hash(Matrix3x2.Identity) + Hash(Matrix3x2.Create(V2(i), V2(j), V2(i + j)));
            case 14:
                return Bits(a[j % 3, i % 2]);
            case 15:
                a.X = V2(j);
                a.Z = -a.Z;
                return Hash(a);
            case 16:
                return Hash(Matrix3x2.Negate(Matrix3x2.Add(a, Matrix3x2.Multiply(b, 2f))));
            case 17:
                return Hash(Matrix3x2.Subtract(a, b)) + Hash(Matrix3x2.Multiply(a, b));
            default:
                throw new ArgumentOutOfRangeException(nameof(op));
        }
    }

    // A matrix's row or element out of range throws.
    public static float Matrix3x2OutOfRange(int row, int column) => M3(1)[row, column];

    public static float Matrix4x4OutOfRange(int row, int column) => M4(1)[row, column];

    public static float Matrix4x4RowOutOfRange(int row) => M4(1)[row].X;

    // Matrix4x4: op 0 to 25.
    public static long Matrix4x4Ops(int op, int i, int j)
    {
        var a = M4(i);
        var b = M4(j);
        switch (op)
        {
            case 0:
                return Hash(a + b);
            case 1:
                return Hash(a - b);
            case 2:
                return Hash(a * b);
            case 3:
                return Hash(a * Q(j));
            case 4:
                return Hash(-a);
            case 5:
                return Hash(Matrix4x4.Transpose(a));
            case 6:
                return Bits(a.GetDeterminant());
            case 7:
                return Matrix4x4.Invert(a, out var inverse) ? Hash(inverse) : -Hash(inverse);
            case 8:
                return Hash(Matrix4x4.Lerp(a, b, 0.5f));
            case 9:
                return Hash(Matrix4x4.CreateScale(Q(i), Q(j), Q(i + j))) + Hash(Matrix4x4.CreateScale(V3(i), V3(j)));
            case 10:
                return Hash(Matrix4x4.CreateTranslation(V3(i))) + Hash(Matrix4x4.CreateScale(Q(j)));
            case 11:
                return (a == b ? 1 : 0) + (a.Equals((object)M4(i)) ? 2 : 0) + (Matrix4x4.Identity.IsIdentity ? 4 : 0)
                       + (a.IsIdentity ? 8 : 0) + (a.GetHashCode() == M4(i).GetHashCode() ? 16 : 0);
            case 12:
                return Bits(a[3, 2]) + Hash(a[1]) + Hash(a.Translation) + Hash(a.X) + Hash(a.W);
            case 13:
                a[2, 1] = 9.5f;
                a[3] = V4(j);
                a.Translation = V3(i + j);
                a.M11 = -3f;
                a.Y = V4(i);
                return Hash(a);
            case 14:
                return Hash(Matrix4x4.CreateFromQuaternion(Quaternion.Normalize(Qu(i))));
            case 15:
                return Hash(Matrix4x4.Transform(a, Quaternion.Normalize(Qu(j))));
            case 16:
                return Hash(Matrix4x4.CreateReflection(new Plane(Vector3.UnitY, Q(j)))) + Hash(Matrix4x4.CreateReflection(new Plane(-Vector3.UnitX, Q(i))));
            case 17:
                return Hash(Matrix4x4.CreateShadow(V3(i), new Plane(Vector3.UnitZ, Q(i))));
            case 18:
                return Hash(Matrix4x4.CreateOrthographic(Q(i) + 20f, Q(j) + 20f, 0.5f, 100f))
                       + Hash(Matrix4x4.CreateOrthographicOffCenter(-4f, 4f, -2f, 2f, 1f, 9f));
            case 19:
                return Hash(Matrix4x4.CreatePerspective(4f, 2f, 1f, 100f)) + Hash(Matrix4x4.CreatePerspectiveOffCenter(-2f, 2f, -1f, 1f, 1f, 17f));
            case 20:
                return Hash(Matrix4x4.CreateLookAt(V3(i), V3(j), Vector3.UnitY));
            case 21:
                return Hash(Matrix4x4.CreateWorld(V3(i), -Vector3.UnitZ, Vector3.UnitY));
            case 22:
            {
                var matrix = Matrix4x4.CreateScale(2f, 4f, 0.5f) * Matrix4x4.CreateFromQuaternion(Quaternion.Normalize(Qu(i)))
                             * Matrix4x4.CreateTranslation(V3(j));
                bool decomposed = Matrix4x4.Decompose(matrix, out var scale, out var rotation, out var translation);
                return (decomposed ? 1 : 0) + Hash(scale) + Hash(rotation) + Hash(translation);
            }

            case 23:
                return Hash(Matrix4x4.Identity) + Hash(new Matrix4x4(M3(i))) + Hash(Matrix4x4.Create(V4(i), V4(j), V4(i + j), V4(i - j)));
            case 24:
                return Hash(Matrix4x4.Multiply(a, b)) + Hash(Matrix4x4.Negate(Matrix4x4.Subtract(a, b)));
            case 25:
                return Bits(a[j % 4, i % 4]) + Bits(a.M43);
            default:
                throw new ArgumentOutOfRangeException(nameof(op));
        }
    }

    // One component of what takes sines, cosines and tangents (op 0 to 13;
    // within ulps of the CLR's).
    public static float Trigonometry(int op, int component, float angle)
    {
        var axis = Vector3.Normalize(new Vector3(1f, 2f, 3f));
        float[] values = op switch
        {
            0 => Components(Matrix4x4.CreateRotationX(angle)),
            1 => Components(Matrix4x4.CreateRotationY(angle)),
            2 => Components(Matrix4x4.CreateRotationZ(angle)),
            3 => Components(Matrix4x4.CreateRotationZ(angle, new Vector3(1f, 2f, 3f))),
            4 => Components(Matrix4x4.CreateFromAxisAngle(axis, angle)),
            5 => Components(Matrix4x4.CreateFromYawPitchRoll(angle, angle * 0.5f, -angle)),
            6 => Components(Matrix4x4.CreatePerspectiveFieldOfView(angle, 1.5f, 0.5f, 100f)),
            7 => Components(Quaternion.CreateFromAxisAngle(axis, angle)),
            8 => Components(Quaternion.CreateFromYawPitchRoll(angle, 0.25f, angle * 2f)),
            9 => Components(Quaternion.Slerp(Quaternion.Identity, Quaternion.CreateFromAxisAngle(axis, angle), 0.3f)),
            10 => Components(Matrix3x2.CreateRotation(angle)),
            11 => Components(Matrix3x2.CreateSkew(angle * 0.25f, -angle * 0.125f)),
            12 => Components(Vector3.Transform(new Vector3(1f, 2f, 3f), Quaternion.CreateFromAxisAngle(axis, angle))),
            13 => Components(Matrix4x4.CreateBillboard(new Vector3(1f, 2f, 3f), new Vector3(angle, -1f, 5f), Vector3.UnitY, -Vector3.UnitZ)),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
        return values[component % values.Length];
    }

    private static float[] Components(Matrix4x4 m) =>
        [m.M11, m.M12, m.M13, m.M14, m.M21, m.M22, m.M23, m.M24, m.M31, m.M32, m.M33, m.M34, m.M41, m.M42, m.M43, m.M44];

    private static float[] Components(Matrix3x2 m) => [m.M11, m.M12, m.M21, m.M22, m.M31, m.M32];

    private static float[] Components(Quaternion q) => [q.X, q.Y, q.Z, q.W];

    private static float[] Components(Vector3 v) => [v.X, v.Y, v.Z];

    // Text, arrays and copies.
    public static int TextHash(int op, int i)
    {
        string text = op switch
        {
            0 => V2(i).ToString(),
            1 => V3(i).ToString(),
            2 => V4(i).ToString(),
            3 => Qu(i).ToString(),
            4 => new Plane(V4(i)).ToString(),
            5 => M3(i).ToString(),
            6 => M4(i).ToString(),
            7 => V2(i).ToString("F2"),
            _ => throw new ArgumentOutOfRangeException(nameof(op)),
        };
        int hash = text.Length;
        foreach (char c in text)
        {
            hash = (hash * 31) + c;
        }

        return hash;
    }

    public static long Copies(int op, int length)
    {
        var array = new float[length];
        switch (op)
        {
            case 0:
                V2(3).CopyTo(array);
                break;
            case 1:
                V3(3).CopyTo(array, 1);
                break;
            case 2:
                V4(3).CopyTo((Span<float>)array);
                break;
            case 3:
                return V4(5).TryCopyTo(array) ? Hash(array) : -1;
            case 4:
                return Hash(Vector2.Create((ReadOnlySpan<float>)array)) + Hash(Vector4.Create((ReadOnlySpan<float>)array));
        }

        return Hash(array);
    }

    // Vectors as values: arrays, fields, references and boxes.
    private struct Body
    {
        public Vector3 Position;
        public Vector3 Velocity;
        public Quaternion Rotation;

        public void Step(float dt)
        {
            Position += Velocity * dt;
            Velocity.Y -= 9.75f * dt;
        }
    }

    private sealed class Transform
    {
        public Matrix4x4 World = Matrix4x4.Identity;
        public Vector2 Offset;
    }

    private static void Scale(ref Vector3 vector, float amount) => vector *= amount;

    public static long Values(int op, int n)
    {
        switch (op)
        {
            case 0:
            {
                var bodies = new Body[n];
                for (int index = 0; index < n; index++)
                {
                    bodies[index].Position = new Vector3(index, 0f, -index);
                    bodies[index].Velocity = new Vector3(1f, 4f, 0.5f);
                    bodies[index].Rotation = Quaternion.Identity;
                    for (int step = 0; step < 4; step++)
                    {
                        bodies[index].Step(0.25f);
                    }
                }

                long hash = 0;
                foreach (var body in bodies)
                {
                    hash = (hash * 31) + Hash(body.Position) + Hash(body.Velocity) + Hash(body.Rotation);
                }

                return hash;
            }

            case 1:
            {
                var transform = new Transform();
                transform.World.M41 = n;
                transform.World.M22 = 2f;
                transform.Offset.X = 0.5f;
                transform.Offset += Vector2.One;
                Shared = new Vector3(n);
                Scale(ref Shared, 0.5f);
                return Hash(transform.World) + Hash(transform.Offset) + Hash(Shared);
            }

            case 2:
            {
                var vectors = new Vector3[n];
                for (int index = 0; index < n; index++)
                {
                    vectors[index] = V3(index);
                    Scale(ref vectors[index], 2f);
                }

                var sum = Vector3.Zero;
                foreach (var vector in vectors)
                {
                    sum += vector;
                }

                return Hash(sum);
            }

            case 3:
            {
                object boxed = V4(n);
                IEquatable<Vector4> equatable = V4(n);
                return (boxed.Equals(V4(n)) ? 1 : 0) + (equatable.Equals(V4(n)) ? 2 : 0) + (boxed is Vector4 ? 4 : 0)
                       + (boxed.GetHashCode() == V4(n).GetHashCode() ? 8 : 0) + Hash((Vector4)boxed);
            }
        }

        throw new ArgumentOutOfRangeException(nameof(op));
    }

    private static Vector3 Shared;
}
