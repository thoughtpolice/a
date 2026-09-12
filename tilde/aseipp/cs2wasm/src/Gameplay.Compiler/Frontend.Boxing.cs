// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Boxing, and `object` values. An `object` is an eqref: a reference is
// itself, and a value of a value type V (a scalar, an enum, a struct, a
// record struct or a union) is boxed as a `$Box_V`, a final subtype of
// `$Object` holding the value after the vtable (and the identity hash):
// a scalar, a union's reference, or a struct's storage box, so that an
// interface call on the box runs the struct's method on its storage and a
// mutation stays in the box, as in the CLR. Each boxing allocates a new
// box, charged like an object of the value's fields plus one. A box's
// vtable holds the itables of V's interfaces, whose thunks unwrap the
// storage, and, when code dispatches them, V's Equals, GetHashCode and
// ToString.
//
// A module with object values makes every class polymorphic, so that
// every object but a string, an array or a delegate is a `$Object` whose
// vtable answers Equals, GetHashCode and ToString: a class that does not
// override them compares and hashes by identity and prints its type's full
// name. Discovery finds out late whether the module has object values;
// when it does and some class was laid out plain, discovery starts over
// with every class polymorphic. A string compares, hashes and prints by
// its contents; an array compares by identity, and hashing or printing
// one, or comparing distinct delegates, faults with Unsupported (19): the
// CLR's answers need what arrays and delegates lack here.
//
// Unboxing checks for null (NullReferenceException) and the box's type
// (InvalidCastException), which is exact but for enums and their
// underlying integers, as the CLR's unbox is.
internal sealed partial class Frontend
{
    // The boxes of the value types code boxes, unboxes or tests for.
    private readonly Dictionary<ITypeSymbol, ClassLayout> boxes = new(SymbolEqualityComparer.Default);
    private bool objectValues;
    private readonly bool allPolymorphic;
    // The System.Object members code calls on objects of unknown type, and
    // the function each box and each class without an override runs for
    // them, by slot.
    private readonly HashSet<string> objectMemberDemands = [];
    private readonly int[] objectHelpers = [-1, -1, -1];
    private readonly Dictionary<ClassLayout, int[]> boxMembers = [];
    private readonly Dictionary<INamedTypeSymbol, int> defaultToStrings = new(SymbolEqualityComparer.Default);

    // Thrown when discovery finds object values after laying out a class
    // plain; Compile starts over with every class polymorphic.
    private sealed class ObjectValuesFound : Exception;

    public static bool IsObjectType(ITypeSymbol? type) => type?.SpecialType == SpecialType.System_Object;

    // A value type a box can hold: a scalar, an enum, a struct, a union or
    // a Vector128.
    public static bool IsBoxable(ITypeSymbol? type) =>
        ScalarOf(type) is not null || IsStruct(type) || VectorLane(type) is not null;

    private WType ObjectType()
    {
        objectValues = true;
        if (!frozen)
        {
            EnsureObjectRoot();
        }

        return WType.Ref(EqHeap);
    }

    public ClassLayout BoxOf(ITypeSymbol type) => boxes.TryGetValue(type, out var box)
        ? box
        : throw new InternalCompilerError($"'{type.ToDisplayString()}' was not boxed.");

    public bool TryBox(ITypeSymbol type, out ClassLayout box) => boxes.TryGetValue(type, out box!);

    // The box field holding the value, after the vtable and the hash.
    public int BoxValueField => identityHash ? 2 : 1;

    public ClassLayout EnsureBox(ITypeSymbol type)
    {
        if (boxes.TryGetValue(type, out var box))
        {
            return box;
        }

        if (frozen)
        {
            throw new InternalCompilerError($"'{type.ToDisplayString()}' was not boxed during discovery.");
        }

        if (!IsBoxable(type))
        {
            throw new CompileError($"'{type.ToDisplayString()}' cannot be boxed.");
        }

        objectValues = true;
        EnsureObjectRoot();
        MapType(type);
        box = new ClassLayout((INamedTypeSymbol)type, null, AddType(null), AddType(null)) { IsBox = true };
        boxes.Add(type, box);
        foreach (string slot in objectMemberDemands)
        {
            RegisterBoxMember(box, slot);
        }

        return box;
    }

    // The value field's definition: a scalar, a union's reference, or the
    // storage box of a struct, which the box owns.
    private WField BoxValueDefinition(ITypeSymbol type)
    {
        var mapped = MapType(type);
        return mapped.IsTuple
            ? new(WType.NonNullRef(StructOf(mapped).Box), Mutable: false)
            : new(mapped, Mutable: false);
    }

    // What a box of `type` accepts unboxed as `target`: the same type, or,
    // for enums, their underlying integer type either way.
    public IEnumerable<ClassLayout> UnboxSources(ITypeSymbol target)
    {
        if (boxes.TryGetValue(target, out var exact))
        {
            yield return exact;
        }

        if (ScalarOf(target) is not { } scalar)
        {
            yield break;
        }

        foreach (var (type, box) in boxes)
        {
            if (!SymbolEqualityComparer.Default.Equals(type, target) && ScalarOf(type) == scalar
                && (type.TypeKind == TypeKind.Enum || target.TypeKind == TypeKind.Enum))
            {
                yield return box;
            }
        }
    }

    // A call of a System.Object member on a value of unknown type: every
    // record, box and class answers it, and a helper takes apart the values
    // that are not $Objects.
    public void DemandObjectMember(string slot)
    {
        if (!objectMemberDemands.Add(slot))
        {
            return;
        }

        objectValues = true;
        objectSlots = true;
        EnsureObjectRoot();
        DemandObjectSlot(slot, compilation.GetSpecialType(SpecialType.System_Object));
        switch (slot)
        {
            case "GetHashCode":
                identityHash = true;
                break;
            case "ToString":
                StringType();
                break;
        }

        foreach (var box in boxes.Values.ToList())
        {
            RegisterBoxMember(box, slot);
        }

        int index = Array.IndexOf(ObjectSlotNames, slot);
        objectHelpers[index] = methods.Count;
        var member = ObjectMember(index);
        methods.Add(new(
            member,
            $"{member.ToDisplayString()} [object]",
            slot == "Equals" ? [WType.Ref(EqHeap), WType.Ref(EqHeap)] : [WType.Ref(EqHeap)],
            slot == "ToString" ? StringType() : WType.I32,
            true,
            null,
            MethodPlanKind.ObjectHelper,
            Substitution.Empty));
    }

    public INamedTypeSymbol ObjectSymbol => compilation.GetSpecialType(SpecialType.System_Object);

    // What `new object()` creates (runtime/Shims.cs).
    public INamedTypeSymbol PlainObjectType => TypeNamed("Gameplay.Runtime.PlainObject")!;

    // Each array type's heap and CLR name.
    public IEnumerable<(int Heap, string Name)> ArrayNames => heapIds
        .Where(entry => entry.Key is IArrayTypeSymbol array && ClrName(entry.Key) is not null && Escapes(array))
        .Select(entry => (entry.Value, ClrName(entry.Key)!));

    // Equals, GetHashCode and ToString of System.Object (or ValueType), as a
    // call names them when the receiver's type does not override them, and
    // the static Equals and ReferenceEquals.
    public static bool IsObjectMember(IMethodSymbol method) =>
        method is { Name: "ToString", IsStatic: false, Parameters.Length: 0 }
        && method.ContainingType.ToDisplayString() == "System.Exception" ||
        method.ContainingType.SpecialType is SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum
            or SpecialType.System_Delegate or SpecialType.System_MulticastDelegate
        && (method.IsStatic
            ? method.Name is "Equals" or "ReferenceEquals" && method.Parameters.Length == 2
            : method.Name is "Equals" or "GetHashCode" or "ToString" && ObjectSlot(SlotRoot(method)) >= 0)
        || ScalarOf(method.ContainingType) is not null && !method.IsStatic
        && (method.Name is "GetHashCode" or "ToString" && method.Parameters.Length == 0
            || method.Name == "Equals" && method.Parameters.Length == 1);

    // Whether a class of this type may override an object member.
    public bool OverridesObjectMember(ITypeSymbol type, string slot) =>
        IsSourceClass(type as INamedTypeSymbol) && !type.IsRecord && objectOverrides.Contains(slot);

    public int ObjectHelper(string slot) =>
        objectHelpers[Array.IndexOf(ObjectSlotNames, slot)] is var index and >= 0
            ? imports.Count + index
            : throw new InternalCompilerError($"object {slot} was not demanded.");

    // A box's function for an object member, its value's: the struct's
    // override if it has one, or ValueType's and the scalars' meaning.
    private void RegisterBoxMember(ClassLayout box, string slot)
    {
        if (!boxMembers.TryGetValue(box, out var members))
        {
            members = [-1, -1, -1];
            boxMembers.Add(box, members);
        }

        int index = Array.IndexOf(ObjectSlotNames, slot);
        if (members[index] >= 0)
        {
            return;
        }

        var member = ObjectMember(index);
        var type = box.Symbol;
        if (ObjectOverride(type, member) is { } overriding)
        {
            EnsureMethod(overriding, Substitution.Empty);
        }
        else if (slot == "Equals")
        {
            DemandEquality(type, byObject: true);
        }
        else if (slot == "GetHashCode")
        {
            DemandHash(type);
        }

        if (slot == "ToString")
        {
            DemandPrinting(type);
        }

        members[index] = methods.Count;
        methods.Add(new(
            member,
            $"{member.ToDisplayString()} [box {type.ToDisplayString()}]",
            slot == "Equals" ? [WType.Ref(objectHeap), WType.Ref(EqHeap)] : [WType.Ref(objectHeap)],
            slot == "ToString" ? StringType() : WType.I32,
            false,
            type,
            MethodPlanKind.BoxMember,
            Substitution.Empty));
    }

    // Each concrete class's ToString when code prints objects, the BCL
    // exceptions' included: its type's full name, or an exception's text,
    // unless it overrides it.
    private void FinishObjectPrinting()
    {
        if (!objectMemberDemands.Contains("ToString"))
        {
            return;
        }

        if (layouts.Keys.Any(IsException))
        {
            RequireMessages();
        }

        var member = ObjectMethod("ToString");
        foreach (var layout in layouts.Values.Where(layout => !layout.Symbol.IsAbstract && ObjectOverride(layout.Symbol, member) is null))
        {
            defaultToStrings[layout.Symbol] = methods.Count;
            methods.Add(new(
                member,
                $"{member.ToDisplayString()} [{layout.Symbol.ToDisplayString()}]",
                [WType.Ref(objectHeap)],
                StringType(),
                true,
                layout.Symbol,
                MethodPlanKind.ObjectDefault,
                Substitution.Empty));
        }
    }

    // A type's name as the CLR's Type.ToString prints it: namespace, the
    // containing types after '+', a generic type's arity after '`', then
    // every type argument's name in brackets; an array's element's and []
    // (`System.Collections.Generic.List`1[System.Int32]`).
    public static string? ClrName(ITypeSymbol type)
    {
        switch (type)
        {
            case IArrayTypeSymbol { IsSZArray: true } array:
                return ClrName(array.ElementType) is { } element ? element + "[]" : null;
            case INamedTypeSymbol named:
                var chain = new List<INamedTypeSymbol>();
                for (var current = named; current is not null; current = current.ContainingType)
                {
                    chain.Insert(0, current);
                }

                string name = string.Join("+", chain.Select(part => part.MetadataName));
                if (named.ContainingNamespace is { IsGlobalNamespace: false } space)
                {
                    name = space.ToDisplayString() + "." + name;
                }

                var arguments = chain.SelectMany(part => part.TypeArguments).ToList();
                if (arguments.Count == 0)
                {
                    return name;
                }

                var names = arguments.Select(ClrName).ToList();
                return names.Any(argument => argument is null) ? null : name + "[" + string.Join(",", names) + "]";
            default:
                return null;
        }
    }

    // The function a box's or class's vtable holds for an object slot.
    private int ObjectSlotFunction(ClassLayout layout, int slot)
    {
        if (layout.IsBox)
        {
            return boxMembers.TryGetValue(layout, out var members) && members[slot] >= 0 ? imports.Count + members[slot] : -1;
        }

        if (ObjectSlotNames[slot] == "ToString" && defaultToStrings.TryGetValue(layout.Symbol, out int toString))
        {
            return imports.Count + toString;
        }

        return objectDefaults[slot] >= 0 ? imports.Count + objectDefaults[slot] : -1;
    }

    // Discovery found object values: every class must be a $Object.
    private void CheckObjectValues()
    {
        if (objectValues && !allPolymorphic && heapIds.Keys.OfType<INamedTypeSymbol>()
                .Any(type => type.TypeKind == TypeKind.Class && !type.IsStatic && !layouts.ContainsKey(type)
                             && !representationLayouts.ContainsKey(type)))
        {
            throw new ObjectValuesFound();
        }
    }
}
