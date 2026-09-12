// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A union is a struct of one reference, so its comparer's itable members
// have the function types of a string comparer's: an interface thunk read
// the union back where it passed a string, and left the string uncast (the
// fuzzer's seed 5240).
using System;
using System.Collections.Generic;
internal record Tag;
internal sealed class Cat { }
internal union Pet(long, Cat);
internal class Shelter
{
    public virtual int Count(int x)
    {
        var pets = new HashSet<Pet>();
        return pets.Count + x;
    }
}
public static class Entry
{
    public static int F(int x)
    {
        var counts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        counts["a"] = x;
        return counts.Count + new Shelter().Count(x);
    }
}
