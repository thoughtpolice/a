// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Gameplay.Compiler;

// Declaration discovery: which classes, fields, properties, constructors and
// methods exist, and which Wasm entity each becomes. Policy violations are
// reported here, before any body is lowered.
internal sealed partial class Frontend
{
    private readonly Dictionary<INamedTypeSymbol, int> nextFieldIndex = new(SymbolEqualityComparer.Default);
    private readonly HashSet<INamedTypeSymbol> scannedTypes = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<INamedTypeSymbol, IMethodSymbol> staticConstructors = new(SymbolEqualityComparer.Default);

    private void Discover(SyntaxTree[] trees)
    {
        var classes = new List<(ClassDeclarationSyntax Syntax, INamedTypeSymbol Symbol)>();
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
                switch (member)
                {
                    case BaseNamespaceDeclarationSyntax namespaceDeclaration:
                        foreach (var nestedMember in namespaceDeclaration.Members)
                        {
                            Visit(nestedMember);
                        }

                        return;
                    case ClassDeclarationSyntax declaration:
                        var symbol = (INamedTypeSymbol?)model.GetDeclaredSymbol(declaration)
                            ?? throw CompileError.At(declaration, "Unresolved class.");
                        if (IsBindingType(symbol))
                        {
                            return;
                        }

                        if ((!symbol.IsStatic && !symbol.IsSealed)
                            || symbol.IsGenericType
                            || declaration.BaseList is not null
                            || declaration.AttributeLists.Count != 0
                            || declaration.ParameterList is not null)
                        {
                            throw CompileError.At(declaration,
                                "Classes must be static or sealed, non-generic, without bases, attributes "
                                + "or primary constructors.");
                        }

                        classes.Add((declaration, symbol));
                        if (!symbol.IsStatic)
                        {
                            AddHeap(symbol);
                        }

                        foreach (var nested in declaration.Members.OfType<BaseTypeDeclarationSyntax>())
                        {
                            Visit(nested);
                        }

                        return;
                    case EnumDeclarationSyntax enumDeclaration:
                        ValidateEnum(enumDeclaration, model);
                        return;
                    default:
                        throw CompileError.At(member,
                            "Only namespaces, static classes, sealed classes and enums are supported.");
                }
            }

            foreach (var member in root.Members)
            {
                Visit(member);
            }
        }

        // Class identities are registered; fields and methods can refer forward.
        foreach (var (syntax, symbol) in classes)
        {
            RegisterBackingFields(symbol);
            var model = compilation.GetSemanticModel(syntax.SyntaxTree);
            foreach (var member in syntax.Members)
            {
                RegisterMember(member, symbol, model);
            }
        }

        OrderStaticInitialization(classes.Select(entry => entry.Symbol));

        // Give implicit constructors real functions when they have initializer
        // work. Recursive allocations then use normal call-depth/fuel limits
        // instead of recursively expanding expressions during compilation.
        foreach (var type in fieldInitializers.Keys)
        {
            foreach (var constructor in type.InstanceConstructors
                         .Where(constructor => constructor.IsImplicitlyDeclared))
            {
                RegisterMethod(constructor, null, MethodPlanKind.Constructor);
            }
        }

        if (methods.Count is < 1 or > 4096)
        {
            throw new CompileError("Expected 1 to 4096 methods.");
        }

        if (globals.Count > 1024)
        {
            throw new CompileError("Static field limit is 1024.");
        }

        // Discover every reference shape before emitting the recursive type group.
        var operationRoots = methods.Select(method => method.Body)
            .Concat(methods.Select(method => method.ConstructorInitializer))
            .Concat(fieldInitializers.Values.SelectMany(initializers => initializers).Select(initializer => initializer.Value))
            .Concat(staticInitializers.Select(initializer => initializer.Value))
            .OfType<IOperation>();
        foreach (var root in operationRoots)
        {
            var pending = new Stack<IOperation>();
            pending.Push(root);
            while (pending.TryPop(out var operation))
            {
                operation = ArrayForEachCollection(ReferenceEqualityOperand(operation));
                if (operation.Type is not null && !IsIgnoredType(operation))
                {
                    MapType(operation.Type);
                }

                // A local gets a Wasm local of its type even when no operation
                // ever reads or writes it.
                foreach (var local in DeclaredLocals(operation))
                {
                    if (!local.IsConst)
                    {
                        MapType(local.Type);
                    }
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
                    .Where(field => fieldIds.ContainsKey(field))
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

    // Some typed operations never produce a value of their type: the
    // discarded target of `_ = e`, and pattern operations, whose Type is the
    // input type but which lower to i32 tests. Neither needs a heap type.
    private static bool IsIgnoredType(IOperation operation) =>
        operation is IDiscardOperation or IPatternOperation;

    // C# runs every static field initializer of a class, in textual order,
    // before its static constructor body, wherever the constructor is
    // declared (including in another part of a partial class). Field steps
    // were collected in declaration order; group them class by class, in the
    // order the classes were discovered, each followed by its constructor.
    private void OrderStaticInitialization(IEnumerable<INamedTypeSymbol> classOrder)
    {
        var fieldSteps = staticInitializers.ToLookup(
            step => step.Field!.ContainingType, SymbolEqualityComparer.Default);
        var ordered = new List<StaticInitializerPlan>();
        foreach (var type in classOrder.Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default))
        {
            ordered.AddRange(fieldSteps[type]);
            if (staticConstructors.TryGetValue(type, out var constructor))
            {
                ordered.Add(new(null, null, constructor));
            }
        }

        staticInitializers.Clear();
        staticInitializers.AddRange(ordered);
    }

    private static IEnumerable<ILocalSymbol> DeclaredLocals(IOperation operation) => operation switch
    {
        IVariableDeclaratorOperation declarator => [declarator.Symbol],
        IBlockOperation block => block.Locals,
        ILoopOperation loop => loop.Locals,
        ISwitchOperation sw => sw.Locals,
        ISwitchCaseOperation section => section.Locals,
        ISwitchExpressionArmOperation arm => arm.Locals,
        _ => [],
    };

    private void ValidateEnum(EnumDeclarationSyntax declaration, SemanticModel model)
    {
        var symbol = (INamedTypeSymbol?)model.GetDeclaredSymbol(declaration)
            ?? throw CompileError.At(declaration, "Unresolved enum.");
        if (ScalarOf(symbol) is null or Scalar.Bool or Scalar.Char or Scalar.F32 or Scalar.F64)
        {
            throw CompileError.At(declaration, "Enum underlying types must be integer types.");
        }

        foreach (var attribute in symbol.GetAttributes())
        {
            if (flagsAttribute is null || !SymbolEqualityComparer.Default.Equals(attribute.AttributeClass, flagsAttribute))
            {
                throw CompileError.At(declaration, "Only the Flags attribute is supported on enums.");
            }
        }
    }

    // Auto-implemented properties (and the `field` keyword) have compiler
    // generated backing fields; they are ordinary fields of the object.
    private void RegisterBackingFields(INamedTypeSymbol type)
    {
        if (!scannedTypes.Add(type))
        {
            return;
        }

        foreach (var field in type.GetMembers().OfType<IFieldSymbol>())
        {
            if (field.AssociatedSymbol is IPropertySymbol)
            {
                RegisterField(field);
            }
        }
    }

    private void RegisterField(IFieldSymbol field)
    {
        MapType(field.Type);
        if (field.IsStatic)
        {
            globalIds.Add(field, globals.Count);
            globals.Add((field, MapType(field.Type)));
            return;
        }

        nextFieldIndex.TryGetValue(field.ContainingType, out int index);
        nextFieldIndex[field.ContainingType] = index + 1;
        fieldIds.Add(field, index);
    }

    private void AddInitializer(IFieldSymbol field, IOperation value)
    {
        if (field.IsStatic)
        {
            staticInitializers.Add(new(field, value, null));
            return;
        }

        if (!fieldInitializers.TryGetValue(field.ContainingType, out var initializers))
        {
            initializers = [];
            fieldInitializers.Add(field.ContainingType, initializers);
        }

        initializers.Add(new(field, value));
    }

    private void RegisterMember(MemberDeclarationSyntax member, INamedTypeSymbol type, SemanticModel model)
    {
        switch (member)
        {
            case BaseTypeDeclarationSyntax:
                // Nested classes and enums were discovered with the top-level ones.
                return;
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

                    if (field.IsVolatile)
                    {
                        throw CompileError.At(variable, "Volatile fields are unsupported.");
                    }

                    RegisterField(field);
                    if (variable.Initializer is not null)
                    {
                        var initializer = model.GetOperation(variable.Initializer) as IFieldInitializerOperation
                            ?? throw CompileError.At(variable.Initializer, "Unresolved field initializer.");
                        AddInitializer(field, initializer.Value);
                    }
                }

                return;
            case PropertyDeclarationSyntax property:
                RegisterProperty(property, model);
                return;
            case MethodDeclarationSyntax method:
                RegisterMethodDeclaration(method, model);
                return;
            case ConstructorDeclarationSyntax constructor:
                RegisterConstructor(constructor, model);
                return;
            default:
                throw CompileError.At(member,
                    "Indexers, events, operators, conversions, finalizers and delegates are not supported.");
        }
    }

    private void RegisterProperty(PropertyDeclarationSyntax property, SemanticModel model)
    {
        var symbol = (IPropertySymbol?)model.GetDeclaredSymbol(property)
            ?? throw CompileError.At(property, "Unresolved property.");
        if (property.AttributeLists.Count != 0 || symbol.ReturnsByRef || symbol.ReturnsByRefReadonly
            || symbol.IsAbstract || symbol.IsVirtual || symbol.IsOverride || symbol.IsExtern)
        {
            throw CompileError.At(property, "Properties must be ordinary, non-virtual and without attributes.");
        }

        MapType(symbol.Type);
        var backingField = symbol.ContainingType.GetMembers()
            .OfType<IFieldSymbol>()
            .FirstOrDefault(field => SymbolEqualityComparer.Default.Equals(field.AssociatedSymbol, symbol));

        if (property.ExpressionBody is not null)
        {
            var body = model.GetOperation(property.ExpressionBody) as IBlockOperation
                ?? throw CompileError.At(property, "Expected an expression-bodied property.");
            RegisterMethod(symbol.GetMethod!, body, MethodPlanKind.Ordinary);
        }
        else
        {
            var accessors = property.AccessorList?.Accessors
                ?? throw CompileError.At(property, "Expected property accessors.");
            var autoAccessors = new List<IMethodSymbol>();
            foreach (var accessor in accessors)
            {
                if (accessor.AttributeLists.Count != 0)
                {
                    throw CompileError.At(accessor, "Accessor attributes are unsupported.");
                }

                var accessorSymbol = (IMethodSymbol?)model.GetDeclaredSymbol(accessor)
                    ?? throw CompileError.At(accessor, "Unresolved accessor.");
                if (accessor.Body is null && accessor.ExpressionBody is null)
                {
                    autoAccessors.Add(accessorSymbol);
                    continue;
                }

                var body = model.GetOperation(accessor) as IMethodBodyOperation;
                var block = body?.BlockBody ?? body?.ExpressionBody
                    ?? throw CompileError.At(accessor, "Expected an ordinary accessor body.");
                RegisterMethod(accessorSymbol, block, MethodPlanKind.Ordinary);
            }

            if (autoAccessors.Count != 0)
            {
                if (backingField is null)
                {
                    throw CompileError.At(property, "Auto-implemented accessors need a backing field.");
                }

                if (autoAccessors.Count == accessors.Count)
                {
                    // Fully automatic: accesses become field accesses, with no
                    // call, fuel or depth cost.
                    autoProperties.Add(symbol, backingField);
                }
                else
                {
                    foreach (var accessor in autoAccessors)
                    {
                        var kind = accessor.MethodKind == MethodKind.PropertyGet
                            ? MethodPlanKind.AutoGetter
                            : MethodPlanKind.AutoSetter;
                        RegisterMethod(accessor, null, kind, autoField: backingField);
                    }
                }
            }
        }

        if (property.Initializer is not null)
        {
            var initializer = model.GetOperation(property.Initializer) as IPropertyInitializerOperation
                ?? throw CompileError.At(property.Initializer, "Unresolved property initializer.");
            AddInitializer(
                backingField ?? throw CompileError.At(property, "Only auto-implemented properties take initializers."),
                initializer.Value);
        }
    }

    private void RegisterMethodDeclaration(MethodDeclarationSyntax method, SemanticModel model)
    {
        var symbol = (IMethodSymbol?)model.GetDeclaredSymbol(method)
            ?? throw CompileError.At(method, "Unresolved method.");
        if (TryRegisterHostImport(method, symbol))
        {
            return;
        }

        // A partial method is one function; its definition part carries the
        // signature Roslyn binds calls to, its implementation part the body.
        if (symbol.IsPartialDefinition)
        {
            if (symbol.PartialImplementationPart is null)
            {
                throw CompileError.At(method, $"Partial method '{symbol.Name}' has no implementation.");
            }

            return;
        }

        var canonical = symbol.PartialDefinitionPart ?? symbol;
        var attributes = canonical.GetAttributes()
            .Concat(symbol.GetAttributes())
            .DistinctBy(attribute => attribute.ApplicationSyntaxReference?.Span)
            .ToArray();
        string? exportName = null;
        foreach (var attribute in attributes)
        {
            if (IsWasmExport(attribute.AttributeClass))
            {
                exportName = ExportAttributeName(attribute, method);
                continue;
            }

            throw CompileError.At(method, "Only the WasmImport and WasmExport attributes are supported on methods.");
        }

        if (symbol.IsGenericMethod || symbol.IsAsync || symbol.IsAbstract
            || symbol.IsVirtual || symbol.IsOverride || symbol.IsExtern
            || symbol.ReturnsByRef || symbol.ReturnsByRefReadonly
            || HasUnsupportedParameters(symbol))
        {
            throw CompileError.At(method,
                "Generic, async, virtual, extern and by-ref methods/parameters are unsupported.");
        }

        var body = model.GetOperation(method) as IMethodBodyOperation;
        var block = body?.BlockBody ?? body?.ExpressionBody
            ?? throw CompileError.At(method, "Expected an ordinary method body.");
        RegisterMethod(canonical, block, MethodPlanKind.Ordinary);

        if (exportName is not null)
        {
            if (!canonical.IsStatic || !HasScalarSignature(canonical))
            {
                throw CompileError.At(method,
                    "WasmExport requires a static method whose parameters and result are scalars.");
            }

            exportNames.Add(canonical, exportName);
        }
    }

    private void RegisterConstructor(ConstructorDeclarationSyntax constructor, SemanticModel model)
    {
        var symbol = (IMethodSymbol?)model.GetDeclaredSymbol(constructor)
            ?? throw CompileError.At(constructor, "Unresolved constructor.");
        if (constructor.AttributeLists.Count != 0 || symbol.IsExtern || HasUnsupportedParameters(symbol))
        {
            throw CompileError.At(constructor,
                "Constructors take no attributes and no optional, params or by-ref parameters.");
        }

        var body = model.GetOperation(constructor) as IConstructorBodyOperation
            ?? throw CompileError.At(constructor, "Expected an ordinary constructor body.");
        var block = body.BlockBody ?? body.ExpressionBody
            ?? throw CompileError.At(constructor, "Expected an ordinary constructor body.");

        if (symbol.IsStatic)
        {
            // A static constructor is an ordinary function the static
            // initializer calls after the class's static field initializers;
            // OrderStaticInitialization places it once they are all known.
            RegisterMethod(symbol, block, MethodPlanKind.Ordinary);
            staticConstructors.Add(symbol.ContainingType, symbol);
            return;
        }

        IOperation? chain = null;
        if (constructor.Initializer is { } initializer)
        {
            if (!initializer.ThisOrBaseKeyword.IsKind(SyntaxKind.ThisKeyword))
            {
                throw CompileError.At(constructor, "Explicit base constructor initializers are unsupported.");
            }

            chain = body.Initializer ?? throw CompileError.At(constructor, "Unresolved constructor initializer.");
        }
        else if (!IsImplicitObjectConstructorCall(body.Initializer))
        {
            throw CompileError.At(constructor,
                "Only the implicit parameterless System.Object base constructor is supported.");
        }

        // Every supported class derives directly from object. Its implicit base
        // constructor does nothing; emit only the source body, keeping
        // framework calls disallowed elsewhere.
        RegisterMethod(symbol, block, MethodPlanKind.Constructor, chain);
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

    private void RegisterMethod(
        IMethodSymbol symbol,
        IBlockOperation? body,
        MethodPlanKind kind,
        IOperation? constructorInitializer = null,
        IFieldSymbol? autoField = null)
    {
        var parameters = new List<WType>();
        if (!symbol.IsStatic)
        {
            parameters.Add(MapType(symbol.ContainingType));
        }

        parameters.AddRange(symbol.Parameters.Select(parameter => MapType(parameter.Type)));
        methodIds.Add(symbol, methods.Count);
        methods.Add(new(
            symbol,
            body,
            symbol.ToDisplayString(),
            parameters.ToArray(),
            MapType(symbol.ReturnType),
            symbol.IsStatic,
            symbol.ContainingType,
            kind,
            constructorInitializer,
            autoField));
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
}
