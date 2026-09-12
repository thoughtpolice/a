// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Spans. System.Span<T> and ReadOnlySpan<T> are the runtime's structs of
// those names (runtime/Spans.cs), as a tuple type is its ValueTuple: an
// array, a start and a length, flattened in locals like any struct. C#'s
// span conversions (an array or a span to a span, a string to a span of its
// chars) call the runtime's conversions, and stackalloc makes a fresh array
// (Spans.StackAlloc) holding its initializer.
internal sealed partial class Frontend
{
    // MemoryExtensions.AsSpan(string), the runtime's: what string's
    // conversion to ReadOnlySpan<char> is.
    public IMethodSymbol StringAsSpan() => RuntimeTypeNamed("System.MemoryExtensions")!
        .GetMembers("AsSpan").OfType<IMethodSymbol>()
        .Single(method => method.Parameters is [{ Type.SpecialType: SpecialType.System_String }]);

    // A runtime span's ToArray.
    public static IMethodSymbol SpanToArray(INamedTypeSymbol span) =>
        span.GetMembers("ToArray").OfType<IMethodSymbol>().Single(method => method.Parameters.Length == 0);
}
