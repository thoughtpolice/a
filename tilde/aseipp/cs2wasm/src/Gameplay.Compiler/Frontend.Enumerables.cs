// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The framework interfaces the module adopts as its own: IDisposable, the
// non-generic IEnumerator, and IEnumerable<T> and IEnumerator<T>. Classes
// and structs, the runtime's collections among them, implement them with
// itables like any source interface's, laid out from the framework's
// members. An IEnumerable<T> value may also be an array (or, of chars, a
// string), as in the CLR, so its values are any references, and its
// GetEnumerator tests for those first.
internal sealed partial class Frontend
{
    // Whether the module adopts them: discovery starts again with them
    // once it meets one, so a module without enumerables keeps its
    // classes (the runtime's collections among them) without itables.
    private readonly bool adoptEnumerables;

    private sealed class EnumerablesFound : Exception;

    public static bool IsAdoptedInterface(ITypeSymbol? type) =>
        type is INamedTypeSymbol { TypeKind: TypeKind.Interface } named
        && (FullName(named.OriginalDefinition) is "System.IDisposable" or "System.Collections.IEnumerator"
                or "System.Collections.Generic.IEnumerable`1" or "System.Collections.Generic.IEnumerator`1"
                or "System.Collections.Generic.IComparer`1" or "System.Collections.Generic.IEqualityComparer`1"
                or "System.IComparable`1"
            || IsCollectionInterface(named) || IsLazilyAdopted(named));

    // The interfaces adopted only once code names them as types
    // (IComparable<int> x = 5): IEquatable<T> and the non-generic
    // IComparable, which so many types implement that itables of them
    // everywhere would cost more than they give, and the interfaces of
    // await and async enumeration (the task library's awaiters and state
    // machines implement them, and C#'s lowering calls them on type
    // parameters, directly).
    public static bool IsLazilyAdopted(INamedTypeSymbol type) =>
        FullName(type.OriginalDefinition) is "System.IEquatable`1" or "System.IComparable"
            or "System.Runtime.CompilerServices.IAsyncStateMachine" or "System.Runtime.CompilerServices.INotifyCompletion"
            or "System.Runtime.CompilerServices.ICriticalNotifyCompletion"
            or "System.Threading.Tasks.Sources.IValueTaskSource" or "System.Threading.Tasks.Sources.IValueTaskSource`1"
            or "System.IAsyncDisposable" or "System.Collections.Generic.IAsyncEnumerable`1"
            or "System.Collections.Generic.IAsyncEnumerator`1";

    // The collection interfaces the CoreLib's collections implement as
    // .NET's do; arrays do not (see FunctionEmitter.Coerce). And the rest
    // of .NET's collection interfaces (the non-generic ICollection, ISet<T>,
    // IDictionary<TKey, TValue>...), which the imported framework
    // assemblies' collections implement and test for.
    public static bool IsCollectionInterface(INamedTypeSymbol type) =>
        FullName(type.OriginalDefinition) is "System.Collections.Generic.ICollection`1" or "System.Collections.Generic.IList`1"
            or "System.Collections.Generic.IReadOnlyCollection`1" or "System.Collections.Generic.IReadOnlyList`1"
        || (InCoreLibrary(type) && IsSurfaceType(type)
            && type.ContainingNamespace?.ToDisplayString() is "System.Collections" or "System.Collections.Generic");

    // IEnumerable<T>: arrays and strings are ones too.
    public static bool IsEnumerableInterface(ITypeSymbol? type) =>
        type is INamedTypeSymbol { TypeKind: TypeKind.Interface } named
        && FullName(named.OriginalDefinition) == "System.Collections.Generic.IEnumerable`1";

    // An interface the CLR gives one-dimensional arrays: IEnumerable<T>,
    // and the generic collection interfaces too, whose values
    // are then any references, and whose members an array runs as
    // ArrayImplementation says.
    public static bool IsArrayInterface(ITypeSymbol? type) =>
        IsEnumerableInterface(type)
        || (type is INamedTypeSymbol { TypeKind: TypeKind.Interface } named
            && FullName(named.OriginalDefinition) is "System.Collections.Generic.ICollection`1" or "System.Collections.Generic.IList`1"
                or "System.Collections.Generic.IReadOnlyCollection`1" or "System.Collections.Generic.IReadOnlyList`1")
        || IsObjectArrayInterface(type);

    // The non-generic IEnumerable, ICollection and IList, which
    // any array is, whatever its elements, and a string an IEnumerable.
    public static bool IsObjectArrayInterface(ITypeSymbol? type) =>
        type is INamedTypeSymbol { TypeKind: TypeKind.Interface } named
        && FullName(named) is "System.Collections.IEnumerable" or "System.Collections.ICollection" or "System.Collections.IList";

    // The CoreLib's method (corelib/ArrayCollections.cs) an array of any
    // element type runs for a member of the non-generic interfaces, by
    // name; the module's array types each have their own (see
    // DrainObjectArrayMembers).
    public static string? ObjectArrayHelper(IMethodSymbol member) =>
        !IsObjectArrayInterface(member.ContainingType)
            ? null
            : (member.ContainingType.Name, member.Name) switch
            {
                ("IEnumerable", "GetEnumerator") => "ObjectGetEnumerator",
                ("ICollection", "get_Count") => "ObjectCount",
                ("IList", "get_Item") => "ObjectGetItem",
                ("IList", "set_Item") => "ObjectSetItem",
                ("IList", "get_IsReadOnly") => "ObjectIsReadOnly",
                ("IList", "get_IsFixedSize") => "ObjectIsFixedSize",
                ("IList", "IndexOf" or "Contains" or "Clear" or "Add" or "Insert" or "Remove" or "RemoveAt") => "Object" + member.Name,
                _ => null,
            };

    private readonly HashSet<string> objectArrayMembers = [];
    private readonly HashSet<(string Helper, ITypeSymbol Element)> objectArrayHelpers = [];

    public IMethodSymbol ObjectArrayMethod(string helper, ITypeSymbol element) =>
        TypeNamed("Gameplay.Runtime.ArrayCollections")!.GetMembers(helper).OfType<IMethodSymbol>().Single().Construct(element);

    // The one-dimensional array types of the module, by element type.
    public IEnumerable<IArrayTypeSymbol> ArrayTypes() =>
        heapIds.Keys.OfType<IArrayTypeSymbol>().Where(array => array.IsSZArray && Escapes(array)).ToList();

    // Each non-generic member code calls, for each array type: its
    // element type's method, as more array types turn up.
    private void DrainObjectArrayMembers()
    {
        foreach (string helper in objectArrayMembers)
        {
            foreach (var array in ArrayTypes())
            {
                if (objectArrayHelpers.Add((helper, array.ElementType)))
                {
                    EnsureMethod(ObjectArrayMethod(helper, array.ElementType), Substitution.Empty);
                }
            }
        }

        if (objectArrayMembers.Contains("ObjectGetEnumerator") && stringHeap >= 0)
        {
            EnsureRuntimeMethod("Enumerables", "OfString", 1);
        }
    }

    // The module's one-dimensional array types an array interface of an
    // element type may be: arrays of it, and of the reference
    // types that convert to it (array covariance: a Bird[] is an
    // IEnumerable<Animal>).
    public List<IArrayTypeSymbol> ArraysConvertingTo(ITypeSymbol element) =>
        [.. heapIds.Keys.OfType<IArrayTypeSymbol>().Where(array => array.IsSZArray && Escapes(array)
            && (SymbolEqualityComparer.Default.Equals(array.ElementType, element)
                || (element.IsReferenceType && array.ElementType.IsReferenceType
                    && ClassifyConversion(array.ElementType, element) is { IsImplicit: true, IsReference: true })))];

    // What a member of a collection interface of E runs on an array of X:
    // ArrayImplementation's method for arrays of E, the covariant one of X
    // and E for the others.
    public IMethodSymbol? ArrayMember(IMethodSymbol member, IArrayTypeSymbol array)
    {
        var element = ((INamedTypeSymbol)member.ContainingType).TypeArguments[0];
        if (SymbolEqualityComparer.Default.Equals(array.ElementType, element))
        {
            return ArrayImplementation(member);
        }

        string? name = ArrayImplementation(member)?.Name;
        return name is null || TypeNamed("Gameplay.Runtime.CovariantArrayCollections") is not { } helpers
            ? null
            : helpers.GetMembers("Covariant" + name).OfType<IMethodSymbol>().Single().Construct(array.ElementType, element);
    }

    private readonly HashSet<ITypeSymbol> enumerableElements = new(SymbolEqualityComparer.Default);
    private readonly HashSet<IMethodSymbol> arrayMembers = new(SymbolEqualityComparer.Default);
    private readonly HashSet<(ISymbol, ITypeSymbol)> covariantArrayMethods = [];

    // What the array interfaces code uses need for each array type that
    // may be one by covariance, as array types turn up.
    private void DrainCovariantArrays()
    {
        foreach (var element in enumerableElements)
        {
            foreach (var array in ArraysConvertingTo(element))
            {
                if (covariantArrayMethods.Add((element, array)))
                {
                    EnsureMethod(RuntimeMethod("Enumerables", "OfArray", 1).Construct(array.ElementType), Substitution.Empty);
                }
            }
        }

        foreach (var member in arrayMembers.ToList())
        {
            foreach (var array in ArraysConvertingTo(((INamedTypeSymbol)member.ContainingType).TypeArguments[0]))
            {
                if (covariantArrayMethods.Add((member, array)) && ArrayMember(member, array) is { } method)
                {
                    EnsureMethod(method, Substitution.Empty);
                }
            }
        }
    }

    // What a member of one of the collection interfaces runs on an array:
    // the CoreLib's (corelib/ArrayCollections.cs), over the element type.
    public IMethodSymbol? ArrayImplementation(IMethodSymbol member)
    {
        if (member.ContainingType is not INamedTypeSymbol face || !IsArrayInterface(face) || IsEnumerableInterface(face)
            || IsObjectArrayInterface(face) || TypeNamed("Gameplay.Runtime.ArrayCollections") is not { } helpers)
        {
            return null;
        }

        string name = member.Name switch
        {
            "get_Count" => "Count",
            "get_Item" => "GetItem",
            "set_Item" => "SetItem",
            "get_IsReadOnly" => "IsReadOnly",
            var other => other,
        };
        return helpers.GetMembers(name).OfType<IMethodSymbol>()
            .FirstOrDefault(candidate => candidate.Parameters.Length == member.Parameters.Length + 1)
            ?.Construct(face.TypeArguments[0]);
    }

    // An interface with an itable: a source one, or an adopted one.
    private bool IsModuleInterface(INamedTypeSymbol type) =>
        IsSourceInterface(type) || (adoptEnumerables && IsAdoptedInterface(type));

    // An adopted interface's layout, its members in declaration order.
    private void EnsureAdoptedInterface(INamedTypeSymbol type)
    {
        if (interfaces.ContainsKey(type))
        {
            return;
        }

        if (!adoptEnumerables)
        {
            throw new EnumerablesFound();
        }

        EnsureObjectRoot();
        var layout = new InterfaceLayout(type, interfaces.Count, ITableType(type));
        interfaces.Add(type, layout);
        interfaceOrder.Add(type);
        if (IsEnumerableInterface(type))
        {
            EnsureEnumerableSources(type);
        }

        foreach (var baseInterface in type.Interfaces.Where(candidate => IsAdoptedInterface(candidate) && !IsLazilyAdopted(candidate)))
        {
            EnsureAdoptedInterface(baseInterface);
        }

        foreach (var member in type.GetMembers())
        {
            var accessors = member switch
            {
                IMethodSymbol { MethodKind: MethodKind.Ordinary } method => [method],
                IPropertySymbol property => new[] { property.GetMethod, property.SetMethod }.OfType<IMethodSymbol>(),
                _ => [],
            };
            foreach (var method in accessors.Where(method => method.IsAbstract && !method.IsStatic))
            {
                int signature;
                try
                {
                    // Of the canonical form's shape (Frontend.Sharing).
                    var shaped = CanonicalMember(method);
                    signature = SignatureType(
                        [WType.Ref(objectHeap), .. shaped.Parameters.Select(ParameterType)],
                        MapType(shaped.ReturnType));
                }
                catch (CompileError) when (IsCollectionInterface(type) && IsSurfaceType(type))
                {
                    // A member of .NET's collection interfaces this
                    // representation has no signature for (ICollection's
                    // CopyTo(Array, int)): no slot, an error where code
                    // calls it.
                    continue;
                }

                layout.Members.Add(method);
                layout.MemberTypes.Add(signature);
            }
        }
    }

    private readonly List<INamedTypeSymbol> pendingEnumerables = [];

    // What IEnumerable<T>.GetEnumerator needs for arrays and strings: the
    // runtime's enumerators of them, registered with the discovery loop's
    // next round.
    private void EnsureEnumerableSources(INamedTypeSymbol enumerable) => pendingEnumerables.Add(enumerable);

    private void DrainEnumerableSources()
    {
        foreach (var enumerable in pendingEnumerables.ToList())
        {
            var element = enumerable.TypeArguments[0];
            // The enumerators of the arrays code converts to it
            // (DrainCovariantArrays; Frontend.ClosedWorld).
            enumerableElements.Add(element);
            MapType(ArrayOf(element));

            if (element.SpecialType == SpecialType.System_Char)
            {
                StringType();
                EnsureMethod(RuntimeMethod("Enumerables", "OfString", 1), Substitution.Empty);
            }
        }

        pendingEnumerables.Clear();
    }
}
