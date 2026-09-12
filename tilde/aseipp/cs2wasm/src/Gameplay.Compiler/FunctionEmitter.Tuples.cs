// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Tuples: C#'s (a, b), which are the runtime's ValueTuple structs
// (runtime/Tuples.cs), element names aside.
internal sealed partial class FunctionEmitter
{

    // Each element of a tuple in a local, in a new local of its own.
    private int[] TupleElements(int value, ITypeSymbol type)
    {
        var layout = frontend.StructOf(type);
        var place = new Location(LocationKind.Local, frontend.MapType(type), type, Local: value, ReadOnly: true);
        return layout.Fields.Select(field => LoadMember(place, -1, type, field)).ToArray();
    }
}
