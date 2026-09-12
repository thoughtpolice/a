// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// decimal. System.Decimal is the runtime's struct of that name
// (runtime/Decimal.cs; see Frontend.RuntimeCounterpart), and C#'s built-in
// decimal operators and numeric conversions, which Roslyn binds without an
// operator method, are System.Decimal's operator methods: every operator
// consumer asks here for an operation's method, so a decimal operator is a
// user-defined one calling the runtime's.
internal static class DecimalOperators
{
    private static INamedTypeSymbol? DecimalOf(ITypeSymbol? type)
    {
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable)
        {
            type = nullable.TypeArguments[0];
        }

        return type is INamedTypeSymbol { SpecialType: SpecialType.System_Decimal } named ? named : null;
    }

    public static bool IsDecimal(ITypeSymbol? type) => DecimalOf(type) is not null;
}

internal sealed partial class Frontend
{
    private INamedTypeSymbol? runtimeDecimal;

    public INamedTypeSymbol RuntimeDecimal =>
        runtimeDecimal ??= TypeNamed("Gameplay.Runtime.Decimal")
            ?? throw new InternalCompilerError("the runtime has no Decimal.");

    // decimal itself, or the runtime's struct standing for it.
    public bool IsDecimalType(ITypeSymbol? type) =>
        type?.SpecialType == SpecialType.System_Decimal || SymbolEqualityComparer.Default.Equals(type, RuntimeDecimal);

    // Decimal.Equals(d1, d2) and the runtime's Hash(d): the default
    // equality and hash of decimals, by value (1.0m equals 1.00m).
    public IMethodSymbol DecimalEquality =>
        RuntimeDecimal.GetMembers("Equals").OfType<IMethodSymbol>().Single(method => method.IsStatic && method.Parameters.Length == 2);

    public IMethodSymbol DecimalHash =>
        RuntimeDecimal.GetMembers("Hash").OfType<IMethodSymbol>().Single();
}
