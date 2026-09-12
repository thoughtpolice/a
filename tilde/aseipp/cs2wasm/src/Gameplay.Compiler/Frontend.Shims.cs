// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Framework members written in C# (runtime/Shims.cs): a static class in
// Gameplay.Runtime.Shims named like a framework type holds, under the same
// name, a static method per framework method it stands for, with the
// receiver of an instance method first. A call of the framework method is a
// call of the shim, and only the shims code calls get functions.
internal sealed partial class Frontend
{
    private const string ShimNamespace = "Gameplay.Runtime.Shims.";

    private readonly Dictionary<IMethodSymbol, IMethodSymbol?> shims = new(SymbolEqualityComparer.Default);

    // The shim a framework method runs, closed over its type arguments.
    public IMethodSymbol? ShimOf(IMethodSymbol method)
    {
        if (method.ContainingType is not { } type || IsModuleDefined(type))
        {
            return null;
        }

        if (shims.TryGetValue(method, out var cached))
        {
            return cached;
        }

        IMethodSymbol? shim = null;
        var definition = method.OriginalDefinition;
        if (!type.IsGenericType && TypeNamed(ShimNamespace + type.MetadataName) is { } shimClass
            && IsRuntimeType(shimClass))
        {
            var wanted = definition.IsStatic
                ? definition.Parameters.Select(parameter => (parameter.Type, parameter.RefKind)).ToList()
                : [(type, RefKind.None), .. definition.Parameters.Select(parameter => (parameter.Type, parameter.RefKind))];
            // An instance method's shim may be named for it apart from a
            // static method of its shape (InstanceEquals); a constructor's
            // is New.
            var candidates = definition.MethodKind == MethodKind.Constructor
                ? shimClass.GetMembers("New")
                : definition.IsStatic
                    ? shimClass.GetMembers(method.Name)
                    : [.. shimClass.GetMembers("Instance" + method.Name), .. shimClass.GetMembers(method.Name)];
            if (definition.MethodKind == MethodKind.Constructor)
            {
                wanted = [.. definition.Parameters.Select(parameter => (parameter.Type, parameter.RefKind))];
            }

            // Which of the wanted parameters are params spans, which a
            // shim's array may take.
            var isParams = wanted.Select((_, index) =>
            {
                int ordinal = index - (wanted.Count - definition.Parameters.Length);
                return ordinal >= 0 && definition.Parameters[ordinal].IsParams;
            }).ToList();
            foreach (var candidate in candidates.OfType<IMethodSymbol>())
            {
                if (candidate.IsStatic && candidate.Arity == definition.Arity
                    && candidate.Parameters.Length == wanted.Count
                    && candidate.Parameters.Select((parameter, index) =>
                            parameter.RefKind == wanted[index].RefKind
                            && (SameShape(parameter.Type, wanted[index].Type)
                                || (isParams[index] && IsParamsSpanOf(parameter.Type, wanted[index].Type))))
                        .All(same => same)
                    && (definition.MethodKind == MethodKind.Constructor
                        ? SymbolEqualityComparer.Default.Equals(candidate.ReturnType, type)
                        : SameShape(Unnamed(candidate.ReturnType), Unnamed(definition.ReturnType))))
                {
                    shim = candidate.IsGenericMethod ? candidate.Construct([.. method.TypeArguments]) : candidate;
                    break;
                }
            }
        }

        shims.Add(method, shim);
        return shim;
    }

    // A shim's array for a framework method's params span (C# 13's params
    // ReadOnlySpan<T>, which overload resolution prefers).
    private static bool IsParamsSpanOf(ITypeSymbol shim, ITypeSymbol framework) =>
        shim is IArrayTypeSymbol { Rank: 1 } array
        && framework is INamedTypeSymbol { Name: "ReadOnlySpan" or "Span", TypeArguments: [var element] } span
        && span.ContainingNamespace.ToDisplayString() == "System"
        && SameShape(array.ElementType, element);

    public IArrayTypeSymbol ArrayOf(ITypeSymbol element) => compilation.CreateArrayTypeSymbol(element);

    // Types alike but for the method type parameters, matched by position.
    private static bool SameShape(ITypeSymbol left, ITypeSymbol right) => (left, right) switch
    {
        (ITypeParameterSymbol { TypeParameterKind: TypeParameterKind.Method } a,
            ITypeParameterSymbol { TypeParameterKind: TypeParameterKind.Method } b) => a.Ordinal == b.Ordinal,
        (IArrayTypeSymbol a, IArrayTypeSymbol b) => a.Rank == b.Rank && SameShape(a.ElementType, b.ElementType),
        // A span, as the runtime's struct standing for it.
        (INamedTypeSymbol a, INamedTypeSymbol b) when IsFrameworkSpan(b) =>
            IsRuntimeType(a) && a.MetadataName == b.MetadataName
            && a.TypeArguments.Zip(b.TypeArguments).All(pair => SameShape(pair.First, pair.Second)),
        (INamedTypeSymbol { IsGenericType: true } a, INamedTypeSymbol { IsGenericType: true } b) =>
            SymbolEqualityComparer.Default.Equals(a.OriginalDefinition, b.OriginalDefinition)
            && a.TypeArguments.Zip(b.TypeArguments).All(pair => SameShape(pair.First, pair.Second)),
        _ => SymbolEqualityComparer.Default.Equals(left, right),
    };

    // A runtime method the emitter calls itself, by class and name.
    public IMethodSymbol RuntimeMethod(string type, string name, int parameters) =>
        TypeNamed("Gameplay.Runtime." + type)!
            .GetMembers(name)
            .OfType<IMethodSymbol>()
            .First(method => method.Parameters.Length == parameters);

    private void EnsureRuntimeMethod(string type, string name, int parameters) =>
        EnsureMethod(RuntimeMethod(type, name, parameters), Substitution.Empty);
}
