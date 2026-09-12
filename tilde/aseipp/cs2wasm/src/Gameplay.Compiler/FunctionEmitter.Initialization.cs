// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Lazy static initialization (see Frontend.Initialization): the checks at
// the accesses that trigger a class's initializer, the initializer, and the
// bookkeeping around import calls that lets entries recover from traps.
internal sealed partial class FunctionEmitter
{
    // Whether this function starts by initializing its own class, which it
    // then need not check again: its state cannot go back while the
    // function runs.
    private bool triggered;

    // A precise class's static members and instance constructors trigger
    // its initialization when they run, and so do a struct's instance
    // members: the CLR runs a value type's static constructor at the first
    // call of an instance method too (ECMA-335 II.10.5.3.1), though not for
    // a default value.
    private void EmitClassTrigger()
    {
        if (frontend.LazyClass(plan.ContainingType) is not { Precise: true } initialization)
        {
            return;
        }

        bool trigger = plan.Kind switch
        {
            MethodPlanKind.Constructor => true,
            MethodPlanKind.Ordinary => plan.Symbol is { MethodKind: not MethodKind.StaticConstructor } member
                                       && (member.IsStatic || Frontend.IsStruct(plan.ContainingType)),
            _ => false,
        };
        if (trigger)
        {
            CheckInitialized(initialization);
            triggered = true;
        }
    }

    // Initializes a lazily initialized class unless this function is known
    // to be past that: the class's own initializer and static constructor,
    // and the members that triggered it on entry.
    private void EnsureInitialized(INamedTypeSymbol? type)
    {
        if (frontend.LazyClass(type) is not { } initialization)
        {
            return;
        }

        if (SymbolEqualityComparer.Default.Equals(type, plan.ContainingType)
            && (triggered || plan.Kind == MethodPlanKind.ClassInitializer
                || plan.Symbol?.MethodKind == MethodKind.StaticConstructor))
        {
            return;
        }

        CheckInitialized(initialization);
    }

    private void CheckInitialized(Frontend.ClassInitialization initialization)
    {
        GlobalGet(initialization.State);
        code.I32(Frontend.InitDone);
        code.Byte(0x47); // i32.ne
        OpenBlock(0x04, WType.Void, new object());
        Call(frontend.InitializerIndex(initialization));
        CloseBlock();
    }

    // Resets every lazily initialized class that an entry deeper than the
    // parameter left running.
    private WasmFunction EmitRecover()
    {
        foreach (var initialization in frontend.LazyClasses)
        {
            GlobalGet(initialization.State);
            LocalGet(0);
            code.I32(Frontend.RunningState);
            code.Byte(0x6a); // i32.add
            code.Byte(0x4a); // i32.gt_s
            OpenBlock(0x04, WType.Void, new object());
            code.I32(0);
            GlobalSet(initialization.State);
            CloseBlock();
        }

        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // The count of entries, noted as the depth of the import call.
    private WasmFunction EmitImportEnter()
    {
        GlobalGet(frontend.EntriesGlobal);
        GlobalSet(frontend.ImportsGlobal);
        GlobalGet(frontend.EntriesGlobal);
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // After an import call at depth parameter 0: an entry the host made that
    // trapped poisons the module, and ends this entry too.
    private WasmFunction EmitImportLeave()
    {
        LocalGet(0);
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        GlobalSet(frontend.ImportsGlobal);
        GlobalGet(frontend.PoisonGlobal);
        GlobalGet(frontend.EntriesGlobal);
        LocalGet(0);
        code.Byte(0x47); // i32.ne
        code.Byte(0x72); // i32.or
        OpenBlock(0x04, WType.Void, new object());
        code.I32(1);
        GlobalSet(frontend.PoisonGlobal);
        Trap(FaultCode.Poisoned);
        CloseBlock();
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // A call of a host import, with its arguments on the stack. The host may
    // call back into the module, and may swallow a trap of the entry it
    // made. By default that ends this entry too, with fault 18: the module is
    // poisoned. With --recover-after-trap, the trapped entry's budgets,
    // handler records and running classes are restored and reset here, and an
    // entry the host abandoned by entering again after such a trap cannot go
    // on (fault 12).
    private void CallImport(int function)
    {
        int handlers = -1;
        int handlerBase = -1;
        if (frontend.TwoPass)
        {
            handlers = NewLocal(WType.I32);
            handlerBase = NewLocal(WType.I32);
            GlobalGet(frontend.HandlersGlobal);
            LocalSet(handlers);
            GlobalGet(frontend.HandlerBaseGlobal);
            LocalSet(handlerBase);
        }

        bool recover = frontend.Limits.RecoverAfterTrap;
        int depth = NewLocal(WType.I32);
        int epoch = -1;
        int[] budgets = [];
        if (recover)
        {
            budgets =
            [
                NewLocal(WType.I32), NewLocal(WType.I32), NewLocal(WType.I64),
            ];
            GlobalGet(ModuleWriter.FuelGlobal);
            LocalSet(budgets[0]);
            GlobalGet(ModuleWriter.CallDepthGlobal);
            LocalSet(budgets[1]);
            GlobalGet(ModuleWriter.AllocationBudgetGlobal);
            LocalSet(budgets[2]);
            epoch = NewLocal(WType.I32);
            GlobalGet(frontend.EpochGlobal);
            LocalSet(epoch);
        }

        if (!recover)
        {
            Call(frontend.ImportEnter);
            LocalSet(depth);
            Call(function);
            LocalGet(depth);
            Call(frontend.ImportLeave);
        }
        else
        {
            GlobalGet(frontend.EntriesGlobal);
            LocalSet(depth);
            LocalGet(depth);
            GlobalSet(frontend.ImportsGlobal);
            Call(function);
            LocalGet(depth);
            code.I32(1);
            code.Byte(0x6b); // i32.sub
            GlobalSet(frontend.ImportsGlobal);
            GlobalGet(frontend.EpochGlobal);
            LocalGet(epoch);
            code.Byte(0x47); // i32.ne
            TrapIf(FaultCode.AbandonedEntry);
            GlobalGet(frontend.EntriesGlobal);
            LocalGet(depth);
            code.Byte(0x47); // i32.ne
            OpenBlock(0x04, WType.Void, new object());
            if (frontend.HasRecover)
            {
                LocalGet(depth);
                Call(frontend.Recover);
            }

            LocalGet(depth);
            GlobalSet(frontend.EntriesGlobal);
            LocalGet(budgets[0]);
            GlobalSet(ModuleWriter.FuelGlobal);
            LocalGet(budgets[1]);
            GlobalSet(ModuleWriter.CallDepthGlobal);
            LocalGet(budgets[2]);
            GlobalSet(ModuleWriter.AllocationBudgetGlobal);
            code.I32(0);
            GlobalSet(ModuleWriter.FaultGlobal);
            CloseBlock();
        }

        if (handlers >= 0)
        {
            LocalGet(handlers);
            GlobalSet(frontend.HandlersGlobal);
            LocalGet(handlerBase);
            GlobalSet(frontend.HandlerBaseGlobal);
        }
    }

    // A class's initializer. Done or running (by this entry or one it is
    // nested in), it returns; failed, it throws the class's
    // TypeInitializationException again. Otherwise it resets the class's
    // static fields, marks it running and runs the steps, like the CLR's
    // type initializer a boundary no exception crosses: what escapes is
    // wrapped, recorded and thrown. An exception from the host leaves the
    // class uninitialized.
    private void EmitClassInitializer()
    {
        var initialization = frontend.LazyClass(plan.ContainingType)!;
        GlobalGet(initialization.State);
        int state = Save(WType.I32);
        LocalGet(state);
        OpenBlock(0x04, WType.Void, new object());
        LocalGet(state);
        code.I32(Frontend.InitFailed);
        code.Byte(0x46); // i32.eq
        OpenBlock(0x04, WType.Void, new object());
        GlobalGet(initialization.Error);
        code.Byte(0xd4); // ref.as_non_null
        ThrowException();
        CloseBlock();
        Branch(returnLabel);
        CloseBlock();

        foreach (var (field, type) in frontend.StaticFields(initialization.Type))
        {
            var location = new Location(LocationKind.Global, type, Frontend.StorageType(field), Global: frontend.GlobalIndex(field),
                Boxed: type.IsTuple);
            int value = NewLocal(type);
            PushDefault(type);
            LocalSet(value);
            Store(location, value);
        }

        code.I32(Frontend.RunningState);
        GlobalGet(frontend.EntriesGlobal);
        code.Byte(0x6a); // i32.add
        GlobalSet(initialization.State);

        int handlerBase = -1;
        if (frontend.TwoPass)
        {
            // A handler of its own: the filters outside never see what the
            // initializer throws.
            handlerBase = NewLocal(WType.I32);
            GlobalGet(frontend.HandlerBaseGlobal);
            LocalSet(handlerBase);
            GlobalGet(frontend.HandlersGlobal);
            GlobalSet(frontend.HandlerBaseGlobal);
        }

        void RestoreHandlers()
        {
            if (handlerBase >= 0)
            {
                LocalGet(handlerBase);
                GlobalSet(frontend.HandlerBaseGlobal);
            }
        }

        var exceptionType = WType.Ref(frontend.ExceptionHeap);
        var host = new object();
        var failed = new object();
        OpenBlock(0x02, WType.ExnRef, host);
        OpenBlock(0x02, exceptionType, failed);
        OpenTryTable((0x00, 0, failed), (0x03, -1, host)); // catch the tag, catch_all_ref
        foreach (var step in initialization.Steps)
        {
            Call(frontend.MethodIndex(step.Constructor));
        }

        CloseBlock();
        RestoreHandlers();
        code.I32(Frontend.InitDone);
        GlobalSet(initialization.State);
        Branch(returnLabel);
        CloseBlock();

        int inner = Save(exceptionType);
        RestoreHandlers();
        EmitNewException(frontend.TypeInitializationException, () => code.I32(Frontend.UnhandledExceptionFault));
        if (frontend.ExceptionMessages)
        {
            // The CLR's message, the name of the class, and what escaped.
            int created = Save(frontend.MapType(frontend.TypeInitializationException));
            string name = Frontend.FullName(initialization.Type);
            LocalGet(created);
            EmitLiteral($"The type initializer for '{name}' threw an exception.");
            code.Gc(5, frontend.ExceptionHeap, frontend.MessageField); // struct.set
            LocalGet(created);
            LocalGet(inner);
            code.Gc(5, frontend.ExceptionHeap, frontend.InnerField);
            LocalGet(created);
            EmitLiteral(name);
            code.Gc(5, frontend.MapType(frontend.TypeInitializationException).Heap, frontend.TypeNameField);
            LocalGet(created);
        }

        GlobalSet(initialization.Error);
        code.I32(Frontend.InitFailed);
        GlobalSet(initialization.State);
        GlobalGet(initialization.Error);
        code.Byte(0xd4); // ref.as_non_null
        ThrowException();
        CloseBlock();

        RestoreHandlers();
        code.I32(0);
        GlobalSet(initialization.State);
        code.Byte(0x0a); // throw_ref
    }

    // Throws the exception on the stack, first choosing its clause in a
    // module with filters.
    private void ThrowException()
    {
        if (frontend.TwoPass)
        {
            Call(frontend.Raise);
        }
        else
        {
            code.OpIndex(0x08, 0); // throw
        }

        code.Byte(0x00); // unreachable
    }
}
