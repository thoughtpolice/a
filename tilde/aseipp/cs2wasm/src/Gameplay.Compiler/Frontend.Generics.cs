// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The type arguments one instantiation binds: definition type parameters
// (of the containing types and the method) to closed types. A generic
// definition's IL names its own type parameters; the code for an
// instantiation maps every type and member it mentions through its
// substitution. The frontend interns substitutions, so they compare by
// reference.
internal sealed class Substitution
{
    public static readonly Substitution Empty = new([]);

    public Substitution(ImmutableArray<(ITypeParameterSymbol Parameter, ITypeSymbol Argument)> pairs)
    {
        Pairs = pairs;
    }

    public ImmutableArray<(ITypeParameterSymbol Parameter, ITypeSymbol Argument)> Pairs { get; }

    public bool IsEmpty => Pairs.IsEmpty;

    public ITypeSymbol? Lookup(ITypeParameterSymbol parameter)
    {
        foreach (var (candidate, argument) in Pairs)
        {
            if (SymbolEqualityComparer.Default.Equals(candidate, parameter))
            {
                return argument;
            }
        }

        return null;
    }

    public override string ToString() =>
        string.Join(", ", Pairs.Select(pair => $"{pair.Parameter.Name}={pair.Argument.ToDisplayString()}"));
}

// Order-insensitive structural equality, for interning.
internal sealed class SubstitutionComparer : IEqualityComparer<Substitution>
{
    public static readonly SubstitutionComparer Instance = new();

    public bool Equals(Substitution? left, Substitution? right)
    {
        if (ReferenceEquals(left, right))
        {
            return true;
        }

        if (left is null || right is null || left.Pairs.Length != right.Pairs.Length)
        {
            return false;
        }

        foreach (var (parameter, argument) in left.Pairs)
        {
            if (right.Lookup(parameter) is not { } other || !SymbolEqualityComparer.Default.Equals(argument, other))
            {
                return false;
            }
        }

        return true;
    }

    public int GetHashCode(Substitution substitution)
    {
        int hash = 0;
        foreach (var (parameter, argument) in substitution.Pairs)
        {
            hash ^= HashCode.Combine(
                SymbolEqualityComparer.Default.GetHashCode(parameter),
                SymbolEqualityComparer.Default.GetHashCode(argument));
        }

        return hash;
    }
}

// A key of a table about one body under one instantiation: the same
// symbol of a generic definition belongs to every instantiation, with
// different types.
internal readonly record struct Instance(object Item, Substitution Generic)
{
    public bool Equals(Instance other) =>
        ReferenceEquals(Generic, other.Generic)
        && (Item is ISymbol symbol && other.Item is ISymbol otherSymbol
            ? SymbolEqualityComparer.Default.Equals(symbol, otherSymbol)
            : Equals(Item, other.Item));

    public override int GetHashCode() => HashCode.Combine(
        Item is ISymbol symbol ? SymbolEqualityComparer.Default.GetHashCode(symbol) : Item.GetHashCode(),
        Generic);
}

// Generics by monomorphization. Generic classes, interfaces and methods are
// templates; each closed instantiation that code reaches gets its own heap
// types and functions. Types are instantiated as soon as a type mentions
// them (their fields decide layouts), members of generic classes only when
// something calls them, except virtual ones, which vtables need.
internal sealed partial class Frontend
{
    // Nesting of type arguments beyond this is taken for polymorphic
    // recursion (`F<T>() => F<List<T>>()`), which would never finish.
    private const int MaximumGenericDepth = 8;
    private const int MaximumInstantiations = 2048;

    private readonly Dictionary<Substitution, Substitution> substitutions = new(SubstitutionComparer.Instance);
    // The functions of generic class members, created when first reached.
    private readonly Dictionary<IMethodSymbol, Action> deferredMethods = new(SymbolEqualityComparer.Default);
    private readonly Queue<INamedTypeSymbol> pendingInstances = new();
    private readonly HashSet<ISymbol> instantiated = new(SymbolEqualityComparer.Default);
    private readonly HashSet<ISymbol> exactInstantiations = new(SymbolEqualityComparer.Default);
    private bool deferMembers;

    public Substitution Intern(Substitution substitution)
    {
        if (substitution.IsEmpty)
        {
            return Substitution.Empty;
        }

        if (!substitutions.TryGetValue(substitution, out var interned))
        {
            substitutions.Add(substitution, substitution);
            interned = substitution;
        }

        return interned;
    }

    // The substitution that closes the members of a type (and its
    // containing types) and, for a method, its own type parameters.
    public Substitution SubstitutionOf(INamedTypeSymbol? type, IMethodSymbol? method = null)
    {
        var pairs = ImmutableArray.CreateBuilder<(ITypeParameterSymbol, ITypeSymbol)>();
        for (var current = type; current is not null; current = current.ContainingType)
        {
            var parameters = current.OriginalDefinition.TypeParameters;
            for (int index = 0; index < parameters.Length; index++)
            {
                pairs.Add((parameters[index], current.TypeArguments[index]));
            }
        }

        if (method is { IsGenericMethod: true })
        {
            var parameters = method.OriginalDefinition.TypeParameters;
            for (int index = 0; index < parameters.Length; index++)
            {
                pairs.Add((parameters[index], method.TypeArguments[index]));
            }
        }

        return Intern(new Substitution(pairs.ToImmutable()));
    }

    public static bool ContainsTypeParameters(ITypeSymbol? type) => type switch
    {
        ITypeParameterSymbol => true,
        IArrayTypeSymbol array => ContainsTypeParameters(array.ElementType),
        INamedTypeSymbol named => named.TypeArguments.Any(ContainsTypeParameters)
            || ContainsTypeParameters(named.ContainingType),
        _ => false,
    };

    [return: System.Diagnostics.CodeAnalysis.NotNullIfNotNull(nameof(type))]
    public ITypeSymbol? Substitute(Substitution generic, ITypeSymbol? type) =>
        type is null ? null : Unnamed(SubstituteType(generic, type));

    // Tuple element names are only names: a tuple type is the ValueTuple it
    // stands for, and so are tuples among type arguments and elements. A
    // Nullable<T> is the runtime's (runtime/Nullable.cs).
    public ITypeSymbol Unnamed(ITypeSymbol type)
    {
        if (!HasTupleNames(type))
        {
            return type;
        }

        // Of the compilation alone, so once for every compilation of the
        // module (Frontend.ClosedWorld).
        unnamedTypes ??= new(SymbolEqualityComparer.IncludeNullability);
        if (!unnamedTypes.TryGetValue(type, out var unnamed))
        {
            unnamed = type switch
            {
                IArrayTypeSymbol { IsSZArray: false } md => MdArrayClass(md, Unnamed(md.ElementType)),
                IArrayTypeSymbol array => compilation.CreateArrayTypeSymbol(Unnamed(array.ElementType), array.Rank),
                INamedTypeSymbol named => UnnamedNamed(named),
                _ => type,
            };
            unnamedTypes[type] = unnamed;
        }

        return unnamed;
    }

    [ThreadStatic]
    private static Dictionary<ITypeSymbol, ITypeSymbol>? unnamedTypes;

    private INamedTypeSymbol UnnamedNamed(INamedTypeSymbol named)
    {
        if (IsNullableValue(named))
        {
            return RuntimeNullable.Construct(Unnamed(named.TypeArguments[0]));
        }

        if (RuntimeCounterpart(named) is { } counterpart)
        {
            return counterpart;
        }

        var unconstructed = named.ConstructedFrom;
        if (named.ContainingType is { } containing && HasTupleNames(containing))
        {
            var unnamedContaining = (INamedTypeSymbol)Unnamed(containing);
            var nested = unnamedContaining.GetTypeMembers(named.Name, named.Arity);
            // In the runtime's own type standing for a framework one (a
            // span's Enumerator), the type of the name.
            unconstructed = RuntimeCounterpart(containing) is not null
                ? nested.First()
                : nested.First(member => SymbolEqualityComparer.Default.Equals(member.OriginalDefinition, named.OriginalDefinition));
        }

        return named.Arity == 0 ? unconstructed : unconstructed.Construct(named.TypeArguments.Select(Unnamed).ToArray());
    }

    public bool IsRuntimeNullable(ITypeSymbol? type) =>
        type is INamedTypeSymbol named && SymbolEqualityComparer.Default.Equals(named.OriginalDefinition, RuntimeNullable);

    public static bool IsNullableValue(ITypeSymbol? type) =>
        type?.OriginalDefinition.SpecialType == SpecialType.System_Nullable_T;

    private INamedTypeSymbol RuntimeNullable =>
        runtimeNullable ??= TypeNamed("Gameplay.Runtime.Nullable`1")
            ?? throw new InternalCompilerError("the runtime has no Nullable.");

    private INamedTypeSymbol? runtimeNullable;

    private static bool HasTupleNames(ITypeSymbol type)
    {
        tupleNamed ??= new(SymbolEqualityComparer.IncludeNullability);
        if (!tupleNamed.TryGetValue(type, out bool named))
        {
            named = FindTupleNames(type);
            tupleNamed[type] = named;
        }

        return named;
    }

    [ThreadStatic]
    private static Dictionary<ITypeSymbol, bool>? tupleNamed;

    private static bool FindTupleNames(ITypeSymbol type) => type switch
    {
        INamedTypeSymbol { IsTupleType: true, TupleUnderlyingType: not null } => true,
        INamedTypeSymbol named when IsNullableValue(named) => true,
        INamedTypeSymbol { Name: "Index" or "Range" or "Type" or "StringComparer" or "Decimal" or "CharEnumerator", Arity: 0, ContainingNamespace: { Name: "System" } space }
            when space.ContainingNamespace.IsGlobalNamespace => true,
        INamedTypeSymbol named when IsFrameworkTuple(named) || IsMemberInfo(named) || IsFrameworkSpan(named)
                                    || IsFrameworkMemory(named) || CultureCounterpart(named) is not null => true,
        INamedTypeSymbol named => named.TypeArguments.Any(HasTupleNames)
            || (named.ContainingType is { } containing && HasTupleNames(containing)),
        IArrayTypeSymbol array => !array.IsSZArray || HasTupleNames(array.ElementType),
        _ => false,
    };

    // A member of a type with tuple names, as the unnamed type's.
    private T UnnamedMember<T>(T member)
        where T : class, ISymbol
    {
        if (member.ContainingType is not { } containing || !HasTupleNames(containing))
        {
            return member;
        }

        var unnamed = (INamedTypeSymbol)Unnamed(containing);
        if (RuntimeCounterpart(containing) is not null
            || (!IsNullableValue(containing) && !IsFrameworkTuple(containing)
                && !SymbolEqualityComparer.Default.Equals(unnamed.OriginalDefinition, containing.OriginalDefinition)
                && IsRuntimeType(unnamed) && !IsRuntimeType(containing)))
        {
            // The runtime's member of the name and parameter types.
            if (member is IFieldSymbol { CorrespondingTupleField: { } tupleField })
            {
                member = (T)(ISymbol)tupleField;
            }

            var counterpart = unnamed.GetMembers(member.Name)
                .OfType<T>()
                .FirstOrDefault(candidate => SameSignature(candidate, member)
                                             && (candidate as IMethodSymbol)?.Arity == (member as IMethodSymbol)?.Arity)
                ?? throw new CompileError(CultureCounterpart(containing) is not null
                    ? $"'{member.ToDisplayString()}' is unsupported: only the invariant culture is "
                      + "(CultureInfo.InvariantCulture, NumberFormatInfo.InvariantInfo or a null provider)."
                    : $"'{member.ToDisplayString()}' is unsupported.");

            // A generic method (decimal.CreateChecked<int>) with the call's
            // type arguments.
            return counterpart is IMethodSymbol { IsGenericMethod: true } genericCounterpart && member is IMethodSymbol call
                ? (T)(ISymbol)genericCounterpart.ConstructedFrom.Construct(call.TypeArguments.Select(Unnamed).ToArray())
                : counterpart;
        }

        if (IsNullableValue(containing))
        {
            // The runtime's member of the name and arity.
            return unnamed.GetMembers(member.Name)
                .OfType<T>()
                .First(candidate => ParameterCount(candidate) == ParameterCount(member));
        }

        if (member is IFieldSymbol { CorrespondingTupleField: { } element })
        {
            member = (T)(ISymbol)element;
        }

        var definition = member is IMethodSymbol method ? method.ConstructedFrom.OriginalDefinition : member.OriginalDefinition;
        var found = unnamed.GetMembers(member.Name)
            .OfType<T>()
            .First(candidate => SymbolEqualityComparer.Default.Equals(
                candidate is IMethodSymbol candidateMethod
                    ? candidateMethod.ConstructedFrom.OriginalDefinition
                    : candidate.OriginalDefinition,
                definition));
        return found is IMethodSymbol { IsGenericMethod: true } generic && member is IMethodSymbol original
            ? (T)(ISymbol)generic.ConstructedFrom.Construct(original.TypeArguments.Select(Unnamed).ToArray())
            : found;
    }

    // The framework structs the runtime has its own of: System.Index and
    // System.Range, which C# makes of `^i` and `a..b`, in Gameplay.Runtime
    // (runtime/Ranges.cs); and the framework's ValueTuples, which a
    // framework member's signature can name, as the runtime's (C# binds
    // tuples in code to those).
    private INamedTypeSymbol? RuntimeCounterpart(ITypeSymbol type)
    {
        if (type is INamedTypeSymbol span && (IsFrameworkSpan(span) || IsFrameworkMemory(span)))
        {
            return TypeNamed("Gameplay.Runtime." + span.MetadataName)!
                .Construct(span.TypeArguments.Select(Unnamed).ToArray());
        }

        if (type is INamedTypeSymbol culture && CultureCounterpart(culture) is { } cultureName)
        {
            return TypeNamed("Gameplay.Runtime." + cultureName)!;
        }

        if (IsMemberInfo(type))
        {
            // Type's base, whose members (Name) only Type objects have here.
            return TypeNamed("Gameplay.Runtime.Type");
        }

        if (type is not INamedTypeSymbol { ContainingNamespace: { Name: "System" } space } named
            || !space.ContainingNamespace.IsGlobalNamespace)
        {
            return null;
        }

        if (named is { Name: "CharEnumerator", Arity: 0 })
        {
            // What string.GetEnumerator makes (a spread of a string, in IL).
            return TypeNamed("Gameplay.Runtime.StringEnumerator")!;
        }

        if (named is { Name: "Index" or "Range" or "Type" or "StringComparer" or "Decimal", Arity: 0 })
        {
            return TypeNamed("Gameplay.Runtime." + type.Name)
                ?? throw new InternalCompilerError($"the runtime has no {type.Name}.");
        }

        if (IsFrameworkTuple(named)
            && RuntimeTypeNamed("System.ValueTuple`" + named.Arity) is { } source)
        {
            return source.Construct(named.TypeArguments.Select(Unnamed).ToArray());
        }

        return null;
    }

    // System.Span<T> and ReadOnlySpan<T>, the runtime's structs (see
    // Frontend.Spans).
    public static bool IsFrameworkSpan(INamedTypeSymbol type) =>
        type is { MetadataName: "Span`1" or "ReadOnlySpan`1", ContainingNamespace: { Name: "System" } system }
        && system.ContainingNamespace.IsGlobalNamespace && !IsRuntimeType(type);

    // IFormatProvider, CultureInfo and NumberFormatInfo: the runtime's
    // classes of the invariant culture (runtime/Culture.cs).
    private static string? CultureCounterpart(INamedTypeSymbol type) => type switch
    {
        { Name: "IFormatProvider", Arity: 0, ContainingNamespace: { Name: "System" } system }
            when system.ContainingNamespace.IsGlobalNamespace => "FormatProvider",
        { Name: "CultureInfo" or "NumberFormatInfo", Arity: 0, ContainingNamespace: { Name: "Globalization" } globalization }
            when globalization.ContainingNamespace is { Name: "System" } outer && outer.ContainingNamespace.IsGlobalNamespace => type.Name,
        _ => null,
    };

    // System.Memory<T> and ReadOnlyMemory<T>, the runtime's structs
    // (runtime/Memory.cs).
    public static bool IsFrameworkMemory(INamedTypeSymbol type) =>
        type is { MetadataName: "Memory`1" or "ReadOnlyMemory`1", ContainingNamespace: { Name: "System" } system }
        && system.ContainingNamespace.IsGlobalNamespace && !IsRuntimeType(type);

    private static bool IsMemberInfo(ITypeSymbol type) =>
        type is INamedTypeSymbol { Name: "MemberInfo", Arity: 0, ContainingNamespace: { Name: "Reflection" } reflection }
        && reflection.ContainingNamespace is { Name: "System" } system && system.ContainingNamespace.IsGlobalNamespace;

    private static bool IsFrameworkTuple(INamedTypeSymbol type) =>
        type is { Name: "ValueTuple", Arity: > 0, ContainingAssembly.Name: not "Gameplay" };

    private static bool SameSignature(ISymbol candidate, ISymbol member)
    {
        var candidateParameters = candidate switch
        {
            IMethodSymbol method => method.Parameters,
            IPropertySymbol property => property.Parameters,
            _ => [],
        };
        var memberParameters = member switch
        {
            IMethodSymbol method => method.Parameters,
            IPropertySymbol property => property.Parameters,
            _ => [],
        };
        // Conversion operators differ in their result alone.
        if (candidate is IMethodSymbol { MethodKind: MethodKind.Conversion } conversion
            && member is IMethodSymbol memberMethod
            && conversion.ReturnType.Name != memberMethod.ReturnType.Name)
        {
            return false;
        }

        return candidateParameters.Length == memberParameters.Length
            && candidate.IsStatic == member.IsStatic
            && candidateParameters.Zip(memberParameters)
                .All(pair => SameShapeOf(pair.First.Type, pair.Second.Type) && pair.First.RefKind == pair.Second.RefKind);
    }

    // The same type by name and type arguments (ReadOnlySpan<char> is not
    // ReadOnlySpan<byte>), a type parameter standing for any.
    private static bool SameShapeOf(ITypeSymbol left, ITypeSymbol right) => (left, right) switch
    {
        (ITypeParameterSymbol, _) or (_, ITypeParameterSymbol) => true,
        (IArrayTypeSymbol a, IArrayTypeSymbol b) => a.Rank == b.Rank && SameShapeOf(a.ElementType, b.ElementType),
        (INamedTypeSymbol a, INamedTypeSymbol b) => a.Name == b.Name && a.TypeArguments.Length == b.TypeArguments.Length
                                                    && a.TypeArguments.Zip(b.TypeArguments).All(pair => SameShapeOf(pair.First, pair.Second)),
        _ => left.Name == right.Name,
    };

    private static int ParameterCount(ISymbol member) => member switch
    {
        IMethodSymbol method => method.Parameters.Length,
        IPropertySymbol property => property.Parameters.Length,
        _ => 0,
    };

    private ITypeSymbol SubstituteType(Substitution generic, ITypeSymbol type)
    {
        if (generic.IsEmpty)
        {
            return type;
        }

        switch (type)
        {
            case ITypeParameterSymbol parameter:
                return generic.Lookup(parameter) ?? type;
            case IArrayTypeSymbol array:
                var element = Substitute(generic, array.ElementType);
                return ReferenceEquals(element, array.ElementType)
                    ? array
                    : compilation.CreateArrayTypeSymbol(element, array.Rank);
            case INamedTypeSymbol named when ContainsTypeParameters(named):
                var definition = named.OriginalDefinition;
                INamedTypeSymbol unconstructed = definition;
                if (named.ContainingType is { } containing)
                {
                    var closed = (INamedTypeSymbol)SubstituteType(generic, containing);
                    unconstructed = closed.GetTypeMembers(definition.Name, definition.Arity)
                        .First(member => SymbolEqualityComparer.Default.Equals(member.OriginalDefinition, definition));
                }

                return named.TypeArguments.Length == 0 || named.Arity == 0
                    ? unconstructed
                    : unconstructed.Construct(named.TypeArguments.Select(argument => SubstituteType(generic, argument)).ToArray());
            default:
                return type;
        }
    }

    // The member of the closed containing type that corresponds to a member
    // of the definition, with a generic method's own type arguments closed.
    public IMethodSymbol Substitute(Substitution generic, IMethodSymbol method)
    {
        if (generic.IsEmpty)
        {
            return UnnamedGenericMethod(UnnamedMember(method));
        }

        var target = SubstituteMember(generic, method);
        // A generic method's own type arguments, closed or not: the member
        // of the closed containing type is its definition.
        if (method.IsGenericMethod && (method.TypeArguments.Any(ContainsTypeParameters)
                                       || SymbolEqualityComparer.Default.Equals(target, target.ConstructedFrom)))
        {
            target = target.ConstructedFrom.Construct(
                method.TypeArguments.Select(argument => Substitute(generic, argument)).ToArray());
        }

        return UnnamedGenericMethod(target);
    }

    private IMethodSymbol UnnamedGenericMethod(IMethodSymbol method) =>
        method.IsGenericMethod && method.TypeArguments.Any(HasTupleNames)
            ? method.ConstructedFrom.Construct(method.TypeArguments.Select(Unnamed).ToArray())
            : method;

    public IFieldSymbol Substitute(Substitution generic, IFieldSymbol field) => SubstituteMember(generic, field);

    public IEventSymbol Substitute(Substitution generic, IEventSymbol symbol) => SubstituteMember(generic, symbol);

    private T SubstituteMember<T>(Substitution generic, T member)
        where T : class, ISymbol
    {
        if (generic.IsEmpty || member.ContainingType is not { } containing || !ContainsTypeParameters(containing))
        {
            return UnnamedMember(member);
        }

        if (member is IFieldSymbol { CorrespondingTupleField: { } tupleField } && !SymbolEqualityComparer.Default.Equals(tupleField, member))
        {
            // A tuple element's name: the ItemN field it stands for.
            member = (T)(ISymbol)tupleField;
        }

        var closed = (INamedTypeSymbol)Substitute(generic, containing);
        var definition = member is IMethodSymbol method ? method.ConstructedFrom.OriginalDefinition : member.OriginalDefinition;
        var candidates = closed.GetMembers(member.Name).OfType<T>();
        if (!SymbolEqualityComparer.Default.Equals(closed.OriginalDefinition, containing.OriginalDefinition))
        {
            // A framework type the runtime has its own of (a span): the
            // member of the name and parameter types.
            return candidates.FirstOrDefault(candidate => SameSignature(candidate, member))
                ?? throw new CompileError($"'{member.ToDisplayString()}' is unsupported.");
        }

        return candidates.First(candidate => SymbolEqualityComparer.Default.Equals(
                candidate is IMethodSymbol candidateMethod
                    ? candidateMethod.ConstructedFrom.OriginalDefinition
                    : candidate.OriginalDefinition,
                definition));
    }

    // A closed instantiation of a generic source class, interface or struct.
    public static bool IsGenericInstance(ITypeSymbol? type) =>
        type is INamedTypeSymbol { IsGenericType: true } named && IsModuleDefined(named)
            && named.TypeKind != TypeKind.Delegate;

    private static int GenericDepth(ITypeSymbol type) => type switch
    {
        IArrayTypeSymbol array => 1 + GenericDepth(array.ElementType),
        INamedTypeSymbol named => 1 + Math.Max(
            named.TypeArguments.Select(GenericDepth).DefaultIfEmpty(0).Max(),
            named.ContainingType is { } containing ? GenericDepth(containing) - 1 : 0),
        _ => 1,
    };

    private void CountInstantiation(ISymbol symbol, IEnumerable<ITypeSymbol> arguments)
    {
        // With shared generics, instantiations over reference types count
        // as their canonical form, whose code they share (Frontend.SharedCode);
        // their own identities apart.
        if (!exactInstantiations.Add(symbol))
        {
            return;
        }

        if (arguments.Any(argument => GenericDepth(argument) > MaximumGenericDepth))
        {
            throw new CompileError(
                $"Generic instantiation '{symbol.ToDisplayString()}' nests type arguments more than "
                + $"{MaximumGenericDepth} levels deep; polymorphic recursion is unsupported.");
        }

        var counted = symbol switch
        {
            INamedTypeSymbol type => Canonical(type),
            IMethodSymbol method => CanonicalMember(method),
            _ => symbol,
        };
        if (!instantiated.Add(counted))
        {
            return;
        }

        if (instantiated.Count > MaximumInstantiations)
        {
            throw new CompileError($"Generic instantiation limit is {MaximumInstantiations}.");
        }
    }

    private static IEnumerable<ITypeSymbol> AllTypeArguments(INamedTypeSymbol type)
    {
        for (INamedTypeSymbol? current = type; current is not null; current = current.ContainingType)
        {
            foreach (var argument in current.TypeArguments)
            {
                yield return argument;
            }
        }
    }

    private void EnsureInstance(INamedTypeSymbol type)
    {
        if (type.TypeKind == TypeKind.Interface)
        {
            EnsureInterfaceInstance(type);
        }
        else if (type.TypeKind == TypeKind.Class)
        {
            EnsureClassInstance(type);
        }
        else if (IsStruct(type))
        {
            EnsureStruct(type);
        }
    }

    // Registers a closed generic class's identity; its members follow once
    // discovery has seen every declaration.
    private void EnsureClassInstance(INamedTypeSymbol type)
    {
        if (heapIds.ContainsKey(type) || layouts.ContainsKey(type) || membersRegistered.Contains(type))
        {
            return;
        }

        CountInstantiation(type, AllTypeArguments(type));
        if (!type.IsStatic)
        {
            RegisterClass(type);
        }

        pendingInstances.Enqueue(type);
    }

    private void EnsureInterfaceInstance(INamedTypeSymbol type)
    {
        if (interfaces.ContainsKey(type))
        {
            return;
        }

        CountInstantiation(type, AllTypeArguments(type));
        RegisterInterface(type);
        pendingInstances.Enqueue(type);
    }

    // Registers the members of the classes and interfaces instantiated so
    // far, which may instantiate more.
    private void DrainInstances()
    {
        while (pendingInstances.TryDequeue(out var type))
        {
            if (type.TypeKind == TypeKind.Interface)
            {
                RegisterImportedInterfaceMembers(type);
            }
            else
            {
                RegisterMembers(type);
            }
        }
    }

    // Makes sure a call target has a function: a member of a generic class,
    // created when first reached, or an instantiation of a generic method.
    public void EnsureMethod(IMethodSymbol method, Substitution enclosing)
    {
        if (IsGenericDispatch(method) && !method.TypeArguments.Any(ContainsTypeParameters)
            && !ContainsTypeParameters(method.ContainingType))
        {
            EnsureGenericDispatcher(method);
        }

        if (HasFunction(method) || importIds.ContainsKey(method))
        {
            return;
        }

        if (IsGenericInstance(method.ContainingType)
            || (IsOnDemandType(method.ContainingType) && method.ContainingType.TypeKind is TypeKind.Class or TypeKind.Struct))
        {
            EnsureInstance(method.ContainingType);
            DrainInstances();
        }

        if (deferredMethods.Remove(method, out var register))
        {
            register();
            return;
        }

        if (IsSurfaceBody(method))
        {
            RegisterImportedMethod(method, SubstitutionOf(method.ContainingType, method));
            return;
        }

        if (method.IsGenericMethod
            && importedGenericMethods.Contains(method.ConstructedFrom.OriginalDefinition))
        {
            CountInstantiation(method, method.TypeArguments.Concat(AllTypeArguments(method.ContainingType)));
            RegisterImportedMethod(method, SubstitutionOf(method.ContainingType, method));
            return;
        }

        // A runtime method demanded while declarations are still being
        // registered (a record's members demanding a formatter, say) may
        // not be known yet: it is ensured again in the discovery loop.
        if (!HasFunction(method) && method.ContainingType is { } owner && IsRuntimeType(owner)
            && !IsRuntimeIntrinsic(method))
        {
            pendingRuntimeMethods.Add((method, enclosing));
        }
    }

    private readonly List<(IMethodSymbol Method, Substitution Enclosing)> pendingRuntimeMethods = [];

    private void DrainPendingRuntimeMethods()
    {
        var pending = pendingRuntimeMethods.ToList();
        pendingRuntimeMethods.Clear();
        foreach (var (method, enclosing) in pending)
        {
            if (!HasFunction(method))
            {
                EnsureMethod(method, enclosing);
            }
        }
    }

    public Microsoft.CodeAnalysis.CSharp.Conversion ClassifyConversion(ITypeSymbol source, ITypeSymbol destination)
    {
        // Of the compilation alone, so for every compilation of the module.
        conversions ??= new(TypePairComparer.Instance);
        if (!conversions.TryGetValue((source, destination), out var conversion))
        {
            conversion = compilation.ClassifyConversion(source, destination);
            conversions.Add((source, destination), conversion);
        }

        return conversion;
    }

    [ThreadStatic]
    private static Dictionary<(ITypeSymbol, ITypeSymbol), Microsoft.CodeAnalysis.CSharp.Conversion>? conversions;

    private sealed class TypePairComparer : IEqualityComparer<(ITypeSymbol, ITypeSymbol)>
    {
        public static readonly TypePairComparer Instance = new();

        public bool Equals((ITypeSymbol, ITypeSymbol) left, (ITypeSymbol, ITypeSymbol) right) =>
            SymbolEqualityComparer.IncludeNullability.Equals(left.Item1, right.Item1)
            && SymbolEqualityComparer.IncludeNullability.Equals(left.Item2, right.Item2);

        public int GetHashCode((ITypeSymbol, ITypeSymbol) pair) =>
            HashCode.Combine(
                SymbolEqualityComparer.IncludeNullability.GetHashCode(pair.Item1),
                SymbolEqualityComparer.IncludeNullability.GetHashCode(pair.Item2));
    }

    // A class's parameterless instance constructor, which `new T()` runs.
    public static IMethodSymbol? DefaultConstructor(ITypeSymbol type) =>
        (type as INamedTypeSymbol)?.InstanceConstructors.FirstOrDefault(constructor => constructor.Parameters.Length == 0);
}
