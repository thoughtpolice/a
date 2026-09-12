using System.Collections.Immutable;
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

internal sealed record Limits(
    int Fuel = 100_000,
    int CallDepth = 64,
    long AllocationUnits = 1_048_576,
    int ArrayLength = 65_536);

internal sealed record SourceFile(string Path, string Text);

internal sealed record MethodPlan(IMethodSymbol Symbol, IBlockOperation? Body, string Name);

internal sealed record FieldInitializerPlan(IFieldSymbol Field, IOperation Value);

internal sealed record CompilationProduct(byte[] Bytes, string[] Exports, int Functions, int HeapTypes);

internal sealed partial class Frontend
{
    private readonly CSharpCompilation compilation;
    private readonly Dictionary<ITypeSymbol, int> heapIds = new(SymbolEqualityComparer.Default);
    private readonly List<ITypeSymbol> heapSymbols = [];
    private readonly Dictionary<IFieldSymbol, int> fieldIds = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<INamedTypeSymbol, List<FieldInitializerPlan>> fieldInitializers =
        new(SymbolEqualityComparer.Default);
    private readonly Dictionary<IMethodSymbol, int> methodIds = new(SymbolEqualityComparer.Default);
    private readonly List<MethodPlan> methods = [];
    private readonly List<HeapDefinition> heaps = [];
    private bool frozen;

    public Limits Limits { get; }

    private Frontend(CSharpCompilation compilation, Limits limits)
    {
        this.compilation = compilation;
        Limits = limits;
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

        var trees = sources.Select(source => CSharpSyntaxTree.ParseText(
            SourceText.From(source.Text, Encoding.UTF8),
            new CSharpParseOptions(LanguageVersion.CSharp14),
            source.Path)).ToArray();

        // A native AOT process has no usable System.Private.CoreLib.dll beside it.
        // The embedded reference assembly supplies metadata without loading code.
        using var resource = typeof(Frontend).Assembly.GetManifestResourceStream(
            "Gameplay.Compiler.Binding.System.Runtime.dll")
            ?? throw new CompileError("Missing embedded binding reference; check the build configuration.");
        using var buffer = new MemoryStream();
        resource.CopyTo(buffer);
        var reference = MetadataReference.CreateFromImage(ImmutableArray.CreateRange(buffer.ToArray()));
        var compilation = CSharpCompilation.Create(
            "Gameplay",
            trees.Append(CSharpSyntaxTree.ParseText(
                HostImportAttributeSource,
                new CSharpParseOptions(LanguageVersion.CSharp14),
                "<gameplay-imports>")),
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

    private void Discover(SyntaxTree[] trees)
    {
        var classes = new List<ClassDeclarationSyntax>();
        foreach (var tree in trees)
        {
            var root = (CompilationUnitSyntax)tree.GetRoot();
            if (root.AttributeLists.Count != 0)
            {
                throw CompileError.At(root, "Assembly/module attributes are not supported.");
            }

            var model = compilation.GetSemanticModel(tree);
            void Visit(MemberDeclarationSyntax member)
            {
                if (member is BaseNamespaceDeclarationSyntax namespaceDeclaration)
                {
                    foreach (var nestedMember in namespaceDeclaration.Members)
                    {
                        Visit(nestedMember);
                    }

                    return;
                }

                if (member is not ClassDeclarationSyntax declaration)
                {
                    throw CompileError.At(member, "Only namespaces, static classes and sealed classes are supported.");
                }

                var symbol = (INamedTypeSymbol?)model.GetDeclaredSymbol(declaration)
                    ?? throw CompileError.At(declaration, "Unresolved class.");
                if ((!symbol.IsStatic && !symbol.IsSealed)
                    || symbol.IsGenericType
                    || declaration.BaseList is not null
                    || declaration.AttributeLists.Count != 0
                    || declaration.ParameterList is not null
                    || declaration.Modifiers.Any(SyntaxKind.PartialKeyword))
                {
                    throw CompileError.At(declaration,
                        "Classes must be static or sealed, non-generic, without bases, attributes, "
                        + "primary constructors or partial declarations.");
                }

                classes.Add(declaration);
                if (!symbol.IsStatic)
                {
                    AddHeap(symbol);
                }
            }

            foreach (var member in root.Members)
            {
                Visit(member);
            }
        }

        // Register class identities first so fields and methods can refer forward.
        foreach (var syntax in classes)
        {
            var model = compilation.GetSemanticModel(syntax.SyntaxTree);
            int fieldIndex = 0;
            foreach (var member in syntax.Members)
            {
                switch (member)
                {
                    case FieldDeclarationSyntax declaration:
                        if (declaration.AttributeLists.Count != 0)
                        {
                            throw CompileError.At(declaration, "Field attributes are unsupported.");
                        }

                        foreach (var variable in declaration.Declaration.Variables)
                        {
                            var field = (IFieldSymbol?)model.GetDeclaredSymbol(variable)
                                ?? throw CompileError.At(variable, "Unresolved field.");
                            MapType(field.Type);
                            if (field.IsConst)
                            {
                                // Roslyn's constant evaluator handles constant fields.
                                continue;
                            }

                            if (field.IsStatic || field.IsReadOnly || field.IsVolatile)
                            {
                                throw CompileError.At(variable,
                                    "Only mutable instance fields, plus constants, are supported.");
                            }

                            fieldIds.Add(field, fieldIndex++);
                            if (variable.Initializer is not null)
                            {
                                var initializer = model.GetOperation(variable.Initializer) as IFieldInitializerOperation
                                    ?? throw CompileError.At(variable.Initializer, "Unresolved field initializer.");
                                if (!fieldInitializers.TryGetValue(field.ContainingType, out var initializers))
                                {
                                    initializers = [];
                                    fieldInitializers.Add(field.ContainingType, initializers);
                                }

                                initializers.Add(new(field, initializer.Value));
                            }
                        }

                        break;
                    case MethodDeclarationSyntax method:
                        var methodSymbol = (IMethodSymbol?)model.GetDeclaredSymbol(method)
                            ?? throw CompileError.At(method, "Unresolved method.");
                        if (TryRegisterHostImport(method, methodSymbol))
                        {
                            break;
                        }

                        if (methodSymbol.IsGenericMethod || methodSymbol.IsAsync || methodSymbol.IsAbstract
                            || methodSymbol.IsVirtual || methodSymbol.IsOverride || methodSymbol.IsExtern
                            || methodSymbol.ReturnsByRef || methodSymbol.ReturnsByRefReadonly
                            || method.AttributeLists.Count != 0
                            || HasUnsupportedParameters(methodSymbol)
                            || method.Modifiers.Any(SyntaxKind.PartialKeyword))
                        {
                            throw CompileError.At(method,
                                "Generic, async, virtual, extern, attributed, partial and by-ref methods/parameters are unsupported.");
                        }

                        var body = model.GetOperation(method) as IMethodBodyOperation;
                        var block = body?.BlockBody ?? body?.ExpressionBody
                            ?? throw CompileError.At(method, "Expected an ordinary method body.");
                        RegisterMethod(methodSymbol, block);
                        break;
                    case ConstructorDeclarationSyntax constructor:
                        var constructorSymbol = (IMethodSymbol?)model.GetDeclaredSymbol(constructor)
                            ?? throw CompileError.At(constructor, "Unresolved constructor.");
                        if (constructorSymbol.IsStatic || constructorSymbol.IsExtern
                            || constructor.AttributeLists.Count != 0
                            || constructor.Initializer is not null
                            || HasUnsupportedParameters(constructorSymbol))
                        {
                            throw CompileError.At(constructor,
                                "Only ordinary instance constructors without attributes, constructor chaining, "
                                + "explicit base initializers, or optional/params/by-ref parameters are supported.");
                        }

                        var constructorBody = model.GetOperation(constructor) as IConstructorBodyOperation
                            ?? throw CompileError.At(constructor, "Expected an ordinary constructor body.");
                        if (!IsImplicitObjectConstructorCall(constructorBody.Initializer))
                        {
                            throw CompileError.At(constructor,
                                "Only the implicit parameterless System.Object base constructor is supported.");
                        }

                        // Every supported class derives directly from object. Its
                        // implicit base constructor does nothing; emit only the
                        // source body, keeping framework calls disallowed elsewhere.
                        var constructorBlock = constructorBody.BlockBody ?? constructorBody.ExpressionBody
                            ?? throw CompileError.At(constructor, "Expected an ordinary constructor body.");
                        RegisterMethod(constructorSymbol, constructorBlock);
                        break;
                    default:
                        throw CompileError.At(member, "Properties, events, operators and nested declarations are not supported.");
                }
            }
        }

        // Give implicit constructors real functions when they have initializer
        // work. Recursive allocations then use normal call-depth/fuel limits
        // instead of recursively expanding expressions during compilation.
        foreach (var type in fieldInitializers.Keys)
        {
            foreach (var constructor in type.InstanceConstructors
                         .Where(constructor => constructor.IsImplicitlyDeclared))
            {
                RegisterMethod(constructor, null);
            }
        }

        if (methods.Count is < 1 or > 4096)
        {
            throw new CompileError("Expected 1 to 4096 methods.");
        }

        // Discover every reference shape before emitting the recursive type group.
        var initializerExpressions = fieldInitializers.Values
            .SelectMany(initializers => initializers)
            .Select(initializer => initializer.Value);
        var operationRoots = methods.Select(method => method.Body)
            .OfType<IOperation>()
            .Concat(initializerExpressions);
        foreach (var root in operationRoots)
        {
            var pending = new Stack<IOperation>();
            pending.Push(root);
            while (pending.TryPop(out var operation))
            {
                operation = ArrayForEachCollection(ReferenceEqualityOperand(operation));
                if (operation.Type is not null)
                {
                    MapType(operation.Type);
                }

                foreach (var child in operation.ChildOperations)
                {
                    pending.Push(child);
                }
            }
        }

        for (int i = 0; i < heapSymbols.Count; i++)
        {
            var type = heapSymbols[i];
            if (type is IArrayTypeSymbol array)
            {
                heaps.Add(new(type.ToDisplayString(), true, [MapType(array.ElementType)]));
            }
            else
            {
                var fields = ((INamedTypeSymbol)type).GetMembers()
                    .OfType<IFieldSymbol>()
                    .Where(field => !field.IsStatic && !field.IsConst)
                    .OrderBy(field => fieldIds[field]);
                heaps.Add(new(type.ToDisplayString(), false, fields.Select(field => MapType(field.Type)).ToArray()));
            }
        }

        frozen = true;
        if (heaps.Count > 1024)
        {
            throw new CompileError("Heap type limit is 1024.");
        }
    }

    private static bool HasUnsupportedParameters(IMethodSymbol method) => method.Parameters.Any(parameter =>
        parameter.RefKind != RefKind.None || parameter.IsParams || parameter.IsOptional
        || parameter.GetAttributes().Length != 0);

    private static bool IsImplicitObjectConstructorCall(IOperation? initializer) => initializer is
        IExpressionStatementOperation
    {
        IsImplicit: true,
        Operation: IInvocationOperation
        {
            IsImplicit: true,
            TargetMethod:
            {
                MethodKind: MethodKind.Constructor,
                ContainingType.SpecialType: SpecialType.System_Object,
                Parameters.Length: 0
            },
            Arguments.Length: 0,
            Instance: IInstanceReferenceOperation
            {
                IsImplicit: true,
                ReferenceKind: InstanceReferenceKind.ContainingTypeInstance
            }
        }
    };

    private void RegisterMethod(IMethodSymbol symbol, IBlockOperation? body)
    {
        MapType(symbol.ReturnType);
        foreach (var parameter in symbol.Parameters)
        {
            MapType(parameter.Type);
        }

        methodIds.Add(symbol, methods.Count);
        methods.Add(new(symbol, body, symbol.ToDisplayString()));
    }

    // Roslyn widens operands of built-in reference equality to object. Keep the
    // source reference types for Wasm without admitting object values or boxing.
    public static IOperation ReferenceEqualityOperand(IOperation operation)
    {
        if (operation is IConversionOperation
            {
                IsImplicit: true,
                Conversion.IsReference: true,
                Type.SpecialType: SpecialType.System_Object,
                Parent: IBinaryOperation
                {
                    OperatorKind: BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals,
                    OperatorMethod: null,
                    IsLifted: false
                }
            } conversion)
        {
            return conversion.Operand;
        }

        return operation;
    }

    // Roslyn models array foreach through an implicit IEnumerable conversion.
    // Lower the original array directly without allowing interface values into
    // the language subset or accepting unrelated conversions to IEnumerable.
    public static IOperation ArrayForEachCollection(IOperation operation)
    {
        if (operation is IConversionOperation
            {
                IsImplicit: true,
                Conversion.IsReference: true,
                OperatorMethod: null,
                Type.SpecialType: SpecialType.System_Collections_IEnumerable,
                Operand.Type: IArrayTypeSymbol { Rank: 1, IsSZArray: true },
                Parent: IForEachLoopOperation loop
            } conversion
            && ReferenceEquals(loop.Collection, conversion))
        {
            return conversion.Operand;
        }

        return operation;
    }

    private int AddHeap(ITypeSymbol type)
    {
        if (heapIds.TryGetValue(type, out int id))
        {
            return id;
        }

        if (frozen)
        {
            throw new CompileError("Internal error: heap type discovery was incomplete.");
        }

        id = heapSymbols.Count;
        heapIds.Add(type, id);
        heapSymbols.Add(type);
        return id;
    }

    public WType MapType(ITypeSymbol? type)
    {
        if (type is null)
        {
            throw new CompileError("An untyped operation is outside this subset.");
        }

        switch (type.SpecialType)
        {
            case SpecialType.System_Void:
                return WType.Void;
            case SpecialType.System_Int32:
            case SpecialType.System_Boolean:
                return WType.I32;
            case SpecialType.System_Single:
                return WType.F32;
            case SpecialType.System_Double:
                return WType.F64;
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
            + "Allowed: int, bool, float, double, sealed source classes and one-dimensional arrays of these types.");
    }

    public int FieldIndex(IFieldSymbol field, IOperation site) => fieldIds.TryGetValue(field, out int id)
        ? id
        : throw CompileError.At(site, "Field is not a supported source instance field.");

    public int MethodIndex(IMethodSymbol method, IOperation site)
    {
        if (importIds.TryGetValue(method, out int importIndex))
        {
            return importIndex;
        }

        return methodIds.TryGetValue(method, out int id)
            ? imports.Count + id
            : throw CompileError.At(site,
                $"Call to '{method.ToDisplayString()}' is not allowed. Declare host calls with WasmImport.");
    }

    public int ConstructorIndex(IMethodSymbol constructor, IOperation site) =>
        constructor.IsImplicitlyDeclared && !methodIds.ContainsKey(constructor)
            ? -1
            : MethodIndex(constructor, site);

    public IReadOnlyList<FieldInitializerPlan> FieldInitializers(INamedTypeSymbol type) =>
        fieldInitializers.TryGetValue(type, out var initializers) ? initializers : [];

    public int FieldCount(WType type) => heaps[type.Heap].Fields.Length;

    private CompilationProduct Emit()
    {
        var functions = new List<WasmFunction>();
        foreach (var method in methods)
        {
            functions.Add(new FunctionEmitter(this, method).Emit());
        }

        var exports = new List<WasmExport>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < methods.Count; index++)
        {
            var method = methods[index].Symbol;
            if (!method.IsStatic || method.DeclaredAccessibility != Accessibility.Public)
            {
                continue;
            }

            string name = method.ContainingType.ToDisplayString() + "." + method.Name;
            if (!names.Add(name))
            {
                throw new CompileError($"Public export overload '{name}' is unsupported; use distinct method names.");
            }

            WType result = MapType(method.ReturnType);
            WType[] parameters = method.Parameters.Select(parameter => MapType(parameter.Type)).ToArray();
            if (result.IsRef || parameters.Any(parameter => parameter.IsRef))
            {
                throw new CompileError(
                    $"Export '{name}' must have primitive/void signature. "
                    + "Reference-valued helpers must be non-public or instance methods.");
            }

            var code = new WasmWriter();
            // Each host entry gets fresh fuel, call depth, allocation budget and fault state.
            code.I32(Limits.Fuel);
            code.OpIndex(0x24, 0); // global.set fuel
            code.I32(0);
            code.OpIndex(0x24, 1); // global.set call depth
            code.I64(Limits.AllocationUnits);
            code.OpIndex(0x24, 2); // global.set allocation budget
            code.I32(0);
            code.OpIndex(0x24, 3); // global.set fault

            for (int parameter = 0; parameter < parameters.Length; parameter++)
            {
                code.OpIndex(0x20, parameter);
                // Host-provided booleans are canonicalized to the C# 0/1 model.
                if (method.Parameters[parameter].Type.SpecialType == SpecialType.System_Boolean)
                {
                    code.Byte(0x45);
                    code.Byte(0x45);
                }
            }

            code.OpIndex(0x10, imports.Count + index);
            code.Byte(0x0b);
            exports.Add(new(name, imports.Count + functions.Count));
            functions.Add(new(name + " [entry]", parameters, result, [], code.ToArray()));
        }

        if (exports.Count == 0)
        {
            throw new CompileError("At least one public static entry method is required.");
        }

        return new(
            ModuleWriter.Write(heaps, imports, functions, exports),
            exports.Select(export => export.Name).ToArray(),
            imports.Count + functions.Count,
            heaps.Count);
    }
}
