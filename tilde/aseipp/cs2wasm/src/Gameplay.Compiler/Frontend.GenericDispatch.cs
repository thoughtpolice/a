// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Generic virtual methods: a virtual, abstract or override generic method
// of a class, and a generic method of an interface. Each instantiation code
// calls gets a dispatcher, a function taking the receiver and arguments,
// which tests the receiver against every concrete class that can receive
// it, most derived first, and calls that class's implementation of the
// instantiation (a vtable has no slots for them, since instantiations are
// found while the vtables grow). A struct's box runs the struct's method
// on the storage it holds. Discovery instantiates each class's
// implementation for every dispatched instantiation, as classes appear.
internal sealed partial class Frontend
{
    private readonly Dictionary<IMethodSymbol, int> genericDispatchers = new(SymbolEqualityComparer.Default);

    // Whether calls of a closed method go through a dispatcher.
    public static bool IsGenericDispatch(IMethodSymbol method) =>
        method is { IsGenericMethod: true, IsStatic: false }
        && (IsDispatched(method) || method.ContainingType.TypeKind == TypeKind.Interface)
        && method.MethodKind == MethodKind.Ordinary;

    // The dispatcher of an instantiation, registered on first use.
    private void EnsureGenericDispatcher(IMethodSymbol method)
    {
        method = DispatchRoot(method);
        if (genericDispatchers.ContainsKey(method))
        {
            return;
        }

        genericDispatchers.Add(method, methods.Count);
        var receiver = method.ContainingType.TypeKind == TypeKind.Interface
            ? WType.Ref(ObjectHeapOrRoot())
            : MapType(method.ContainingType);
        methods.Add(new(
            method,
            method.ToDisplayString() + " [dispatch]",
            [receiver, .. PlanParameters(method)],
            PlanResult(method),
            false,
            method.ContainingType,
            MethodPlanKind.GenericDispatch,
            Substitution.Empty));
    }

    private int ObjectHeapOrRoot()
    {
        EnsureObjectRoot();
        return objectHeap;
    }

    // The instantiation of the method whose slot a class generic method
    // overrides; an interface's own.
    private static IMethodSymbol DispatchRoot(IMethodSymbol method)
    {
        if (method.ContainingType.TypeKind == TypeKind.Interface)
        {
            return method;
        }

        var root = SlotRoot(method.ConstructedFrom);
        return root.Construct([.. method.TypeArguments]);
    }

    public MethodPlan MethodPlanOf(IMethodSymbol method) => methods[methodIds[method]];

    // The plan of a function by its index before pruning.
    public MethodPlan PlanOfFunction(int function) => methods[function - imports.Count];

    public int GenericDispatcher(IMethodSymbol method) =>
        genericDispatchers.TryGetValue(DispatchRoot(method), out int id)
            ? imports.Count + id
            : throw Error(UnsupportedCall(method, "no generic virtual dispatcher"));

    // The concrete classes a dispatcher tests for, most derived first, and
    // the implementation each runs.
    public List<(ClassLayout Layout, IMethodSymbol Implementation)> GenericDispatchTargets(IMethodSymbol method)
    {
        var targets = new List<(ClassLayout, IMethodSymbol)>();
        foreach (var layout in layouts.Values.Where(layout => !layout.Symbol.IsAbstract).Concat(boxes.Values)
                     .OrderByDescending(layout => layout.IsBox ? 0 : Depth(layout.Symbol)))
        {
            if (GenericImplementation(layout.Symbol, method) is { } implementation)
            {
                targets.Add((layout, implementation));
            }
        }

        return targets;
    }

    // The instantiation a class runs for a dispatched one, if it can receive
    // it: its most derived override of the class method, or its
    // implementation of the interface method.
    private static IMethodSymbol? GenericImplementation(INamedTypeSymbol type, IMethodSymbol method)
    {
        if (method.ContainingType.TypeKind == TypeKind.Interface)
        {
            if (!type.AllInterfaces.Any(candidate => SameInterface(candidate, method.ContainingType))
                || type.FindImplementationForInterfaceMember(method.ConstructedFrom) is not IMethodSymbol implementation)
            {
                return null;
            }

            // A virtual implementation runs as the class overrides it.
            var constructed = implementation.Construct([.. method.TypeArguments]);
            return IsDispatched(implementation) && implementation.ContainingType.TypeKind != TypeKind.Interface
                ? GenericImplementation(type, constructed)
                : implementation.IsAbstract ? null : constructed;
        }

        if (!DerivesFrom(type, method.ContainingType))
        {
            return null;
        }

        var root = SlotRoot(method.ConstructedFrom).OriginalDefinition;
        for (INamedTypeSymbol? current = type; current is not null; current = current.BaseType)
        {
            foreach (var candidate in current.GetMembers(method.Name).OfType<IMethodSymbol>())
            {
                if (candidate.IsGenericMethod && !candidate.IsAbstract
                    && candidate.Arity == method.Arity
                    && SymbolEqualityComparer.Default.Equals(SlotRoot(candidate).OriginalDefinition, root))
                {
                    return candidate.Construct([.. method.TypeArguments]);
                }
            }

            if (SymbolEqualityComparer.Default.Equals(current.OriginalDefinition, method.ContainingType.OriginalDefinition))
            {
                return null;
            }
        }

        return null;
    }

    // Instantiates every class's implementation of every dispatched
    // instantiation; discovery runs it until no class or instantiation is
    // new.
    private void DrainGenericDispatch()
    {
        foreach (var method in genericDispatchers.Keys.ToList())
        {
            foreach (var layout in layouts.Values.Where(layout => !layout.Symbol.IsAbstract).Concat(boxes.Values).ToList())
            {
                if (GenericImplementation(layout.Symbol, method) is { } implementation)
                {
                    EnsureMethod(implementation, Substitution.Empty);
                }
            }
        }
    }
}
