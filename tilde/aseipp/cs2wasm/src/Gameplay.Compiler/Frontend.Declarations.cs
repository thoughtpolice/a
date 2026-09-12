// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Registration: the functions and storage of the classes, fields,
// constructors and methods code reaches, and which Wasm entity each becomes
// (the imported members come from Frontend.Import).
internal sealed partial class Frontend
{
    private readonly Dictionary<INamedTypeSymbol, int> nextFieldIndex = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<INamedTypeSymbol, IMethodSymbol> staticConstructors = new(SymbolEqualityComparer.Default);
    private readonly HashSet<INamedTypeSymbol> membersRegistered = new(SymbolEqualityComparer.Default);
    // Classes in the order discovery registered them, then generic
    // instantiations in the order code reached them; the eager static
    // initializers run in this order.
    private readonly List<INamedTypeSymbol> classOrder = [];

    private const int MaximumTypes = 65536;
    private const int MaximumMethods = 65536;
    private const int MaximumGlobals = 65536;

    // Registers a class's fields and members, after its base's: a class
    // when discovery reaches it, a generic class once code mentions an
    // instantiation. A generic class's members other than virtual
    // ones get functions only when reached.
    private void RegisterMembers(INamedTypeSymbol type)
    {
        if (!membersRegistered.Add(type))
        {
            return;
        }

        if (UsesRepresentation(type))
        {
            // Its canonical form's fields and slots come first.
            RepresentationOf(type);
        }

        if (SourceBase(type) is { } baseType)
        {
            if (IsGenericInstance(baseType))
            {
                EnsureClassInstance(baseType);
            }

            RegisterMembers(baseType);
        }

        foreach (var implemented in Implemented(type).Where(IsGenericInstance))
        {
            EnsureInterfaceInstance(implemented);
        }

        var generic = SubstitutionOf(type);
        if (!generic.IsEmpty || IsOnDemandType(type))
        {
            classOrder.Add(type);
        }

        if (adoptEnumerables && type.TypeKind != TypeKind.Interface)
        {
            foreach (var adopted in Implemented(type).Where(candidate => IsAdoptedInterface(candidate) && !IsLazilyAdopted(candidate)))
            {
                EnsureAdoptedInterface(adopted);
            }
        }

        bool deferring = deferMembers;
        deferMembers = !generic.IsEmpty || IsRuntimeType(type) || HasCanonicalAbi(type);
        try
        {
            StartMembers(type);
            if (type is { IsRecord: true, TypeKind: TypeKind.Class })
            {
                recordClasses.Add(type);
            }

            RegisterImportedMembers(type, generic);

            // The object members code already calls, of a record class
            // registered after the calls.
            if (type is { IsRecord: true, TypeKind: TypeKind.Class })
            {
                foreach (var (slot, receiver) in objectSlotDemands.ToList())
                {
                    if (DerivesFrom(type, receiver) && ObjectOverride(type, ObjectMethod(slot)) is { } overriding)
                    {
                        EnsureMethod(overriding, Substitution.Empty);
                    }
                }
            }
        }
        finally
        {
            deferMembers = deferring;
        }
    }

    private void RegisterField(IFieldSymbol field)
    {
        if (!field.IsStatic && IsStruct(field.ContainingType))
        {
            // Laid out with its struct (see StructLayout).
            MapType(field.Type);
            return;
        }

        RegisterStorage(field, field.Type);
    }

    private void RegisterStorage(ISymbol storage, ITypeSymbol type)
    {
        MapType(type);
        if (!storage.IsStatic && UsesRepresentation(storage.ContainingType))
        {
            // Its canonical form's field (see FieldIndex).
            return;
        }

        if (storage.IsStatic)
        {
            globalIds.Add(storage, globals.Count);
            globals.Add((storage, MapType(type)));
            return;
        }

        nextFieldIndex.TryGetValue(storage.ContainingType, out int index);
        nextFieldIndex[storage.ContainingType] = index + 1;
        fieldIds.Add(storage, index);
    }

    // `ref` and `out` parameters are references to the caller's storage; `in`,
    // `params` and optional parameters are unsupported.
    // `in` and `ref readonly` parameters are values here, which nothing
    // can tell apart from a reference to storage the callee cannot change;
    // params arrays and optional parameters are the caller's.
    private static bool HasUnsupportedParameters(IMethodSymbol method) => method.Parameters.Any(parameter =>
        parameter.RefKind is not (RefKind.None or RefKind.Ref or RefKind.Out or RefKind.In or RefKind.RefReadOnlyParameter)
        || (parameter.IsParams && parameter.Type is not IArrayTypeSymbol
            && !(parameter.Type is INamedTypeSymbol span && IsFrameworkSpan(span)))
        || parameter.GetAttributes().Length != 0);

    // A method's function. A member of a generic instantiation gets one only
    // once something reaches it (see EnsureMethod), unless it is virtual.
    private static bool IsCompilerGenerated(ISymbol symbol) =>
        symbol.GetAttributes().Any(attribute => attribute.AttributeClass is
        {
            Name: "CompilerGeneratedAttribute",
            ContainingNamespace: { Name: "CompilerServices", ContainingNamespace: { Name: "Runtime", ContainingNamespace.Name: "System" } },
        });

    private void RegisterMethod(
        IMethodSymbol symbol,
        MethodPlanKind kind,
        Substitution generic,
        bool defer = true)
    {
        // A runtime struct's overrides too: only a box dispatches them. And
        // what C# synthesizes for a record, on demand: its overrides of
        // object's members, which DemandObjectSlot registers once code calls
        // them, and its members no virtual call reaches.
        if (defer && (((deferMembers || HasCanonicalAbi(symbol))
                       && (!IsDispatched(symbol) || (IsStruct(symbol.ContainingType) && IsRuntimeType(symbol.ContainingType)))
                       && !symbol.IsImplicitlyDeclared)
                      || (symbol.ContainingType.IsRecord && IsCompilerGenerated(symbol)
                          && (!IsDispatched(symbol)
                              || (symbol.IsOverride && symbol.ContainingType.TypeKind == TypeKind.Class && ObjectSlot(SlotRoot(symbol)) >= 0)))))
        {
            deferredMethods[symbol] = () => RegisterMethod(
                symbol, kind, generic, defer: false);
            return;
        }

        if (TryRegisterShared(symbol, kind))
        {
            // Its canonical form's shared code (Frontend.SharedCode).
            return;
        }

        var parameters = PlanParameters(symbol);
        // Imported, the method's body is its IL.
        var ilCode = kind is MethodPlanKind.Ordinary or MethodPlanKind.Constructor
            ? kind == MethodPlanKind.Ordinary && IsRuntimeAsync(symbol) ? RuntimeAsyncOf(symbol).Kickoff : IlOf(symbol)
            : null;
        void Add(Dictionary<IMethodSymbol, int> ids, string name, WType? receiver, WType result)
        {
            ids.Add(symbol, methods.Count);
            methods.Add(new(
                symbol,
                name,
                receiver is { } type ? [type, .. parameters] : parameters.ToArray(),
                result,
                receiver is null,
                symbol.ContainingType,
                kind,
                generic,
                Il: ilCode));
        }

        if (IsStruct(symbol.ContainingType) && !symbol.IsStatic)
        {
            // A struct's members, constructors included, take `this` by
            // reference: as the box of the storage they run on.
            var layout = StructOf(symbol.ContainingType);
            Add(boxMethodIds, symbol.ToDisplayString() + " [box]", WType.Ref(layout.Box), PlanResult(symbol));
            return;
        }

        Add(methodIds, symbol.ToDisplayString(), symbol.IsStatic ? null : ReceiverType(symbol), PlanResult(symbol));
    }

    // A parameter's Wasm type: its value, or for `ref` and `out` the
    // reference to the caller's storage. A `ref readonly`
    // parameter is a reference too (Unsafe.Add of it names the storage's
    // neighbours, as Vector128.LoadUnsafe's does); an `in` parameter is
    // its value.
    private WType ParameterType(IParameterSymbol parameter) => ParameterType(parameter, Substitution.Empty);

    public WType ParameterType(IParameterSymbol parameter, Substitution generic)
    {
        var type = Substitute(generic, parameter.Type);
        return IsReferenceParameter(parameter) ? RefParameterType(type) : MapType(type);
    }

    public static bool IsReferenceParameter(IParameterSymbol parameter) =>
        parameter.RefKind is RefKind.Ref or RefKind.Out || parameter.RefKind == RefKind.RefReadOnlyParameter;
}
