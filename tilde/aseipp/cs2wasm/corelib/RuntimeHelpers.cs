// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// RuntimeHelpers' internal members dotnet/runtime's sources call. The type
// stays .NET's (the importer implements its public members).

using Gameplay.Runtime;

namespace System.Runtime.CompilerServices
{
    [Surface]
    public static partial class RuntimeHelpers
    {
        // The JIT's: whether an argument is a constant where the call is
        // inlined. Never, here, so code takes its general path.
        internal static bool IsKnownConstant(int value) => false;

        internal static bool IsKnownConstant(uint value) => false;

        internal static bool IsKnownConstant(long value) => false;

        internal static bool IsKnownConstant(ulong value) => false;

        internal static bool IsKnownConstant(char value) => false;

        internal static bool IsKnownConstant(string? value) => false;

        internal static bool IsKnownConstant(Type? value) => false;
    }
}
