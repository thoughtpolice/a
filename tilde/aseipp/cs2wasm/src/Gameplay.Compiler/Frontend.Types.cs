// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// System.Type objects (runtime/Types.cs): each type code names with typeof,
// or whose values code calls GetType on, has a function that makes its
// object on first use and keeps it in a global, so a type has one object.
// GetType on a value whose class the static type does not fix calls a
// helper that tests the object against every class, box, array type and
// string the module has, most derived first, or, where the static type is
// a class of the module's or an exception class, one that tests the
// classes deriving from it alone.
internal sealed partial class Frontend
{
    private readonly Dictionary<ITypeSymbol, int> typeObjects = new(SymbolEqualityComparer.Default);
    private readonly List<ITypeSymbol> typeObjectOrder = [];
    private int objectTypeHelper = -1;
    private int firstTypeObjectGlobal = -1;

    public INamedTypeSymbol RuntimeTypeClass => TypeNamed("Gameplay.Runtime.Type")
        ?? throw new InternalCompilerError("the runtime has no Type.");

    public IMethodSymbol RuntimeTypeConstructor => RuntimeTypeClass.InstanceConstructors.Single();

    // The function making a type's object, registered on first use with
    // its base types'.
    public void EnsureTypeObject(ITypeSymbol type)
    {
        type = FrameworkCounterpart(type);
        if (typeObjects.ContainsKey(type))
        {
            return;
        }

        if (ClrName(type) is null || ContainsTypeParameters(type) || type is INamedTypeSymbol { IsUnboundGenericType: true })
        {
            throw Error($"A Type object for '{type.ToDisplayString()}' is unsupported.");
        }

        MapType(RuntimeTypeClass);
        EnsureMethod(RuntimeTypeConstructor, Substitution.Empty);
        StringType();
        typeObjects.Add(type, methods.Count);
        typeObjectOrder.Add(type);
        methods.Add(new(
            null,
            $"<typeof> {type.ToDisplayString()}",
            [],
            MapType(RuntimeTypeClass),
            true,
            null,
            MethodPlanKind.TypeObject,
            Substitution.Empty,
            Receiver: type));
        if (BaseTypeOf(type) is { } baseType)
        {
            EnsureTypeObject(baseType);
        }
    }

    public int TypeObject(ITypeSymbol type) =>
        typeObjects.TryGetValue(FrameworkCounterpart(type), out int id)
            ? imports.Count + id
            : throw Error($"A Type object for '{type.ToDisplayString()}' was not discovered.");

    // The global a type's object is kept in (after the initialization
    // globals).
    public int TypeObjectGlobal(ITypeSymbol type) => firstTypeObjectGlobal + typeObjectOrder.IndexOf(FrameworkCounterpart(type));

    private int AssignTypeObjectGlobals(int next)
    {
        firstTypeObjectGlobal = next;
        return next + typeObjectOrder.Count;
    }

    private IEnumerable<WasmGlobal> TypeObjectGlobals() =>
        typeObjectOrder.Select(type => new WasmGlobal("typeof " + type.ToDisplayString(), MapType(RuntimeTypeClass)));

    // The framework type a runtime counterpart stands for, whose name its
    // Type object has.
    private ITypeSymbol FrameworkCounterpart(ITypeSymbol type)
    {
        if (IsRuntimeNullable(type))
        {
            return compilation.GetSpecialType(SpecialType.System_Nullable_T)
                .Construct(((INamedTypeSymbol)type).TypeArguments[0]);
        }

        if (type is INamedTypeSymbol { Name: "Index" or "Range" or "Type" or "Decimal", Arity: 0 } named && IsRuntimeType(named)
            && named.ContainingNamespace.ToDisplayString() == "Gameplay.Runtime")
        {
            return TypeNamed("System." + named.Name)!;
        }

        if (SymbolEqualityComparer.Default.Equals(type, PlainObjectType))
        {
            return compilation.GetSpecialType(SpecialType.System_Object);
        }

        return type;
    }

    // The runtime's collections and Random are sealed where the
    // framework's are not.
    private static readonly HashSet<string> UnsealedInFramework =
    [
        "System.Collections.Generic.List`1",
        "System.Collections.Generic.Dictionary`2",
        "System.Collections.Generic.HashSet`1",
        "System.Collections.Generic.Queue`1",
        "System.Random",
    ];

    public ITypeSymbol? BaseTypeOf(ITypeSymbol type) => type switch
    {
        IArrayTypeSymbol => compilation.GetSpecialType(SpecialType.System_Array),
        INamedTypeSymbol { TypeKind: TypeKind.Interface } => null,
        INamedTypeSymbol { TypeKind: TypeKind.Enum } => compilation.GetSpecialType(SpecialType.System_Enum),
        INamedTypeSymbol { TypeKind: TypeKind.Struct } => compilation.GetSpecialType(SpecialType.System_ValueType),
        INamedTypeSymbol { TypeKind: TypeKind.Delegate } => compilation.GetSpecialType(SpecialType.System_MulticastDelegate),
        INamedTypeSymbol named => named.BaseType,
        _ => null,
    };

    // A Type object's contents: its ToString text, Name, Namespace and
    // flags (see runtime/Types.cs).
    public (string Text, string Name, string? Namespace, int Flags) TypeObjectData(ITypeSymbol type)
    {
        string text = ClrName(type)!;
        var element = type;
        string suffix = "";
        while (element is IArrayTypeSymbol array)
        {
            element = array.ElementType;
            suffix += "[]";
        }

        var named = (INamedTypeSymbol)element;
        bool sealedHere = named.IsSealed
                          && !(IsRuntimeType(named.OriginalDefinition)
                               && UnsealedInFramework.Contains(
                                   named.OriginalDefinition.ContainingNamespace.ToDisplayString() + "."
                                   + named.OriginalDefinition.MetadataName));
        var outermost = named;
        while (outermost.ContainingType is { } outer)
        {
            outermost = outer;
        }

        string? space = outermost.ContainingNamespace is { IsGlobalNamespace: false } ns ? ns.ToDisplayString() : null;
        int flags = 0;
        if (type is IArrayTypeSymbol)
        {
            flags |= 16 | 2 | 64;
        }
        else
        {
            if (named.IsValueType)
            {
                flags |= 1 | 64;
            }
            else if (named.TypeKind != TypeKind.Interface)
            {
                flags |= 2;
            }

            if (named.TypeKind == TypeKind.Interface)
            {
                flags |= 4 | 128;
            }

            if (named.TypeKind == TypeKind.Enum)
            {
                flags |= 8;
            }

            if (named.SpecialType is >= SpecialType.System_Boolean and <= SpecialType.System_Double
                && named.SpecialType != SpecialType.System_Decimal)
            {
                flags |= 32;
            }

            if (sealedHere || named.IsStatic)
            {
                flags |= 64;
            }

            if ((named.IsAbstract || named.IsStatic) && named.TypeKind == TypeKind.Class)
            {
                flags |= 128;
            }

            var chain = new List<INamedTypeSymbol>();
            for (var current = named; current is not null; current = current.ContainingType)
            {
                chain.Add(current);
            }

            if (chain.Any(part => part.TypeArguments.Length != 0))
            {
                flags |= 256;
            }
        }

        return (text, named.MetadataName + suffix, space, flags);
    }

    // GetType's helpers for a value of a class that does not fix its own:
    // one per such class, telling apart only the classes deriving from it
    // (an exception's GetType needs the exceptions' type objects, not every
    // class's), made by DemandObjectTypeHelper(type).
    private readonly Dictionary<ITypeSymbol, int> classTypeHelpers = new(SymbolEqualityComparer.Default);

    // Whether GetType of a value of a type can be told from its class's
    // subclasses alone: a class of the module's (or a BCL exception) that
    // is not object, which boxes, arrays and strings are never values of.
    private bool HasClassTypeHelper(ITypeSymbol type) =>
        type is INamedTypeSymbol { TypeKind: TypeKind.Class, SpecialType: SpecialType.None } named
        && !IsObjectType(named) && (IsSourceClass(named) || IsFrameworkException(named) || IsException(named));

    public void DemandObjectTypeHelper(ITypeSymbol receiver)
    {
        if (!HasClassTypeHelper(receiver))
        {
            DemandObjectTypeHelper();
            return;
        }

        if (classTypeHelpers.ContainsKey(receiver))
        {
            return;
        }

        EnsureObjectRoot();
        classTypeHelpers.Add(receiver, methods.Count);
        methods.Add(new(
            null,
            $"<GetType of {receiver.ToDisplayString()}>",
            [WType.Ref(EqHeap)],
            MapType(RuntimeTypeClass),
            true,
            null,
            MethodPlanKind.ObjectType,
            Substitution.Empty,
            Receiver: receiver));
    }

    public int ObjectTypeHelperOf(ITypeSymbol receiver) =>
        classTypeHelpers.TryGetValue(receiver, out int id) ? imports.Count + id : ObjectTypeHelper;

    // GetType's helper for a value of a type that does not fix its class.
    public void DemandObjectTypeHelper()
    {
        if (objectTypeHelper >= 0)
        {
            return;
        }

        objectValues = true;
        EnsureObjectRoot();
        EnsureTypeObject(compilation.GetSpecialType(SpecialType.System_Object));
        objectTypeHelper = methods.Count;
        methods.Add(new(
            null,
            "<object GetType>",
            [WType.Ref(EqHeap)],
            MapType(RuntimeTypeClass),
            true,
            null,
            MethodPlanKind.ObjectType,
            Substitution.Empty));
    }

    public int ObjectTypeHelper => imports.Count + objectTypeHelper;

    // The types the helper tells apart, once discovery is over: every
    // class, box, array and string, given objects.
    private void FinishTypeObjects()
    {
        if (objectTypeHelper >= 0)
        {
            foreach (var (type, _) in ObjectTypeCandidates())
            {
                EnsureTypeObject(type);
            }
        }

        foreach (var receiver in classTypeHelpers.Keys)
        {
            foreach (var (type, _) in ObjectTypeCandidates(receiver))
            {
                EnsureTypeObject(type);
            }
        }
    }

    // The heaps an object of a class may be: the classes deriving from it
    // (and it), most derived first.
    public List<(ITypeSymbol Type, int Heap)> ObjectTypeCandidates(ITypeSymbol receiver) =>
        ObjectTypeCandidates().Where(candidate => candidate.Type is INamedTypeSymbol { TypeKind: TypeKind.Class } named
                                                  && DerivesFrom(named, receiver)).ToList();

    private static bool DerivesFrom(INamedTypeSymbol type, ITypeSymbol ancestor)
    {
        for (INamedTypeSymbol? current = type; current is not null; current = current.BaseType)
        {
            if (SymbolEqualityComparer.Default.Equals(current, ancestor))
            {
                return true;
            }
        }

        return false;
    }

    // The heaps an object's class may be, with the type each stands for,
    // most derived first.
    public List<(ITypeSymbol Type, int Heap)> ObjectTypeCandidates()
    {
        var candidates = new List<(ITypeSymbol, int)>();
        // Depth counts every base class, not only source ones: an exception
        // class of the module's is tested before the BCL's it derives from.
        static int BaseCount(INamedTypeSymbol type)
        {
            int count = 0;
            for (var current = type.BaseType; current is not null; current = current.BaseType)
            {
                count++;
            }

            return count;
        }

        foreach (var layout in layouts.Values.Where(layout => !layout.Symbol.IsAbstract)
                     .OrderByDescending(layout => BaseCount(layout.Symbol)))
        {
            candidates.Add((layout.Symbol, layout.Heap));
        }

        foreach (var box in boxes.Values)
        {
            candidates.Add((box.Symbol, box.Heap));
        }

        foreach (var entry in heapIds.Where(entry => entry.Key is IArrayTypeSymbol array && ClrName(entry.Key) is not null && Escapes(array)))
        {
            candidates.Add((entry.Key, entry.Value));
        }

        if (stringHeap >= 0)
        {
            candidates.Add((compilation.GetSpecialType(SpecialType.System_String), stringHeap));
        }

        return candidates;
    }

    // Whether a value of a type has a class the type fixes: a value type,
    // a sealed class, a string or an array.
    public static bool FixesClass(ITypeSymbol type) =>
        type.IsValueType || type is IArrayTypeSymbol || type.SpecialType == SpecialType.System_String
        || type is INamedTypeSymbol { TypeKind: TypeKind.Class, IsSealed: true };
}
