// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// A source struct: its instance fields in layout order, the flattened value
// (one Wasm value per scalar or reference leaf, nested structs expanded in
// place), and its box, the GC struct that holds one in the heap.
internal sealed class StructLayout(INamedTypeSymbol symbol, int index)
{
    public INamedTypeSymbol Symbol { get; } = symbol;

    public int Index { get; } = index;

    public WType Type => WType.Tuple(Index);

    public List<IFieldSymbol> Fields { get; } = [];

    public WType[] Leaves { get; set; } = [];

    // The first leaf of each field, by field position.
    public int[] Offsets { get; set; } = [];

    public int Box { get; set; } = -1;

    public bool Complete { get; set; }
}

// Structs. A struct value is flattened wherever it is a value: in Wasm
// locals, parameters and results, one per leaf, so copying it copies the
// leaves and nothing is shared. A struct that lives in the heap (a field of a
// class, an array element, a static field, or a local whose address is
// taken) lives in a box: a
// mutable GC struct of its fields, whose nested structs are boxes of their
// own, allocated with the storage and never shared between two storage
// locations. Assigning to such a location writes the leaves into its box,
// so value semantics hold; a method that may mutate `this` takes the box,
// so it mutates the storage itself, as a CLR managed pointer would.
internal sealed partial class Frontend
{
    private readonly Dictionary<INamedTypeSymbol, StructLayout> structs = new(SymbolEqualityComparer.Default);
    private readonly List<StructLayout> structLayouts = [];
    private readonly Dictionary<WType, int> cells = [];
    // The function of each struct method that takes `this` as a box; the
    // one in methodIds (readonly members only) takes it flattened.
    private readonly Dictionary<IMethodSymbol, int> boxMethodIds = new(SymbolEqualityComparer.Default);

    public static bool IsStruct(ITypeSymbol? type) =>
        type is INamedTypeSymbol { TypeKind: TypeKind.Struct } named && IsModuleDefined(named);

    // A tuple type as the runtime's ValueTuple it stands for, element names
    // dropped.
    public static ITypeSymbol? Untupled(ITypeSymbol? type) =>
        type is INamedTypeSymbol { IsTupleType: true, TupleUnderlyingType: { } underlying } ? underlying : type;

    // Members of readonly structs, and readonly members, never write `this`.
    public static bool IsReadOnlyMember(IMethodSymbol method) =>
        method.IsReadOnly || method.ContainingType.IsReadOnly;

    public StructLayout StructOf(WType type) => type.IsTuple
        ? structLayouts[type.Heap]
        : throw new InternalCompilerError("not a struct type.");

    public StructLayout StructOf(ITypeSymbol type) => EnsureStruct((INamedTypeSymbol)type);

    // The Wasm values a value of this type takes: none for void, the leaves
    // of a struct, or itself.
    public WType[] Leaves(WType type) => type == WType.Void
        ? []
        : type.IsTuple ? StructOf(type).Leaves : [type];

    private StructLayout EnsureStruct(INamedTypeSymbol type)
    {
        type = (INamedTypeSymbol)Untupled(type)!;
        if (sharing && IsSharedInstance(type))
        {
            // Laid out as its canonical form (Frontend.Sharing); its own
            // members are registered for it.
            if (!frozen && sharedStructs.Add(type))
            {
                CountInstantiation(type, AllTypeArguments(type));
                pendingInstances.Enqueue(type);
            }

            return EnsureStruct(Canonical(type));
        }

        if (structs.TryGetValue(type, out var layout))
        {
            if (!layout.Complete)
            {
                throw new CompileError($"Struct '{type.ToDisplayString()}' contains itself.");
            }

            return layout;
        }

        if (frozen)
        {
            throw new InternalCompilerError($"struct '{type.ToDisplayString()}' was not discovered.");
        }

        if (IsGenericInstance(type))
        {
            CountInstantiation(type, AllTypeArguments(type));
            pendingInstances.Enqueue(type);
        }
        else if (IsRuntimeType(type) && IsOnDemandType(type))
        {
            pendingInstances.Enqueue(type);
        }

        layout = new StructLayout(type, structLayouts.Count);
        structs.Add(type, layout);
        structLayouts.Add(layout);
        var leaves = new List<WType>();
        var offsets = new List<int>();
        var boxFields = new List<WField>();
        foreach (var field in type.GetMembers().OfType<IFieldSymbol>().Where(field => !field.IsStatic && !field.IsConst))
        {
            if (field.IsVolatile || field.IsFixedSizeBuffer || field.RefKind != RefKind.None)
            {
                throw new CompileError($"Field '{field.ToDisplayString()}' of a struct must be an ordinary field.");
            }

            var fieldType = MapType(field.Type);
            layout.Fields.Add(field);
            offsets.Add(leaves.Count);
            leaves.AddRange(Leaves(fieldType));
            boxFields.Add(StorageField(field.Type, mutable: true));
        }

        layout.Leaves = leaves.ToArray();
        layout.Offsets = offsets.ToArray();
        layout.Box = SharedBox(type, boxFields) ?? AddType(TypeDefinition.Struct("box " + type.ToDisplayString(), boxFields.ToArray()));
        layout.Complete = true;
        return layout;
    }

    // The box of the struct a CoreLib struct marked
    // [Gameplay.Runtime.SameLayout(typeof(S))] shares with S, whose fields
    // it has: a reference to one is a reference to the other, as
    // Unsafe.As between them is in the CLR (a matrix and its Impl,
    // corelib/Numerics.cs).
    private int? SharedBox(INamedTypeSymbol type, List<WField> boxFields)
    {
        if (!InCoreLibrary(type)
            || type.GetAttributes().FirstOrDefault(attribute =>
                    attribute.AttributeClass is { Name: "SameLayoutAttribute", ContainingNamespace: { Name: "Runtime", ContainingNamespace.Name: "Gameplay" } })
                is not { ConstructorArguments: [{ Value: INamedTypeSymbol other }] })
        {
            return null;
        }

        var shared = EnsureStruct(other);
        var definition = types[shared.Box];
        if (definition is null || !definition.Fields.AsSpan().SequenceEqual(boxFields.ToArray()))
        {
            throw new InternalCompilerError($"'{type.ToDisplayString()}' is not laid out as '{other.ToDisplayString()}'.");
        }

        return shared.Box;
    }

    public int FieldPosition(StructLayout layout, IFieldSymbol field)
    {
        if (IsSharedInstance(field.ContainingType))
        {
            field = CanonicalMember(field);
        }

        // A tuple's element, named or not, is its ItemN field.
        int position = layout.Symbol.IsTupleType
            ? layout.Fields.FindIndex(candidate => candidate.Name == (field.CorrespondingTupleField ?? field).Name)
            : layout.Fields.FindIndex(candidate => SymbolEqualityComparer.Default.Equals(candidate, field));
        return position >= 0 ? position : throw new InternalCompilerError($"field '{field.ToDisplayString()}' has no slot.");
    }

    // How a value of this type is held in a heap field or array element: a
    // struct by its box, which the storage owns (a non-null immutable
    // reference, except in arrays, which start out null and are filled);
    // anything else as itself.
    public WField StorageField(ITypeSymbol type, bool mutable = true, bool nullable = false)
    {
        var mapped = MapType(type);
        if (!mapped.IsTuple)
        {
            return new(mapped, mutable);
        }

        int box = StructOf(mapped).Box;
        return nullable ? new(WType.Ref(box), Mutable: true) : new(WType.NonNullRef(box), Mutable: false);
    }

    // The reference a `ref` or `out` parameter of this type receives: the box
    // of a struct, or a cell holding one other value.
    public WType ReferenceType(ITypeSymbol type)
    {
        var mapped = MapType(type);
        return mapped.IsTuple ? WType.Ref(StructOf(mapped).Box) : WType.Ref(CellHeap(mapped));
    }

    // The struct whose box a reference type names, if any.
    public StructLayout? BoxOwner(WType type) =>
        type.IsRef ? structLayouts.Find(layout => layout.Box == type.Heap) : null;

    // A cell is a `$ref` of its type (see Frontend.References), declared
    // first, as a supertype must be.
    public int CellHeap(WType type)
    {
        type = ReferenceKey(type);
        if (!cells.TryGetValue(type, out int heap))
        {
            int reference = AddType(TypeDefinition.Struct("ref", [], final: false));
            referenceBases.Add(type, reference);
            heap = AddType(TypeDefinition.Struct("cell", [new(type)], reference));
            cells.Add(type, heap);
        }

        return heap;
    }

    // Allocates a struct's box holding the zero value, nested boxes first; a
    // constant expression, so it also initializes a static field's global.
    public void WriteNewBox(WasmWriter code, StructLayout layout)
    {
        foreach (var field in layout.Fields)
        {
            var type = MapType(field.Type);
            if (type.IsTuple)
            {
                WriteNewBox(code, StructOf(type));
            }
            else
            {
                type.Default(code);
            }
        }

        code.Gc(0, layout.Box); // struct.new
    }

    // Leaves of a struct and its nested boxes: what allocating a box
    // charges, like an object of that many fields.
    public int BoxCharge(WType type) => type.IsTuple ? Math.Max(1, StructOf(type).Leaves.Length) : 1;

    public int BoxMethodIndex(IMethodSymbol method) =>
        boxMethodIds.TryGetValue(method, out int id)
            ? imports.Count + id
            : throw Error(UnsupportedCall(method, "no function on its struct's box"));

    public bool HasFunction(IMethodSymbol method) =>
        methodIds.ContainsKey(method) || boxMethodIds.ContainsKey(method);
}
