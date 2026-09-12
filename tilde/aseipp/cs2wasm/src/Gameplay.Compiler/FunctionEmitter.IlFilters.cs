// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;
using System.Reflection.Metadata;

namespace Gameplay.Compiler;

// The CIL importer's two-pass exception handling (see Frontend.Filters):
// in a module with filters, each try block with catch clauses pushes a
// handler record while its protected code runs, and its selector (a
// function of its own) picks the clause that takes an exception before
// anything unwinds, running the clauses' filters. A filter is IL of the
// method's own: its selector runs it over the method's locals and
// arguments, which live in cells (or are references already) an
// environment struct in the record holds.
internal sealed partial class FunctionEmitter
{
    // The filter running in a selector: where endfilter leaves its value.
    private (int Result, object Label)? endFilter;

    // The protected code, then the clause the record was marked with.
    private void EmitSelectedGroup(IlGroup group)
    {
        var recordType = WType.Ref(frontend.HandlerHeap);
        var frame = new HandlerFrame { Previous = NewLocal(WType.I32) };
        int record = NewLocal(recordType);
        GlobalGet(frontend.HandlersGlobal);
        LocalSet(frame.Previous);
        GlobalGet(frontend.HandlerPoolGlobal);
        code.Byte(0xd1); // ref.is_null
        OpenBlock(0x04, WType.I32, new object());
        code.I32(1);
        code.Byte(0x05); // else
        LocalGet(frame.Previous);
        GlobalGet(frontend.HandlerPoolGlobal);
        code.Gc(15); // array.len
        code.Byte(0x4f); // i32.ge_u
        CloseBlock();
        OpenBlock(0x04, WType.Void, new object());
        Call(frontend.GrowHandlers);
        CloseBlock();
        GlobalGet(frontend.HandlerPoolGlobal);
        LocalGet(frame.Previous);
        code.Gc(11, frontend.HandlerPoolHeap); // array.get
        LocalSet(record);
        LocalGet(record);
        FunctionReference(frontend.IlSelectorIndex(plan.Symbol!, plan.Generic, group.Id));
        code.Gc(5, frontend.HandlerHeap, Frontend.HandlerSelector); // struct.set
        var environment = frontend.FilterEnvironmentOf(plan.Symbol!, plan.Generic);
        LocalGet(record);
        foreach (var (argument, index, _) in environment.Variables)
        {
            LocalGet(argument ? ilArguments[index] : ilLocals[index]);
        }

        StructNew(environment.Heap);
        code.Gc(5, frontend.HandlerHeap, Frontend.HandlerEnvironment);
        LocalGet(record);
        code.Byte(0xd0); // ref.null
        code.Signed(frontend.ExceptionHeap);
        code.Gc(5, frontend.HandlerHeap, Frontend.HandlerException);
        LocalGet(frame.Previous);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        GlobalSet(frontend.HandlersGlobal);

        var exceptionType = WType.Ref(frontend.ExceptionHeap);
        var host = new object();
        var handler = new object();
        OpenBlock(0x02, WType.ExnRef, host);
        OpenBlock(0x02, exceptionType, handler);
        OpenTryTable(frame, (0x00, 0, handler), (0x03, -1, host)); // catch the tag, catch_all_ref
        EmitArea(group.Try);
        CloseBlock();
        code.Byte(0x00); // unreachable: the try left through a branch
        CloseBlock();
        int exception = Save(exceptionType);
        PopHandler(frame);
        RestoreDepth();
        LocalGet(record);
        code.Gc(2, frontend.HandlerHeap, Frontend.HandlerException); // struct.get
        LocalGet(exception);
        code.Byte(0xd3); // ref.eq
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(exception);
        code.OpIndex(0x08, 0); // throw: marked for an enclosing handler
        CloseBlock();
        LocalGet(record);
        code.Gc(2, frontend.HandlerHeap, Frontend.HandlerClause);
        int selected = Save(WType.I32);
        for (int index = 0; index < group.Clauses.Count; index++)
        {
            var next = new object();
            OpenBlock(0x02, WType.Void, next);
            LocalGet(selected);
            code.I32(index);
            code.Byte(0x47); // i32.ne
            Branch(next, true);
            var clause = group.Clauses[index];
            var caught = clause.Kind == ExceptionRegionKind.Filter ? frontend.ObjectSymbol : flow.CatchType(clause);
            var entry = new IlSlot(IlKind.Ref, caught);
            LocalGet(exception);
            Coerce(exceptionType, IlWType(entry));
            LocalSet(SlotLocal(0, IlWType(entry)));
            caughtExceptions.Push(exception);
            EmitArea(group.Handlers[index]);
            caughtExceptions.Pop();
            CloseBlock();
        }

        code.Byte(0x00); // unreachable
        CloseBlock();
        PopHandler(frame);
        code.Byte(0x0a); // throw_ref: an exception from the host
    }

    // A selector: which of a try block's clauses takes the exception in
    // parameter 1, or -1. Each clause's type test, or its filter, run with
    // the handler stack empty, so that what it throws it catches itself or
    // ends the filter, which is then false, as in the CLR.
    private void EmitIlSelectorBody()
    {
        var group = flow.Groups[plan.IlGroup];
        var environment = frontend.FilterEnvironmentOf(plan.Symbol!, plan.Generic);
        ilLocals = new int[flow.Locals.Length];
        ilLocalBoxed = new bool[flow.Locals.Length];
        ilArguments = new int[flow.Arguments.Length];
        ilArgumentBoxed = new bool[flow.Arguments.Length];
        ilArgumentStored = new bool[flow.Arguments.Length];
        if (environment.Variables.Count != 0)
        {
            LocalGet(0);
            code.Gc(2, frontend.HandlerHeap, Frontend.HandlerEnvironment); // struct.get
            code.RefCast(WType.NonNullRef(environment.Heap));
            int held = Save(WType.Ref(environment.Heap));
            for (int field = 0; field < environment.Variables.Count; field++)
            {
                var (argument, index, type) = environment.Variables[field];
                LocalGet(held);
                code.Gc(2, environment.Heap, field); // struct.get
                int local = Save(type);
                if (argument)
                {
                    ilArguments[index] = local;
                    ilArgumentBoxed[index] = flow.Arguments[index].Kind != IlKind.ByRef
                                             && (plan.Symbol!.IsStatic || index != 0);
                }
                else
                {
                    ilLocals[index] = local;
                    ilLocalBoxed[index] = !flow.Locals[index].ByRef;
                }
            }
        }

        var exceptionType = WType.Ref(frontend.ExceptionHeap);
        for (int index = 0; index < group.Clauses.Count; index++)
        {
            var clause = group.Clauses[index];
            var next = new object();
            OpenBlock(0x02, WType.Void, next);
            if (clause.Kind == ExceptionRegionKind.Catch)
            {
                var caught = flow.CatchType(clause);
                bool all = caught.SpecialType == SpecialType.System_Object
                           || SymbolEqualityComparer.Default.Equals(caught, frontend.ExceptionType);
                if (!all)
                {
                    LocalGet(1);
                    code.RefTest(WType.NonNullRef(frontend.MapType(caught).Heap));
                    code.Byte(0x45); // i32.eqz
                    Branch(next, true);
                }
            }
            else
            {
                EmitIlFilter(group.Filters[index]!, exceptionType);
                code.Byte(0x45); // i32.eqz
                Branch(next, true);
            }

            code.I32(index);
            LocalSet(returnSlot);
            Branch(returnLabel);
            CloseBlock();
        }

        code.I32(-1);
        LocalSet(returnSlot);
    }

    // A filter's IL, leaving its verdict: what escapes it makes it false.
    private void EmitIlFilter(IlArea filter, WType exceptionType)
    {
        int saved = NewLocal(WType.I32);
        int result = NewLocal(WType.I32);
        GlobalGet(frontend.HandlerBaseGlobal);
        LocalSet(saved);
        GlobalGet(frontend.HandlersGlobal);
        GlobalSet(frontend.HandlerBaseGlobal);
        code.I32(0);
        LocalSet(result);
        var after = new object();
        var host = new object();
        var failed = new object();
        OpenBlock(0x02, WType.Void, after);
        OpenBlock(0x02, WType.ExnRef, host);
        OpenBlock(0x02, exceptionType, failed);
        OpenTryTable((0x00, 0, failed), (0x03, -1, host)); // catch the tag, catch_all_ref
        var entry = new IlSlot(IlKind.Ref, frontend.ObjectSymbol);
        LocalGet(1);
        Coerce(WType.NonNullRef(frontend.ExceptionHeap), IlWType(entry));
        LocalSet(SlotLocal(0, IlWType(entry)));
        var done = new object();
        OpenBlock(0x02, WType.Void, done);
        endFilter = (result, done);
        EmitArea(filter);
        endFilter = null;
        CloseBlock();
        CloseBlock();
        Branch(after);
        CloseBlock();
        code.Byte(0x1a); // drop: the filter threw
        RestoreDepth();
        Branch(after);
        CloseBlock();
        LocalGet(saved);
        GlobalSet(frontend.HandlerBaseGlobal);
        code.Byte(0x0a); // throw_ref
        CloseBlock();
        LocalGet(saved);
        GlobalSet(frontend.HandlerBaseGlobal);
        LocalGet(result);
    }

    // endfilter: the verdict, then out of the filter.
    private void EmitEndFilter()
    {
        var (result, label) = endFilter ?? throw IlError("endfilter outside a filter.");
        var value = Pop();
        Get(value, WType.I32);
        code.I32(0);
        code.Byte(0x47); // i32.ne
        LocalSet(result);
        Branch(label);
    }

    // A throw, in a module with filters: the raise function's first pass.
    private void EmitRaise(int exception)
    {
        LocalGet(exception);
        code.Byte(0xd4); // ref.as_non_null
        Call(frontend.Raise);
        code.Byte(0x00); // unreachable
    }
}
