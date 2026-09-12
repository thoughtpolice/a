// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The Wasm shape of every delegate type with one lowered Invoke signature:
// `$D = sub (struct (field fn (ref $F)) (field type i32) (field method i32)
// (field target (ref null eq)))`, where `$F = func (self: ref null $D,
// parameters...) -> result`. Delegate types whose signatures lower alike
// share it. A combined (multicast) delegate is a `$M <: $D` whose function
// calls each of its list in turn; it and the functions that combine,
// remove and compare delegates of the layout exist once code needs them.
internal sealed record DelegateLayout(int Heap, int Function, Signature Invoke)
{
    public int Multi { get; set; } = -1;

    public int List { get; set; } = -1;

    public int Invoker { get; set; } = -1;

    public int Combine { get; set; } = -1;

    public int Remove { get; set; } = -1;

    public int Equal { get; set; } = -1;
}

// Delegates. A delegate value is a `$D` holding the function that runs it,
// the ids of its delegate type and of the method it stands for, and its
// target: a closure's environment, a method group's object, or null. The
// function receives the delegate itself to reach its target. Invocation
// checks for null, then calls `fn` with call_ref. Two delegates are equal,
// as the CLR's are, when their types, methods and targets are, or when
// both are combined of equal delegates in order.
internal sealed partial class Frontend
{
    public const int DelegateTypeField = 1;
    public const int DelegateMethodField = 2;
    public const int DelegateTargetField = 3;
    public const int DelegateListField = 4;

    private readonly Dictionary<ITypeSymbol, int> delegateTypeIds = new(SymbolEqualityComparer.Default);
    private readonly List<ITypeSymbol> delegateTypes = [];
    private readonly Dictionary<object, int> delegateMethodIds = [];

    // A delegate type's id, which Equals compares and ToString names.
    public int DelegateTypeId(ITypeSymbol type)
    {
        if (!delegateTypeIds.TryGetValue(type, out int id))
        {
            id = delegateTypes.Count;
            delegateTypeIds.Add(type, id);
            delegateTypes.Add(type);
        }

        return id;
    }

    public IReadOnlyList<ITypeSymbol> DelegateTypes => delegateTypes;

    // The id of what a delegate calls: a lambda, or a method (a virtual
    // one by its slot, since the target picks the override).
    public int DelegateMethodId(object key)
    {
        if (!delegateMethodIds.TryGetValue(key, out int id))
        {
            id = delegateMethodIds.Count;
            delegateMethodIds.Add(key, id);
        }

        return id;
    }

    // A method group's method id: a virtual method's by its slot unless
    // called through base.
    public int MethodGroupId(IMethodSymbol method, bool baseAccess, Substitution generic)
    {
        object key = !baseAccess && IsDispatched(method) ? SlotRoot(method) : method;
        return DelegateMethodId(key);
    }

    public bool IsArrayHeap(int heap) =>
        (refArrayHeap >= 0 && heap == refArrayHeap) || heapIds.Any(pair => pair.Key is IArrayTypeSymbol && pair.Value == heap);

    // What the object members of delegates need once code compares objects.
    private void FinishDelegates()
    {
        if (objectMemberDemands.Contains("Equals"))
        {
            foreach (var layout in delegateLayouts.Values.ToList())
            {
                EnsureDelegateEqual(layout);
            }
        }
    }

    // Conversions of delegates by variance: a Func<Bird> as a
    // Func<Animal>, an Action<Animal> as an Action<Bird>. Delegate types
    // share a layout only by their lowered signatures, so the converted
    // delegate is a new one of the target's layout forwarding to the
    // original (as the CLR's is the original itself, the two are not
    // equal). By layouts, the function that converts.
    private readonly Dictionary<(int From, int To), int> delegateVariance = [];

    private bool delegateTypeChecks;

    // How many of the delegate types RegisterDelegateVariance has paired.
    private int pairedDelegates;

    // The function that throws for delegates of two types combined or
    // removed, once delegates convert by variance.
    public int? DelegateTypeMismatch =>
        delegateTypeChecks ? MethodIndex(RuntimeMethod("DelegateChecks", "TypeMismatch", 0)) : null;

    public int? DelegateVariance(int from, int to) =>
        delegateVariance.TryGetValue((from, to), out int function) ? imports.Count + function : null;

    // Each pair of the module's delegate types one of which converts to
    // the other by variance, where their layouts differ. Discovery calls
    // this until nothing is new, and a pair of types it has seen once
    // has nothing more to register.
    private void RegisterDelegateVariance()
    {
        var known = delegateTypes.OfType<INamedTypeSymbol>().ToList();
        int seen = pairedDelegates;
        pairedDelegates = known.Count;
        for (int sourceIndex = 0; sourceIndex < known.Count; sourceIndex++)
        {
            var source = known[sourceIndex];
            for (int targetIndex = sourceIndex < seen ? seen : 0; targetIndex < known.Count; targetIndex++)
            {
                var target = known[targetIndex];
                if (SymbolEqualityComparer.Default.Equals(source, target)
                    || !SymbolEqualityComparer.Default.Equals(source.OriginalDefinition, target.OriginalDefinition)
                    || !source.OriginalDefinition.TypeParameters.Any(parameter => parameter.Variance != VarianceKind.None)
                    || ClassifyConversion(source, target) is not { IsImplicit: true, IsReference: true })
                {
                    continue;
                }

                var from = DelegateOf(source);
                var to = DelegateOf(target);
                if (sharing && from.Heap == to.Heap && !delegateTypeChecks)
                {
                    // One canonical layout (Frontend.Sharing): the converted
                    // delegate is the original, as the CLR's is, but still
                    // of its own type.
                    EnsureRuntimeMethod("DelegateChecks", "TypeMismatch", 0);
                    delegateTypeChecks = true;
                }

                if (from.Heap == to.Heap || delegateVariance.ContainsKey((from.Heap, to.Heap)))
                {
                    continue;
                }

                // Combining or removing delegates of two types throws.
                EnsureRuntimeMethod("DelegateChecks", "TypeMismatch", 0);
                delegateTypeChecks = true;
                int forward = methods.Count;
                methods.Add(new(
                    null, $"<delegate forward {from.Heap} {to.Heap}>", [WType.Ref(to.Heap), .. to.Invoke.Parameters],
                    to.Invoke.Result, true, null, MethodPlanKind.DelegateForward, Substitution.Empty,
                    Bound: to.Heap, VarianceSource: from.Heap));
                delegateVariance.Add((from.Heap, to.Heap), methods.Count);
                methods.Add(new(
                    null, $"<delegate variance {from.Heap} {to.Heap}>", [WType.Ref(from.Heap)], WType.Ref(to.Heap), true,
                    null, MethodPlanKind.DelegateVariance, Substitution.Empty, Bound: to.Heap, VarianceSource: from.Heap,
                    IlGroup: forward));
            }
        }
    }

    public DelegateLayout? DelegateLayoutOfHeap(int heap) =>
        delegateLayouts.Values.FirstOrDefault(layout => layout.Heap == heap || layout.Multi == heap);

    public IEnumerable<DelegateLayout> DelegateLayouts => delegateLayouts.Values;

    // What combining delegates of a layout needs: the multicast subtype,
    // its list and invoking function, and the combine function.
    public DelegateLayout EnsureMulticast(DelegateLayout layout)
    {
        if (layout.Multi >= 0)
        {
            return layout;
        }

        if (frozen)
        {
            throw new InternalCompilerError("delegates were combined after discovery.");
        }

        layout.List = AddType(TypeDefinition.Array("delegates", new(WType.Ref(layout.Heap), Mutable: true)));
        layout.Multi = AddType(TypeDefinition.Struct(
            "multicast delegate",
            [
                new(WType.NonNullRef(layout.Function), Mutable: false),
                new(WType.I32, Mutable: false),
                new(WType.I32, Mutable: false),
                new(WType.Ref(EqHeap), Mutable: false),
                new(WType.NonNullRef(layout.List), Mutable: false),
            ],
            layout.Heap));
        layout.Invoker = AddDelegateHelper("invoke", MethodPlanKind.DelegateInvoker, layout,
            [WType.Ref(layout.Heap), .. layout.Invoke.Parameters], layout.Invoke.Result);
        layout.Combine = AddDelegateHelper("combine", MethodPlanKind.DelegateCombine, layout,
            [WType.Ref(layout.Heap), WType.Ref(layout.Heap)], WType.Ref(layout.Heap));
        return layout;
    }

    // Removing a delegate needs combining's and comparing's.
    public DelegateLayout EnsureDelegateRemove(DelegateLayout layout)
    {
        EnsureMulticast(layout);
        EnsureDelegateEqual(layout);
        if (layout.Remove < 0)
        {
            layout.Remove = AddDelegateHelper("remove", MethodPlanKind.DelegateRemove, layout,
                [WType.Ref(layout.Heap), WType.Ref(layout.Heap)], WType.Ref(layout.Heap));
        }

        return layout;
    }

    // op_Equality: both null, or equal.
    public DelegateLayout EnsureDelegateEqual(DelegateLayout layout)
    {
        if (layout.Equal < 0)
        {
            if (frozen)
            {
                throw new InternalCompilerError("delegates were compared after discovery.");
            }

            layout.Equal = AddDelegateHelper("equal", MethodPlanKind.DelegateEqual, layout,
                [WType.Ref(layout.Heap), WType.Ref(layout.Heap)], WType.I32);
        }

        return layout;
    }

    private int AddDelegateHelper(string name, MethodPlanKind kind, DelegateLayout layout, WType[] parameters, WType result)
    {
        int id = methods.Count;
        methods.Add(new(
            null, $"<delegate {name} {layout.Heap}>", parameters, result, true, null, kind, Substitution.Empty,
            Bound: layout.Heap));
        return imports.Count + id;
    }
    private readonly Dictionary<Signature, DelegateLayout> delegateLayouts = [];
    private readonly HashSet<INamedTypeSymbol> mappingDelegates = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<(IMethodSymbol Method, int Delegate, WType Receiver, bool BaseAccess, Substitution Generic), int>
        groupThunkIds = [];

    // Action, Func, Predicate, Comparison, and delegate types declared in
    // source.
    public static bool IsSupportedDelegate(ITypeSymbol? type) =>
        type is INamedTypeSymbol { TypeKind: TypeKind.Delegate } named
        && (IsModuleDefined(named)
            || (named.ContainingNamespace is { Name: "System", ContainingNamespace.IsGlobalNamespace: true }
                && named.Name is "Action" or "Func" or "Predicate" or "Comparison" or "Converter"));

    public DelegateLayout DelegateOf(ITypeSymbol type)
    {
        var named = (INamedTypeSymbol)type;
        if (!mappingDelegates.Add(named))
        {
            throw new CompileError($"Delegate type '{type.ToDisplayString()}' refers to itself; that is unsupported.");
        }

        try
        {
            // Of its canonical form's signature (Frontend.Sharing).
            var invoke = Canonical(named).DelegateInvokeMethod!;
            if (invoke.ReturnsByRef || invoke.ReturnsByRefReadonly || HasUnsupportedParameters(invoke))
            {
                throw new CompileError($"Delegate type '{type.ToDisplayString()}' has by-ref or optional parameters.");
            }

            var signature = new Signature(
                invoke.Parameters.Select(ParameterType).ToArray(),
                MapType(invoke.ReturnType));
            if (!delegateLayouts.TryGetValue(signature, out var layout))
            {
                int heap = AddType(null);
                int function = SignatureType([WType.Ref(heap), .. signature.Parameters], signature.Result);
                types[heap] = TypeDefinition.Struct(
                    "delegate",
                    [
                        new(WType.NonNullRef(function), Mutable: false),
                        new(WType.I32, Mutable: false),
                        new(WType.I32, Mutable: false),
                        new(WType.Ref(EqHeap), Mutable: false),
                    ],
                    final: false);
                layout = new(heap, function, signature);
                delegateLayouts.Add(signature, layout);
            }

            DelegateTypeId(named);
            return layout;
        }
        finally
        {
            mappingDelegates.Remove(named);
        }
    }

    // A delegate type's Invoke: a call through the delegate's function.
    private CallTarget DelegateCall(IMethodSymbol invoke)
    {
        var layout = DelegateOf(invoke.ContainingType);
        return new(-1, layout.Heap, Slot: 0, Signature: layout.Function);
    }

    // The same for a method, closed, bound to a receiver of a static type
    // (none for a static method), and called through base or not.
    public (int Function, int Bound) MethodGroupThunk(
        IMethodSymbol method,
        ITypeSymbol? receiverType,
        bool baseAccess,
        ITypeSymbol delegateType,
        Substitution generic)
    {
        // System.Object's virtual members (as object, ValueType, Enum, a
        // scalar or Exception declare them): what a virtual call of the
        // member on the target runs, the object helpers' dispatch
        // (`ldvirtftn object::ToString`, or `ldftn int::ToString` after the
        // `box` C# makes of a value), as ldvirtftn finds the override.
        bool objectMember = !method.IsStatic && IsObjectMember(method);
        if (objectMember)
        {
            DemandObjectMember(method.Name);
            if (method.Name == "Equals" && method.Parameters[0].Type.IsValueType)
            {
                // A scalar's Equals(T), whose argument the helper takes boxed.
                EnsureBox(method.Parameters[0].Type);
            }
        }
        else if (!IsModuleDefined(method))
        {
            // A framework method runs as its shim, a receiver first.
            method = ShimOf(method) ?? throw Error($"A method group over {UnsupportedCall(method)[..^1]}; use a lambda.");
            EnsureMethod(method, Substitution.Empty);
        }

        var layout = DelegateOf(delegateType);
        // The target's heap type, which the thunk casts the delegate's
        // target to: the receiver. A struct's method is bound to the box
        // C# made of the value (`box` before `ldftn`), and runs on the
        // storage the box holds, as a box's interface methods do.
        WType receiver = default;
        int bound = -1;
        if (objectMember)
        {
            receiver = ObjectType();
            bound = receiver.Heap;
            receiverType = ObjectSymbol;
        }
        else if (!method.IsStatic && IsStruct(method.ContainingType))
        {
            bound = EnsureBox(method.ContainingType).Heap;
            receiver = WType.Ref(bound);
            receiverType = method.ContainingType;
        }
        else if (!method.IsStatic)
        {
            receiver = MapType(receiverType);
            bound = receiver.Heap;
        }

        var enclosing = Substitution.Empty;
        var key = (method, layout.Heap, receiver, baseAccess, enclosing);
        if (!groupThunkIds.TryGetValue(key, out int id))
        {
            id = methods.Count;
            groupThunkIds.Add(key, id);
            methods.Add(new(
                method,
                $"{method.ToDisplayString()} [delegate]",
                [WType.Ref(layout.Heap), .. layout.Invoke.Parameters],
                layout.Invoke.Result,
                true,
                (INamedTypeSymbol?)Substitute(generic, method.ContainingType),
                MethodPlanKind.MethodGroupThunk,
                enclosing,
                Bound: bound,
                Receiver: receiverType,
                BaseAccess: baseAccess));
        }

        return (imports.Count + id, bound);
    }
}
