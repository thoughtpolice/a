// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Numerics;
using System.Runtime.Intrinsics;

namespace Tests.NativeIntegers;

// What has no CLR counterpart to compare with (tests/native-integers.mjs):
// native integers are 64 bits here, as on the oracle's CLR, and values of
// their own (arrays, fields, lanes, boxes); little-endian; BigInteger's
// hash is deterministic and agrees with equality; its text of numbers
// known by heart; a BigInteger computation larger than the budgets faults.
public static class Natives
{
    private sealed class Holder
    {
        public nint Signed;
        public nuint Unsigned;
    }

    public static int Size() => IntPtr.Size * 10 + UIntPtr.Size + (BitConverter.IsLittleEndian ? 100 : 0);

    public static long Arrays(int count)
    {
        var limbs = new nuint[count];
        for (int index = 0; index < count; index++)
        {
            limbs[index] = (nuint)index * (nuint)0x1_0000_0001UL;
        }

        var holder = new Holder { Signed = -count, Unsigned = nuint.MaxValue };
        object boxed = holder.Signed;
        nuint sum = 0;
        foreach (nuint limb in limbs)
        {
            sum += limb;
        }

        return (long)sum + (boxed is nint back ? back : 0) + (long)(holder.Unsigned >> 60) + (nint)(-7) / 2;
    }

    public static long Lanes(long a, long b)
    {
        Vector128<nuint> vector = Vector128.Create((nuint)a).WithElement(1, (nuint)b);
        Vector128<nuint> shifted = (vector << 4) | (vector >> 60);
        Vector128<nint> signed = Vector128.Create((nint)a).WithElement(1, (nint)b) >> 1;
        return (long)shifted.GetElement(0) ^ (long)shifted.GetElement(1) ^ signed.GetElement(1) ^ (Vector128<nint>.IsSupported ? 1 : 0);
    }

    public static int Hashes(int which)
    {
        BigInteger a = BigInteger.Pow(3, 100 + which);
        BigInteger b = BigInteger.Parse(a.ToString());
        var set = new HashSet<BigInteger> { a, b, -a, a + 1 };
        return (a.GetHashCode() == b.GetHashCode() ? 1 : 0) + set.Count * 10 + (new BigInteger(which).GetHashCode() == which ? 100 : 0);
    }

    public static int Hash() => BigInteger.Pow(7, 40).GetHashCode();

    public static int Text(int which) => which switch
    {
        0 => (BigInteger.One << 100).ToString() == "1267650600228229401496703205376" ? 1 : 0,
        1 => (-(BigInteger.One << 64)).ToString("X") == "F0000000000000000" ? 1 : 0,
        2 => BigInteger.Parse("-0x10".Substring(3), System.Globalization.NumberStyles.HexNumber) == 16 ? 1 : 0,
        3 => new Complex(1.5, -2).ToString() == "<1.5; -2>" ? 1 : 0,
        _ => $"{BigInteger.Pow(10, 20):N0}" == "100,000,000,000,000,000,000" ? 1 : 0,
    };

    // A thousand-digit power, printed: beyond the default budgets.
    public static int Huge(int digits) => BigInteger.Pow(10, digits).ToString().Length;
}
