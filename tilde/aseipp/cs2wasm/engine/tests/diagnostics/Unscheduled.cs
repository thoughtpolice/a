// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// KILN014: a program over a library of Kiln declarations (Library.cs)
// compiled without Kiln's generator, which is therefore no Kiln library.
namespace Bad;

using Kiln;

public static class Program
{
    public static int Run() => World.Create().EntityCount;
}
