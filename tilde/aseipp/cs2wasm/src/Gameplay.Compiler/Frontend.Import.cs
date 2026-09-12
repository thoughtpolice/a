// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// The CIL importer's declarations (see docs/IMPORTER.md): the sources,
// compiled by the pinned Roslyn against .NET's reference assemblies, and the
// gameplay CoreLib (Frontend.CoreLib) are read back as metadata symbols, and
// every type and member comes from those symbols, every body from IL.
internal sealed partial class Frontend
{
    // The methods of generic definitions, instantiated when code reaches
    // them.
    private readonly HashSet<IMethodSymbol> importedGenericMethods = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IMethodSymbol, IlCode?> ilBodies = new(SymbolEqualityComparer.Default);


    // An error at an IL method, located by the PDB where it can be.
    public CompileError ErrorAt(IMethodSymbol? method, int offset, string message)
    {
        if (method is not null && IlModuleOf(method)?.Location(method, offset) is { } location)
        {
            return new CompileError($"{location}: GP1000: {message}");
        }

        return new CompileError(method is null ? message : $"{method.ToDisplayString()}+IL_{offset:X4}: GP1000: {message}");
    }

    private CompileError ErrorAt(ISymbol symbol, string message)
    {
        var method = symbol as IMethodSymbol ?? symbol.ContainingType?.GetMembers().OfType<IMethodSymbol>().FirstOrDefault();
        if (method is not null && IlModuleOf(method)?.Location(method, 0) is { } location)
        {
            return new CompileError($"{location}: GP1000: {symbol.ToDisplayString()}: {message}");
        }

        return new CompileError($"{symbol.ToDisplayString()}: GP1000: {message}");
    }

    // A method's IL, decoded once per definition.
    public IlCode? IlOf(IMethodSymbol method)
    {
        var definition = method.OriginalDefinition;
        if (definition.IsGenericMethod)
        {
            definition = definition.ConstructedFrom;
        }

        if (!ilBodies.TryGetValue(definition, out var code))
        {
            var module = IlModuleOf(definition);
            code = module?.Body(definition) is { } body ? new IlCode(body, module) : null;
            ilBodies.Add(definition, code);
        }

        return code;
    }

    private readonly Dictionary<IMethodSymbol, IFieldSymbol?> autoGetters = new(SymbolEqualityComparer.Default);

    // The backing field an auto-property's getter only reads (`ldarg.0;
    // ldfld; ret`), when no override can replace it: a call of it is a
    // read of the field.
    public IFieldSymbol? AutoGetterField(IMethodSymbol method)
    {
        if (method is not { MethodKind: MethodKind.PropertyGet, IsStatic: false, IsAbstract: false }
            || (IsDispatched(method) && !(method.IsSealed || method.ContainingType.IsSealed || method.ContainingType.IsValueType))
            || !IsModuleDefined(method) || !IsCompilerGenerated(method))
        {
            return null;
        }

        if (!autoGetters.TryGetValue(method, out var field))
        {
            field = IlOf(method) is { Instructions: [{ OpCode: ILOpCode.Ldarg, Operand: 0 }, { OpCode: ILOpCode.Ldfld } load, { OpCode: ILOpCode.Ret }] } code
                    && code.Module.Resolve(load.Token, IlContext(method)) is IFieldSymbol backing
                ? Substitute(SubstitutionOf(method.ContainingType), backing)
                : null;
            autoGetters.Add(method, field);
        }

        return field;
    }

    // The type parameters a method's IL names.
    public static IlGenericContext IlContext(IMethodSymbol method) =>
        IlGenericContext.Of(method.ContainingType.OriginalDefinition, method.OriginalDefinition);

    // `<PrivateImplementationDetails>` and its data blobs: what array
    // initializers and string switches reach.
    private static bool IsPrivateImplementation(INamedTypeSymbol type)
    {
        for (INamedTypeSymbol? current = type; current is not null; current = current.ContainingType)
        {
            if (current.Name == "<PrivateImplementationDetails>")
            {
                return true;
            }
        }

        return false;
    }

    // A field whose initial data is in the image (an array initializer's).
    public bool HasInitialData(IFieldSymbol field) => HasData(field);

    private bool HasData(IFieldSymbol field)
    {
        if (!field.IsStatic || field.OriginalDefinition.MetadataToken == 0 || IlModuleOf(field) is not { } module)
        {
            return false;
        }

        var handle = (FieldDefinitionHandle)MetadataTokens.EntityHandle(field.OriginalDefinition.MetadataToken);
        return (module.Reader.GetFieldDefinition(handle).Attributes & System.Reflection.FieldAttributes.HasFieldRVA) != 0;
    }

    private bool IsBeforeFieldInit(INamedTypeSymbol type)
    {
        var handle = (TypeDefinitionHandle)MetadataTokens.EntityHandle(type.OriginalDefinition.MetadataToken);
        return (IlModuleOf(type)!.Reader.GetTypeDefinition(handle).Attributes & System.Reflection.TypeAttributes.BeforeFieldInit) != 0;
    }

    // Declaration discovery from metadata: Discover's counterpart.
    private void DiscoverImported()
    {
        // Two-pass exception handling (see Frontend.Filters) when any body
        // has a filter.
        StartTwoPass(il!.HasFilters() || (libraryModules ?? []).Any(library => library.HasFilters()));
        var classes = new List<INamedTypeSymbol>();
        var interfaceTypes = new List<INamedTypeSymbol>();
        // The module's types (its libraries' first, which are its own as
        // if its sources declared them: Frontend.Libraries), and the
        // CoreLib's own (its runtime layer), which, as the runtime layer's
        // in the one assembly otherwise, mostly reach the module only once
        // code uses them.
        IEnumerable<INamedTypeSymbol> moduleTypes = (libraryModules ?? [])
            .SelectMany(library => library.Types().OrderBy(type => type.MetadataToken))
            .Concat(il.Types().OrderBy(type => type.MetadataToken))
            .Concat(coreIl.Types().Where(IsModuleDefined).OrderBy(type => type.MetadataToken));

        foreach (var framework in frameworkModules ?? [])
        {
            moduleTypes = moduleTypes.Concat(framework.Types().OrderBy(type => type.MetadataToken));
        }

        foreach (var type in moduleTypes)
        {
            if (type.Name == "<Module>" || IsBindingType(type) || IsPrivateImplementation(type)
                || (type.ContainingType is { } outer && IsBindingType(outer))
                || IsAttributeClass(type))
            {
                // Attribute classes are metadata: what a source generator
                // or the compiler reads, never a module's values (code that
                // makes one is refused where it does, IsMetadataOnly).
                continue;
            }

            if (type.IsRefLikeType && !IsRuntimeType(type))
            {
                throw ErrorAt(type, "Structs must not be `ref`.");
            }

            switch (type.TypeKind)
            {
                case TypeKind.Class:
                    if (type.BaseType is { SpecialType: not SpecialType.System_Object } baseType
                        && !IsSourceClass(baseType) && !IsFrameworkException(baseType))
                    {
                        throw ErrorAt(type,
                            $"Base class '{baseType.ToDisplayString()}' is unsupported; "
                            + "a base class must be a source class or a BCL exception.");
                    }

                    if (!type.IsGenericType && !IsOnDemandType(type))
                    {
                        classes.Add(type);
                        if (!type.IsStatic)
                        {
                            RegisterClass(type);
                        }
                    }

                    break;
                case TypeKind.Struct:
                    if (!type.IsGenericType && !(IsRuntimeType(type) && IsOnDemandType(type)))
                    {
                        classes.Add(type);
                    }

                    break;
                case TypeKind.Interface:
                    // Variant ones too (see Frontend.Implemented). Not the
                    // CoreLib's of static members only (dotnet/runtime's
                    // BigInteger's IBitwiseOp, a constraint of generic
                    // methods), which have nothing to dispatch.
                    if (type.IsGenericType
                        || (InCoreLibrary(type) && type.GetMembers().All(member => member.IsStatic)))
                    {
                        break;
                    }

                    RegisterInterface(type);
                    interfaceTypes.Add(type);
                    break;
                case TypeKind.Enum:
                    if (ScalarOf(type) is null or Scalar.Bool or Scalar.Char or Scalar.F32 or Scalar.F64)
                    {
                        throw ErrorAt(type, "Enum underlying types must be integer types.");
                    }

                    break;
            }
        }

        foreach (var type in interfaceTypes)
        {
            RegisterImportedInterfaceMembers(type);
        }

        var sourceOrder = classes.Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default).ToList();
        classOrder.AddRange(sourceOrder);
        foreach (var symbol in sourceOrder.OrderBy(Depth))
        {
            RegisterMembers(symbol);
        }

        DrainInstances();
        RegisterInterfaceThunks();
        if (methods.Count == 0)
        {
            throw new CompileError("Expected at least one method.");
        }

        if (CovariantArrays)
        {
            // What a covariant store throws, and the function checking one.
            EnsureRuntimeMethod("ArrayChecks", "Mismatch", 0);
            RegisterStoreCheck();
        }

        int nextPlan = 0;
        while (true)
        {
            DrainInstances();
            RegisterInterfaceThunks();
            EnsureStringHelpers();
            DrainGenericDispatch();
            DrainReimplementations();
            DrainEnumerableSources();
            DrainObjectArrayMembers();
            DrainCovariantArrays();
            RegisterDelegateVariance();
            DrainPendingRuntimeMethods();
            DrainSharedUses();
            DrainInstances();
            var plans = methods.Skip(nextPlan).Where(plan => plan.Il is not null && plan.Kind != MethodPlanKind.Selector).ToList();
            if (nextPlan == methods.Count)
            {
                break;
            }

            nextPlan = methods.Count;
            foreach (var plan in plans)
            {
                if (plan.Symbol is { } symbol && (InFramework(symbol) || IsCanonicalForm(symbol.ContainingType)))
                {
                    // A framework method its lowering cannot take (one of
                    // serialization's virtual members, say) is an error only
                    // if the module keeps it (Unlowered).
                    try
                    {
                        WalkIl(plan);
                    }
                    catch (CompileError error)
                    {
                        unlowered.TryAdd(plan, Located(plan, error));
                    }
                    catch (InternalCompilerError error) when (Environment.GetEnvironmentVariable("GAMEPLAYC_TRACE") is not null)
                    {
                        throw new InternalCompilerError($"{plan.Name}: {error.Message}");
                    }

                    continue;
                }

                try
                {
                    WalkIl(plan);
                }
                catch (InternalCompilerError error) when (Environment.GetEnvironmentVariable("GAMEPLAYC_TRACE") is not null)
                {
                    throw new InternalCompilerError($"{plan.Name}: {error.Message}");
                }
            }
        }

        ReviseSharing();
        FinishDiscovery();
    }

    // What an imported class's or struct's members are: its fields and the
    // methods with IL (property and event accessors are methods too).
    private void RegisterImportedMembers(INamedTypeSymbol type, Substitution generic)
    {
        foreach (var member in type.GetMembers())
        {
            switch (member)
            {
                case IFieldSymbol field:
                    if (field.IsConst || HasData(field) || (field.IsStatic && InFramework(field)))
                    {
                        // A framework assembly's static fields are
                        // registered where code uses them
                        // (RegisterUsedStatic).
                        continue;
                    }

                    if (field.RefKind != RefKind.None || field.IsFixedSizeBuffer)
                    {
                        throw ErrorAt(field, "Ref fields and fixed buffers are unsupported.");
                    }

                    if (InFramework(field) && !IsStruct(type))
                    {
                        // A framework class's field of a type the CoreLib
                        // cannot represent (SortedSet's SerializationInfo,
                        // for deserializing): left out, an error where code
                        // uses it.
                        try
                        {
                            MapType(field.Type);
                        }
                        catch (CompileError)
                        {
                            break;
                        }
                    }

                    MapType(field.Type);
                    RegisterField(field);
                    break;
                case IMethodSymbol method:
                    RegisterImportedMethod(method, generic);
                    break;
                case IEventSymbol eventSymbol when HasBackingField(eventSymbol):
                    // Roslyn's symbols do not show a field-like event's
                    // field: the event is its storage, as it is from source.
                    RegisterStorage(eventSymbol, eventSymbol.Type);
                    break;
            }
        }
    }

    private bool HasBackingField(IEventSymbol symbol)
    {
        var handle = (TypeDefinitionHandle)MetadataTokens.EntityHandle(symbol.ContainingType.OriginalDefinition.MetadataToken);
        var reader = IlModuleOf(symbol.ContainingType)!.Reader;
        return reader.GetTypeDefinition(handle).GetFields()
            .Any(field => reader.GetString(reader.GetFieldDefinition(field).Name) == symbol.Name);
    }

    private void RegisterImportedMethod(IMethodSymbol symbol, Substitution generic)
    {
        if (IsRuntimeIntrinsic(symbol) || symbol.MetadataToken == 0 && symbol.OriginalDefinition.MetadataToken == 0)
        {
            // Or a member Roslyn only pretends metadata has (a struct's
            // parameterless constructor).
            return;
        }

        if (InFramework(symbol) && NamesMissingType(symbol))
        {
            // A framework member whose signature names a type the CoreLib
            // does not have (serialization's, say): as if it were not
            // there, an error where code calls it.
            return;
        }

        if (symbol.IsGenericMethod && generic.Lookup(symbol.OriginalDefinition.TypeParameters[0]) is null)
        {
            // A template until code reaches an instantiation.
            if (!symbol.IsAbstract)
            {
                importedGenericMethods.Add(symbol.OriginalDefinition);
            }

            return;
        }

        if (generic.IsEmpty && TryRegisterHostImport(symbol))
        {
            return;
        }

        string? exportName = null;
        foreach (var attribute in symbol.GetAttributes())
        {
            if (IsWasmExport(attribute.AttributeClass) && generic.IsEmpty)
            {
                exportName = ExportAttributeName(attribute, symbol);
            }
        }

        if (!symbol.IsAbstract && IlOf(symbol) is null)
        {
            if (InCoreLibrary(symbol))
            {
                // .NET's declaration of a member the CoreLib's own type does
                // not implement (see corelib/generator): an error where
                // code calls it.
                return;
            }

            throw ErrorAt(symbol, "Extern methods other than WasmImport host calls are unsupported.");
        }

        AssignSlot(symbol);
        if (symbol.IsAbstract)
        {
            return;
        }

        switch (symbol.MethodKind)
        {
            case MethodKind.StaticConstructor:
                // Precise unless beforefieldinit: then it runs where C#
                // runs field initializers, at the first static field access.
                RegisterMethod(symbol, MethodPlanKind.Ordinary, generic, defer: false);
                if (IsBeforeFieldInit(symbol.ContainingType))
                {
                    staticInitializers.Add(new(symbol, generic));
                }
                else
                {
                    staticConstructors.Add(symbol.ContainingType, symbol);
                }

                return;
            case MethodKind.Constructor:
                RegisterMethod(symbol, MethodPlanKind.Constructor, generic);
                return;
        }

        RegisterMethod(symbol, MethodPlanKind.Ordinary, generic, defer: exportName is null);
        if (exportName is not null)
        {
            if (!symbol.IsStatic || !HasScalarSignature(symbol))
            {
                throw ErrorAt(symbol, "WasmExport requires a static method whose parameters and result are scalars.");
            }

            exportNames.Add(symbol, exportName);
        }
    }

    // The framework methods that could not be walked or lowered, and why.
    private readonly Dictionary<MethodPlan, CompileError> unlowered = new(ReferenceEqualityComparer.Instance);

    public CompileError? Unlowered(MethodPlan plan) => unlowered.GetValueOrDefault(plan);

    // An error that does not say where, at the method it stopped.
    private static CompileError Located(MethodPlan plan, CompileError error) =>
        System.Text.RegularExpressions.Regex.IsMatch(error.Message, @"^.+?: GP\d{4}: ")
            ? error
            : new CompileError($"{plan.Symbol!.ToDisplayString()}: GP1000: {error.Message}");

    // Whether a method's signature names a type no imported assembly
    // defines.
    private static bool NamesMissingType(IMethodSymbol method) =>
        IsMissing(method.ReturnType) || method.Parameters.Any(parameter => IsMissing(parameter.Type));

    public static bool IsMissing(ITypeSymbol type) => type switch
    {
        IErrorTypeSymbol => true,
        IArrayTypeSymbol array => IsMissing(array.ElementType),
        IPointerTypeSymbol pointer => IsMissing(pointer.PointedAtType),
        INamedTypeSymbol named => named.TypeArguments.Any(IsMissing) || (named.ContainingType is { } outer && IsMissing(outer)),
        _ => false,
    };

    // An imported interface's members: RegisterInterfaceMembers from
    // metadata.
    private void RegisterImportedInterfaceMembers(INamedTypeSymbol type)
    {
        var layout = interfaces[type];
        var generic = SubstitutionOf(type);
        foreach (var baseInterface in type.Interfaces.Select(Unnamed).OfType<INamedTypeSymbol>().Where(IsGenericInstance))
        {
            EnsureInterfaceInstance(baseInterface);
        }

        if (type.GetMembers().Any(member => member is IFieldSymbol { IsStatic: true, IsConst: false }
                or IMethodSymbol { MethodKind: MethodKind.StaticConstructor }))
        {
            classOrder.Add(type);
        }

        foreach (var member in type.GetMembers())
        {
            switch (member)
            {
                case IFieldSymbol field:
                    if (!field.IsConst && !HasData(field))
                    {
                        MapType(field.Type);
                        RegisterField(field);
                    }

                    break;
                case IMethodSymbol method:
                    if (method.IsStatic || method.MethodKind == MethodKind.ExplicitInterfaceImplementation
                        || !(method.IsAbstract || method.IsVirtual))
                    {
                        if (!method.IsAbstract)
                        {
                            RegisterImportedMethod(method, generic);
                        }

                        break;
                    }

                    if (method.ReturnsByRef || method.ReturnsByRefReadonly)
                    {
                        throw ErrorAt(method, "By-ref members of interfaces are unsupported.");
                    }

                    if (!method.IsGenericMethod)
                    {
                        // Of the canonical form's shape (Frontend.Sharing).
                        var shaped = CanonicalMember(method);
                        layout.Members.Add(method);
                        layout.MemberTypes.Add(SignatureType(
                            [WType.Ref(objectHeap), .. shaped.Parameters.Select(ParameterType)],
                            MapType(shaped.ReturnType)));
                    }

                    if (!method.IsAbstract)
                    {
                        RegisterImportedMethod(method, generic);
                    }

                    break;
            }
        }
    }

    // The variables of a method's filters (see FunctionEmitter.IlFilters),
    // under an instantiation: they live in cells (or are references
    // already) that an environment struct holds for the selector.
    internal sealed record IlFilterEnvironment(int Heap, List<(bool Argument, int Index, WType Type)> Variables);

    private readonly Dictionary<Instance, IlFilterEnvironment> filterEnvironments = [];

    public IlFilterEnvironment FilterEnvironmentOf(IMethodSymbol method, Substitution generic) =>
        filterEnvironments[new(method, generic)];

    public int IlSelectorIndex(IMethodSymbol method, Substitution generic, int group) =>
        selectorIds.TryGetValue(new((method, group), generic), out int id)
            ? imports.Count + id
            : throw new InternalCompilerError("try block without a selector.");

    // A method's try blocks with catch clauses each get a selector, under
    // two-pass exception handling, and its filters an environment.
    private void RegisterIlSelectors(MethodPlan plan, IlAnalysis flow)
    {
        if (!twoPass || !flow.Groups.Any(group => !group.IsFinally))
        {
            return;
        }

        var key = new Instance(plan.Symbol!, plan.Generic);
        if (!filterEnvironments.ContainsKey(key))
        {
            var variables = new List<(bool Argument, int Index, WType Type)>();
            foreach (var (argument, index) in flow.FilterVariables())
            {
                WType type;
                if (argument)
                {
                    var slot = flow.Arguments[index];
                    type = slot.Kind == IlKind.ByRef
                        ? RefParameterType(slot.Type!)
                        : !plan.Symbol!.IsStatic && index == 0 ? MapType(slot.Type) : ReferenceType(slot.Type!);
                }
                else
                {
                    var local = flow.Locals[index];
                    type = local.ByRef ? RefParameterType(local.Type) : ReferenceType(local.Type);
                }

                variables.Add((argument, index, type));
            }

            int heap = AddType(TypeDefinition.Struct(
                "filter environment",
                [.. variables.Select(variable => new WField(variable.Type, Mutable: false))]));
            filterEnvironments.Add(key, new(heap, variables));
        }

        foreach (var group in flow.Groups.Where(group => !group.IsFinally))
        {
            var selector = new Instance((plan.Symbol!, group.Id), plan.Generic);
            if (selectorIds.ContainsKey(selector))
            {
                continue;
            }

            selectorIds.Add(selector, methods.Count);
            methods.Add(new(
                plan.Symbol,
                $"{plan.Name} <filter {group.Id}>",
                [WType.NonNullRef(handlerHeap), WType.NonNullRef(ExceptionHeap)],
                WType.I32,
                true,
                plan.ContainingType,
                MethodPlanKind.Selector,
                plan.Generic,
                Il: plan.Il,
                IlGroup: group.Id));
        }
    }

    // What discovery does once no new code turns up: Discover's tail.
    private void FinishDiscovery()
    {
        if (globals.Count > MaximumGlobals)
        {
            throw new CompileError($"The module needs {globals.Count} globals; the limit is {MaximumGlobals}.");
        }

        CheckObjectValues();
        RegisterObjectDefaults();
        ClassifyStaticInitialization();
        FinishExceptions();
        FinishObjectPrinting();
        FinishDelegates();
        FinishTypeObjects();
        RegisterImportBookkeeping();
        FinishDictionaries();
        DefineClasses();
        for (int i = 0; i < types.Count; i++)
        {
            var type = typeSymbols[i];
            if (types[i] is not null)
            {
                continue;
            }

            if (type is IArrayTypeSymbol array)
            {
                types[i] = ArrayDefinition(array);
            }
            else if (type is not null)
            {
                var fields = OwnStorage((INamedTypeSymbol)type).Select(field => StorageField(StorageType(field)));
                if (identityHash)
                {
                    fields = fields.Append(HashFieldDefinition);
                }

                types[i] = TypeDefinition.Struct(type.ToDisplayString(), fields.ToArray());
            }
        }

        if (types.Count > MaximumTypes)
        {
            throw new CompileError($"The module needs {types.Count} GC types; the limit is {MaximumTypes}.");
        }

        if (methods.Count > MaximumMethods)
        {
            throw new CompileError($"The module needs {methods.Count} functions; the limit is {MaximumMethods}.");
        }

        foreach (var plan in AllPlans)
        {
            SignatureType(plan.Parameters, plan.Result);
        }

        AssignTypeObjectGlobals(AssignInitializationGlobals());
        frozen = true;
    }
}
