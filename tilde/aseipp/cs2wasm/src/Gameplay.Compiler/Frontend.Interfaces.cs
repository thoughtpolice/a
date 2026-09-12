// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// An interface: its dense id, which indexes every vtable's itables, and its
// itable type, one immutable function reference per member.
internal sealed class InterfaceLayout(INamedTypeSymbol symbol, int id, int table)
{
    public INamedTypeSymbol Symbol { get; } = symbol;

    public int Id { get; } = id;

    public int Table { get; } = table;

    // Its own methods and accessors, not its base interfaces', in declaration
    // order, and the function type of each.
    public List<IMethodSymbol> Members { get; } = [];

    public List<int> MemberTypes { get; } = [];
}

// Interfaces. A value of an interface type is a `(ref null $Object)`. When
// the module declares an interface, `$VT_Object` holds `itables`, an array
// indexed by interface id of each implemented interface's itable (null for
// the others). Itable slots take `this` as an `$Object` and point at thunks
// that cast it and call the implementation, directly or through its vtable.
internal sealed partial class Frontend
{
    private readonly Dictionary<INamedTypeSymbol, InterfaceLayout> interfaces = new(SymbolEqualityComparer.Default);

    // The interfaces in the order they were registered (their ids).
    private readonly List<INamedTypeSymbol> interfaceOrder = [];
    private readonly Dictionary<(IMethodSymbol Member, IMethodSymbol Implementation), int> thunkIds = [];

    // How many of an itable's members RegisterInterfaceThunks has given a
    // class's thunks, by the class and the interface's id.
    private readonly Dictionary<(ClassLayout Class, int Interface), int> thunkedMembers = [];
    private int itablesArray = -1;

    private static bool IsSourceInterface(INamedTypeSymbol type) =>
        type is { TypeKind: TypeKind.Interface } && IsModuleDefined(type);

    public bool TryInterface(ITypeSymbol? type, out InterfaceLayout layout)
    {
        layout = null!;
        return type is INamedTypeSymbol named && interfaces.TryGetValue(named, out layout!);
    }

    public int ObjectHeap => objectHeap;

    public int ObjectVTable => objectVTable;

    public int ITables => itablesArray;

    private void EnsureObjectRoot()
    {
        if (objectHeap < 0)
        {
            objectVTable = AddType(null);
            objectHeap = AddType(TypeDefinition.Struct(
                "object", [new(WType.NonNullRef(objectVTable), Mutable: false)], final: false));
        }
    }

    // An interface's identity: its id and itable type. `symbol` is a
    // declared interface or a closed instantiation of a generic one.
    private void RegisterInterface(INamedTypeSymbol symbol)
    {
        // A base interface over this one (IEquatable<IShape>) names it in
        // its members' signatures, so it is adopted once this one is known.
        var overThis = new List<INamedTypeSymbol>();
        foreach (var baseInterface in symbol.Interfaces.Select(Unnamed).OfType<INamedTypeSymbol>())
        {
            if (IsAdoptedInterface(baseInterface))
            {
                if (baseInterface.TypeArguments.Any(argument => SymbolEqualityComparer.Default.Equals(argument, symbol)))
                {
                    overThis.Add(baseInterface);
                }
                else
                {
                    EnsureAdoptedInterface(baseInterface);
                }
            }
            else if (!IsSourceInterface(baseInterface) && !IsMarkerInterface(baseInterface))
            {
                throw CompileError.At(symbol,
                    $"Base interface '{baseInterface.ToDisplayString()}' is unsupported; "
                    + "an interface may extend only source interfaces and the enumeration interfaces.");
            }
        }

        if (!interfaces.ContainsKey(symbol))
        {
            EnsureObjectRoot();
            interfaces.Add(symbol, new InterfaceLayout(symbol, interfaces.Count, ITableType(symbol)));
            interfaceOrder.Add(symbol);
        }

        foreach (var baseInterface in overThis)
        {
            EnsureAdoptedInterface(baseInterface);
        }
    }

    // An interface's itable type: its own, or, for a shared instantiation,
    // its canonical form's, which every instantiation of that form shares
    // (Frontend.Sharing).
    private readonly Dictionary<INamedTypeSymbol, int> sharedITables = new(SymbolEqualityComparer.Default);

    private int ITableType(INamedTypeSymbol symbol)
    {
        if (!sharing)
        {
            return AddType(null);
        }

        var canonical = Canonical(symbol);
        if (!sharedITables.TryGetValue(canonical, out int table))
        {
            table = AddType(null);
            sharedITables.Add(canonical, table);
        }

        return table;
    }

    // One thunk per interface member and implementation, for the itables of
    // every concrete class. Discovery calls this until nothing is new; the
    // members of each class's itables seen once are not looked at again.
    private void RegisterInterfaceThunks()
    {
        foreach (var layout in layouts.Values.Concat(boxes.Values).Where(layout => !layout.Symbol.IsAbstract).ToList())
        {
            foreach (var implemented in SourceInterfaces(layout.Symbol))
            {
                var itable = interfaces[implemented];
                thunkedMembers.TryGetValue((layout, itable.Id), out int seen);
                thunkedMembers[(layout, itable.Id)] = itable.Members.Count;
                for (int index = seen; index < itable.Members.Count; index++)
                {
                    var member = itable.Members[index];
                    var implementation = Implementation(layout, member);
                    if (thunkIds.ContainsKey((member, implementation))
                        || implementation.ContainingType.TypeKind == TypeKind.Interface)
                    {
                        // A default body is the itable's function itself.
                        continue;
                    }

                    // A box's thunk calls the struct's method on the
                    // storage it holds.
                    thunkIds.Add((member, implementation), methods.Count);
                    var (parameters, result) = SignatureShape(itable.MemberTypes[index]);
                    methods.Add(new(
                        implementation,
                        $"{member.ToDisplayString()} => {implementation.ToDisplayString()}",
                        parameters,
                        result,
                        false,
                        implementation.ContainingType,
                        layout.IsBox ? MethodPlanKind.BoxThunk : MethodPlanKind.InterfaceThunk,
                        Substitution.Empty));
                }
            }
        }
    }

    // The method a class runs for an interface member. An automatic property
    // is otherwise a field access; implementing an interface gives its
    // accessor a function too.
    private IMethodSymbol Implementation(ClassLayout layout, IMethodSymbol member)
    {
        var found = layout.Symbol.FindImplementationForInterfaceMember(member) as IMethodSymbol;
        if (found is null
            && VarianceSource(DirectlyImplemented(layout.Symbol), member.ContainingType) is { } source)
        {
            // By variance: what the class runs for the member of the
            // interface it implements that converts to this one.
            var sourceMember = source.GetMembers(member.Name).OfType<IMethodSymbol>()
                .First(candidate => SymbolEqualityComparer.Default.Equals(candidate.OriginalDefinition, member.OriginalDefinition));
            found = layout.Symbol.FindImplementationForInterfaceMember(sourceMember) as IMethodSymbol;
        }

        if (found is not { } implementation
            || (implementation.IsAbstract && implementation.ContainingType.TypeKind == TypeKind.Interface))
        {
            throw new CompileError(
                $"'{layout.Symbol.ToDisplayString()}' has no member implementing '{member.ToDisplayString()}'.");
        }

        EnsureMethod(implementation, Substitution.Empty);
        if (ScalarOf(implementation.ContainingType) is not null && ShimOf(implementation) is { } shim)
        {
            // A boxed number's member: its shim.
            EnsureMethod(shim, Substitution.Empty);
        }

        return implementation;
    }

    // What a static abstract or virtual interface member runs as for a
    // type: the type's implementation, or the member's own default body.
    public IMethodSymbol StaticImplementation(ITypeSymbol type, IMethodSymbol member)
    {
        var definition = member.IsGenericMethod ? member.ConstructedFrom : member;
        var implementation = type.FindImplementationForInterfaceMember(definition) as IMethodSymbol
                             ?? (definition.IsAbstract ? null : definition)
                             ?? throw Error($"'{type.ToDisplayString()}' does not implement '{member.ToDisplayString()}'.");
        return member.IsGenericMethod ? implementation.Construct([.. member.TypeArguments]) : implementation;
    }

    public int Thunk(IMethodSymbol member, IMethodSymbol implementation) =>
        imports.Count + thunkIds[(member, implementation)];

    // A class's itables, as the constant expression that starts its vtable.
    // An itable member's function is kept only where code calls the
    // member through an interface (its SlotUse); the others are null.
    private void WriteITables(ClassLayout layout, WasmWriter code, List<Relocation> relocations, Func<IMethodSymbol, bool> used)
    {
        var implemented = SourceInterfaces(layout.Symbol).Select(type => interfaces[type]).ToList();
        int count = implemented.Count == 0 ? 0 : implemented.Max(entry => entry.Id) + 1;
        for (int id = 0; id < count; id++)
        {
            if (implemented.Find(entry => entry.Id == id) is not { } itable)
            {
                code.Byte(0xd0); // ref.null
                code.Signed(WType.StructHeap);
                continue;
            }

            for (int member = 0; member < itable.Members.Count; member++)
            {
                if (!used(itable.Members[member]))
                {
                    code.Byte(0xd0); // ref.null
                    code.Signed(itable.MemberTypes[member]);
                    continue;
                }

                code.Byte(0xd2); // ref.func
                relocations.Add(new(code.Length, RelocationKind.FunctionReference, ITableFunction(layout, itable.Members[member])));
            }

            code.Gc(0, itable.Table); // struct.new
        }

        code.Gc(8, itablesArray, count); // array.new_fixed
    }

    private int ITableFunction(ClassLayout layout, IMethodSymbol member)
    {
        var implementation = Implementation(layout, member);
        return implementation.ContainingType.TypeKind == TypeKind.Interface
            ? MethodIndex(implementation)
            : Thunk(member, implementation);
    }

    // A concrete class's itable members, as the slots pruning keeps where
    // code dispatches through them: the member, its function and type.
    private IEnumerable<(IMethodSymbol Root, int Function, int Type)> ITableSlots(ClassLayout layout)
    {
        if (interfaces.Count == 0)
        {
            yield break;
        }

        foreach (var itable in SourceInterfaces(layout.Symbol).Select(type => interfaces[type]))
        {
            for (int member = 0; member < itable.Members.Count; member++)
            {
                yield return (itable.Members[member], ITableFunction(layout, itable.Members[member]), itable.MemberTypes[member]);
            }
        }
    }

    // What a call on an interface-typed receiver runs: the member's slot of
    // the itable its class holds for the interface.
    private CallTarget InterfaceCall(IMethodSymbol method)
    {
        var layout = interfaces[method.ContainingType];
        int member = layout.Members.FindIndex(candidate => SymbolEqualityComparer.Default.Equals(candidate, method));
        if (member < 0)
        {
            throw Error(UnsupportedCall(method, "no member of its interface's itable"));
        }

        return new(
            -1,
            objectHeap,
            objectVTable,
            member,
            layout.MemberTypes[member],
            Interface: layout.Id,
            Table: layout.Table,
            Use: new SlotUse(method, method.ContainingType),
            EnumerableElement: IsEnumerableInterface(method.ContainingType) && method.Name == "GetEnumerator"
                ? ((INamedTypeSymbol)method.ContainingType).TypeArguments[0]
                : null,
            ArrayCall: ArrayImplementation(method) is not null ? method : null,
            ObjectArrayCall: ObjectArrayHelper(method));
    }
}
