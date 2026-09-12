// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection.Metadata;

namespace Gameplay.Compiler;

// One decoded IL instruction: its offset and opcode, and its operand (an
// integer, a long, a float or double's bits, a token, a branch target, or
// a switch's targets).
internal sealed record IlInstruction(int Offset, ILOpCode OpCode, long Operand = 0, double Real = 0, int[]? Targets = null)
{
    public int Token => (int)Operand;

    public int Target => (int)Operand;

    public override string ToString() =>
        $"IL_{Offset:X4}: {OpCode}" + (Targets is null ? $" {Operand}" : " (" + string.Join(", ", Targets.Select(target => $"IL_{target:X4}")) + ")");
}

// A rewritten body's operand: a symbol the compiler names, open as the
// method's definition would name it.
internal sealed record IlSymbolOperand(Microsoft.CodeAnalysis.ISymbol Symbol);

internal enum IlCodeKind
{
    Method,
    // A runtime-async method's (Il.RuntimeAsync): the function its callers
    // call, which makes the frame and runs the first step, and the
    // function each step resumes in.
    RuntimeAsyncKickoff,
    RuntimeAsyncResume,
}

// The instructions a rewritten body has that IL does not, in opcodes IL
// leaves unassigned: the kickoff's frame and continuation (an Action whose
// target is the frame), and a step's return.
internal static class IlPseudo
{
    public const ILOpCode NewResume = (ILOpCode)0xFEE0;
    public const ILOpCode StepReturn = (ILOpCode)0xFEE1;
}

// An exception-handling clause, by IL offsets. A catch clause of
// CatchToken -1 catches System.Exception.
internal sealed record IlRegion(
    ExceptionRegionKind Kind,
    int TryStart,
    int TryEnd,
    int HandlerStart,
    int HandlerEnd,
    int FilterStart,
    int CatchToken);

// A method body's instructions and exception clauses, and the assembly
// whose tokens they name. A body the compiler rewrote (Il.RuntimeAsync)
// also has locals of its own after the signature's, instructions whose
// operands are symbols rather than tokens, and offsets of its own, which
// map back to the IL's for diagnostics.
internal sealed class IlCode
{
    public IlCode(
        IlCode original,
        ImmutableArray<IlInstruction> instructions,
        ImmutableArray<IlRegion> regions,
        ImmutableArray<IlType> extraLocals,
        Dictionary<int, IlSymbolOperand> synthetic,
        Func<int, int> sourceOffset)
    {
        Body = original.Body;
        Module = original.Module;
        Instructions = instructions;
        Regions = regions;
        ExtraLocals = extraLocals;
        Synthetic = synthetic;
        SourceOffset = sourceOffset;
        for (int index = 0; index < Instructions.Length; index++)
        {
            IndexOf[Instructions[index].Offset] = index;
        }
    }

    public IlCode(MethodBodyBlock body, IlModule module)
    {
        Body = body;
        Module = module;
        Instructions = Decode(body.GetILReader());
        Regions = [.. body.ExceptionRegions.Select(region => new IlRegion(
            region.Kind,
            region.TryOffset,
            region.TryOffset + region.TryLength,
            region.HandlerOffset,
            region.HandlerOffset + region.HandlerLength,
            region.Kind == ExceptionRegionKind.Filter ? region.FilterOffset : -1,
            region.Kind == ExceptionRegionKind.Catch ? System.Reflection.Metadata.Ecma335.MetadataTokens.GetToken(region.CatchType) : 0))];
        for (int index = 0; index < Instructions.Length; index++)
        {
            IndexOf[Instructions[index].Offset] = index;
        }
    }

    public MethodBodyBlock Body { get; }

    public IlModule Module { get; }

    public ImmutableArray<IlInstruction> Instructions { get; }

    public ImmutableArray<IlRegion> Regions { get; }

    // Locals past the signature's, by their open types.
    public ImmutableArray<IlType> ExtraLocals { get; } = [];

    // The operands of instructions the compiler wrote, by instruction
    // index: symbols open as the definition names them.
    public Dictionary<int, IlSymbolOperand> Synthetic { get; } = [];

    // The IL offset an offset of this body stands for.
    public Func<int, int> SourceOffset { get; } = offset => offset;

    // What kind of body a rewritten one is.
    public IlCodeKind Kind { get; init; }

    // The index of the instruction at an offset.
    public Dictionary<int, int> IndexOf { get; } = [];

    private static ImmutableArray<IlInstruction> Decode(BlobReader reader)
    {
        var instructions = ImmutableArray.CreateBuilder<IlInstruction>();
        while (reader.RemainingBytes > 0)
        {
            int offset = reader.Offset;
            int first = reader.ReadByte();
            var opcode = first == 0xFE ? (ILOpCode)(0xFE00 | reader.ReadByte()) : (ILOpCode)first;
            int next;
            switch (opcode)
            {
                case ILOpCode.Br_s or ILOpCode.Brfalse_s or ILOpCode.Brtrue_s or ILOpCode.Beq_s or ILOpCode.Bge_s
                    or ILOpCode.Bgt_s or ILOpCode.Ble_s or ILOpCode.Blt_s or ILOpCode.Bne_un_s or ILOpCode.Bge_un_s
                    or ILOpCode.Bgt_un_s or ILOpCode.Ble_un_s or ILOpCode.Blt_un_s or ILOpCode.Leave_s:
                    int shortDelta = reader.ReadSByte();
                    next = reader.Offset;
                    instructions.Add(new(offset, Long(opcode), next + shortDelta));
                    break;
                case ILOpCode.Br or ILOpCode.Brfalse or ILOpCode.Brtrue or ILOpCode.Beq or ILOpCode.Bge or ILOpCode.Bgt
                    or ILOpCode.Ble or ILOpCode.Blt or ILOpCode.Bne_un or ILOpCode.Bge_un or ILOpCode.Bgt_un
                    or ILOpCode.Ble_un or ILOpCode.Blt_un or ILOpCode.Leave:
                    int delta = reader.ReadInt32();
                    next = reader.Offset;
                    instructions.Add(new(offset, opcode, next + delta));
                    break;
                case ILOpCode.Switch:
                    int count = reader.ReadInt32();
                    var deltas = new int[count];
                    for (int index = 0; index < count; index++)
                    {
                        deltas[index] = reader.ReadInt32();
                    }

                    next = reader.Offset;
                    instructions.Add(new(offset, opcode, Targets: [.. deltas.Select(value => next + value)]));
                    break;
                case ILOpCode.Ldarg_s or ILOpCode.Ldarga_s or ILOpCode.Starg_s or ILOpCode.Ldloc_s or ILOpCode.Ldloca_s
                    or ILOpCode.Stloc_s or ILOpCode.Unaligned:
                    instructions.Add(new(offset, Long(opcode), reader.ReadByte()));
                    break;
                case ILOpCode.Ldc_i4_s:
                    instructions.Add(new(offset, ILOpCode.Ldc_i4, reader.ReadSByte()));
                    break;
                case ILOpCode.Ldarg or ILOpCode.Ldarga or ILOpCode.Starg or ILOpCode.Ldloc or ILOpCode.Ldloca or ILOpCode.Stloc:
                    instructions.Add(new(offset, opcode, reader.ReadUInt16()));
                    break;
                case ILOpCode.Ldc_i4:
                    instructions.Add(new(offset, opcode, reader.ReadInt32()));
                    break;
                case ILOpCode.Ldc_i8:
                    instructions.Add(new(offset, opcode, reader.ReadInt64()));
                    break;
                case ILOpCode.Ldc_r4:
                    instructions.Add(new(offset, opcode, Real: reader.ReadSingle()));
                    break;
                case ILOpCode.Ldc_r8:
                    instructions.Add(new(offset, opcode, Real: reader.ReadDouble()));
                    break;
                case ILOpCode.Ldstr or ILOpCode.Ldtoken or ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj
                    or ILOpCode.Ldfld or ILOpCode.Ldflda or ILOpCode.Stfld or ILOpCode.Ldsfld or ILOpCode.Ldsflda
                    or ILOpCode.Stsfld or ILOpCode.Box or ILOpCode.Unbox or ILOpCode.Unbox_any or ILOpCode.Newarr
                    or ILOpCode.Castclass or ILOpCode.Isinst or ILOpCode.Ldelema or ILOpCode.Ldelem or ILOpCode.Stelem
                    or ILOpCode.Ldobj or ILOpCode.Stobj or ILOpCode.Cpobj or ILOpCode.Initobj or ILOpCode.Sizeof
                    or ILOpCode.Ldftn or ILOpCode.Ldvirtftn or ILOpCode.Constrained or ILOpCode.Mkrefany
                    or ILOpCode.Refanyval or ILOpCode.Calli or ILOpCode.Jmp:
                    instructions.Add(new(offset, opcode, reader.ReadInt32()));
                    break;
                case (ILOpCode)0xFE19: // no.
                    instructions.Add(new(offset, ILOpCode.Nop, reader.ReadByte()));
                    break;
                default:
                    instructions.Add(Short(offset, opcode));
                    break;
            }
        }

        return instructions.ToImmutable();
    }

    // The short forms as the long ones, so that lowering sees one of each.
    private static ILOpCode Long(ILOpCode opcode) => opcode switch
    {
        ILOpCode.Br_s => ILOpCode.Br,
        ILOpCode.Brfalse_s => ILOpCode.Brfalse,
        ILOpCode.Brtrue_s => ILOpCode.Brtrue,
        ILOpCode.Beq_s => ILOpCode.Beq,
        ILOpCode.Bge_s => ILOpCode.Bge,
        ILOpCode.Bgt_s => ILOpCode.Bgt,
        ILOpCode.Ble_s => ILOpCode.Ble,
        ILOpCode.Blt_s => ILOpCode.Blt,
        ILOpCode.Bne_un_s => ILOpCode.Bne_un,
        ILOpCode.Bge_un_s => ILOpCode.Bge_un,
        ILOpCode.Bgt_un_s => ILOpCode.Bgt_un,
        ILOpCode.Ble_un_s => ILOpCode.Ble_un,
        ILOpCode.Blt_un_s => ILOpCode.Blt_un,
        ILOpCode.Leave_s => ILOpCode.Leave,
        ILOpCode.Ldarg_s => ILOpCode.Ldarg,
        ILOpCode.Ldarga_s => ILOpCode.Ldarga,
        ILOpCode.Starg_s => ILOpCode.Starg,
        ILOpCode.Ldloc_s => ILOpCode.Ldloc,
        ILOpCode.Ldloca_s => ILOpCode.Ldloca,
        ILOpCode.Stloc_s => ILOpCode.Stloc,
        _ => opcode,
    };

    // The implicit-operand forms as the explicit ones.
    private static IlInstruction Short(int offset, ILOpCode opcode) => opcode switch
    {
        ILOpCode.Ldarg_0 => new(offset, ILOpCode.Ldarg, 0),
        ILOpCode.Ldarg_1 => new(offset, ILOpCode.Ldarg, 1),
        ILOpCode.Ldarg_2 => new(offset, ILOpCode.Ldarg, 2),
        ILOpCode.Ldarg_3 => new(offset, ILOpCode.Ldarg, 3),
        ILOpCode.Ldloc_0 => new(offset, ILOpCode.Ldloc, 0),
        ILOpCode.Ldloc_1 => new(offset, ILOpCode.Ldloc, 1),
        ILOpCode.Ldloc_2 => new(offset, ILOpCode.Ldloc, 2),
        ILOpCode.Ldloc_3 => new(offset, ILOpCode.Ldloc, 3),
        ILOpCode.Stloc_0 => new(offset, ILOpCode.Stloc, 0),
        ILOpCode.Stloc_1 => new(offset, ILOpCode.Stloc, 1),
        ILOpCode.Stloc_2 => new(offset, ILOpCode.Stloc, 2),
        ILOpCode.Stloc_3 => new(offset, ILOpCode.Stloc, 3),
        ILOpCode.Ldc_i4_m1 => new(offset, ILOpCode.Ldc_i4, -1),
        ILOpCode.Ldc_i4_0 => new(offset, ILOpCode.Ldc_i4, 0),
        ILOpCode.Ldc_i4_1 => new(offset, ILOpCode.Ldc_i4, 1),
        ILOpCode.Ldc_i4_2 => new(offset, ILOpCode.Ldc_i4, 2),
        ILOpCode.Ldc_i4_3 => new(offset, ILOpCode.Ldc_i4, 3),
        ILOpCode.Ldc_i4_4 => new(offset, ILOpCode.Ldc_i4, 4),
        ILOpCode.Ldc_i4_5 => new(offset, ILOpCode.Ldc_i4, 5),
        ILOpCode.Ldc_i4_6 => new(offset, ILOpCode.Ldc_i4, 6),
        ILOpCode.Ldc_i4_7 => new(offset, ILOpCode.Ldc_i4, 7),
        ILOpCode.Ldc_i4_8 => new(offset, ILOpCode.Ldc_i4, 8),
        _ => new(offset, opcode),
    };
}
