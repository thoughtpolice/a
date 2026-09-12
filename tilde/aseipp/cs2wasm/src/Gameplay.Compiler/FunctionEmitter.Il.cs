// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection.Metadata;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Gameplay.Compiler;

// The CIL importer's lowering (see docs/IMPORTER.md): an IL body through
// the body layer's primitives. Every evaluation stack entry lives in a Wasm
// local of its depth and type, so blocks carry no Wasm values, `dup` is a
// second name for a local, and a branch copies what differs into the
// target's entry locals. Managed references are Locations (FunctionEmitter's
// storage descriptions) until something needs a reference value: a struct's
// box, a variable's cell, or a handle, as Frontend.References has them.
// Control flow is structured area by area (the method body, each try block,
// each handler) by the dominator-tree algorithm of "Beyond Relooper"
// (Ramsey, ICFP 2022); a try block and its handlers are one node of the
// area around them, whose successors are where they leave to.
internal sealed partial class FunctionEmitter
{
    private abstract record IlValue;

    // A value in a Wasm local: a stack slot, or an argument never stored
    // to; with the constant it is, when an ldc or ldstr pushed it.
    private sealed record IlLocalValue(IlSlot Type, int Local, object? Constant = null) : IlValue;

    private sealed record IlNullValue : IlValue;

    // stackalloc'd memory, at a byte offset, which only `new Span<T>(void*,
    // int)` takes: what an initializer stores in it waits in its block
    // for the span's array.
    private sealed record IlStackValue(IlStackBlock Block, int Offset) : IlValue;

    private sealed class IlStackBlock
    {
        public List<(int Offset, int Local, WType Type)> Stores { get; } = [];

        public byte[]? Data { get; set; }
    }

    // A field's initial data (an initializer's constants), which cpblk
    // copies into stackalloc'd memory.
    private sealed record IlDataValue(byte[] Bytes) : IlValue;

    // The constant data an IL local's span of it (CreateSpan's) holds, by
    // local: what GetPinnableReference then refers to.
    private readonly Dictionary<int, byte[]> ilLocalData = [];

    // The values stored in a params span's buffer (see
    // EmitInlineArrayHelper), by position: each's local and static type.
    private sealed record IlSpanItems(List<(int Local, ITypeSymbol? Type)> Items);

    // The buffer and position of an element reference into a params span's
    // buffer, and what each buffer's positions hold.
    private readonly Dictionary<IlRefValue, (int Buffer, int Index)> inlineItemRefs = [];
    private readonly Dictionary<int, Dictionary<int, (int Local, ITypeSymbol? Type)>> inlineItems = [];

    // A managed reference not yet made a value.
    private sealed record IlRefValue(IlSlot Type, Location Place, ISymbol? Field) : IlValue;

    private sealed record IlMethodValue(IMethodSymbol Method, bool Virtual) : IlValue;

    private sealed record IlTokenValue(ISymbol Symbol) : IlValue;

    // A value type's value `box` boxed, in a local of its own: the box is
    // made where an object is needed, and the value read where it is
    // (Enum.HasFlag's operands, say).
    private sealed record IlBoxedValue(ITypeSymbol Type, int Value) : IlValue;

    // A node of one area's control flow graph: blocks by index, groups
    // after them by id.
    private sealed class IlGraph(IlArea area)
    {
        public IlArea Area { get; } = area;

        public int Entry { get; set; }

        public List<int> Order { get; } = [];

        public Dictionary<int, int> Rpo { get; } = [];

        public Dictionary<int, List<int>> Successors { get; } = [];

        public Dictionary<int, int> Idom { get; } = [];

        public Dictionary<int, List<int>> Children { get; } = [];

        public HashSet<int> Merges { get; } = [];

        public HashSet<int> Loops { get; } = [];

        // Irreducible (a loop entered in the middle: an iterator's resume
        // points, or gotos into loops): lowered as a dispatch loop over
        // its nodes by a label local instead.
        public bool Irreducible { get; set; }

        public int Label { get; set; } = -1;

        public object DispatchLoop { get; } = new();

        public Dictionary<int, int> Cases { get; } = [];
    }

    private sealed record IlLabel(IlArea Area, int Node, bool Loop);

    private IlAnalysis flow = null!;
    private readonly Dictionary<(int Depth, WType Type), int> ilSlots = [];
    private List<IlValue> ilStack = [];
    private readonly Dictionary<IlLabel, IlLabel> ilLabels = [];
    private readonly Stack<object> endFinallyLabels = new();
    // Where each IL local and argument lives: a Wasm local holding its
    // value, or (Boxed) a box or cell, or for a byref local or parameter
    // the reference.
    private int[] ilLocals = [];
    private bool[] ilLocalBoxed = [];
    private int[] ilArguments = [];
    private bool[] ilArgumentBoxed = [];
    private bool[] ilArgumentStored = [];
    private int ilIndex;

    private CompileError IlError(string message) => flow.Error(ilIndex, message);

    // A diagnostic that already names where it is.
    private static readonly System.Text.RegularExpressions.Regex Located = new(@"^.+?: GP\d{4}: ");

    private WasmFunction EmitIl()
    {
        // Shared code's own analysis (Frontend.SharedCode).
        flow = plan.Shared?.Flow ?? new IlAnalysis(frontend, plan);
        if (Environment.GetEnvironmentVariable("GAMEPLAYC_DUMP_IL") is { } dumped && plan.Name.Contains(dumped, StringComparison.Ordinal))
        {
            // For the compiler's own debugging: the body as lowered.
            for (int index = 0; index < flow.Instructions.Length; index++)
            {
                Console.Error.WriteLine($"{flow.Instructions[index]} block {flow.BlockOf[index]} {(flow.Before[index].IsDefault ? "unreached" : "")} {flow.Operands[index]}");
            }
        }

        ConsumeFuel();
        GlobalGet(ModuleWriter.CallDepthGlobal);
        code.I32(frontend.Limits.CallDepth);
        code.Byte(0x4f); // i32.ge_u
        FaultIf(FaultCode.CallDepthExceeded);
        GlobalGet(ModuleWriter.CallDepthGlobal);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        if (flow.Groups.Any(group => !group.IsFinally))
        {
            // Its call depth, which its catch clauses restore (RestoreDepth).
            depthLevel = NewLocal(WType.I32);
            code.OpIndex(0x22, depthLevel); // local.tee
        }

        GlobalSet(ModuleWriter.CallDepthGlobal);

        if (thisSlot != 0)
        {
            LocalGet(0);
            code.RefCast(locals[thisSlot - parameterCount]);
            LocalSet(thisSlot);
        }

        EmitClassTrigger();
        OpenDictionary();
        OpenBlock(0x02, WType.Void, returnLabel);
        if (plan.Kind == MethodPlanKind.Selector)
        {
            EmitIlSelectorBody();
        }
        else if (plan.Kind == MethodPlanKind.RuntimeAsyncStep)
        {
            OpenRuntimeAsyncFrame();
            EmitArea(flow.Body);
        }
        else
        {
            OpenIlStorage();
            EmitArea(flow.Body);
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

    // MARK: Storage

    // Locals and arguments whose address escapes (a reference to them is
    // passed on, stored or returned, rather than read or written through
    // at once) live in a box or cell for the whole call.
    private void OpenIlStorage()
    {
        var escaping = EscapingAddresses();
        if (flow.Code.Kind == IlCodeKind.RuntimeAsyncKickoff)
        {
            // A runtime-async method's variables are its frame's cells.
            foreach (var (argument, index, _) in frontend.RuntimeAsyncFrameOf(plan.Symbol!, plan.Generic).Variables)
            {
                escaping.Add((argument, index));
            }
        }

        ilLocals = new int[flow.Locals.Length];
        ilLocalBoxed = new bool[flow.Locals.Length];
        for (int index = 0; index < flow.Locals.Length; index++)
        {
            var local = flow.Locals[index];
            if (!flow.HasLocal(index))
            {
                // Of a type there is not, on a path folding removed.
                ilLocals[index] = -1;
            }
            else if (local.ByRef)
            {
                ilLocals[index] = NewLocal(frontend.RefParameterType(local.Type));
            }
            else if (escaping.Contains((false, index)))
            {
                var mapped = frontend.MapType(local.Type);
                EmitNewBox(mapped);
                ilLocals[index] = Save(frontend.ReferenceType(local.Type));
                ilLocalBoxed[index] = true;
            }
            else
            {
                ilLocals[index] = NewLocal(frontend.MapType(local.Type));
            }
        }

        int count = flow.Arguments.Length;
        ilArguments = new int[count];
        ilArgumentBoxed = new bool[count];
        ilArgumentStored = new bool[count];
        foreach (var instruction in flow.Instructions)
        {
            if (instruction.OpCode == ILOpCode.Starg)
            {
                ilArgumentStored[(int)instruction.Operand] = true;
            }
        }

        int first = plan.Symbol!.IsStatic ? 0 : 1;
        if (first == 1)
        {
            ilArguments[0] = Frontend.IsStruct(plan.ContainingType) ? 0 : thisSlot;
        }

        for (int index = first; index < count; index++)
        {
            var parameter = plan.Symbol.Parameters[index - first];
            int slot = parameterBases[index];
            if (parameter.RefKind == RefKind.None && plan.Parameters[index].IsRef
                && IlWType(flow.Arguments[index]) is { IsRef: true } exact && exact != plan.Parameters[index])
            {
                // A shared instantiation's parameter is its canonical
                // form's: the IL's more exact type, cast once
                // (Frontend.Sharing).
                LocalGet(slot);
                CastToShape(plan.Parameters[index], exact);
                slot = Save(exact);
            }

            ilArguments[index] = slot;
            if (parameter.RefKind == RefKind.None && escaping.Contains((true, index)))
            {
                var mapped = frontend.MapType(parameter.Type);
                EmitNewBox(mapped);
                int box = Save(frontend.ReferenceType(parameter.Type));
                Store(new(LocationKind.Local, mapped, parameter.Type, Local: box, Boxed: true, NonNull: true), slot);
                ilArguments[index] = box;
                ilArgumentBoxed[index] = true;
            }
        }
    }

    // A runtime-async method's step (Il.RuntimeAsync): its variables are
    // the cells of the frame its continuation's target is; its byref
    // locals, which no await outlives, are its own.
    private void OpenRuntimeAsyncFrame()
    {
        var frame = frontend.RuntimeAsyncFrameOf(plan.Symbol!, plan.Generic);
        ilLocals = new int[flow.Locals.Length];
        ilLocalBoxed = new bool[flow.Locals.Length];
        ilArguments = new int[flow.Arguments.Length];
        ilArgumentBoxed = new bool[flow.Arguments.Length];
        ilArgumentStored = new bool[flow.Arguments.Length];
        for (int index = 0; index < flow.Locals.Length; index++)
        {
            ilLocals[index] = flow.HasLocal(index) && flow.Locals[index].ByRef
                ? NewLocal(frontend.RefParameterType(flow.Locals[index].Type))
                : -1;
        }

        LocalGet(0);
        code.Gc(2, frontend.DelegateOf(frontend.CoreType("System.Action")).Heap, Frontend.DelegateTargetField); // struct.get
        code.RefCast(WType.NonNullRef(frame.Heap));
        int held = Save(WType.Ref(frame.Heap));
        for (int field = 0; field < frame.Variables.Count; field++)
        {
            var (argument, index, type) = frame.Variables[field];
            LocalGet(held);
            code.Gc(2, frame.Heap, field); // struct.get
            int local = Save(type);
            if (argument)
            {
                ilArguments[index] = local;
                ilArgumentBoxed[index] = flow.Arguments[index].Kind != IlKind.ByRef && (plan.Symbol!.IsStatic || index != 0);
            }
            else
            {
                ilLocals[index] = local;
                ilLocalBoxed[index] = true;
            }
        }
    }

    // The kickoff's continuation: an Action whose function is the step and
    // whose target is the frame of the kickoff's cells.
    private void EmitNewResume()
    {
        var frame = frontend.RuntimeAsyncFrameOf(plan.Symbol!, plan.Generic);
        var action = frontend.CoreType("System.Action");
        var layout = frontend.DelegateOf(action);
        code.I64(16 + 8 * frame.Variables.Count);
        ChargeAllocation();
        foreach (var (argument, index, _) in frame.Variables)
        {
            LocalGet(argument ? ilArguments[index] : ilLocals[index]);
        }

        StructNew(frame.Heap);
        int target = Save(WType.Ref(frame.Heap));
        code.I64(24);
        ChargeAllocation();
        FunctionReference(frontend.RuntimeAsyncStepIndex(plan.Symbol!, plan.Generic));
        code.I32(frontend.DelegateTypeId(action));
        code.I32(frontend.MethodGroupId(plan.Symbol!, false, plan.Generic));
        LocalGet(target);
        StructNew(layout.Heap);
        PushResult();
    }

    // The locals and arguments (IsArgument, index) a reference to which
    // escapes.
    private HashSet<(bool IsArgument, int Index)> EscapingAddresses()
    {
        var result = new HashSet<(bool, int)>();
        for (int index = 0; index < flow.Instructions.Length; index++)
        {
            var instruction = flow.Instructions[index];
            if (instruction.OpCode is not (ILOpCode.Ldloca or ILOpCode.Ldarga))
            {
                continue;
            }

            bool argument = instruction.OpCode == ILOpCode.Ldarga;
            int number = (int)instruction.Operand;
            if (argument && flow.Arguments[number].Kind == IlKind.ByRef)
            {
                // A ref parameter's own reference, or `this` of a struct.
                continue;
            }

            if (Escapes(index))
            {
                result.Add((argument, number));
            }
        }

        if (frontend.TwoPass)
        {
            // What filters use lives in cells their selectors reach (see
            // FunctionEmitter.IlFilters); references and `this` are values.
            foreach (var (argument, number) in flow.FilterVariables())
            {
                bool reference = argument
                    ? flow.Arguments[number].Kind == IlKind.ByRef || (!plan.Symbol!.IsStatic && number == 0)
                    : flow.Locals[number].ByRef;
                if (!reference)
                {
                    result.Add((argument, number));
                }
            }
        }

        return result;
    }

    // Whether the reference instruction `index` pushes is used as a value:
    // anything but a load, store, field access or framework scalar call
    // through it.
    private bool Escapes(int index)
    {
        if (flow.After[index] is not { } after)
        {
            return false;
        }

        int depth = after.Length - 1;
        var block = flow.Blocks[flow.BlockOf[index]];
        for (int next = index + 1; next < block.End; next++)
        {
            // A call pops its arguments and may push a result at the same
            // depth, so whether it takes the reference is by its arguments.
            bool untouched = flow.Instructions[next].OpCode is ILOpCode.Call or ILOpCode.Callvirt
                             && flow.Operands[next] is IMethodSymbol called && flow.After[next] is not null
                ? flow.Before[next].Length - called.Parameters.Length - (called.IsStatic ? 0 : 1) > depth
                : flow.After[next] is not { } later || (later.Length > depth && flow.Before[next].Length > depth);
            if (untouched)
            {
                // Still below the top, untouched.
                if (flow.Instructions[next].OpCode == ILOpCode.Dup && flow.Before[next].Length == depth + 1)
                {
                    return true;
                }

                continue;
            }

            // Instruction `next` consumes it: which operand is it?
            var instruction = flow.Instructions[next];
            int operand = flow.Before[next].Length - 1 - depth;
            switch (instruction.OpCode)
            {
                case ILOpCode.Ldfld or ILOpCode.Ldobj or ILOpCode.Initobj or ILOpCode.Ldind_i1 or ILOpCode.Ldind_u1
                    or ILOpCode.Ldind_i2 or ILOpCode.Ldind_u2 or ILOpCode.Ldind_i4 or ILOpCode.Ldind_u4
                    or ILOpCode.Ldind_i8 or ILOpCode.Ldind_i or ILOpCode.Ldind_r4 or ILOpCode.Ldind_r8
                    or ILOpCode.Ldind_ref:
                    return false;
                case ILOpCode.Stfld or ILOpCode.Stobj or ILOpCode.Stind_i1 or ILOpCode.Stind_i2 or ILOpCode.Stind_i4
                    or ILOpCode.Stind_i8 or ILOpCode.Stind_r4 or ILOpCode.Stind_r8 or ILOpCode.Stind_ref
                    or ILOpCode.Stind_i:
                    // The address (operand 1), not the value stored.
                    return operand != 1;
                case ILOpCode.Ldflda:
                    return Escapes(next);
                case ILOpCode.Call or ILOpCode.Callvirt:
                    if (flow.Operands[next] is not IMethodSymbol method)
                    {
                        return true;
                    }

                    bool receiver = !method.IsStatic && operand == method.Parameters.Length;
                    if (!receiver && operand < method.Parameters.Length
                        && method.Parameters[method.Parameters.Length - 1 - operand].RefKind == RefKind.In
                        && Frontend.IsModuleDefined(method) && frontend.IntrinsicOf(method) is null)
                    {
                        // An `in` argument, which the callee takes as its
                        // value (FunctionEmitter.ArgumentLocal): read at once.
                        return false;
                    }

                    return !(receiver && (ReadsThroughReceiver(method, flow.Constrained[next])
                                          || (flow.Constrained[next] is null && frontend.AutoGetterField(method) is not null)
                                          || (method.MethodKind == MethodKind.Constructor
                                              && frontend.InlinedConstruction(method) is not null)));
                default:
                    return true;
            }
        }

        return true;
    }

    // A call whose `this` reference is only read through: a framework
    // member of a scalar, or a constrained call on a reference type.
    private static bool ReadsThroughReceiver(IMethodSymbol method, ITypeSymbol? constrained) =>
        (constrained is { IsReferenceType: true })
        || (Frontend.ScalarOf(constrained ?? method.ContainingType) is not null && !Frontend.IsModuleDefined(method));

    // MARK: Stack

    private int SlotLocal(int depth, WType type)
    {
        if (!ilSlots.TryGetValue((depth, type), out int local))
        {
            local = NewLocal(type);
            ilSlots.Add((depth, type), local);
        }

        return local;
    }

    // The Wasm type of a stack entry that is a value.
    private WType IlWType(IlSlot slot) => slot.Kind switch
    {
        IlKind.I32 => WType.I32,
        IlKind.I64 => WType.I64,
        IlKind.F32 => WType.F32,
        IlKind.F64 => WType.F64,
        IlKind.Ref => frontend.MapType(slot.Type),
        IlKind.Value => frontend.MapType(slot.Type),
        IlKind.ByRef => frontend.RefParameterType(slot.Type!),
        _ => throw IlError($"A {slot.Kind} has no value."),
    };

    private IlValue Pop()
    {
        var top = ilStack[^1];
        ilStack.RemoveAt(ilStack.Count - 1);
        return top;
    }

    private IlValue Peek(int fromTop = 0) => ilStack[ilStack.Count - 1 - fromTop];

    // Pops the value on the Wasm stack into the slot of the result
    // `ilIndex` leaves on top.
    private void PushResult()
    {
        var type = flow.After[ilIndex]!.Value[^1];
        PushResult(type);
    }

    private void PushResult(IlSlot type)
    {
        int local = SlotLocal(ilStack.Count, IlWType(type));
        LocalSet(local);
        ilStack.Add(new IlLocalValue(type, local));
    }

    // Pushes a value onto the Wasm stack as `expected`.
    private void Get(IlValue value, WType expected)
    {
        switch (value)
        {
            case IlNullValue:
                if (!expected.IsRef)
                {
                    throw IlError("A null where a value is expected.");
                }

                code.Byte(0xd0); // ref.null
                code.Signed(expected.Heap);
                return;
            case IlLocalValue local:
                LocalGet(local.Local);
                Coerce(IlLocalType(local.Local), expected);
                return;
            case IlBoxedValue boxed:
                LocalGet(boxed.Value);
                EmitBox(boxed.Type);
                Coerce(ObjectRef, expected);
                return;
            case IlRefValue reference:
                LocalGet(Materialize(reference));
                Coerce(frontend.RefParameterType(reference.Type.Type!), expected);
                return;
            default:
                throw IlError($"{value} is not a value.");
        }
    }

    // The constant an integer stack entry is, through conversions to native
    // ints and products of constants, or null.
    private static int? ConstantOf(IlValue value) => value is IlLocalValue { Constant: int constant } ? constant : null;

    // A value in a new local of its own, which no later stack entry
    // overwrites.
    private int GetOwnLocal(IlValue value, IlSlot type)
    {
        var mapped = IlWType(type);
        Get(value, mapped);
        return Save(mapped);
    }

    // A value in a local of its own type, reusing its local when it is one.
    private int GetLocal(IlValue value, WType type)
    {
        if (value is IlLocalValue local && IlLocalType(local.Local) == type)
        {
            return local.Local;
        }

        Get(value, type);
        return Save(type);
    }

    // The Wasm type of a local or parameter, a struct's by its first leaf.
    private WType IlLocalType(int local)
    {
        if (tupleLocals.TryGetValue(local, out var tuple))
        {
            return tuple;
        }

        if (local < parameterCount)
        {
            for (int index = plan.Parameters.Length - 1; index >= 0; index--)
            {
                if (parameterBases[index] == local)
                {
                    return plan.Parameters[index];
                }
            }

            throw new InternalCompilerError("a parameter inside a flattened parameter.");
        }

        return locals[local - parameterCount];
    }

    // Converts the value on the Wasm stack between representations IL
    // considers one: a reference to a supertype or to what a cast proves,
    // and int32 with native int.
    private void Coerce(WType from, WType to)
    {
        if (from == to || to == WType.Void)
        {
            return;
        }

        if ((from.IsTuple || to.IsTuple) && frontend.Leaves(from).AsSpan().SequenceEqual(frontend.Leaves(to)))
        {
            // Values of the same leaves: what a function type records
            // (FunctionEmitter.TargetShape) cannot tell them apart.
            return;
        }

        if (from.IsRef && to.IsRef)
        {
            if (!frontend.IsSubtypeHeap(from.Heap, to.Heap))
            {
                if (frontend.IsArrayHeap(from.Heap) && frontend.IsStructHeap(to.Heap))
                {
                    // A cast that cannot succeed: an array as an object of
                    // a class, which here only IEnumerable<T> may hold.
                    throw IlError("An array where an object is expected: arrays are IEnumerable<T> here, "
                                  + "but not ICollection<T>, IList<T> or the read-only collection interfaces.");
                }

                if (from.Heap >= 0 && to.Heap >= 0 && frontend.DelegateVariance(from.Heap, to.Heap) is int convert)
                {
                    // A delegate converted by variance.
                    Call(convert);
                    return;
                }

                if (frontend.ArraySymbolOfHeap(from.Heap) is { ElementType: { IsReferenceType: true } fromElement }
                    && frontend.ArraySymbolOfHeap(to.Heap) is { ElementType: { IsReferenceType: true } toElement }
                    && frontend.ClassifyConversion(fromElement, toElement) is { IsImplicit: true, IsReference: true })
                {
                    // Array covariance: arrays of references in one family.
                    frontend.NoteArrayCovariance(toElement);
                }

                if (from.Heap >= 0 && to.Heap >= 0 && !frontend.IsSubtypeHeap(to.Heap, from.Heap))
                {
                    // Unrelated representations, which only the CLR's
                    // variance relates.
                    throw IlError("A conversion between unrelated representations is unsupported (by variance: a covariant array, "
                                  + "a variant delegate or interface; or to an interface a string or array has only on the CLR).");
                }

                code.RefCast(to.IsNullable ? to : WType.Ref(to.Heap));
            }

            return;
        }

        if (from == WType.I32 && to == WType.I64)
        {
            code.Byte(0xac); // i64.extend_i32_s
            return;
        }

        if (from == WType.I64 && to == WType.I32)
        {
            code.Byte(0xa7); // i32.wrap_i64
            return;
        }

        throw IlError($"A value of {from} where {to} is expected.");
    }

    // A reference value, in a local: the storage's box or cell, or a new
    // handle naming an element or field.
    private int Materialize(IlRefValue reference)
    {
        var place = reference.Place;
        var pointee = reference.Type.Type!;
        var mapped = frontend.MapType(pointee);
        var referenceType = frontend.RefParameterType(pointee);
        if (place.Boxed)
        {
            if (place.Kind == LocationKind.Local)
            {
                return place.Local;
            }

            LoadSlot(place);
            return Save(referenceType);
        }

        if (mapped.IsTuple)
        {
            // A flattened struct's copy, in a new box: what a readonly
            // reference to a value can be.
            EmitNewBox(mapped);
            int box = Save(WType.Ref(frontend.StructOf(mapped).Box));
            Load(place);
            WriteBox(box, frontend.StructOf(mapped), Save(mapped));
            return box;
        }

        switch (place.Kind)
        {
            case LocationKind.ArrayElement:
                LocalGet(place.Receiver);
                LocalGet(place.Index);
                break;
            case LocationKind.Field when reference.Field is { } field:
                LocalGet(place.Receiver);
                code.I32(-2 - frontend.ReferencedField(field));
                break;
            case LocationKind.Global when reference.Field is { } field:
                EnsureInitialized(place.Class);
                code.Byte(0xd0); // ref.null
                code.Signed(Frontend.EqHeap);
                code.I32(-2 - frontend.ReferencedField(field));
                break;
            case LocationKind.Local:
                // A value that has no storage of its own (an `in`
                // parameter, say): a new cell holding a copy.
                EmitNewBox(mapped);
                int cell = Save(WType.Ref(frontend.CellHeap(mapped)));
                LocalGet(cell);
                Load(place);
                code.Gc(5, frontend.CellHeap(mapped), 0); // struct.set
                return cell;
            default:
                throw IlError("A reference to this storage is unsupported.");
        }

        // (The handle's type only now: a copy's cell needs none.)
        int handle = frontend.HandleHeap(mapped);
        code.I64(32);
        ChargeAllocation();
        StructNew(handle);
        return Save(referenceType);
    }

    // A location whose receiver and index are in locals of its own, which
    // later stack entries cannot overwrite while a reference names it.
    private Location Pinned(Location place)
    {
        if (place.Receiver >= 0 && place.Kind is LocationKind.Field or LocationKind.ArrayElement)
        {
            LocalGet(place.Receiver);
            place = place with { Receiver = Save(IlLocalType(place.Receiver)) };
        }

        if (place.Index >= 0)
        {
            LocalGet(place.Index);
            place = place with { Index = Save(WType.I32) };
        }

        return place;
    }

    // The storage a reference names.
    private Location PlaceOf(IlValue value)
    {
        switch (value)
        {
            case IlRefValue reference:
                var place = reference.Place;
                if (place.Boxed && place.Kind != LocationKind.Local && frontend.MapType(reference.Type.Type!).IsTuple)
                {
                    // A struct's box, in a local, so its fields are places.
                    LoadSlot(place);
                    return ReferenceLocation(Save(frontend.RefParameterType(reference.Type.Type!)), reference.Type.Type!);
                }

                return place;
            case IlLocalValue { Type.Kind: IlKind.ByRef } local:
                return ReferenceLocation(local.Local, local.Type.Type!);
            default:
                throw IlError($"{value} is not a reference.");
        }
    }

    // MARK: Structure

    private IlLabel Label(IlArea area, int node, bool loop)
    {
        var key = new IlLabel(area, node, loop);
        if (!ilLabels.TryGetValue(key, out var label))
        {
            ilLabels.Add(key, key);
            label = key;
        }

        return label;
    }

    private int GroupNode(IlGroup group) => flow.Blocks.Count + group.Id;

    // The node standing for a block in an area: the block, or the group
    // holding it; null outside the area.
    private int? Representative(IlArea area, int block)
    {
        var current = flow.Blocks[block].Area;
        if (current == area)
        {
            return block;
        }

        for (; current is not null; current = current.Parent)
        {
            if (current.Group is { } group && group.Parent == area)
            {
                return GroupNode(group);
            }
        }

        return null;
    }

    private bool InGroup(int block, IlGroup group)
    {
        for (var current = flow.Blocks[block].Area; current is not null; current = current.Parent)
        {
            if (current.Group == group)
            {
                return true;
            }
        }

        return false;
    }

    private IEnumerable<int> NodeSuccessors(IlArea area, int node)
    {
        if (node < flow.Blocks.Count)
        {
            foreach (int successor in flow.Blocks[node].Successors)
            {
                if (Representative(area, successor) is { } represented)
                {
                    yield return represented;
                }
            }

            yield break;
        }

        var group = flow.Groups[node - flow.Blocks.Count];
        for (int block = 0; block < flow.Blocks.Count; block++)
        {
            // Where a block no path reaches would go (one folding left
            // behind, see Il.Folding) is no exit.
            if (!InGroup(block, group) || flow.Blocks[block].Entry is null)
            {
                continue;
            }

            foreach (int successor in flow.Blocks[block].Successors)
            {
                if (!InGroup(successor, group) && Representative(area, successor) is { } represented)
                {
                    yield return represented;
                }
            }
        }
    }

    private IlGraph BuildGraph(IlArea area)
    {
        var graph = new IlGraph(area);
        // The entry block, or the try statement it starts.
        int entry = Representative(area, area.Entry)!.Value;
        graph.Entry = entry;
        var visited = new HashSet<int>();
        var postorder = new List<int>();
        void Visit(int node)
        {
            if (!visited.Add(node))
            {
                return;
            }

            var successors = NodeSuccessors(area, node).Distinct().ToList();
            graph.Successors[node] = successors;
            foreach (int successor in successors)
            {
                Visit(successor);
            }

            postorder.Add(node);
        }

        Visit(entry);
        postorder.Reverse();
        graph.Order.AddRange(postorder);
        for (int index = 0; index < postorder.Count; index++)
        {
            graph.Rpo[postorder[index]] = index;
        }

        // Dominators (Cooper, Harvey and Kennedy).
        var predecessors = graph.Order.ToDictionary(node => node, _ => new List<int>());
        foreach (int node in graph.Order)
        {
            foreach (int successor in graph.Successors[node])
            {
                predecessors[successor].Add(node);
            }
        }

        graph.Idom[entry] = entry;
        bool changed = true;
        while (changed)
        {
            changed = false;
            foreach (int node in graph.Order.Skip(1))
            {
                int? idom = null;
                foreach (int predecessor in predecessors[node].Where(graph.Idom.ContainsKey))
                {
                    idom = idom is null ? predecessor : Intersect(graph, predecessor, idom.Value);
                }

                if (idom is { } found && (!graph.Idom.TryGetValue(node, out int old) || old != found))
                {
                    graph.Idom[node] = found;
                    changed = true;
                }
            }
        }

        foreach (int node in graph.Order)
        {
            graph.Children[node] = [];
        }

        foreach (int node in graph.Order.Skip(1))
        {
            graph.Children[graph.Idom[node]].Add(node);
        }

        foreach (int node in graph.Order)
        {
            int forward = 0;
            foreach (int predecessor in predecessors[node])
            {
                if (graph.Rpo[predecessor] >= graph.Rpo[node])
                {
                    if (!Dominates(graph, node, predecessor))
                    {
                        graph.Irreducible = true;
                    }

                    graph.Loops.Add(node);
                }
                else
                {
                    forward++;
                }

                if (predecessor >= flow.Blocks.Count)
                {
                    // Where a try statement leaves to follows it.
                    graph.Merges.Add(node);
                }
            }

            if (forward >= 2)
            {
                graph.Merges.Add(node);
            }
        }

        return graph;
    }

    private static int Intersect(IlGraph graph, int left, int right)
    {
        while (left != right)
        {
            while (graph.Rpo[left] > graph.Rpo[right])
            {
                left = graph.Idom[left];
            }

            while (graph.Rpo[right] > graph.Rpo[left])
            {
                right = graph.Idom[right];
            }
        }

        return left;
    }

    private static bool Dominates(IlGraph graph, int dominator, int node)
    {
        while (true)
        {
            if (node == dominator)
            {
                return true;
            }

            int idom = graph.Idom[node];
            if (idom == node)
            {
                return false;
            }

            node = idom;
        }
    }

    private readonly Dictionary<IlArea, IlGraph> dispatchGraphs = [];

    private void EmitArea(IlArea area)
    {
        var graph = BuildGraph(area);
        if (graph.Irreducible)
        {
            EmitDispatch(graph);
            return;
        }

        DoTree(graph, graph.Entry);
    }

    // An irreducible area: a loop whose every iteration runs the node the
    // label local names, which a branch sets before continuing the loop.
    private void EmitDispatch(IlGraph graph)
    {
        for (int index = 0; index < graph.Order.Count; index++)
        {
            graph.Cases[graph.Order[index]] = index;
        }

        graph.Label = NewLocal(WType.I32);
        code.I32(graph.Cases[graph.Entry]);
        LocalSet(graph.Label);
        dispatchGraphs[graph.Area] = graph;
        OpenBlock(0x03, WType.Void, graph.DispatchLoop); // loop
        ConsumeFuel();
        var cases = graph.Order.Select(_ => new object()).ToList();
        for (int index = cases.Count - 1; index >= 0; index--)
        {
            OpenBlock(0x02, WType.Void, cases[index]);
        }

        LocalGet(graph.Label);
        code.Byte(0x0e); // br_table
        code.Index(cases.Count - 1);
        foreach (var label in cases)
        {
            code.Index(LabelDepth(label));
        }

        for (int index = 0; index < cases.Count; index++)
        {
            CloseBlock();
            EmitNode(graph, graph.Order[index]);
        }

        CloseBlock();
        dispatchGraphs.Remove(graph.Area);
    }

    // Continues an irreducible area's dispatch loop at a node.
    private void Dispatch(IlGraph graph, int node)
    {
        code.I32(graph.Cases[node]);
        LocalSet(graph.Label);
        Branch(graph.DispatchLoop);
    }

    private void DoTree(IlGraph graph, int node)
    {
        var merges = graph.Children[node]
            .Where(graph.Merges.Contains)
            .OrderByDescending(child => graph.Rpo[child])
            .ToList();
        if (graph.Loops.Contains(node))
        {
            OpenBlock(0x03, WType.Void, Label(graph.Area, node, loop: true)); // loop
            // Every iteration spends fuel, as a C# loop's does.
            ConsumeFuel();
            NodeWithin(graph, node, merges, 0);
            CloseBlock();
        }
        else
        {
            NodeWithin(graph, node, merges, 0);
        }
    }

    private void NodeWithin(IlGraph graph, int node, List<int> merges, int next)
    {
        if (next == merges.Count)
        {
            EmitNode(graph, node);
            return;
        }

        int follower = merges[next];
        OpenBlock(0x02, WType.Void, Label(graph.Area, follower, loop: false));
        NodeWithin(graph, node, merges, next + 1);
        CloseBlock();
        DoTree(graph, follower);
    }

    // A branch from `node` to the block `target`, its stack entries
    // copied where the target expects them.
    private void DoBranch(IlGraph graph, int node, int target)
    {
        TransferStack(target);
        if (Representative(graph.Area, target) is not { } represented)
        {
            BranchOut(graph.Area, target);
            return;
        }

        if (graph.Irreducible)
        {
            Dispatch(graph, represented);
        }
        else if (graph.Rpo[represented] <= graph.Rpo[node])
        {
            Branch(Label(graph.Area, represented, loop: true));
        }
        else if (graph.Merges.Contains(represented))
        {
            Branch(Label(graph.Area, represented, loop: false));
        }
        else
        {
            DoTree(graph, represented);
        }
    }

    // A branch out of an area: to the label of the target (or the group
    // holding it) in an enclosing area, through the finally blocks between.
    private void BranchOut(IlArea area, int target)
    {
        for (var outer = area.Parent; outer is not null; outer = outer.Parent)
        {
            if (Representative(outer, target) is not { } represented)
            {
                continue;
            }

            if (dispatchGraphs.TryGetValue(outer, out var dispatched))
            {
                Dispatch(dispatched, represented);
                return;
            }

            var loop = Label(outer, represented, loop: true);
            if (labels.Contains(loop))
            {
                Branch(loop);
                return;
            }

            var follow = Label(outer, represented, loop: false);
            if (labels.Contains(follow))
            {
                Branch(follow);
                return;
            }
        }

        throw new InternalCompilerError($"no label for the branch to block {target} in {plan.Name}.");
    }

    // What the compiler, not the module, holds of stack entries without a
    // value (stackalloc's memory, say) across the branches into a block:
    // the same on every edge, as C#'s initializers leave them.
    private readonly Dictionary<(int Block, int Depth), IlValue> carried = [];

    private void TransferStack(int target)
    {
        var entry = flow.Blocks[target].Entry!.Value;
        if (entry.Length != ilStack.Count)
        {
            if (entry.Length == 0)
            {
                return;
            }

            throw new InternalCompilerError("the evaluation stack does not match its target's.");
        }

        for (int depth = 0; depth < entry.Length; depth++)
        {
            if (entry[depth].Kind == IlKind.Null)
            {
                continue;
            }

            if (entry[depth].Kind == IlKind.Token)
            {
                if (carried.TryGetValue((target, depth), out var known) && !ReferenceEquals(known, ilStack[depth]))
                {
                    throw IlError("Stack entries without a value that differ between branches are unsupported.");
                }

                carried[(target, depth)] = ilStack[depth];
                continue;
            }

            var type = IlWType(entry[depth]);
            int slot = SlotLocal(depth, type);
            if (ilStack[depth] is IlLocalValue value && value.Local == slot)
            {
                continue;
            }

            Get(ilStack[depth], type);
            LocalSet(slot);
            ilStack[depth] = new IlLocalValue(entry[depth], slot);
        }
    }

    private void EmitNode(IlGraph graph, int node)
    {
        if (node >= flow.Blocks.Count)
        {
            EmitGroup(flow.Groups[node - flow.Blocks.Count]);
            return;
        }

        var block = flow.Blocks[node];
        ilStack = [.. block.Entry!.Value.Select((slot, depth) => slot.Kind switch
        {
            IlKind.Null => new IlNullValue(),
            IlKind.Token => carried.TryGetValue((node, depth), out var value)
                ? value
                : throw IlError("A stack entry without a value is unsupported here."),
            _ => (IlValue)new IlLocalValue(slot, SlotLocal(depth, IlWType(slot))),
        })];
        for (int index = block.Start; index < block.End; index++)
        {
            ilIndex = index;
            try
            {
                if (EmitIlInstruction(graph, node, index))
                {
                    return;
                }
            }
            catch (CompileError error) when (!Located.IsMatch(error.Message))
            {
                // The module layer's verdicts on what an instruction does
                // (a type test, a type), at the instruction.
                throw IlError(error.Message);
            }
        }

        // Into the next block.
        DoBranch(graph, node, node + 1);
    }

    private void EmitGroup(IlGroup group)
    {
        ilStack = [];
        if (frontend.TwoPass && !group.IsFinally)
        {
            EmitSelectedGroup(group);
            return;
        }

        if (group.IsFinally)
        {
            if (group.Clauses[0].Kind == ExceptionRegionKind.Fault)
            {
                // A fault block runs only when an exception leaves the try
                // block (an iterator's MoveNext disposes itself so), which
                // it then rethrows.
                var caught = new object();
                var endFault = new object();
                OpenBlock(0x02, WType.ExnRef, caught);
                OpenTryTable((0x03, -1, caught)); // catch_all_ref
                EmitArea(group.Try);
                CloseBlock();
                code.Byte(0x00); // unreachable: the try left through a branch
                CloseBlock();
                int thrown = Save(WType.ExnRef);
                OpenBlock(0x02, WType.Void, endFault);
                endFinallyLabels.Push(endFault);
                EmitArea(group.Handlers[0]);
                endFinallyLabels.Pop();
                CloseBlock();
                LocalGet(thrown);
                code.Byte(0x0a); // throw_ref
                return;
            }

            var endFinally = new object();
            EmitTryFinally(
                () => EmitArea(group.Try),
                () =>
                {
                    OpenBlock(0x02, WType.Void, endFinally);
                    endFinallyLabels.Push(endFinally);
                    EmitArea(group.Handlers[0]);
                    endFinallyLabels.Pop();
                    CloseBlock();
                });
            code.Byte(0x00); // unreachable: the try left through a branch
            return;
        }

        var exceptionType = WType.Ref(frontend.ExceptionHeap);
        var handler = new object();
        OpenBlock(0x02, exceptionType, handler);
        OpenTryTable((0x00, 0, handler)); // catch the tag
        EmitArea(group.Try);
        CloseBlock();
        code.Byte(0x00); // unreachable
        CloseBlock();
        int exception = Save(exceptionType);
        RestoreDepth();
        for (int index = 0; index < group.Clauses.Count; index++)
        {
            var next = new object();
            OpenBlock(0x02, WType.Void, next);
            var caught = flow.CatchType(group.Clauses[index]);
            bool all = caught.SpecialType == SpecialType.System_Object
                       || SymbolEqualityComparer.Default.Equals(caught, frontend.ExceptionType);
            var target = all ? exceptionType : frontend.MapType(caught);
            if (!all)
            {
                LocalGet(exception);
                code.RefTest(WType.NonNullRef(target.Heap));
                code.Byte(0x45); // i32.eqz
                Branch(next, true);
            }

            var entry = new IlSlot(IlKind.Ref, caught);
            LocalGet(exception);
            Coerce(exceptionType, IlWType(entry));
            LocalSet(SlotLocal(0, IlWType(entry)));
            caughtExceptions.Push(exception);
            EmitArea(group.Handlers[index]);
            caughtExceptions.Pop();
            CloseBlock();
        }

        LocalGet(exception);
        code.OpIndex(0x08, 0); // throw: no clause takes it
    }

    // MARK: Instructions

    // Lowers one instruction; true when it ended the block.
    private bool EmitIlInstruction(IlGraph graph, int node, int index)
    {
        var instruction = flow.Instructions[index];
        if (plan.Shared is { } shared && shared.SiteAt.TryGetValue(index, out var site) && site.Kind != SiteKind.Direct)
        {
            // Through the exact instantiation's dictionary.
            if (site.Kind == SiteKind.Function)
            {
                EmitFunctionSite(shared, site);
            }
            else
            {
                EmitSiteCall(shared, site);
            }

            return false;
        }

        if (ElementOf(instruction.OpCode) is int arrayDepth && flow.Before[index][^arrayDepth].Kind == IlKind.Null)
        {
            // An element of a null array: the access faults.
            ilStack.RemoveRange(ilStack.Count - arrayDepth, arrayDepth);
            Fault(FaultCode.NullReference);
            if (flow.After[index]!.Value.Length > ilStack.Count)
            {
                var result = flow.After[index]!.Value[^1];
                if (result.Kind == IlKind.Null)
                {
                    ilStack.Add(new IlNullValue());
                }
                else
                {
                    PushDefault(IlWType(result));
                    PushResult(result);
                }
            }

            return false;
        }

        if (flow.Operands[index] is IlPopFirst)
        {
            // A type test folded to its answer (Il.Folding).
            Pop();
        }

        switch (instruction.OpCode)
        {
            case ILOpCode.Nop or ILOpCode.Break or ILOpCode.Readonly or ILOpCode.Volatile or ILOpCode.Tail
                or ILOpCode.Unaligned or ILOpCode.Constrained:
                return false;
            case ILOpCode.Ldarg:
                LoadArgument((int)instruction.Operand);
                return false;
            case ILOpCode.Ldarga:
                ilStack.Add(new IlRefValue(flow.After[index]!.Value[^1], ArgumentPlace((int)instruction.Operand), null));
                return false;
            case ILOpCode.Starg:
                StoreArgument((int)instruction.Operand);
                return false;
            case ILOpCode.Ldloc:
                LoadIlLocal((int)instruction.Operand);
                return false;
            case ILOpCode.Ldloca:
                ilStack.Add(new IlRefValue(flow.After[index]!.Value[^1], LocalPlace((int)instruction.Operand), null));
                return false;
            case ILOpCode.Stloc:
                StoreIlLocal((int)instruction.Operand);
                return false;
            case ILOpCode.Ldnull:
                ilStack.Add(new IlNullValue());
                return false;
            case IlPseudo.NewResume:
                EmitNewResume();
                return false;
            case IlPseudo.StepReturn:
                Branch(returnLabel);
                return true;
            case ILOpCode.Ldc_i4:
                code.I32((int)instruction.Operand);
                PushResult();
                ilStack[^1] = ((IlLocalValue)ilStack[^1]) with { Constant = (int)instruction.Operand };
                return false;
            case ILOpCode.Ldc_i8:
                code.I64(instruction.Operand);
                PushResult();
                return false;
            case ILOpCode.Ldc_r4:
                code.Const(WType.F32, instruction.Real);
                PushResult();
                return false;
            case ILOpCode.Ldc_r8:
                code.Const(WType.F64, instruction.Real);
                PushResult();
                return false;
            case ILOpCode.Ldstr:
                EmitLiteral((string)flow.Operands[index]!);
                PushResult();
                ilStack[^1] = ((IlLocalValue)ilStack[^1]) with { Constant = (string)flow.Operands[index]! };
                return false;
            case ILOpCode.Dup:
                if (ilStack[^1] is IlBoxedValue)
                {
                    // One box, both copies of the reference its.
                    Get(Pop(), ObjectRef);
                    PushResult(flow.Before[index][^1]);
                }

                ilStack.Add(ilStack[^1]);
                return false;
            case ILOpCode.Pop:
                Pop();
                return false;
            case ILOpCode.Call or ILOpCode.Callvirt:
                EmitIlCall(index);
                return false;
            case ILOpCode.Newobj:
                EmitIlNewObject(index);
                return false;
            case ILOpCode.Ret:
                if (returnSlot >= 0)
                {
                    if (Peek() is IlRefValue { Place: { Kind: LocationKind.Local, Boxed: false } })
                    {
                        // An `in` parameter's, say: passed here as a value,
                        // so a reference to it is to a copy, which would not
                        // alias the caller's variable.
                        throw IlError("A reference to this storage is unsupported: it would be to a copy.");
                    }

                    Get(Pop(), plan.Result);
                    LocalSet(returnSlot);
                }

                Branch(returnLabel);
                return true;
            case ILOpCode.Br or ILOpCode.Leave:
                if (instruction.OpCode == ILOpCode.Leave)
                {
                    ilStack.Clear();
                }

                DoBranch(graph, node, flow.BlockOf[flow.Code.IndexOf[instruction.Target]]);
                return true;
            case ILOpCode.Brtrue or ILOpCode.Brfalse:
                EmitTruth(Pop());
                if (instruction.OpCode == ILOpCode.Brfalse)
                {
                    code.Byte(0x45); // i32.eqz
                }

                EmitConditionalBranch(graph, node, index);
                return true;
            case ILOpCode.Beq or ILOpCode.Bne_un or ILOpCode.Bge or ILOpCode.Bge_un or ILOpCode.Bgt or ILOpCode.Bgt_un
                or ILOpCode.Ble or ILOpCode.Ble_un or ILOpCode.Blt or ILOpCode.Blt_un:
                EmitComparison(PredicateOf(instruction.OpCode));
                EmitConditionalBranch(graph, node, index);
                return true;
            case ILOpCode.Switch:
                EmitSwitchBranch(graph, node, index);
                return true;
            case ILOpCode.Ceq or ILOpCode.Cgt or ILOpCode.Cgt_un or ILOpCode.Clt or ILOpCode.Clt_un:
                EmitComparison(PredicateOf(instruction.OpCode));
                PushResult();
                return false;
            case ILOpCode.Add or ILOpCode.Sub or ILOpCode.Mul or ILOpCode.Div or ILOpCode.Div_un or ILOpCode.Rem
                or ILOpCode.Rem_un or ILOpCode.And or ILOpCode.Or or ILOpCode.Xor or ILOpCode.Shl or ILOpCode.Shr
                or ILOpCode.Shr_un or ILOpCode.Add_ovf or ILOpCode.Add_ovf_un or ILOpCode.Mul_ovf
                or ILOpCode.Mul_ovf_un or ILOpCode.Sub_ovf or ILOpCode.Sub_ovf_un:
                EmitIlArithmetic(instruction.OpCode);
                return false;
            case ILOpCode.Neg or ILOpCode.Not:
                EmitIlUnary(instruction.OpCode);
                return false;
            case ILOpCode.Conv_i1 or ILOpCode.Conv_i2 or ILOpCode.Conv_i4 or ILOpCode.Conv_i8 or ILOpCode.Conv_r4
                or ILOpCode.Conv_r8 or ILOpCode.Conv_u4 or ILOpCode.Conv_u8 or ILOpCode.Conv_r_un or ILOpCode.Conv_u2
                or ILOpCode.Conv_u1 or ILOpCode.Conv_i or ILOpCode.Conv_u or ILOpCode.Conv_ovf_i1
                or ILOpCode.Conv_ovf_u1 or ILOpCode.Conv_ovf_i2 or ILOpCode.Conv_ovf_u2 or ILOpCode.Conv_ovf_i4
                or ILOpCode.Conv_ovf_u4 or ILOpCode.Conv_ovf_i8 or ILOpCode.Conv_ovf_u8 or ILOpCode.Conv_ovf_i
                or ILOpCode.Conv_ovf_u or ILOpCode.Conv_ovf_i1_un or ILOpCode.Conv_ovf_i2_un
                or ILOpCode.Conv_ovf_i4_un or ILOpCode.Conv_ovf_i8_un or ILOpCode.Conv_ovf_u1_un
                or ILOpCode.Conv_ovf_u2_un or ILOpCode.Conv_ovf_u4_un or ILOpCode.Conv_ovf_u8_un
                or ILOpCode.Conv_ovf_i_un or ILOpCode.Conv_ovf_u_un:
                EmitIlConversion(instruction.OpCode);
                return false;
            case ILOpCode.Ldind_i1 or ILOpCode.Ldind_u1 or ILOpCode.Ldind_i2 or ILOpCode.Ldind_u2 or ILOpCode.Ldind_i4
                or ILOpCode.Ldind_u4 or ILOpCode.Ldind_i8 or ILOpCode.Ldind_i or ILOpCode.Ldind_r4 or ILOpCode.Ldind_r8
                or ILOpCode.Ldind_ref or ILOpCode.Ldobj:
                LoadIndirect();
                return false;
            case ILOpCode.Stind_i1 or ILOpCode.Stind_i2 or ILOpCode.Stind_i4 or ILOpCode.Stind_i8 or ILOpCode.Stind_r4
                or ILOpCode.Stind_r8 or ILOpCode.Stind_ref or ILOpCode.Stind_i or ILOpCode.Stobj:
                StoreIndirect();
                return false;
            case ILOpCode.Initobj:
                InitializeIndirect((ITypeSymbol)flow.Operands[index]!);
                return false;
            case ILOpCode.Cpobj:
                var source = Pop();
                var destination = Pop();
                ilStack.Add(destination);
                ilStack.Add(source);
                LoadIndirectFrom(Pop(), (ITypeSymbol)flow.Operands[index]!);
                StoreIndirect();
                return false;
            case ILOpCode.Ldfld:
                LoadIlField((ISymbol)flow.Operands[index]!);
                return false;
            case ILOpCode.Ldflda:
                LoadIlFieldAddress((ISymbol)flow.Operands[index]!);
                return false;
            case ILOpCode.Stfld:
                StoreIlField((ISymbol)flow.Operands[index]!);
                return false;
            case ILOpCode.Ldsfld:
                LoadIlStaticField((ISymbol)flow.Operands[index]!);
                return false;
            case ILOpCode.Ldsflda:
                var staticField = (ISymbol)flow.Operands[index]!;
                if (staticField is IFieldSymbol dataField && frontend.HasInitialData(dataField))
                {
                    ilStack.Add(new IlDataValue(FieldBytes(dataField)));
                    return false;
                }

                if (staticField is IFieldSymbol { IsConst: true, HasConstantValue: true } constantField)
                {
                    // A decimal constant's address: a copy of its value.
                    EmitConstant(constantField.Type, constantField.ConstantValue);
                    var constantType = frontend.MapType(constantField.Type);
                    ilStack.Add(new IlRefValue(
                        new(IlKind.ByRef, constantField.Type),
                        new Location(LocationKind.Local, constantType, constantField.Type, Local: Save(constantType), ReadOnly: true),
                        null));
                    return false;
                }

                var staticPlace = StaticFieldLocation(staticField);
                ilStack.Add(new IlRefValue(new(IlKind.ByRef, Frontend.StorageType(staticField)), staticPlace, staticField));
                return false;
            case ILOpCode.Stsfld:
                var stored = (ISymbol)flow.Operands[index]!;
                if (stored is IFieldSymbol { IsConst: true })
                {
                    // A decimal constant's static constructor store: every
                    // read is of the constant.
                    Pop();
                    return false;
                }

                var storedPlace = StaticFieldLocation(stored);
                Store(storedPlace, GetLocal(Pop(), storedPlace.Type));
                return false;
            case ILOpCode.Newarr:
                EmitIlNewArray((ITypeSymbol)flow.Operands[index]!);
                return false;
            case ILOpCode.Ldlen:
                int lengthArray = GetLocal(Pop(), IlWType(flow.Before[index][^1]));
                CheckNull(lengthArray);
                LocalGet(lengthArray);
                code.Gc(15); // array.len
                code.Byte(0xad); // i64.extend_i32_u
                PushResult();
                return false;
            case ILOpCode.Ldelem or ILOpCode.Ldelem_i1 or ILOpCode.Ldelem_u1 or ILOpCode.Ldelem_i2
                or ILOpCode.Ldelem_u2 or ILOpCode.Ldelem_i4 or ILOpCode.Ldelem_u4 or ILOpCode.Ldelem_i8
                or ILOpCode.Ldelem_i or ILOpCode.Ldelem_r4 or ILOpCode.Ldelem_r8 or ILOpCode.Ldelem_ref:
                Load(PrepareIlElement());
                PushResult();
                return false;
            case ILOpCode.Ldelema:
                var element = PrepareIlElement();
                ilStack.Add(new IlRefValue(flow.After[index]!.Value[^1], Pinned(element), null));
                if (element.Boxed)
                {
                    // A struct element: its box, now.
                    var reference = (IlRefValue)Pop();
                    LocalGet(Materialize(reference));
                    PushResult();
                }

                return false;
            case ILOpCode.Stelem or ILOpCode.Stelem_i1 or ILOpCode.Stelem_i2 or ILOpCode.Stelem_i4
                or ILOpCode.Stelem_i8 or ILOpCode.Stelem_r4 or ILOpCode.Stelem_r8 or ILOpCode.Stelem_ref
                or ILOpCode.Stelem_i:
                var value = Pop();
                var target = PrepareIlElement();
                Store(target, GetLocal(value, target.Type));
                return false;
            case ILOpCode.Box:
                EmitIlBox((ITypeSymbol)flow.Operands[index]!);
                return false;
            case ILOpCode.Unbox_any:
                EmitIlUnboxAny((ITypeSymbol)flow.Operands[index]!);
                return false;
            case ILOpCode.Unbox:
                EmitIlUnbox((ITypeSymbol)flow.Operands[index]!);
                return false;
            case ILOpCode.Castclass or ILOpCode.Isinst:
                EmitIlCast((ITypeSymbol)flow.Operands[index]!, instruction.OpCode == ILOpCode.Isinst);
                return false;
            case ILOpCode.Throw:
                EmitIlThrow(Pop());
                return true;
            case ILOpCode.Rethrow:
                if (caughtExceptions.Count == 0)
                {
                    throw IlError("rethrow outside a catch handler.");
                }

                if (frontend.TwoPass)
                {
                    EmitRaise(caughtExceptions.Peek());
                    return true;
                }

                LocalGet(caughtExceptions.Peek());
                code.OpIndex(0x08, 0); // throw
                return true;
            case ILOpCode.Endfilter:
                EmitEndFilter();
                return true;
            case ILOpCode.Endfinally:
                ilStack.Clear();
                Branch(endFinallyLabels.Peek());
                return true;
            case ILOpCode.Ldtoken:
                ilStack.Add(new IlTokenValue((ISymbol)flow.Operands[index]!));
                return false;
            case ILOpCode.Ldftn:
                ilStack.Add(new IlMethodValue((IMethodSymbol)flow.Operands[index]!, false));
                return false;
            case ILOpCode.Ldvirtftn:
                Pop();
                ilStack.Add(new IlMethodValue((IMethodSymbol)flow.Operands[index]!, true));
                return false;
            case ILOpCode.Sizeof:
                var sized = (ITypeSymbol)flow.Operands[index]!;
                int width = Frontend.ScalarOf(sized) switch
                {
                    Scalar.Bool or Scalar.I8 or Scalar.U8 => 1,
                    Scalar.I16 or Scalar.U16 or Scalar.Char => 2,
                    Scalar.I32 or Scalar.U32 or Scalar.F32 => 4,
                    Scalar.I64 or Scalar.U64 or Scalar.F64 => 8,
                    _ => throw IlError($"sizeof({sized.ToDisplayString()}) is unsupported: structs have no byte layout here."),
                };
                code.I32(width);
                PushResult();
                ilStack[^1] = ((IlLocalValue)ilStack[^1]) with { Constant = width };
                return false;
            case ILOpCode.Cpblk:
                var length = Pop();
                var data = Pop();
                var blockTarget = Pop();
                if (blockTarget is not IlStackValue { Offset: 0 } block || data is not IlDataValue { Bytes: var copied }
                    || ConstantOf(length) is not int size)
                {
                    throw IlError("cpblk other than a stackalloc initializer's of a field's data is unsupported.");
                }

                block.Block.Data = copied.AsSpan(0, Math.Min(size, copied.Length)).ToArray();
                return false;
            case ILOpCode.Localloc:
                // stackalloc: a span's constructor makes the array.
                Pop();
                ilStack.Add(new IlStackValue(new IlStackBlock(), 0));
                return false;
            case ILOpCode.Ckfinite:
                var checkedValue = Peek();
                int finite = GetLocal(checkedValue, IlWType(flow.Before[index][^1]));
                bool single = flow.Before[index][^1].Kind == IlKind.F32;
                LocalGet(finite);
                code.Byte(single ? (byte)0x8b : (byte)0x99); // abs
                code.Const(single ? WType.F32 : WType.F64, double.PositiveInfinity);
                code.Byte(single ? (byte)0x5d : (byte)0x63); // lt: false for NaN and infinities
                code.Byte(0x45); // i32.eqz
                FaultIf(FaultCode.DivisionOverflow);
                return false;
            default:
                throw IlError($"The IL instruction '{instruction.OpCode}' is unsupported.");
        }
    }

    // How deep an element instruction's array is on the stack, or null.
    private static int? ElementOf(ILOpCode opcode) => opcode switch
    {
        ILOpCode.Ldelem or ILOpCode.Ldelem_i1 or ILOpCode.Ldelem_u1 or ILOpCode.Ldelem_i2 or ILOpCode.Ldelem_u2
            or ILOpCode.Ldelem_i4 or ILOpCode.Ldelem_u4 or ILOpCode.Ldelem_i8 or ILOpCode.Ldelem_i or ILOpCode.Ldelem_r4
            or ILOpCode.Ldelem_r8 or ILOpCode.Ldelem_ref or ILOpCode.Ldelema or ILOpCode.Ldlen => opcode == ILOpCode.Ldlen ? 1 : 2,
        ILOpCode.Stelem or ILOpCode.Stelem_i1 or ILOpCode.Stelem_i2 or ILOpCode.Stelem_i4 or ILOpCode.Stelem_i8
            or ILOpCode.Stelem_r4 or ILOpCode.Stelem_r8 or ILOpCode.Stelem_ref or ILOpCode.Stelem_i => 3,
        _ => null,
    };

    private void EmitConditionalBranch(IlGraph graph, int node, int index)
    {
        var instruction = flow.Instructions[index];
        var block = flow.Blocks[node];
        int taken = flow.BlockOf[flow.Code.IndexOf[instruction.Target]];
        var saved = ilStack.ToList();
        OpenBlock(0x04, WType.Void, new object()); // if
        DoBranch(graph, node, taken);
        code.Byte(0x05); // else
        ilStack = saved;
        DoBranch(graph, node, block.Index + 1);
        CloseBlock();
    }

    private void EmitSwitchBranch(IlGraph graph, int node, int index)
    {
        var instruction = flow.Instructions[index];
        var targets = instruction.Targets!.Select(offset => flow.BlockOf[flow.Code.IndexOf[offset]]).ToList();
        int fallthrough = node + 1;
        int selector = GetLocal(Pop(), WType.I32);
        var distinct = targets.Append(fallthrough).Distinct().ToList();
        var saved = ilStack.ToList();
        var caseLabels = distinct.Select(_ => new object()).ToList();
        // One block per distinct target, the first innermost; br_table
        // picks the block to leave, after which that target's branch runs.
        for (int label = distinct.Count - 1; label >= 0; label--)
        {
            OpenBlock(0x02, WType.Void, caseLabels[label]);
        }

        LocalGet(selector);
        code.Byte(0x0e); // br_table
        code.Index(targets.Count);
        foreach (int target in targets)
        {
            code.Index(LabelDepth(caseLabels[distinct.IndexOf(target)]));
        }

        code.Index(LabelDepth(caseLabels[distinct.IndexOf(fallthrough)]));
        for (int label = 0; label < distinct.Count; label++)
        {
            CloseBlock();
            ilStack = saved.ToList();
            DoBranch(graph, node, distinct[label]);
        }
    }

    // The i32 truth of a value: non-zero, or a non-null reference.
    private void EmitTruth(IlValue value)
    {
        switch (value)
        {
            case IlNullValue:
                code.I32(0);
                return;
            case IlLocalValue local when local.Type.Kind == IlKind.I32:
                LocalGet(local.Local);
                return;
            case IlLocalValue local when local.Type.Kind == IlKind.I64:
                LocalGet(local.Local);
                code.Byte(0x50); // i64.eqz
                code.Byte(0x45); // i32.eqz
                return;
            case IlLocalValue local when local.Type.Kind is IlKind.Ref or IlKind.ByRef:
                LocalGet(local.Local);
                code.Byte(0xd1); // ref.is_null
                code.Byte(0x45); // i32.eqz
                return;
            case IlRefValue or IlBoxedValue:
                code.I32(1);
                return;
            default:
                throw IlError($"{value} has no truth value.");
        }
    }

    private static Scalar IlScalar(IlKind kind, bool unsigned) => kind switch
    {
        IlKind.I32 => unsigned ? Scalar.U32 : Scalar.I32,
        IlKind.I64 => unsigned ? Scalar.U64 : Scalar.I64,
        IlKind.F32 => Scalar.F32,
        IlKind.F64 => Scalar.F64,
        _ => throw new InternalCompilerError($"{kind} is not a scalar."),
    };

    // The comparisons IL branches and compares by. The .un ones of floats
    // are true when the operands are unordered; of integers, unsigned.
    private enum IlPredicate
    {
        Eq,
        Ne,
        Ge,
        Gt,
        Le,
        Lt,
        GeUn,
        GtUn,
        LeUn,
        LtUn,
    }

    private static IlPredicate PredicateOf(ILOpCode opcode) => opcode switch
    {
        ILOpCode.Beq or ILOpCode.Ceq => IlPredicate.Eq,
        ILOpCode.Bne_un => IlPredicate.Ne,
        ILOpCode.Bge => IlPredicate.Ge,
        ILOpCode.Bge_un => IlPredicate.GeUn,
        ILOpCode.Bgt or ILOpCode.Cgt => IlPredicate.Gt,
        ILOpCode.Bgt_un or ILOpCode.Cgt_un => IlPredicate.GtUn,
        ILOpCode.Ble => IlPredicate.Le,
        ILOpCode.Ble_un => IlPredicate.LeUn,
        ILOpCode.Blt or ILOpCode.Clt => IlPredicate.Lt,
        _ => IlPredicate.LtUn,
    };

    private void EmitComparison(IlPredicate predicate)
    {
        var right = Pop();
        var left = Pop();
        var leftType = flow.Before[ilIndex][^2];
        var rightType = flow.Before[ilIndex][^1];
        bool references = leftType.Kind is IlKind.Ref or IlKind.Null or IlKind.ByRef
                          || rightType.Kind is IlKind.Ref or IlKind.Null or IlKind.ByRef;
        if (references)
        {
            // Reference equality; `x > null` (cgt.un) is `x != null`.
            if (leftType.Kind == IlKind.Null || rightType.Kind == IlKind.Null)
            {
                var other = leftType.Kind == IlKind.Null ? right : left;
                if (other is IlNullValue)
                {
                    code.I32(1);
                }
                else
                {
                    Get(other, WType.Ref(Frontend.EqHeap));
                    code.Byte(0xd1); // ref.is_null
                }
            }
            else
            {
                Get(left, WType.Ref(Frontend.EqHeap));
                Get(right, WType.Ref(Frontend.EqHeap));
                code.Byte(0xd3); // ref.eq
            }

            if (predicate != IlPredicate.Eq)
            {
                code.Byte(0x45); // i32.eqz
            }

            return;
        }

        var kind = leftType.Kind == IlKind.I64 || rightType.Kind == IlKind.I64 ? IlKind.I64 : leftType.Kind;
        bool floating = kind is IlKind.F32 or IlKind.F64;
        var wasm = IlWType(new IlSlot(kind));
        Get(left, wasm);
        Get(right, wasm);
        bool unsigned = predicate is IlPredicate.GeUn or IlPredicate.GtUn or IlPredicate.LeUn or IlPredicate.LtUn;
        if (floating && unsigned)
        {
            // Unordered or greater: not less-or-equal; and so on.
            code.Byte(BinaryOpcode(IlScalar(kind, false), predicate switch
            {
                IlPredicate.GeUn => BinaryOperatorKind.LessThan,
                IlPredicate.GtUn => BinaryOperatorKind.LessThanOrEqual,
                IlPredicate.LeUn => BinaryOperatorKind.GreaterThan,
                _ => BinaryOperatorKind.GreaterThanOrEqual,
            }));
            code.Byte(0x45); // i32.eqz
            return;
        }

        code.Byte(BinaryOpcode(IlScalar(kind, unsigned), predicate switch
        {
            IlPredicate.Eq => BinaryOperatorKind.Equals,
            IlPredicate.Ne => BinaryOperatorKind.NotEquals,
            IlPredicate.Ge or IlPredicate.GeUn => BinaryOperatorKind.GreaterThanOrEqual,
            IlPredicate.Gt or IlPredicate.GtUn => BinaryOperatorKind.GreaterThan,
            IlPredicate.Le or IlPredicate.LeUn => BinaryOperatorKind.LessThanOrEqual,
            _ => BinaryOperatorKind.LessThan,
        }));
    }

    private void EmitIlArithmetic(ILOpCode opcode)
    {
        if (Peek(1) is IlStackValue memory)
        {
            // An element's address in stackalloc'd memory: a known offset.
            var offset = Pop();
            Pop();
            if (opcode != ILOpCode.Add || ConstantOf(offset) is not int bytes)
            {
                throw IlError("stackalloc'd memory is only indexed at constant offsets here.");
            }

            ilStack.Add(memory with { Offset = memory.Offset + bytes });
            return;
        }

        var right = Pop();
        var left = Pop();
        var leftType = flow.Before[ilIndex][^2];
        var rightType = flow.Before[ilIndex][^1];
        var result = flow.After[ilIndex]!.Value[^1];
        bool shift = opcode is ILOpCode.Shl or ILOpCode.Shr or ILOpCode.Shr_un;
        var kind = shift ? leftType.Kind : result.Kind;
        var wasm = IlWType(new IlSlot(kind));
        bool unsigned = opcode is ILOpCode.Div_un or ILOpCode.Rem_un or ILOpCode.Shr_un or ILOpCode.Add_ovf_un
            or ILOpCode.Mul_ovf_un or ILOpCode.Sub_ovf_un;
        var scalar = IlScalar(kind, unsigned);
        Get(left, wasm);
        if (shift)
        {
            Get(right, rightType.Kind == IlKind.I64 ? WType.I64 : WType.I32);
            if (wasm == WType.I64 && rightType.Kind != IlKind.I64)
            {
                code.Byte(0xad); // i64.extend_i32_u
            }
            else if (wasm == WType.I32 && rightType.Kind == IlKind.I64)
            {
                code.Byte(0xa7); // i32.wrap_i64
            }
        }
        else
        {
            Get(right, wasm);
        }

        var operation = opcode switch
        {
            ILOpCode.Add or ILOpCode.Add_ovf or ILOpCode.Add_ovf_un => BinaryOperatorKind.Add,
            ILOpCode.Sub or ILOpCode.Sub_ovf or ILOpCode.Sub_ovf_un => BinaryOperatorKind.Subtract,
            ILOpCode.Mul or ILOpCode.Mul_ovf or ILOpCode.Mul_ovf_un => BinaryOperatorKind.Multiply,
            ILOpCode.Div or ILOpCode.Div_un => BinaryOperatorKind.Divide,
            ILOpCode.Rem or ILOpCode.Rem_un => BinaryOperatorKind.Remainder,
            ILOpCode.And => BinaryOperatorKind.And,
            ILOpCode.Or => BinaryOperatorKind.Or,
            ILOpCode.Xor => BinaryOperatorKind.ExclusiveOr,
            ILOpCode.Shl => BinaryOperatorKind.LeftShift,
            ILOpCode.Shr => BinaryOperatorKind.RightShift,
            _ => BinaryOperatorKind.UnsignedRightShift,
        };
        bool isChecked = opcode is ILOpCode.Add_ovf or ILOpCode.Add_ovf_un or ILOpCode.Sub_ovf or ILOpCode.Sub_ovf_un
            or ILOpCode.Mul_ovf or ILOpCode.Mul_ovf_un;
        EmitNumericBinary(scalar, operation, isChecked);
        PushResult();
        if (ConstantOf(left) is int a && ConstantOf(right) is int b && opcode is ILOpCode.Mul or ILOpCode.Add)
        {
            // Offsets of stackalloc initializers' elements.
            ilStack[^1] = ((IlLocalValue)ilStack[^1]) with { Constant = opcode == ILOpCode.Mul ? a * b : a + b };
        }
    }

    private void EmitIlUnary(ILOpCode opcode)
    {
        var value = Pop();
        var type = flow.Before[ilIndex][^1];
        var wasm = IlWType(type);
        if (opcode == ILOpCode.Neg && type.Kind is IlKind.F32 or IlKind.F64)
        {
            Get(value, wasm);
            code.Byte(type.Kind == IlKind.F32 ? (byte)0x8c : (byte)0x9a); // neg
            PushResult();
            return;
        }

        if (opcode == ILOpCode.Neg)
        {
            code.Const(wasm, 0L);
            Get(value, wasm);
            code.Byte(wasm == WType.I64 ? (byte)0x7d : (byte)0x6b); // sub
            PushResult();
            return;
        }

        Get(value, wasm);
        code.Const(wasm, -1L);
        code.Byte(wasm == WType.I64 ? (byte)0x85 : (byte)0x73); // xor
        PushResult();
    }

    private void EmitIlConversion(ILOpCode opcode)
    {
        var value = Pop();
        var type = flow.Before[ilIndex][^1];
        bool unsignedSource = opcode is ILOpCode.Conv_r_un or ILOpCode.Conv_ovf_i1_un or ILOpCode.Conv_ovf_i2_un
            or ILOpCode.Conv_ovf_i4_un or ILOpCode.Conv_ovf_i8_un or ILOpCode.Conv_ovf_u1_un or ILOpCode.Conv_ovf_u2_un
            or ILOpCode.Conv_ovf_u4_un or ILOpCode.Conv_ovf_u8_un or ILOpCode.Conv_ovf_i_un or ILOpCode.Conv_ovf_u_un;
        var source = IlScalar(type.Kind, unsignedSource);
        if (!unsignedSource && opcode is ILOpCode.Conv_u8 or ILOpCode.Conv_u && type.Kind == IlKind.I32)
        {
            // Zero-extended, as conv.u8 of an int32 is.
            source = Scalar.U32;
        }

        var destination = opcode switch
        {
            ILOpCode.Conv_i1 or ILOpCode.Conv_ovf_i1 or ILOpCode.Conv_ovf_i1_un => Scalar.I8,
            ILOpCode.Conv_u1 or ILOpCode.Conv_ovf_u1 or ILOpCode.Conv_ovf_u1_un => Scalar.U8,
            ILOpCode.Conv_i2 or ILOpCode.Conv_ovf_i2 or ILOpCode.Conv_ovf_i2_un => Scalar.I16,
            ILOpCode.Conv_u2 or ILOpCode.Conv_ovf_u2 or ILOpCode.Conv_ovf_u2_un => Scalar.U16,
            ILOpCode.Conv_i4 or ILOpCode.Conv_ovf_i4 or ILOpCode.Conv_ovf_i4_un => Scalar.I32,
            ILOpCode.Conv_u4 or ILOpCode.Conv_ovf_u4 or ILOpCode.Conv_ovf_u4_un => Scalar.U32,
            ILOpCode.Conv_i8 or ILOpCode.Conv_ovf_i8 or ILOpCode.Conv_ovf_i8_un or ILOpCode.Conv_i or ILOpCode.Conv_ovf_i
                or ILOpCode.Conv_ovf_i_un => Scalar.I64,
            ILOpCode.Conv_u8 or ILOpCode.Conv_ovf_u8 or ILOpCode.Conv_ovf_u8_un or ILOpCode.Conv_u or ILOpCode.Conv_ovf_u
                or ILOpCode.Conv_ovf_u_un => Scalar.U64,
            ILOpCode.Conv_r4 => Scalar.F32,
            _ => Scalar.F64,
        };
        Get(value, IlWType(type));
        bool isChecked = opcode.ToString().Contains("ovf", StringComparison.Ordinal);
        if (isChecked)
        {
            // A size that overflows is an invalid array length, as the CLR
            // reports a new array's.
            bool size = ilIndex + 1 < flow.Instructions.Length && flow.Instructions[ilIndex + 1].OpCode == ILOpCode.Newarr;
            CheckConversion(source, destination, size ? FaultCode.InvalidArrayLength : FaultCode.ArithmeticOverflow);
        }

        EmitScalarConversion(source, destination);
        PushResult();
        if (ConstantOf(value) is int constant && opcode is ILOpCode.Conv_i or ILOpCode.Conv_u or ILOpCode.Conv_i4)
        {
            ilStack[^1] = ((IlLocalValue)ilStack[^1]) with { Constant = constant };
        }
    }

    // MARK: Locals, arguments and fields

    private Location LocalPlace(int number)
    {
        var local = flow.Locals[number];
        var mapped = frontend.MapType(local.Type);
        if (local.ByRef)
        {
            // What a ref local refers to.
            return ReferenceLocation(ilLocals[number], local.Type);
        }

        return ilLocalBoxed[number]
            ? new(LocationKind.Local, mapped, local.Type, Local: ilLocals[number], Boxed: true, NonNull: true)
            : new(LocationKind.Local, mapped, local.Type, Local: ilLocals[number]);
    }

    private void LoadIlLocal(int number)
    {
        var local = flow.Locals[number];
        if (local.ByRef)
        {
            LocalGet(ilLocals[number]);
            PushResult();
            return;
        }

        if (!ilLocalBoxed[number] && ilIndex + 1 < flow.Instructions.Length
            && flow.Instructions[ilIndex + 1].OpCode == ILOpCode.Ldfld && flow.BlockOf[ilIndex + 1] == flow.BlockOf[ilIndex])
        {
            // Read for one of its fields (ldloc; ldfld), which the next
            // instruction reads from the local itself before anything can
            // store to it: no copy of the whole value.
            ilStack.Add(new IlLocalValue(flow.After[ilIndex]!.Value[^1], ilLocals[number]));
            return;
        }

        Load(LocalPlace(number));
        PushResult();
    }

    private void StoreIlLocal(int number)
    {
        var local = flow.Locals[number];
        var value = Pop();
        if (value is IlLocalValue { Constant: byte[] data })
        {
            ilLocalData[number] = data;
        }
        else
        {
            ilLocalData.Remove(number);
        }

        if (local.ByRef)
        {
            Get(value, frontend.RefParameterType(local.Type));
            LocalSet(ilLocals[number]);
            return;
        }

        var place = LocalPlace(number);
        if (!place.Boxed)
        {
            Get(value, place.Type);
            LocalSet(place.Local);
            return;
        }

        Store(place, GetLocal(value, place.Type));
    }

    private Location ArgumentPlace(int number)
    {
        var slot = flow.Arguments[number];
        int storage = ilArguments[number];
        if (slot.Kind == IlKind.ByRef)
        {
            var parameter = plan.Symbol!.IsStatic || number > 0
                ? plan.Symbol.Parameters[number - (plan.Symbol.IsStatic ? 0 : 1)]
                : null;
            if (parameter is { RefKind: RefKind.In })
            {
                // An `in` parameter is its value here.
                return new(LocationKind.Local, frontend.MapType(slot.Type), slot.Type!, Local: storage, ReadOnly: true);
            }

            return ReferenceLocation(storage, slot.Type!);
        }

        var mapped = IlWType(slot);
        return ilArgumentBoxed[number]
            ? new(LocationKind.Local, mapped, slot.Type!, Local: storage, Boxed: true, NonNull: true)
            : new(LocationKind.Local, mapped, slot.Type!, Local: storage);
    }

    private void LoadArgument(int number)
    {
        var slot = flow.Arguments[number];
        if (slot.Kind == IlKind.ByRef)
        {
            ilStack.Add(new IlRefValue(slot, ArgumentPlace(number), null));
            return;
        }

        if (!ilArgumentStored[number] && !ilArgumentBoxed[number])
        {
            // Never stored to: the argument's own local.
            ilStack.Add(new IlLocalValue(slot, ilArguments[number]));
            return;
        }

        Load(ArgumentPlace(number));
        PushResult(slot);
    }

    private void StoreArgument(int number)
    {
        var place = ArgumentPlace(number);
        var value = Pop();
        if (flow.Arguments[number].Kind == IlKind.ByRef || !place.Boxed)
        {
            Get(value, place.Type);
            LocalSet(place.Local);
            return;
        }

        Store(place, GetLocal(value, place.Type));
    }

    // A class instance field of the object a value holds, checked for null.
    private Location InstanceFieldLocation(IlValue receiver, ISymbol field, bool check = true)
    {
        var container = frontend.MapType(field.ContainingType);
        // The receiver's own local when it holds a subclass: it is only
        // read, and struct.get and struct.set take a subtype.
        int local = receiver is IlLocalValue { Type.Kind: IlKind.Ref } own && IlLocalType(own.Local) is { IsRef: true } ownType
                    && container.IsRef && frontend.IsSubtypeHeap(ownType.Heap, container.Heap)
            ? own.Local
            : GetLocal(receiver, container);
        if (check)
        {
            CheckNull(local);
        }

        var storageType = Frontend.StorageType(field);
        var type = frontend.MapType(frontend.FieldStorageType(field));
        return new(
            LocationKind.Field, type, storageType, Receiver: local, Container: container,
            Field: frontend.FieldIndex(field), Boxed: type.IsTuple, NonNull: true);
    }

    private Location StaticFieldLocation(ISymbol field)
    {
        var storageType = Frontend.StorageType(field);
        var type = frontend.MapType(storageType);
        return new(
            LocationKind.Global, type, storageType, Global: frontend.GlobalIndex(field), Boxed: type.IsTuple,
            Class: field.ContainingType);
    }

    // A field of the struct or object a receiver (an object, a reference,
    // or a struct value) holds.
    private Location FieldLocation(IlValue receiver, IlSlot receiverType, ISymbol storage)
    {
        if (receiverType.Kind is IlKind.Ref or IlKind.Null)
        {
            return InstanceFieldLocation(receiver, storage);
        }

        var field = storage as IFieldSymbol ?? throw IlError($"'{storage.ToDisplayString()}' of a struct is unsupported.");
        switch (receiverType.Kind)
        {
            case IlKind.ByRef:
                return FieldOfPlace(PlaceOf(receiver), field, readOnly: false);
            case IlKind.Value:
                var type = frontend.MapType(receiverType.Type);
                int value = GetLocal(receiver, type);
                return FieldOfPlace(new(LocationKind.Local, type, receiverType.Type!, Local: value), field, readOnly: false);
            default:
                throw IlError($"A field of {receiverType} is unsupported.");
        }
    }

    private void LoadIlField(ISymbol field)
    {
        var receiverType = flow.Before[ilIndex][^1];
        LoadResult(FieldLocation(Pop(), receiverType, field));
    }

    // Loads a location as the instruction's result: a shared
    // instantiation's storage holds its canonical type's values, which
    // the stack has exactly (Frontend.Sharing).
    private void LoadResult(Location location)
    {
        Load(location);
        Coerce(location.Type, IlWType(flow.After[ilIndex]!.Value[^1]));
        PushResult();
    }

    private void LoadIlFieldAddress(ISymbol field)
    {
        var receiverType = flow.Before[ilIndex][^1];
        var place = FieldLocation(Pop(), receiverType, field);
        var reference = new IlRefValue(new(IlKind.ByRef, Frontend.StorageType(field)), place, field);
        if (place.Boxed)
        {
            // A struct field's box.
            LocalGet(Materialize(reference));
            PushResult();
            return;
        }

        ilStack.Add(reference with { Place = Pinned(place) });
    }

    private void StoreIlField(ISymbol field)
    {
        var value = Pop();
        var receiverType = flow.Before[ilIndex][^2];
        var place = FieldLocation(Pop(), receiverType, field);
        Store(place, GetLocal(value, place.Type));
    }

    private void LoadIlStaticField(ISymbol field)
    {
        if (field is { Name: "Empty", ContainingType.SpecialType: SpecialType.System_String })
        {
            EmitLiteral("");
            PushResult();
            return;
        }

        if (field is IFieldSymbol { IsConst: true, HasConstantValue: true } constant)
        {
            // A decimal constant, which IL keeps in a field.
            EmitConstant(constant.Type, constant.ConstantValue);
            PushResult();
            return;
        }

        Load(StaticFieldLocation(field));
        PushResult();
    }

    // MARK: Indirection

    private void LoadIndirect()
    {
        var reference = Pop();
        var pointee = flow.Before[ilIndex][^1].Type!;
        if (flow.Instructions[ilIndex].OpCode == ILOpCode.Ldobj)
        {
            pointee = (ITypeSymbol)flow.Operands[ilIndex]!;
        }

        LoadIndirectFrom(reference, pointee);
    }

    private void LoadIndirectFrom(IlValue reference, ITypeSymbol pointee)
    {
        LoadResult(PlaceOf(reference));
        _ = pointee;
    }

    private void StoreIndirect()
    {
        var value = Pop();
        var reference = Pop();
        if (reference is IlStackValue memory)
        {
            // An initializer's element: its value now, stored with the array.
            var slot = flow.Before[ilIndex][^1];
            var stored = IlWType(slot);
            memory.Block.Stores.Add((memory.Offset, GetOwnLocal(value, slot), stored));
            return;
        }

        if (reference is IlRefValue item && inlineItemRefs.TryGetValue(item, out var position))
        {
            if (!inlineItems.TryGetValue(position.Buffer, out var stored))
            {
                inlineItems[position.Buffer] = stored = [];
            }

            stored[position.Index] = value switch
            {
                IlBoxedValue boxed => (boxed.Value, boxed.Type),
                IlNullValue => (-1, null),
                _ => (GetOwnLocal(value, flow.Before[ilIndex][^1]), flow.Before[ilIndex][^1].Type),
            };
        }

        var place = PlaceOf(reference);
        Store(place, GetLocal(value, place.Type));
    }

    private void InitializeIndirect(ITypeSymbol type) => InitializePlace(PlaceOf(Pop()), type);

    private void InitializePlace(Location place, ITypeSymbol type)
    {
        if (Frontend.InlineArrayLength(type) is int inlineLength)
        {
            // A params span's buffer: a new array of its length.
            code.I32(inlineLength);
            int length = Save(WType.I32);
            var arraySymbol = frontend.ArrayOf(Frontend.InlineArrayElement(type));
            Store(place, Save(EmitNewArray(arraySymbol, length)));
            return;
        }

        var mapped = frontend.MapType(type);
        PushDefault(mapped);
        Store(place, Save(mapped));

        // A struct holding a buffer (dotnet/runtime's
        // BigInteger.RentedBuffer) gets the buffer's array too.
        foreach (var field in type.GetMembers().OfType<IFieldSymbol>())
        {
            if (!field.IsStatic && Frontend.HoldsInlineArray(field.Type))
            {
                InitializePlace(FieldOfPlace(place, field, readOnly: false), field.Type);
            }
        }
    }

    // MARK: Arrays

    // An index or size as the i32 array instructions take: native ints
    // outside [0, int.MaxValue] become 0xFFFFFFFF, which range checks reject.
    private int IlIndex(IlValue value, IlSlot type)
    {
        if (type.Kind == IlKind.I32)
        {
            return GetLocal(value, WType.I32);
        }

        int wide = GetLocal(value, WType.I64);
        LocalGet(wide);
        code.Byte(0xa7); // i32.wrap_i64
        code.I32(-1);
        LocalGet(wide);
        code.I64(int.MaxValue);
        code.Byte(0x58); // i64.le_u
        code.Byte(0x1b); // select
        return Save(WType.I32);
    }

    // The element an array and index on the stack name, checked.
    private Location PrepareIlElement()
    {
        var indexType = flow.Before[ilIndex][^1];
        var arrayType = flow.Before[ilIndex][^2];
        if (flow.Instructions[ilIndex].OpCode is ILOpCode.Stelem or ILOpCode.Stelem_i1 or ILOpCode.Stelem_i2
            or ILOpCode.Stelem_i4 or ILOpCode.Stelem_i8 or ILOpCode.Stelem_r4 or ILOpCode.Stelem_r8
            or ILOpCode.Stelem_ref or ILOpCode.Stelem_i)
        {
            indexType = flow.Before[ilIndex][^2];
            arrayType = flow.Before[ilIndex][^3];
        }

        var indexValue = Pop();
        var arrayValue = Pop();
        if (arrayType.Type is not IArrayTypeSymbol { IsSZArray: true } array)
        {
            throw IlError($"Element access on {arrayType} is unsupported.");
        }

        var container = frontend.MapType(array);
        int arrayLocal = GetLocal(arrayValue, container);
        int index = IlIndex(indexValue, indexType);
        CheckArray(arrayLocal, index);
        var element = frontend.MapType(array.ElementType);
        return new(
            LocationKind.ArrayElement, element, array.ElementType, Receiver: arrayLocal, Index: index,
            Container: container, Boxed: element.IsTuple, NonNull: true);
    }

    private void EmitIlNewArray(ITypeSymbol elementType)
    {
        var sizeType = flow.Before[ilIndex][^1];
        int length = IlIndex(Pop(), sizeType);
        var arraySymbol = frontend.ArrayOf(elementType);
        if (frontend.Exceptions)
        {
            LocalGet(length);
            code.I32(0);
            code.Byte(0x48); // i32.lt_s
            FaultIf(FaultCode.InvalidArrayLength);
            LocalGet(length);
            code.I32(frontend.Limits.ArrayLength);
            code.Byte(0x4b); // i32.gt_u
            TrapIf(FaultCode.InvalidArrayLength);
        }
        else
        {
            LocalGet(length);
            code.I32(frontend.Limits.ArrayLength);
            code.Byte(0x4b); // i32.gt_u
            FaultIf(FaultCode.InvalidArrayLength);
        }

        EmitNewArray(arraySymbol, length);
        PushResult();
    }

    // MARK: Boxing, casts and throw

    private void EmitIlBox(ITypeSymbol type)
    {
        var value = Pop();
        if (!type.IsValueType)
        {
            // A reference type argument: already an object.
            ilStack.Add(value);
            return;
        }

        if (frontend.IsRuntimeNullable(type))
        {
            // A nullable boxes its value, or is null.
            var underlying = ((INamedTypeSymbol)type).TypeArguments[0];
            var mapped = frontend.MapType(type);
            int nullable = GetLocal(value, mapped);
            var layout = frontend.StructOf(mapped);
            int has = layout.Fields.FindIndex(field => field.Name == "hasValue");
            int held = layout.Fields.FindIndex(field => field.Name == "value");
            code.OpIndex(0x20, nullable + layout.Offsets[has]); // local.get
            OpenBlock(0x04, ObjectRef, new object());
            PushLocal(nullable + layout.Offsets[held], frontend.MapType(underlying));
            if (Frontend.IsBoxable(underlying))
            {
                EmitBox(underlying);
            }

            code.Byte(0x05); // else
            ObjectRef.Default(code);
            CloseBlock();
            PushResult();
            return;
        }

        Get(value, frontend.MapType(type));
        ilStack.Add(new IlBoxedValue(type, Save(frontend.MapType(type))));
    }

    private void EmitIlUnboxAny(ITypeSymbol type)
    {
        if (!type.IsValueType)
        {
            EmitIlCast(type, isinst: false);
            return;
        }

        var value = Pop();
        int boxed = GetLocal(value, ObjectRef);
        if (frontend.IsRuntimeNullable(type))
        {
            // null is no value; a box of the underlying type is its value.
            var mapped = frontend.MapType(type);
            var layout = frontend.StructOf(mapped);
            var underlying = ((INamedTypeSymbol)type).TypeArguments[0];
            int result = NewLocal(mapped);
            PushDefault(mapped);
            LocalSet(result);
            int has = layout.Fields.FindIndex(field => field.Name == "hasValue");
            int held = layout.Fields.FindIndex(field => field.Name == "value");
            LocalGet(boxed);
            code.Byte(0xd1); // ref.is_null
            code.Byte(0x45); // i32.eqz
            OpenBlock(0x04, WType.Void, new object());
            EmitUnbox(underlying, boxed);
            PopLocal(result + layout.Offsets[held], frontend.MapType(underlying));
            code.I32(1);
            code.OpIndex(0x21, result + layout.Offsets[has]); // local.set
            CloseBlock();
            LocalGet(result);
            PushResult();
            return;
        }

        EmitUnbox(type, boxed);
        PushResult();
    }

    private void EmitIlUnbox(ITypeSymbol type)
    {
        // The value, copied into a box or cell of its own: C# unboxes only
        // to read (a method call on the value).
        var value = Pop();
        int boxed = GetLocal(value, ObjectRef);
        var mapped = EmitUnbox(type, boxed);
        int copy = Save(mapped);
        EmitNewBox(mapped);
        int box = Save(frontend.ReferenceType(type));
        Store(new(LocationKind.Local, mapped, type, Local: box, Boxed: true, NonNull: true), copy);
        LocalGet(box);
        PushResult();
    }

    private void EmitIlCast(ITypeSymbol type, bool isinst)
    {
        var value = Pop();
        var sourceType = flow.Before[ilIndex][^1];
        if (value is IlNullValue)
        {
            ilStack.Add(value);
            return;
        }

        var target = frontend.MapType(type);
        if (type is IArrayTypeSymbol { IsSZArray: true, ElementType: { IsReferenceType: true } element }
            && frontend.ArrayHeapsConvertingTo(element).Count > 1)
        {
            // An array of another element type may pass the test: arrays
            // of references in one family.
            frontend.NoteArrayCovariance(element);
        }

        if (sourceType.Type is { } source && frontend.ClassifyConversion(source, type) is { IsImplicit: true } conversion
            && (conversion.IsIdentity || conversion.IsReference) && !type.IsValueType)
        {
            // Proven by the static type.
            Get(value, target);
            PushResult();
            return;
        }

        // Type tests read the local's declared type: a local of its own.
        Get(value, IlWType(sourceType));
        int local = Save(IlWType(sourceType));
        if (isinst)
        {
            EmitTypeTest(local, type);
            OpenBlock(0x04, target.IsRef ? target : ObjectRef, new object());
            LocalGet(local);
            if (target.IsRef)
            {
                code.RefCast(target);
            }

            code.Byte(0x05); // else
            (target.IsRef ? target : ObjectRef).Default(code);
            CloseBlock();
            PushResult();
            return;
        }

        // castclass: null passes, anything else must test true.
        LocalGet(local);
        code.Byte(0xd1); // ref.is_null
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Void, new object());
        EmitTypeTest(local, type);
        code.Byte(0x45); // i32.eqz
        FaultIf(FaultCode.InvalidCast);
        CloseBlock();
        LocalGet(local);
        if (target.IsRef)
        {
            code.RefCast(target);
        }

        PushResult();
    }

    private void EmitIlThrow(IlValue value)
    {
        var type = flow.Before[ilIndex][^1];
        if (value is IlNullValue)
        {
            Fault(FaultCode.NullReference);
            return;
        }

        int exception = GetLocal(value, WType.Ref(frontend.ExceptionHeap));
        CheckNull(exception);
        _ = type;
        ThrowLocal(exception);
    }

    // Throws the exception in a local, or faults with its code in a module
    // that catches nothing.
    private void ThrowLocal(int exception)
    {
        if (frontend.Exceptions)
        {
            if (frontend.TwoPass)
            {
                EmitRaise(exception);
                return;
            }

            LocalGet(exception);
            code.OpIndex(0x08, 0); // throw
            return;
        }

        LocalGet(exception);
        code.Gc(2, frontend.ExceptionHeap, frontend.FaultField); // struct.get
        GlobalSet(ModuleWriter.FaultGlobal);
        code.Byte(0x00); // unreachable
    }
}
