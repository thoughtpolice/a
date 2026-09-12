// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// What an IL evaluation stack entry is, as far as lowering cares: a scalar
// of one of Wasm's four types (native ints are 64-bit, as on the CLR the
// fixtures are compared with), an object reference of its static type,
// null, a managed reference to storage of a type, a struct value, or the
// method pointer and runtime handle that `ldftn` and `ldtoken` push for
// the instruction after to consume.
internal enum IlKind
{
    I32,
    I64,
    F32,
    F64,
    Ref,
    Null,
    ByRef,
    Value,
    Method,
    Token,
}

internal readonly record struct IlSlot(IlKind Kind, ITypeSymbol? Type = null, ISymbol? Symbol = null, bool Virtual = false)
{
    public bool IsScalar => Kind is IlKind.I32 or IlKind.I64 or IlKind.F32 or IlKind.F64;

    public override string ToString() => Kind + (Type is null ? "" : $"({Type.ToDisplayString()})");
}

// A method the runtime gives a multidimensional array type: its
// constructor of the lengths, and Get, Set and Address of an element; Type
// is the MdArray class the array is.
internal sealed record IlArrayMethod(INamedTypeSymbol Type, ITypeSymbol Element, int Rank, string Name)
{
    public int Parameters => Name == "Set" ? Rank + 1 : Rank;
}

// A basic block: instructions [Start, End), and the blocks control flows
// to (a leave's target included).
internal sealed class IlBlock(int index, int start)
{
    public int Index { get; } = index;

    public int Start { get; } = start;

    public int End { get; set; }

    public List<int> Successors { get; } = [];

    public ImmutableArray<IlSlot>? Entry { get; set; }

    public IlArea Area { get; set; } = null!;
}

// Code that is structured on its own: the method body, a protected
// region's try block, or one of its handlers. Area offsets are IL offsets.
internal sealed class IlArea(int start, int end, IlGroup? group)
{
    public int Start { get; } = start;

    public int End { get; } = end;

    // The protected group this is the try block or a handler of; null for
    // the method body.
    public IlGroup? Group { get; } = group;

    public IlArea? Parent { get; set; }

    public List<IlGroup> Children { get; } = [];

    public int Entry { get; set; } = -1;

    public bool Contains(int offset) => offset >= Start && offset < End;

    public override string ToString() => $"[{Start:X4}, {End:X4})";
}

// A try block and its handlers: catch clauses tried in order, or one
// finally (or fault) block.
internal sealed class IlGroup(int id, int tryStart, int tryEnd)
{
    public int Id { get; } = id;

    public int TryStart { get; } = tryStart;

    public int TryEnd { get; } = tryEnd;

    public List<IlRegion> Clauses { get; } = [];

    public IlArea Try { get; set; } = null!;

    public List<IlArea> Handlers { get; } = [];

    // Each clause's filter, or null.
    public List<IlArea?> Filters { get; } = [];

    public IlArea Parent { get; set; } = null!;

    public bool IsFinally => Clauses[0].Kind is ExceptionRegionKind.Finally or ExceptionRegionKind.Fault;

    public int Start => Math.Min(TryStart, Clauses.Min(clause => clause.FilterStart >= 0 ? clause.FilterStart : clause.HandlerStart));

    public int End => Math.Max(TryEnd, Clauses.Max(clause => clause.HandlerEnd));
}

// A method body's IL, analyzed for lowering: its blocks, each
// instruction's resolved operand (closed under the instantiation), the
// evaluation stack before each instruction, and its areas. Discovery and
// the emitter both read it.
internal sealed partial class IlAnalysis
{
    private readonly Frontend frontend;
    private readonly Substitution generic;

    // For a shared method's code (Frontend.SharedCode): whether an open
    // symbol depends on its shared type arguments, and whether folding
    // decided anything by them that differs between reference types
    // (`typeof(T) == typeof(string)`), which leaves the method unshared.
    private readonly Func<ISymbol?, bool>? shared;

    public bool FoldedByShared { get; private set; }

    // The arrays the stack typing joined with other types.
    public List<IArrayTypeSymbol> JoinedArrays { get; } = [];

    public IlAnalysis(Frontend frontend, MethodPlan plan, Func<ISymbol?, bool>? shared = null)
    {
        this.frontend = frontend;
        this.shared = shared;
        generic = plan.Generic;
        Method = plan.Symbol!;
        Code = plan.Il!;
        Context = Frontend.IlContext(Method);
        var il = Code.Module;
        Locals = [.. il.Locals(Code.Body.LocalSignature, Context).Concat(Code.ExtraLocals).Select(local => local with { Type = Sub(local.Type) })];
        // A runtime-async method's IL returns its result, not its task, and
        // nothing for a Task or ValueTask (Il.RuntimeAsync).
        returnsNothing = Method.ReturnsVoid
                         || (Code.Kind == IlCodeKind.Method && Method.ReturnType is INamedTypeSymbol { TypeArguments.Length: 0 }
                             && RuntimeAsyncSplitter.Returns(Method) && frontend.IsRuntimeAsync(Method));
        Arguments = ArgumentSlots();
        Instructions = Code.Instructions;
        Operands = new object?[Instructions.Length];
        OpenOperands = new ISymbol?[Instructions.Length];
        Before = new ImmutableArray<IlSlot>[Instructions.Length];
        After = new ImmutableArray<IlSlot>?[Instructions.Length];
        Constrained = new ITypeSymbol?[Instructions.Length];
        unresolved = new CompileError?[Instructions.Length];
        ResolveOperands();
        Fold();
        BuildAreas();
        BuildBlocks();
        Type();
    }

    public IMethodSymbol Method { get; }

    public IlCode Code { get; }

    public IlGenericContext Context { get; }

    public ImmutableArray<IlType> Locals { get; }

    // The type of each IL argument, `this` first for an instance method.
    public ImmutableArray<IlSlot> Arguments { get; }

    // Each instruction's resolved operand: a closed symbol, a string, or null.
    public object?[] Operands { get; }

    // Each instruction's symbol operand as the definition names it, before
    // the instantiation closes it: what tells a shared method's code that
    // depends on its type arguments from the rest (Frontend.SharedCode).
    public ISymbol?[] OpenOperands { get; }

    // The type a `constrained.` prefix names, on the call it prefixes.
    public ITypeSymbol?[] Constrained { get; }

    public ImmutableArray<IlSlot>[] Before { get; }

    public ImmutableArray<IlSlot>?[] After { get; }

    public List<IlBlock> Blocks { get; } = [];

    // The block each instruction is in.
    public int[] BlockOf { get; private set; } = [];

    public IlArea Body { get; private set; } = null!;

    public List<IlGroup> Groups { get; } = [];

    // The body's instructions, as folding left them (Il.Folding): the
    // constants it computed replace their instructions.
    public ImmutableArray<IlInstruction> Instructions { get; private set; }

    // What a token that did not resolve would report, by instruction: an
    // error only where the instruction is reachable.
    private readonly CompileError?[] unresolved;

    private ITypeSymbol Sub(ITypeSymbol type) => frontend.Substitute(generic, type);

    private readonly bool returnsNothing;

    public CompileError Error(int index, string message) =>
        frontend.ErrorAt(Method, Code.SourceOffset(Instructions[index].Offset), message);

    private ImmutableArray<IlSlot> ArgumentSlots()
    {
        var builder = ImmutableArray.CreateBuilder<IlSlot>();
        if (!Method.IsStatic)
        {
            var self = Method.ContainingType;
            builder.Add(self.IsValueType ? new IlSlot(IlKind.ByRef, self) : new IlSlot(IlKind.Ref, self));
        }

        foreach (var parameter in Method.Parameters)
        {
            builder.Add(parameter.RefKind != RefKind.None
                ? new IlSlot(IlKind.ByRef, parameter.Type)
                : SlotOf(parameter.Type));
        }

        return builder.ToImmutable();
    }

    // The stack entry a value of a closed C# type is.
    public IlSlot SlotOf(ITypeSymbol type)
    {
        // As the module layer names it: a framework struct the runtime has
        // its own of (decimal, Nullable<T>) is the runtime's.
        type = Sub(type);
        if (type is IPointerTypeSymbol or IFunctionPointerTypeSymbol)
        {
            throw new CompileError($"GP1001: Type '{type.ToDisplayString()}' is unsupported: pointers have no representation here.");
        }

        if (Frontend.ScalarOf(type) is { } scalar)
        {
            return new(Frontend.Represent(scalar).Code switch
            {
                0x7e => IlKind.I64,
                0x7d => IlKind.F32,
                0x7c => IlKind.F64,
                _ => IlKind.I32,
            }, type);
        }

        return type.IsValueType ? new(IlKind.Value, type) : new(IlKind.Ref, type);
    }

    // The local an instruction uses, which must be of a type there is.
    private int UsedLocal(int index)
    {
        int local = (int)Instructions[index].Operand;
        return Frontend.IsMissing(Locals[local].Type)
            ? throw Error(index, $"Type '{Locals[local].Type.ToDisplayString()}' is not in the gameplay CoreLib.")
            : local;
    }

    // Whether a local is of a type that exists (see IlModule.Locals), and,
    // if it is of a type with no representation (a Vector128 of elements
    // Wasm has no lanes of, a Vector256 or Vector512, whose
    // IsHardwareAccelerated folds to false, or a BFloat16, which generic
    // conversions test for by typeof), whether an instruction folding left uses it:
    // the CoreLib's vectorized span search declares some, on paths other
    // element types never take.
    public bool HasLocal(int index) =>
        !Frontend.IsMissing(Locals[index].Type)
        && (!Unrepresentable(Locals[index].Type) || UsedLocals.Contains(index));

    private static bool Unrepresentable(ITypeSymbol type) =>
        Frontend.IsUnacceleratedVector(type)
        || type is INamedTypeSymbol { Name: "BFloat16", ContainingNamespace: { Name: "Numerics", ContainingNamespace.Name: "System" } }
        || (Frontend.IsVector128(type) && !Frontend.ContainsTypeParameters(type) && Frontend.VectorLane(type) is null);

    private HashSet<int>? usedLocals;

    private HashSet<int> UsedLocals => usedLocals ??= Enumerable.Range(0, Instructions.Length)
        .Where(index => !Before[index].IsDefault
                        && Instructions[index].OpCode is ILOpCode.Ldloc or ILOpCode.Stloc or ILOpCode.Ldloca)
        .Select(index => (int)Instructions[index].Operand)
        .ToHashSet();

    public IlSlot LocalSlot(int index) =>
        Locals[index].ByRef ? new(IlKind.ByRef, Locals[index].Type) : SlotOf(Locals[index].Type);

    // MARK: Operands

    private void ResolveOperands()
    {
        var il = Code.Module;
        ITypeSymbol? constrained = null;
        for (int index = 0; index < Instructions.Length; index++)
        {
            var instruction = Instructions[index];
            if (Code.Synthetic.TryGetValue(index, out var written))
            {
                // A call the compiler wrote, of a symbol it names.
                var target = (IMethodSymbol)written.Symbol;
                OpenOperands[index] = target;
                Operands[index] = frontend.Substitute(generic, target);
                constrained = null;
                continue;
            }

            try
            {
                switch (instruction.OpCode)
                {
                    case ILOpCode.Ldstr:
                        Operands[index] = il.UserString(instruction.Token);
                        break;
                    case ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj
                        when il.ArrayMethod(instruction.Token, Context) is var (array, name):
                        // A multidimensional array's: its MdArray class's.
                        var mdType = (INamedTypeSymbol)Sub(array);
                        Operands[index] = new IlArrayMethod(mdType, mdType.TypeArguments[0], array.Rank, name);
                        break;
                    case ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj or ILOpCode.Ldftn or ILOpCode.Ldvirtftn:
                        var method = frontend.Redirected((IMethodSymbol)il.Resolve(instruction.Token, Context));
                        OpenOperands[index] = method;
                        // typeof's handle conversion has no runtime counterpart:
                        // the lowering takes the token.
                        // A span of one element by reference has none either.
                        Operands[index] = method is { Name: "GetTypeFromHandle", ContainingType.Name: "Type" }
                                          || IsSpanOfOne(method) || IsSpanOfStack(method)
                            ? method
                            : frontend.Substitute(generic, method);
                        Constrained[index] = constrained;
                        break;
                    case ILOpCode.Ldfld or ILOpCode.Ldflda or ILOpCode.Stfld or ILOpCode.Ldsfld or ILOpCode.Ldsflda
                        or ILOpCode.Stsfld:
                        var openField = il.Resolve(instruction.Token, Context);
                        OpenOperands[index] = openField;
                        Operands[index] = openField switch
                        {
                            IFieldSymbol field => frontend.Substitute(generic, field),
                            // A field-like event's backing field, which the
                            // module layer keeps as the event's storage.
                            IEventSymbol storage => (ISymbol)frontend.Substitute(generic, storage),
                            var other => throw Error(index, $"'{other.ToDisplayString()}' is not a field."),
                        };
                        break;
                    case ILOpCode.Box or ILOpCode.Unbox or ILOpCode.Unbox_any or ILOpCode.Newarr or ILOpCode.Castclass
                        or ILOpCode.Isinst or ILOpCode.Ldelema or ILOpCode.Ldelem or ILOpCode.Stelem or ILOpCode.Ldobj
                        or ILOpCode.Stobj or ILOpCode.Cpobj or ILOpCode.Initobj or ILOpCode.Sizeof or ILOpCode.Constrained:
                        var openType = il.ResolveType(MetadataTokens.EntityHandle(instruction.Token), Context);
                        OpenOperands[index] = openType;
                        var type = Sub(openType);
                        Operands[index] = type;
                        if (instruction.OpCode == ILOpCode.Constrained)
                        {
                            constrained = type;
                            continue;
                        }

                        break;
                    case ILOpCode.Ldtoken:
                        var handle = MetadataTokens.EntityHandle(instruction.Token);
                        if (handle.Kind is HandleKind.TypeDefinition or HandleKind.TypeReference or HandleKind.TypeSpecification)
                        {
                            OpenOperands[index] = il.ResolveType(handle, Context);
                        }

                        Operands[index] = handle.Kind is HandleKind.TypeDefinition or HandleKind.TypeReference
                            or HandleKind.TypeSpecification
                            ? Sub(il.ResolveType(handle, Context))
                            : il.Resolve(handle, Context) switch
                            {
                                IFieldSymbol field => frontend.Substitute(generic, field),
                                IMethodSymbol tokenMethod => frontend.Substitute(generic, tokenMethod),
                                var other => other,
                            };
                        break;
                    case ILOpCode.Readonly or ILOpCode.Volatile or ILOpCode.Tail or ILOpCode.Unaligned:
                        continue;
                    case ILOpCode.Calli or ILOpCode.Jmp or ILOpCode.Arglist or ILOpCode.Mkrefany
                        or ILOpCode.Refanyval or ILOpCode.Refanytype or ILOpCode.Initblk:
                        throw Error(index, $"The IL instruction '{instruction.OpCode}' is unsupported.");
                }
            }
            catch (CompileError error)
            {
                // A token that does not resolve (or names a member the
                // module layer has no counterpart of), located at its
                // instruction, where code reaches it.
                unresolved[index] = Error(index, error.Message.StartsWith("GP1001: ", StringComparison.Ordinal)
                    ? error.Message["GP1001: ".Length..]
                    : error.Message);
            }

            constrained = null;
        }
    }

    // `new ReadOnlySpan<T>(ref readonly T)` (or Span's): a span of one
    // element C# makes of a variable, a params span's one argument.
    public static bool IsSpanOfOne(IMethodSymbol method) =>
        method is { MethodKind: MethodKind.Constructor, Parameters: [{ RefKind: not RefKind.None }] }
        && Frontend.IsFrameworkSpan(method.ContainingType);

    // `new Span<T>(void*, int)` of stackalloc'd memory.
    public static bool IsSpanOfStack(IMethodSymbol method) =>
        method is { MethodKind: MethodKind.Constructor, Parameters: [{ Type: IPointerTypeSymbol }, { Type.SpecialType: SpecialType.System_Int32 }] }
        && Frontend.IsFrameworkSpan(method.ContainingType);

    // The locals and arguments (Argument, index) a filter reads or writes:
    // its selector reaches them through an environment.
    public SortedSet<(bool Argument, int Index)> FilterVariables()
    {
        var variables = new SortedSet<(bool Argument, int Index)>();
        foreach (var group in Groups)
        {
            foreach (var filter in group.Filters.OfType<IlArea>())
            {
                foreach (var instruction in Instructions.Where(instruction => filter.Contains(instruction.Offset)))
                {
                    switch (instruction.OpCode)
                    {
                        case ILOpCode.Ldloc or ILOpCode.Stloc or ILOpCode.Ldloca:
                            variables.Add((false, (int)instruction.Operand));
                            break;
                        case ILOpCode.Ldarg or ILOpCode.Starg or ILOpCode.Ldarga:
                            variables.Add((true, (int)instruction.Operand));
                            break;
                    }
                }
            }
        }

        return variables;
    }

    // MARK: Areas

    // The exception clauses, but a finally that only disposes of a struct
    // whose Dispose does nothing (a List<T> enumerator's, in foreach):
    // without it the code is the try block's alone, which needs no
    // exception handling.
    private List<IlRegion> regions = [];

    private bool IsEmptyFinally(IlRegion region)
    {
        if (region.Kind != ExceptionRegionKind.Finally
            || !Code.IndexOf.TryGetValue(region.HandlerStart, out int start)
            || !Code.IndexOf.TryGetValue(region.HandlerEnd, out int end)
            || end - start != 4)
        {
            return false;
        }

        var instructions = Code.Instructions;
        return instructions[start].OpCode is ILOpCode.Ldloca or ILOpCode.Ldarga
               && instructions[start + 1].OpCode == ILOpCode.Constrained
               && instructions[start + 2].OpCode is ILOpCode.Callvirt or ILOpCode.Call
               && instructions[start + 3].OpCode == ILOpCode.Endfinally
               && Operands[start + 2] is IMethodSymbol { Name: "Dispose", ContainingType.Name: "IDisposable" } dispose
               && Constrained[start + 2] is INamedTypeSymbol { IsValueType: true } disposed
               && disposed.FindImplementationForInterfaceMember(dispose) is IMethodSymbol implementation
               && frontend.IlOf(implementation) is { Regions.Length: 0 } body
               && body.Instructions.All(instruction => instruction.OpCode is ILOpCode.Nop or ILOpCode.Ret);
    }

    private void BuildAreas()
    {
        regions = [.. Code.Regions.Where(region => !IsEmptyFinally(region))];
        Body = new IlArea(0, int.MaxValue, null) { Entry = 0 };
        foreach (var region in regions)
        {
            var group = Groups.Find(candidate => candidate.TryStart == region.TryStart && candidate.TryEnd == region.TryEnd);
            if (group is null)
            {
                group = new IlGroup(Groups.Count, region.TryStart, region.TryEnd);
                Groups.Add(group);
            }
            else if (group.IsFinally || region.Kind is not (ExceptionRegionKind.Catch or ExceptionRegionKind.Filter))
            {
                throw frontend.ErrorAt(Method, region.TryStart, "A try block with both catch and finally handlers is unsupported.");
            }

            group.Clauses.Add(region);
        }

        var areas = new List<IlArea> { Body };
        foreach (var group in Groups)
        {
            group.Try = new IlArea(group.TryStart, group.TryEnd, group);
            areas.Add(group.Try);
            foreach (var clause in group.Clauses)
            {
                var handler = new IlArea(clause.HandlerStart, clause.HandlerEnd, group);
                group.Handlers.Add(handler);
                areas.Add(handler);
                // A filter is code of its own, from its start to its
                // handler's (see FunctionEmitter.IlFilters).
                var filter = clause.Kind == ExceptionRegionKind.Filter
                    ? new IlArea(clause.FilterStart, clause.HandlerStart, group)
                    : null;
                group.Filters.Add(filter);
                if (filter is not null)
                {
                    areas.Add(filter);
                }
            }
        }

        // A group's parent is the smallest area that holds all of it.
        foreach (var group in Groups)
        {
            group.Parent = areas
                .Where(area => area.Group != group && area.Start <= group.Start && area.End >= group.End)
                .OrderBy(area => area.End - (long)area.Start)
                .First();
            group.Parent.Children.Add(group);
            group.Try.Parent = group.Parent;
            foreach (var handler in group.Handlers.Concat(group.Filters.OfType<IlArea>()))
            {
                handler.Parent = group.Parent;
            }
        }
    }

    // The smallest area an offset is in.
    public IlArea AreaOf(int offset)
    {
        var area = Body;
        while (true)
        {
            IlArea? inner = null;
            foreach (var group in area.Children)
            {
                if (group.Try.Contains(offset))
                {
                    inner = group.Try;
                }
                else if (group.Handlers.Concat(group.Filters.OfType<IlArea>()).FirstOrDefault(handler => handler.Contains(offset)) is { } handler)
                {
                    inner = handler;
                }
            }

            if (inner is null)
            {
                return area;
            }

            area = inner;
        }
    }

    // MARK: Blocks

    private static bool EndsBlock(ILOpCode opcode) => opcode is ILOpCode.Br or ILOpCode.Brfalse or ILOpCode.Brtrue
        or ILOpCode.Beq or ILOpCode.Bge or ILOpCode.Bgt or ILOpCode.Ble or ILOpCode.Blt or ILOpCode.Bne_un
        or ILOpCode.Bge_un or ILOpCode.Bgt_un or ILOpCode.Ble_un or ILOpCode.Blt_un or ILOpCode.Switch
        or ILOpCode.Leave or ILOpCode.Ret or ILOpCode.Throw or ILOpCode.Rethrow or ILOpCode.Endfinally
        or ILOpCode.Endfilter or IlPseudo.StepReturn;

    public static bool IsConditional(ILOpCode opcode) => opcode is ILOpCode.Brfalse or ILOpCode.Brtrue
        or ILOpCode.Beq or ILOpCode.Bge or ILOpCode.Bgt or ILOpCode.Ble or ILOpCode.Blt or ILOpCode.Bne_un
        or ILOpCode.Bge_un or ILOpCode.Bgt_un or ILOpCode.Ble_un or ILOpCode.Blt_un;

    private void BuildBlocks()
    {
        var instructions = Instructions;
        var leaders = new SortedSet<int> { 0 };
        void Leader(int offset)
        {
            if (!Code.IndexOf.TryGetValue(offset, out int index))
            {
                if (offset == instructions[^1].Offset + 1 || offset > instructions[^1].Offset)
                {
                    return;
                }

                throw new InternalCompilerError($"branch into the middle of an instruction at IL_{offset:X4}.");
            }

            leaders.Add(index);
        }

        for (int index = 0; index < instructions.Length; index++)
        {
            var instruction = instructions[index];
            if (instruction.Targets is { } targets)
            {
                foreach (int target in targets)
                {
                    Leader(target);
                }
            }
            else if (EndsBlock(instruction.OpCode) && instruction.OpCode is not (ILOpCode.Ret or ILOpCode.Throw
                         or ILOpCode.Rethrow or ILOpCode.Endfinally or ILOpCode.Endfilter or IlPseudo.StepReturn))
            {
                Leader(instruction.Target);
            }

            if (EndsBlock(instruction.OpCode) && index + 1 < instructions.Length)
            {
                leaders.Add(index + 1);
            }
        }

        foreach (var region in regions)
        {
            Leader(region.TryStart);
            Leader(region.TryEnd);
            Leader(region.HandlerStart);
            Leader(region.HandlerEnd);
            if (region.FilterStart >= 0)
            {
                Leader(region.FilterStart);
            }
        }

        BlockOf = new int[instructions.Length];
        var starts = leaders.ToList();
        for (int block = 0; block < starts.Count; block++)
        {
            var node = new IlBlock(block, starts[block])
            {
                End = block + 1 < starts.Count ? starts[block + 1] : instructions.Length,
            };
            node.Area = AreaOf(instructions[node.Start].Offset);
            Blocks.Add(node);
            for (int index = node.Start; index < node.End; index++)
            {
                BlockOf[index] = block;
            }
        }

        foreach (var block in Blocks)
        {
            var last = instructions[block.End - 1];
            int BlockAt(int offset) => BlockOf[Code.IndexOf[offset]];
            if (last.Targets is { } targets)
            {
                block.Successors.AddRange(targets.Select(BlockAt));
                AddFallthrough(block);
            }
            else if (last.OpCode is ILOpCode.Br or ILOpCode.Leave)
            {
                block.Successors.Add(BlockAt(last.Target));
            }
            else if (IsConditional(last.OpCode))
            {
                block.Successors.Add(BlockAt(last.Target));
                AddFallthrough(block);
            }
            else if (!EndsBlock(last.OpCode))
            {
                AddFallthrough(block);
            }
        }

        foreach (var area in Groups.SelectMany(group => new[] { group.Try }.Concat(group.Handlers).Concat(group.Filters.OfType<IlArea>())))
        {
            area.Entry = BlockOf[Code.IndexOf[area.Start]];
        }
    }

    private void AddFallthrough(IlBlock block)
    {
        if (block.End >= Instructions.Length)
        {
            throw Error(block.End - 1, "Control falls off the end of the method.");
        }

        block.Successors.Add(block.Index + 1);
    }

    // MARK: Stack typing

    private void Type()
    {
        var pending = new Stack<int>();
        void Enter(int block, ImmutableArray<IlSlot> stack)
        {
            var target = Blocks[block];
            if (target.Entry is not { } existing)
            {
                target.Entry = stack;
                pending.Push(block);
                return;
            }

            if (existing.Length != stack.Length)
            {
                throw Error(target.Start, "The evaluation stack differs between the paths that reach this instruction.");
            }

            var merged = existing.ToBuilder();
            bool changed = false;
            for (int depth = 0; depth < stack.Length; depth++)
            {
                var slot = Merge(existing[depth], stack[depth], target.Start);
                if (slot != existing[depth])
                {
                    merged[depth] = slot;
                    changed = true;
                }
            }

            if (changed)
            {
                target.Entry = merged.ToImmutable();
                pending.Push(block);
            }
        }

        Enter(0, []);
        foreach (var group in Groups)
        {
            for (int clause = 0; clause < group.Clauses.Count; clause++)
            {
                var region = group.Clauses[clause];
                int handler = BlockOf[Code.IndexOf[region.HandlerStart]];
                Enter(handler, region.Kind switch
                {
                    ExceptionRegionKind.Catch => [new IlSlot(IlKind.Ref, CatchType(region))],
                    ExceptionRegionKind.Filter => [new IlSlot(IlKind.Ref, frontend.ObjectSymbol)],
                    _ => [],
                });
                if (region.Kind == ExceptionRegionKind.Filter)
                {
                    Enter(BlockOf[Code.IndexOf[region.FilterStart]], [new IlSlot(IlKind.Ref, frontend.ObjectSymbol)]);
                }
            }
        }

        while (pending.TryPop(out int index))
        {
            var block = Blocks[index];
            var stack = block.Entry!.Value;
            for (int instruction = block.Start; instruction < block.End; instruction++)
            {
                if (unresolved[instruction] is { } error)
                {
                    throw error;
                }

                Before[instruction] = stack;
                stack = Step(instruction, stack);
                After[instruction] = stack;
            }

            var last = Instructions[block.End - 1];
            foreach (int successor in block.Successors)
            {
                Enter(successor, last.OpCode == ILOpCode.Leave ? [] : stack);
            }
        }
    }

    public ITypeSymbol CatchType(IlRegion region) =>
        region.CatchToken == -1 ? frontend.ExceptionType : Sub(Code.Module.ResolveType(MetadataTokens.EntityHandle(region.CatchToken), Context));

    private IlSlot Merge(IlSlot left, IlSlot right, int index)
    {
        if (left == right)
        {
            return left;
        }

        if (left.Kind == IlKind.Null && right.Kind == IlKind.Ref)
        {
            return right;
        }

        if (right.Kind == IlKind.Null && left.Kind == IlKind.Ref)
        {
            return left;
        }

        if (left.Kind != right.Kind)
        {
            throw Error(index, $"The evaluation stack holds {left} on one path and {right} on another.");
        }

        if (left.Kind is IlKind.Ref)
        {
            // An array joined with another type is seen as their base
            // (Frontend.ClosedWorld).
            if (left.Type is IArrayTypeSymbol leftArray)
            {
                JoinedArrays.Add(leftArray);
            }

            if (right.Type is IArrayTypeSymbol rightArray)
            {
                JoinedArrays.Add(rightArray);
            }

            return new(IlKind.Ref, CommonBase(left.Type!, right.Type!));
        }

        if (left.Kind is IlKind.ByRef or IlKind.Value
            && !SymbolEqualityComparer.Default.Equals(left.Type, right.Type))
        {
            throw Error(index, $"The evaluation stack holds {left} on one path and {right} on another.");
        }

        // Scalars of one Wasm type: which C# type is only a hint.
        return new(left.Kind, left.Type);
    }

    private ITypeSymbol CommonBase(ITypeSymbol left, ITypeSymbol right)
    {
        if (frontend.ClassifyConversion(left, right) is { IsImplicit: true, IsReference: true } or { IsIdentity: true })
        {
            return right;
        }

        if (frontend.ClassifyConversion(right, left) is { IsImplicit: true, IsReference: true })
        {
            return left;
        }

        for (var current = left.BaseType; current is not null; current = current.BaseType)
        {
            if (frontend.ClassifyConversion(right, current) is { IsImplicit: true, IsReference: true } or { IsIdentity: true })
            {
                return current;
            }
        }

        return frontend.ObjectSymbol;
    }

    private ITypeSymbol Special(SpecialType type) => frontend.SpecialTypeOf(type);

    // The stack after one instruction.
    private ImmutableArray<IlSlot> Step(int index, ImmutableArray<IlSlot> stack)
    {
        var instruction = Instructions[index];
        var builder = stack.ToBuilder();
        IlSlot Pop()
        {
            if (builder.Count == 0)
            {
                throw Error(index, "The evaluation stack underflows.");
            }

            var top = builder[^1];
            builder.RemoveAt(builder.Count - 1);
            return top;
        }

        void Push(IlSlot slot) => builder.Add(slot);
        IlSlot Int(SpecialType type) => new(IlKind.I32, Special(type));
        IlSlot Long(SpecialType type) => new(IlKind.I64, Special(type));

        if (Operands[index] is IlPopFirst)
        {
            // A type test folded to its answer (Il.Folding).
            Pop();
        }

        switch (instruction.OpCode)
        {
            case ILOpCode.Nop or ILOpCode.Break or ILOpCode.Readonly or ILOpCode.Volatile or ILOpCode.Tail
                or ILOpCode.Unaligned or ILOpCode.Constrained:
                break;
            case ILOpCode.Ldarg:
                Push(Arguments[(int)instruction.Operand]);
                break;
            case ILOpCode.Ldarga:
                Push(new(IlKind.ByRef, ArgumentType((int)instruction.Operand)));
                break;
            case ILOpCode.Stloc:
                UsedLocal(index);
                Pop();
                break;
            case ILOpCode.Starg or ILOpCode.Pop:
                Pop();
                break;
            case ILOpCode.Ldloc:
                Push(LocalSlot(UsedLocal(index)));
                break;
            case ILOpCode.Ldloca:
                Push(new(IlKind.ByRef, Locals[UsedLocal(index)].Type));
                break;
            case ILOpCode.Ldnull:
                Push(new(IlKind.Null));
                break;
            case ILOpCode.Ldc_i4:
                Push(Int(SpecialType.System_Int32));
                break;
            case ILOpCode.Ldc_i8:
                Push(Long(SpecialType.System_Int64));
                break;
            case ILOpCode.Ldc_r4:
                Push(new(IlKind.F32, Special(SpecialType.System_Single)));
                break;
            case ILOpCode.Ldc_r8:
                Push(new(IlKind.F64, Special(SpecialType.System_Double)));
                break;
            case ILOpCode.Ldstr:
                Push(new(IlKind.Ref, Special(SpecialType.System_String)));
                break;
            case ILOpCode.Dup:
                var duplicated = Pop();
                Push(duplicated);
                Push(duplicated);
                break;
            case ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj when Operands[index] is IlArrayMethod accessor:
                for (int parameter = 0; parameter < accessor.Parameters; parameter++)
                {
                    Pop();
                }

                if (accessor.Name != ".ctor")
                {
                    Pop();
                }

                switch (accessor.Name)
                {
                    case ".ctor":
                        Push(new(IlKind.Ref, accessor.Type));
                        break;
                    case "Get":
                        Push(SlotOf(accessor.Element));
                        break;
                    case "Address":
                        Push(new(IlKind.ByRef, accessor.Element));
                        break;
                }

                break;
            case ILOpCode.Call when Operands[index] is IlExactTypeTest:
                Pop();
                Push(Int(SpecialType.System_Boolean));
                break;
            case ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj:
                var method = (IMethodSymbol)Operands[index]!;
                for (int parameter = 0; parameter < method.Parameters.Length; parameter++)
                {
                    Pop();
                }

                IlSlot? receiver = null;
                if (!method.IsStatic && instruction.OpCode != ILOpCode.Newobj)
                {
                    receiver = Pop();
                }

                if (instruction.OpCode == ILOpCode.Newobj)
                {
                    Push(SlotOf(method.ContainingType));
                }
                else if (CallResult(method, stack) is { } result)
                {
                    Push(result);
                }

                _ = receiver;
                break;
            case ILOpCode.Ret:
                if (!returnsNothing)
                {
                    Pop();
                }

                break;
            case IlPseudo.NewResume:
                // The kickoff's continuation (Il.RuntimeAsync).
                Push(new(IlKind.Ref, frontend.CoreType("System.Action")));
                break;
            case IlPseudo.StepReturn:
                break;
            case ILOpCode.Br or ILOpCode.Leave or ILOpCode.Endfinally:
                if (instruction.OpCode != ILOpCode.Br)
                {
                    builder.Clear();
                }

                break;
            case ILOpCode.Brfalse or ILOpCode.Brtrue or ILOpCode.Switch:
                Pop();
                break;
            case ILOpCode.Beq or ILOpCode.Bge or ILOpCode.Bgt or ILOpCode.Ble or ILOpCode.Blt or ILOpCode.Bne_un
                or ILOpCode.Bge_un or ILOpCode.Bgt_un or ILOpCode.Ble_un or ILOpCode.Blt_un:
                Pop();
                Pop();
                break;
            case ILOpCode.Ldind_i1:
                Pop();
                Push(Int(SpecialType.System_SByte));
                break;
            case ILOpCode.Ldind_u1:
                Pop();
                Push(Int(SpecialType.System_Byte));
                break;
            case ILOpCode.Ldind_i2:
                Pop();
                Push(Int(SpecialType.System_Int16));
                break;
            case ILOpCode.Ldind_u2:
                var charReference = Pop();
                Push(charReference.Type?.SpecialType == SpecialType.System_Char
                    ? Int(SpecialType.System_Char)
                    : Int(SpecialType.System_UInt16));
                break;
            case ILOpCode.Ldind_i4:
                var intReference = Pop();
                Push(intReference.Type is { } intType && Frontend.ScalarOf(intType) is Scalar.I32
                    ? new(IlKind.I32, intType)
                    : Int(SpecialType.System_Int32));
                break;
            case ILOpCode.Ldind_u4:
                Pop();
                Push(Int(SpecialType.System_UInt32));
                break;
            case ILOpCode.Ldind_i8:
                var longReference = Pop();
                Push(longReference.Type is { } longType && Frontend.ScalarOf(longType) is Scalar.I64 or Scalar.U64
                    ? new(IlKind.I64, longType)
                    : Long(SpecialType.System_Int64));
                break;
            case ILOpCode.Ldind_i:
                Pop();
                Push(Long(SpecialType.System_IntPtr));
                break;
            case ILOpCode.Ldind_r4:
                Pop();
                Push(new(IlKind.F32, Special(SpecialType.System_Single)));
                break;
            case ILOpCode.Ldind_r8:
                Pop();
                Push(new(IlKind.F64, Special(SpecialType.System_Double)));
                break;
            case ILOpCode.Ldind_ref:
                var reference = Pop();
                Push(new(IlKind.Ref, reference.Type));
                break;
            case ILOpCode.Stind_i1 or ILOpCode.Stind_i2 or ILOpCode.Stind_i4 or ILOpCode.Stind_i8 or ILOpCode.Stind_r4
                or ILOpCode.Stind_r8 or ILOpCode.Stind_ref or ILOpCode.Stind_i:
                Pop();
                Pop();
                break;
            case ILOpCode.Add or ILOpCode.Sub or ILOpCode.Mul or ILOpCode.Div or ILOpCode.Div_un or ILOpCode.Rem
                or ILOpCode.Rem_un or ILOpCode.And or ILOpCode.Or or ILOpCode.Xor or ILOpCode.Add_ovf
                or ILOpCode.Add_ovf_un or ILOpCode.Mul_ovf or ILOpCode.Mul_ovf_un or ILOpCode.Sub_ovf
                or ILOpCode.Sub_ovf_un:
                var right = Pop();
                var left = Pop();
                Push(Arithmetic(left, right, index));
                break;
            case ILOpCode.Shl or ILOpCode.Shr or ILOpCode.Shr_un:
                Pop();
                var shifted = Pop();
                Push(Numeric(shifted, index));
                break;
            case ILOpCode.Neg or ILOpCode.Not:
                Push(Numeric(Pop(), index));
                break;
            case ILOpCode.Conv_i1 or ILOpCode.Conv_ovf_i1 or ILOpCode.Conv_ovf_i1_un:
                Pop();
                Push(Int(SpecialType.System_SByte));
                break;
            case ILOpCode.Conv_u1 or ILOpCode.Conv_ovf_u1 or ILOpCode.Conv_ovf_u1_un:
                Pop();
                Push(Int(SpecialType.System_Byte));
                break;
            case ILOpCode.Conv_i2 or ILOpCode.Conv_ovf_i2 or ILOpCode.Conv_ovf_i2_un:
                Pop();
                Push(Int(SpecialType.System_Int16));
                break;
            case ILOpCode.Conv_u2 or ILOpCode.Conv_ovf_u2 or ILOpCode.Conv_ovf_u2_un:
                Pop();
                Push(Int(SpecialType.System_UInt16));
                break;
            case ILOpCode.Conv_i4 or ILOpCode.Conv_ovf_i4 or ILOpCode.Conv_ovf_i4_un:
                Pop();
                Push(Int(SpecialType.System_Int32));
                break;
            case ILOpCode.Conv_u4 or ILOpCode.Conv_ovf_u4 or ILOpCode.Conv_ovf_u4_un:
                Pop();
                Push(Int(SpecialType.System_UInt32));
                break;
            case ILOpCode.Conv_i8 or ILOpCode.Conv_ovf_i8 or ILOpCode.Conv_ovf_i8_un:
                Pop();
                Push(Long(SpecialType.System_Int64));
                break;
            case ILOpCode.Conv_u8 or ILOpCode.Conv_ovf_u8 or ILOpCode.Conv_ovf_u8_un:
                Pop();
                Push(Long(SpecialType.System_UInt64));
                break;
            case ILOpCode.Conv_i or ILOpCode.Conv_ovf_i or ILOpCode.Conv_ovf_i_un:
                Pop();
                Push(Long(SpecialType.System_IntPtr));
                break;
            case ILOpCode.Conv_u or ILOpCode.Conv_ovf_u or ILOpCode.Conv_ovf_u_un:
                Pop();
                Push(Long(SpecialType.System_UIntPtr));
                break;
            case ILOpCode.Conv_r4:
                Pop();
                Push(new(IlKind.F32, Special(SpecialType.System_Single)));
                break;
            case ILOpCode.Conv_r8 or ILOpCode.Conv_r_un:
                Pop();
                Push(new(IlKind.F64, Special(SpecialType.System_Double)));
                break;
            case ILOpCode.Ceq or ILOpCode.Cgt or ILOpCode.Cgt_un or ILOpCode.Clt or ILOpCode.Clt_un:
                Pop();
                Pop();
                Push(Int(SpecialType.System_Boolean));
                break;
            case ILOpCode.Ldfld:
                Pop();
                Push(SlotOf(Frontend.StorageType((ISymbol)Operands[index]!)));
                break;
            case ILOpCode.Ldflda:
                Pop();
                Push(new(IlKind.ByRef, Frontend.StorageType((ISymbol)Operands[index]!)));
                break;
            case ILOpCode.Stfld:
                Pop();
                Pop();
                break;
            case ILOpCode.Ldsfld:
                Push(SlotOf(Frontend.StorageType((ISymbol)Operands[index]!)));
                break;
            case ILOpCode.Ldsflda:
                Push(new(IlKind.ByRef, Frontend.StorageType((ISymbol)Operands[index]!)));
                break;
            case ILOpCode.Stsfld:
                Pop();
                break;
            case ILOpCode.Newarr:
                Pop();
                Push(new(IlKind.Ref, frontend.ArrayOf((ITypeSymbol)Operands[index]!)));
                break;
            case ILOpCode.Ldlen:
                Pop();
                Push(Long(SpecialType.System_UIntPtr));
                break;
            case ILOpCode.Ldelema:
                Pop();
                Pop();
                Push(new(IlKind.ByRef, (ITypeSymbol)Operands[index]!));
                break;
            case ILOpCode.Ldelem:
                Pop();
                Pop();
                Push(SlotOf((ITypeSymbol)Operands[index]!));
                break;
            case ILOpCode.Ldelem_i1 or ILOpCode.Ldelem_u1 or ILOpCode.Ldelem_i2 or ILOpCode.Ldelem_u2
                or ILOpCode.Ldelem_i4 or ILOpCode.Ldelem_u4 or ILOpCode.Ldelem_i8 or ILOpCode.Ldelem_i
                or ILOpCode.Ldelem_r4 or ILOpCode.Ldelem_r8 or ILOpCode.Ldelem_ref:
                Pop();
                var array = Pop();
                Push(array.Type is IArrayTypeSymbol arrayType
                    ? SlotOf(arrayType.ElementType)
                    : array.Kind == IlKind.Null
                        ? instruction.OpCode switch
                        {
                            // An element of null: it faults, so any type will do.
                            ILOpCode.Ldelem_i8 or ILOpCode.Ldelem_i => Long(SpecialType.System_Int64),
                            ILOpCode.Ldelem_r4 => new(IlKind.F32, Special(SpecialType.System_Single)),
                            ILOpCode.Ldelem_r8 => new(IlKind.F64, Special(SpecialType.System_Double)),
                            ILOpCode.Ldelem_ref => new(IlKind.Null),
                            _ => Int(SpecialType.System_Int32),
                        }
                        : throw Error(index, "An element load needs an array."));
                break;
            case ILOpCode.Stelem or ILOpCode.Stelem_i1 or ILOpCode.Stelem_i2 or ILOpCode.Stelem_i4
                or ILOpCode.Stelem_i8 or ILOpCode.Stelem_r4 or ILOpCode.Stelem_r8 or ILOpCode.Stelem_ref
                or ILOpCode.Stelem_i:
                Pop();
                Pop();
                Pop();
                break;
            case ILOpCode.Box:
                Pop();
                var boxed = (ITypeSymbol)Operands[index]!;
                Push(new(IlKind.Ref, boxed.IsValueType ? frontend.ObjectSymbol : boxed));
                break;
            case ILOpCode.Unbox_any:
                Pop();
                Push(SlotOf((ITypeSymbol)Operands[index]!));
                break;
            case ILOpCode.Unbox:
                Pop();
                Push(new(IlKind.ByRef, (ITypeSymbol)Operands[index]!));
                break;
            case ILOpCode.Castclass or ILOpCode.Isinst:
                Pop();
                var castType = (ITypeSymbol)Operands[index]!;
                // A value type's test leaves the box.
                Push(new(IlKind.Ref, castType.IsValueType ? frontend.ObjectSymbol : castType));
                break;
            case ILOpCode.Throw:
                Pop();
                break;
            case ILOpCode.Rethrow:
                break;
            case ILOpCode.Ldtoken:
                Push(new(IlKind.Token, Symbol: (ISymbol)Operands[index]!));
                break;
            case ILOpCode.Ldftn:
                Push(new(IlKind.Method, Symbol: (ISymbol)Operands[index]!));
                break;
            case ILOpCode.Ldvirtftn:
                Pop();
                Push(new(IlKind.Method, Symbol: (ISymbol)Operands[index]!, Virtual: true));
                break;
            case ILOpCode.Initobj:
                Pop();
                break;
            case ILOpCode.Ldobj:
                Pop();
                Push(SlotOf((ITypeSymbol)Operands[index]!));
                break;
            case ILOpCode.Cpblk:
                Pop();
                Pop();
                Pop();
                break;
            case ILOpCode.Stobj or ILOpCode.Cpobj:
                Pop();
                Pop();
                break;
            case ILOpCode.Sizeof:
                Push(Int(SpecialType.System_Int32));
                break;
            case ILOpCode.Localloc:
                // stackalloc: memory only a span's constructor may take.
                Pop();
                Push(new(IlKind.Token));
                break;
            case ILOpCode.Ckfinite:
                break;
            case ILOpCode.Endfilter:
                Pop();
                break;
            default:
                throw Error(index, $"The IL instruction '{instruction.OpCode}' is unsupported.");
        }

        return builder.ToImmutable();
    }

    private ITypeSymbol ArgumentType(int index) => Arguments[index] is { Kind: IlKind.ByRef } byRef
        ? byRef.Type!
        : Arguments[index].Type!;

    // What a call leaves: its result, but for Delegate.Combine and Remove,
    // whose Delegate is the operands' own type.
    private IlSlot? CallResult(IMethodSymbol method, ImmutableArray<IlSlot> before)
    {
        if (method.ReturnsVoid)
        {
            return null;
        }

        if (method.ContainingType.SpecialType == SpecialType.System_Delegate
            && method.Name is "Combine" or "Remove" && method.Parameters.Length == 2)
        {
            var first = before[^2];
            return first.Kind == IlKind.Ref ? first : before[^1];
        }

        if (method.ReturnsByRef || method.ReturnsByRefReadonly)
        {
            return new(IlKind.ByRef, method.ReturnType);
        }

        return SlotOf(method.ReturnType);
    }

    private IlSlot Arithmetic(IlSlot left, IlSlot right, int index)
    {
        if (left.Kind == IlKind.Token && right.Kind is IlKind.I32 or IlKind.I64)
        {
            // An offset into stackalloc'd memory (an initializer's element).
            return left;
        }

        if (left.Kind == right.Kind && left.IsScalar)
        {
            return new(left.Kind, WidestType(left, right));
        }

        // int32 with native int: native int.
        if (left.Kind is IlKind.I32 or IlKind.I64 && right.Kind is IlKind.I32 or IlKind.I64)
        {
            return new(IlKind.I64, Special(SpecialType.System_IntPtr));
        }

        throw Error(index, $"Arithmetic on {left} and {right} is unsupported.");
    }

    private ITypeSymbol? WidestType(IlSlot left, IlSlot right) =>
        left.Type is { } type && Frontend.ScalarOf(type) is Scalar.U32 or Scalar.U64 ? type : right.Type ?? left.Type;

    private IlSlot Numeric(IlSlot slot, int index) => slot.IsScalar
        ? slot
        : throw Error(index, $"Arithmetic on {slot} is unsupported.");
}
