// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// throw, try/catch/finally (see Frontend.Exceptions). A try with catch
// clauses runs its body in a try_table that catches the module's tag; the
// handler receives the exception object and tries the clauses' type tests
// in order, rethrowing when none matches. With filters, the clause is
// chosen before the throw instead (two-pass, see Frontend.Filters). A
// finally is a try_table catching everything (catch_all_ref, so exceptions
// from the host pass through it unchanged too): whether the protected code
// completed, threw, or left it by return, break or continue, the finally
// block runs, then the exception is rethrown (throw_ref) or the branch
// taken. Branches that leave a finally's protected code are routed through
// it.
internal sealed partial class FunctionEmitter
{
    // The label of a finally block's entry. A branch out of the protected
    // code records its target here, stores its number in Kind and enters the
    // finally block, which then takes it; -1 means an exception, in Exception.
    private sealed class FinallyFrame
    {
        public int Kind { get; init; }

        public int Exception { get; init; }

        public List<object> Targets { get; } = [];
    }

    // The label of the protected code of a try statement's handler record:
    // what leaves it takes the record off the stack, restoring its top, in
    // Previous.
    private sealed class HandlerFrame
    {
        public int Previous { get; init; }
    }

    // The exceptions of the catch clauses being run, innermost last, which
    // `throw;` rethrows.
    private readonly Stack<int> caughtExceptions = new();

    // The local holding the function's call depth, in a function with
    // exception handlers, or -1.
    private int depthLevel = -1;

    // A catch clause's entry: an exception unwinding frames above this one
    // left the call depth theirs, which their returns would have restored,
    // so it is this function's again. A finally or fault block needs none:
    // the exception goes on to a catch clause, which restores its own, or
    // leaves the entry, which restores its caller's.
    private void RestoreDepth()
    {
        if (depthLevel >= 0)
        {
            LocalGet(depthLevel);
            GlobalSet(ModuleWriter.CallDepthGlobal);
        }
    }

    // Protected code, then its finally block however it leaves.
    private void EmitTryFinally(Action protectedCode, Action finallyCode)
    {
        var frame = new FinallyFrame { Kind = NewLocal(WType.I32), Exception = NewLocal(WType.ExnRef) };
        code.I32(0);
        LocalSet(frame.Kind);
        var caught = new object();
        OpenBlock(0x02, WType.Void, frame);
        OpenBlock(0x02, WType.ExnRef, caught);
        OpenTryTable((0x03, -1, caught)); // catch_all_ref
        protectedCode();
        CloseBlock();
        Branch(frame);
        CloseBlock();
        LocalSet(frame.Exception);
        code.I32(-1);
        LocalSet(frame.Kind);
        CloseBlock();

        finallyCode();

        LocalGet(frame.Kind);
        code.I32(-1);
        code.Byte(0x46); // i32.eq
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(frame.Exception);
        code.Byte(0x0a); // throw_ref
        CloseBlock();
        for (int target = 0; target < frame.Targets.Count; target++)
        {
            LocalGet(frame.Kind);
            code.I32(target + 1);
            code.Byte(0x46); // i32.eq
            OpenBlock(0x04, WType.Void, new object());
            Branch(frame.Targets[target]);
            CloseBlock();
        }
    }

    private void PopHandler(HandlerFrame frame)
    {
        LocalGet(frame.Previous);
        GlobalSet(frontend.HandlersGlobal);
    }

    // The raise function, the first pass: asks the records on the handler
    // stack above its base, innermost first, which clause takes the
    // exception, and marks the first that has one, clearing the mark of each
    // it passes (an earlier throw of the same object may have left one),
    // then throws. Without a clause, the exported entry is the handler.
    private WasmFunction EmitRaise()
    {
        int index = NewLocal(WType.I32);
        int record = NewLocal(WType.Ref(frontend.HandlerHeap));
        int clause = NewLocal(WType.I32);
        GlobalGet(frontend.HandlersGlobal);
        LocalSet(index);
        var found = new object();
        var search = new object();
        OpenBlock(0x02, WType.Void, found);
        OpenBlock(0x03, WType.Void, search); // loop
        LocalGet(index);
        GlobalGet(frontend.HandlerBaseGlobal);
        code.Byte(0x4c); // i32.le_s
        Branch(found, true);
        LocalGet(index);
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        LocalSet(index);
        GlobalGet(frontend.HandlerPoolGlobal);
        LocalGet(index);
        code.Gc(11, frontend.HandlerPoolHeap); // array.get
        LocalSet(record);
        LocalGet(record);
        code.Byte(0xd4); // ref.as_non_null
        LocalGet(0);
        LocalGet(record);
        code.Gc(2, frontend.HandlerHeap, Frontend.HandlerSelector); // struct.get
        CallReference(frontend.SelectorSignature);
        LocalSet(clause);
        LocalGet(clause);
        code.I32(0);
        code.Byte(0x4e); // i32.ge_s
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(record);
        LocalGet(0);
        code.Gc(5, frontend.HandlerHeap, Frontend.HandlerException); // struct.set
        LocalGet(record);
        LocalGet(clause);
        code.Gc(5, frontend.HandlerHeap, Frontend.HandlerClause);
        Branch(found);
        CloseBlock();
        LocalGet(record);
        code.Byte(0xd0); // ref.null
        code.Signed(frontend.ExceptionHeap);
        code.Gc(5, frontend.HandlerHeap, Frontend.HandlerException);
        Branch(search);
        CloseBlock();
        CloseBlock();
        LocalGet(0);
        code.OpIndex(0x08, 0); // throw
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // Grows the handler stack's array, twice as long (16 at first), filled
    // with records to reuse.
    private WasmFunction EmitGrowHandlers()
    {
        int pool = NewLocal(WType.Ref(frontend.HandlerPoolHeap));
        int length = NewLocal(WType.I32);
        int index = NewLocal(WType.I32);
        GlobalGet(frontend.HandlerPoolGlobal);
        LocalSet(pool);
        LocalGet(pool);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.I32(16);
        code.Byte(0x05); // else
        LocalGet(pool);
        code.Gc(15); // array.len
        code.I32(1);
        code.Byte(0x74); // i32.shl
        CloseBlock();
        LocalSet(length);
        LocalGet(length);
        code.Gc(7, frontend.HandlerPoolHeap); // array.new_default
        GlobalSet(frontend.HandlerPoolGlobal);
        LocalGet(pool);
        code.Byte(0xd1); // ref.is_null
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Void, new object());
        GlobalGet(frontend.HandlerPoolGlobal);
        code.I32(0);
        LocalGet(pool);
        code.I32(0);
        LocalGet(pool);
        code.Gc(15); // array.len
        code.Gc(17, frontend.HandlerPoolHeap, frontend.HandlerPoolHeap); // array.copy
        LocalGet(pool);
        code.Gc(15);
        LocalSet(index);
        CloseBlock();
        var done = new object();
        var fill = new object();
        OpenBlock(0x02, WType.Void, done);
        OpenBlock(0x03, WType.Void, fill); // loop
        LocalGet(index);
        LocalGet(length);
        code.Byte(0x4f); // i32.ge_u
        Branch(done, true);
        GlobalGet(frontend.HandlerPoolGlobal);
        LocalGet(index);
        code.Gc(1, frontend.HandlerHeap); // struct.new_default
        code.Gc(14, frontend.HandlerPoolHeap); // array.set
        LocalGet(index);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        LocalSet(index);
        Branch(fill);
        CloseBlock();
        CloseBlock();
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // try_table with catch clauses (kind, tag or -1, label); the labels are
    // those of blocks around it. The try_table is a block of its own, whose
    // label is `frame`.
    private void OpenTryTable(params (byte Kind, int Tag, object Label)[] catches) =>
        OpenTryTable(new object(), catches);

    private void OpenTryTable(object frame, params (byte Kind, int Tag, object Label)[] catches)
    {
        code.Byte(0x1f); // try_table
        code.Byte(0x40);
        code.Index(catches.Length);
        foreach (var (kind, tag, label) in catches)
        {
            code.Byte(kind);
            if (tag >= 0)
            {
                code.Index(tag);
            }

            code.Index(LabelDepth(label));
        }

        labels.Add(frame);
    }

    private int LabelDepth(object label)
    {
        for (int i = labels.Count - 1; i >= 0; i--)
        {
            if (SameLabel(labels[i], label))
            {
                return labels.Count - i - 1;
            }
        }

        throw new InternalCompilerError("catch outside its handler.");
    }

    // A BCL exception constructor's work: storing its message (its class's
    // own for a parameterless one; the one passed, unless null), inner
    // exception and parameter name in the new exception. An argument
    // exception's message ends with the parameter's name, and an
    // ArgumentOutOfRangeException's with the actual value, as the CLR's
    // Message composes them.
    private void EmitExceptionConstructor(int receiver, IMethodSymbol constructor, int[] arguments)
    {
        var type = constructor.ContainingType;
        if (!frontend.ExceptionMessages)
        {
            return;
        }

        if (!frontend.IsFrameworkException(type))
        {
            return;
        }

        string[] names = [.. constructor.Parameters.Select(parameter => parameter.Name)];
        int Argument(string name) => arguments[Array.IndexOf(names, name)];
        void StoreMessage(Action push)
        {
            LocalGet(receiver);
            push();
            code.Gc(5, frontend.ExceptionHeap, frontend.MessageField); // struct.set
        }

        if (names.Length == 0)
        {
            if (Frontend.OwnDefaultMessage(type) is { } text)
            {
                StoreMessage(() => EmitLiteral(text));
            }

            return;
        }

        // A null message is the class's own, as the CLR's constructors
        // make it; System.Exception's keeps the message naming the class.
        var ownDefault = Frontend.OwnDefaultMessage(type);
        void PushMessage()
        {
            if (!names.Contains("message"))
            {
                EmitLiteral(Frontend.OwnDefaultMessage(type)!);
                return;
            }

            int message = Argument("message");
            LocalGet(message);
            code.Byte(0xd1); // ref.is_null
            EmitChoice(WType.Ref(frontend.StringHeap), () =>
            {
                if (ownDefault is not null)
                {
                    EmitLiteral(ownDefault);
                }
                else
                {
                    LocalGet(receiver);
                    code.Gc(2, frontend.ExceptionHeap, frontend.MessageField); // struct.get
                }
            }, () => LocalGet(message));
        }

        if (names.Contains("paramName"))
        {
            StoreMessage(() =>
            {
                PushMessage();
                LocalGet(Argument("paramName"));
                Call(frontend.MethodIndex(frontend.RuntimeMethod("ExceptionText", "WithParameter", 2)));
                if (names.Contains("actualValue"))
                {
                    LocalGet(Argument("actualValue"));
                    Call(frontend.MethodIndex(frontend.RuntimeMethod("ExceptionText", "WithActualValue", 2)));
                }
            });
            LocalGet(receiver);
            LocalGet(Argument("paramName"));
            code.Gc(5, frontend.ExceptionHeap, frontend.ParamNameField); // struct.set
        }
        else if (ownDefault is not null)
        {
            StoreMessage(PushMessage);
        }
        else
        {
            LocalGet(Argument("message"));
            code.Byte(0xd1); // ref.is_null
            code.Byte(0x45); // i32.eqz
            OpenBlock(0x04, WType.Void, new object());
            StoreMessage(() => LocalGet(Argument("message")));
            CloseBlock();
        }

        if (names.Contains("innerException"))
        {
            LocalGet(receiver);
            LocalGet(Argument("innerException"));
            code.Gc(5, frontend.ExceptionHeap, frontend.InnerField);
        }
    }

    // The function a failed check calls in a module with exception handling:
    // it throws a new exception of the class the fault code stands for,
    // carrying that code, charged like an object.
    private WasmFunction EmitThrowHelper()
    {
        code.I64(16);
        ChargeAllocation();
        foreach (var group in Frontend.CatchableFaults.GroupBy(fault => frontend.CheckException(fault).Name))
        {
            var type = frontend.CheckException(group.First());
            var heap = frontend.MapType(type);
            code.I32(0);
            foreach (int fault in group)
            {
                LocalGet(0);
                code.I32(fault);
                code.Byte(0x46); // i32.eq
                code.Byte(0x72); // i32.or
            }

            OpenBlock(0x04, WType.Void, new object());
            code.Byte(0x23); // global.get
            Relocations.Add(new(code.Length, RelocationKind.VTable, frontend.VTableGlobal(type)!.Value));
            var fields = frontend.Fields(heap);
            for (int field = 1; field < fields.Count; field++)
            {
                if (field == frontend.FaultField)
                {
                    LocalGet(0);
                }
                else if (frontend.ExceptionMessages && field == frontend.MessageField)
                {
                    EmitLiteral(Frontend.CheckMessage(type));
                }
                else
                {
                    fields[field].Type.Default(code);
                }
            }

            StructNew(heap.Heap);
            if (frontend.TwoPass)
            {
                Call(frontend.Raise);
            }
            else
            {
                code.OpIndex(0x08, 0); // throw
            }

            CloseBlock();
        }

        code.Byte(0x00); // unreachable
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // Pushes a new exception of a BCL class, with the fault code
    // `pushFault` pushes, charged like an object, and the message its class
    // gives it.
    private void EmitNewException(INamedTypeSymbol type, Action pushFault)
    {
        code.I64(16);
        ChargeAllocation();
        var heap = frontend.MapType(type);
        code.Byte(0x23); // global.get
        Relocations.Add(new(code.Length, RelocationKind.VTable, frontend.VTableGlobal(type)!.Value));
        var fields = frontend.Fields(heap);
        for (int field = 1; field < fields.Count; field++)
        {
            if (field == frontend.FaultField)
            {
                pushFault();
            }
            else if (frontend.ExceptionMessages && field == frontend.MessageField)
            {
                EmitLiteral(Frontend.CheckMessage(type));
            }
            else
            {
                fields[field].Type.Default(code);
            }
        }

        StructNew(heap.Heap);
    }
}
