// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection.Metadata;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// `new S(...)` of a struct is a zeroed box the constructor fills (the
// constructor takes `this` by reference, as the box of its storage), read
// back as a value: an allocation per value made, which a Vector2 or a
// tuple made in a loop pays each time. Most struct constructors only store
// their arguments, so where the constructor's IL is one of the two shapes
// C# gives them the value is made at the call site instead, with nothing
// allocated and nothing called:
//
// - field stores: `this = default` optionally, then `this.F = argument`
//   or `this.F = constant` for fields in any order, then return (tuples,
//   KeyValuePair, positional record structs, most hand-written ones);
// - a factory: `this = M(arguments in order)`, for a static M returning
//   the struct (System.Numerics' `Vector2(x, y) { this = Create(x, y); }`),
//   which is called instead.
//
// A struct with a static constructor keeps its call: running its
// constructor is what initializes the type (see Static state in the
// README). The fuel and depth the constructor's call would have spent are
// not spent.
internal sealed partial class Frontend
{
    private readonly Dictionary<IMethodSymbol, InlineConstruction?> inlineConstructions = new(SymbolEqualityComparer.Default);

    // How `new` makes a struct without its constructor's call, or null.
    public InlineConstruction? InlinedConstruction(IMethodSymbol constructor) =>
        inlineConstructions.TryGetValue(constructor, out var inline) ? inline : null;

    // Decides, where the walk first meets `new` of a struct constructor,
    // whether the constructor's value can be made in place.
    private void NoteStructConstruction(IMethodSymbol constructor, Substitution generic)
    {
        if (inlineConstructions.ContainsKey(constructor))
        {
            return;
        }

        if (IlPlanOf(constructor) is null)
        {
            // Not registered yet: decided at a later `new`.
            return;
        }

        var inline = AnalyzeConstruction(constructor);
        inlineConstructions[constructor] = inline;
        if (inline?.Factory is { } factory)
        {
            EnsureMethod(factory, generic);
        }
    }

    private InlineConstruction? AnalyzeConstruction(IMethodSymbol constructor)
    {
        var type = constructor.ContainingType;
        if (!IsStruct(type) || !IsModuleDefined(constructor) || InlineArrayLength(type) is not null
            || staticConstructors.ContainsKey(type) || staticConstructors.ContainsKey(type.OriginalDefinition)
            || constructor.Parameters.Any(parameter => parameter.RefKind != RefKind.None)
            || IlPlanOf(constructor) is not { Il: not null } plan)
        {
            return null;
        }

        IlAnalysis flow;
        try
        {
            flow = new IlAnalysis(this, plan);
        }
        catch (CompileError)
        {
            return null;
        }

        if (flow.Groups.Count != 0)
        {
            return null;
        }

        var code = new List<(IlInstruction Instruction, object? Operand)>();
        for (int index = 0; index < flow.Instructions.Length; index++)
        {
            if (flow.Instructions[index].OpCode != ILOpCode.Nop)
            {
                code.Add((flow.Instructions[index], flow.Operands[index]));
            }
        }

        return Factory(code, constructor) ?? FieldStores(code, constructor);
    }

    // `this = M(arguments)`: ldarg.0, ldarg.1 .. ldarg.n, call M, stobj S, ret.
    private static InlineConstruction? Factory(List<(IlInstruction Instruction, object? Operand)> code, IMethodSymbol constructor)
    {
        int count = constructor.Parameters.Length;
        if (code.Count != count + 4 || !IsArgument(code[0].Instruction, 0))
        {
            return null;
        }

        for (int argument = 1; argument <= count; argument++)
        {
            if (!IsArgument(code[argument].Instruction, argument))
            {
                return null;
            }
        }

        var type = constructor.ContainingType;
        if (code[count + 1] is not { Instruction.OpCode: ILOpCode.Call, Operand: IMethodSymbol factory }
            || !factory.IsStatic || factory.IsGenericMethod || factory.Parameters.Length != count
            || !SymbolEqualityComparer.Default.Equals(factory.ReturnType, type)
            || factory.Parameters.Any(parameter => parameter.RefKind != RefKind.None)
            || code[count + 2] is not { Instruction.OpCode: ILOpCode.Stobj, Operand: ITypeSymbol stored }
            || !SymbolEqualityComparer.Default.Equals(stored, type)
            || code[count + 3].Instruction.OpCode != ILOpCode.Ret
            || !IsModuleDefined(factory))
        {
            return null;
        }

        return new InlineConstruction(null, factory);
    }

    // Field stores of arguments and constants: `this.F = argument`,
    // `this.F = constant` (a long's zero is an int's widened, as C# writes
    // it), and `this.F = default` of a struct-typed field (`ldflda F;
    // initobj`), which C# writes for the fields a constructor leaves.
    private InlineConstruction? FieldStores(List<(IlInstruction Instruction, object? Operand)> code, IMethodSymbol constructor)
    {
        var type = constructor.ContainingType;
        var layout = StructOf(MapType(type));
        var sources = new FieldSource[layout.Fields.Count];
        int Position(IFieldSymbol field) => layout.Fields.FindIndex(candidate =>
            candidate.Name == field.Name
            && SymbolEqualityComparer.Default.Equals(candidate.ContainingType.OriginalDefinition, field.ContainingType.OriginalDefinition));

        int at = 0;
        if (code.Count >= 2 && IsArgument(code[0].Instruction, 0) && code[1] is { Instruction.OpCode: ILOpCode.Initobj })
        {
            at = 2;
        }

        while (at + 3 <= code.Count && IsArgument(code[at].Instruction, 0))
        {
            if (code[at + 1] is { Instruction.OpCode: ILOpCode.Ldflda, Operand: IFieldSymbol { IsStatic: false } zeroed }
                && code[at + 2].Instruction.OpCode == ILOpCode.Initobj)
            {
                if (Position(zeroed) is var cleared and >= 0)
                {
                    sources[cleared] = default;
                    at += 3;
                    continue;
                }

                return null;
            }

            var value = code[at + 1].Instruction;
            int length = 1;
            if (value.OpCode == ILOpCode.Ldc_i4 && at + 2 < code.Count && code[at + 2].Instruction.OpCode == ILOpCode.Conv_i8)
            {
                value = value with { OpCode = ILOpCode.Ldc_i8 };
                length = 2;
            }

            if (at + 2 + length > code.Count
                || code[at + 1 + length] is not { Instruction.OpCode: ILOpCode.Stfld, Operand: IFieldSymbol { IsStatic: false } field })
            {
                return null;
            }

            int position = Position(field);
            if (position < 0)
            {
                return null;
            }

            switch (value.OpCode)
            {
                case ILOpCode.Ldarg when value.Operand >= 1 && value.Operand <= constructor.Parameters.Length
                                         && SymbolEqualityComparer.Default.Equals(
                                             constructor.Parameters[(int)value.Operand - 1].Type, field.Type):
                    sources[position] = new FieldSource((int)value.Operand, null);
                    break;
                case ILOpCode.Ldc_i4 or ILOpCode.Ldc_i8 or ILOpCode.Ldc_r4 or ILOpCode.Ldc_r8 or ILOpCode.Ldnull:
                    sources[position] = new FieldSource(0, value);
                    break;
                default:
                    return null;
            }

            at += 2 + length;
        }

        return at == code.Count - 1 && code[at].Instruction.OpCode == ILOpCode.Ret
            ? new InlineConstruction(sources, null)
            : null;
    }

    private static bool IsArgument(IlInstruction instruction, int number) =>
        instruction.OpCode == ILOpCode.Ldarg && instruction.Operand == number;
}

// Where each of a struct's fields comes from when `new` makes it in place:
// Fields by layout position (an IL argument number from 1, a constant
// instruction, or neither for the zero value), or a Factory to call.
internal sealed record InlineConstruction(FieldSource[]? Fields, IMethodSymbol? Factory);

internal readonly record struct FieldSource(int Argument, IlInstruction? Constant);
