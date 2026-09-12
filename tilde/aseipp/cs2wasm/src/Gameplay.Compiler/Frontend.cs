// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace Gameplay.Compiler;

internal sealed class CompileError(string message) : Exception(message)
{
    public static CompileError At(SyntaxNode syntax, string message)
    {
        var span = syntax.GetLocation().GetLineSpan();
        int line = span.StartLinePosition.Line + 1;
        int column = span.StartLinePosition.Character + 1;
        return new($"{span.Path}({line},{column}): GP1000: {message}");
    }

    public static CompileError At(IOperation operation, string message) => At(operation.Syntax, message);
}

// A broken compiler invariant, never a verdict on the source: the driver
// reports it with the internal-error exit status rather than as a rejection.
internal sealed class InternalCompilerError(string message) : Exception(message);

internal sealed record Limits(
    int Fuel = 100_000,
    int CallDepth = 64,
    long AllocationUnits = 1_048_576,
    int ArrayLength = 65_536);

internal sealed record SourceFile(string Path, string Text);

internal enum MethodPlanKind
{
    Ordinary,
    Constructor,
    // The synthesized function that runs every static field initializer and
    // static constructor, once, before the first exported entry proceeds.
    StaticInitializer,
    // An auto-implemented accessor of a property whose other accessor has a
    // body: a load or store of the backing field.
    AutoGetter,
    AutoSetter,
}

// A Wasm function to emit. Symbol is null for the static initializer.
internal sealed record MethodPlan(
    IMethodSymbol? Symbol,
    IBlockOperation? Body,
    string Name,
    WType[] Parameters,
    WType Result,
    bool IsStatic,
    INamedTypeSymbol? ContainingType,
    MethodPlanKind Kind,
    IOperation? ConstructorInitializer = null,
    IFieldSymbol? AutoField = null);

internal sealed record FieldInitializerPlan(IFieldSymbol Field, IOperation Value);

// One step of static initialization: a static field's initializer, or a
// static constructor to call. Class by class, a class's field initializers run
// in declaration order, then its static constructor.
internal sealed record StaticInitializerPlan(IFieldSymbol? Field, IOperation? Value, IMethodSymbol? Constructor);

internal sealed record CompilationProduct(byte[] Bytes, string[] Exports, int Functions, int HeapTypes);

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

    private readonly CSharpCompilation compilation;
    private readonly Dictionary<ITypeSymbol, int> heapIds = new(SymbolEqualityComparer.Default);
    private readonly List<ITypeSymbol> heapSymbols = [];
    private readonly Dictionary<IFieldSymbol, int> fieldIds = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IFieldSymbol, int> globalIds = new(SymbolEqualityComparer.Default);
    private readonly List<(IFieldSymbol Field, WType Type)> globals = [];
    private readonly Dictionary<INamedTypeSymbol, List<FieldInitializerPlan>> fieldInitializers =
        new(SymbolEqualityComparer.Default);
    private readonly List<StaticInitializerPlan> staticInitializers = [];
    private readonly Dictionary<IMethodSymbol, int> methodIds = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IPropertySymbol, IFieldSymbol> autoProperties = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IMethodSymbol, string> exportNames = new(SymbolEqualityComparer.Default);
    private readonly List<MethodPlan> methods = [];
    private readonly List<HeapDefinition> heaps = [];
    private bool frozen;

    public Limits Limits { get; }

    // Well-known symbols, resolved once and compared by identity rather than
    // by name. The binding attributes are null when no source declares them.
    private readonly INamedTypeSymbol? wasmImportAttribute;
    private readonly INamedTypeSymbol? wasmExportAttribute;
    private readonly INamedTypeSymbol? flagsAttribute;

    public IPropertySymbol ArrayLength { get; }

    private Frontend(CSharpCompilation compilation, Limits limits)
    {
        this.compilation = compilation;
        Limits = limits;
        wasmImportAttribute = compilation.GetTypeByMetadataName("Gameplay.WasmImportAttribute");
        wasmExportAttribute = compilation.GetTypeByMetadataName("Gameplay.WasmExportAttribute");
        flagsAttribute = compilation.GetTypeByMetadataName("System.FlagsAttribute");
        ArrayLength = compilation.GetSpecialType(SpecialType.System_Array)
            .GetMembers("Length")
            .OfType<IPropertySymbol>()
            .Single();
        intrinsics = ResolveIntrinsics(compilation);
    }

    public static CompilationProduct Compile(IReadOnlyList<SourceFile> sources, Limits limits)
    {
        if (sources.Count is < 1 or > 128)
        {
            throw new CompileError("Provide 1 to 128 source files.");
        }

        if (sources.Sum(source => (long)source.Text.Length) > 2_000_000)
        {
            throw new CompileError("Source limit is 2,000,000 UTF-16 code units.");
        }

        var parseOptions = new CSharpParseOptions(LanguageVersion.CSharp14);
        var trees = sources.Select(source => CSharpSyntaxTree.ParseText(
            SourceText.From(source.Text, Encoding.UTF8),
            parseOptions,
            source.Path)).ToArray();

        // A native AOT process has no usable System.Private.CoreLib.dll beside it.
        // The embedded reference assembly supplies metadata without loading code.
        var reference = MetadataReference.CreateFromImage(
            ImmutableCollectionsMarshal.AsImmutableArray(ReadResource("Gameplay.Compiler.Binding.System.Runtime.dll")));

        // The attribute declarations are bound like any source, unless the
        // designer's sources already carry the SDK's copy of them.
        var allTrees = trees.AsEnumerable();
        if (!trees.Any(DeclaresBindingTypes))
        {
            allTrees = allTrees.Append(CSharpSyntaxTree.ParseText(
                SourceText.From(Encoding.UTF8.GetString(ReadResource(BindingResource))),
                parseOptions,
                BindingPath));
        }

        var compilation = CSharpCompilation.Create(
            "Gameplay",
            allTrees,
            [reference],
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                optimizationLevel: OptimizationLevel.Release,
                checkOverflow: false,
                allowUnsafe: false,
                concurrentBuild: false,
                deterministic: true,
                nullableContextOptions: NullableContextOptions.Disable));
        var diagnostics = compilation.GetDiagnostics()
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .ToArray();
        if (diagnostics.Length != 0)
        {
            throw new CompileError(string.Join(Environment.NewLine, diagnostics.Take(32).Select(d => d.ToString())));
        }

        var frontend = new Frontend(compilation, limits);
        frontend.Discover(trees);
        return frontend.Emit();
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

    private bool IsBindingType(INamedTypeSymbol symbol) => IsWasmImport(symbol) || IsWasmExport(symbol);

    private bool IsWasmImport(INamedTypeSymbol? symbol) =>
        wasmImportAttribute is not null && SymbolEqualityComparer.Default.Equals(symbol, wasmImportAttribute);

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

        if (type.SpecialType == SpecialType.System_Void)
        {
            return WType.Void;
        }

        if (ScalarOf(type) is { } scalar)
        {
            return Represent(scalar);
        }

        if (heapIds.TryGetValue(type, out int index))
        {
            return WType.Ref(index);
        }

        if (type is IArrayTypeSymbol array && array.Rank == 1 && array.IsSZArray)
        {
            MapType(array.ElementType); // recursively register jagged element arrays
            return WType.Ref(AddHeap(type));
        }

        throw new CompileError(
            $"GP1001: Type '{type.ToDisplayString()}' is unsupported. "
            + "Allowed: bool, the integer types, char, float, double, enums, sealed source classes "
            + "and one-dimensional arrays of these types.");
    }

    private int AddHeap(ITypeSymbol type)
    {
        if (heapIds.TryGetValue(type, out int id))
        {
            return id;
        }

        if (frozen)
        {
            throw new InternalCompilerError("heap type discovery was incomplete.");
        }

        id = heapSymbols.Count;
        heapIds.Add(type, id);
        heapSymbols.Add(type);
        return id;
    }

    // MARK: Lookups used by the emitter

    // Lookups take the operation they serve for the error location; the
    // synthesized functions have none.
    private static CompileError Error(IOperation? site, string message) =>
        site is null ? new CompileError(message) : CompileError.At(site, message);

    public int FieldIndex(IFieldSymbol field, IOperation? site) => fieldIds.TryGetValue(field, out int id)
        ? id
        : throw Error(site, "Field is not a supported source instance field.");

    public int GlobalIndex(IFieldSymbol field, IOperation? site) => globalIds.TryGetValue(field, out int id)
        ? ModuleWriter.RuntimeGlobals.Length + id
        : throw Error(site, "Field is not a supported source static field.");

    public bool TryAutoProperty(IPropertySymbol property, out IFieldSymbol field)
    {
        return autoProperties.TryGetValue(property.OriginalDefinition, out field!);
    }

    public int MethodIndex(IMethodSymbol method, IOperation? site)
    {
        method = method.PartialDefinitionPart ?? method;
        if (importIds.TryGetValue(method, out int importIndex))
        {
            return importIndex;
        }

        return methodIds.TryGetValue(method, out int id)
            ? imports.Count + id
            : throw Error(site,
                $"Call to '{method.ToDisplayString()}' is not allowed. Declare host calls with WasmImport.");
    }

    public int ConstructorIndex(IMethodSymbol constructor, IOperation site) =>
        constructor.IsImplicitlyDeclared && !methodIds.ContainsKey(constructor)
            ? -1
            : MethodIndex(constructor, site);

    public IReadOnlyList<FieldInitializerPlan> FieldInitializers(INamedTypeSymbol type) =>
        fieldInitializers.TryGetValue(type, out var initializers) ? initializers : [];

    public IReadOnlyList<StaticInitializerPlan> StaticInitializers => staticInitializers;

    public int FieldCount(WType type) => heaps[type.Heap].Fields.Length;

    // MARK: Emission

    private MethodPlan StaticInitializerPlan => new(
        null, null, "<static initializer>", [], WType.Void, true, null, MethodPlanKind.StaticInitializer);

    // Function indices before pruning count the imports, then `methods`, then
    // the static initializer. Bodies come back with their call sites, whose
    // function indices are filled in once pruning has fixed them.
    private List<(WasmFunction Function, List<(int Offset, int Function)> Calls)> EmitFunctions()
    {
        var plans = methods.AsEnumerable();
        if (staticInitializers.Count != 0)
        {
            plans = plans.Append(StaticInitializerPlan);
        }

        var functions = new List<(WasmFunction, List<(int, int)>)>();
        foreach (var plan in plans)
        {
            var emitter = new FunctionEmitter(this, plan);
            functions.Add((emitter.Emit(), emitter.Calls));
        }

        return functions;
    }

    // Splices each call's final function index in at its offset.
    private static WasmFunction Link(WasmFunction function, List<(int Offset, int Function)> calls, int[] emitted)
    {
        var code = new WasmWriter();
        int start = 0;
        foreach (var (offset, callee) in calls)
        {
            code.Bytes(function.Instructions.AsSpan(start, offset - start));
            code.Index(emitted[callee]);
            start = offset;
        }

        code.Bytes(function.Instructions.AsSpan(start));
        return function with { Instructions = code.ToArray() };
    }

    private CompilationProduct Emit()
    {
        // Every body is lowered, so unsupported code is rejected wherever it
        // is, and the call graph is recorded.
        var allFunctions = EmitFunctions();
        int staticInitializer = staticInitializers.Count != 0 ? imports.Count + methods.Count : -1;

        var exported = new List<(int Function, string Name, MethodPlan Plan)>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < methods.Count; index++)
        {
            var plan = methods[index];
            if (plan.Symbol is null || ExportName(plan.Symbol) is not { } name)
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
        // a host should only have to supply the ones it calls.
        var reachable = new HashSet<int>();
        var pending = new Stack<int>(exported.Select(export => export.Function));
        if (staticInitializer >= 0)
        {
            pending.Push(staticInitializer);
        }

        while (pending.TryPop(out int function))
        {
            if (!reachable.Add(function) || function < imports.Count)
            {
                continue;
            }

            foreach (var (_, callee) in allFunctions[function - imports.Count].Calls)
            {
                pending.Push(callee);
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
                emitted[imports.Count + index] = keptImports.Count + kept.Count;
                kept.Add(index);
            }
        }

        var functions = kept
            .Select(index => Link(allFunctions[index].Function, allFunctions[index].Calls, emitted))
            .ToList();

        // Static fields live after the runtime globals; a flag after them
        // records how far static initialization has got.
        var moduleGlobals = globals
            .Select(global => new WasmGlobal(global.Field.ToDisplayString(), global.Type))
            .ToList();
        int initializedGlobal = -1;
        if (staticInitializer >= 0)
        {
            initializedGlobal = ModuleWriter.RuntimeGlobals.Length + moduleGlobals.Count;
            moduleGlobals.Add(new WasmGlobal("__initialized", WType.I32));
        }

        var exports = new List<WasmExport>();
        foreach (var (function, name, plan) in exported)
        {
            int staticInitializerFunction = staticInitializer >= 0 ? emitted[staticInitializer] : -1;
            var (locals, code) = EmitEntry(plan, emitted[function], staticInitializerFunction, initializedGlobal);
            exports.Add(new(name, keptImports.Count + functions.Count));
            functions.Add(new(name + " [entry]", plan.Parameters, plan.Result, locals, code));
        }

        return new(
            ModuleWriter.Write(heaps, keptImports, functions, exports, moduleGlobals),
            exports.Select(export => export.Name).ToArray(),
            keptImports.Count + functions.Count,
            heaps.Count);
    }

    // The static initialization flag: not run yet (or abandoned by a fault),
    // running, or complete.
    private const int StaticInitPending = 0;
    private const int StaticInitRunning = 1;
    private const int StaticInitDone = 2;

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
    // Static initialization runs once, on the first entry that gets that far.
    // An entry that finds it running is either a re-entrant call from a host
    // import during initialization, which is refused with fault 12 rather
    // than running initialization twice or on half-initialized state, or a
    // call after one whose initialization was unwound. A compiler fault
    // leaves `__fault` set, so that case retries initialization; a host
    // exception leaves no trace, so the next entry is refused once (the
    // refusal clears the flag) and the one after that retries.
    private (WType[] Locals, byte[] Code) EmitEntry(
        MethodPlan plan,
        int body,
        int staticInitializer,
        int initializedGlobal)
    {
        var code = new WasmWriter();
        void GlobalGet(int index) => code.OpIndex(0x23, index);
        void GlobalSet(int index) => code.OpIndex(0x24, index);
        void LocalGet(int index) => code.OpIndex(0x20, index);
        void LocalSet(int index) => code.OpIndex(0x21, index);

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

        if (staticInitializer >= 0)
        {
            GlobalGet(initializedGlobal);
            code.I32(StaticInitRunning);
            code.Byte(0x46); // i32.eq
            code.Byte(0x04); // if
            code.Byte(0x40);
            code.I32(StaticInitPending);
            GlobalSet(initializedGlobal);
            GlobalGet(ModuleWriter.FaultGlobal);
            code.Byte(0x45); // i32.eqz
            code.Byte(0x04); // if
            code.Byte(0x40);
            code.I32((int)FunctionEmitter.FaultCode.ReentrantStaticInitialization);
            GlobalSet(ModuleWriter.FaultGlobal);
            code.Byte(0x00); // unreachable
            code.Byte(0x0b); // end
            code.Byte(0x0b); // end
        }

        code.I32(Limits.Fuel);
        GlobalSet(ModuleWriter.FuelGlobal);
        code.I32(0);
        GlobalSet(ModuleWriter.CallDepthGlobal);
        code.I64(Limits.AllocationUnits);
        GlobalSet(ModuleWriter.AllocationBudgetGlobal);
        code.I32(0);
        GlobalSet(ModuleWriter.FaultGlobal);

        if (staticInitializer >= 0)
        {
            // Initialization runs on the budget of the entry that starts it.
            // A fault leaves the flag at running; the next entry sees the
            // fault code and tries again rather than running on
            // half-initialized state.
            GlobalGet(initializedGlobal);
            code.I32(StaticInitPending);
            code.Byte(0x46); // i32.eq
            code.Byte(0x04); // if
            code.Byte(0x40);
            code.I32(StaticInitRunning);
            GlobalSet(initializedGlobal);
            code.OpIndex(0x10, staticInitializer);
            code.I32(StaticInitDone);
            GlobalSet(initializedGlobal);
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

        LocalGet(savedFuel);
        GlobalSet(ModuleWriter.FuelGlobal);
        LocalGet(savedDepth);
        GlobalSet(ModuleWriter.CallDepthGlobal);
        LocalGet(savedBudget);
        GlobalSet(ModuleWriter.AllocationBudgetGlobal);
        if (result >= 0)
        {
            LocalGet(result);
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
        && method.Parameters.All(parameter => ScalarOf(parameter.Type) is not null);
}
