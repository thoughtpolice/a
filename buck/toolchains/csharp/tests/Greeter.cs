// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Depot.CSharp.Tests;

public static class Greeter
{
    public static string Greet(string name) => $"hello, {name}";

    // Exercises LINQ and collection code paths that trimming and AOT must keep.
    public static int SumOfSquares(int count) => Enumerable.Range(0, count).Select(i => i * i).Sum();
}
