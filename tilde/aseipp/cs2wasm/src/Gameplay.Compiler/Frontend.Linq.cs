// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The default order (Comparer<T>.Default): numbers, chars, bools and enums
// by value, types implementing IComparable<T> (a class, of a base's by
// contravariance) by their CompareTo (a null reference first), types
// implementing the non-generic IComparable alone by its CompareTo(object)
// (ObjectComparer: a reference equal to itself, then a null first), and
// nullables of any of them by their values (NullableComparer: no value
// first). Strings and other types have none here (the
// CLR's orders strings by culture): runtime code instantiated over one
// throws NotSupportedException where it would order, and the calls in
// source code that would order that way are rejected where they are made.
internal sealed partial class Frontend
{
    // The CompareTo a type's default order calls, if it is not a scalar:
    // its IComparable<T>'s, or, as IComparable<in T> is contravariant, a
    // class's IComparable<Base> for a base class or interface it converts
    // to (the CLR's GenericComparer<T> is chosen for either).
    public IMethodSymbol? ComparableCompareTo(ITypeSymbol type) =>
        ComparableMember(type) is { } member
            ? ((INamedTypeSymbol)type).FindImplementationForInterfaceMember(member) as IMethodSymbol
            : null;

    // The IComparable<T>.CompareTo (of T, or of a base) that
    // ComparableCompareTo implements.
    public IMethodSymbol? ComparableMember(ITypeSymbol type)
    {
        if (type is not INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Struct } named
            || type.SpecialType == SpecialType.System_String)
        {
            return null;
        }

        var comparables = named.AllInterfaces
            .Where(candidate => FullName(candidate.OriginalDefinition) == "System.IComparable`1")
            .ToList();
        var comparable = comparables.FirstOrDefault(candidate => SymbolEqualityComparer.Default.Equals(candidate.TypeArguments[0], type))
            ?? (named.TypeKind == TypeKind.Class
                ? comparables.FirstOrDefault(candidate =>
                    candidate.TypeArguments[0] is INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Interface } wider
                    && DerivesFrom(named, wider))
                : null);
        return comparable?.GetMembers("CompareTo").OfType<IMethodSymbol>().SingleOrDefault();
    }

    // The CompareTo(object) of a class or struct implementing the
    // non-generic IComparable alone, which the CLR's ObjectComparer<T>
    // (System.Collections.Comparer.Default) calls on the left, the right
    // boxed.
    public IMethodSymbol? ObjectCompareTo(ITypeSymbol type) =>
        ObjectComparableMember(type) is { } member
            ? ((INamedTypeSymbol)type).FindImplementationForInterfaceMember(member) as IMethodSymbol
            : null;

    // IComparable.CompareTo, of a type ObjectCompareTo implements it for.
    public IMethodSymbol? ObjectComparableMember(ITypeSymbol type) =>
        type is INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Struct } named
        && type.SpecialType != SpecialType.System_String && ComparableCompareTo(type) is null
        && named.AllInterfaces.FirstOrDefault(candidate => FullName(candidate) == "System.IComparable") is { } comparable
            ? comparable.GetMembers("CompareTo").OfType<IMethodSymbol>().SingleOrDefault()
            : null;

    // Numbers, chars, bools and enums, IComparable<T> types, types of
    // IComparable alone, and nullables of any of them.
    public bool HasDefaultOrder(ITypeSymbol type) =>
        ScalarOf(type) is not null || ComparableCompareTo(type) is not null || ObjectCompareTo(type) is not null
        || (IsRuntimeNullable(type) && HasDefaultOrder(((INamedTypeSymbol)type).TypeArguments[0]));

    // Whether the CLR sorts arrays of a type by its default comparer's
    // Compare (ArraySortHelper<T>) rather than by its values' own order
    // (GenericArraySortHelper<T>, of the types implementing IComparable<T>):
    // a nullable (NullableComparer) and a type of IComparable alone
    // (ObjectComparer).
    public bool SortsByComparer(ITypeSymbol type) =>
        ScalarOf(type) is null && ComparableCompareTo(type) is null && HasDefaultOrder(type);

    // What an ordering intrinsic over a type needs.
    private void DemandOrdering(ITypeSymbol type)
    {
        if (ScalarOf(type) is not null)
        {
            return;
        }

        if (IsRuntimeNullable(type))
        {
            MapType(type);
            DemandOrdering(((INamedTypeSymbol)type).TypeArguments[0]);
        }
        else if (ComparableCompareTo(type) is { } compareTo)
        {
            EnsureMethod(compareTo, Substitution.Empty);
            DemandReimplementations(type, ComparableMember(type)!);
        }
        else if (ObjectCompareTo(type) is { } objectCompareTo)
        {
            EnsureMethod(objectCompareTo, Substitution.Empty);
            DemandReimplementations(type, ObjectComparableMember(type)!);
            if (type.IsValueType)
            {
                EnsureBox(type);
            }
        }
        else
        {
            EnsureRuntimeMethod("Ordering", "Unsupported", 0);
        }
    }

    // Why a call cannot be made (the user's calls are checked with it), or
    // null.
    public string? DefaultOrderingError(IMethodSymbol method, Substitution? generic = null)
    {
        var type = method.ContainingType;
        string owner = type is null ? "" : FullName(type.OriginalDefinition);
        int parameters = method.Parameters.Length;
        ITypeSymbol? key = (owner, method.Name) switch
        {
            ("System.Linq.Enumerable", "OrderBy" or "OrderByDescending" or "ThenBy" or "ThenByDescending" or "MinBy" or "MaxBy")
                when parameters == 2 => method.TypeArguments[1],
            ("System.Linq.Enumerable", "Order" or "OrderDescending") when parameters == 1 => method.TypeArguments[0],
            ("System.Linq.Enumerable", "Min" or "Max") when method is { Arity: 1, Parameters.Length: 1 } => method.TypeArguments[0],
            ("System.Collections.Generic.List`1", "Sort") when parameters == 0 => type!.TypeArguments[0],
            ("System.Collections.Generic.List`1", "BinarySearch") when parameters == 1 => type!.TypeArguments[0],
            ("System.Array", "Sort") when method.IsGenericMethod && method.Parameters.All(p => p.Type.Name != "Comparison" && p.Type.Name != "IComparer")
                => method.TypeArguments[0],
            ("System.Array", "BinarySearch") when method.IsGenericMethod && method.Parameters.All(p => p.Type.Name != "IComparer")
                => method.TypeArguments[0],
            ("System.Collections.Generic.Comparer`1", "get_Default") => type!.TypeArguments[0],
            ("System.Collections.Generic.SortedDictionary`2" or "System.Collections.Generic.SortedList`2", ".ctor")
                when !method.Parameters.Any(p => p.Type.Name == "IComparer") => type!.TypeArguments[0],
            ("System.Collections.Generic.SortedSet`1", ".ctor") when !method.Parameters.Any(p => p.Type.Name == "IComparer")
                => type!.TypeArguments[0],
            ("System.Collections.Generic.PriorityQueue`2", ".ctor") when !method.Parameters.Any(p => p.Type.Name == "IComparer")
                => type!.TypeArguments[1],
            _ => null,
        };
        if (key is not null && generic is { IsEmpty: false })
        {
            key = Substitute(generic, key);
        }

        if (key is not null && key.TypeKind != TypeKind.TypeParameter && !HasDefaultOrder(key))
        {
            return $"'{method.ToDisplayString()}' orders by the default comparer, which '{key.ToDisplayString()}' does not have here "
                + "(numbers, chars, bools, enums, IComparable<T> and IComparable types and their nullables; strings compare by "
                + "culture on the CLR); pass a "
                + "comparer or Comparison, such as StringComparer.Ordinal.";
        }

        return null;
    }
}
