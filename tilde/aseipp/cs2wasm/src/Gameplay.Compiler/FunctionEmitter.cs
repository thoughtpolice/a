// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Gameplay.Compiler;

// Translates structured Roslyn operations directly into structured Wasm.
// Unsupported operations fail closed, including those in unreachable source.
// This file holds the function shell, locations, calls and allocation; the
// numeric, control-flow and intrinsic lowerings are in the other parts.
internal sealed partial class FunctionEmitter
{
    private readonly Frontend frontend;
    private readonly MethodPlan plan;
    private readonly WasmWriter code = new();
    private readonly List<WType> locals = [];
    private readonly Dictionary<ILocalSymbol, int> localIds = new(SymbolEqualityComparer.Default);
    private readonly List<object> labels = [];
    private readonly Stack<int> initializerReceivers = new();
    private readonly object returnLabel = new();
    private readonly int parameterCount;
    private readonly int returnSlot;

    public FunctionEmitter(Frontend frontend, MethodPlan plan)
    {
        this.frontend = frontend;
        this.plan = plan;
        parameterCount = plan.Parameters.Length;
        returnSlot = plan.Result == WType.Void ? -1 : NewLocal(plan.Result);
    }

    public WasmFunction Emit()
    {
        ConsumeFuel();
        GlobalGet(ModuleWriter.CallDepthGlobal);
        code.I32(frontend.Limits.CallDepth);
        code.Byte(0x4f); // i32.ge_u
        FaultIf(FaultCode.CallDepthExceeded);

        GlobalGet(ModuleWriter.CallDepthGlobal);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        GlobalSet(ModuleWriter.CallDepthGlobal);

        // Returns branch to this shared exit so every successful call restores depth.
        OpenBlock(0x02, WType.Void, returnLabel);
        switch (plan.Kind)
        {
            case MethodPlanKind.Constructor when plan.ConstructorInitializer is not null:
                // `: this(...)` runs the other constructor, which is the one
                // that runs the field initializers.
                EmitConstructorChain(plan.ConstructorInitializer);
                break;
            case MethodPlanKind.Constructor:
                EmitFieldInitializers();
                break;
            case MethodPlanKind.StaticInitializer:
                EmitStaticInitializers();
                break;
            case MethodPlanKind.AutoGetter:
                EmitAutoAccessor(store: false);
                break;
            case MethodPlanKind.AutoSetter:
                EmitAutoAccessor(store: true);
                break;
        }

        if (plan.Body is not null)
        {
            EmitStatement(plan.Body);
        }

        CloseBlock();

        GlobalGet(ModuleWriter.CallDepthGlobal);
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        GlobalSet(ModuleWriter.CallDepthGlobal);
        if (returnSlot >= 0)
        {
            LocalGet(returnSlot);
        }

        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // MARK: Locals, blocks and faults

    private int NewLocal(WType type)
    {
        if (type == WType.Void)
        {
            throw new InternalCompilerError("void local.");
        }

        int id = parameterCount + locals.Count;
        locals.Add(type);
        return id;
    }

    // A local's slot, allocated at its first declaration. A switch block
    // declares its locals ahead of time (see EmitSwitch); their declarators
    // then find the slot already there.
    private int DeclareLocal(ILocalSymbol symbol)
    {
        if (!localIds.TryGetValue(symbol, out int local))
        {
            local = NewLocal(frontend.MapType(symbol.Type));
            localIds.Add(symbol, local);
        }

        return local;
    }

    private int ParameterSlot(IParameterSymbol parameter) => parameter.Ordinal + (plan.IsStatic ? 0 : 1);

    private void LocalGet(int id) => code.OpIndex(0x20, id);
    private void LocalSet(int id) => code.OpIndex(0x21, id);
    private void GlobalGet(int id) => code.OpIndex(0x23, id);
    private void GlobalSet(int id) => code.OpIndex(0x24, id);

    // Each call's callee, by its index before pruning, and the code offset
    // where its final index belongs. The code leaves the index out: the
    // frontend keeps only what the exports reach, then splices them in.
    public List<(int Offset, int Function)> Calls { get; } = [];

    private void Call(int function)
    {
        code.Byte(0x10); // call
        Calls.Add((code.Length, function));
    }

    private int SaveToLocal(IOperation expression)
    {
        var type = EmitExpression(expression);
        int id = NewLocal(type);
        LocalSet(id);
        return id;
    }

    private void OpenBlock(byte opcode, WType type, object label)
    {
        code.Byte(opcode);
        type.Write(code);
        labels.Add(label);
    }

    private void CloseBlock()
    {
        code.Byte(0x0b); // end
        labels.RemoveAt(labels.Count - 1);
    }

    private static bool SameLabel(object left, object right) => left is ISymbol leftSymbol && right is ISymbol rightSymbol
        ? SymbolEqualityComparer.Default.Equals(leftSymbol, rightSymbol)
        : ReferenceEquals(left, right);

    private void Branch(object target, bool conditional = false)
    {
        for (int i = labels.Count - 1; i >= 0; i--)
        {
            if (SameLabel(labels[i], target))
            {
                code.OpIndex(conditional ? (byte)0x0d : (byte)0x0c, labels.Count - i - 1);
                return;
            }
        }

        throw new InternalCompilerError("branch outside supported structured region.");
    }

    internal enum FaultCode
    {
        FuelExhausted = 1,
        CallDepthExceeded = 2,
        AllocationBudgetExceeded = 3,
        InvalidArrayLength = 4,
        NullReference = 5,
        ArrayIndexOutOfRange = 6,
        DivisionByZero = 7,
        DivisionOverflow = 8,
        ArithmeticOverflow = 9,
        InvalidArgument = 10,
        UnmatchedSwitch = 11,
        // A host import called back into an export while static
        // initialization was running (see Frontend.EmitEntry).
        ReentrantStaticInitialization = 12,
    }

    private void FaultIf(FaultCode fault)
    {
        // Input is an i32 predicate. Faults are uncatchable Wasm traps in this
        // subset, and the wrapper resets state before the next host invocation.
        code.Byte(0x04); // if
        code.Byte(0x40); // empty block type
        Fault(fault);
        code.Byte(0x0b); // end
    }

    private void Fault(FaultCode fault)
    {
        code.I32((int)fault);
        GlobalSet(ModuleWriter.FaultGlobal);
        code.Byte(0x00); // unreachable
    }

    private void ConsumeFuel()
    {
        GlobalGet(ModuleWriter.FuelGlobal);
        code.Byte(0x45); // i32.eqz
        FaultIf(FaultCode.FuelExhausted);

        GlobalGet(ModuleWriter.FuelGlobal);
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        GlobalSet(ModuleWriter.FuelGlobal);
    }

    // Consumes an i64 charge from the Wasm stack and deducts it from the budget.
    private void ChargeAllocation()
    {
        int charge = NewLocal(WType.I64);
        LocalSet(charge);
        GlobalGet(ModuleWriter.AllocationBudgetGlobal);
        LocalGet(charge);
        code.Byte(0x54); // i64.lt_u
        FaultIf(FaultCode.AllocationBudgetExceeded);

        GlobalGet(ModuleWriter.AllocationBudgetGlobal);
        LocalGet(charge);
        code.Byte(0x7d); // i64.sub
        GlobalSet(ModuleWriter.AllocationBudgetGlobal);
    }

    private void CheckNull(int reference)
    {
        LocalGet(reference);
        code.Byte(0xd1); // ref.is_null
        FaultIf(FaultCode.NullReference);
    }

    private void CheckArray(int reference, int index)
    {
        CheckNull(reference);
        LocalGet(index);
        LocalGet(reference);
        code.Gc(15); // array.len
        code.Byte(0x4f); // i32.ge_u: index >= length, including negative indices
        FaultIf(FaultCode.ArrayIndexOutOfRange);
    }

    // Saves an array index or size as the i32 Wasm's array instructions take.
    // C# indexes and sizes arrays with int, uint, long or ulong (Roslyn
    // converts narrower types to int). An int or uint is used as it is: an
    // unsigned range check rejects negative ints and uints past
    // int.MaxValue alike. A long or ulong narrows the way the CLR's
    // overflow-checked conversion to a native integer does: a ulong above
    // long.MaxValue faults with `overflow` right here, before the array is
    // checked; any other value outside [0, int.MaxValue] becomes 0xFFFFFFFF,
    // which the later range check rejects, after the null check, as the CLR
    // does.
    private int SaveArrayIndex(IOperation index, FaultCode overflow)
    {
        var type = EmitExpression(index);
        if (type == WType.I32)
        {
            int narrow = NewLocal(WType.I32);
            LocalSet(narrow);
            return narrow;
        }

        if (type != WType.I64)
        {
            throw CompileError.At(index, "Array indices and sizes must be integers.");
        }

        int wide = NewLocal(WType.I64);
        LocalSet(wide);
        if (Frontend.ScalarOf(index.Type) == Scalar.U64)
        {
            LocalGet(wide);
            code.I64(0);
            code.Byte(0x53); // i64.lt_s: at or above 2^63 as a ulong
            FaultIf(overflow);
        }

        LocalGet(wide);
        code.Byte(0xa7); // i32.wrap_i64
        code.I32(-1);
        LocalGet(wide);
        code.I64(int.MaxValue);
        code.Byte(0x58); // i64.le_u: within [0, int.MaxValue]
        code.Byte(0x1b); // select
        int result = NewLocal(WType.I32);
        LocalSet(result);
        return result;
    }

    // MARK: Function prologues

    private void EmitFieldInitializers()
    {
        var type = frontend.MapType(plan.ContainingType);
        foreach (var initializer in frontend.FieldInitializers(plan.ContainingType!))
        {
            // The object has already been zeroed. C# evaluates these expressions
            // in declaration order, before entering the constructor body.
            LocalGet(0);
            EmitExpression(initializer.Value);
            code.Gc(5, type.Heap, frontend.FieldIndex(initializer.Field, initializer.Value)); // struct.set
        }
    }

    private void EmitConstructorChain(IOperation initializer)
    {
        if (initializer is not IExpressionStatementOperation
            {
                Operation: IInvocationOperation { TargetMethod.MethodKind: MethodKind.Constructor } call
            })
        {
            throw CompileError.At(initializer, "Unsupported constructor initializer.");
        }

        int[] arguments = EvaluateArguments(call.TargetMethod, call.Arguments, call);
        LocalGet(0);
        foreach (int argument in arguments)
        {
            LocalGet(argument);
        }

        Call(frontend.MethodIndex(call.TargetMethod, call));
    }

    private void EmitStaticInitializers()
    {
        foreach (var step in frontend.StaticInitializers)
        {
            if (step.Constructor is not null)
            {
                Call(frontend.MethodIndex(step.Constructor, null));
                continue;
            }

            EmitExpression(step.Value!);
            GlobalSet(frontend.GlobalIndex(step.Field!, step.Value!));
        }
    }

    private void EmitAutoAccessor(bool store)
    {
        var field = plan.AutoField!;
        if (field.IsStatic)
        {
            if (store)
            {
                LocalGet(0);
                GlobalSet(frontend.GlobalIndex(field, null));
            }
            else
            {
                GlobalGet(frontend.GlobalIndex(field, null));
                LocalSet(returnSlot);
            }

            return;
        }

        var container = frontend.MapType(field.ContainingType);
        LocalGet(0);
        if (store)
        {
            LocalGet(1);
            code.Gc(5, container.Heap, frontend.FieldIndex(field, null)); // struct.set
        }
        else
        {
            code.Gc(2, container.Heap, frontend.FieldIndex(field, null)); // struct.get
            LocalSet(returnSlot);
        }
    }

    // MARK: Statements

    private void EmitStatement(IOperation operation)
    {
        switch (operation)
        {
            case IBlockOperation block:
                foreach (var child in block.Operations)
                {
                    EmitStatement(child);
                }

                return;
            case IVariableDeclarationGroupOperation group:
                foreach (var declaration in group.Declarations)
                {
                    EmitStatement(declaration);
                }

                return;
            case IVariableDeclarationOperation declaration:
                if (declaration.Initializer is not null)
                {
                    throw CompileError.At(operation, "Shared declaration initializers are unsupported.");
                }

                foreach (var declarator in declaration.Declarators)
                {
                    EmitStatement(declarator);
                }

                return;
            case IVariableDeclaratorOperation declarator:
                if (declarator.Symbol.RefKind != RefKind.None)
                {
                    throw CompileError.At(operation, "Ref locals are unsupported.");
                }

                if (declarator.Symbol.IsConst)
                {
                    // Roslyn folds every use of a constant local.
                    return;
                }

                int local = DeclareLocal(declarator.Symbol);
                if (declarator.Initializer is not null)
                {
                    EmitExpression(declarator.Initializer.Value);
                    LocalSet(local);
                }

                return;
            case IExpressionStatementOperation expression:
                if (EmitExpression(expression.Operation) != WType.Void)
                {
                    code.Byte(0x1a); // drop
                }

                return;
            case IReturnOperation { Kind: OperationKind.Return } ret:
                if (ret.ReturnedValue is not null)
                {
                    EmitExpression(ret.ReturnedValue);
                    if (returnSlot < 0)
                    {
                        throw CompileError.At(operation, "Unexpected value return.");
                    }

                    LocalSet(returnSlot);
                }

                Branch(returnLabel);
                return;
            case IConditionalOperation conditional when
                conditional.Type is null || conditional.Type.SpecialType == SpecialType.System_Void:
                EmitExpression(conditional.Condition);
                OpenBlock(0x04, WType.Void, new object());
                EmitStatement(conditional.WhenTrue);
                if (conditional.WhenFalse is not null)
                {
                    code.Byte(0x05); // else
                    EmitStatement(conditional.WhenFalse);
                }

                CloseBlock();
                return;
            case IWhileLoopOperation loop:
                EmitWhileLoop(loop);
                return;
            case IForLoopOperation loop:
                EmitForLoop(loop);
                return;
            case IForEachLoopOperation loop:
                EmitArrayForEach(loop);
                return;
            case IBranchOperation branch when branch.BranchKind is BranchKind.Break or BranchKind.Continue:
                Branch(branch.Target);
                return;
            case ISwitchOperation sw:
                EmitSwitch(sw);
                return;
            case IEmptyOperation:
                return;
            default:
                throw CompileError.At(operation, $"Statement operation '{operation.Kind}' is unsupported.");
        }
    }

    // MARK: Expressions

    private WType EmitExpression(IOperation operation)
    {
        if (operation.ConstantValue.HasValue && operation.Type is not null)
        {
            EmitConstant(operation.Type, operation.ConstantValue.Value, operation);
            return frontend.MapType(operation.Type);
        }

        switch (operation)
        {
            case ILocalReferenceOperation local:
                if (!localIds.TryGetValue(local.Local, out int slot))
                {
                    throw CompileError.At(operation, "Local was not declared in the supported scope.");
                }

                LocalGet(slot);
                return frontend.MapType(local.Type);
            case IParameterReferenceOperation parameter:
                LocalGet(ParameterSlot(parameter.Parameter));
                return frontend.MapType(parameter.Type);
            case IInstanceReferenceOperation instance:
                if (instance.ReferenceKind == InstanceReferenceKind.ImplicitReceiver && initializerReceivers.Count != 0)
                {
                    LocalGet(initializerReceivers.Peek());
                }
                else if (instance.ReferenceKind == InstanceReferenceKind.ContainingTypeInstance && !plan.IsStatic)
                {
                    LocalGet(0);
                }
                else
                {
                    throw CompileError.At(operation, "Unsupported implicit receiver.");
                }

                return frontend.MapType(instance.Type);
            case IParenthesizedOperation parentheses:
                return EmitExpression(parentheses.Operand);
            case IDefaultValueOperation:
                var defaultType = frontend.MapType(operation.Type);
                defaultType.Default(code);
                return defaultType;
            case IConversionOperation conversion:
                return EmitConversion(conversion);
            case IBinaryOperation binary:
                return EmitBinary(binary);
            case IUnaryOperation unary:
                return EmitUnary(unary);
            case IConditionalOperation conditional:
                if (conditional.IsRef || conditional.WhenFalse is null)
                {
                    throw CompileError.At(operation, "By-reference/missing conditional operand.");
                }

                var conditionalType = frontend.MapType(conditional.Type);
                EmitExpression(conditional.Condition);
                OpenBlock(0x04, conditionalType, new object());
                EmitExpression(conditional.WhenTrue);
                code.Byte(0x05); // else
                EmitExpression(conditional.WhenFalse);
                CloseBlock();
                return conditionalType;
            case ISimpleAssignmentOperation assignment:
                return EmitAssignment(assignment);
            case ICompoundAssignmentOperation assignment:
                return EmitCompoundAssignment(assignment);
            case IIncrementOrDecrementOperation increment:
                return EmitIncrement(increment);
            case IFieldReferenceOperation or IArrayElementReferenceOperation:
                var location = PrepareLocation(operation);
                Load(location);
                return location.Type;
            case IPropertyReferenceOperation property when
                property.Instance?.Type is IArrayTypeSymbol
                && SymbolEqualityComparer.Default.Equals(property.Property, frontend.ArrayLength)
                && property.Arguments.Length == 0:
                int array = SaveToLocal(property.Instance);
                CheckNull(array);
                LocalGet(array);
                code.Gc(15); // array.len
                return WType.I32;
            case IPropertyReferenceOperation:
                var propertyLocation = PrepareLocation(operation);
                Load(propertyLocation);
                return propertyLocation.Type;
            case IObjectCreationOperation creation:
                return EmitNewObject(creation);
            case IArrayCreationOperation creation:
                return EmitNewArray(creation);
            case IInvocationOperation invocation:
                return EmitCall(invocation);
            case ISwitchExpressionOperation sw:
                return EmitSwitchExpression(sw);
            case IIsPatternOperation isPattern:
                return EmitIsPattern(isPattern);
            case ICoalesceOperation coalesce:
                return EmitCoalesce(coalesce);
            default:
                throw CompileError.At(operation, $"Expression operation '{operation.Kind}' is unsupported.");
        }
    }

    private WType EmitAssignment(ISimpleAssignmentOperation assignment)
    {
        if (assignment.IsRef)
        {
            throw CompileError.At(assignment, "Ref assignments are unsupported.");
        }

        if (assignment.Target is IDiscardOperation)
        {
            // `_ = e` evaluates e for its effects; the value is the result.
            return EmitExpression(assignment.Value);
        }

        // Evaluate the receiver/index first, but simple assignment does
        // not check them until after evaluating its right-hand side.
        var location = PrepareLocation(assignment.Target, validate: false);
        int value = SaveToLocal(assignment.Value);
        CheckLocation(location);
        Store(location, value);
        LocalGet(value);
        return location.Type;
    }

    // MARK: Locations

    private enum LocationKind
    {
        Local,
        Field,
        Global,
        ArrayElement,
        Property,
    }

    // Receiver and index expressions are saved once, before a location is read or written.
    private sealed record Location(
        LocationKind Kind,
        WType Type,
        ITypeSymbol TypeSymbol,
        int Local = -1,
        int Receiver = -1,
        int Index = -1,
        WType Container = default,
        int Field = -1,
        int Global = -1,
        IPropertySymbol? Property = null,
        IOperation? Site = null);

    private Location PrepareLocation(IOperation target, bool validate = true)
    {
        var type = frontend.MapType(target.Type);
        var typeSymbol = target.Type!;
        switch (target)
        {
            case ILocalReferenceOperation local when localIds.TryGetValue(local.Local, out int id):
                return new(LocationKind.Local, type, typeSymbol, Local: id);
            case IParameterReferenceOperation parameter:
                return new(LocationKind.Local, type, typeSymbol, Local: ParameterSlot(parameter.Parameter));
            case IFieldReferenceOperation { Field.IsStatic: true } field:
                return new(LocationKind.Global, type, typeSymbol, Global: frontend.GlobalIndex(field.Field, target));
            case IFieldReferenceOperation field when field.Instance is not null:
                int fieldReceiver = SaveToLocal(field.Instance);
                if (validate)
                {
                    CheckNull(fieldReceiver);
                }

                return new(
                    LocationKind.Field,
                    type,
                    typeSymbol,
                    Receiver: fieldReceiver,
                    Container: frontend.MapType(field.Field.ContainingType),
                    Field: frontend.FieldIndex(field.Field, target));
            case IArrayElementReferenceOperation array when array.Indices.Length == 1:
                int receiver = SaveToLocal(array.ArrayReference);
                int index = SaveArrayIndex(array.Indices[0], FaultCode.ArithmeticOverflow);
                if (validate)
                {
                    CheckArray(receiver, index);
                }

                return new(
                    LocationKind.ArrayElement,
                    type,
                    typeSymbol,
                    Receiver: receiver,
                    Index: index,
                    Container: frontend.MapType(array.ArrayReference.Type));
            case IPropertyReferenceOperation { Arguments.Length: 0 } property:
                return PreparePropertyLocation(property, type, validate);
            default:
                throw CompileError.At(target,
                    "Only local, parameter, field, property and single array-element locations are supported.");
        }
    }

    private Location PreparePropertyLocation(IPropertyReferenceOperation property, WType type, bool validate)
    {
        var symbol = property.Property;
        var typeSymbol = property.Type!;
        bool instance = !symbol.IsStatic;
        if (instance && property.Instance is null)
        {
            throw CompileError.At(property, "Missing property receiver.");
        }

        // A fully automatic property is its backing field: no call, no fuel.
        if (frontend.TryAutoProperty(symbol, out var backingField))
        {
            if (!instance)
            {
                return new(LocationKind.Global, type, typeSymbol, Global: frontend.GlobalIndex(backingField, property));
            }

            int fieldReceiver = SaveToLocal(property.Instance!);
            if (validate)
            {
                CheckNull(fieldReceiver);
            }

            return new(
                LocationKind.Field,
                type,
                typeSymbol,
                Receiver: fieldReceiver,
                Container: frontend.MapType(symbol.ContainingType),
                Field: frontend.FieldIndex(backingField, property));
        }

        int receiver = -1;
        if (instance)
        {
            receiver = SaveToLocal(property.Instance!);
            if (validate)
            {
                CheckNull(receiver);
            }
        }

        return new(LocationKind.Property, type, typeSymbol, Receiver: receiver, Property: symbol, Site: property);
    }

    private void CheckLocation(Location location)
    {
        if (location.Kind is LocationKind.Field || (location.Kind is LocationKind.Property && location.Receiver >= 0))
        {
            CheckNull(location.Receiver);
        }
        else if (location.Kind == LocationKind.ArrayElement)
        {
            CheckArray(location.Receiver, location.Index);
        }
    }

    private void Load(Location location)
    {
        switch (location.Kind)
        {
            case LocationKind.Local:
                LocalGet(location.Local);
                break;
            case LocationKind.Field:
                LocalGet(location.Receiver);
                code.Gc(2, location.Container.Heap, location.Field); // struct.get
                break;
            case LocationKind.Global:
                GlobalGet(location.Global);
                break;
            case LocationKind.ArrayElement:
                LocalGet(location.Receiver);
                LocalGet(location.Index);
                code.Gc(11, location.Container.Heap); // array.get
                break;
            case LocationKind.Property:
                var getter = location.Property!.GetMethod
                    ?? throw CompileError.At(location.Site!, "The property has no getter.");
                if (location.Receiver >= 0)
                {
                    LocalGet(location.Receiver);
                }

                Call(frontend.MethodIndex(getter, location.Site));
                break;
        }
    }

    private void Store(Location location, int value)
    {
        switch (location.Kind)
        {
            case LocationKind.Local:
                LocalGet(value);
                LocalSet(location.Local);
                break;
            case LocationKind.Field:
                LocalGet(location.Receiver);
                LocalGet(value);
                code.Gc(5, location.Container.Heap, location.Field); // struct.set
                break;
            case LocationKind.Global:
                LocalGet(value);
                GlobalSet(location.Global);
                break;
            case LocationKind.ArrayElement:
                LocalGet(location.Receiver);
                LocalGet(location.Index);
                LocalGet(value);
                code.Gc(14, location.Container.Heap); // array.set
                break;
            case LocationKind.Property:
                var setter = location.Property!.SetMethod
                    ?? throw CompileError.At(location.Site!, "The property has no setter.");
                if (location.Receiver >= 0)
                {
                    LocalGet(location.Receiver);
                }

                LocalGet(value);
                Call(frontend.MethodIndex(setter, location.Site));
                break;
        }
    }

    // MARK: Allocation and calls

    private WType EmitNewObject(IObjectCreationOperation creation)
    {
        var type = frontend.MapType(creation.Type);
        if (!type.IsRef || creation.Constructor is not { MethodKind: MethodKind.Constructor } constructor
            || creation.Type is IArrayTypeSymbol)
        {
            throw CompileError.At(creation, "Only supported source-class construction is allowed.");
        }

        int constructorIndex = frontend.ConstructorIndex(constructor, creation);
        // Constructor arguments run once in source order, before allocation.
        // Keep the resulting values in parameter order for the eventual call.
        int[] arguments = EvaluateArguments(constructor, creation.Arguments, creation);
        code.I64(16L + frontend.FieldCount(type) * 8L);
        ChargeAllocation();
        code.Gc(1, type.Heap); // struct.new_default
        int receiver = NewLocal(type);
        LocalSet(receiver);

        if (constructorIndex >= 0)
        {
            LocalGet(receiver);
            foreach (int argument in arguments)
            {
                LocalGet(argument);
            }

            // Constructors share normal method fuel and call-depth accounting.
            Call(constructorIndex);
        }

        // Object initializer assignments run after the constructor body.
        if (creation.Initializer is not null)
        {
            initializerReceivers.Push(receiver);
            foreach (var init in creation.Initializer.Initializers)
            {
                if (init is not ISimpleAssignmentOperation
                    {
                        Target: IFieldReferenceOperation or IPropertyReferenceOperation
                    })
                {
                    throw CompileError.At(init, "Only field and property assignments are supported in object initializers.");
                }

                EmitExpression(init);
                code.Byte(0x1a); // drop
            }

            initializerReceivers.Pop();
        }

        LocalGet(receiver);
        return type;
    }

    private WType EmitNewArray(IArrayCreationOperation creation)
    {
        var type = frontend.MapType(creation.Type);
        if (creation.DimensionSizes.Length != 1)
        {
            throw CompileError.At(creation, "Only single-dimensional arrays are supported.");
        }

        int length = SaveArrayIndex(creation.DimensionSizes[0], FaultCode.InvalidArrayLength);
        LocalGet(length);
        code.I32(frontend.Limits.ArrayLength);
        code.Byte(0x4b); // i32.gt_u also rejects negative lengths
        FaultIf(FaultCode.InvalidArrayLength);

        // Logical allocation cost: a 16-unit header plus 8 units per element.
        LocalGet(length);
        code.Byte(0xad); // i64.extend_i32_u
        code.I64(8);
        code.Byte(0x7e); // i64.mul
        code.I64(16);
        code.Byte(0x7c); // i64.add
        ChargeAllocation();
        LocalGet(length);
        code.Gc(7, type.Heap); // array.new_default
        int array = NewLocal(type);
        LocalSet(array);
        if (creation.Initializer is not null)
        {
            for (int i = 0; i < creation.Initializer.ElementValues.Length; i++)
            {
                LocalGet(array);
                code.I32(i);
                EmitExpression(creation.Initializer.ElementValues[i]);
                code.Gc(14, type.Heap); // array.set
            }
        }

        LocalGet(array);
        return type;
    }

    private WType EmitCall(IInvocationOperation invocation)
    {
        if (frontend.IntrinsicOf(invocation.TargetMethod) is { } intrinsic)
        {
            return EmitIntrinsic(intrinsic, invocation);
        }

        int method = frontend.MethodIndex(invocation.TargetMethod, invocation);
        int receiver = -1;
        if (!invocation.TargetMethod.IsStatic)
        {
            if (invocation.Instance is null)
            {
                throw CompileError.At(invocation, "Missing method receiver.");
            }

            receiver = SaveToLocal(invocation.Instance);
        }

        int[] arguments = EvaluateArguments(invocation.TargetMethod, invocation.Arguments, invocation);

        // A C# instance call evaluates arguments before checking a null receiver.
        if (receiver >= 0)
        {
            CheckNull(receiver);
            LocalGet(receiver);
        }

        foreach (int argument in arguments)
        {
            LocalGet(argument);
        }

        Call(method);
        if (frontend.IsImport(invocation.TargetMethod) && !invocation.TargetMethod.ReturnsVoid)
        {
            // The host may hand back any i32 for a bool or narrow integer;
            // bring it into the C# representation.
            Canonicalize(code, Frontend.ScalarOf(invocation.TargetMethod.ReturnType)!.Value);
        }

        return frontend.MapType(invocation.Type);
    }

    private int[] EvaluateArguments(
        IMethodSymbol method,
        IEnumerable<IArgumentOperation> sourceArguments,
        IOperation site)
    {
        var arguments = new int[method.Parameters.Length];
        Array.Fill(arguments, -1);
        // Roslyn presents arguments in source evaluation order. Store them by
        // parameter ordinal after evaluation: named arguments can reorder them.
        foreach (var argument in sourceArguments)
        {
            if (argument.ArgumentKind != ArgumentKind.Explicit
                || argument.Parameter is null || argument.Parameter.RefKind != RefKind.None)
            {
                throw CompileError.At(argument, "Only explicit positional or named value arguments are supported.");
            }

            arguments[argument.Parameter.Ordinal] = SaveToLocal(argument.Value);
        }

        if (arguments.Any(argument => argument < 0))
        {
            throw CompileError.At(site, "Missing argument.");
        }

        return arguments;
    }
}
