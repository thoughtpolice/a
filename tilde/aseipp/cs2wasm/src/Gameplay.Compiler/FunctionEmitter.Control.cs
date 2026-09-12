// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Gameplay.Compiler;

// Loops, switches and patterns. Every construct lowers to Wasm's structured
// blocks; `break` and `continue` branch to the labels Roslyn attaches to the
// enclosing loop or switch, which are pushed on the label stack here.
internal sealed partial class FunctionEmitter
{
    // MARK: Loops

    private void EmitWhileLoop(IWhileLoopOperation loop)
    {
        if (loop.ConditionIsUntil || loop.Condition is null)
        {
            throw CompileError.At(loop, "Only ordinary while and do/while loops are supported.");
        }

        if (loop.ConditionIsTop)
        {
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
        }

        // do/while: `continue` skips to the condition, which decides whether
        // the loop header runs again.
        var repeat = new object();
        OpenBlock(0x02, WType.Void, loop.ExitLabel);
        OpenBlock(0x03, WType.Void, repeat);
        ConsumeFuel();
        OpenBlock(0x02, WType.Void, loop.ContinueLabel);
        EmitStatement(loop.Body);
        CloseBlock();
        EmitExpression(loop.Condition);
        Branch(repeat, true);
        CloseBlock();
        CloseBlock();
    }

    private void EmitForLoop(IForLoopOperation loop)
    {
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
        if (elementType.IsRef != variableType.IsRef
            || (elementType.IsRef && !SymbolEqualityComparer.Default.Equals(arrayType.ElementType, declarator.Symbol.Type)))
        {
            throw CompileError.At(loop, "The foreach variable must have the element type or a scalar conversion from it.");
        }

        int variable = NewLocal(variableType);
        localIds[declarator.Symbol] = variable;

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
        if (!elementType.IsRef)
        {
            // C# permits an explicit conversion of each element to the variable's type.
            EmitScalarConversion(
                Frontend.ScalarOf(arrayType.ElementType)!.Value,
                Frontend.ScalarOf(declarator.Symbol.Type)!.Value,
                loop);
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

    // MARK: Switch statements

    private void EmitSwitch(ISwitchOperation sw)
    {
        // The switch block is one scope: a local declared in one section can
        // be assigned and used in a later one. The default section's body is
        // emitted last, so its declarations may reach code emitted before it;
        // allocate every section-scoped local first.
        foreach (var local in sw.Locals)
        {
            if (!local.IsConst)
            {
                DeclareLocal(local);
            }
        }

        int value = SaveToLocal(sw.Value);
        var valueType = sw.Value.Type!;
        ISwitchCaseOperation? defaultSection = null;
        foreach (var section in sw.Cases)
        {
            if (section.Clauses.Any(clause => clause is IDefaultCaseClauseOperation))
            {
                if (defaultSection is not null)
                {
                    throw CompileError.At(section, "A switch has one default section.");
                }

                defaultSection = section;
            }
        }

        // Sections are tested in order; the default section's body sits after
        // the inner block, where the tests branch to when nothing else matched
        // (or when one of its own case labels did). Each other body ends by
        // leaving the outer block, so the default never runs after it.
        var runDefault = new object();
        OpenBlock(0x02, WType.Void, sw.ExitLabel);
        OpenBlock(0x02, WType.Void, runDefault);
        foreach (var section in sw.Cases)
        {
            var tests = section.Clauses.Where(clause => clause is not IDefaultCaseClauseOperation).ToList();
            if (tests.Count == 0)
            {
                continue;
            }

            EmitAnyClause(tests, value, valueType);
            if (ReferenceEquals(section, defaultSection))
            {
                Branch(runDefault, true);
                continue;
            }

            OpenBlock(0x04, WType.Void, new object());
            EmitSectionBody(section);
            Branch(sw.ExitLabel);
            CloseBlock();
        }

        CloseBlock();
        if (defaultSection is not null)
        {
            EmitSectionBody(defaultSection);
        }

        CloseBlock();
    }

    private void EmitSectionBody(ISwitchCaseOperation section)
    {
        foreach (var statement in section.Body)
        {
            EmitStatement(statement);
        }
    }

    private void EmitAnyClause(IReadOnlyList<ICaseClauseOperation> clauses, int value, ITypeSymbol valueType)
    {
        EmitClause(clauses[0], value, valueType);
        for (int index = 1; index < clauses.Count; index++)
        {
            OpenBlock(0x04, WType.I32, new object());
            code.I32(1);
            code.Byte(0x05); // else
            EmitClause(clauses[index], value, valueType);
            CloseBlock();
        }
    }

    private void EmitClause(ICaseClauseOperation clause, int value, ITypeSymbol valueType)
    {
        switch (clause)
        {
            case ISingleValueCaseClauseOperation single:
                EmitEqualsConstant(value, valueType, single.Value);
                return;
            case IPatternCaseClauseOperation pattern:
                EmitPatternTest(pattern.Pattern, value, valueType);
                EmitGuard(pattern.Guard);
                return;
            default:
                throw CompileError.At(clause, "Unsupported switch case clause.");
        }
    }

    // ANDs the i32 already on the stack with a `when` clause, short-circuited.
    private void EmitGuard(IOperation? guard)
    {
        if (guard is null)
        {
            return;
        }

        OpenBlock(0x04, WType.I32, new object());
        EmitExpression(guard);
        code.Byte(0x05); // else
        code.I32(0);
        CloseBlock();
    }

    private void EmitEqualsConstant(int value, ITypeSymbol valueType, IOperation constant)
    {
        var type = frontend.MapType(valueType);
        if (type.IsRef)
        {
            if (constant.ConstantValue is not { HasValue: true, Value: null })
            {
                throw CompileError.At(constant, "References compare only against null.");
            }

            LocalGet(value);
            code.Byte(0xd1); // ref.is_null
            return;
        }

        var scalar = Frontend.ScalarOf(valueType)!.Value;
        if (IsFloating(scalar) && constant.ConstantValue is { HasValue: true, Value: float.NaN or double.NaN })
        {
            // A constant pattern uses Equals, under which NaN matches NaN.
            LocalGet(value);
            LocalGet(value);
            code.Byte(BinaryOpcode(scalar, BinaryOperatorKind.NotEquals, constant));
            return;
        }

        LocalGet(value);
        EmitExpression(constant);
        code.Byte(BinaryOpcode(scalar, BinaryOperatorKind.Equals, constant));
    }

    // MARK: Patterns

    private void EmitPatternTest(IPatternOperation pattern, int value, ITypeSymbol valueType)
    {
        switch (pattern)
        {
            case IDiscardPatternOperation:
                code.I32(1);
                return;
            case IConstantPatternOperation constant:
                EmitEqualsConstant(value, valueType, constant.Value);
                return;
            case IRelationalPatternOperation relational:
                if (frontend.MapType(valueType).IsRef)
                {
                    throw CompileError.At(pattern, "Relational patterns need a numeric input.");
                }

                LocalGet(value);
                EmitExpression(relational.Value);
                code.Byte(BinaryOpcode(Frontend.ScalarOf(valueType)!.Value, relational.OperatorKind, relational));
                return;
            case INegatedPatternOperation negated:
                EmitPatternTest(negated.Pattern, value, valueType);
                code.Byte(0x45); // i32.eqz
                return;
            case IBinaryPatternOperation binary:
                EmitPatternTest(binary.LeftPattern, value, valueType);
                OpenBlock(0x04, WType.I32, new object());
                if (binary.OperatorKind == BinaryOperatorKind.And)
                {
                    EmitPatternTest(binary.RightPattern, value, valueType);
                    code.Byte(0x05); // else
                    code.I32(0);
                }
                else
                {
                    code.I32(1);
                    code.Byte(0x05); // else
                    EmitPatternTest(binary.RightPattern, value, valueType);
                }

                CloseBlock();
                return;
            default:
                throw CompileError.At(pattern,
                    "Only constant, relational, discard, and/or/not patterns are supported.");
        }
    }

    private WType EmitIsPattern(IIsPatternOperation isPattern)
    {
        int value = SaveToLocal(isPattern.Value);
        EmitPatternTest(isPattern.Pattern, value, isPattern.Value.Type!);
        return WType.I32;
    }

    private WType EmitSwitchExpression(ISwitchExpressionOperation sw)
    {
        var type = frontend.MapType(sw.Type);
        int value = SaveToLocal(sw.Value);
        EmitArms(sw.Arms, 0, value, sw.Value.Type!, type);
        return type;
    }

    // Arms nest as if/else chains; falling off the end is the
    // SwitchExpressionException case, a fault here.
    private void EmitArms(
        System.Collections.Immutable.ImmutableArray<ISwitchExpressionArmOperation> arms,
        int index,
        int value,
        ITypeSymbol valueType,
        WType type)
    {
        if (index == arms.Length)
        {
            Fault(FaultCode.UnmatchedSwitch);
            return;
        }

        var arm = arms[index];
        EmitPatternTest(arm.Pattern, value, valueType);
        EmitGuard(arm.Guard);
        OpenBlock(0x04, type, new object());
        EmitExpression(arm.Value);
        code.Byte(0x05); // else
        EmitArms(arms, index + 1, value, valueType, type);
        CloseBlock();
    }

    private WType EmitCoalesce(ICoalesceOperation coalesce)
    {
        var type = frontend.MapType(coalesce.Type);
        if (!type.IsRef || !coalesce.ValueConversion.IsIdentity)
        {
            throw CompileError.At(coalesce, "?? is supported between references of one type.");
        }

        int value = SaveToLocal(coalesce.Value);
        LocalGet(value);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, type, new object());
        EmitExpression(coalesce.WhenNull);
        code.Byte(0x05); // else
        LocalGet(value);
        CloseBlock();
        return type;
    }
}
