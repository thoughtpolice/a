// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Interface re-implementation where the compiler calls an interface
// member's implementation directly rather than through an itable: the
// default comparers (EqualityComparer<T>.Default's IEquatable<T>.Equals,
// Comparer<T>.Default's IComparable<T>.CompareTo and IComparable's
// CompareTo(object)), which the CLR calls through the interface on the
// value. A class that lists the interface again and declares its own
// member (`class Derived : Base, IEquatable<Base>` with a `new` Equals)
// re-implements it, and the CLR's interface dispatch runs the most derived
// class's implementation, not the one T's own declaration maps; virtual
// dispatch alone, which finds overrides, does not. So such a call tests the
// value against the module's classes deriving from T that change the
// implementation, most derived first (a closed world: every class is
// known), as a generic virtual method's dispatcher does. Interface calls
// through itables need none of this: each class's itable holds its own
// implementation (Frontend.Interfaces).
internal sealed partial class Frontend
{
    private readonly HashSet<(INamedTypeSymbol Type, IMethodSymbol Member)> reimplementationDemands = [];

    // A direct call of the implementation of `member` T maps, which
    // discovery completes with the re-implementations of T's subclasses as
    // classes appear.
    private void DemandReimplementations(ITypeSymbol type, IMethodSymbol member)
    {
        if (type is INamedTypeSymbol { TypeKind: TypeKind.Class, IsSealed: false } named)
        {
            reimplementationDemands.Add((named, member));
        }
    }

    private void DrainReimplementations()
    {
        foreach (var (type, member) in reimplementationDemands.ToList())
        {
            foreach (var (_, implementation) in Reimplementations(type, member))
            {
                EnsureMethod(implementation, Substitution.Empty);
            }
        }
    }

    // The module's classes deriving from T whose implementation of an
    // interface member differs from their base class's, most derived
    // first: a class that re-implements the interface, whose subclasses
    // (unless one re-implements it again) run what it does.
    public List<(INamedTypeSymbol Class, IMethodSymbol Implementation)> Reimplementations(ITypeSymbol type, IMethodSymbol member)
    {
        var found = new List<(INamedTypeSymbol, IMethodSymbol)>();
        if (type is not INamedTypeSymbol { TypeKind: TypeKind.Class, IsSealed: false } named)
        {
            return found;
        }

        foreach (var layout in layouts.Values.Where(layout => !layout.IsBox).OrderByDescending(layout => Depth(layout.Symbol)))
        {
            var candidate = layout.Symbol;
            if (SymbolEqualityComparer.Default.Equals(candidate, named) || !DerivesFrom(candidate, named)
                || candidate.BaseType is not { } baseType
                || candidate.FindImplementationForInterfaceMember(member) is not IMethodSymbol implementation
                || implementation.IsAbstract
                || SymbolEqualityComparer.Default.Equals(implementation, baseType.FindImplementationForInterfaceMember(member)))
            {
                continue;
            }

            found.Add((candidate, implementation));
        }

        return found;
    }
}
