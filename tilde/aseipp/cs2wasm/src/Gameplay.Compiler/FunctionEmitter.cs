// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Gameplay.Compiler;

// Translates structured Roslyn operations directly into structured Wasm.
// Unsupported operations fail closed, including those in unreachable source.
internal sealed class FunctionEmitter
{
    // These indices match the runtime globals declared by ModuleWriter.
    private const int FuelGlobal = 0;
    private const int CallDepthGlobal = 1;
    private const int AllocationBudgetGlobal = 2;
    private const int FaultGlobal = 3;

    private readonly Frontend frontend;
    private readonly MethodPlan plan;
    private readonly WasmWriter code = new();
    private readonly List<WType> locals = [];
    private readonly Dictionary<ILocalSymbol, int> localIds = new(SymbolEqualityComparer.Default);
    private readonly List<object> labels = [];
    private readonly Stack<int> initializerReceivers = new();
    private readonly object returnLabel = new();
    private readonly int parameterCount;
    private readonly WType returnType;
    private readonly int returnSlot;

    public FunctionEmitter(Frontend frontend, MethodPlan plan)
    {
        this.frontend = frontend;
        this.plan = plan;
        parameterCount = plan.Symbol.Parameters.Length + (plan.Symbol.IsStatic ? 0 : 1);
        returnType = frontend.MapType(plan.Symbol.ReturnType);
        returnSlot = returnType == WType.Void ? -1 : NewLocal(returnType);
    }

    public WasmFunction Emit()
    {
        ConsumeFuel();
        GlobalGet(CallDepthGlobal);
        code.I32(frontend.Limits.CallDepth);
        code.Byte(0x4f); // i32.ge_u
        FaultIf(FaultCode.CallDepthExceeded);

        GlobalGet(CallDepthGlobal);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        GlobalSet(CallDepthGlobal);

        // Returns branch to this shared exit so every successful call restores depth.
        OpenBlock(0x02, WType.Void, returnLabel);
        if (plan.Symbol.MethodKind == MethodKind.Constructor)
        {
            EmitFieldInitializers();
        }

        if (plan.Body is not null)
        {
            EmitStatement(plan.Body);
        }

        CloseBlock();

        GlobalGet(CallDepthGlobal);
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        GlobalSet(CallDepthGlobal);
        if (returnSlot >= 0)
        {
            LocalGet(returnSlot);
        }

        code.Byte(0x0b); // end
        var parameters = new List<WType>();
        if (!plan.Symbol.IsStatic)
        {
            parameters.Add(frontend.MapType(plan.Symbol.ContainingType));
        }

        parameters.AddRange(plan.Symbol.Parameters.Select(p => frontend.MapType(p.Type)));
        return new(plan.Name, parameters.ToArray(), returnType, locals.ToArray(), code.ToArray());
    }

    private int NewLocal(WType type)
    {
        if (type == WType.Void)
        {
            throw new CompileError("Internal error: void local.");
        }

        int id = parameterCount + locals.Count;
        locals.Add(type);
        return id;
    }

    private void LocalGet(int id) => code.OpIndex(0x20, id);
    private void LocalSet(int id) => code.OpIndex(0x21, id);
    private void GlobalGet(int id) => code.OpIndex(0x23, id);
    private void GlobalSet(int id) => code.OpIndex(0x24, id);

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

        throw new CompileError("Internal error: branch outside supported structured region.");
    }

    private enum FaultCode
    {
        FuelExhausted = 1,
        CallDepthExceeded = 2,
        AllocationBudgetExceeded = 3,
        InvalidArrayLength = 4,
        NullReference = 5,
        ArrayIndexOutOfRange = 6,
        DivisionByZero = 7,
        DivisionOverflow = 8
    }

    private void FaultIf(FaultCode fault)
    {
        // Input is an i32 predicate. Faults are uncatchable Wasm traps in this
        // subset, and the wrapper resets state before the next host invocation.
        code.Byte(0x04); // if
        code.Byte(0x40); // empty block type
        code.I32((int)fault);
        GlobalSet(FaultGlobal);
        code.Byte(0x00); // unreachable
        code.Byte(0x0b); // end
    }

    private void ConsumeFuel()
    {
        GlobalGet(FuelGlobal);
        code.Byte(0x45); // i32.eqz
        FaultIf(FaultCode.FuelExhausted);

        GlobalGet(FuelGlobal);
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        GlobalSet(FuelGlobal);
    }

    // Consumes an i64 charge from the Wasm stack and deducts it from the budget.
    private void ChargeAllocation()
    {
        int charge = NewLocal(WType.I64);
        LocalSet(charge);
        GlobalGet(AllocationBudgetGlobal);
        LocalGet(charge);
        code.Byte(0x54); // i64.lt_u
        FaultIf(FaultCode.AllocationBudgetExceeded);

        GlobalGet(AllocationBudgetGlobal);
        LocalGet(charge);
        code.Byte(0x7d); // i64.sub
        GlobalSet(AllocationBudgetGlobal);
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

                int local = NewLocal(frontend.MapType(declarator.Symbol.Type));
                localIds.Add(declarator.Symbol, local);
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
            case IReturnOperation ret:
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
                if (!loop.ConditionIsTop || loop.ConditionIsUntil || loop.Condition is null)
                {
                    throw CompileError.At(operation, "Only ordinary while loops are supported (no do/while yet).");
                }

                OpenBlock(0x02, WType.Void, loop.ExitLabel);
                OpenBlock(0x03, WType.Void, loop.ContinueLabel);
                ConsumeFuel();
                EmitExpression(loop.Condition);
                code.Byte(0x45); // i32.eqz
                Branch(loop.ExitLabel, true);
                EmitStatement(loop.Body);
                Branch(loop.ContinueLabel);
                CloseBlock();
                CloseBlock();
                return;
            case IForLoopOperation loop:
                foreach (var before in loop.Before)
                {
                    EmitStatement(before);
                }

                var repeat = new object();
                OpenBlock(0x02, WType.Void, loop.ExitLabel);
                OpenBlock(0x03, WType.Void, repeat);
                ConsumeFuel();
                if (loop.Condition is not null)
                {
                    EmitExpression(loop.Condition);
                    code.Byte(0x45); // i32.eqz
                    Branch(loop.ExitLabel, true);
                }

                OpenBlock(0x02, WType.Void, loop.ContinueLabel);
                EmitStatement(loop.Body);
                CloseBlock();
                foreach (var bottom in loop.AtLoopBottom)
                {
                    EmitStatement(bottom);
                }

                Branch(repeat);
                CloseBlock();
                CloseBlock();
                return;
            case IBranchOperation branch when branch.BranchKind is BranchKind.Break or BranchKind.Continue:
                Branch(branch.Target);
                return;
            case IForEachLoopOperation loop:
                EmitArrayForEach(loop);
                return;
            case IEmptyOperation:
                return;
            default:
                throw CompileError.At(operation, $"Statement operation '{operation.Kind}' is unsupported.");
        }
    }

    private void EmitArrayForEach(IForEachLoopOperation loop)
    {
        var collection = Frontend.ArrayForEachCollection(loop.Collection);
        if (loop.IsAsynchronous || loop.NextVariables.Length != 0
            || collection.Type is not IArrayTypeSymbol { Rank: 1, IsSZArray: true } arrayType
            || loop.LoopControlVariable is not IVariableDeclaratorOperation declarator
            || declarator.Symbol.RefKind != RefKind.None)
        {
            throw CompileError.At(loop, "Only value-variable foreach loops over single-dimensional arrays are supported.");
        }

        var elementType = frontend.MapType(arrayType.ElementType);
        var variableType = frontend.MapType(declarator.Symbol.Type);
        int variable = NewLocal(variableType);
        localIds.Add(declarator.Symbol, variable);

        // Capture the original array once: assigning another array to the
        // collection variable inside the loop must not change this iteration.
        int array = SaveToLocal(collection);
        CheckNull(array);
        LocalGet(array);
        code.Gc(15); // array.len
        int length = NewLocal(WType.I32);
        LocalSet(length);
        int index = NewLocal(WType.I32);
        code.I32(0);
        LocalSet(index);

        var repeat = new object();
        OpenBlock(0x02, WType.Void, loop.ExitLabel);
        OpenBlock(0x03, WType.Void, repeat);
        ConsumeFuel();
        LocalGet(index);
        LocalGet(length);
        code.Byte(0x4f); // i32.ge_u
        Branch(loop.ExitLabel, true);

        LocalGet(array);
        LocalGet(index);
        code.Gc(11, frontend.MapType(arrayType).Heap); // array.get
        if (elementType != variableType)
        {
            EmitNumericConversion(elementType, variableType, loop);
        }

        LocalSet(variable);
        // Continue exits the body block, then advances the index. Break exits
        // both blocks and therefore skips the increment, including when nested.
        OpenBlock(0x02, WType.Void, loop.ContinueLabel);
        EmitStatement(loop.Body);
        CloseBlock();
        LocalGet(index);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        LocalSet(index);
        Branch(repeat);
        CloseBlock();
        CloseBlock();
    }

    private WType EmitExpression(IOperation operation)
    {
        if (operation.ConstantValue.HasValue && operation.Type is not null)
        {
            var type = frontend.MapType(operation.Type);
            EmitConstant(type, operation.ConstantValue.Value, operation);
            return type;
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
                LocalGet(parameter.Parameter.Ordinal + (plan.Symbol.IsStatic ? 0 : 1));
                return frontend.MapType(parameter.Type);
            case IInstanceReferenceOperation instance:
                if (instance.ReferenceKind == InstanceReferenceKind.ImplicitReceiver && initializerReceivers.Count != 0)
                {
                    LocalGet(initializerReceivers.Peek());
                }
                else if (instance.ReferenceKind == InstanceReferenceKind.ContainingTypeInstance && !plan.Symbol.IsStatic)
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
                if (assignment.IsRef)
                {
                    throw CompileError.At(operation, "Ref assignments are unsupported.");
                }

                // Evaluate the receiver/index first, but simple assignment does
                // not check them until after evaluating its right-hand side.
                var location = PrepareLocation(assignment.Target, validate: false);
                int value = SaveToLocal(assignment.Value);
                CheckLocation(location);
                Store(location, value);
                LocalGet(value);
                return location.Type;
            case ICompoundAssignmentOperation assignment:
                return EmitCompoundAssignment(assignment);
            case IIncrementOrDecrementOperation increment:
                return EmitIncrement(increment);
            case IFieldReferenceOperation field:
                var fieldLocation = PrepareLocation(field);
                Load(fieldLocation);
                return fieldLocation.Type;
            case IArrayElementReferenceOperation arrayElement:
                var arrayLocation = PrepareLocation(arrayElement);
                Load(arrayLocation);
                return arrayLocation.Type;
            case IPropertyReferenceOperation property when
                property.Instance?.Type is IArrayTypeSymbol
                && property.Property.Name == "Length"
                && property.Arguments.Length == 0:
                int array = SaveToLocal(property.Instance);
                CheckNull(array);
                LocalGet(array);
                code.Gc(15); // array.len
                return WType.I32;
            case IObjectCreationOperation creation:
                return EmitNewObject(creation);
            case IArrayCreationOperation creation:
                return EmitNewArray(creation);
            case IInvocationOperation invocation:
                return EmitCall(invocation);
            default:
                throw CompileError.At(operation, $"Expression operation '{operation.Kind}' is unsupported.");
        }
    }

    private void EmitConstant(WType type, object? value, IOperation site)
    {
        if (value is null && type.IsRef)
        {
            type.Default(code);
            return;
        }

        switch (value)
        {
            case int number when type == WType.I32:
                code.I32(number);
                return;
            case bool boolean when type == WType.I32:
                code.I32(boolean ? 1 : 0);
                return;
            case float number when type == WType.F32:
                code.Byte(0x43); // f32.const
                code.F32(number);
                return;
            case double number when type == WType.F64:
                code.Byte(0x44); // f64.const
                code.F64(number);
                return;
            default:
                throw CompileError.At(site, "Unsupported constant representation.");
        }
    }

    private WType EmitConversion(IConversionOperation conversion)
    {
        var target = frontend.MapType(conversion.Type);
        if (conversion.OperatorMethod is not null || conversion.IsTryCast || conversion.IsChecked)
        {
            throw CompileError.At(conversion, "User-defined, checked and 'as' conversions are unsupported.");
        }

        if (conversion.Operand.ConstantValue.HasValue && conversion.Operand.ConstantValue.Value is null && target.IsRef)
        {
            target.Default(code);
            return target;
        }

        var source = frontend.MapType(conversion.Operand.Type);
        if (source == target && (conversion.Conversion.IsIdentity
            || (conversion.Conversion.IsReference
                && SymbolEqualityComparer.Default.Equals(conversion.Type, conversion.Operand.Type))))
        {
            EmitExpression(conversion.Operand);
            return target;
        }

        EmitExpression(conversion.Operand);
        EmitNumericConversion(source, target, conversion);
        return target;
    }

    // Both explicit casts and foreach element conversions use this deliberately
    // small set of numeric conversions. In particular, float-to-int conversion
    // would require a separate policy for NaN and values outside the int range.
    private void EmitNumericConversion(WType source, WType target, IOperation site)
    {
        byte opcode = (source.Code, target.Code) switch
        {
            (0x7f, 0x7d) => 0xb2, // f32.convert_i32_s
            (0x7f, 0x7c) => 0xb7, // f64.convert_i32_s
            (0x7d, 0x7c) => 0xbb, // f64.promote_f32
            (0x7c, 0x7d) => 0xb6, // f32.demote_f64
            _ => throw CompileError.At(site, "Conversion is outside the prototype's exact conversion subset.")
        };
        code.Byte(opcode);
    }

    private WType EmitUnary(IUnaryOperation unary)
    {
        if (unary.OperatorMethod is not null || unary.IsLifted || unary.IsChecked)
        {
            throw CompileError.At(unary, "User-defined, lifted and checked unary operations are unsupported.");
        }

        var type = frontend.MapType(unary.Type);
        if (unary.OperatorKind == UnaryOperatorKind.Plus)
        {
            return EmitExpression(unary.Operand);
        }

        if (unary.OperatorKind == UnaryOperatorKind.Minus && type == WType.I32)
        {
            code.I32(0);
            EmitExpression(unary.Operand);
            code.Byte(0x6b); // i32.sub
            return type;
        }

        EmitExpression(unary.Operand);
        if (unary.OperatorKind == UnaryOperatorKind.Minus && type == WType.F32)
        {
            code.Byte(0x8c); // f32.neg
        }
        else if (unary.OperatorKind == UnaryOperatorKind.Minus && type == WType.F64)
        {
            code.Byte(0x9a); // f64.neg
        }
        else if (unary.OperatorKind == UnaryOperatorKind.Not && type == WType.I32)
        {
            code.Byte(0x45); // i32.eqz
        }
        else if (unary.OperatorKind == UnaryOperatorKind.BitwiseNegation && type == WType.I32)
        {
            code.I32(-1);
            code.Byte(0x73); // i32.xor
        }
        else
        {
            throw CompileError.At(unary, "Unsupported unary operator.");
        }

        return type;
    }

    private WType EmitBinary(IBinaryOperation binary)
    {
        if (binary.OperatorMethod is not null || binary.IsLifted || binary.IsChecked)
        {
            throw CompileError.At(binary, "User-defined, lifted and checked binary operations are unsupported.");
        }

        var leftOperand = Frontend.ReferenceEqualityOperand(binary.LeftOperand);
        var rightOperand = Frontend.ReferenceEqualityOperand(binary.RightOperand);
        var type = frontend.MapType(leftOperand.Type ?? rightOperand.Type);
        var resultType = frontend.MapType(binary.Type);
        var operatorKind = binary.OperatorKind;
        if (operatorKind is BinaryOperatorKind.ConditionalAnd or BinaryOperatorKind.ConditionalOr)
        {
            EmitExpression(binary.LeftOperand);
            OpenBlock(0x04, WType.I32, new object());
            if (operatorKind == BinaryOperatorKind.ConditionalAnd)
            {
                EmitExpression(binary.RightOperand);
                code.Byte(0x05); // else
                code.I32(0);
            }
            else
            {
                code.I32(1);
                code.Byte(0x05); // else
                EmitExpression(binary.RightOperand);
            }

            CloseBlock();
            return WType.I32;
        }

        if (type.IsRef && operatorKind is BinaryOperatorKind.Equals or BinaryOperatorKind.NotEquals)
        {
            if (leftOperand.ConstantValue is { HasValue: true, Value: null })
            {
                type.Default(code);
            }
            else
            {
                EmitExpression(leftOperand);
            }

            if (rightOperand.ConstantValue is { HasValue: true, Value: null })
            {
                type.Default(code);
            }
            else
            {
                EmitExpression(rightOperand);
            }

            code.Byte(0xd3); // ref.eq
            if (operatorKind == BinaryOperatorKind.NotEquals)
            {
                code.Byte(0x45); // i32.eqz
            }

            return WType.I32;
        }

        EmitExpression(binary.LeftOperand);
        EmitExpression(binary.RightOperand);
        EmitNumericBinary(type, operatorKind, binary);
        return resultType;
    }

    // Operands are already evaluated, left then right. Saving them here keeps
    // arithmetic fault handling identical for binary and compound operators.
    private void EmitNumericBinary(WType type, BinaryOperatorKind operatorKind, IOperation site)
    {
        if (type == WType.I32 && operatorKind is BinaryOperatorKind.Divide or BinaryOperatorKind.Remainder)
        {
            int right = NewLocal(WType.I32);
            LocalSet(right);
            int left = NewLocal(WType.I32);
            LocalSet(left);
            LocalGet(right);
            code.Byte(0x45); // i32.eqz
            FaultIf(FaultCode.DivisionByZero);

            // Choose the throwing C# division-overflow behavior consistently
            // for both / and %. Wasm rem_s by itself returns zero for Min/-1.
            LocalGet(left);
            code.I32(int.MinValue);
            code.Byte(0x46); // i32.eq
            LocalGet(right);
            code.I32(-1);
            code.Byte(0x46); // i32.eq
            code.Byte(0x71); // i32.and
            FaultIf(FaultCode.DivisionOverflow);

            LocalGet(left);
            LocalGet(right);
        }

        code.Byte(BinaryOpcode(type, operatorKind, site));
    }

    private static byte BinaryOpcode(WType type, BinaryOperatorKind operatorKind, IOperation site)
    {
        if (type == WType.I32)
        {
            return operatorKind switch
            {
                BinaryOperatorKind.Add => 0x6a,
                BinaryOperatorKind.Subtract => 0x6b,
                BinaryOperatorKind.Multiply => 0x6c,
                BinaryOperatorKind.Divide => 0x6d,
                BinaryOperatorKind.Remainder => 0x6f,
                BinaryOperatorKind.And => 0x71,
                BinaryOperatorKind.Or => 0x72,
                BinaryOperatorKind.ExclusiveOr => 0x73,
                BinaryOperatorKind.LeftShift => 0x74,
                BinaryOperatorKind.RightShift => 0x75,
                BinaryOperatorKind.UnsignedRightShift => 0x76,
                BinaryOperatorKind.Equals => 0x46,
                BinaryOperatorKind.NotEquals => 0x47,
                BinaryOperatorKind.LessThan => 0x48,
                BinaryOperatorKind.GreaterThan => 0x4a,
                BinaryOperatorKind.LessThanOrEqual => 0x4c,
                BinaryOperatorKind.GreaterThanOrEqual => 0x4e,
                _ => throw CompileError.At(site, "Unsupported integer/Boolean operator.")
            };
        }

        if (type == WType.F32)
        {
            return operatorKind switch
            {
                BinaryOperatorKind.Add => 0x92,
                BinaryOperatorKind.Subtract => 0x93,
                BinaryOperatorKind.Multiply => 0x94,
                BinaryOperatorKind.Divide => 0x95,
                BinaryOperatorKind.Equals => 0x5b,
                BinaryOperatorKind.NotEquals => 0x5c,
                BinaryOperatorKind.LessThan => 0x5d,
                BinaryOperatorKind.GreaterThan => 0x5e,
                BinaryOperatorKind.LessThanOrEqual => 0x5f,
                BinaryOperatorKind.GreaterThanOrEqual => 0x60,
                _ => throw CompileError.At(site, "Unsupported float operator (floating remainder is not implemented).")
            };
        }

        if (type == WType.F64)
        {
            return operatorKind switch
            {
                BinaryOperatorKind.Add => 0xa0,
                BinaryOperatorKind.Subtract => 0xa1,
                BinaryOperatorKind.Multiply => 0xa2,
                BinaryOperatorKind.Divide => 0xa3,
                BinaryOperatorKind.Equals => 0x61,
                BinaryOperatorKind.NotEquals => 0x62,
                BinaryOperatorKind.LessThan => 0x63,
                BinaryOperatorKind.GreaterThan => 0x64,
                BinaryOperatorKind.LessThanOrEqual => 0x65,
                BinaryOperatorKind.GreaterThanOrEqual => 0x66,
                _ => throw CompileError.At(site, "Unsupported double operator.")
            };
        }

        throw CompileError.At(site, "Unsupported operand type.");
    }

    private enum LocationKind
    {
        Local,
        Field,
        ArrayElement
    }

    // Receiver and index expressions are saved once, before a location is read or written.
    private sealed record Location(
        LocationKind Kind,
        WType Type,
        int Local = -1,
        int Receiver = -1,
        int Index = -1,
        WType Container = default,
        int Field = -1);

    private Location PrepareLocation(IOperation target, bool validate = true)
    {
        var type = frontend.MapType(target.Type);
        switch (target)
        {
            case ILocalReferenceOperation local when localIds.TryGetValue(local.Local, out int id):
                return new(LocationKind.Local, type, Local: id);
            case IParameterReferenceOperation parameter:
                return new(LocationKind.Local, type, Local: parameter.Parameter.Ordinal + (plan.Symbol.IsStatic ? 0 : 1));
            case IFieldReferenceOperation field when field.Instance is not null && !field.Field.IsStatic:
                int fieldReceiver = SaveToLocal(field.Instance);
                if (validate)
                {
                    CheckNull(fieldReceiver);
                }
                return new(
                    LocationKind.Field,
                    type,
                    Receiver: fieldReceiver,
                    Container: frontend.MapType(field.Field.ContainingType),
                    Field: frontend.FieldIndex(field.Field, target));
            case IArrayElementReferenceOperation array when array.Indices.Length == 1:
                int receiver = SaveToLocal(array.ArrayReference);
                int index = SaveToLocal(array.Indices[0]);
                if (validate)
                {
                    CheckArray(receiver, index);
                }
                return new(
                    LocationKind.ArrayElement,
                    type,
                    Receiver: receiver,
                    Index: index,
                    Container: frontend.MapType(array.ArrayReference.Type));
            default:
                throw CompileError.At(target, "Only local, parameter, instance field and single array-element locations are supported.");
        }
    }

    private void CheckLocation(Location location)
    {
        if (location.Kind == LocationKind.Field)
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
            case LocationKind.ArrayElement:
                LocalGet(location.Receiver);
                LocalGet(location.Index);
                code.Gc(11, location.Container.Heap); // array.get
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
            case LocationKind.ArrayElement:
                LocalGet(location.Receiver);
                LocalGet(location.Index);
                LocalGet(value);
                code.Gc(14, location.Container.Heap); // array.set
                break;
        }
    }

    private WType EmitCompoundAssignment(ICompoundAssignmentOperation assignment)
    {
        if (assignment.OperatorMethod is not null || assignment.IsChecked || assignment.IsLifted
            || !assignment.InConversion.IsIdentity || !assignment.OutConversion.IsIdentity)
        {
            throw CompileError.At(assignment,
                "User-defined, checked, lifted and narrowing compound assignments are unsupported.");
        }

        var location = PrepareLocation(assignment.Target);
        if (location.Type.IsRef || frontend.MapType(assignment.Value.Type) != location.Type
            || (assignment.Target.Type?.SpecialType == SpecialType.System_Boolean
                && assignment.OperatorKind is not (BinaryOperatorKind.And or BinaryOperatorKind.Or
                    or BinaryOperatorKind.ExclusiveOr)))
        {
            throw CompileError.At(assignment, "Unsupported compound assignment operand types.");
        }

        // Unlike simple assignment, compound assignment reads (and therefore
        // checks) its location before evaluating the right-hand side. Retain
        // that old value even if the right-hand side changes the same location.
        Load(location);
        EmitExpression(assignment.Value);
        EmitNumericBinary(location.Type, assignment.OperatorKind, assignment);
        int value = NewLocal(location.Type);
        LocalSet(value);
        Store(location, value);
        LocalGet(value);
        return location.Type;
    }

    private WType EmitIncrement(IIncrementOrDecrementOperation increment)
    {
        if (increment.OperatorMethod is not null || increment.IsChecked || increment.IsLifted)
        {
            throw CompileError.At(increment, "User-defined, checked and lifted increments are unsupported.");
        }

        var location = PrepareLocation(increment.Target);
        if (location.Type != WType.I32)
        {
            throw CompileError.At(increment, "Only int increment/decrement is supported.");
        }

        Load(location);
        int before = NewLocal(WType.I32);
        LocalSet(before);
        LocalGet(before);
        code.I32(1);
        code.Byte(increment.Kind == OperationKind.Increment ? (byte)0x6a : (byte)0x6b);
        int after = NewLocal(WType.I32);
        LocalSet(after);
        Store(location, after);
        LocalGet(increment.IsPostfix ? before : after);
        return WType.I32;
    }

    private void EmitFieldInitializers()
    {
        var type = frontend.MapType(plan.Symbol.ContainingType);
        foreach (var initializer in frontend.FieldInitializers(plan.Symbol.ContainingType))
        {
            // The object has already been zeroed. C# evaluates these expressions
            // in declaration order, before entering the constructor body.
            LocalGet(0);
            EmitExpression(initializer.Value);
            code.Gc(5, type.Heap, frontend.FieldIndex(initializer.Field, initializer.Value)); // struct.set
        }
    }

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
            code.OpIndex(0x10, constructorIndex);
        }

        // Object initializer assignments run after the constructor body.
        if (creation.Initializer is not null)
        {
            initializerReceivers.Push(receiver);
            foreach (var init in creation.Initializer.Initializers)
            {
                if (init is not ISimpleAssignmentOperation { Target: IFieldReferenceOperation })
                {
                    throw CompileError.At(init, "Only field assignments are supported in object initializers.");
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

        int length = SaveToLocal(creation.DimensionSizes[0]);
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

        code.OpIndex(0x10, method);
        if (frontend.IsImport(invocation.TargetMethod)
            && invocation.TargetMethod.ReturnType.SpecialType == SpecialType.System_Boolean)
        {
            // Wasm represents bool as i32; normalize any nonzero host result.
            code.Byte(0x45); // i32.eqz
            code.Byte(0x45); // i32.eqz
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
