// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The boundary memory. The component model's canonical ABI passes strings,
// lists and what does not fit the flat parameters and result through the
// module's linear memory; the glue witgen generates ([CanonicalAbi]) copies
// between it and GC objects through runtime/Canonical.cs. Only that glue and
// the runtime may use the memory, and a module whose code does not has none.
//
// The memory is an arena: `cabi_realloc` (the host's allocator, exported)
// and the glue allocate at its end, `__heap_top`, growing the memory as
// needed. An import call's glue returns the arena to where it was once it
// has copied the results, which frees the arguments, the results, and what
// entries made during the call allocated. The outermost entry empties it
// when it starts: the host allocated its parameters there, and the glue
// copies them before allocating anything, so what the previous entry left
// (its results, which the host has read, or anything a trap left behind)
// is reused. The arena needs no post-return functions.
internal sealed partial class Frontend
{
    public const int HeapBase = 16;

    private bool boundaryMemory;
    private int reallocFunction = -1;

    public int HeapTopGlobal { get; private set; } = -1;

    // The arena's floor, where an outermost entry empties it to: the
    // CoreLib raises it over memory that must outlive an entry (the areas
    // of async imports' results, see corelib/ComponentTasks.cs). Only a
    // module that moves it has one; for the others it is HeapBase.
    private bool heapFloor;

    public int HeapFloorGlobal { get; private set; } = -1;

    // The chain of the blocks the host allocated while the CoreLib holds
    // them (see EmitRealloc); only a module that holds them has one.
    private bool hostChain;

    public int HostChainGlobal { get; private set; } = -1;

    public int Realloc => imports.Count + reallocFunction;

    private INamedTypeSymbol? canonicalAbiAttribute;

    private bool HasCanonicalAbi(ISymbol? symbol)
    {
        canonicalAbiAttribute ??= TypeNamed("Gameplay.CanonicalAbiAttribute");
        return symbol is not null && canonicalAbiAttribute is not null && symbol.GetAttributes()
            .Any(attribute => SymbolEqualityComparer.Default.Equals(attribute.AttributeClass, canonicalAbiAttribute));
    }

    private bool IsCanonicalAbiAttribute(INamedTypeSymbol? type)
    {
        canonicalAbiAttribute ??= TypeNamed("Gameplay.CanonicalAbiAttribute");
        return type is not null && SymbolEqualityComparer.Default.Equals(type, canonicalAbiAttribute);
    }

    // A class or struct of generated glue, registered once code uses it.
    // A type that reaches a module only where code uses it: canonical ABI
    // glue, and the runtime's classes.
    private bool IsOnDemandType(ITypeSymbol? type) =>
        type is INamedTypeSymbol { IsGenericType: false } named && IsModuleDefined(named)
        && (HasCanonicalAbi(named) || (IsRuntimeType(named) && named is { TypeKind: TypeKind.Class, IsStatic: false } or { TypeKind: TypeKind.Struct })
            || (InFramework(named) && named is { TypeKind: TypeKind.Class, IsStatic: true }));

    private static bool IsBoundaryType(INamedTypeSymbol? type) =>
        type is not null && IsRuntimeType(type)
        && type.ToDisplayString() is "Gameplay.Runtime.Memory" or "Gameplay.Runtime.Canonical";

    // A call from the CoreLib, or from [CanonicalAbi] glue.
    private void NoteIlBoundaryMemory(IMethodSymbol method, IMethodSymbol caller, IlAnalysis flow, int index)
    {
        if (!IsBoundaryType(method.ContainingType))
        {
            return;
        }

        if (!InCoreLibrary(caller))
        {
            bool allowed = false;
            for (ISymbol? symbol = caller; symbol is not null && !allowed; symbol = symbol.ContainingSymbol)
            {
                allowed = HasCanonicalAbi(symbol);
            }

            if (!allowed)
            {
                throw flow.Error(index, "The boundary memory is only for the canonical ABI glue witgen generates ([Gameplay.CanonicalAbi]).");
            }
        }

        heapFloor |= method.Name is "Floor" or "SetFloor";
        hostChain |= method.Name is "HostChain" or "SetHostChain";
        UseBoundaryMemory();
    }

    // The memory and its allocator, once.
    private void UseBoundaryMemory()
    {
        if (boundaryMemory)
        {
            return;
        }

        boundaryMemory = true;
        StringType();
        reallocFunction = methods.Count;
        methods.Add(new(
            null, "cabi_realloc", [WType.I32, WType.I32, WType.I32, WType.I32], WType.I32, true, null,
            MethodPlanKind.Realloc, Substitution.Empty));
    }
}
