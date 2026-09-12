// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The module side of world `echo` in echo.wit, which tests/wit.mjs calls
// through a component runtime when one is installed.
namespace Test.Echo;

public static partial class Echo
{
    public static partial string Shout(string text) => text + "! (" + text.Length + ")";

    public static partial Entry[] Entries(string[] names)
    {
        var entries = new Entry[names.Length];
        for (int index = 0; index < names.Length; index++)
        {
            var values = new ushort[names[index].Length];
            for (int unit = 0; unit < values.Length; unit++)
                values[unit] = names[index][unit];
            entries[index] = new Entry(names[index] + index, values);
        }

        return entries;
    }

    public static partial Result<string, uint> Classify(Mixed value) => value switch
    {
        MixedSmall small => new Ok<string>("small " + (int)(small.Value * 2)),
        MixedBig big => new Ok<string>("big " + big.Value),
        MixedText text => new Ok<string>("text " + text.Value),
        _ => new Err<uint>(7),
    };

    public static partial string Pick(Tuple2<string, uint>[] items, uint wanted)
    {
        foreach (var item in items)
        {
            if (item.Item1 == wanted)
                return item.Item0;
        }

        return null;
    }
}
