// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// A class that takes part in dispatch: one with a source base class, one
// that is not sealed, or one that implements an interface.
internal sealed class ClassLayout(INamedTypeSymbol symbol, ClassLayout? parent, int heap, int vtable)
{
    public INamedTypeSymbol Symbol { get; } = symbol;

    public ClassLayout? Base { get; } = parent;

    public int Heap { get; } = heap;

    public int VTable { get; } = vtable;

    // The method each vtable slot runs for this class (null while abstract),
    // and the function type of the slot. A class starts from its base's.
    public List<IMethodSymbol?> Slots { get; } = [];

    public List<int> SlotTypes { get; } = [];

    // The index of this class's vtable global, or -1 for an abstract class.
    public int Global { get; set; } = -1;

    // A value type's box (see Frontend.Boxing) rather than a class.
    public bool IsBox { get; init; }

    // An exact instantiation whose heap and vtable types are its canonical
    // form's representation's (see Frontend.Sharing), or null.
    public ClassLayout? Representation { get; init; }

    // A shared class's representation, rather than a class.
    public bool IsRepresentation { get; init; }

    // The class's id and the last id of the classes deriving from it, in
    // depth-first order of the module's class hierarchy: what a type test
    // of a class whose heap type others share compares (Frontend.Sharing).
    public int ClassId { get; set; } = -1;

    public int LastDerivedId { get; set; } = -1;
}

// Classes, vtables and virtual dispatch. Every polymorphic class is a
// subtype of the root struct `$Object { vt: (ref $VT_Object) }`: field 0
// holds its vtable, immutable so that each subclass refines it to its own
// vtable type, and the fields of each base come first, in the base's order.
// A vtable is a struct of immutable function references, one per slot, and
// extends its base's; each concrete class has one, in an immutable global.
// The root vtable holds the itables, then, in a module that dispatches
// them, slots for System.Object's ToString, GetHashCode and Equals, which
// records, classes and boxes override; classes that do not have functions
// comparing and hashing by identity and printing their name (see
// Frontend.Boxing). A slot no call site dispatches through holds null, and
// the functions only it would reach are left out of the module.
// Sealed classes without a base keep the plain struct of their fields;
// records are always polymorphic.
internal sealed partial class Frontend
{
    private readonly Dictionary<INamedTypeSymbol, ClassLayout> layouts = new(SymbolEqualityComparer.Default);
    private readonly List<ClassLayout> concreteClasses = [];
    // Each slot, keyed by the method that introduced it.
    private readonly Dictionary<IMethodSymbol, int> slotIds = new(SymbolEqualityComparer.Default);
    private int objectHeap = -1;
    private int objectVTable = -1;
    // The System.Object members with slots in the root vtable, when a record
    // class overrides them, and each slot's function type.
    private static readonly string[] ObjectSlotNames = ["ToString", "GetHashCode", "Equals"];
    private bool objectSlots;
    private int[] objectSlotTypes = [];
    // The System.Object members a class other than a record overrides.
    private readonly HashSet<string> objectOverrides = [];
    // The identity Equals and GetHashCode of classes that do not override
    // them, when there are object slots; -1 for none.
    private readonly int[] objectDefaults = [-1, -1, -1];

    private static bool IsSourceClass(INamedTypeSymbol? type) =>
        type is { TypeKind: TypeKind.Class } && IsModuleDefined(type);

    private static INamedTypeSymbol? SourceBase(INamedTypeSymbol type) =>
        IsSourceClass(type.BaseType) ? type.BaseType : null;

    // A class deriving from a class that is not in source derives from a BCL
    // exception (discovery admits no other).
    public bool IsPolymorphic(INamedTypeSymbol type) =>
        !type.IsStatic
        && (allPolymorphic || !type.IsSealed || type.IsRecord || SourceBase(type) is not null || SourceInterfaces(type).Any()

            || type.BaseType is { SpecialType: not SpecialType.System_Object, TypeKind: TypeKind.Class } baseType
                && !IsSourceClass(baseType));

    // The interfaces a class implements that have itables: its source
    // interfaces. System.Collections.IEnumerable only lets the runtime's
    // collections take collection initializers; the BCL exceptions'
    // interfaces go unused.
    // A framework type's are only the adopted interfaces of the runtime's
    // own types, and a boxed number's, where its members have shims (see
    // FunctionEmitter.EmitBoxThunk): `IComparable<int> x = 5` compares.
    public IEnumerable<INamedTypeSymbol> SourceInterfaces(INamedTypeSymbol type) =>
        Implemented(type).Where(candidate => IsModuleInterface(candidate)
            && (!IsLazilyAdopted(candidate) || interfaces.ContainsKey(candidate))
            && (IsModuleDefined(type) || FullName(candidate.OriginalDefinition) != "System.IComparable`1"
                || (ScalarOf(type) is not null && interfaces.ContainsKey(candidate))));

    public static bool IsMarkerInterface(INamedTypeSymbol type) =>
        type.SpecialType == SpecialType.System_Collections_IEnumerable;

    // Whether a class is, derives from or implements a type.
    private static bool DerivesFrom(INamedTypeSymbol type, INamedTypeSymbol baseType)
    {
        if (baseType.TypeKind == TypeKind.Interface)
        {
            return type.AllInterfaces.Any(candidate => SameInterface(candidate, baseType));
        }

        for (INamedTypeSymbol? current = type; current is not null; current = current.BaseType)
        {
            if (SymbolEqualityComparer.Default.Equals(current, baseType))
            {
                return true;
            }
        }

        return false;
    }

    private static int Depth(INamedTypeSymbol type)
    {
        int depth = 0;
        for (var current = SourceBase(type); current is not null; current = SourceBase(current))
        {
            depth++;
        }

        return depth;
    }

    // A class's heap type, registered after its base's so that the group
    // declares every supertype before its subtypes.
    private void RegisterClass(INamedTypeSymbol type)
    {
        if (heapIds.ContainsKey(type) || layouts.ContainsKey(type))
        {
            return;
        }

        if (UsesRepresentation(type))
        {
            RegisterSharedClass(type);
            return;
        }

        if (!IsPolymorphic(type))
        {
            AddHeap(type);
            return;
        }

        ClassLayout? parent = null;
        if (SourceBase(type) is { } baseType)
        {
            if (baseType.IsSealed)
            {
                // The CoreLib's collections and Random are sealed where
                // .NET's are not.
                throw CompileError.At(type, $"Deriving from '{baseType.ToDisplayString()}' is unsupported: it is sealed here.");
            }

            if (IsGenericInstance(baseType))
            {
                EnsureClassInstance(baseType);
            }
            else
            {
                RegisterClass(baseType);
            }

            parent = layouts[baseType];
        }
        else if (IsFrameworkException(type.BaseType))
        {
            parent = RegisterFrameworkClass(type.BaseType!);
        }
        else
        {
            EnsureObjectRoot();
        }

        int heap = AddHeap(type);
        var layout = new ClassLayout(type, parent, heap, AddType(null));
        layouts.Add(type, layout);
    }

    // Numbers a class's own fields after its base's (or after the vtable),
    // and starts its slots from its base's. Discovery registers a base's
    // members before its derived classes'.
    private void StartMembers(INamedTypeSymbol type)
    {
        if (!layouts.TryGetValue(type, out var layout))
        {
            return;
        }

        if (layout.Representation is { } representation)
        {
            // An exact instantiation has its canonical form's fields and
            // slots, which that registered first; its own methods fill them.
            if (!startedShared.Add(type))
            {
                return;
            }

            nextFieldIndex[type] = nextFieldIndex[representation.Symbol];
            layout.Slots.AddRange(representation.Slots.Select(_ => (IMethodSymbol?)null));
            layout.SlotTypes.AddRange(representation.SlotTypes);
            if (layout.Base is not null)
            {
                for (int slot = 0; slot < layout.Base.Slots.Count; slot++)
                {
                    layout.Slots[slot] = layout.Base.Slots[slot];
                }
            }

            return;
        }

        if (!nextFieldIndex.TryAdd(type, layout.Base is { } parent ? nextFieldIndex[parent.Symbol] : 1))
        {
            return;
        }

        if (layout.Base is not null)
        {
            layout.Slots.AddRange(layout.Base.Slots);
            layout.SlotTypes.AddRange(layout.Base.SlotTypes);
        }
    }

    private readonly HashSet<INamedTypeSymbol> startedShared = new(SymbolEqualityComparer.Default);

    public bool TryLayout(ITypeSymbol? type, out ClassLayout layout)
    {
        layout = null!;
        return type is INamedTypeSymbol named && layouts.TryGetValue(named, out layout!);
    }

    private static bool IsDispatched(IMethodSymbol method) =>
        method.IsVirtual || method.IsAbstract || method.IsOverride;

    // An override returning a type derived from its slot's: its function
    // returns the slot's type, which its callers cast back.
    public static bool HasCovariantResult(IMethodSymbol method) =>
        method.IsOverride && !SymbolEqualityComparer.Default.Equals(method.ReturnType, SlotRoot(method).ReturnType);

    public static IMethodSymbol SlotRootOf(IMethodSymbol method) => SlotRoot(method);

    // Whether values of one heap type are values of another: its
    // supertype chain, or an abstract heap above every struct or array.
    public bool IsSubtypeHeap(int heap, int super)
    {
        if (heap == super || super == EqHeap || (super == WType.StructHeap && heap >= 0 && types[heap]?.Kind == DefinitionKind.Struct))
        {
            return true;
        }

        for (int current = heap; current >= 0 && types[current] is { } definition; current = definition.Supertype)
        {
            if (current == super)
            {
                return true;
            }
        }

        return false;
    }

    public bool IsStructHeap(int heap) => heap >= 0 && heap < types.Count && types[heap]?.Kind == DefinitionKind.Struct;

    public INamedTypeSymbol SpecialTypeOf(SpecialType type) => compilation.GetSpecialType(type);

    // A type's interfaces without tuple element names, which metadata
    // carries on implementations (IEnumerable<(int First, int Second)>) and
    // which do not make another interface.
    public IEnumerable<INamedTypeSymbol> Implemented(INamedTypeSymbol type)
    {
        if (!implemented.TryGetValue(type, out var known))
        {
            var direct = type.AllInterfaces.Select(candidate => (INamedTypeSymbol)Unnamed(candidate))
                .Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default)
                .ToArray();
            known = new(direct, direct, 0);
        }

        // By variance too: of the module's interfaces, each an
        // interface the type implements converts to (an IEnumerable<Animal>
        // of a List<Bird>, an IComparer<Bird> of a Comparer<Animal>), with
        // itables of its own (see Implementation). The interfaces are
        // only ever added to, so only those added since are new.
        if (known.Checked < interfaceOrder.Count)
        {
            var all = known.All.ToList();
            foreach (var face in interfaceOrder.Skip(known.Checked))
            {
                if (!all.Contains(face, SymbolEqualityComparer.Default) && VarianceSource(known.Direct, face) is not null)
                {
                    all.Add(face);
                }
            }

            known = new(known.Direct, all.Count == known.All.Length ? known.All : [.. all], interfaceOrder.Count);
        }

        implemented[type] = known;
        return known.All;
    }

    // What Implemented has found of a type: its interfaces, and those it
    // converts to of the first `Checked` the module registered.
    private sealed record KnownInterfaces(INamedTypeSymbol[] Direct, INamedTypeSymbol[] All, int Checked);

    private readonly Dictionary<INamedTypeSymbol, KnownInterfaces> implemented = new(SymbolEqualityComparer.IncludeNullability);

    // Whether a dispatch on a receiver of a type may run a class's slot:
    // the class derives from it, or implements it (by variance too).
    private bool Reaches(INamedTypeSymbol type, INamedTypeSymbol receiver) =>
        DerivesFrom(type, receiver)
        || (receiver.TypeKind == TypeKind.Class && UsesRepresentation(receiver) && DerivesFromCanonical(type, receiver))
        || (receiver.TypeKind == TypeKind.Interface
            && VarianceSource(DirectlyImplemented(type), receiver) is not null);

    private INamedTypeSymbol[] DirectlyImplemented(INamedTypeSymbol type)
    {
        Implemented(type);
        return implemented[type].Direct;
    }

    // The interface among those implemented that converts to a variant
    // interface by variance (the first, in the CLR's order), or null.
    private INamedTypeSymbol? VarianceSource(IEnumerable<INamedTypeSymbol> implemented, INamedTypeSymbol face) =>
        !face.OriginalDefinition.TypeParameters.Any(parameter => parameter.Variance != VarianceKind.None)
            ? null
            : implemented.FirstOrDefault(candidate =>
                SymbolEqualityComparer.Default.Equals(candidate.OriginalDefinition, face.OriginalDefinition)
                && !SameInterface(candidate, face)
                && ClassifyConversion(candidate, face) is { IsImplicit: true, IsReference: true });

    private static bool SameInterface(INamedTypeSymbol left, INamedTypeSymbol right) =>
        SymbolEqualityComparer.Default.Equals(left, right)
        || (SymbolEqualityComparer.Default.Equals(left.OriginalDefinition, right.OriginalDefinition)
            && left.TypeArguments.Zip(right.TypeArguments).All(pair => SameIgnoringNames(pair.First, pair.Second)));

    private static bool SameIgnoringNames(ITypeSymbol left, ITypeSymbol right)
    {
        static ITypeSymbol Untuple(ITypeSymbol type) =>
            type is INamedTypeSymbol { IsTupleType: true, TupleUnderlyingType: { } underlying } ? underlying : type;

        left = Untuple(left);
        right = Untuple(right);
        return (left, right) switch
        {
            (INamedTypeSymbol a, INamedTypeSymbol b) =>
                SymbolEqualityComparer.Default.Equals(a.OriginalDefinition, b.OriginalDefinition)
                && a.TypeArguments.Zip(b.TypeArguments).All(pair => SameIgnoringNames(pair.First, pair.Second)),
            (IArrayTypeSymbol a, IArrayTypeSymbol b) => a.Rank == b.Rank && SameIgnoringNames(a.ElementType, b.ElementType),
            _ => SymbolEqualityComparer.Default.Equals(left, right),
        };
    }

    private static IMethodSymbol SlotRoot(IMethodSymbol method)
    {
        while (method.IsOverride && method.OverriddenMethod is { } overridden)
        {
            method = overridden;
        }

        return method;
    }

    // The receiver type of a method's function: its class, or for a virtual
    // method the class that introduced its slot, so that every override
    // shares the slot's function type.
    // A record's override of an object member takes an $Object.
    private WType ReceiverType(IMethodSymbol method)
    {
        var owner = IsDispatched(method) ? SlotRoot(method).ContainingType : method.ContainingType;
        return IsSourceClass(owner) ? MapType(owner) : WType.Ref(objectHeap);
    }

    // The root vtable's slot of a System.Object member, or -1.
    private static int ObjectSlot(IMethodSymbol method) =>
        method is { IsStatic: false, ContainingType.SpecialType: SpecialType.System_Object }
            ? Array.IndexOf(ObjectSlotNames, method.Name)
            : -1;

    public bool ObjectSlots => objectSlots;

    // A call of a System.Object member through its slot, on an $Object of
    // a type, such as an interface, with no layout.
    public CallTarget ObjectSlotCall(string name, INamedTypeSymbol receiver)
    {
        int slot = Array.IndexOf(ObjectSlotNames, name);
        return new(
            -1, objectHeap, objectVTable, ObjectSlotField(slot), objectSlotTypes[slot],
            Use: new(ObjectMember(slot), receiver));
    }

    // The identity Equals and GetHashCode, for the classes that do not
    // override them; GetHashCode only when objects have identity hashes.
    private void RegisterObjectDefaults()
    {
        if (!objectSlots)
        {
            return;
        }

        EnsureObjectRoot();
        foreach (string name in new[] { "Equals", "GetHashCode" })
        {
            int slot = Array.IndexOf(ObjectSlotNames, name);
            if (name == "GetHashCode" && !identityHash)
            {
                continue;
            }

            var member = ObjectMember(slot);
            objectDefaults[slot] = methods.Count;
            methods.Add(new(
                member,
                $"{member.ToDisplayString()} [identity]",
                [WType.Ref(objectHeap), .. name == "Equals" ? [WType.Ref(EqHeap)] : Array.Empty<WType>()],
                WType.I32,
                true,
                null,
                MethodPlanKind.ObjectDefault,
                Substitution.Empty));
        }
    }

    private IMethodSymbol ObjectMember(int slot) => ObjectMethod(ObjectSlotNames[slot]);

    // The source override of a System.Object member that a type runs, if any.
    public static IMethodSymbol? ObjectOverride(INamedTypeSymbol type, IMethodSymbol member)
    {
        for (INamedTypeSymbol? current = type; current is not null && IsModuleDefined(current); current = current.BaseType)
        {
            foreach (var candidate in current.GetMembers(member.Name).OfType<IMethodSymbol>())
            {
                if (candidate.IsOverride && SymbolEqualityComparer.Default.Equals(SlotRoot(candidate), member))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    // Gives a virtual, abstract or override method its slot: a new one
    // unless it overrides, in which case it takes over the slot of the
    // method it overrides for its own class and those derived from it.
    private void AssignSlot(IMethodSymbol method)
    {
        // An interface's members dispatch through itables, a generic
        // method's instantiations through dispatchers.
        if (!IsDispatched(method) || method.ContainingType.TypeKind == TypeKind.Interface || method.IsGenericMethod)
        {
            return;
        }

        var root = SlotRoot(method);
        if (!IsSourceClass(root.ContainingType))
        {
            if (ObjectSlot(root) >= 0)
            {
                // The root vtable's (see DemandObjectSlot). A class that
                // overrides one is a $Object like every class then.
                if (!method.ContainingType.IsRecord)
                {
                    objectValues = true;
                    objectOverrides.Add(root.Name);
                }

                return;
            }

            throw CompileError.At(method,
                $"Overriding '{root.ToDisplayString()}' is unsupported: members of System.Object and the BCL have no slots here.");
        }

        var layout = layouts[method.ContainingType];
        root = CanonicalMember(root);
        if (!slotIds.TryGetValue(root, out int slot))
        {
            slot = layout.Slots.Count;
            slotIds.Add(root, slot);
            layout.Slots.Add(null);
            layout.SlotTypes.Add(SignatureType([MapType(root.ContainingType), .. PlanParameters(root)], PlanResult(root)));
        }

        layout.Slots[slot] = method.IsAbstract ? null : method;
    }

    // A vtable's fields: the itables, when the module has interfaces, the
    // object members' slots, then the class's.
    private int FirstSlotField => ClassIdField + (classIds ? 1 : 0) + (classDictionaries ? 1 : 0);

    // With shared classes, the class id every vtable holds after the
    // object members' slots (see Frontend.Sharing), once DefineClasses
    // has decided.
    public int ClassIdField => ObjectSlotField(objectSlots ? ObjectSlotNames.Length : 0);

    private bool classIds;

    // With shared code, the dictionary every vtable holds after the class
    // id (see Frontend.SharedCode).
    private bool classDictionaries;

    private int ObjectSlotField(int slot) => (interfaces.Count != 0 ? 1 : 0) + slot;

    // Defines the root vtable, the itables, and each polymorphic class's
    // struct and vtable types once every field and slot is known, and
    // numbers the vtables of concrete classes.
    private void DefineClasses()
    {
        if (objectHeap < 0)
        {
            return;
        }

        var rootFields = new List<WField>();
        if (interfaces.Count != 0)
        {
            itablesArray = AddType(TypeDefinition.Array("itables", new(WType.Ref(WType.StructHeap), Mutable: false)));
            rootFields.Add(new(WType.NonNullRef(itablesArray), Mutable: false));
            foreach (var layout in interfaces.Values)
            {
                types[layout.Table] = TypeDefinition.Struct(
                    "itable " + layout.Symbol.ToDisplayString(),
                    layout.MemberTypes.Select(member => new WField(WType.Ref(member), Mutable: false)).ToArray());
            }
        }

        if (objectSlots)
        {
            objectSlotTypes = ObjectSlotNames
                .Select(name => name switch
                {
                    "ToString" => SignatureType([WType.Ref(objectHeap)], StringType(used: false)),
                    "Equals" => SignatureType([WType.Ref(objectHeap), WType.Ref(EqHeap)], WType.I32),
                    _ => SignatureType([WType.Ref(objectHeap)], WType.I32),
                })
                .ToArray();
            rootFields.AddRange(objectSlotTypes.Select(slot => new WField(WType.Ref(slot), Mutable: false)));
        }

        classIds = sharing && representationLayouts.Count != 0;
        if (classIds)
        {
            rootFields.Add(new(WType.I32, Mutable: false));
        }

        classDictionaries = classIds && dictionaryOwners.Keys.Any(owner => owner is { Symbol: INamedTypeSymbol { TypeKind: TypeKind.Class }, Statics: false });
        if (classDictionaries)
        {
            rootFields.Add(new(WType.Ref(WType.StructHeap), Mutable: false));
        }

        types[objectVTable] = TypeDefinition.Struct("vtable object", rootFields.ToArray(), final: false);
        if (identityHash)
        {
            types[objectHeap] = TypeDefinition.Struct(
                "object", [new(WType.NonNullRef(objectVTable), Mutable: false), HashFieldDefinition], final: false);
        }

        foreach (var box in boxes.Values)
        {
            var fields = new List<WField> { new(WType.NonNullRef(box.VTable), Mutable: false) };
            if (identityHash)
            {
                fields.Add(HashFieldDefinition);
            }

            fields.Add(BoxValueDefinition(box.Symbol));
            types[box.Heap] = TypeDefinition.Struct("box " + box.Symbol.ToDisplayString(), fields.ToArray(), objectHeap, true);
            types[box.VTable] = TypeDefinition.Struct(
                "vtable box " + box.Symbol.ToDisplayString(), rootFields.ToArray(), objectVTable, true);
            box.Global = concreteClasses.Count;
            concreteClasses.Add(box);
        }

        foreach (var layout in representationLayouts.Values.Concat(layouts.Values).OrderBy(layout => layout.Heap))
        {
            if (layout.IsRepresentation)
            {
                // A shared class's types, which its instantiations' and
                // subclasses' extend.
                var representationFields = new List<WField> { new(WType.NonNullRef(layout.VTable), Mutable: false) };
                if (identityHash)
                {
                    representationFields.Add(HashFieldDefinition);
                }

                representationFields.AddRange(InstanceFields(layout.Symbol).Select(field => StorageField(StorageType(field))));
                types[layout.Heap] = TypeDefinition.Struct(
                    "shared " + layout.Symbol.ToDisplayString(), representationFields.ToArray(), layout.Base?.Heap ?? objectHeap, final: false);
                types[layout.VTable] = TypeDefinition.Struct(
                    "vtable shared " + layout.Symbol.ToDisplayString(),
                    rootFields.Concat(layout.SlotTypes.Select(slot => new WField(WType.Ref(slot), Mutable: false))).ToArray(),
                    layout.Base?.VTable ?? objectVTable,
                    final: false);
                continue;
            }

            if (layout.Representation is not null)
            {
                // Its canonical form's types.
                if (!layout.Symbol.IsAbstract)
                {
                    layout.Global = concreteClasses.Count;
                    concreteClasses.Add(layout);
                }

                continue;
            }

            int superHeap = layout.Base?.Heap ?? objectHeap;
            int superVTable = layout.Base?.VTable ?? objectVTable;
            var fields = new List<WField> { new(WType.NonNullRef(layout.VTable), Mutable: false) };
            if (identityHash)
            {
                fields.Add(HashFieldDefinition);
            }

            if (IsException(layout.Symbol))
            {
                fields.Add(new(WType.I32));
                if (exceptionMessages)
                {
                    fields.Add(new(WType.Ref(stringHeap)));
                    fields.Add(new(WType.Ref(ExceptionHeap)));
                    if (exceptionParamNames)
                    {
                        fields.Add(new(WType.Ref(stringHeap)));
                    }

                    if (SymbolEqualityComparer.Default.Equals(layout.Symbol, TypeInitializationException))
                    {
                        fields.Add(new(WType.Ref(stringHeap)));
                    }
                }
            }

            fields.AddRange(InstanceFields(layout.Symbol).Select(field => StorageField(StorageType(field))));
            types[layout.Heap] = TypeDefinition.Struct(
                layout.Symbol.ToDisplayString(), fields.ToArray(), superHeap, layout.Symbol.IsSealed);
            types[layout.VTable] = TypeDefinition.Struct(
                "vtable " + layout.Symbol.ToDisplayString(),
                rootFields.Concat(layout.SlotTypes.Select(slot => new WField(WType.Ref(slot), Mutable: false)))
                    .ToArray(),
                superVTable,
                layout.Symbol.IsSealed);

            if (!layout.Symbol.IsAbstract)
            {
                layout.Global = concreteClasses.Count;
                concreteClasses.Add(layout);
            }
        }

        AssignClassIds();
    }

    // A class's instance fields, its bases' first, in field index order.
    private IEnumerable<ISymbol> InstanceFields(INamedTypeSymbol type)
    {
        var chain = new List<INamedTypeSymbol>();
        for (INamedTypeSymbol? current = type; current is not null; current = SourceBase(current))
        {
            // A shared instantiation's fields are its canonical form's.
            chain.Insert(0, UsesRepresentation(current) ? Canonical(current) : current);
        }

        return chain.SelectMany(OwnStorage);
    }

    // A type's own instance storage, in index order.
    private IEnumerable<ISymbol> OwnStorage(INamedTypeSymbol type) => type.GetMembers()
        .Where(member => member is IFieldSymbol or IEventSymbol && fieldIds.ContainsKey(member))
        .OrderBy(member => fieldIds[member]);

    public static ITypeSymbol StorageType(ISymbol storage) => storage switch
    {
        IFieldSymbol field => field.Type,
        IEventSymbol symbol => symbol.Type,
        IParameterSymbol parameter => parameter.Type,
        _ => throw new InternalCompilerError($"'{storage.ToDisplayString()}' is no storage."),
    };

    // What a call runs: a function, or the slot of the receiver's vtable
    // when the target depends on the receiver's class. A call through
    // `base.`, or on a receiver whose static class fixes the implementation
    // (a sealed class, or a sealed override), is direct.
    public CallTarget ResolveCall(
        IMethodSymbol method,
        ITypeSymbol? receiverType,
        bool baseAccess,
        Substitution? enclosing = null)
    {
        if (IsGenericDispatch(method))
        {
            return baseAccess && !method.IsAbstract
                ? new(MethodIndex(method, enclosing))
                : new(GenericDispatcher(method));
        }

        if (!IsDispatched(method) || method.IsStatic)
        {
            return new(MethodIndex(method, enclosing));
        }

        if (method.ContainingType.TypeKind == TypeKind.Interface)
        {
            return InterfaceCall(method);
        }

        if (method.MethodKind == MethodKind.DelegateInvoke && IsSupportedDelegate(method.ContainingType))
        {
            return DelegateCall(method);
        }

        var root = SlotRoot(method);
        if (ObjectSlot(root) is var objectSlot and >= 0 && TryDispatchLayout(receiverType, out var owner)
            && ObjectOverride(owner.Symbol, root) is { } overriding)
        {
            return baseAccess || owner.Symbol.IsSealed || overriding.IsSealed
                ? new(MethodIndex(overriding))
                : new(
                    -1, owner.Heap, objectVTable, ObjectSlotField(objectSlot), objectSlotTypes[objectSlot],
                    Use: new(root, owner.Symbol));
        }

        if (!slotIds.TryGetValue(CanonicalMember(root), out int slot) || !TryDispatchLayout(receiverType, out var layout))
        {
            throw Error(UnsupportedCall(method, "no vtable slot"));
        }

        var implementation = layout.Slots[slot];
        if (implementation is not null && (baseAccess || layout.Symbol.IsSealed || implementation.IsSealed))
        {
            return new(MethodIndex(implementation));
        }

        if (baseAccess)
        {
            throw Error("Cannot call an abstract base member.");
        }

        return new(-1, layout.Heap, layout.VTable, FirstSlotField + slot, layout.SlotTypes[slot], Use: new(CanonicalMember(root), layout.Symbol));
    }

    // Whether a value of this type is an $Object: a polymorphic class or an
    // interface.
    public bool IsObject(WType type) =>
        type.IsRef && objectHeap >= 0
        && (type.Heap == objectHeap || layouts.Values.Concat(boxes.Values).Concat(representationLayouts.Values).Any(layout => layout.Heap == type.Heap));

    public int? VTableGlobal(ITypeSymbol? type) =>
        TryLayout(type, out var layout) && layout.Global >= 0 ? layout.Global : null;

    // The logical allocation charge counts the fields source code declares,
    // not the vtable.
    // A struct field counts its leaves; the identity hash, like the vtable,
    // is not a declared field.
    public int AllocationFields(WType type)
    {
        var definition = types[type.Heap]!;
        var fields = definition.Fields.AsEnumerable();
        if (definition.Supertype >= 0)
        {
            fields = fields.Skip(identityHash ? 2 : 1);
        }
        else if (identityHash)
        {
            fields = fields.SkipLast(1);
        }

        return fields.Sum(field => BoxOwner(field.Type) is { } layout ? Math.Max(1, layout.Leaves.Length) : 1);
    }

    public IReadOnlyList<WField> Fields(WType type) => types[type.Heap]!.Fields;

    // A concrete class's vtable, as a constant expression: a reference to
    // the function of each slot that is `used`, null for the others, then
    // struct.new. The function references are relocated like calls.
    private (byte[] Code, List<Relocation> Relocations) VTableInitializer(ClassLayout layout, Func<IMethodSymbol, bool> used)
    {
        var code = new WasmWriter();
        var relocations = new List<Relocation>();
        if (interfaces.Count != 0)
        {
            WriteITables(layout, code, relocations, used);
        }

        var slots = VTableSlots(layout);
        for (int index = 0; index < slots.Count; index++)
        {
            var (root, function, type) = slots[index];
            if (classIds && index == (objectSlots ? ObjectSlotNames.Length : 0))
            {
                code.I32(layout.ClassId);
                WriteDictionary(layout, code, relocations);
            }

            if (function < 0 || !used(root))
            {
                code.Byte(0xd0); // ref.null
                code.Signed(type);
                continue;
            }

            code.Byte(0xd2); // ref.func
            relocations.Add(new(code.Length, RelocationKind.FunctionReference, function));
        }

        if (classIds && slots.Count == (objectSlots ? ObjectSlotNames.Length : 0))
        {
            code.I32(layout.ClassId);
            WriteDictionary(layout, code, relocations);
        }

        code.Gc(0, layout.VTable); // struct.new
        return (code.ToArray(), relocations);
    }

    // Each slot of a concrete class's vtable after its itables: the method
    // that introduced it, the function the class runs (-1 for an object
    // member it does not override, -2 for a record's override code never
    // demanded), and its function type.
    private List<(IMethodSymbol Root, int Function, int Type)> VTableSlots(ClassLayout layout)
    {
        var slots = new List<(IMethodSymbol, int, int)>();
        if (objectSlots)
        {
            for (int slot = 0; slot < ObjectSlotNames.Length; slot++)
            {
                var member = ObjectMember(slot);
                slots.Add((
                    member,
                    !layout.IsBox && ObjectOverride(layout.Symbol, member) is { } overriding
                        ? HasFunction(overriding) ? MethodIndex(overriding) : -2
                        : ObjectSlotFunction(layout, slot),
                    objectSlotTypes[slot]));
            }
        }

        for (int slot = 0; slot < layout.Slots.Count; slot++)
        {
            var implementation = layout.Slots[slot]!;
            slots.Add((CanonicalMember(SlotRoot(implementation)), MethodIndex(implementation), layout.SlotTypes[slot]));
        }

        return slots;
    }
}

// A direct call to Function, or a call through field Slot of the vtable
// that field 0 of the receiver (of heap type Heap) holds; for an interface
// call, through member Slot of the itable (of type Table) that the vtable
// holds for Interface. A delegate (VTable -1) holds its function itself.
// A virtual call's Use is the slot it dispatches through.
internal readonly record struct CallTarget(
    int Function,
    int Heap = -1,
    int VTable = -1,
    int Slot = -1,
    int Signature = -1,
    int Interface = -1,
    int Table = -1,
    SlotUse? Use = null,
    ITypeSymbol? EnumerableElement = null,
    IMethodSymbol? ArrayCall = null,
    string? ObjectArrayCall = null)
{
    public bool IsVirtual => Function < 0;
}

// A dispatch through the slot Root introduced, on a receiver whose static
// class is Receiver: it reaches the slot's functions in the vtables of
// Receiver and the classes derived from it.
internal readonly record struct SlotUse(IMethodSymbol Root, INamedTypeSymbol Receiver)
{
    public bool Equals(SlotUse other) =>
        SymbolEqualityComparer.Default.Equals(Root, other.Root)
        && SymbolEqualityComparer.Default.Equals(Receiver, other.Receiver);

    public override int GetHashCode() => HashCode.Combine(
        SymbolEqualityComparer.Default.GetHashCode(Root),
        SymbolEqualityComparer.Default.GetHashCode(Receiver));
}
