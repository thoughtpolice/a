// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Gameplay code that uses what DescribeGenerator generates: the attribute
// it declares, and the members it adds to each [Describe] type. The same
// file runs on the CLR (Program.cs, compiled by csc with the generator as
// an analyzer) and in Wasm (compiled by gameplayc --generator); the
// exports' results must agree.
namespace Probe;

[Describe]
public partial struct Point
{
    public int X;
    public float Y;
}

[Describe]
public partial class Enemy
{
    public string Name = "";
    public int Health;
    public bool Boss;
}

public static class Checks
{
    public static int FieldCounts() => Point.FieldCount * 10 + Enemy.FieldCount;

    public static int DescriptionLength() => Point.Describe().Length + Enemy.Describe().Length;

    // FNV-1a over both descriptions.
    public static int DescriptionHash()
    {
        uint hash = 2166136261;
        foreach (char character in Point.Describe() + "|" + Enemy.Describe())
        {
            hash = (hash ^ character) * 16777619;
        }

        return unchecked((int)hash);
    }

    public static bool DescribesPoint() => Point.Describe() == "Point(X:int, Y:float)";
}
