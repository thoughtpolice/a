// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Nullable value types: `int?` is the runtime's Nullable<int>
// (runtime/Nullable.cs), a flag and a value, whose members are C#.
internal sealed partial class FunctionEmitter
{
    private bool IsNullable(ITypeSymbol? type) => type is not null && frontend.IsRuntimeNullable(Sub(type));

    private ITypeSymbol Underlying(ITypeSymbol nullable) => ((INamedTypeSymbol)Sub(nullable)).TypeArguments[0];

    // Whether a nullable in a local has a value, and its value, in locals.
    private (int Has, int Value) NullableParts(int nullable, ITypeSymbol type)
    {
        int[] parts = TupleElements(nullable, Sub(type));
        return (parts[0], parts[1]);
    }
}
