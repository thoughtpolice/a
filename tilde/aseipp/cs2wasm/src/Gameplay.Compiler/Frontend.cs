// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Gameplay.Compiler;

internal sealed class CompileError(string message) : Exception(message)
{
    // At a symbol, which names where it is.
    public static CompileError At(ISymbol symbol, string message) => new($"{symbol.ToDisplayString()}: GP1000: {message}");
}

// A broken compiler invariant, never a verdict on the source: the driver
// reports it with the internal-error exit status rather than as a rejection.
internal sealed class InternalCompilerError(string message) : Exception(message);

// RecoverAfterTrap lets entries run after one trapped (see
// Frontend.Initialization); by default the module is poisoned instead.
internal sealed record Limits(
    int Fuel = 100_000,
    int CallDepth = 64,
    long AllocationUnits = 1_048_576,
    int ArrayLength = 65_536,
    bool RecoverAfterTrap = false);

internal sealed record SourceFile(string Path, string Text);

internal enum MethodPlanKind
{
    Ordinary,
    Constructor,
    // The synthesized function that runs the static constructors that only
    // compute constants (see Frontend.Initialization), before the first
    // exported entry proceeds.
    StaticInitializer,
    // An itable slot's function: it casts `this` from $Object to the class
    // of Symbol, an interface member's implementation, and calls it.
    InterfaceThunk,
    // A delegate's function for a method group: it calls Symbol, on the
    // target a Bound delegate holds for an instance method.
    MethodGroupThunk,
    // Throws the exception a failed check stands for, by its fault code.
    ThrowHelper,
    // With two-pass exception handling (see Frontend.Filters): the function
    // that selects a try statement's catch clause for an exception, running
    // its filters, and the one that searches the handlers, then throws.
    Selector,
    Raise,
    GrowHandlers,
    // cabi_realloc, the boundary memory's allocator (see Frontend.Memory).
    Realloc,
    // A lazily initialized class's initializer (see
    // Frontend.Initialization), and the function that resets the classes
    // an abandoned entry left running.
    ClassInitializer,
    Recover,
    // The bookkeeping around an import call of a module poisoned by traps:
    // taking the entry count, then checking it.
    ImportEnter,
    ImportLeave,
    // System.Object's Equals and GetHashCode, by identity, and a class's
    // ToString, its type's name, in the root vtable's slots of the classes
    // that do not override them.
    ObjectDefault,
    // Boxes (see Frontend.Boxing): an itable slot's function, which calls
    // the struct's method on the box's storage, and an object member of
    // the boxed value; and the object members of any object value.
    BoxThunk,
    BoxMember,
    ObjectHelper,
    // An enum's names (see Frontend.Enums).
    EnumFormat,
    // A delegate layout's (Bound) multicast function and its combining,
    // removing and comparing functions (see Frontend.Delegates).
    DelegateInvoker,
    DelegateCombine,
    DelegateRemove,
    DelegateEqual,
    // A delegate converted by variance: the function making a
    // delegate of the layout Bound that forwards to one of the layout
    // VarianceSource, and the forwarding function.
    DelegateVariance,
    DelegateForward,
    // A generic virtual method's instantiation's dispatcher (see
    // Frontend.GenericDispatch).
    GenericDispatch,
    // A type's System.Type object, made on first use (Receiver), and
    // GetType's helper for objects (see Frontend.Types).
    TypeObject,
    ObjectType,
    // A reference type's load and store functions (see
    // Frontend.References).
    ReferenceLoad,
    ReferenceStore,
    // Shared generics (see Frontend.SharedCode): one instruction of a
    // shared method's code as its exact instantiation Symbol runs it (the
    // instruction at IlGroup), which the instantiation's dictionary holds;
    // and an exact instantiation's entry into the shared code (the plan at
    // IlGroup), which passes its dictionary (the one numbered Bound).
    ExactStep,
    SharedEntry,
    // A store into an array of the covariant family (see Frontend.Arrays):
    // the value must be of the array's exact element type.
    StoreCheck,
    // A step of a runtime-async method (see Il.RuntimeAsync): the function
    // its continuation, an Action, runs.
    RuntimeAsyncStep,
}

// A Wasm function to emit. Symbol is null for the static initializer.
// IsStatic means the function has no `this`. The body's IL belongs to a
// generic definition when Generic binds its type parameters; Symbol and
// ContainingType are then the closed instantiation.
internal sealed record MethodPlan(
    IMethodSymbol? Symbol,
    string Name,
    WType[] Parameters,
    WType Result,
    bool IsStatic,
    INamedTypeSymbol? ContainingType,
    MethodPlanKind Kind,
    Substitution Generic,
    int Bound = -1,
    ITypeSymbol? Receiver = null,
    bool BaseAccess = false,
    IlCode? Il = null,
    int IlGroup = -1,
    int VarianceSource = -1,
    SharedCode? Shared = null);

// One step of static initialization: a static constructor to call (its IL
// runs the class's field initializers in declaration order first).
internal sealed record StaticInitializerPlan(IMethodSymbol Constructor, Substitution Generic);

// The module's bytes are written when first asked for, so that of the
// compilations a closed world makes (Frontend.ClosedWorld) only the one kept
// is written and stackified (Wasm.Locals).
internal sealed record CompilationProduct(Lazy<byte[]> Module, string[] Exports, int Functions, int HeapTypes)
{
    public byte[] Bytes => Module.Value;
}

// A function's body, before pruning: its relocations, the vtable slots it
// dispatches through, and why it cannot be lowered, for a synthesized one
// that is an error only if the module keeps it.
internal sealed record EmittedFunction(
    WasmFunction Function,
    List<Relocation> Relocations,
    IReadOnlySet<SlotUse> SlotUses,
    CompileError? Error);

// Every scalar is an i32, i64, f32 or f64 in Wasm. The C# type decides the
// signedness, the width to wrap to, and the conversions between them.
internal enum Scalar
{
    Bool,
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
    Char,
}

internal sealed partial class Frontend
{
    private const string BindingResource = "Gameplay.Compiler.Binding.Gameplay.cs";
    private const string BindingPath = "<gameplay-binding>";

    // The assembly being imported (see docs/IMPORTER.md). One compilation
    // runs at a time per thread.
    [ThreadStatic]
    private static IAssemblySymbol? importedAssembly;

    // A type of the runtime layer: the CoreLib's own (Frontend.CoreLib).
    private static bool IsRuntimeType(INamedTypeSymbol type)
    {
        // And an imported framework assembly's, compiled from its IL as
        // the CoreLib's own are.
        var definition = type.OriginalDefinition;
        return (InCoreLibrary(definition) && !IsSurfaceType(definition)) || InFramework(definition);
    }

    // Whether a symbol is the module's own: defined by the assembly being
    // imported, a library it references, a framework assembly, or the CoreLib's own code (not its
    // surface's declarations).
    public static bool IsModuleDefined(ISymbol symbol)
    {
        var definition = symbol.OriginalDefinition;
        if (SymbolEqualityComparer.Default.Equals(definition.ContainingAssembly, importedAssembly))
        {
            return true;
        }

        if (InFramework(definition) || InLibrary(definition))
        {
            return true;
        }

        // Over the CoreLib, the runtime layer's types and their members, and
        // the static methods it gives the surface's types bodies of.
        return InCoreLibrary(definition)
               && (definition is INamedTypeSymbol type ? IsRuntimeType(type)
                   : (definition.ContainingType is { } containing && IsRuntimeType(containing))
                     || (definition is IMethodSymbol method && IsSurfaceBody(method)));
    }

    // The length of an [InlineArray] struct (what C# puts a params span's
    // elements in), or null for any other type.
    public static int? InlineArrayLength(ITypeSymbol? type) =>
        type is INamedTypeSymbol { TypeKind: TypeKind.Struct } named
        && named.GetAttributes().FirstOrDefault(attribute =>
                attribute.AttributeClass is { Name: "InlineArrayAttribute", ContainingNamespace.Name: "CompilerServices" })
            is { ConstructorArguments: [{ Value: int length }] }
            ? length
            : null;

    // Whether a value of a type holds an [InlineArray] buffer: is one, or
    // a struct with one among its fields'.
    public static bool HoldsInlineArray(ITypeSymbol type) =>
        InlineArrayLength(type) is not null
        || (type is INamedTypeSymbol { TypeKind: TypeKind.Struct } named && ScalarOf(named) is null
            && named.GetMembers().OfType<IFieldSymbol>().Any(field => !field.IsStatic && !SymbolEqualityComparer.Default.Equals(field.Type, named)
                                                                      && HoldsInlineArray(field.Type)));

    // An [InlineArray] struct's element type: its one instance field's
    // (C#'s params buffers are generic over it; the framework's own, such
    // as SegmentedArrayBuilder<T>'s scratch buffer, are not).
    public static ITypeSymbol InlineArrayElement(ITypeSymbol type) =>
        type.GetMembers().OfType<IFieldSymbol>().Single(field => !field.IsStatic && !field.IsConst).Type;

    // The struct C# builds interpolated strings with, in IL.
    public static bool IsInterpolationHandler(ITypeSymbol? type) =>
        type is INamedTypeSymbol { Name: "DefaultInterpolatedStringHandler", ContainingNamespace: { Name: "CompilerServices" } };

    // The IL being imported, and the CoreLib's.
    private readonly IlModule il;
    private readonly IlModule coreIl;

    // The module whose IL defines a symbol: the module's, a library's, the
    // CoreLib's or a framework assembly's.
    public IlModule? IlModuleOf(ISymbol symbol) =>
        il.Defines(symbol) ? il
        : coreIl.Defines(symbol) ? coreIl
        : LibraryModuleOf(symbol) ?? FrameworkModuleOf(symbol);

    // The assembly the module's own types are in: the imported one.
    public IAssemblySymbol ModuleAssembly => il.Assembly;

    // A type by metadata name, the module's own first, then the import
    // compilation's (the CoreLib's, the framework's).
    public INamedTypeSymbol? TypeNamed(string metadataName) =>
        ModuleAssembly.GetTypeByMetadataName(metadataName) ?? compilation.GetTypeByMetadataName(metadataName);

    // The runtime layer's type of a name (a framework type the runtime
    // declares, or declares members of), or null.
    public INamedTypeSymbol? RuntimeTypeNamed(string metadataName) =>
        ModuleAssembly.GetTypeByMetadataName(metadataName) ?? coreLibrary?.GetTypeByMetadataName(metadataName);

    private readonly CSharpCompilation compilation;
    // The recursive type group. A source class or array type is registered
    // first and defined once discovery knows its fields; the types the
    // compiler synthesizes (signatures, vtables) are defined as they are
    // added.
    private readonly Dictionary<ITypeSymbol, int> heapIds = new(SymbolEqualityComparer.Default);
    private readonly List<ITypeSymbol?> typeSymbols = [];
    private readonly List<TypeDefinition?> types = [];
    private readonly Dictionary<FunctionType, int> signatureIds = [];
    // Storage: fields, and field-like events, which are their own storage
    // since Roslyn does not name their backing fields.
    private readonly Dictionary<ISymbol, int> fieldIds = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<ISymbol, int> globalIds = new(SymbolEqualityComparer.Default);
    private readonly List<(ISymbol Field, WType Type)> globals = [];
    private readonly List<StaticInitializerPlan> staticInitializers = [];
    private readonly Dictionary<IMethodSymbol, int> methodIds = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IMethodSymbol, string> exportNames = new(SymbolEqualityComparer.Default);
    private readonly List<MethodPlan> methods = [];
    private bool frozen;

    public Limits Limits { get; }

    // Well-known symbols, resolved once and compared by identity rather than
    // by name. The binding attributes are null when no source declares them.
    private readonly INamedTypeSymbol? wasmImportAttribute;
    private readonly INamedTypeSymbol? wasmExportAttribute;
    private readonly INamedTypeSymbol? flagsAttribute;

    public IPropertySymbol ArrayLength { get; }

    private Frontend(
        CSharpCompilation compilation, Limits limits, bool allPolymorphic, bool adoptEnumerables, IlModule il,
        IlModule coreIl, IReadOnlySet<ITypeSymbol> covariantElements, IReadOnlySet<string>? unshared,
        ClosedWorld? world, bool share)
    {
        this.compilation = compilation;
        this.unshared = unshared ?? new HashSet<string>();
        revised = unshared is not null;
        World = world;
        this.covariantElements = covariantElements;
        this.il = il;
        this.coreIl = coreIl;
        sharing = share && SharingEnabled();
        Limits = limits;
        this.allPolymorphic = allPolymorphic;
        this.adoptEnumerables = adoptEnumerables;
        wasmImportAttribute = TypeNamed("Gameplay.WasmImportAttribute");
        wasmExportAttribute = TypeNamed("Gameplay.WasmExportAttribute");
        flagsAttribute = TypeNamed("System.FlagsAttribute");
        ArrayLength = compilation.GetSpecialType(SpecialType.System_Array)
            .GetMembers("Length")
            .OfType<IPropertySymbol>()
            .Single();
        intrinsics = ResolveIntrinsics(compilation);
    }

    // runtimeAsync compiles the sources' async methods as runtime-async
    // (MethodImplAttributes.Async) rather than as state machines, which the
    // importer then splits (Il.RuntimeAsync).
    // generators are Roslyn source generators (Generators), run over the
    // sources' compilation.
    public static CompilationProduct Compile(
        IReadOnlyList<SourceFile> sources, Limits limits, bool runtimeAsync = false,
        IReadOnlyList<string>? generators = null, IReadOnlyList<ReferencedLibrary>? libraries = null)
    {
        SyntaxTree[] trees;
        CSharpParseOptions parseOptions;
        using (Timings.Start("parse"))
        {
            (trees, parseOptions) = Parse(sources, runtimeAsync, bindings: true);
        }

        return CompileIl(trees, limits, Generators.Load(generators ?? []), parseOptions, libraries ?? []);
    }

    // The sources' syntax trees; with `bindings`, and the attribute
    // declarations of sdk/Gameplay.cs, unless the designer's sources
    // already carry the SDK's copy of them.
    private static (SyntaxTree[] Trees, CSharpParseOptions Options) Parse(IReadOnlyList<SourceFile> sources, bool runtimeAsync, bool bindings)
    {
        if (sources.Count is < 1 or > 128)
        {
            throw new CompileError("Provide 1 to 128 source files.");
        }

        if (sources.Sum(source => (long)source.Text.Length) > 2_000_000)
        {
            throw new CompileError("Source limit is 2,000,000 UTF-16 code units.");
        }

        var parseOptions = new CSharpParseOptions(LanguageVersion.CSharp15);
        if (runtimeAsync)
        {
            parseOptions = parseOptions.WithFeatures([new("runtime-async", "on")]);
        }

        var trees = sources.Select(source => CSharpSyntaxTree.ParseText(
            SourceText.From(source.Text, Encoding.UTF8),
            parseOptions,
            source.Path)).ToArray();

        // The attribute declarations are bound like any source, unless the
        // designer's sources already carry the SDK's copy of them.
        if (bindings && !trees.Any(DeclaresBindingTypes))
        {
            trees = [.. trees, CSharpSyntaxTree.ParseText(
                SourceText.From(Encoding.UTF8.GetString(ReadResource(BindingResource)), Encoding.UTF8),
                parseOptions,
                BindingPath)];
        }

        return (trees, parseOptions);
    }

    private static byte[] ReadResource(string name)
    {
        using var resource = typeof(Frontend).Assembly.GetManifestResourceStream(name)
            ?? throw new CompileError($"Missing embedded resource {name}; check the build configuration.");
        var data = new byte[resource.Length];
        resource.ReadExactly(data);
        return data;
    }

    private static bool DeclaresBindingTypes(SyntaxTree tree) => tree.GetRoot()
        .DescendantNodes()
        .OfType<ClassDeclarationSyntax>()
        .Any(declaration => declaration.Identifier.ValueText is "WasmImportAttribute" or "WasmExportAttribute");

    private bool IsBindingType(INamedTypeSymbol symbol) =>
        IsWasmImport(symbol) || IsWasmExport(symbol) || IsCanonicalAbiAttribute(symbol);

    private bool IsWasmImport(INamedTypeSymbol? symbol) =>
        (wasmImportAttribute is not null && SymbolEqualityComparer.Default.Equals(symbol, wasmImportAttribute))
        // The CoreLib's own, for its host services (corelib/Host.cs).
        || (symbol is { Name: "HostImportAttribute", ContainingNamespace: { Name: "Runtime", ContainingNamespace.Name: "Gameplay" } }
            && InCoreLibrary(symbol));

    private bool IsWasmExport(INamedTypeSymbol? symbol) =>
        wasmExportAttribute is not null && SymbolEqualityComparer.Default.Equals(symbol, wasmExportAttribute);

    // MARK: Types

    public static Scalar? ScalarOf(ITypeSymbol? type)
    {
        if (type is INamedTypeSymbol { EnumUnderlyingType: { } underlying })
        {
            type = underlying;
        }

        return type?.SpecialType switch
        {
            SpecialType.System_Boolean => Scalar.Bool,
            SpecialType.System_SByte => Scalar.I8,
            SpecialType.System_Byte => Scalar.U8,
            SpecialType.System_Int16 => Scalar.I16,
            SpecialType.System_UInt16 => Scalar.U16,
            SpecialType.System_Int32 => Scalar.I32,
            SpecialType.System_UInt32 => Scalar.U32,
            SpecialType.System_Int64 => Scalar.I64,
            SpecialType.System_UInt64 => Scalar.U64,
            SpecialType.System_IntPtr => Scalar.I64,
            SpecialType.System_UIntPtr => Scalar.U64,
            SpecialType.System_Single => Scalar.F32,
            SpecialType.System_Double => Scalar.F64,
            SpecialType.System_Char => Scalar.Char,
            _ => null,
        };
    }

    public static WType Represent(Scalar scalar) => scalar switch
    {
        Scalar.I64 or Scalar.U64 => WType.I64,
        Scalar.F32 => WType.F32,
        Scalar.F64 => WType.F64,
        _ => WType.I32,
    };

    public WType MapType(ITypeSymbol? type)
    {
        if (type is null)
        {
            throw new CompileError("An untyped operation is outside this subset.");
        }

        type = Unnamed(type);

        if (type.SpecialType == SpecialType.System_Void)
        {
            return WType.Void;
        }

        if (ScalarOf(type) is { } scalar)
        {
            return Represent(scalar);
        }

        if (IsVector128(type) && !ContainsTypeParameters(type))
        {
            return MapVector(type);
        }

        if (ContainsTypeParameters(type))
        {
            throw new InternalCompilerError($"open type '{type.ToDisplayString()}' reached lowering.");
        }

        if (UsesRepresentation(type))
        {
            // A shared class's representation (Frontend.Sharing): the
            // instantiation's own layout, its identity, is registered where
            // code makes, tests for or calls into one.
            return WType.Ref(RepresentationOf((INamedTypeSymbol)type).Heap);
        }

        if (sharing && type is INamedTypeSymbol { TypeKind: TypeKind.Struct } shared && IsSharedInstance(shared))
        {
            // Its canonical form's layout (Frontend.Sharing).
            if (!frozen)
            {
                EnsureInstance(shared);
            }

            return MapType(Canonical(shared));
        }

        if (InlineArrayLength(type) is not null)
        {
            // Imported: the elements of a params span, as an array.
            return MapType(ArrayOf(InlineArrayElement(type)));
        }

        if (IsInterpolationHandler(type))
        {
            // Imported: the string an interpolated string builds so far.
            return StringType();
        }

        if (IsStruct(type))
        {
            return EnsureStruct((INamedTypeSymbol)type).Type;
        }

        if (type.SpecialType == SpecialType.System_String)
        {
            return StringType();
        }

        if (IsObjectType(type))
        {
            return ObjectType();
        }

        if (IsFrameworkException(type) && !frozen)
        {
            RegisterFrameworkClass((INamedTypeSymbol)type);
        }

        if ((IsGenericInstance(type) || (IsOnDemandType(type) && type.TypeKind == TypeKind.Class)) && !frozen)
        {
            EnsureInstance((INamedTypeSymbol)type);
        }

        if (heapIds.TryGetValue(type, out int index))
        {
            return type is IArrayTypeSymbol known && IsFamilyArray(known) ? WType.Ref(FamilyHeap(known)) : WType.Ref(index);
        }

        if (IsAdoptedInterface(type) && !frozen)
        {
            EnsureAdoptedInterface((INamedTypeSymbol)type);
        }

        if (TryInterface(type, out _))
        {
            // An enumerable may be an array or string.
            return IsArrayInterface(type) ? WType.Ref(EqHeap) : WType.Ref(objectHeap);
        }

        if (IsSupportedDelegate(type))
        {
            return WType.Ref(DelegateOf(type).Heap);
        }

        if (type is IArrayTypeSymbol array && array.Rank == 1 && array.IsSZArray)
        {
            MapType(array.ElementType); // recursively register jagged element arrays
            int heap = AddHeap(type);
            // Of a covariant array's family (Frontend.Arrays), any of it.
            return IsFamilyArray(array) ? WType.Ref(FamilyHeap(array)) : WType.Ref(heap);
        }

        if (type is INamedTypeSymbol { Name: "MemoryHandle" or "MemoryManager" or "MemoryPool", ContainingNamespace.Name: "Buffers" })
        {
            throw new CompileError(
                $"GP1001: Type '{type.ToDisplayString()}' is unsupported: memory here is GC arrays, which cannot be pinned "
                + "(Memory<T>.Pin, MemoryHandle, MemoryManager<T> and MemoryPool<T>).");
        }

        if (type is INamedTypeSymbol attribute && IsAttributeClass(attribute))
        {
            throw new CompileError(
                $"GP1001: Type '{type.ToDisplayString()}' is unsupported: attribute classes are metadata, "
                + "read by the compiler and source generators, and never a module's values.");
        }

        throw new CompileError(
            $"GP1001: Type '{type.ToDisplayString()}' is unsupported. "
            + "Allowed: bool, the integer types, char, float, double, enums, source classes, structs "
            + "and interfaces, Action, Func, Predicate, Comparison, Converter and source delegate types, and one-dimensional arrays of these types.");
    }

    private int AddHeap(ITypeSymbol type)
    {
        if (heapIds.TryGetValue(type, out int id))
        {
            return id;
        }

        if (type is IArrayTypeSymbol covariant && IsFamilyArray(covariant))
        {
            // The family's supertype first, as the group declares it.
            _ = FamilyHeap(covariant);
        }

        id = AddType(null);
        heapIds.Add(type, id);
        typeSymbols[id] = type;
        return id;
    }

    private int AddType(TypeDefinition? definition)
    {
        if (frozen)
        {
            throw new InternalCompilerError("type discovery was incomplete.");
        }

        types.Add(definition);
        typeSymbols.Add(null);
        return types.Count - 1;
    }

    // The group's function type for a signature, interned: every internal
    // function is declared with one, and function references and call_ref
    // name them.
    public int SignatureType(WType[] parameters, WType result)
    {
        var signature = new FunctionType(parameters.SelectMany(Leaves).ToArray(), Leaves(result));
        if (!signatureIds.TryGetValue(signature, out int id))
        {
            id = AddType(TypeDefinition.Function(signature));
            signatureIds.Add(signature, id);
            signatureShapes.Add(id, (parameters, result));
        }

        return id;
    }

    // The parameters and result a function type was made of, structs whole.
    private readonly Dictionary<int, (WType[] Parameters, WType Result)> signatureShapes = [];

    public (WType[] Parameters, WType Result) SignatureShape(int signature) => signatureShapes[signature];

    // MARK: Lookups used by the emitter

    private static CompileError Error(string message) => new(message);

    // Why a call has nothing to run, for its diagnostic: what the method is
    // (.NET's declaration the CoreLib does not implement, a member of an
    // assembly the compiler does not import, an extern without WasmImport)
    // or, for one of the module's own, what the module lacks of it
    // (`missing`, "no function" unless the caller knows better).
    public static string UnsupportedCall(IMethodSymbol method, string? missing = null)
    {
        var definition = method.OriginalDefinition;
        string name = $"'{method.ToDisplayString()}'";
        if (definition.ContainingType is { } type && InCoreLibrary(definition) && IsSurfaceType(type))
        {
            return definition.IsStatic || coreModule?.HasBody(definition) != true
                ? $"{name} is unsupported: .NET declares it, but the gameplay CoreLib does not implement it."
                : $"{name} is unsupported: the compiler implements .NET's '{type.ToDisplayString()}' itself, but not this member.";
        }

        if (IsModuleDefined(definition))
        {
            return definition.IsExtern && coreModule?.HasBody(definition) != true
                ? $"{name} has no body: declare host calls with WasmImport."
                : $"{name} has {missing ?? "no function"} in the module.";
        }

        return $"{name} is unsupported: it is defined in '{definition.ContainingAssembly?.Name}', which the compiler does not import.";
    }

    // A polymorphic class's fields follow the identity hash, when there is one.
    // So do an exception's message and inner exception.
    public int FieldIndex(ISymbol field) =>
        FieldIndexOf(IsSharedInstance(field.ContainingType) || UsesRepresentation(field.ContainingType) ? CanonicalMember(field) : field);

    private int FieldIndexOf(ISymbol field) => fieldIds.TryGetValue(field, out int id)
        ? id + (identityHash && (layouts.ContainsKey(field.ContainingType) || representationLayouts.ContainsKey(field.ContainingType)) ? 1 : 0)
          + (IsException(field.ContainingType) ? ExceptionTextFields : 0)
        : throw Error($"Field '{field.ToDisplayString()}' is not a supported source instance field.");

    public int GlobalIndex(ISymbol field) => globalIds.TryGetValue(field, out int id)
        ? FirstStaticGlobal + id
        : throw Error($"Field '{field.ToDisplayString()}' is not a supported source static field.");

    public int MethodIndex(IMethodSymbol method, Substitution? enclosing = null)
    {
        if (importIds.TryGetValue(method, out int importIndex))
        {
            return importIndex;
        }

        if (methodIds.TryGetValue(method, out int id))
        {
            return imports.Count + id;
        }

        if (sharing && method.ContainingType is not null
            && sharedCodes.TryGetValue(CanonicalMember(method), out var shared) && shared is { Plan: >= 0, HiddenDictionary: false })
        {
            // Shared code's call of shared code (Frontend.SharedCode).
            return imports.Count + shared.Plan;
        }

        throw Error(UnsupportedCall(method));
    }

    // -1 for a constructor with nothing to run: an implicit one without
    // initializer work, or a BCL exception's.
    public int ConstructorIndex(IMethodSymbol constructor)
    {
        if (IsFrameworkException(constructor.ContainingType))
        {
            return IsSupportedExceptionConstructor(constructor)
                ? -1
                : throw Error($"'{constructor.ToDisplayString()}' is unsupported.");
        }

        return constructor.IsImplicitlyDeclared && !methodIds.ContainsKey(constructor)
            ? -1
            : MethodIndex(constructor);
    }

    // MARK: Emission

    private MethodPlan StaticInitializerPlan => new(
        null, "<static initializer>", [], WType.Void, true, null, MethodPlanKind.StaticInitializer,
        Substitution.Empty);

    private IEnumerable<MethodPlan> AllPlans => staticInitializers.Count != 0
        ? methods.Append(StaticInitializerPlan)
        : methods;

    // Function indices before pruning count the imports, then `methods`, then
    // the static initializer. Bodies come back with their relocations, whose
    // indices are filled in once pruning has fixed them.
    private List<EmittedFunction> EmitFunctions()
    {
        var functions = new List<EmittedFunction>();
        foreach (var plan in AllPlans)
        {
            var emitter = new FunctionEmitter(this, plan);
            WasmFunction function;
            try
            {
                function = emitter.Emit();
            }
            catch (Exception error) when (error is not (CompileError or ArrayCovarianceFound)
                                          && Environment.GetEnvironmentVariable("GAMEPLAYC_TRACE") is not null)
            {
                throw new InternalCompilerError($"{plan.Name}: {error.Message}\n{error.StackTrace}");
            }
            catch (CompileError error) when (plan.Symbol is { } symbol
                                              && (InFramework(symbol) || IsCanonicalForm(symbol.ContainingType)
                                                  || plan.Kind is MethodPlanKind.InterfaceThunk or MethodPlanKind.BoxThunk))
            {
                // A framework method the lowering cannot take, or an itable
                // member whose implementation .NET's surface declares but
                // the CoreLib does not have (List<T>'s IList.Add): a trap,
                // and an error if the module keeps it.
                unlowered.TryAdd(plan, Located(plan, error));
                emitter = new FunctionEmitter(this, plan);
                function = emitter.Emit();
            }

            // cabi_realloc keeps a standalone signature, like the entries.
            if (plan.Kind != MethodPlanKind.Realloc)
            {
                function = function with { Type = SignatureType(plan.Parameters, plan.Result) };
            }

            functions.Add(new(function, emitter.Relocations, emitter.SlotUses, emitter.DeferredError));
        }

        return functions;
    }

    // Splices each relocation's final index in at its offset.
    private static byte[] Link(byte[] code, List<Relocation> relocations, Func<Relocation, int> resolve)
    {
        var linked = new WasmWriter();
        int start = 0;
        foreach (var relocation in relocations)
        {
            linked.Bytes(code.AsSpan(start, relocation.Offset - start));
            linked.Index(resolve(relocation));
            start = relocation.Offset;
        }

        linked.Bytes(code.AsSpan(start));
        return linked.ToArray();
    }

    private CompilationProduct Emit()
    {
        if (Environment.GetEnvironmentVariable("GAMEPLAYC_STATS") is not null)
        {
            // For the compiler's own measurements.
            Console.Error.WriteLine($"instantiations {instantiated.Count}; exact {exactInstantiations.Count}; functions {methods.Count}; "
                                    + $"types {types.Count}; interfaces {interfaces.Count}; concrete classes {concreteClasses.Count}");
            if (Environment.GetEnvironmentVariable("GAMEPLAYC_STATS") == "all")
            {
                foreach (var symbol in instantiated)
                {
                    Console.Error.WriteLine("instance " + symbol.ToDisplayString());
                }
            }
        }

        // Every body is lowered, so unsupported code is rejected wherever it
        // is, and the call graph is recorded.
        List<EmittedFunction> allFunctions;
        int escaped = escapingArrays.Count;
        using (Timings.Start("lower"))
        {
            allFunctions = EmitFunctions();
        }

        if (escapingArrays.Count != escaped)
        {
            // A compilation's world is decided before emission
            // (Frontend.CoreLib).
            throw new InternalCompilerError("emission let an array escape that discovery did not.");
        }

        using var linking = Timings.Start("link");
        int staticInitializer = staticInitializers.Count != 0 ? imports.Count + methods.Count : -1;

        var exported = new List<(int Function, string Name, MethodPlan Plan)>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < methods.Count; index++)
        {
            var plan = methods[index];
            if (plan.Kind != MethodPlanKind.Ordinary || plan.Symbol is null || ExportName(plan.Symbol) is not { } name)
            {
                continue;
            }

            if (ModuleWriter.ReservedExports.Contains(name, StringComparer.Ordinal))
            {
                throw new CompileError($"Export name '{name}' is reserved for the runtime.");
            }

            if (!names.Add(name))
            {
                throw new CompileError($"Export '{name}' is declared twice; use distinct method names or WasmExport names.");
            }

            exported.Add((imports.Count + index, name, plan));
        }

        if (exported.Count == 0)
        {
            throw new CompileError("At least one public static entry method is required.");
        }

        // Only what the exports (and static initialization) reach is emitted:
        // generated bindings declare far more imports than a module uses, and
        // a host should only have to supply the ones it calls. The graph's
        // nodes are the functions, then the vtables: constructing a class
        // reaches its vtable and its itables' thunks, and a vtable the
        // functions of the slots that reachable code dispatches through.
        int functionCount = imports.Count + allFunctions.Count;
        var vtableThunks = concreteClasses.Select(layout => VTableInitializer(layout, _ => false).Relocations).ToList();
        var vtableSlots = concreteClasses.Select(layout => VTableSlots(layout).Concat(ITableSlots(layout)).ToList()).ToList();
        // The receivers each slot is dispatched on, and the functions of
        // reachable vtables' slots no dispatch has reached yet.
        var slotReceivers = new Dictionary<IMethodSymbol, List<INamedTypeSymbol>>(SymbolEqualityComparer.Default);
        var waiting = new Dictionary<IMethodSymbol, List<(INamedTypeSymbol Class, int Function)>>(SymbolEqualityComparer.Default);
        bool Used(IMethodSymbol root, INamedTypeSymbol type) =>
            slotReceivers.TryGetValue(root, out var receivers) && receivers.Any(receiver => Reaches(type, receiver));
        var reachable = new HashSet<int>();
        // Then the dictionaries of shared code (Frontend.SharedCode): a
        // reachable one reaches the function of each entry whose shared
        // code is reachable.
        int dictionaryBase = functionCount + concreteClasses.Count;
        var waitingThunks = new Dictionary<int, List<int>>();
        int Node(Relocation relocation) => relocation.Kind switch
        {
            RelocationKind.VTable => functionCount + relocation.Target,
            RelocationKind.Dictionary => dictionaryBase + relocation.Target,
            _ => relocation.Target,
        };
        var pending = new Stack<int>(exported.Select(export => export.Function));
        if (staticInitializer >= 0)
        {
            pending.Push(staticInitializer);
        }

        if (recoverFunction >= 0)
        {
            pending.Push(Recover);
        }

        if (boundaryMemory)
        {
            pending.Push(Realloc);
        }

        while (pending.TryPop(out int node))
        {
            if (!reachable.Add(node) || node < imports.Count)
            {
                continue;
            }

            if (node >= dictionaryBase)
            {
                foreach (var (code, _, thunk) in DictionaryEntries(dictionaryOrder[node - dictionaryBase]))
                {
                    if (thunk < 0)
                    {
                        continue;
                    }

                    int shared = imports.Count + code.Plan;
                    if (reachable.Contains(shared))
                    {
                        pending.Push(thunk);
                    }
                    else if (waitingThunks.TryGetValue(shared, out var thunks))
                    {
                        thunks.Add(thunk);
                    }
                    else
                    {
                        waitingThunks.Add(shared, [thunk]);
                    }
                }

                continue;
            }

            if (waitingThunks.Remove(node, out var released))
            {
                foreach (int thunk in released)
                {
                    pending.Push(thunk);
                }
            }

            if (node >= functionCount)
            {
                int vtable = node - functionCount;
                foreach (var relocation in vtableThunks[vtable])
                {
                    pending.Push(Node(relocation));
                }

                var type = concreteClasses[vtable].Symbol;
                foreach (var (root, slotFunction, _) in vtableSlots[vtable].Where(slot => slot.Function >= 0))
                {
                    if (Used(root, type))
                    {
                        pending.Push(slotFunction);
                    }
                    else if (waiting.TryGetValue(root, out var waitingFunctions))
                    {
                        waitingFunctions.Add((type, slotFunction));
                    }
                    else
                    {
                        waiting.Add(root, [(type, slotFunction)]);
                    }
                }

                continue;
            }

            var function = allFunctions[node - imports.Count];
            foreach (var relocation in function.Relocations.Where(relocation => relocation.Kind != RelocationKind.Literal))
            {
                pending.Push(Node(relocation));
            }

            foreach (var (root, receiver) in function.SlotUses)
            {
                if (Used(root, receiver))
                {
                    continue;
                }

                if (!slotReceivers.TryGetValue(root, out var receivers))
                {
                    slotReceivers.Add(root, receivers = []);
                }

                receivers.Add(receiver);
                if (waiting.TryGetValue(root, out var waitingFunctions))
                {
                    foreach (var (_, slotFunction) in waitingFunctions.Where(entry => Reaches(entry.Class, receiver)))
                    {
                        pending.Push(slotFunction);
                    }

                    waitingFunctions.RemoveAll(entry => Reaches(entry.Class, receiver));
                }
            }
        }

        for (int vtable = 0; vtable < concreteClasses.Count; vtable++)
        {
            if (reachable.Contains(functionCount + vtable)
                && vtableSlots[vtable].Any(slot => slot.Function == -2 && Used(slot.Root, concreteClasses[vtable].Symbol)))
            {
                throw new InternalCompilerError(
                    $"a dispatched override of '{concreteClasses[vtable].Symbol.ToDisplayString()}' has no function.");
            }
        }

        // `emitted` maps each index before pruning to its index in the
        // module, or -1 when nothing reachable calls it.
        var emitted = new int[imports.Count + allFunctions.Count];
        Array.Fill(emitted, -1);
        var keptImports = new List<WasmImport>();
        for (int index = 0; index < imports.Count; index++)
        {
            if (reachable.Contains(index))
            {
                emitted[index] = keptImports.Count;
                keptImports.Add(imports[index]);
            }
        }

        var kept = new List<int>();
        for (int index = 0; index < allFunctions.Count; index++)
        {
            if (reachable.Contains(imports.Count + index))
            {
                if (allFunctions[index].Error is { } error)
                {
                    throw error;
                }

                emitted[imports.Count + index] = keptImports.Count + kept.Count;
                kept.Add(index);
            }
        }

        // Static fields live after the runtime globals, then those of
        // static initialization (see Frontend.Initialization). The vtables
        // of the classes constructed come last. A static struct's global
        // holds its box, built by the global's initializer.
        var moduleGlobals = globals
            .Select(global =>
            {
                if (!global.Type.IsTuple)
                {
                    return new WasmGlobal(
                        global.Field.ToDisplayString(),
                        global.Type);
                }

                var layout = StructOf(global.Type);
                var box = new WasmWriter();
                WriteNewBox(box, layout);
                return new WasmGlobal(
                    global.Field.ToDisplayString(), WType.NonNullRef(layout.Box), Mutable: false, box.ToArray());
            })
            .ToList();
        if (identityHash)
        {
            moduleGlobals.Insert(0, new WasmGlobal("__next_hash", WType.I32));
        }

        if (twoPass)
        {
            int at = HandlersGlobal - ModuleWriter.RuntimeGlobals.Length;
            moduleGlobals.Insert(at, new WasmGlobal("__handler_pool", WType.Ref(handlerPoolHeap)));
            moduleGlobals.Insert(at, new WasmGlobal("__handler_base", WType.I32));
            moduleGlobals.Insert(at, new WasmGlobal("__handler_top", WType.I32));
        }

        moduleGlobals.AddRange(InitializationGlobals());
        moduleGlobals.AddRange(TypeObjectGlobals());

        // The reachable dictionaries, before the vtables that hold them:
        // each entry's function where it is kept, null otherwise.
        var dictionaryGlobals = new int[dictionaryOrder.Count];
        for (int index = 0; index < dictionaryOrder.Count; index++)
        {
            dictionaryGlobals[index] = -1;
            if (!reachable.Contains(dictionaryBase + index))
            {
                continue;
            }

            var dictionary = dictionaryOrder[index];
            var initializer = new WasmWriter();
            var initializerRelocations = new List<Relocation>();
            foreach (var (code, site, thunk) in DictionaryEntries(dictionary))
            {
                if (thunk >= 0 && emitted[thunk] >= 0)
                {
                    initializer.Byte(0xd2); // ref.func
                    initializerRelocations.Add(new(initializer.Length, RelocationKind.FunctionReference, thunk));
                }
                else
                {
                    initializer.Byte(0xd0); // ref.null
                    initializer.Signed(code.SignatureOf[site]);
                }
            }

            initializer.Gc(0, dictionary.Owner.Type); // struct.new
            dictionaryGlobals[index] = ModuleWriter.RuntimeGlobals.Length + moduleGlobals.Count;
            moduleGlobals.Add(new WasmGlobal(
                "dictionary " + dictionary.Exact.ToDisplayString(),
                WType.NonNullRef(dictionary.Owner.Type),
                Mutable: false,
                Link(initializer.ToArray(), initializerRelocations, relocation => emitted[relocation.Target])));
        }

        var vtableGlobals = new int[concreteClasses.Count];
        for (int index = 0; index < concreteClasses.Count; index++)
        {
            vtableGlobals[index] = -1;
            if (reachable.Contains(functionCount + index))
            {
                var layout = concreteClasses[index];
                var (vtableCode, vtableRelocations) = VTableInitializer(layout, root => Used(root, layout.Symbol));

                vtableGlobals[index] = ModuleWriter.RuntimeGlobals.Length + moduleGlobals.Count;
                moduleGlobals.Add(new WasmGlobal(
                    "vtable " + layout.Symbol.ToDisplayString(),
                    WType.NonNullRef(layout.VTable),
                    Mutable: false,
                    Link(vtableCode, vtableRelocations, relocation => relocation.Kind == RelocationKind.Dictionary
                        ? dictionaryGlobals[relocation.Target]
                        : emitted[relocation.Target])));
            }
        }

        // The literals the kept functions use come last, in order of first use.
        var literalGlobals = new Dictionary<int, int>();
        foreach (int index in kept)
        {
            foreach (var relocation in allFunctions[index].Relocations.Where(relocation => relocation.Kind == RelocationKind.Literal))
            {
                if (!literalGlobals.ContainsKey(relocation.Target))
                {

                    literalGlobals.Add(relocation.Target, ModuleWriter.RuntimeGlobals.Length + moduleGlobals.Count);
                    moduleGlobals.Add(new WasmGlobal(
                        "literal",
                        WType.NonNullRef(stringHeap),
                        Mutable: false,
                        LiteralInitializer(literals[relocation.Target])));
                }
            }
        }

        // A global's initializer declares the functions it references; code
        // needs the element segment to declare the ones it does.
        var declared = new SortedSet<int>();
        int Resolve(Relocation relocation)
        {
            switch (relocation.Kind)
            {
                case RelocationKind.VTable:
                    return vtableGlobals[relocation.Target];
                case RelocationKind.Literal:
                    return literalGlobals[relocation.Target];
                case RelocationKind.Dictionary:
                    return dictionaryGlobals[relocation.Target];
                case RelocationKind.FunctionReference:
                    declared.Add(emitted[relocation.Target]);
                    break;
            }

            return emitted[relocation.Target];
        }

        if (Environment.GetEnvironmentVariable("GAMEPLAYC_STATS") == "functions")
        {
            // For the compiler's own measurements: the code each kept
            // function has, by its definition, and the vtables kept.
            foreach (int index in kept)
            {
                var plan = index < methods.Count ? methods[index] : null;
                Console.Error.WriteLine($"function {allFunctions[index].Function.Instructions.Length} {plan?.Kind} "
                                        + $"{plan?.Symbol?.ContainingType?.OriginalDefinition.ToDisplayString()} :: {plan?.Name}");
            }

            for (int index = 0; index < concreteClasses.Count; index++)
            {
                if (reachable.Contains(functionCount + index))
                {
                    Console.Error.WriteLine($"vtable {concreteClasses[index].Symbol.ToDisplayString()}");
                }
            }
        }

        // What a second compilation may take as the whole world (see
        // Frontend.ClosedWorld): the classes and boxes whose vtables are
        // kept, the arrays code converts, whether there are strings.
        LastWorld = new ClosedWorld(
            [.. Enumerable.Range(0, concreteClasses.Count)
                .Where(index => reachable.Contains(functionCount + index))
                .Select(index => (ITypeSymbol)concreteClasses[index].Symbol)],
            layouts.Keys.ToHashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default),
            escapingArrays,
            stringHeap >= 0);

        var functions = kept
            .Select(index => allFunctions[index].Function with
            {
                Instructions = Link(
                    allFunctions[index].Function.Instructions, allFunctions[index].Relocations, Resolve),
            })
            .ToList();

        var exports = new List<WasmExport>();
        foreach (var (function, name, plan) in exported)
        {
            int staticInitializerFunction = staticInitializer >= 0 ? emitted[staticInitializer] : -1;
            var (locals, code) = EmitEntry(
                plan, emitted[function], staticInitializerFunction, recoverFunction >= 0 ? emitted[Recover] : -1);
            exports.Add(new(name, keptImports.Count + functions.Count));
            functions.Add(new(name + " [entry]", plan.Parameters, plan.Result, locals, code));
        }

        if (boundaryMemory)
        {
            exports.Add(new("memory", 0, Kind: 2));
            exports.Add(new("cabi_realloc", emitted[Realloc]));
        }

        var moduleTypes = types.Select(type => type!).ToList();
        var declaredFunctions = declared.ToArray();
        int[] tags = exceptions ? [exceptionTag] : [];
        return new(
            new Lazy<byte[]>(() =>
            {
                using var writing = Timings.Start("write");
                return ModuleWriter.Write(
                moduleTypes,
                keptImports,
                functions,
                exports,
                moduleGlobals,
                declaredFunctions,
                tags,
                boundaryMemory);
            }),
            exports.Select(export => export.Name).ToArray(),
            keptImports.Count + functions.Count,
            types.Count(type => type!.IsHeap));
    }

    // The wrapper a host calls. Every entry, including one a host import
    // makes while an outer export is still running, runs on fresh fuel, call
    // depth, allocation budget and fault state: the wrapper saves the runtime
    // globals in its own locals, resets them, and restores them when the
    // body returns, so a re-entrant call neither spends nor refills the outer
    // call's budgets and the outer call resumes at its own call depth.
    // Resetting on entry (rather than trusting what an earlier call left
    // behind) keeps entries sound after a trap or a host exception unwound a
    // call without running its epilogue.
    //
    // The eager classes' initializers (see Frontend.Initialization) run
    // once, on the first entry that gets that far, which is not charged for
    // them; they are pure, so running them again after a trap stopped them
    // is harmless. With lazily
    // initialized classes or the boundary memory, the entry counts itself
    // in `__entries`, first checking the count against `__imports`: a
    // mismatch means an entry trapped, and every class it left running is
    // reset (see there). The outermost entry empties the boundary memory's
    // arena (see Frontend.Memory).
    private (WType[] Locals, byte[] Code) EmitEntry(
        MethodPlan plan,
        int body,
        int staticInitializer,
        int recover)
    {
        var code = new WasmWriter();
        void GlobalGet(int index) => code.OpIndex(0x23, index);
        void GlobalSet(int index) => code.OpIndex(0x24, index);
        void LocalGet(int index) => code.OpIndex(0x20, index);
        void LocalSet(int index) => code.OpIndex(0x21, index);
        void Add(int index, int amount)
        {
            GlobalGet(index);
            code.I32(amount);
            code.Byte(0x6a); // i32.add
            GlobalSet(index);
        }

        var locals = new List<WType> { WType.I32, WType.I32, WType.I64 };
        int savedFuel = plan.Parameters.Length;
        int savedDepth = savedFuel + 1;
        int savedBudget = savedFuel + 2;
        int result = -1;
        if (plan.Result != WType.Void)
        {
            result = savedFuel + locals.Count;
            locals.Add(plan.Result);
        }

        GlobalGet(ModuleWriter.FuelGlobal);
        LocalSet(savedFuel);
        GlobalGet(ModuleWriter.CallDepthGlobal);
        LocalSet(savedDepth);
        GlobalGet(ModuleWriter.AllocationBudgetGlobal);
        LocalSet(savedBudget);

        void Poisoned()
        {
            code.I32(1);
            GlobalSet(PoisonGlobal);
            code.I32((int)FunctionEmitter.FaultCode.Poisoned);
            GlobalSet(ModuleWriter.FaultGlobal);
            code.Byte(0x00); // unreachable
        }

        {
            // A poisoned module refuses the entry.
            if (PoisonGlobal >= 0)
            {
                GlobalGet(PoisonGlobal);
                code.Byte(0x04); // if
                code.Byte(0x40);
                Poisoned();
                code.Byte(0x0b); // end
            }

            // Every entry but the outermost runs inside an import call of
            // the one before it, so the counts match unless an entry
            // trapped: that poisons the module, or, recovering, every
            // entry is taken as abandoned.
            GlobalGet(EntriesGlobal);
            if (ImportsGlobal >= 0)
            {
                GlobalGet(ImportsGlobal);
            }
            else
            {
                code.I32(0);
            }

            code.Byte(0x47); // i32.ne
            code.Byte(0x04); // if
            code.Byte(0x40);
            if (PoisonGlobal >= 0)
            {
                Poisoned();
            }
            else
            {
                if (recover >= 0)
                {
                    code.I32(0);
                    code.OpIndex(0x10, recover);
                }

                code.I32(0);
                GlobalSet(EntriesGlobal);
                if (ImportsGlobal >= 0)
                {
                    code.I32(0);
                    GlobalSet(ImportsGlobal);
                    Add(EpochGlobal, 1);
                }

                if (twoPass)
                {
                    code.I32(0);
                    GlobalSet(HandlersGlobal);
                    code.I32(0);
                    GlobalSet(HandlerBaseGlobal);
                }
            }

            code.Byte(0x0b); // end
            if (HeapTopGlobal >= 0)
            {
                GlobalGet(EntriesGlobal);
                code.Byte(0x45); // i32.eqz
                code.Byte(0x04); // if
                code.Byte(0x40);
                if (HeapFloorGlobal >= 0)
                {
                    GlobalGet(HeapFloorGlobal);
                }
                else
                {
                    code.I32(HeapBase);
                }

                GlobalSet(HeapTopGlobal);
                code.Byte(0x0b); // end
            }

            Add(EntriesGlobal, 1);
        }

        int savedHandlers = -1;
        if (twoPass)
        {
            // An entry is the handler of last resort: the records of an
            // outer entry are not its own.
            savedHandlers = savedFuel + locals.Count;
            locals.Add(WType.I32);
            locals.Add(WType.I32);
            GlobalGet(HandlersGlobal);
            LocalSet(savedHandlers);
            GlobalGet(HandlerBaseGlobal);
            LocalSet(savedHandlers + 1);
            GlobalGet(HandlersGlobal);
            GlobalSet(HandlerBaseGlobal);
        }

        code.I32(Limits.Fuel);
        GlobalSet(ModuleWriter.FuelGlobal);
        code.I32(0);
        GlobalSet(ModuleWriter.CallDepthGlobal);
        code.I64(Limits.AllocationUnits);
        GlobalSet(ModuleWriter.AllocationBudgetGlobal);
        code.I32(0);
        GlobalSet(ModuleWriter.FaultGlobal);

        // An exception that escapes, from static initialization or the body,
        // ends the entry as a trap with its fault code. With the entry
        // counters and imports, an exception from the host takes the entry
        // off the count on its way out.
        bool host = ImportsGlobal >= 0;
        if (host)
        {
            code.Byte(0x02); // block
            WType.ExnRef.Write(code);
        }

        if (exceptions)
        {
            code.Byte(0x02); // block
            WType.Ref(ExceptionHeap).Write(code);
        }

        if (exceptions || host)
        {
            code.Byte(0x1f); // try_table
            code.Byte(0x40);
            code.Index((exceptions ? 1 : 0) + (host ? 1 : 0));
            if (exceptions)
            {
                code.Byte(0x00); // catch
                code.Index(0); // the tag
                code.Index(0); // the block
            }

            if (host)
            {
                code.Byte(0x03); // catch_all_ref
                code.Index(exceptions ? 1 : 0);
            }
        }

        if (staticInitializer >= 0)
        {
            // Like the CLR's early initialization of beforefieldinit types,
            // this is the module's own business: the entry's budgets start
            // afresh after it.
            GlobalGet(EagerFlagGlobal);
            code.Byte(0x45); // i32.eqz
            code.Byte(0x04); // if
            code.Byte(0x40);
            code.OpIndex(0x10, staticInitializer);
            code.I32(1);
            GlobalSet(EagerFlagGlobal);
            code.I32(Limits.Fuel);
            GlobalSet(ModuleWriter.FuelGlobal);
            code.I64(Limits.AllocationUnits);
            GlobalSet(ModuleWriter.AllocationBudgetGlobal);
            code.Byte(0x0b); // end
        }

        for (int parameter = 0; parameter < plan.Parameters.Length; parameter++)
        {
            LocalGet(parameter);
            // Host-provided values are canonicalized to the C# model: bools
            // to 0/1, narrow integers to their width (the canonical ABI
            // lets a caller leave the high bits unspecified).
            FunctionEmitter.Canonicalize(code, ScalarOf(plan.Symbol!.Parameters[parameter].Type)!.Value);
        }

        code.OpIndex(0x10, body);
        if (result >= 0)
        {
            LocalSet(result);
        }

        if (exceptions || host)
        {
            code.Byte(0x0b); // end try_table
        }

        LocalGet(savedFuel);
        GlobalSet(ModuleWriter.FuelGlobal);
        LocalGet(savedDepth);
        GlobalSet(ModuleWriter.CallDepthGlobal);
        LocalGet(savedBudget);
        GlobalSet(ModuleWriter.AllocationBudgetGlobal);
        if (savedHandlers >= 0)
        {
            LocalGet(savedHandlers);
            GlobalSet(HandlersGlobal);
            LocalGet(savedHandlers + 1);
            GlobalSet(HandlerBaseGlobal);
        }

        Add(EntriesGlobal, -1);

        if (result >= 0)
        {
            LocalGet(result);
        }

        if (exceptions || host)
        {
            code.Byte(0x0f); // return
        }

        if (exceptions)
        {
            code.Byte(0x0b); // end block: the exception
            code.Gc(2, ExceptionHeap, FaultField); // struct.get
            GlobalSet(ModuleWriter.FaultGlobal);
            Add(EntriesGlobal, -1);
            if (PoisonGlobal >= 0)
            {
                // An unhandled exception ends the module, as it ends a .NET
                // process.
                code.I32(1);
                GlobalSet(PoisonGlobal);
            }

            code.Byte(0x00); // unreachable
        }

        if (host)
        {
            code.Byte(0x0b); // end block: from the host
            Add(EntriesGlobal, -1);
            // The import call it came through, if any, was this entry's.
            GlobalGet(EntriesGlobal);
            GlobalSet(ImportsGlobal);
            code.Byte(0x0a); // throw_ref
        }

        code.Byte(0x0b);
        return (locals.ToArray(), code.ToArray());
    }

    // Public static methods of public classes are exported under
    // Namespace.Class.Method when their signatures are scalar; WasmExport names
    // an export explicitly. Anything else stays internal to the module.
    private string? ExportName(IMethodSymbol method)
    {
        if (exportNames.TryGetValue(method, out string? explicitName))
        {
            return explicitName;
        }

        if (method.MethodKind != MethodKind.Ordinary || !method.IsStatic
            // The user's assembly's alone: not the CoreLib's
            // or the framework's public methods.
            || !il.Defines(method)
            || method.IsGenericMethod || method.ContainingType.IsGenericType
            || method.DeclaredAccessibility != Accessibility.Public
            || !IsPubliclyVisible(method.ContainingType)
            || !HasScalarSignature(method))
        {
            return null;
        }

        return method.ContainingType.ToDisplayString() + "." + method.Name;
    }

    private static bool IsPubliclyVisible(INamedTypeSymbol? type)
    {
        for (; type is not null; type = type.ContainingType)
        {
            if (type.DeclaredAccessibility != Accessibility.Public)
            {
                return false;
            }
        }

        return true;
    }

    private static bool HasScalarSignature(IMethodSymbol method) =>
        (method.ReturnsVoid || ScalarOf(method.ReturnType) is not null)
        && method.Parameters.All(parameter => parameter.RefKind == RefKind.None && ScalarOf(parameter.Type) is not null);

    public IReadOnlyList<StaticInitializerPlan> StaticInitializers => staticInitializers;
}
