// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The transcendental functions of System.Math and MathF, which Wasm has no
// instructions for. Each reduces its argument exactly, sums the leading
// terms of a series in double-double arithmetic and the small rest in
// double, then rounds once: within about 0.52 ulps, where the CLR's
// (the platform's libm) are within one or two. Every function is
// straight-line code, a few dozen units of fuel. Special values follow
// C99, as .NET's do.

namespace Gameplay.Runtime
{
    // An unevaluated sum Hi + Lo, |Lo| at most half an ulp of Hi.
    internal readonly struct Dd
    {
        public readonly double Hi;
        public readonly double Lo;

        public Dd(double hi, double lo)
        {
            Hi = hi;
            Lo = lo;
        }
    }

    internal static class DoubleDouble
    {
        public static Dd Of(double value) => new Dd(value, 0);

        public static Dd TwoSum(double a, double b)
        {
            double s = a + b;
            double bb = s - a;
            double e = (a - (s - bb)) + (b - bb);
            return new Dd(s, e);
        }

        public static Dd FastTwoSum(double a, double b)
        {
            double s = a + b;
            return new Dd(s, b - (s - a));
        }

        public static Dd TwoProduct(double a, double b)
        {
            double p = a * b;
            double t = 134217729.0 * a;
            double ah = t - (t - a);
            double al = a - ah;
            t = 134217729.0 * b;
            double bh = t - (t - b);
            double bl = b - bh;
            double e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
            return new Dd(p, e);
        }

        // The primitives inline their two-sums and two-products: the budget
        // charges a unit per call.
        public static Dd Add(Dd a, Dd b)
        {
            double s = a.Hi + b.Hi;
            double sb = s - a.Hi;
            double se = (a.Hi - (s - sb)) + (b.Hi - sb);
            double t = a.Lo + b.Lo;
            double tb = t - a.Lo;
            double te = (a.Lo - (t - tb)) + (b.Lo - tb);
            se += t;
            double u = s + se;
            double e = se - (u - s) + te;
            double hi = u + e;
            return new Dd(hi, e - (hi - u));
        }

        public static Dd Add(Dd a, double b)
        {
            double s = a.Hi + b;
            double sb = s - a.Hi;
            double e = (a.Hi - (s - sb)) + (b - sb) + a.Lo;
            double hi = s + e;
            return new Dd(hi, e - (hi - s));
        }

        public static Dd Negate(Dd a) => new Dd(-a.Hi, -a.Lo);

        public static Dd Subtract(Dd a, Dd b) => Add(a, new Dd(-b.Hi, -b.Lo));

        public static Dd Multiply(Dd a, Dd b)
        {
            double p = a.Hi * b.Hi;
            double t = 134217729.0 * a.Hi;
            double ah = t - (t - a.Hi);
            double al = a.Hi - ah;
            t = 134217729.0 * b.Hi;
            double bh = t - (t - b.Hi);
            double bl = b.Hi - bh;
            double e = ((ah * bh - p) + ah * bl + al * bh) + al * bl + (a.Hi * b.Lo + a.Lo * b.Hi);
            double hi = p + e;
            return new Dd(hi, e - (hi - p));
        }

        public static Dd Multiply(Dd a, double b)
        {
            double p = a.Hi * b;
            double t = 134217729.0 * a.Hi;
            double ah = t - (t - a.Hi);
            double al = a.Hi - ah;
            t = 134217729.0 * b;
            double bh = t - (t - b);
            double bl = b - bh;
            double e = ((ah * bh - p) + ah * bl + al * bh) + al * bl + a.Lo * b;
            double hi = p + e;
            return new Dd(hi, e - (hi - p));
        }

        public static Dd Divide(Dd a, Dd b)
        {
            double q1 = a.Hi / b.Hi;
            var r = Subtract(a, Multiply(b, q1));
            double q2 = r.Hi / b.Hi;
            r = Subtract(r, Multiply(b, q2));
            double q3 = r.Hi / b.Hi;
            var q = FastTwoSum(q1, q2);
            return Add(q, q3);
        }

        public static Dd Sqrt(Dd a)
        {
            if (a.Hi <= 0)
            {
                return new Dd(a.Hi == 0 ? 0 : double.NaN, 0);
            }

            double x = System.Math.Sqrt(a.Hi);
            var square = TwoProduct(x, x);
            double correction = ((a.Hi - square.Hi) - square.Lo + a.Lo) / (2 * x);
            return FastTwoSum(x, correction);
        }

        public static Dd Scale(Dd a, double factor) => new Dd(a.Hi * factor, a.Lo * factor);

        // 2^exponent, for exponents a double's normal range holds.
        public static double Power2(int exponent) =>
            System.BitConverter.Int64BitsToDouble((long)(exponent + 1023) << 52);

        // value * 2^exponent, rounding once at the end.
        public static double ScaleB(double value, int exponent)
        {
            while (exponent > 1023)
            {
                value *= Power2(1023);
                exponent -= 1023;
            }

            if (exponent < -1022)
            {
                // Into the subnormals in steps that stay exact until the last.
                value *= Power2(-1022 + 53);
                exponent += 1022 - 53;
                while (exponent < -1022)
                {
                    value *= Power2(-1022);
                    exponent += 1022;
                }
            }

            return value * Power2(exponent);
        }

        public static Dd Ln2() => new Dd(0.6931471805599453, 2.3190468138462996e-17);

        public static Dd Ln10() => new Dd(2.302585092994046, -2.1707562233822494e-16);

        public static Dd Pi() => new Dd(3.141592653589793, 1.2246467991473532e-16);

        public static Dd HalfPi() => new Dd(1.5707963267948966, 6.123233995736766e-17);
    }

    // Math.Round and MathF.Round to fractional digits as .NET 11 has them:
    // the exact value rounded at the digit, then the float nearest that
    // decimal, where scaling by a power of ten would round twice.
    internal static class DecimalRounding
    {
        // value (a float's when single) to digits > 0 in MidpointRounding
        // mode, for a finite value beneath the type's integer boundary.
        public static double Round(double value, int digits, int mode, bool single)
        {
            long bits = System.BitConverter.DoubleToInt64Bits(value);
            bool negative = bits < 0;
            int biased = (int)((bits >> 52) & 0x7FF);
            ulong mantissa = (ulong)(bits & 0xFFFFFFFFFFFFFL);
            if (biased == 0 && mantissa == 0)
            {
                return value;
            }

            int exponent = biased == 0 ? -1074 : biased - 1075;
            if (biased != 0)
            {
                mantissa |= 1UL << 52;
            }

            if (exponent + digits >= 0)
            {
                return value;
            }

            // |value| * 10^digits = scaled / 2^shift, exactly.
            int shift = -exponent;
            double result;
            if (digits <= 3)
            {
                // The common case fits 64 bits.
                ulong power = digits == 1 ? 10UL : digits == 2 ? 100UL : 1000UL;
                ulong product = mantissa * power;
                ulong floor = 0;
                int below = -1;
                bool rest = true;
                if (shift < 64)
                {
                    floor = product >> shift;
                    ulong remainder = product & ((1UL << shift) - 1);
                    ulong halfway = 1UL << (shift - 1);
                    below = remainder < halfway ? -1 : remainder > halfway ? 1 : 0;
                    rest = remainder != 0;
                }

                if (RoundsUp(mode, below, (floor & 1) != 0, rest, negative))
                {
                    floor++;
                }

                if (floor <= (single ? 1UL << 24 : 1UL << 53))
                {
                    result = single ? (float)floor / (float)power : floor / (double)power;
                    return negative ? -result : result;
                }
            }

            var scaled = new Big();
            scaled.Set(mantissa);
            scaled.MultiplyPow10(digits);
            bool half = scaled.Bit(shift - 1);
            bool lower = scaled.AnyBelow(shift - 1);
            int midpoint = half ? (lower ? 1 : 0) : -1;
            scaled.ShiftRight(shift);
            if (RoundsUp(mode, midpoint, scaled.Bit(0), half || lower, negative))
            {
                scaled.Increment();
            }

            result = Nearest(scaled, digits, single);
            return negative ? -result : result;
        }

        // Whether a magnitude rounds up from its floor, given how its
        // fraction compares with a half.
        private static bool RoundsUp(int mode, int midpoint, bool odd, bool remainder, bool negative) => mode switch
        {
            0 => midpoint > 0 || (midpoint == 0 && odd),
            1 => midpoint >= 0,
            2 => false,
            3 => negative && remainder,
            _ => !negative && remainder,
        };

        // The float (single) or double nearest quotient / 10^digits, ties to
        // even.
        public static double Nearest(Big quotient, int digits, bool single) =>
            Nearest(quotient, digits, single ? 24 : 53, single ? -149 : -1074);

        // The same for a binary format of `precision` significant bits whose
        // least subnormal is 2^least (a Half's 11 and -24), as a double.
        public static double Nearest(Big quotient, int digits, int precision, int least)
        {
            if (quotient.IsZero)
            {
                return 0;
            }

            bool single = precision == 24;
            if (precision >= 24 && quotient.TryGetUInt64(out ulong small) && small <= (1UL << precision) && digits <= (single ? 10 : 22))
            {
                // Both exact, so the one division rounds correctly.
                double power10 = 1;
                for (int index = 0; index < digits; index++)
                {
                    power10 *= 10;
                }

                return single ? (float)small / (float)power10 : small / power10;
            }

            var divisor = new Big();
            divisor.Set(1);
            divisor.MultiplyPow10(digits);
            return Nearest(quotient, divisor, precision, least);
        }

        // The float (single) or double nearest numerator / divisor, ties to
        // even; the divisor is changed.
        public static double Nearest(Big quotient, Big divisor, bool single) =>
            Nearest(quotient, divisor, single ? 24 : 53, single ? -149 : -1074);

        public static double Nearest(Big quotient, Big divisor, int precision, int least)
        {
            if (quotient.IsZero)
            {
                return 0;
            }

            // t = floor(quotient * 2^s / divisor), of precision + 2 or + 3
            // bits, by long division.
            int s = precision + 2 - quotient.BitLength + divisor.BitLength;
            var rest = new Big();
            rest.CopyFrom(quotient);
            if (s >= 0)
            {
                rest.ShiftLeft(s);
            }
            else
            {
                divisor.ShiftLeft(-s);
            }

            divisor.ShiftLeft(precision + 2);
            ulong t = 0;
            for (int index = precision + 2; index >= 0; index--)
            {
                t <<= 1;
                if (Big.Compare(rest, divisor) >= 0)
                {
                    rest.Subtract(divisor);
                    t |= 1;
                }

                divisor.ShiftRight(1);
            }

            bool sticky = !rest.IsZero;
            int length = 0;
            for (ulong top = t; top != 0; top >>= 1)
            {
                length++;
            }

            // Drop to the precision, or to the least subnormal's place.
            int drop = length - precision;
            if (drop < least + s)
            {
                drop = least + s;
            }

            if (drop > length)
            {
                return 0;
            }

            ulong kept = t >> drop;
            ulong dropped = t & ((1UL << drop) - 1);
            ulong halfway = 1UL << (drop - 1);
            if (dropped > halfway || (dropped == halfway && (sticky || (kept & 1) != 0)))
            {
                kept++;
            }

            return DoubleDouble.ScaleB(kept, drop - s);
        }
    }

    internal static class Transcendental
    {
        private static bool IsNaN(double value) => value != value;

        // e^r - 1 for |r| at most a half: r + r^2/2 in double-double, the
        // rest of the series (under a twelfth of it) in double.
        private static Dd ExpMinusOneSmall(Dd r)
        {
            double x = r.Hi;
            double tail = x * x * x * (0.16666666666666666 + x * (0.041666666666666664 + x * (0.008333333333333333
                + x * (0.001388888888888889 + x * (0.0001984126984126984 + x * (2.48015873015873e-05
                + x * (2.7557319223985893e-06 + x * (2.755731922398589e-07 + x * (2.505210838544172e-08
                + x * (2.08767569878681e-09 + x * (1.6059043836821613e-10 + x * (1.1470745597729725e-11
                + x * 7.647163731819816e-13))))))))))));
            return DoubleDouble.Add(DoubleDouble.Add(r, DoubleDouble.Scale(DoubleDouble.Multiply(r, r), 0.5)), tail);
        }

        // e^x as double-double times 2^scale, for |x.Hi| at most about 746.
        // The parts come back as a tuple, a pair of values, rather than
        // through an out parameter, whose variable would be a cell
        // allocated on every call.
        private static (Dd Value, int Scale) ExpParts(Dd x)
        {
            double k = System.Math.Round(x.Hi / 0.6931471805599453);
            var r = DoubleDouble.Subtract(x, DoubleDouble.Multiply(DoubleDouble.Ln2(), k));
            return (DoubleDouble.Add(ExpMinusOneSmall(r), 1.0), (int)k);
        }

        public static double Exp(double x)
        {
            if (IsNaN(x))
            {
                return x;
            }

            if (x > 709.782712893384)
            {
                return double.PositiveInfinity;
            }

            if (x < -745.1332191019412)
            {
                return 0;
            }

            if (x == 0)
            {
                return 1;
            }

            var (e, scale) = ExpParts(DoubleDouble.Of(x));
            return RoundScaled(e, scale);
        }

        // (Hi + Lo) * 2^scale rounded once, subnormal results included.
        private static double RoundScaled(Dd value, int scale)
        {
            double hi = value.Hi;
            if (scale >= -1021)
            {
                return DoubleDouble.ScaleB(hi + value.Lo, scale);
            }

            // Scale both parts exactly as far as normal numbers go, then let
            // the last addition round in the subnormals.
            double shiftedHi = DoubleDouble.ScaleB(hi, scale + 60);
            double shiftedLo = DoubleDouble.ScaleB(value.Lo, scale + 60);
            double tiny = DoubleDouble.Power2(-60);
            var sum = DoubleDouble.TwoSum(shiftedHi * tiny, shiftedLo * tiny);
            return sum.Hi;
        }

        // ln x as double-double, for a positive finite x.
        private static Dd LogParts(double x)
        {
            int exponent = 0;
            long bits = System.BitConverter.DoubleToInt64Bits(x);
            if ((bits >> 52) == 0)
            {
                x *= DoubleDouble.Power2(54);
                exponent -= 54;
                bits = System.BitConverter.DoubleToInt64Bits(x);
            }

            exponent += (int)(bits >> 52) - 1023;
            double m = System.BitConverter.Int64BitsToDouble((bits & 0xFFFFFFFFFFFFFL) | (1023L << 52));
            if (m > 1.4142135623730951)
            {
                m *= 0.5;
                exponent++;
            }

            // ln m = 2 atanh s, s = (m - 1) / (m + 1): 2s + 2s^3/3 in
            // double-double, the rest (under a thousandth of it) in double.
            var s = DoubleDouble.Divide(DoubleDouble.Of(m - 1), DoubleDouble.TwoSum(m, 1));
            var square = DoubleDouble.Multiply(s, s);
            double z = square.Hi;
            double tail = s.Hi * z * z * (0.4 + z * (0.2857142857142857 + z * (0.2222222222222222
                + z * (0.18181818181818182 + z * (0.15384615384615385 + z * (0.13333333333333333
                + z * (0.11764705882352941 + z * (0.10526315789473684 + z * (0.09523809523809523
                + z * (0.08695652173913043 + z * (0.08 + z * 0.07407407407407407)))))))))));
            var cube = DoubleDouble.Multiply(DoubleDouble.Multiply(square, s), new Dd(0.6666666666666666, 3.700743415417188e-17));
            var result = DoubleDouble.Add(DoubleDouble.Add(DoubleDouble.Scale(s, 2), cube), tail);
            return DoubleDouble.Add(DoubleDouble.Multiply(DoubleDouble.Ln2(), exponent), result);
        }

        public static double Log(double x)
        {
            if (IsNaN(x) || x < 0)
            {
                return double.NaN;
            }

            if (x == 0)
            {
                return double.NegativeInfinity;
            }

            if (x == double.PositiveInfinity)
            {
                return x;
            }

            if (x == 1)
            {
                return 0;
            }

            var l = LogParts(x);
            return l.Hi + l.Lo;
        }

        public static double Log10(double x)
        {
            if (IsNaN(x) || x < 0)
            {
                return double.NaN;
            }

            if (x == 0)
            {
                return double.NegativeInfinity;
            }

            if (x == double.PositiveInfinity)
            {
                return x;
            }

            var l = DoubleDouble.Divide(LogParts(x), DoubleDouble.Ln10());
            return l.Hi + l.Lo;
        }

        public static double Log2(double x)
        {
            if (IsNaN(x) || x < 0)
            {
                return double.NaN;
            }

            if (x == 0)
            {
                return double.NegativeInfinity;
            }

            if (x == double.PositiveInfinity)
            {
                return x;
            }

            var l = DoubleDouble.Divide(LogParts(x), DoubleDouble.Ln2());
            return l.Hi + l.Lo;
        }

        public static double LogBase(double x, double newBase)
        {
            if (IsNaN(x))
            {
                return x;
            }

            if (IsNaN(newBase))
            {
                return newBase;
            }

            if (newBase == 1)
            {
                return double.NaN;
            }

            if (x != 1 && (newBase == 0 || newBase == double.PositiveInfinity))
            {
                return double.NaN;
            }

            return Log(x) / Log(newBase);
        }

        private static bool IsInteger(double y) => System.Math.Floor(y) == y;

        private static bool IsOddInteger(double y) =>
            IsInteger(y) && (y < 0 ? -y : y) < 9007199254740992.0 && ((long)y & 1) != 0;

        public static double Pow(double x, double y)
        {
            if (y == 0 || x == 1)
            {
                return 1;
            }

            if (IsNaN(x) || IsNaN(y))
            {
                return double.NaN;
            }

            double ax = x < 0 ? -x : x;
            if (y == double.PositiveInfinity || y == double.NegativeInfinity)
            {
                if (ax == 1)
                {
                    return 1;
                }

                return (ax < 1) == (y > 0) ? 0 : double.PositiveInfinity;
            }

            if (x == 0)
            {
                bool negativeZero = System.BitConverter.DoubleToInt64Bits(x) < 0;
                if (y < 0)
                {
                    return negativeZero && IsOddInteger(y) ? double.NegativeInfinity : double.PositiveInfinity;
                }

                return negativeZero && IsOddInteger(y) ? -0.0 : 0.0;
            }

            if (x == double.PositiveInfinity)
            {
                return y < 0 ? 0 : double.PositiveInfinity;
            }

            if (x == double.NegativeInfinity)
            {
                if (IsOddInteger(y))
                {
                    return y < 0 ? -0.0 : double.NegativeInfinity;
                }

                return y < 0 ? 0 : double.PositiveInfinity;
            }

            bool negate = false;
            if (x < 0)
            {
                if (!IsInteger(y))
                {
                    return double.NaN;
                }

                negate = IsOddInteger(y);
            }

            var l = LogParts(ax);
            double estimate = l.Hi * y;
            double result;
            if (estimate > 709.782712893384 + 1)
            {
                result = double.PositiveInfinity;
            }
            else if (estimate < -745.1332191019412 - 1)
            {
                result = 0;
            }
            else
            {
                var (e, scale) = ExpParts(DoubleDouble.Multiply(l, y));
                result = RoundScaled(e, scale);
            }

            return negate ? -result : result;
        }

        public static double Cbrt(double x)
        {
            if (IsNaN(x) || x == 0 || x == double.PositiveInfinity || x == double.NegativeInfinity)
            {
                return x;
            }

            double ax = x < 0 ? -x : x;
            int rescale = 0;
            if (ax > 1e200)
            {
                ax *= DoubleDouble.Power2(-600);
                rescale = 200;
            }
            else if (ax < 1e-200)
            {
                ax *= DoubleDouble.Power2(600);
                rescale = -200;
            }

            var l = DoubleDouble.Scale(LogParts(ax), 1.0 / 3);
            // A third isn't exact: refine the exp's result by Newton in
            // double-double against the cube.
            var (e, scale) = ExpParts(l);
            var root = DoubleDouble.Of(DoubleDouble.ScaleB(e.Hi + e.Lo, scale));
            for (int i = 0; i < 2; i++)
            {
                var cube = DoubleDouble.Multiply(DoubleDouble.Multiply(root, root), root);
                var difference = DoubleDouble.Subtract(DoubleDouble.Of(ax), cube);
                var derivative = DoubleDouble.Scale(DoubleDouble.Multiply(root, root), 3);
                root = DoubleDouble.Add(root, DoubleDouble.Divide(difference, derivative));
            }

            double result = (root.Hi + root.Lo) * DoubleDouble.Power2(rescale);
            return x < 0 ? -result : result;
        }

        // x = n * pi/2 + r, |r| at most about pi/4: r in double-double and
        // n mod 4 (a tuple, as ExpParts's is).
        private static (Dd Value, int Quadrant) Reduce(double x)
        {
            double ax = x < 0 ? -x : x;
            if (ax <= 0.7853981633974483)
            {
                return (DoubleDouble.Of(x), 0);
            }

            if (ax < 1647099.3291652855)
            {
                double n = System.Math.Round(x * 0.6366197723675814);
                var r = DoubleDouble.Add(DoubleDouble.TwoProduct(-n, 1.5707963267948966), x);
                r = DoubleDouble.Add(r, DoubleDouble.TwoProduct(-n, 6.123233995736766e-17));
                r = DoubleDouble.Add(r, -n * -1.4973849048591698e-33);
                return (r, (int)((long)n & 3));
            }

            return ReduceLarge(x);
        }

        private static uint TwoOverPi(int index) => index switch
        {
            0 => 0xA2F9836Eu,
            1 => 0x4E441529u,
            2 => 0xFC2757D1u,
            3 => 0xF534DDC0u,
            4 => 0xDB629599u,
            5 => 0x3C439041u,
            6 => 0xFE5163ABu,
            7 => 0xDEBBC561u,
            8 => 0xB7246E3Au,
            9 => 0x424DD2E0u,
            10 => 0x06492EEAu,
            11 => 0x09D1921Cu,
            12 => 0xFE1DEB1Cu,
            13 => 0xB129A73Eu,
            14 => 0xE88235F5u,
            15 => 0x2EBB4484u,
            16 => 0xE99C7026u,
            17 => 0xB45F7E41u,
            18 => 0x3991D639u,
            19 => 0x835339F4u,
            20 => 0x9C845F8Bu,
            21 => 0xBDF9283Bu,
            22 => 0x1FF897FFu,
            23 => 0xDE05980Fu,
            24 => 0xEF2F118Bu,
            25 => 0x5A0A6D1Fu,
            26 => 0x6D367ECFu,
            27 => 0x27CB09B7u,
            28 => 0x4F463F66u,
            29 => 0x9E5FEA2Du,
            30 => 0x7527BAC7u,
            31 => 0xEBE5F17Bu,
            32 => 0x3D0739F7u,
            33 => 0x8A5292EAu,
            34 => 0x6BFB5FB1u,
            35 => 0x1F8D5D08u,
            36 => 0x56033046u,
            37 => 0xFC7B6BABu,
            38 => 0xF0CFBC20u,
            _ => 0x9AF4361Du,
        };

        // Payne-Hanek: the bits of 2/pi that matter, times the mantissa.
        private static (Dd Value, int Quadrant) ReduceLarge(double x)
        {
            long bits = System.BitConverter.DoubleToInt64Bits(x);
            ulong mantissa = (ulong)(bits & 0xFFFFFFFFFFFFFL) | (1UL << 52);
            int exponent = (int)((bits >> 52) & 0x7FF) - 1075;
            // x * 2/pi = mantissa * 2^exponent * sum(chunk[i] * 2^(-32(i+1))).
            // Chunks whose terms are multiples of 4 are left out.
            int first = 0;
            while (exponent - 32 * (first + 1) >= 2)
            {
                first++;
            }

            // mantissa * (6 chunks), exactly, in 32-bit limbs, least first.
            var product = new uint[9];
            ulong low = mantissa & 0xFFFFFFFFUL;
            ulong high = mantissa >> 32;
            for (int i = 0; i < 6; i++)
            {
                ulong chunk = TwoOverPi(first + 5 - i);
                ulong carry = 0;
                ulong p0 = chunk * low + product[i] + carry;
                product[i] = (uint)p0;
                carry = p0 >> 32;
                ulong p1 = chunk * high + product[i + 1] + carry;
                product[i + 1] = (uint)p1;
                carry = p1 >> 32;
                int k = i + 2;
                while (carry != 0 && k < 9)
                {
                    ulong sum = (ulong)product[k] + carry;
                    product[k] = (uint)sum;
                    carry = sum >> 32;
                    k++;
                }
            }

            // The product times 2^(exponent - 32 (first + 6)): the binary
            // point sits `shift` bits up from the least limb.
            int shift = 32 * (first + 6) - exponent;
            int quadrant = (int)(((product[shift / 32] >> (shift % 32)) & 1)
                             | (((product[(shift + 1) / 32] >> ((shift + 1) % 32)) & 1) << 1));
            // The fraction's top 120 bits, as a double-double.
            var f = DoubleDouble.Of(0);
            double weight = 1;
            for (int b = shift - 1; b >= shift - 120 && b >= 0; b -= 24)
            {
                int take = b >= 23 ? 24 : b + 1;
                ulong piece = 0;
                for (int j = 0; j < take; j++)
                {
                    int bit = b - j;
                    piece = (piece << 1) | ((product[bit / 32] >> (bit % 32)) & 1);
                }

                weight *= 1.0 / (1 << take);
                f = DoubleDouble.Add(f, piece * weight);
            }

            if (f.Hi > 0.5)
            {
                f = DoubleDouble.Add(f, -1.0);
                quadrant = (quadrant + 1) & 3;
            }

            var r = DoubleDouble.Multiply(f, DoubleDouble.HalfPi());
            if (x < 0)
            {
                r = DoubleDouble.Negate(r);
                quadrant = (4 - quadrant) & 3;
            }

            return (r, quadrant);
        }

        // sin r for |r| at most about pi/4: r - r^3/6 in double-double, the
        // rest (under a hundredth of it) in double.
        private static Dd SinSmall(Dd r)
        {
            var square = DoubleDouble.Multiply(r, r);
            double z = square.Hi;
            double tail = r.Hi * z * z * (0.008333333333333333 + z * (-0.0001984126984126984
                + z * (2.7557319223985893e-06 + z * (-2.505210838544172e-08 + z * (1.6059043836821613e-10
                + z * (-7.647163731819816e-13 + z * (2.8114572543455206e-15 + z * -8.22063524662433e-18)))))));
            var cube = DoubleDouble.Multiply(DoubleDouble.Multiply(square, r), new Dd(0.16666666666666666, 9.25185853854297e-18));
            return DoubleDouble.Add(DoubleDouble.Subtract(r, cube), tail);
        }

        // cos r for |r| at most about pi/4: 1 - r^2/2 in double-double, the
        // rest (under a fortieth of it) in double.
        private static Dd CosSmall(Dd r)
        {
            var square = DoubleDouble.Multiply(r, r);
            double z = square.Hi;
            double tail = z * z * (0.041666666666666664 + z * (-0.001388888888888889 + z * (2.48015873015873e-05
                + z * (-2.755731922398589e-07 + z * (2.08767569878681e-09 + z * (-1.1470745597729725e-11
                + z * (4.779477332387385e-14 + z * (-1.5619206968586225e-16 + z * 4.110317623312165e-19))))))));
            return DoubleDouble.Add(DoubleDouble.Add(DoubleDouble.Scale(square, -0.5), 1.0), tail);
        }

        public static double Sin(double x)
        {
            if (IsNaN(x) || x == double.PositiveInfinity || x == double.NegativeInfinity)
            {
                return double.NaN;
            }

            if (x == 0)
            {
                return x;
            }

            var (r, quadrant) = Reduce(x);
            var value = (quadrant & 1) == 0 ? SinSmall(r) : CosSmall(r);
            double result = value.Hi + value.Lo;
            return quadrant >= 2 ? -result : result;
        }

        public static double Cos(double x)
        {
            if (IsNaN(x) || x == double.PositiveInfinity || x == double.NegativeInfinity)
            {
                return double.NaN;
            }

            var (r, quadrant) = Reduce(x);
            var value = (quadrant & 1) == 0 ? CosSmall(r) : SinSmall(r);
            double result = value.Hi + value.Lo;
            return quadrant == 1 || quadrant == 2 ? -result : result;
        }

        public static double Tan(double x)
        {
            if (IsNaN(x) || x == double.PositiveInfinity || x == double.NegativeInfinity)
            {
                return double.NaN;
            }

            if (x == 0)
            {
                return x;
            }

            var (r, quadrant) = Reduce(x);
            var sin = SinSmall(r);
            var cos = CosSmall(r);
            var value = (quadrant & 1) == 0 ? DoubleDouble.Divide(sin, cos) : DoubleDouble.Negate(DoubleDouble.Divide(cos, sin));
            return value.Hi + value.Lo;
        }

        // atan of a non-negative double-double at most 1: atan c for the
        // nearest quarter c, plus atan t for t = (a - c) / (1 + ac), at
        // most an eighth, whose series is t - t^3/3 in double-double and
        // the rest (under a three-hundredth of it) in double.
        private static Dd AtanSmall(Dd a)
        {
            double c = System.Math.Round(a.Hi * 4) / 4;
            var t = c == 0
                ? a
                : DoubleDouble.Divide(DoubleDouble.Add(a, -c), DoubleDouble.Add(DoubleDouble.Multiply(a, c), 1.0));
            var square = DoubleDouble.Multiply(t, t);
            double z = square.Hi;
            double tail = t.Hi * z * z * (0.2 + z * (-0.14285714285714285 + z * (0.1111111111111111
                + z * (-0.09090909090909091 + z * (0.07692307692307693 + z * (-0.06666666666666667
                + z * (0.058823529411764705 + z * -0.05263157894736842)))))));
            var cube = DoubleDouble.Multiply(DoubleDouble.Multiply(square, t), new Dd(0.3333333333333333, 1.850371707708594e-17));
            var value = DoubleDouble.Add(DoubleDouble.Subtract(t, cube), tail);
            var atanC = c == 0.25 ? new Dd(0.24497866312686414, 1.0698755618734451e-17)
                : c == 0.5 ? new Dd(0.4636476090008061, 2.2698777452961687e-17)
                : c == 0.75 ? new Dd(0.6435011087932844, 1.5834785051444286e-17)
                : new Dd(0.7853981633974483, 3.061616997868383e-17);
            return c == 0 ? value : DoubleDouble.Add(value, atanC);
        }

        // atan of a non-negative double-double.
        private static Dd AtanParts(Dd a)
        {
            if (a.Hi > 1)
            {
                return DoubleDouble.Subtract(DoubleDouble.HalfPi(), AtanSmall(DoubleDouble.Divide(DoubleDouble.Of(1), a)));
            }

            return AtanSmall(a);
        }

        public static double Atan(double x)
        {
            if (IsNaN(x) || x == 0)
            {
                return x;
            }

            if (x == double.PositiveInfinity || x == double.NegativeInfinity)
            {
                return x > 0 ? 1.5707963267948966 : -1.5707963267948966;
            }

            double ax = x < 0 ? -x : x;
            if (ax < 7.450580596923828e-9)
            {
                // atan x = x - x^3/3 + ..., x within half an ulp.
                return x;
            }

            if (ax > 1.152921504606847e18)
            {
                // pi/2 - 1/x, 1/x beneath the rounding of pi/2.
                return x > 0 ? 1.5707963267948966 : -1.5707963267948966;
            }

            var value = AtanParts(DoubleDouble.Of(ax));
            double result = value.Hi + value.Lo;
            return x < 0 ? -result : result;
        }

        public static double Atan2(double y, double x)
        {
            if (IsNaN(x) || IsNaN(y))
            {
                return double.NaN;
            }

            bool yNegative = System.BitConverter.DoubleToInt64Bits(y) < 0;
            bool xNegative = System.BitConverter.DoubleToInt64Bits(x) < 0;
            double pi = 3.141592653589793;
            if (y == 0)
            {
                if (!xNegative)
                {
                    return y;
                }

                return yNegative ? -pi : pi;
            }

            if (x == 0)
            {
                return yNegative ? -1.5707963267948966 : 1.5707963267948966;
            }

            bool xInfinite = x == double.PositiveInfinity || x == double.NegativeInfinity;
            bool yInfinite = y == double.PositiveInfinity || y == double.NegativeInfinity;
            if (xInfinite)
            {
                double angle = yInfinite ? (xNegative ? 2.356194490192345 : 0.7853981633974483) : (xNegative ? pi : 0.0);
                return yNegative ? -angle : angle;
            }

            if (yInfinite)
            {
                return yNegative ? -1.5707963267948966 : 1.5707963267948966;
            }

            double ay = yNegative ? -y : y;
            double ax = xNegative ? -x : x;
            if (ay > 1e270 || ax > 1e270)
            {
                ay *= DoubleDouble.Power2(-600);
                ax *= DoubleDouble.Power2(-600);
            }
            else if (ay < 1e-270 && ax < 1e-270)
            {
                ay *= DoubleDouble.Power2(600);
                ax *= DoubleDouble.Power2(600);
            }

            Dd value;
            if (ay < ax * 7.450580596923828e-9)
            {
                value = DoubleDouble.Of(ay / ax);
            }
            else if (ax < ay * 7.450580596923828e-9)
            {
                value = DoubleDouble.Subtract(DoubleDouble.HalfPi(), DoubleDouble.Of(ax / ay));
            }
            else if (ay > ax)
            {
                // Better conditioned from the other side.
                value = DoubleDouble.Subtract(DoubleDouble.HalfPi(), AtanSmall(DoubleDouble.Divide(DoubleDouble.Of(ax), DoubleDouble.Of(ay))));
            }
            else
            {
                value = AtanSmall(DoubleDouble.Divide(DoubleDouble.Of(ay), DoubleDouble.Of(ax)));
            }

            if (xNegative)
            {
                value = DoubleDouble.Subtract(DoubleDouble.Pi(), value);
            }

            double result = value.Hi + value.Lo;
            return yNegative ? -result : result;
        }

        public static double Asin(double x)
        {
            if (IsNaN(x) || x > 1 || x < -1)
            {
                return double.NaN;
            }

            if (x == 0)
            {
                return x;
            }

            double ax = x < 0 ? -x : x;
            if (ax < 7.450580596923828e-9)
            {
                // asin x = x + x^3/6 + ..., x within half an ulp.
                return x;
            }

            var rest = DoubleDouble.Sqrt(DoubleDouble.Multiply(DoubleDouble.TwoSum(1, -ax), DoubleDouble.TwoSum(1, ax)));
            Dd value;
            if (rest.Hi == 0)
            {
                value = DoubleDouble.HalfPi();
            }
            else if (ax > rest.Hi)
            {
                value = DoubleDouble.Subtract(DoubleDouble.HalfPi(), AtanSmall(DoubleDouble.Divide(rest, DoubleDouble.Of(ax))));
            }
            else
            {
                value = AtanSmall(DoubleDouble.Divide(DoubleDouble.Of(ax), rest));
            }

            double result = value.Hi + value.Lo;
            return x < 0 ? -result : result;
        }

        public static double Acos(double x)
        {
            if (IsNaN(x) || x > 1 || x < -1)
            {
                return double.NaN;
            }

            if (x == 1)
            {
                return 0;
            }

            if (x == -1)
            {
                return 3.141592653589793;
            }

            // acos x = 2 atan(sqrt((1 - x) / (1 + x))).
            var ratio = DoubleDouble.Divide(DoubleDouble.TwoSum(1, -x), DoubleDouble.TwoSum(1, x));
            var root = DoubleDouble.Sqrt(ratio);
            Dd value = root.Hi == double.PositiveInfinity
                ? DoubleDouble.Pi()
                : DoubleDouble.Scale(AtanParts(root), 2);
            return value.Hi + value.Lo;
        }

        public static double Sinh(double x)
        {
            if (IsNaN(x) || x == 0 || x == double.PositiveInfinity || x == double.NegativeInfinity)
            {
                return x;
            }

            double ax = x < 0 ? -x : x;
            double result;
            if (ax < 0.5)
            {
                // (e^x - e^-x) / 2 without the cancellation.
                var m = ExpMinusOneSmall(DoubleDouble.Of(ax));
                var value = DoubleDouble.Scale(DoubleDouble.Add(m, DoubleDouble.Divide(m, DoubleDouble.Add(m, 1.0))), 0.5);
                result = value.Hi + value.Lo;
            }
            else if (ax > 710.4758600739439)
            {
                result = double.PositiveInfinity;
            }
            else
            {
                var (e, scale) = ExpParts(DoubleDouble.Of(ax));
                var inverse = DoubleDouble.Scale(DoubleDouble.Divide(DoubleDouble.Of(1), e), DoubleDouble.ScaleB(1, -2 * scale));
                var value = DoubleDouble.Scale(DoubleDouble.Subtract(e, inverse), 0.5);
                result = RoundScaled(value, scale);
            }

            return x < 0 ? -result : result;
        }

        public static double Cosh(double x)
        {
            if (IsNaN(x))
            {
                return x;
            }

            double ax = x < 0 ? -x : x;
            if (ax > 710.4758600739439)
            {
                return double.PositiveInfinity;
            }

            var (e, scale) = ExpParts(DoubleDouble.Of(ax));
            var inverse = DoubleDouble.Scale(DoubleDouble.Divide(DoubleDouble.Of(1), e), DoubleDouble.ScaleB(1, -2 * scale));
            var value = DoubleDouble.Scale(DoubleDouble.Add(e, inverse), 0.5);
            return RoundScaled(value, scale);
        }

        public static double Tanh(double x)
        {
            if (IsNaN(x) || x == 0)
            {
                return x;
            }

            double ax = x < 0 ? -x : x;
            double result;
            if (ax > 22)
            {
                result = 1;
            }
            else
            {
                // (e^2x - 1) / (e^2x + 1).
                Dd m;
                if (ax < 0.25)
                {
                    m = ExpMinusOneSmall(DoubleDouble.Of(2 * ax));
                }
                else
                {
                    var (e, scale) = ExpParts(DoubleDouble.Of(2 * ax));
                    m = DoubleDouble.Add(DoubleDouble.Scale(e, DoubleDouble.ScaleB(1, scale)), -1.0);
                }

                var value = DoubleDouble.Divide(m, DoubleDouble.Add(m, 2.0));
                result = value.Hi + value.Lo;
            }

            return x < 0 ? -result : result;
        }

        // IEEE remainder of truncated division, exactly: x - trunc(x/y) * y.
        public static double Fmod(double x, double y)
        {
            if (IsNaN(x) || IsNaN(y) || x == double.PositiveInfinity || x == double.NegativeInfinity || y == 0)
            {
                return double.NaN;
            }

            if (y == double.PositiveInfinity || y == double.NegativeInfinity || x == 0)
            {
                return x;
            }

            bool negative = System.BitConverter.DoubleToInt64Bits(x) < 0;
            double ax = negative ? -x : x;
            double ay = y < 0 ? -y : y;
            if (ax < ay)
            {
                return x;
            }

            // Mantissas and exponents; the remainder is exact.
            long xBits = System.BitConverter.DoubleToInt64Bits(ax);
            long yBits = System.BitConverter.DoubleToInt64Bits(ay);
            int xExponent = (int)(xBits >> 52);
            int yExponent = (int)(yBits >> 52);
            ulong xMantissa = (ulong)(xBits & 0xFFFFFFFFFFFFFL);
            ulong yMantissa = (ulong)(yBits & 0xFFFFFFFFFFFFFL);
            if (xExponent == 0)
            {
                xExponent = 1;
                while (xMantissa < (1UL << 52))
                {
                    xMantissa <<= 1;
                    xExponent--;
                }
            }
            else
            {
                xMantissa |= 1UL << 52;
            }

            if (yExponent == 0)
            {
                yExponent = 1;
                while (yMantissa < (1UL << 52))
                {
                    yMantissa <<= 1;
                    yExponent--;
                }
            }
            else
            {
                yMantissa |= 1UL << 52;
            }

            // x * 2^steps mod y, eleven bits at a time: both stay under 2^53.
            xMantissa %= yMantissa;
            for (int steps = xExponent - yExponent; steps > 0; steps -= 11)
            {
                xMantissa = (xMantissa << (steps < 11 ? steps : 11)) % yMantissa;
            }

            // xMantissa * 2^(yExponent - 1075).
            double result = DoubleDouble.ScaleB(xMantissa, yExponent - 1075);
            if (xMantissa == 0)
            {
                result = 0;
            }

            return negative ? -result : result;
        }

        public static float FmodF(float x, float y) => (float)Fmod(x, y);
    }
}
