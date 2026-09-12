// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

namespace Gameplay.Compiler;

// Stackification (see docs/IMPORTER.md, "Stackification as built"): a pass
// over each linked function body that keeps values on the Wasm operand
// stack where the lowering put them in locals, and packs what locals remain.
// The lowering gives every IL stack entry a local and saves intermediate
// values in locals of their own; this pass, in the manner of LLVM's
// WebAssembly RegStackify and Binaryen's simplify-locals and
// coalesce-locals, but over the binary code:
//
// - removes a `local.set x` and the one `local.get x` its value reaches when
//   everything between them leaves the stack as it found it (the value then
//   simply stays where it was: nothing is moved, so side effects, traps and
//   exceptions between them keep their order);
// - gives a block whose every exit sets one local, read right after it, that
//   local's type as its result (the IL's merge slots, the body's result);
// - removes a `local.tee x` whose value nothing reads, turns a dead
//   `local.set x` into `drop`, drops a constant or local read that is
//   dropped, and deletes code after an unconditional branch;
// - replaces the reads of a local that only ever holds one constant with
//   the constant, where that is no larger;
// - gives locals of one type whose live ranges do not overlap one local,
//   numbers the locals most used first by type, and lets the module writer
//   declare each run of a type once.
//
// Liveness is computed over the body's control flow graph, exception edges
// included (every call or throw inside a try_table may go to each catch
// clause's label around it), so a value an exception handler or a branch
// out of the range reads keeps its local. Non-nullable locals, whose reads
// Wasm validates by where their writes are, are left alone. A body the
// decoder does not understand, or whose stack it cannot account for, is
// written as it was. GAMEPLAYC_STACKIFY=0 turns the pass off.
internal static class LocalPacking
{
    public static bool Enabled { get; } = Environment.GetEnvironmentVariable("GAMEPLAYC_STACKIFY") != "0";

    private static readonly bool Debug = Environment.GetEnvironmentVariable("GAMEPLAYC_DEBUG_STACKIFY") is not null;

    // What the pass needs of the module: each function's type (imports
    // first), the types by index, and each tag's type.
    public sealed class Module(
        IReadOnlyList<TypeDefinition> types,
        IReadOnlyList<Signature> signatures,
        int[] functionTypes,
        IReadOnlyList<int> tags)
    {
        public FunctionType TypeAt(int index) => index < types.Count
            ? types[index].Kind == DefinitionKind.Function
                ? types[index].Signature
                : throw new Unsupported()
            : FunctionType.Of(signatures[index - types.Count]);

        public int Fields(int index) => index < types.Count && types[index].Kind == DefinitionKind.Struct
            ? types[index].Fields.Length
            : throw new Unsupported();

        public FunctionType FunctionAt(int function) => function < functionTypes.Length
            ? TypeAt(functionTypes[function])
            : throw new Unsupported();

        public int TagParameters(int tag) => tag < tags.Count ? TypeAt(tags[tag]).Parameters.Length : throw new Unsupported();
    }

    // Code the decoder does not take, or a stack it cannot account for.
    private sealed class Unsupported : Exception;

    public static WasmFunction Optimize(WasmFunction function, FunctionType type, Module module)
    {
        if (!Enabled)
        {
            return function;
        }

        try
        {
            var code = function.Instructions;
            var locals = function.Locals;
            for (int round = 0; round < 16; round++)
            {
                var body = new Body(code, type, locals, module);
                var rewritten = body.CarryResults() ?? new Body(code, type, locals, module).Stackify();
                if (rewritten is null)
                {
                    break;
                }

                code = rewritten;
            }

            var packed = new Body(code, type, locals, module).Pack();
            return function with { Instructions = packed.Code, Locals = packed.Locals };
        }
        catch (Unsupported)
        {
            if (Debug)
            {
                Console.Error.WriteLine($"stackify: {function.Name}: left as it was");
            }

            return function;
        }
    }

    private enum Kind : byte
    {
        Plain,
        Block,
        Loop,
        If,
        Else,
        End,
        TryTable,
        Br,
        BrIf,
        BrTable,
        // br_on_null, br_on_non_null, br_on_cast and br_on_cast_fail: a
        // conditional branch that leaves values on the stack.
        BrOn,
        // return, unreachable, return_call*: nothing after them runs.
        Return,
        Throw,
        Call,
        LocalGet,
        LocalSet,
        LocalTee,
        Drop,
    }

    private struct Instruction
    {
        public Kind Kind;
        // Its bytes in the body, immediates included.
        public int Start;
        public int End;
        // A local's index; a branch's label; a block's type index or -1.
        public int Operand;
        public int Pops;
        public int Pushes;
        // A block's parameter and result counts.
        public int Parameters;
        public int Results;
        // Pushes one value and does nothing else (a constant, a local's or
        // global's value, ref.null, ref.func).
        public bool Pure;
        // br_table's labels, try_table's catch labels: where in Body.lists.
        public int List;
        public int Count;
    }

    private sealed class Body
    {
        private readonly byte[] code;
        private readonly WType[] parameters;
        private readonly int results;
        private readonly WType[] locals;
        private readonly Module module;
        private readonly List<Instruction> instructions = [];
        private readonly List<int> lists = [];
        private readonly int count;
        private readonly int words;

        // Structure: each block instruction's end, an if's else (or -1),
        // each instruction's enclosing block instruction (-1 for the body).
        private int[] endOf = [];
        private int[] elseOf = [];
        private int[] parent = [];

        // The control flow graph: basic blocks by first instruction.
        private int[] blockOf = [];
        private int[] blockStart = [];
        private List<int>[] successors = [];
        private ulong[][] liveIn = [];
        private ulong[][] liveOut = [];

        public Body(byte[] code, FunctionType type, WType[] locals, Module module)
        {
            this.code = code;
            parameters = type.Parameters;
            results = type.Results.Length;
            this.locals = locals;
            this.module = module;
            count = parameters.Length + locals.Length;
            words = (count + 63) >> 6;
            Decode();
            Structure();
        }

        private WType TypeOf(int local) => local < parameters.Length ? parameters[local] : locals[local - parameters.Length];

        // Non-nullable locals are validated by where their writes are.
        private bool Fixed(int local) => TypeOf(local).Code == 0x64;

        // MARK: Decoding

        private int position;

        private byte Next() => position < code.Length ? code[position++] : throw new Unsupported();

        private uint U32()
        {
            uint result = 0;
            for (int shift = 0; ; shift += 7)
            {
                byte value = Next();
                result |= (uint)(value & 0x7f) << shift;
                if ((value & 0x80) == 0)
                {
                    return result;
                }

                if (shift > 28)
                {
                    throw new Unsupported();
                }
            }
        }

        private int Index() => (int)U32();

        private long Signed()
        {
            long result = 0;
            int shift = 0;
            byte value;
            do
            {
                value = Next();
                result |= (long)(value & 0x7f) << shift;
                shift += 7;
            }
            while ((value & 0x80) != 0 && shift < 70);

            if (shift < 64 && (value & 0x40) != 0)
            {
                result |= -1L << shift;
            }

            return result;
        }

        private void Skip(int bytes)
        {
            position += bytes;
            if (position > code.Length)
            {
                throw new Unsupported();
            }
        }

        private void ValueType()
        {
            byte type = Next();
            if (type is 0x63 or 0x64)
            {
                Signed();
            }
        }

        // A block type: its parameter and result counts, and its type index
        // or -1.
        private (int Parameters, int Results) BlockType()
        {
            byte first = code[position];
            if (first == 0x40)
            {
                position++;
                return (0, 0);
            }

            if ((first & 0x80) == 0 && first >= 0x40)
            {
                ValueType();
                return (0, 1);
            }

            var type = module.TypeAt((int)Signed());
            return (type.Parameters.Length, type.Results.Length);
        }

        // A memarg: the alignment, the memory's index where the
        // alignment's bit 6 says there is one, and the offset.
        private void MemArg()
        {
            uint align = U32();
            if ((align & 0x40) != 0)
            {
                U32();
            }

            U32();
        }

        private void Decode()
        {
            while (position < code.Length)
            {
                int start = position;
                var instruction = new Instruction { Start = start, Operand = -1, List = -1 };
                Read(ref instruction);
                instruction.End = position;
                instructions.Add(instruction);
            }
        }

        private void Plain(ref Instruction instruction, int pops, int pushes)
        {
            instruction.Kind = Kind.Plain;
            instruction.Pops = pops;
            instruction.Pushes = pushes;
        }

        private void Read(ref Instruction instruction)
        {
            byte opcode = Next();
            switch (opcode)
            {
                case 0x00 or 0x0f:
                    instruction.Kind = Kind.Return;
                    instruction.Pops = opcode == 0x0f ? -1 : 0;
                    return;
                case 0x01:
                    Plain(ref instruction, 0, 0);
                    return;
                case 0x02 or 0x03 or 0x04:
                {
                    var (parameters, results) = BlockType();
                    instruction.Kind = opcode switch { 0x02 => Kind.Block, 0x03 => Kind.Loop, _ => Kind.If };
                    instruction.Parameters = parameters;
                    instruction.Results = results;
                    return;
                }
                case 0x05:
                    instruction.Kind = Kind.Else;
                    return;
                case 0x08:
                    instruction.Kind = Kind.Throw;
                    instruction.Pops = module.TagParameters(Index());
                    return;
                case 0x0a:
                    instruction.Kind = Kind.Throw;
                    instruction.Pops = 1;
                    return;
                case 0x0b:
                    instruction.Kind = Kind.End;
                    return;
                case 0x0c:
                    instruction.Kind = Kind.Br;
                    instruction.Operand = Index();
                    return;
                case 0x0d:
                    instruction.Kind = Kind.BrIf;
                    instruction.Operand = Index();
                    return;
                case 0x0e:
                {
                    instruction.Kind = Kind.BrTable;
                    int labels = Index() + 1;
                    instruction.List = lists.Count;
                    instruction.Count = labels;
                    for (int label = 0; label < labels; label++)
                    {
                        lists.Add(Index());
                    }

                    return;
                }
                case 0x10:
                {
                    var type = module.FunctionAt(Index());
                    instruction.Kind = Kind.Call;
                    instruction.Pops = type.Parameters.Length;
                    instruction.Pushes = type.Results.Length;
                    return;
                }
                case 0x11:
                {
                    var type = module.TypeAt(Index());
                    Index();
                    instruction.Kind = Kind.Call;
                    instruction.Pops = type.Parameters.Length + 1;
                    instruction.Pushes = type.Results.Length;
                    return;
                }
                case 0x12:
                    instruction.Kind = Kind.Return;
                    instruction.Pops = module.FunctionAt(Index()).Parameters.Length;
                    return;
                case 0x13:
                    instruction.Kind = Kind.Return;
                    instruction.Pops = module.TypeAt(Index()).Parameters.Length + 1;
                    Index();
                    return;
                case 0x14:
                {
                    var type = module.TypeAt(Index());
                    instruction.Kind = Kind.Call;
                    instruction.Pops = type.Parameters.Length + 1;
                    instruction.Pushes = type.Results.Length;
                    return;
                }
                case 0x15:
                    instruction.Kind = Kind.Return;
                    instruction.Pops = module.TypeAt(Index()).Parameters.Length + 1;
                    return;
                case 0x1a:
                    instruction.Kind = Kind.Drop;
                    instruction.Pops = 1;
                    return;
                case 0x1b:
                    Plain(ref instruction, 3, 1);
                    return;
                case 0x1c:
                {
                    int types = Index();
                    for (int type = 0; type < types; type++)
                    {
                        ValueType();
                    }

                    Plain(ref instruction, 3, 1);
                    return;
                }
                case 0x1f:
                {
                    var (parameters, results) = BlockType();
                    instruction.Kind = Kind.TryTable;
                    instruction.Parameters = parameters;
                    instruction.Results = results;
                    int catches = Index();
                    instruction.List = lists.Count;
                    instruction.Count = catches;
                    for (int clause = 0; clause < catches; clause++)
                    {
                        byte kind = Next();
                        if (kind is 0x00 or 0x01)
                        {
                            Index();
                        }
                        else if (kind is not (0x02 or 0x03))
                        {
                            throw new Unsupported();
                        }

                        lists.Add(Index());
                    }

                    return;
                }
                case 0x20:
                    instruction.Kind = Kind.LocalGet;
                    instruction.Operand = Local();
                    instruction.Pushes = 1;
                    instruction.Pure = true;
                    return;
                case 0x21:
                    instruction.Kind = Kind.LocalSet;
                    instruction.Operand = Local();
                    instruction.Pops = 1;
                    return;
                case 0x22:
                    instruction.Kind = Kind.LocalTee;
                    instruction.Operand = Local();
                    instruction.Pops = 1;
                    instruction.Pushes = 1;
                    return;
                case 0x23:
                    Index();
                    Plain(ref instruction, 0, 1);
                    instruction.Pure = true;
                    return;
                case 0x24:
                    Index();
                    Plain(ref instruction, 1, 0);
                    return;
                case 0x25:
                    Index();
                    Plain(ref instruction, 1, 1);
                    return;
                case 0x26:
                    Index();
                    Plain(ref instruction, 2, 0);
                    return;
                case >= 0x28 and <= 0x35:
                    MemArg();
                    Plain(ref instruction, 1, 1);
                    return;
                case >= 0x36 and <= 0x3e:
                    MemArg();
                    Plain(ref instruction, 2, 0);
                    return;
                case 0x3f:
                    Index();
                    Plain(ref instruction, 0, 1);
                    return;
                case 0x40:
                    Index();
                    Plain(ref instruction, 1, 1);
                    return;
                case 0x41 or 0x42:
                    Signed();
                    Plain(ref instruction, 0, 1);
                    instruction.Pure = true;
                    return;
                case 0x43:
                    Skip(4);
                    Plain(ref instruction, 0, 1);
                    instruction.Pure = true;
                    return;
                case 0x44:
                    Skip(8);
                    Plain(ref instruction, 0, 1);
                    instruction.Pure = true;
                    return;
                case >= 0x45 and <= 0xc4:
                    Plain(ref instruction, NumericPops(opcode), 1);
                    return;
                case 0xd0:
                    Signed();
                    Plain(ref instruction, 0, 1);
                    instruction.Pure = true;
                    return;
                case 0xd1 or 0xd4:
                    Plain(ref instruction, 1, 1);
                    return;
                case 0xd2:
                    Index();
                    Plain(ref instruction, 0, 1);
                    instruction.Pure = true;
                    return;
                case 0xd3:
                    Plain(ref instruction, 2, 1);
                    return;
                case 0xd5 or 0xd6:
                    // The pops and pushes depend on the label's arity (Arity).
                    instruction.Kind = Kind.BrOn;
                    instruction.Operand = Index();
                    instruction.Pops = opcode;
                    return;
                case 0xfb:
                    ReadGc(ref instruction);
                    return;
                case 0xfc:
                    ReadMisc(ref instruction);
                    return;
                case 0xfd:
                    ReadSimd(ref instruction);
                    return;
                default:
                    throw new Unsupported();
            }
        }

        private int Local()
        {
            int local = Index();
            return local < count ? local : throw new Unsupported();
        }

        // The MVP's numeric instructions: comparisons and binary operators
        // pop two values, tests, unary operators and conversions one.
        private static int NumericPops(byte opcode) => opcode switch
        {
            0x45 or 0x50 => 1,
            >= 0x46 and <= 0x66 => 2,
            >= 0x67 and <= 0x69 => 1,
            >= 0x6a and <= 0x78 => 2,
            >= 0x79 and <= 0x7b => 1,
            >= 0x7c and <= 0x8a => 2,
            >= 0x8b and <= 0x91 => 1,
            >= 0x92 and <= 0x98 => 2,
            >= 0x99 and <= 0x9f => 1,
            >= 0xa0 and <= 0xa6 => 2,
            _ => 1,
        };

        private void ReadGc(ref Instruction instruction)
        {
            uint opcode = U32();
            switch (opcode)
            {
                case 0:
                    Plain(ref instruction, module.Fields(Index()), 1);
                    return;
                case 1:
                    Index();
                    Plain(ref instruction, 0, 1);
                    return;
                case 2 or 3 or 4:
                    Index();
                    Index();
                    Plain(ref instruction, 1, 1);
                    return;
                case 5:
                    Index();
                    Index();
                    Plain(ref instruction, 2, 0);
                    return;
                case 6:
                    Index();
                    Plain(ref instruction, 2, 1);
                    return;
                case 7:
                    Index();
                    Plain(ref instruction, 1, 1);
                    return;
                case 8:
                    Index();
                    Plain(ref instruction, Index(), 1);
                    return;
                case 9 or 10:
                    Index();
                    Index();
                    Plain(ref instruction, 2, 1);
                    return;
                case 11 or 12 or 13:
                    Index();
                    Plain(ref instruction, 2, 1);
                    return;
                case 14:
                    Index();
                    Plain(ref instruction, 3, 0);
                    return;
                case 15:
                    Plain(ref instruction, 1, 1);
                    return;
                case 16:
                    Index();
                    Plain(ref instruction, 4, 0);
                    return;
                case 17:
                    Index();
                    Index();
                    Plain(ref instruction, 5, 0);
                    return;
                case 18 or 19:
                    Index();
                    Index();
                    Plain(ref instruction, 4, 0);
                    return;
                case 20 or 21 or 22 or 23:
                    Signed();
                    Plain(ref instruction, 1, 1);
                    return;
                case 24 or 25:
                    Next();
                    instruction.Kind = Kind.BrOn;
                    instruction.Operand = Index();
                    instruction.Pops = 0xfb;
                    Signed();
                    Signed();
                    return;
                case >= 26 and <= 30:
                    Plain(ref instruction, 1, 1);
                    return;
                default:
                    throw new Unsupported();
            }
        }

        private void ReadMisc(ref Instruction instruction)
        {
            uint opcode = U32();
            switch (opcode)
            {
                case <= 7:
                    Plain(ref instruction, 1, 1);
                    return;
                case 8 or 12:
                    Index();
                    Index();
                    Plain(ref instruction, 3, 0);
                    return;
                case 9 or 13:
                    Index();
                    Plain(ref instruction, 0, 0);
                    return;
                case 10 or 14:
                    Index();
                    Index();
                    Plain(ref instruction, 3, 0);
                    return;
                case 11 or 17:
                    Index();
                    Plain(ref instruction, 3, 0);
                    return;
                case 15:
                    Index();
                    Plain(ref instruction, 2, 1);
                    return;
                case 16:
                    Index();
                    Plain(ref instruction, 0, 1);
                    return;
                default:
                    throw new Unsupported();
            }
        }

        private void ReadSimd(ref Instruction instruction)
        {
            uint opcode = U32();
            switch (opcode)
            {
                case <= 10 or 92 or 93:
                    MemArg();
                    Plain(ref instruction, 1, 1);
                    return;
                case 11:
                    MemArg();
                    Plain(ref instruction, 2, 0);
                    return;
                case 12:
                    Skip(16);
                    Plain(ref instruction, 0, 1);
                    instruction.Pure = true;
                    return;
                case 13:
                    Skip(16);
                    Plain(ref instruction, 2, 1);
                    return;
                case >= 21 and <= 34:
                    Skip(1);
                    Plain(ref instruction, opcode is 23 or 26 or 28 or 30 or 32 or 34 ? 2 : 1, 1);
                    return;
                case >= 84 and <= 87:
                    MemArg();
                    Skip(1);
                    Plain(ref instruction, 2, 1);
                    return;
                case >= 88 and <= 91:
                    MemArg();
                    Skip(1);
                    Plain(ref instruction, 2, 0);
                    return;
                case > 275:
                    throw new Unsupported();
                default:
                    Plain(ref instruction, SimdPops(opcode), 1);
                    return;
            }
        }

        // The operands of SIMD's instructions without immediates: unary
        // operators, tests and conversions take one, bitselect and the
        // relaxed fused and lane-select operators three, the rest two.
        private static int SimdPops(uint opcode) => opcode switch
        {
            >= 15 and <= 20 => 1,
            77 or 83 or 94 or 95 => 1,
            82 => 3,
            96 or 97 or 98 or 99 or 100 => 1,
            103 or 104 or 105 or 106 => 1,
            116 or 117 or 122 => 1,
            >= 124 and <= 129 => 1,
            131 or 132 => 1,
            >= 135 and <= 138 => 1,
            148 => 1,
            160 or 161 or 163 or 164 => 1,
            >= 167 and <= 170 => 1,
            192 or 193 or 195 or 196 => 1,
            >= 199 and <= 202 => 1,
            224 or 225 or 227 => 1,
            236 or 237 or 239 => 1,
            >= 248 and <= 255 => 1,
            >= 257 and <= 260 => 1,
            >= 261 and <= 268 => 3,
            275 => 3,
            _ => 2,
        };

        // MARK: Structure

        private void Structure()
        {
            int total = instructions.Count;
            endOf = new int[total];
            elseOf = new int[total];
            parent = new int[total];
            Array.Fill(endOf, -1);
            Array.Fill(elseOf, -1);
            var open = new Stack<int>();
            for (int index = 0; index < total; index++)
            {
                parent[index] = open.Count == 0 ? -1 : open.Peek();
                switch (instructions[index].Kind)
                {
                    case Kind.Block or Kind.Loop or Kind.If or Kind.TryTable:
                        open.Push(index);
                        break;
                    case Kind.Else:
                        if (open.Count == 0 || instructions[open.Peek()].Kind != Kind.If)
                        {
                            throw new Unsupported();
                        }

                        elseOf[open.Peek()] = index;
                        break;
                    case Kind.End:
                        if (open.Count == 0)
                        {
                            if (index != total - 1)
                            {
                                throw new Unsupported();
                            }

                            break;
                        }

                        int block = open.Pop();
                        endOf[block] = index;
                        parent[index] = block;
                        break;
                }
            }

            if (open.Count != 0 || total == 0 || instructions[^1].Kind != Kind.End)
            {
                throw new Unsupported();
            }
        }

        // The block instruction a label names from inside `block` (-1 for
        // the body), its arity and where a branch to it goes (-1: out of the
        // function).
        private int LabelBlock(int block, int label)
        {
            for (; label > 0; label--)
            {
                if (block < 0)
                {
                    throw new Unsupported();
                }

                block = parent[block];
            }

            return block;
        }

        private int Arity(int block) => block < 0 ? results
            : instructions[block].Kind == Kind.Loop ? instructions[block].Parameters
            : instructions[block].Results;

        private int Target(int block) => block < 0 ? -1
            : instructions[block].Kind == Kind.Loop ? block + 1
            : endOf[block];

        // The labels an instruction inside `block` may go to on an
        // exception: every catch clause's, of every try_table around it.
        private IEnumerable<int> CatchBlocks(int block)
        {
            for (int around = block; around >= 0; around = parent[around])
            {
                var instruction = instructions[around];
                if (instruction.Kind != Kind.TryTable)
                {
                    continue;
                }

                for (int clause = 0; clause < instruction.Count; clause++)
                {
                    yield return LabelBlock(parent[around], lists[instruction.List + clause]);
                }
            }
        }

        // MARK: Liveness

        // Where each instruction may go next, by instruction index (-1: out
        // of the function), besides falling through when it can.
        private void Successors(int index, List<int> targets, out bool fallsThrough)
        {
            var instruction = instructions[index];
            int block = parent[index];
            fallsThrough = true;
            switch (instruction.Kind)
            {
                case Kind.If:
                    targets.Add(elseOf[index] >= 0 ? elseOf[index] + 1 : endOf[index]);
                    break;
                case Kind.Else:
                    targets.Add(endOf[parent[index]]);
                    fallsThrough = false;
                    break;
                case Kind.End:
                    fallsThrough = index != instructions.Count - 1;
                    break;
                case Kind.Br:
                    targets.Add(Target(LabelBlock(block, instruction.Operand)));
                    fallsThrough = false;
                    break;
                case Kind.BrIf or Kind.BrOn:
                    targets.Add(Target(LabelBlock(block, instruction.Operand)));
                    break;
                case Kind.BrTable:
                    for (int label = 0; label < instruction.Count; label++)
                    {
                        targets.Add(Target(LabelBlock(block, lists[instruction.List + label])));
                    }

                    fallsThrough = false;
                    break;
                case Kind.Return:
                    fallsThrough = false;
                    break;
                case Kind.Throw:
                    foreach (int handler in CatchBlocks(block))
                    {
                        targets.Add(Target(handler));
                    }

                    fallsThrough = false;
                    break;
                case Kind.Call:
                    foreach (int handler in CatchBlocks(block))
                    {
                        targets.Add(Target(handler));
                    }

                    break;
            }
        }

        private void Liveness()
        {
            int total = instructions.Count;
            blockOf = new int[total];
            var leaders = new bool[total + 1];
            leaders[0] = true;
            var targets = new List<int>();
            var edges = new List<(int From, List<int> To, bool FallsThrough)>();
            var hasEdge = new bool[total];
            for (int index = 0; index < total; index++)
            {
                targets.Clear();
                Successors(index, targets, out bool fallsThrough);
                var kind = instructions[index].Kind;
                if (targets.Count != 0 || !fallsThrough || kind is Kind.Block or Kind.Loop or Kind.If or Kind.TryTable or Kind.Else or Kind.End)
                {
                    leaders[index + 1] = true;
                    foreach (int target in targets)
                    {
                        if (target >= 0)
                        {
                            leaders[target] = true;
                        }
                    }

                    edges.Add((index, [.. targets], fallsThrough));
                    hasEdge[index] = true;
                }
            }

            var starts = new List<int>();
            for (int index = 0; index < total; index++)
            {
                if (leaders[index])
                {
                    starts.Add(index);
                }

                blockOf[index] = starts.Count - 1;
            }

            blockStart = [.. starts];
            int blocks = blockStart.Length;
            successors = new List<int>[blocks];
            for (int block = 0; block < blocks; block++)
            {
                successors[block] = [];
            }

            foreach (var (from, to, fallsThrough) in edges)
            {
                var list = successors[blockOf[from]];
                foreach (int target in to)
                {
                    if (target >= 0 && !list.Contains(blockOf[target]))
                    {
                        list.Add(blockOf[target]);
                    }
                }

                if (fallsThrough && from + 1 < total && !list.Contains(blockOf[from + 1]))
                {
                    list.Add(blockOf[from + 1]);
                }
            }

            // Blocks ending without an edge of their own fall through.
            for (int block = 0; block + 1 < blocks; block++)
            {
                int last = blockStart[block + 1] - 1;
                if (!hasEdge[last] && !successors[block].Contains(block + 1))
                {
                    successors[block].Add(block + 1);
                }
            }

            var use = new ulong[blocks][];
            var def = new ulong[blocks][];
            for (int block = 0; block < blocks; block++)
            {
                use[block] = new ulong[words];
                def[block] = new ulong[words];
                int end = block + 1 < blocks ? blockStart[block + 1] : total;
                for (int index = blockStart[block]; index < end; index++)
                {
                    var instruction = instructions[index];
                    int local = instruction.Operand;
                    switch (instruction.Kind)
                    {
                        case Kind.LocalGet when !Has(def[block], local):
                            Add(use[block], local);
                            break;
                        case Kind.LocalSet or Kind.LocalTee:
                            Add(def[block], local);
                            break;
                    }
                }
            }

            liveIn = new ulong[blocks][];
            liveOut = new ulong[blocks][];
            for (int block = 0; block < blocks; block++)
            {
                liveIn[block] = (ulong[])use[block].Clone();
                liveOut[block] = new ulong[words];
            }

            bool changed = true;
            while (changed)
            {
                changed = false;
                for (int block = blocks - 1; block >= 0; block--)
                {
                    var outSet = liveOut[block];
                    foreach (int successor in successors[block])
                    {
                        var inSet = liveIn[successor];
                        for (int word = 0; word < words; word++)
                        {
                            outSet[word] |= inSet[word];
                        }
                    }

                    var live = liveIn[block];
                    for (int word = 0; word < words; word++)
                    {
                        ulong next = use[block][word] | (outSet[word] & ~def[block][word]);
                        if (next != live[word])
                        {
                            live[word] = next;
                            changed = true;
                        }
                    }
                }
            }
        }

        private static bool Has(ulong[] set, int local) => (set[local >> 6] & (1UL << local)) != 0;

        private static void Add(ulong[] set, int local) => set[local >> 6] |= 1UL << local;

        // Whether a local's value may be read after instruction `index`.
        private bool LiveAfter(int index, int local)
        {
            int block = blockOf[index];
            int end = block + 1 < blockStart.Length ? blockStart[block + 1] : instructions.Count;
            for (int next = index + 1; next < end; next++)
            {
                var instruction = instructions[next];
                if (instruction.Operand == local)
                {
                    switch (instruction.Kind)
                    {
                        case Kind.LocalGet:
                            return true;
                        case Kind.LocalSet or Kind.LocalTee:
                            return false;
                    }
                }
            }

            return Has(liveOut[block], local);
        }

        // Whether a local's value may be read where a branch to `target`
        // (an instruction index, or -1 out of the function) goes.
        private bool LiveAt(int target, int local) => target >= 0 && Has(liveIn[blockOf[target]], local);

        // MARK: Stackification

        private enum Edit : byte
        {
            Keep,
            Delete,
            Drop,
        }

        // A value on a block's stack: an operand, or (Set >= 0) one a
        // local.set took that may stay where it is.
        private record struct Entry(int Set, int Local);

        private sealed class Frame(int block, bool reachable)
        {
            public int Block { get; } = block;

            public bool Reachable { get; set; } = reachable;

            public bool EntryReachable { get; } = reachable;

            public List<Entry> Stack { get; } = [];
        }

        private Edit[] edits = [];
        private readonly List<Frame> frames = [];
        // The set whose value may stay on the stack, by local (-1: none),
        // and the frame depth it is in.
        private int[] pendingSet = [];
        private int[] pendingDepth = [];
        private readonly List<int> pending = [];

        private void Invalidate(int local)
        {
            int depth = pendingDepth[local];
            var stack = frames[depth].Stack;
            for (int index = stack.Count - 1; index >= 0; index--)
            {
                if (stack[index].Set == pendingSet[local])
                {
                    stack.RemoveAt(index);
                    break;
                }
            }

            pendingSet[local] = -1;
            pending.Remove(local);
        }

        private void Pop(Frame frame, int values)
        {
            var stack = frame.Stack;
            while (values > 0)
            {
                if (stack.Count == 0)
                {
                    throw new Unsupported();
                }

                var top = stack[^1];
                if (top.Set >= 0)
                {
                    Invalidate(top.Local);
                    continue;
                }

                stack.RemoveAt(stack.Count - 1);
                values--;
            }
        }

        private static void Push(Frame frame, int values)
        {
            for (int value = 0; value < values; value++)
            {
                frame.Stack.Add(new(-1, -1));
            }
        }

        // Nothing after an unconditional branch runs until its block ends.
        private void Unreachable(Frame frame)
        {
            EndFrame(frame);
            frame.Stack.Clear();
            frame.Reachable = false;
        }

        // A branch from the current frame to `target`, or an exception to
        // it: a value left for a later read cannot stay on the stack when
        // the branch leaves its range and the target may read its local.
        private void Leaves(int targetBlock)
        {
            int targetDepth = DepthOf(targetBlock);
            int target = Target(targetBlock);
            for (int index = pending.Count - 1; index >= 0; index--)
            {
                int local = pending[index];
                if (targetDepth <= pendingDepth[local] && LiveAt(target, local))
                {
                    Invalidate(local);
                }
            }
        }

        private int DepthOf(int block)
        {
            if (block < 0)
            {
                return 0;
            }

            for (int depth = frames.Count - 1; depth > 0; depth--)
            {
                if (frames[depth].Block == block)
                {
                    return depth;
                }
            }

            throw new Unsupported();
        }

        // One round of rewriting; the new code, or null when nothing changed.
        public byte[]? Stackify()
        {
            Liveness();
            int total = instructions.Count;
            edits = new Edit[total];
            pendingSet = new int[count];
            pendingDepth = new int[count];
            Array.Fill(pendingSet, -1);
            frames.Clear();
            frames.Add(new Frame(-1, true));
            bool changed = false;
            for (int index = 0; index < total; index++)
            {
                var instruction = instructions[index];
                var frame = frames[^1];
                int depth = frames.Count - 1;
                if (!frame.Reachable)
                {
                    // Code no branch reaches: deleted, but for what closes
                    // the block.
                    switch (instruction.Kind)
                    {
                        case Kind.Block or Kind.Loop or Kind.If or Kind.TryTable:
                            frames.Add(new Frame(index, false));
                            edits[index] = Edit.Delete;
                            changed = true;
                            continue;
                        case Kind.Else:
                            if (!frame.EntryReachable)
                            {
                                edits[index] = Edit.Delete;
                            }

                            frame.Stack.Clear();
                            Push(frame, instructions[frame.Block].Parameters);
                            frame.Reachable = frame.EntryReachable;
                            continue;
                        case Kind.End:
                            if (frame.Block >= 0 && !frame.EntryReachable)
                            {
                                edits[index] = Edit.Delete;
                            }

                            break;
                        default:
                            edits[index] = Edit.Delete;
                            changed = true;
                            if (instruction.Kind is Kind.LocalGet or Kind.LocalSet or Kind.LocalTee && pendingSet[instruction.Operand] >= 0)
                            {
                                Invalidate(instruction.Operand);
                            }

                            continue;
                    }
                }

                switch (instruction.Kind)
                {
                    case Kind.Plain:
                        Pop(frame, instruction.Pops);
                        Push(frame, instruction.Pushes);
                        break;
                    case Kind.Call:
                        Pop(frame, instruction.Pops);
                        foreach (int handler in CatchBlocks(frame.Block))
                        {
                            Leaves(handler);
                        }

                        Push(frame, instruction.Pushes);
                        break;
                    case Kind.Drop:
                        Pop(frame, 1);
                        break;
                    case Kind.Block or Kind.Loop or Kind.If or Kind.TryTable:
                    {
                        Pop(frame, instruction.Parameters + (instruction.Kind == Kind.If ? 1 : 0));
                        var inner = new Frame(index, frame.Reachable);
                        Push(inner, instruction.Parameters);
                        frames.Add(inner);
                        break;
                    }
                    case Kind.Else:
                        EndFrame(frame);
                        if (frame.Reachable && frame.Stack.Count != instructions[frame.Block].Results)
                        {
                            throw new Unsupported();
                        }

                        frame.Stack.Clear();
                        Push(frame, instructions[frame.Block].Parameters);
                        frame.Reachable = frame.EntryReachable;
                        break;
                    case Kind.End:
                        EndFrame(frame);
                        if (frame.Reachable && frame.Stack.Count != (frame.Block < 0 ? results : instructions[frame.Block].Results))
                        {
                            throw new Unsupported();
                        }

                        if (frame.Block >= 0)
                        {
                            frames.RemoveAt(frames.Count - 1);
                            Push(frames[^1], instructions[frame.Block].Results);
                        }

                        break;
                    case Kind.Br:
                    {
                        int target = LabelBlock(frame.Block, instruction.Operand);
                        Pop(frame, Arity(target));
                        Leaves(target);
                        Unreachable(frame);
                        break;
                    }
                    case Kind.BrIf:
                    {
                        int target = LabelBlock(frame.Block, instruction.Operand);
                        Pop(frame, Arity(target) + 1);
                        Leaves(target);
                        Push(frame, Arity(target));
                        break;
                    }
                    case Kind.BrOn:
                    {
                        int target = LabelBlock(frame.Block, instruction.Operand);
                        int arity = Arity(target);
                        // br_on_null keeps the reference (non-null) when it
                        // does not branch, br_on_non_null drops it, and the
                        // casts keep it.
                        (int pops, int pushes) = instruction.Pops switch
                        {
                            0xd5 => (arity + 1, arity + 1),
                            0xd6 => (arity, arity - 1),
                            _ => (arity, arity),
                        };
                        Pop(frame, pops);
                        Leaves(target);
                        Push(frame, pushes);
                        break;
                    }
                    case Kind.BrTable:
                    {
                        int first = LabelBlock(frame.Block, lists[instruction.List]);
                        Pop(frame, Arity(first) + 1);
                        for (int label = 0; label < instruction.Count; label++)
                        {
                            Leaves(LabelBlock(frame.Block, lists[instruction.List + label]));
                        }

                        Unreachable(frame);
                        break;
                    }
                    case Kind.Return:
                        Pop(frame, instruction.Pops < 0 ? results : instruction.Pops);
                        Unreachable(frame);
                        break;
                    case Kind.Throw:
                        Pop(frame, instruction.Pops);
                        foreach (int handler in CatchBlocks(frame.Block))
                        {
                            Leaves(handler);
                        }

                        Unreachable(frame);
                        break;
                    case Kind.LocalGet:
                    {
                        int local = instruction.Operand;
                        if (pendingSet[local] >= 0)
                        {
                            if (pendingDepth[local] == depth && OnTop(frame, local) && !LiveAfter(index, local))
                            {
                                // The value is where this read would put it.
                                edits[pendingSet[local]] = Edit.Delete;
                                edits[index] = Edit.Delete;
                                changed = true;
                                int at = frame.Stack.FindLastIndex(entry => entry.Set == pendingSet[local]);
                                frame.Stack[at] = new(-1, -1);
                                pendingSet[local] = -1;
                                pending.Remove(local);
                                break;
                            }

                            Invalidate(local);
                        }

                        Push(frame, 1);
                        break;
                    }
                    case Kind.LocalSet:
                    {
                        int local = instruction.Operand;
                        Pop(frame, 1);
                        if (pendingSet[local] >= 0)
                        {
                            Invalidate(local);
                        }

                        if (Fixed(local))
                        {
                            break;
                        }

                        if (!LiveAfter(index, local))
                        {
                            edits[index] = Edit.Drop;
                            changed = true;
                            break;
                        }

                        frame.Stack.Add(new(index, local));
                        pendingSet[local] = index;
                        pendingDepth[local] = depth;
                        pending.Add(local);
                        break;
                    }
                    case Kind.LocalTee:
                    {
                        int local = instruction.Operand;
                        Pop(frame, 1);
                        if (pendingSet[local] >= 0)
                        {
                            Invalidate(local);
                        }

                        if (!Fixed(local) && !LiveAfter(index, local))
                        {
                            edits[index] = Edit.Delete;
                            changed = true;
                        }

                        Push(frame, 1);
                        break;
                    }
                }
            }

            bool peephole = false;
            var rewritten = Encode(ref peephole);
            return changed || peephole ? rewritten : null;
        }

        // Whether nothing but values that may stay in locals is above the
        // pending value of `local`.
        private bool OnTop(Frame frame, int local)
        {
            for (int index = frame.Stack.Count - 1; index >= 0; index--)
            {
                var entry = frame.Stack[index];
                if (entry.Set == pendingSet[local])
                {
                    return true;
                }

                if (entry.Set < 0)
                {
                    return false;
                }
            }

            return false;
        }

        // A block's end (or an if's else): what may stay on its stack cannot.
        private void EndFrame(Frame frame)
        {
            foreach (var entry in frame.Stack.Where(entry => entry.Set >= 0).ToList())
            {
                Invalidate(entry.Local);
            }
        }

        // The body with the round's edits, and the peepholes that follow
        // from them: a constant or a read dropped at once is neither, and
        // `local.tee x; drop` is `local.set x`.
        private byte[] Encode(ref bool peephole)
        {
            var writer = new MemoryStream(code.Length);
            var pure = new Stack<long>();
            long teeAt = -1;
            long setAt = -1;
            int setLocal = -1;
            for (int index = 0; index < instructions.Count; index++)
            {
                var instruction = instructions[index];
                var edit = edits[index];
                if (edit == Edit.Delete)
                {
                    continue;
                }

                bool drop = edit == Edit.Drop || instruction.Kind == Kind.Drop;
                if (drop && pure.Count != 0)
                {
                    writer.SetLength(pure.Pop());
                    teeAt = -1;
                    peephole = true;
                    continue;
                }

                if (drop && teeAt >= 0)
                {
                    writer.GetBuffer()[teeAt] = 0x21;
                    teeAt = -1;
                    peephole = true;
                    continue;
                }

                if (!drop && instruction.Kind == Kind.LocalGet && setAt >= 0 && setLocal == instruction.Operand)
                {
                    writer.GetBuffer()[setAt] = 0x22;
                    teeAt = setAt;
                    setAt = -1;
                    pure.Clear();
                    peephole = true;
                    continue;
                }

                long start = writer.Length;
                setAt = !drop && instruction.Kind == Kind.LocalSet ? start : -1;
                setLocal = instruction.Operand;
                if (drop)
                {
                    writer.WriteByte(0x1a);
                }
                else if (replacements.TryGetValue(index, out var replacement))
                {
                    writer.Write(replacement);
                }
                else
                {
                    writer.Write(code, instruction.Start, instruction.End - instruction.Start);
                }

                teeAt = !drop && instruction.Kind == Kind.LocalTee ? start : -1;
                if (!drop && instruction.Pure)
                {
                    pure.Push(start);
                }
                else
                {
                    pure.Clear();
                }
            }

            return writer.ToArray();
        }

        private readonly Dictionary<int, byte[]> replacements = [];

        // Whether control may continue after instruction `index`.
        private bool Completes(int index)
        {
            var instruction = instructions[index];
            switch (instruction.Kind)
            {
                case Kind.Br or Kind.BrTable or Kind.Return or Kind.Throw:
                    return false;
                case Kind.End when parent[index] >= 0:
                {
                    int block = parent[index];
                    if (Targeted(block) || index - 1 == block || Completes(index - 1))
                    {
                        return true;
                    }

                    return instructions[block].Kind == Kind.If
                        && (elseOf[block] < 0 || elseOf[block] - 1 == block || Completes(elseOf[block] - 1));
                }
                default:
                    return true;
            }
        }

        private bool[]? targeted;

        // Whether a branch or catch clause goes to the end of a block.
        private bool Targeted(int block)
        {
            if (targeted is null)
            {
                targeted = new bool[instructions.Count];
                for (int index = 0; index < instructions.Count; index++)
                {
                    var instruction = instructions[index];
                    switch (instruction.Kind)
                    {
                        case Kind.Br or Kind.BrIf or Kind.BrOn:
                            Mark(LabelBlock(parent[index], instruction.Operand));
                            break;
                        case Kind.BrTable or Kind.TryTable:
                            for (int label = 0; label < instruction.Count; label++)
                            {
                                Mark(LabelBlock(parent[index], lists[instruction.List + label]));
                            }

                            break;
                    }
                }
            }

            return targeted[block];

            void Mark(int target)
            {
                if (target >= 0)
                {
                    targeted![target] = true;
                }
            }
        }
        // Blocks that carry their value where a local does: a block or an
        // if/else every branch to which is `local.set x; br`, whose ends
        // (and an if's else) are `local.set x` or follow an unconditional
        // branch, followed (after anything that leaves the stack as it finds
        // it and reads no local: the epilogue restoring the call depth) by
        // `local.get x` of a value nothing reads afterwards. The block then
        // has x's type as its result, and the local is not written or read:
        // the IL's merge slots (`c ? a : b`) and the body's result.
        public byte[]? CarryResults()
        {
            Liveness();
            int total = instructions.Count;
            edits = new Edit[total];
            bool changed = false;
            for (int block = 0; block < total; block++)
            {
                var opening = instructions[block];
                if (opening.Kind is not (Kind.Block or Kind.If) || opening.Parameters != 0 || opening.Results != 0
                    || (opening.Kind == Kind.If && elseOf[block] < 0))
                {
                    continue;
                }

                int close = endOf[block];
                int read = close + 1;
                int height = 0;
                for (; read < total && instructions[read].Kind == Kind.Plain; read++)
                {
                    height -= instructions[read].Pops;
                    if (height < 0)
                    {
                        break;
                    }

                    height += instructions[read].Pushes;
                }

                if (height != 0 || read >= total || instructions[read].Kind != Kind.LocalGet)
                {
                    continue;
                }

                int local = instructions[read].Operand;
                if (Fixed(local) || edits[read] != Edit.Keep || LiveAfter(read, local))
                {
                    continue;
                }

                var sets = new List<int>();
                var closings = new List<int>();
                // A block end or else no value falls into: nothing runs
                // before it, or only blocks whose ends nothing reaches, in
                // which case validation needs an `unreachable` there.
                bool Ends(int at)
                {
                    if (instructions[at - 1].Kind == Kind.LocalSet && instructions[at - 1].Operand == local)
                    {
                        sets.Add(at - 1);
                        return true;
                    }

                    if (at - 1 == block || Completes(at - 1))
                    {
                        return false;
                    }

                    if (instructions[at - 1].Kind is not (Kind.Br or Kind.BrTable or Kind.Return or Kind.Throw))
                    {
                        closings.Add(at);
                    }

                    return true;
                }

                bool Add(int set)
                {
                    sets.Add(set);
                    return true;
                }

                bool carried = Ends(close) && (opening.Kind != Kind.If || Ends(elseOf[block]));
                for (int index = block + 1; carried && index < close; index++)
                {
                    var instruction = instructions[index];
                    switch (instruction.Kind)
                    {
                        case Kind.Br when LabelBlock(parent[index], instruction.Operand) == block:
                            carried = instructions[index - 1].Kind == Kind.LocalSet
                                && instructions[index - 1].Operand == local && Add(index - 1);
                            break;
                        case Kind.BrIf or Kind.BrOn when LabelBlock(parent[index], instruction.Operand) == block:
                            carried = false;
                            break;
                        case Kind.BrTable or Kind.TryTable:
                            for (int label = 0; label < instruction.Count; label++)
                            {
                                int target = instruction.Kind == Kind.TryTable ? parent[index] : parent[index];
                                carried &= LabelBlock(target, lists[instruction.List + label]) != block;
                            }

                            break;
                    }
                }

                if (!carried || sets.Count == 0 || sets.Exists(set => edits[set] != Edit.Keep)
                    || closings.Exists(replacements.ContainsKey))
                {
                    continue;
                }

                foreach (int set in sets)
                {
                    edits[set] = Edit.Delete;
                }

                foreach (int closing in closings)
                {
                    replacements[closing] = [0x00, code[instructions[closing].Start]];
                }

                edits[read] = Edit.Delete;
                var type = new WasmWriter();
                type.Byte(code[opening.Start]);
                TypeOf(local).Write(type);
                replacements[block] = type.ToArray();
                changed = true;
            }

            if (!changed)
            {
                return null;
            }

            bool peephole = false;
            return Encode(ref peephole);
        }

        // MARK: Packing

        // Constants in place of their locals, then locals that are never live
        // at once merged, numbered by use and grouped by type.
        public (byte[] Code, WType[] Locals) Pack()
        {
            Liveness();
            int total = instructions.Count;

            // Each local's uses, and its only write when it has one.
            var uses = new int[count];
            var writes = new int[count];
            var written = new int[count];
            Array.Fill(written, -1);
            for (int index = 0; index < total; index++)
            {
                var instruction = instructions[index];
                switch (instruction.Kind)
                {
                    case Kind.LocalGet:
                        uses[instruction.Operand]++;
                        break;
                    case Kind.LocalSet or Kind.LocalTee:
                        writes[instruction.Operand]++;
                        written[instruction.Operand] = index;
                        break;
                }
            }

            // A local written once, with a constant, and never read before:
            // each read may be the constant instead.
            var constant = new int[count];
            Array.Fill(constant, -1);
            var remove = new bool[total];
            for (int local = parameters.Length; local < count; local++)
            {
                int write = written[local];
                if (writes[local] != 1 || uses[local] == 0 || Fixed(local) || Has(liveIn[0], local)
                    || write == 0 || !instructions[write - 1].Pure || instructions[write - 1].Kind == Kind.LocalGet
                    || code[instructions[write - 1].Start] is 0x23 or 0xd2)
                {
                    continue;
                }

                var value = instructions[write - 1];
                int size = value.End - value.Start;
                int getSize = LebSize(local) + 1;
                bool tee = instructions[write].Kind == Kind.LocalTee;
                int before = (tee ? 0 : size) + getSize + uses[local] * getSize;
                if (uses[local] * size <= before)
                {
                    constant[local] = write - 1;
                    remove[write] = true;
                    if (!tee)
                    {
                        remove[write - 1] = true;
                    }
                }
            }

            // Interference: a local written while another is live cannot
            // share its storage, nor a parameter a local read before any
            // write (which holds the default).
            var interferes = new ulong[count][];
            for (int local = 0; local < count; local++)
            {
                interferes[local] = new ulong[words];
            }

            var live = new ulong[words];
            for (int block = 0; block < blockStart.Length; block++)
            {
                Array.Copy(liveOut[block], live, words);
                int end = block + 1 < blockStart.Length ? blockStart[block + 1] : total;
                for (int index = end - 1; index >= blockStart[block]; index--)
                {
                    var instruction = instructions[index];
                    int local = instruction.Operand;
                    switch (instruction.Kind)
                    {
                        case Kind.LocalSet or Kind.LocalTee when !remove[index]:
                        {
                            // A copy does not make its source interfere
                            // (Chaitin's rule): sharing, it is no copy.
                            int source = index > 0 && instructions[index - 1].Kind == Kind.LocalGet
                                && constant[instructions[index - 1].Operand] < 0
                                    ? instructions[index - 1].Operand
                                    : -1;
                            for (int word = 0; word < words; word++)
                            {
                                ulong except = source >= 0 && source >> 6 == word ? 1UL << source : 0;
                                interferes[local][word] |= live[word] & ~except;
                            }

                            live[local >> 6] &= ~(1UL << local);
                            break;
                        }
                        case Kind.LocalGet when constant[local] < 0:
                            Add(live, local);
                            break;
                    }
                }
            }

            for (int local = 0; local < count; local++)
            {
                for (int other = 0; other < count; other++)
                {
                    if (Has(interferes[local], other))
                    {
                        Add(interferes[other], local);
                    }
                }
            }

            for (int local = parameters.Length; local < count; local++)
            {
                if (Has(liveIn[0], local))
                {
                    for (int parameter = 0; parameter < parameters.Length; parameter++)
                    {
                        Add(interferes[local], parameter);
                        Add(interferes[parameter], local);
                    }
                }
            }

            // Slots: the parameters, then merged locals, in order of first
            // appearance.
            var slotOf = new int[count];
            Array.Fill(slotOf, -1);
            var slotTypes = new List<WType>();
            var slotMembers = new List<ulong[]>();
            for (int parameter = 0; parameter < parameters.Length; parameter++)
            {
                slotOf[parameter] = parameter;
                slotTypes.Add(parameters[parameter]);
                var members = new ulong[words];
                Add(members, parameter);
                slotMembers.Add(members);
            }

            for (int index = 0; index < total; index++)
            {
                var instruction = instructions[index];
                if (instruction.Kind is not (Kind.LocalGet or Kind.LocalSet or Kind.LocalTee) || remove[index])
                {
                    continue;
                }

                int local = instruction.Operand;
                if (slotOf[local] >= 0 || (instruction.Kind == Kind.LocalGet && constant[local] >= 0))
                {
                    continue;
                }

                var type = TypeOf(local);
                int chosen = -1;
                if (!Fixed(local))
                {
                    for (int slot = 0; slot < slotTypes.Count && chosen < 0; slot++)
                    {
                        if (slotTypes[slot] != type || (slot >= parameters.Length && Fixed(FirstMember(slotMembers[slot]))))
                        {
                            continue;
                        }

                        bool free = true;
                        for (int word = 0; word < words && free; word++)
                        {
                            free = (slotMembers[slot][word] & interferes[local][word]) == 0;
                        }

                        if (free)
                        {
                            chosen = slot;
                        }
                    }
                }

                if (chosen < 0)
                {
                    chosen = slotTypes.Count;
                    slotTypes.Add(type);
                    slotMembers.Add(new ulong[words]);
                }

                slotOf[local] = chosen;
                Add(slotMembers[chosen], local);
            }

            // The locals' order: by type, the type used most first, and in
            // a type the local used most first, so that most indices take a
            // byte.
            var slotUses = new int[slotTypes.Count];
            for (int index = 0; index < total; index++)
            {
                var instruction = instructions[index];
                if (instruction.Kind is Kind.LocalGet or Kind.LocalSet or Kind.LocalTee && !remove[index]
                    && !(instruction.Kind == Kind.LocalGet && constant[instruction.Operand] >= 0))
                {
                    slotUses[slotOf[instruction.Operand]]++;
                }
            }

            var typeUses = new Dictionary<WType, int>();
            var typeFirst = new Dictionary<WType, int>();
            for (int slot = parameters.Length; slot < slotTypes.Count; slot++)
            {
                typeUses[slotTypes[slot]] = typeUses.GetValueOrDefault(slotTypes[slot]) + slotUses[slot];
                typeFirst.TryAdd(slotTypes[slot], slot);
            }

            var order = Enumerable.Range(parameters.Length, slotTypes.Count - parameters.Length)
                .OrderByDescending(slot => typeUses[slotTypes[slot]])
                .ThenBy(slot => typeFirst[slotTypes[slot]])
                .ThenByDescending(slot => slotUses[slot])
                .ThenBy(slot => slot)
                .ToArray();
            var number = new int[slotTypes.Count];
            for (int parameter = 0; parameter < parameters.Length; parameter++)
            {
                number[parameter] = parameter;
            }

            var newLocals = new WType[order.Length];
            for (int index = 0; index < order.Length; index++)
            {
                number[order[index]] = parameters.Length + index;
                newLocals[index] = slotTypes[order[index]];
            }

            var writer = new WasmWriter();
            for (int index = 0; index < total; index++)
            {
                var instruction = instructions[index];
                if (remove[index])
                {
                    continue;
                }

                if (instruction.Kind == Kind.LocalGet && constant[instruction.Operand] < 0)
                {
                    // A copy of a local to its own storage is none.
                    int next = index + 1;
                    while (next < total && remove[next])
                    {
                        next++;
                    }

                    if (next < total && instructions[next].Kind is Kind.LocalSet or Kind.LocalTee
                        && slotOf[instructions[next].Operand] == slotOf[instruction.Operand])
                    {
                        if (instructions[next].Kind == Kind.LocalTee)
                        {
                            writer.Byte(0x20);
                            writer.Index(number[slotOf[instruction.Operand]]);
                        }

                        index = next;
                        continue;
                    }
                }

                switch (instruction.Kind)
                {
                    case Kind.LocalGet when constant[instruction.Operand] >= 0:
                    {
                        var value = instructions[constant[instruction.Operand]];
                        writer.Bytes(code.AsSpan(value.Start, value.End - value.Start));
                        break;
                    }
                    case Kind.LocalGet or Kind.LocalSet or Kind.LocalTee:
                        writer.Byte(code[instruction.Start]);
                        writer.Index(number[slotOf[instruction.Operand]]);
                        break;
                    default:
                        writer.Bytes(code.AsSpan(instruction.Start, instruction.End - instruction.Start));
                        break;
                }
            }

            return (writer.ToArray(), newLocals);
        }

        private static int FirstMember(ulong[] members)
        {
            for (int word = 0; word < members.Length; word++)
            {
                if (members[word] != 0)
                {
                    return (word << 6) + System.Numerics.BitOperations.TrailingZeroCount(members[word]);
                }
            }

            return -1;
        }

        private static int LebSize(int value)
        {
            int size = 1;
            while (value >= 0x80)
            {
                value >>= 7;
                size++;
            }

            return size;
        }
    }
}
