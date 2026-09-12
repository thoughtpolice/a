// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// System.Numerics.Complex and Complex<T> (dotnet/runtime's, compiled into
// the gameplay CoreLib, with the CoreLib's own text; docs/IMPORTER.md,
// "System.Runtime.Numerics as built") against the CLR's: arithmetic,
// the elementary functions (a part at a time, within a few ulps), special
// values, comparison, generic math, formatting and parsing.

using System;
using System.Globalization;
using System.Numerics;

namespace Tests.Complexes
{
    public static class Complexes
    {
        private static readonly double[] Parts =
        {
            0.0, 1.0, -1.0, 0.5, -2.25, 3.0, 1e-3, -7.5, 100.0, 1e10, -1e-8, 0.75,
        };

        private static Complex Value(int which) => which switch
        {
            0 => Complex.Zero,
            1 => Complex.One,
            2 => Complex.ImaginaryOne,
            3 => Complex.NaN,
            4 => Complex.Infinity,
            5 => new Complex(double.MaxValue, double.MaxValue),
            6 => new Complex(-0.0, 0.0),
            _ => new Complex(Parts[which % Parts.Length], Parts[(which * 7 + 3) % Parts.Length]),
        };

        private static long Digest(string text)
        {
            long digest = 17;
            foreach (char c in text)
            {
                digest = unchecked(digest * 31 + c);
            }

            return unchecked(digest * 31 + text.Length);
        }

        private static Complex Operation(int op, Complex a, Complex b) => op switch
        {
            0 => a + b,
            1 => a - b,
            2 => a * b,
            3 => a / b,
            4 => -a,
            5 => Complex.Conjugate(a),
            6 => Complex.Reciprocal(a),
            7 => a * 2.5 + 1.5 / b - (0.5 - a),
            8 => Complex.Sqrt(a),
            9 => Complex.Exp(a),
            10 => Complex.Log(a),
            11 => Complex.Log10(a),
            12 => Complex.Log(a, 2.0),
            13 => Complex.Pow(a, b),
            14 => Complex.Pow(a, 3.0),
            15 => Complex.Sin(a),
            16 => Complex.Cos(a),
            17 => Complex.Tan(a),
            18 => Complex.Asin(a),
            19 => Complex.Acos(a),
            20 => Complex.Atan(a),
            21 => Complex.Sinh(a),
            22 => Complex.Cosh(a),
            23 => Complex.Tanh(a),
            24 => Complex.FromPolarCoordinates(a.Real, b.Real),
            25 => new Complex(Complex.Abs(a), a.Phase),
            26 => new Complex(a.Magnitude, Complex.Abs(b)),
            27 => Complex.MaxMagnitude(a, b),
            28 => Complex.MinMagnitude(a, b),
            29 => Complex.Multiply(a, b) - Complex.Divide(a, b) + Complex.Add(a, 1.0) + Complex.Subtract(2.0, b),
            _ => Complex.CreateChecked(a.Real) + (Complex)(float)b.Imaginary + (Complex)7L,
        };

        // A part of a result: the real part (0) or the imaginary (1).
        public static double Operations(int op, int i, int j, int part)
        {
            Complex result = Operation(op, Value(i), Value(j));
            return part == 0 ? result.Real : result.Imaginary;
        }

        public static long Predicates(int i, int j)
        {
            Complex a = Value(i);
            Complex b = Value(j);
            return (a == b ? 1 : 0) + (a.Equals(b) ? 2 : 0) + (a.Equals((object)b) ? 4 : 0)
                   + (Complex.IsNaN(a) ? 8 : 0) + (Complex.IsInfinity(a) ? 16 : 0) + (Complex.IsFinite(a) ? 32 : 0)
                   + (Complex.IsRealNumber(a) ? 64 : 0) + (Complex.IsImaginaryNumber(a) ? 128 : 0) + (a == Complex.Zero ? 256 : 0)
                   + (a.GetHashCode() == b.GetHashCode() && a.Equals(b) ? 512 : 0) + (Complex.IsNegative(a) ? 1024 : 0);
        }

        // X and x, .NET 11's hexadecimal floating point, format each part so.
        private static readonly string[] Formats = { null, "", "F2", "E3", "G", "R", "N1", "0.00", "P", "G17", "X", "x3", "X0" };

        public static long Formatting(int op, int i)
        {
            Complex a = Value(i);
            string format = Formats[op % Formats.Length];
            try
            {
                string text = a.ToString(format, CultureInfo.InvariantCulture);
                Span<char> destination = stackalloc char[200];
                bool fits = a.TryFormat(destination, out int written, format, CultureInfo.InvariantCulture);
                Span<char> small = stackalloc char[7];
                bool smallFits = a.TryFormat(small, out _, format, CultureInfo.InvariantCulture);
                return Digest(text) + (fits ? Digest(destination.Slice(0, written).ToString()) * 3 : -9) + (smallFits ? 7 : 0)
                       + Digest(a.ToString()) * 11 + Digest($"{a:F1}") * 13;
            }
            catch (FormatException)
            {
                return -5;
            }
        }

        private static readonly string[] Texts =
        {
            "<1; 2>", "<1;2>", " <1; 2> ", "<-1.5; 3e2>", "<1; 2", "1; 2>", "<a; 2>", "<1; 2>x", "<NaN; Infinity>",
            "<1,000; 2>", "(1, 2)", "<;>", "<1;  2>", "<  1; 2>",
        };

        public static long Parsing(int op, int i)
        {
            string text = Texts[i % Texts.Length];
            NumberStyles style = op switch
            {
                0 => NumberStyles.Float | NumberStyles.AllowThousands,
                1 => NumberStyles.Float,
                2 => NumberStyles.None,
                3 => NumberStyles.Any,
                _ => NumberStyles.AllowHexSpecifier,
            };
            try
            {
                bool parsed = Complex.TryParse(text, style, CultureInfo.InvariantCulture, out Complex result);
                long digest = parsed ? Digest(result.ToString("R", CultureInfo.InvariantCulture)) : -1;
                try
                {
                    digest = digest * 31 + Digest(Complex.Parse(text.AsSpan(), style, CultureInfo.InvariantCulture).ToString());
                }
                catch (FormatException)
                {
                    digest = digest * 31 - 5;
                }

                return digest;
            }
            catch (ArgumentException)
            {
                return -4;
            }
        }

        private static T Norm<T>(T[] values)
            where T : INumberBase<T>
        {
            T total = T.Zero;
            foreach (T value in values)
            {
                total += value * value - T.One;
            }

            return total;
        }

        // Generic math over Complex, and Complex<T> of floats and doubles.
        public static double Generic(int i, int j, int part)
        {
            Complex sum = Norm(new[] { Value(i), Value(j) });
            var single = new Complex<float>((float)Value(i).Real, (float)Value(j).Imaginary);
            Complex<float> product = single * single + Complex<float>.One;
            var wide = new Complex<double>(Value(j).Real, Value(i).Imaginary);
            Complex<double> quotient = Complex<double>.Sqrt(wide) / (wide + Complex<double>.ImaginaryOne);
            return part switch
            {
                0 => sum.Real,
                1 => sum.Imaginary,
                2 => product.Real,
                3 => product.Imaginary,
                4 => quotient.Real,
                _ => quotient.Imaginary,
            };
        }
    }
}
