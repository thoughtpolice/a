// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Managed references (`ref` and `out` parameters, ref locals and ref
// returns). A reference to a struct is its box: a struct in the heap always
// has one. A reference to anything else is a `$ref` struct of its type:
// the cell of a variable (a cell is a `$ref`), or a handle naming storage
// that has no cell, an array element (the array and index) or a field (the
// object, or none for a static field, and the field's number among the
// fields of that type code takes references to). Reading or writing through
// a reference whose type has handles goes through the type's load and
// store functions, which tell a cell from a handle; without handles it is a
// cell.
internal sealed partial class Frontend
{
    private readonly Dictionary<WType, int> referenceBases = [];
    private readonly Dictionary<WType, int> handles = [];
    // Per type, the fields references are taken to, by number.
    // Storage by reference: fields, and field-like events (their own
    // storage, see Frontend.Import).
    private readonly Dictionary<WType, List<ISymbol>> referencedFields = [];
    private readonly Dictionary<WType, (int Load, int Store)> referenceHelpers = [];

    // The type of a reference to a value of this type: a struct's box, or
    // the `$ref` of anything else.
    public WType RefParameterType(ITypeSymbol type)
    {
        var mapped = MapType(type);
        return mapped.IsTuple ? WType.Ref(StructOf(mapped).Box) : WType.Ref(ReferenceBase(mapped));
    }

    // The `$ref` supertype of a type's cell and handle.
    public int ReferenceBase(WType type)
    {
        CellHeap(type);
        return referenceBases[ReferenceKey(type)];
    }

    // With shared generics, a reference to a reference of any type is one
    // to an eqref: a shared instantiation's `ref T` is any of them, and a
    // read through one casts (Frontend.Sharing).
    public WType ReferenceKey(WType type) => sharing && type.IsRef ? WType.Ref(EqHeap) : type;

    public int HandleHeap(WType type)
    {
        type = ReferenceKey(type);
        if (!handles.TryGetValue(type, out int heap))
        {
            heap = AddType(TypeDefinition.Struct(
                "handle",
                [new(WType.Ref(EqHeap), Mutable: false), new(WType.I32, Mutable: false)],
                ReferenceBase(type)));
            handles.Add(type, heap);
            EnsureReferenceHelpers(type);
        }

        return heap;
    }

    public bool HasHandles(WType type) => handles.ContainsKey(ReferenceKey(type));

    // The array heaps whose elements are of a type; with shared generics,
    // every array of references is the family's.
    public List<int> ArrayHeapsOf(WType type) => sharing && type.IsRef
        ? refArrayHeap >= 0 ? [refArrayHeap] : []
        : heapIds
            .Where(entry => entry.Key is IArrayTypeSymbol array && MapType(array.ElementType) == type)
            .Select(entry => entry.Value)
            .ToList();

    // The heap type of a type's objects (an array's, a string's, a box's
    // or a class's), and those of the module's classes deriving from it;
    // null when the module has none of its objects.
    public (int Own, List<int> Derived)? ExactHeaps(ITypeSymbol type)
    {
        if (type.SpecialType == SpecialType.System_String)
        {
            return stringHeap >= 0 ? (stringHeap, []) : null;
        }

        if (type.IsValueType)
        {
            return TryBox(type, out var box) ? (box.Heap, []) : null;
        }

        if (UsesRepresentation(type) || !heapIds.TryGetValue(type, out int heap))
        {
            // A shared class without a layout has no objects.
            return null;
        }

        var derived = type is INamedTypeSymbol named
            ? layouts.Values.Where(layout => !layout.IsBox && !SymbolEqualityComparer.Default.Equals(layout.Symbol, named)
                                             && DerivesFrom(layout.Symbol, named))
                .Select(layout => layout.Heap).Distinct().ToList()
            : [];
        return (heap, derived);
    }

    // The heaps of the module's one-dimensional array types whose elements
    // convert to a type by identity or by reference (array covariance).
    public List<int> ArrayHeapsConvertingTo(ITypeSymbol element) => heapIds
        .Where(entry => entry.Key is IArrayTypeSymbol { IsSZArray: true } array && Escapes(array)
                        && (SymbolEqualityComparer.Default.Equals(array.ElementType, element)
                            || (array.ElementType.IsReferenceType
                                && ClassifyConversion(array.ElementType, element) is { IsImplicit: true, IsReference: true })))
        .Select(entry => entry.Value)
        .Distinct()
        .ToList();

    // The number of a field references are taken to, among its type's.
    public int ReferencedField(ISymbol field)
    {
        var type = ReferenceKey(MapType(StorageType(field)));
        var fields = referencedFields[type];
        int index = fields.FindIndex(candidate => SymbolEqualityComparer.Default.Equals(candidate, field));
        return index >= 0 ? index : throw new InternalCompilerError($"no reference to '{field.ToDisplayString()}' was discovered.");
    }

    public IReadOnlyList<ISymbol> ReferencedFields(WType type) =>
        referencedFields.TryGetValue(ReferenceKey(type), out var fields) ? fields : [];

    public (int Load, int Store) ReferenceHelpers(WType type) =>
        (imports.Count + referenceHelpers[ReferenceKey(type)].Load, imports.Count + referenceHelpers[ReferenceKey(type)].Store);

    private void EnsureReferenceHelpers(WType type)
    {
        if (referenceHelpers.ContainsKey(type))
        {
            return;
        }

        var reference = WType.Ref(ReferenceBase(type));
        int load = methods.Count;
        methods.Add(new(null, "<ref load>", [reference], type, true, null, MethodPlanKind.ReferenceLoad, Substitution.Empty));
        int store = methods.Count;
        methods.Add(new(
            null, "<ref store>", [reference, type], WType.Void, true, null, MethodPlanKind.ReferenceStore,
            Substitution.Empty));
        referenceHelpers.Add(type, (load, store));
    }
}
