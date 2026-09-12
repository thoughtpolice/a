// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// Lowers one function to Wasm: the IL of a method (FunctionEmitter.Il), or
// a function the compiler synthesizes. Unsupported code fails closed. This
// file holds the function shell, locations, calls and allocation; the
// numeric, intrinsic and object lowerings are in the other parts.
internal sealed partial class FunctionEmitter
{
    private readonly Frontend frontend;
    private readonly MethodPlan plan;
    private readonly WasmWriter code = new();
    private readonly List<WType> locals = [];
    // Locals that hold a flattened struct, by their first Wasm local.
    private readonly Dictionary<int, WType> tupleLocals = [];
    private readonly List<object> labels = [];
    private readonly object returnLabel = new();
    // The Wasm parameter each of the plan's parameters starts at.
    private readonly int[] parameterBases;
    private readonly int parameterCount;
    private readonly int returnSlot;
    // The local holding `this` as the method's own class. A virtual method
    // receives it as the class that introduced its slot and casts it once.
    private readonly int thisSlot;
    // The instantiation the operations being lowered belong to: the plan's,
    // or a static initialization step's.
    private Substitution generic;

    public FunctionEmitter(Frontend frontend, MethodPlan plan)
    {
        this.frontend = frontend;
        this.plan = plan;
        generic = plan.Generic;
        parameterBases = new int[plan.Parameters.Length];
        for (int index = 0; index < plan.Parameters.Length; index++)
        {
            parameterBases[index] = parameterCount;
            int leaves = frontend.Leaves(plan.Parameters[index]).Length;
            if (plan.Parameters[index].IsTuple && leaves != 0)
            {
                tupleLocals[parameterCount] = plan.Parameters[index];
            }

            parameterCount += leaves;
        }

        // A struct without fields is passed as nothing: its id is a local
        // of its own (which holds nothing either), not the next one's.
        for (int index = 0; index < plan.Parameters.Length; index++)
        {
            if (plan.Parameters[index].IsTuple && frontend.Leaves(plan.Parameters[index]).Length == 0)
            {
                parameterBases[index] = NewLocal(plan.Parameters[index]);
            }
        }

        returnSlot = plan.Result == WType.Void ? -1 : NewLocal(plan.Result);
        if (!plan.IsStatic && !Frontend.IsStruct(plan.ContainingType) && plan.Parameters[0] != Map(plan.ContainingType))
        {
            thisSlot = NewLocal(Map(plan.ContainingType));
        }
    }

    // MARK: Instantiation

    // Types and members as the IL names them, closed under the
    // current instantiation.
    private ITypeSymbol Sub(ITypeSymbol type) => frontend.Substitute(generic, type);

    private ITypeSymbol? SubOrNull(ITypeSymbol? type) => frontend.Substitute(generic, type);

    private WType Map(ITypeSymbol? type) => frontend.MapType(frontend.Substitute(generic, type));

    private IMethodSymbol Sub(IMethodSymbol method) => frontend.Substitute(generic, method);

    private Scalar? ScalarOfType(ITypeSymbol? type) => Frontend.ScalarOf(SubOrNull(type));

    public WasmFunction Emit()
    {
        if (frontend.Unlowered(plan) is { } deferred)
        {
            // A trap, and an error if the module keeps it.
            DeferredError = deferred;
            code.Byte(0x00); // unreachable
            code.Byte(0x0b); // end
            return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
        }

        switch (plan.Kind)
        {
            case MethodPlanKind.InterfaceThunk:
                return EmitInterfaceThunk();
            case MethodPlanKind.GenericDispatch:
                return EmitGenericDispatch();
            case MethodPlanKind.TypeObject:
                return EmitTypeObject();
            case MethodPlanKind.ObjectType:
                return EmitObjectType();
            case MethodPlanKind.ReferenceLoad:
                return EmitReferenceAccess(store: false);
            case MethodPlanKind.ReferenceStore:
                return EmitReferenceAccess(store: true);
            case MethodPlanKind.MethodGroupThunk:
                return EmitMethodGroupThunk();
            case MethodPlanKind.ThrowHelper:
                return EmitThrowHelper();
            case MethodPlanKind.Raise:
                return EmitRaise();
            case MethodPlanKind.GrowHandlers:
                return EmitGrowHandlers();
            case MethodPlanKind.Recover:
                return EmitRecover();
            case MethodPlanKind.ImportEnter:
                return EmitImportEnter();
            case MethodPlanKind.ImportLeave:
                return EmitImportLeave();
            case MethodPlanKind.Realloc:
                return EmitRealloc();
            case MethodPlanKind.ObjectDefault when plan.ContainingType is not null:
                return EmitDefaultToString();
            case MethodPlanKind.ObjectDefault:
                return EmitObjectDefault();
            case MethodPlanKind.BoxThunk:
                return EmitBoxThunk();
            case MethodPlanKind.BoxMember:
                return EmitBoxMember();
            case MethodPlanKind.ObjectHelper:
                return EmitObjectHelper();
            case MethodPlanKind.EnumFormat:
                return EmitEnumFormat();
            case MethodPlanKind.DelegateInvoker:
                return EmitDelegateInvoker();
            case MethodPlanKind.DelegateCombine:
                return EmitDelegateCombine();
            case MethodPlanKind.DelegateRemove:
                return EmitDelegateRemove();
            case MethodPlanKind.DelegateEqual:
                return EmitDelegateEqual();
            case MethodPlanKind.DelegateVariance:
                return EmitDelegateVariance();
            case MethodPlanKind.DelegateForward:
                return EmitDelegateForward();
            case MethodPlanKind.ExactStep:
                return EmitExactStep();
            case MethodPlanKind.StoreCheck:
                return EmitStoreCheck();
            case MethodPlanKind.SharedEntry:
                return EmitSharedEntry();
        }

        if (plan.Il is not null)
        {
            return EmitIl();
        }

        // What has no IL of its own: the module's static initializer, which
        // runs the static constructors initialized eagerly, and a lazily
        // initialized class's initializer.
        ConsumeFuel();
        GlobalGet(ModuleWriter.CallDepthGlobal);
        code.I32(frontend.Limits.CallDepth);
        code.Byte(0x4f); // i32.ge_u
        FaultIf(FaultCode.CallDepthExceeded);

        GlobalGet(ModuleWriter.CallDepthGlobal);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        GlobalSet(ModuleWriter.CallDepthGlobal);

        // Returns branch to this shared exit so every successful call restores depth.
        OpenBlock(0x02, WType.Void, returnLabel);
        switch (plan.Kind)
        {
            case MethodPlanKind.StaticInitializer:
                foreach (var step in frontend.StaticInitializers)
                {
                    Call(frontend.MethodIndex(step.Constructor));
                }

                break;
            case MethodPlanKind.ClassInitializer:
                EmitClassInitializer();
                break;
            default:
                throw new InternalCompilerError($"a {plan.Kind} method without IL.");
        }

        CloseBlock();

        GlobalGet(ModuleWriter.CallDepthGlobal);
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        GlobalSet(ModuleWriter.CallDepthGlobal);
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // MARK: Locals, blocks and faults

    // A new local; a flattened struct takes one Wasm local per leaf, and its
    // first stands for the whole value.
    private int NewLocal(WType type)
    {
        if (type == WType.Void)
        {
            throw new InternalCompilerError("void local.");
        }

        int id = parameterCount + locals.Count;
        var leaves = frontend.Leaves(type);
        locals.AddRange(leaves);
        if (leaves.Length == 0)
        {
            // A struct without fields holds nothing, but its id must not be
            // the next local's.
            locals.Add(WType.I32);
        }

        if (type.IsTuple)
        {
            tupleLocals[id] = type;
        }

        return id;
    }

    // Discards a value the code left on the stack, if any.
    private void Drop(WType type)
    {
        foreach (var _ in frontend.Leaves(type))
        {
            code.Byte(0x1a); // drop
        }
    }

    // A local, or every leaf of a flattened struct local, pushed or popped.
    private void LocalGet(int id)
    {
        if (tupleLocals.TryGetValue(id, out var type))
        {
            PushLocal(id, type);
            return;
        }

        code.OpIndex(0x20, id);
    }

    private void LocalSet(int id)
    {
        if (tupleLocals.TryGetValue(id, out var type))
        {
            PopLocal(id, type);
            return;
        }

        code.OpIndex(0x21, id);
    }

    // The same by type, for a nested struct starting inside another's
    // locals.
    private void PushLocal(int id, WType type)
    {
        int count = frontend.Leaves(type).Length;
        for (int leaf = 0; leaf < count; leaf++)
        {
            code.OpIndex(0x20, id + leaf);
        }
    }

    private void PopLocal(int id, WType type)
    {
        for (int leaf = frontend.Leaves(type).Length - 1; leaf >= 0; leaf--)
        {
            code.OpIndex(0x21, id + leaf);
        }
    }

    // The zero value of a type: zero leaves for a struct.
    private void PushDefault(WType type)
    {
        foreach (var leaf in frontend.Leaves(type))
        {
            leaf.Default(code);
        }
    }

    private void GlobalGet(int id) => code.OpIndex(0x23, id);
    private void GlobalSet(int id) => code.OpIndex(0x24, id);

    // Each function (or vtable) the code names, by its index before
    // pruning, and the code offset where its final index belongs. The code
    // leaves the index out: the frontend keeps only what the exports reach,
    // then splices them in.
    public List<Relocation> Relocations { get; } = [];

    private void Call(int function)
    {
        code.Byte(0x10); // call
        Relocations.Add(new(code.Length, RelocationKind.Call, function));
    }

    private void FunctionReference(int function)
    {
        code.Byte(0xd2); // ref.func
        Relocations.Add(new(code.Length, RelocationKind.FunctionReference, function));
    }

    private void CallReference(int signature) => code.OpIndex(0x14, signature); // call_ref

    private void StructNew(int heap) => code.Gc(0, heap); // struct.new

    // Saves the value on the stack in a new local of its type.
    private int Save(WType type)
    {
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

    private static bool SameLabel(object left, object right) => ReferenceEquals(left, right);

    // A branch that leaves the protected code of a finally goes through the
    // finally block, which takes the branch after running.
    // One that leaves the protected code of a try statement's handler
    // record takes the record off the stack first.
    private void Branch(object target, bool conditional = false)
    {
        for (int i = labels.Count - 1; i >= 0; i--)
        {
            if (SameLabel(labels[i], target))
            {
                code.OpIndex(conditional ? (byte)0x0d : (byte)0x0c, labels.Count - i - 1);
                return;
            }

            if (conditional && labels[i] is FinallyFrame or HandlerFrame)
            {
                OpenBlock(0x04, WType.Void, new object());
                Branch(target);
                CloseBlock();
                return;
            }

            if (labels[i] is HandlerFrame handlerFrame)
            {
                PopHandler(handlerFrame);
                continue;
            }

            if (labels[i] is FinallyFrame frame)
            {

                int number = frame.Targets.FindIndex(candidate => SameLabel(candidate, target));
                if (number < 0)
                {
                    number = frame.Targets.Count;
                    frame.Targets.Add(target);
                }

                code.I32(number + 1);
                LocalSet(frame.Kind);
                code.OpIndex(0x0c, labels.Count - i - 1); // br: into the finally block
                return;
            }
        }

        throw new InternalCompilerError("branch outside supported structured region.");
    }

    internal enum FaultCode
    {
        FuelExhausted = 1,
        CallDepthExceeded = 2,
        AllocationBudgetExceeded = 3,
        InvalidArrayLength = 4,
        NullReference = 5,
        ArrayIndexOutOfRange = 6,
        DivisionByZero = 7,
        DivisionOverflow = 8,
        ArithmeticOverflow = 9,
        InvalidArgument = 10,
        UnmatchedSwitch = 11,
        // The host entered the module again after a trap, abandoning an
        // entry that was waiting on an import (see Frontend.Initialization).
        AbandonedEntry = 12,
        InvalidCast = 13,
        // A collection modified while enumerated, or empty where it may not be.
        InvalidOperation = 14,
        KeyNotFound = 15,
        ArgumentOutOfRange = 16,
        // An earlier entry trapped, which ends the module (see
        // Frontend.Initialization).
        Poisoned = 18,
        // An object operation the CLR answers with what arrays and
        // delegates lack here (see Frontend.Boxing).
        Unsupported = 19,
        // A wait for a task that has not completed, which would block the
        // only thread (corelib/Frames.cs raises it).
        BlockingWait = 20,
    }

    private void FaultIf(FaultCode fault)
    {
        // Input is an i32 predicate. Faults are uncatchable Wasm traps in this
        // subset, and the wrapper resets state before the next host invocation.
        code.Byte(0x04); // if
        code.Byte(0x40); // empty block type
        Fault(fault);
        code.Byte(0x0b); // end
    }

    // Faults where the CLR would throw; in a module with exception handling,
    // the exception the CLR would throw is thrown instead.
    private void Fault(FaultCode fault)
    {
        if (frontend.Exceptions && Frontend.CatchableFaults.Contains((int)fault))
        {
            code.I32((int)fault);
            Call(frontend.ThrowHelper);
            code.Byte(0x00); // unreachable
            return;
        }

        Trap(fault);
    }

    // Faults that nothing catches: budgets, and limits the CLR does not have.
    private void Trap(FaultCode fault)
    {
        code.I32((int)fault);
        GlobalSet(ModuleWriter.FaultGlobal);
        code.Byte(0x00); // unreachable
    }

    private void TrapIf(FaultCode fault)
    {
        code.Byte(0x04); // if
        code.Byte(0x40); // empty block type
        Trap(fault);
        code.Byte(0x0b); // end
    }

    private void ConsumeFuel()
    {
        GlobalGet(ModuleWriter.FuelGlobal);
        code.Byte(0x45); // i32.eqz
        FaultIf(FaultCode.FuelExhausted);

        GlobalGet(ModuleWriter.FuelGlobal);
        code.I32(1);
        code.Byte(0x6b); // i32.sub
        GlobalSet(ModuleWriter.FuelGlobal);
    }

    // Consumes an i64 charge from the Wasm stack and deducts it from the budget.
    private void ChargeAllocation()
    {
        int charge = NewLocal(WType.I64);
        LocalSet(charge);
        GlobalGet(ModuleWriter.AllocationBudgetGlobal);
        LocalGet(charge);
        code.Byte(0x54); // i64.lt_u
        FaultIf(FaultCode.AllocationBudgetExceeded);

        GlobalGet(ModuleWriter.AllocationBudgetGlobal);
        LocalGet(charge);
        code.Byte(0x7d); // i64.sub
        GlobalSet(ModuleWriter.AllocationBudgetGlobal);
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

    // Stores an expression's value in a location whose receiver and index
    // are ready; a value that is not a struct goes straight to the store.
    // A store into an array of the covariant family (see Frontend.Arrays)
    // whose element type has subtypes with arrays: the value must be of
    // the array's exact element type, or the CLR throws
    // ArrayTypeMismatchException.
    private void CheckCovariantStore(Location location, int value)
    {
        if (!frontend.CovariantArrays || !frontend.IsRefArrayHeap(location.Container.Heap))
        {
            return;
        }

        var subtypes = frontend.StrictSubtypeArrays(location.TypeSymbol);
        if (subtypes.Count == 0)
        {
            return;
        }

        // One function checks every such store (Frontend.RegisterStoreCheck).
        LocalGet(location.Receiver);
        LocalGet(value);
        Call(frontend.StoreCheck);
    }

    // The store check's function: the array, then the value.
    private WasmFunction EmitStoreCheck()
    {
        int value = NewLocal(WType.Ref(Frontend.EqHeap));
        LocalGet(1);
        LocalSet(value);
        LocalGet(value);
        code.Byte(0xd1); // ref.is_null
        code.Byte(0x45); // i32.eqz
        OpenBlock(0x04, WType.Void, new object());
        foreach (var (array, heap) in frontend.CheckedArrays())
        {
            LocalGet(0);
            code.RefTest(WType.NonNullRef(heap));
            OpenBlock(0x04, WType.Void, new object());
            if (Frontend.IsSupportedDelegate(array.ElementType))
            {
                EmitDelegateTypeTest(value, array.ElementType);
            }
            else
            {
                EmitTypeTest(value, array.ElementType);
            }

            code.Byte(0x45); // i32.eqz
            OpenBlock(0x04, WType.Void, new object());
            Call(frontend.MethodIndex(frontend.RuntimeMethod("ArrayChecks", "Mismatch", 0)));
            code.Byte(0x00); // unreachable
            CloseBlock();
            CloseBlock();
        }

        CloseBlock();
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // Leaves 1 when the saved non-null delegate is of a type that converts
    // to `type` by reference (itself, or one by variance), by the type id
    // every delegate carries: delegate types of one signature share their
    // representation, and one converted by variance is a forwarding
    // delegate of its target's representation with its own type id.
    private void EmitDelegateTypeTest(int value, ITypeSymbol type)
    {
        var known = frontend.DelegateTypes.ToList();
        var ids = known
            .Where(other => SymbolEqualityComparer.Default.Equals(other, type)
                            || frontend.ClassifyConversion(other, type) is { IsImplicit: true, IsReference: true })
            .Select(frontend.DelegateTypeId)
            .ToList();
        var heaps = known.Select(other => frontend.DelegateOf(other).Heap).Distinct().ToList();
        code.I32(0);
        foreach (int heap in heaps)
        {
            LocalGet(value);
            code.RefTest(WType.NonNullRef(heap));
            OpenBlock(0x04, WType.I32, new object());
            LocalGet(value);
            code.RefCast(WType.NonNullRef(heap));
            code.Gc(2, heap, Frontend.DelegateTypeField); // struct.get
            int id = Save(WType.I32);
            code.I32(0);
            foreach (int other in ids)
            {
                LocalGet(id);
                code.I32(other);
                code.Byte(0x46); // i32.eq
                code.Byte(0x72); // i32.or
            }

            code.Byte(0x05); // else
            code.I32(0);
            CloseBlock();
            code.Byte(0x72); // i32.or
        }
    }

    // An `if` with a value: the condition is on the stack. A struct value
    // goes through a local, since blocks here yield at most one value.
    private WType EmitChoice(WType type, Action whenTrue, Action whenFalse)
    {
        int result = type.IsTuple ? NewLocal(type) : -1;
        OpenBlock(0x04, type.IsTuple ? WType.Void : type, new object());
        whenTrue();
        if (result >= 0)
        {
            LocalSet(result);
        }

        code.Byte(0x05); // else
        whenFalse();
        if (result >= 0)
        {
            LocalSet(result);
        }

        CloseBlock();
        if (result >= 0)
        {
            LocalGet(result);
        }

        return type;
    }

    // MARK: Locations

    private enum LocationKind
    {
        Local,
        Field,
        Global,
        ArrayElement,
    }

    // Receiver and index expressions are saved once, before a location is
    // read or written. A boxed location's slot holds a reference to the
    // storage (a struct's box, or a cell) rather than the value; NonNull
    // marks a receiver that cannot be null; ReadOnly a struct C# may not
    // mutate through this location (a method that could mutate it runs on a
    // copy).
    private sealed record Location(
        LocationKind Kind,
        WType Type,
        ITypeSymbol TypeSymbol,
        int Local = -1,
        int Receiver = -1,
        int Index = -1,
        WType Container = default,
        int Field = -1,
        int Global = -1,
        bool Boxed = false,
        bool NonNull = false,
        bool ReadOnly = false,
        bool Handle = false,
        INamedTypeSymbol? Class = null,
        // A multidimensional array's element (see Frontend.Arrays): the
        // array, its indices and its type; Receiver and Index are the flat
        // array and index, set when the location is checked.
        int MdArray = -1,
        int[]? MdIndices = null,
        INamedTypeSymbol? MdType = null);

    private void CheckLocation(Location location)
    {
        if (location.NonNull)
        {
            return;
        }

        if (location.Kind is LocationKind.Field)
        {
            CheckNull(location.Receiver);
        }
        else if (location.Kind == LocationKind.ArrayElement && location.MdIndices is not null)
        {
            CheckMdElement(location);
        }
        else if (location.Kind == LocationKind.ArrayElement)
        {
            CheckArray(location.Receiver, location.Index);
        }
    }

    // Pushes the location's slot: its value, or for a boxed location the
    // reference to the storage.
    private void LoadSlot(Location location)
    {
        switch (location.Kind)
        {
            case LocationKind.Local:
                if (location.Boxed)
                {
                    code.OpIndex(0x20, location.Local); // local.get: the box
                }
                else
                {
                    PushLocal(location.Local, location.Type);
                }

                break;
            case LocationKind.Field:
                LocalGet(location.Receiver);
                code.Gc(2, location.Container.Heap, location.Field); // struct.get
                break;
            case LocationKind.Global:
                EnsureInitialized(location.Class);
                GlobalGet(location.Global);
                break;
            case LocationKind.ArrayElement:
                LocalGet(location.Receiver);
                LocalGet(location.Index);
                code.Gc(11, location.Container.Heap); // array.get
                if (frontend.CovariantArrays && frontend.IsRefArrayHeap(location.Container.Heap)
                    && location.Type.IsRef && location.Type.Heap != Frontend.EqHeap)
                {
                    // An array of the covariant family holds references.
                    code.RefCast(location.Type);
                }

                break;
        }
    }

    private void Load(Location location)
    {
        LoadSlot(location);
        if (location.Boxed && location.Handle)
        {
            LoadThroughReference(location.Type);
        }
        else if (location.Boxed)
        {
            Unbox(location.Type);
        }
    }

    private void Store(Location location, int value)
    {
        if (location.Boxed)
        {
            LoadSlot(location);
            if (location.Handle)
            {
                StoreThroughReference(location.Type, value);
            }
            else
            {
                WriteThrough(location.Type, value);
            }
            return;
        }

        switch (location.Kind)
        {
            case LocationKind.Local:
                LocalGet(value);
                PopLocal(location.Local, location.Type);
                break;
            case LocationKind.Field:
                LocalGet(location.Receiver);
                LocalGet(value);
                code.Gc(5, location.Container.Heap, location.Field); // struct.set
                break;
            case LocationKind.Global:
                EnsureInitialized(location.Class);
                LocalGet(value);
                GlobalSet(location.Global);
                break;
            case LocationKind.ArrayElement:
                CheckCovariantStore(location, value);
                LocalGet(location.Receiver);
                LocalGet(location.Index);
                LocalGet(value);
                code.Gc(14, location.Container.Heap); // array.set
                break;
        }
    }

    private WType EmitAllocation(
        ITypeSymbol closed,
        IMethodSymbol constructor,
        int[] arguments)
    {
        var type = frontend.MapType(closed);
        int constructorIndex = frontend.ConstructorIndex(constructor);
        if (constructorIndex < 0)
        {
            // No constructor runs to trigger the classes' initialization.
            for (var current = closed as INamedTypeSymbol; current is not null; current = current.BaseType)
            {
                if (frontend.LazyClass(current) is { Precise: true })
                {
                    EnsureInitialized(current);
                }
            }
        }

        int receiver = EmitNewInstance(closed);
        EmitExceptionConstructor(receiver, constructor, arguments);

        if (constructorIndex >= 0)
        {
            LocalGet(receiver);
            foreach (int argument in arguments)
            {
                LocalGet(argument);
            }

            // Constructors share normal method fuel and call-depth accounting.
            Call(constructorIndex);
        }

        LocalGet(receiver);
        return type;
    }

    // A new, charged instance of a class, zeroed but for its vtable (and an
    // exception's fault code and message), in a new local.
    private int EmitNewInstance(ITypeSymbol closed)
    {
        var type = frontend.MapType(closed);
        code.I64(16L + frontend.AllocationFields(type) * 8L);
        ChargeAllocation();
        var fields = frontend.Fields(type);
        if (frontend.VTableGlobal(closed) is { } vtable)
        {
            // The vtable is set before any constructor runs, so a virtual
            // call from a base constructor reaches the override, as in the CLR.
            code.Byte(0x23); // global.get
            Relocations.Add(new(code.Length, RelocationKind.VTable, vtable));
            // An exception starts with its class's fault code, and the
            // message of an exception without one.
            bool exception = frontend.IsException(closed);
            for (int field = 1; field < fields.Count; field++)
            {
                if (exception && field == frontend.FaultField)
                {
                    code.I32(frontend.ExceptionFault(closed));
                }
                else if (exception && frontend.ExceptionMessages && field == frontend.MessageField)
                {
                    EmitLiteral(Frontend.DefaultMessage((INamedTypeSymbol)closed));
                }
                else
                {
                    PushStorageDefault(fields[field].Type);
                }
            }

            StructNew(type.Heap);
        }
        else if (fields.Any(field => frontend.BoxOwner(field.Type) is not null))
        {
            // The boxes of struct fields are allocated with the object.
            foreach (var field in fields)
            {
                PushStorageDefault(field.Type);
            }

            StructNew(type.Heap);
        }
        else
        {
            code.Gc(1, type.Heap); // struct.new_default
        }

        return Save(type);
    }

    // The zero value a heap field or array element starts with: a struct's
    // new box, or the default of anything else.
    private void PushStorageDefault(WType type)
    {
        if (frontend.BoxOwner(type) is { } layout && !type.IsNullable)
        {
            frontend.WriteNewBox(code, layout);
            return;
        }

        type.Default(code);
    }

    // A new array of a length in a local, its elements zeroed: a struct
    // element's a new box each.
    private WType EmitNewArray(IArrayTypeSymbol arraySymbol, int length)
    {
        var type = frontend.MapType(arraySymbol);
        var elementType = frontend.MapType(Sub(arraySymbol.ElementType));

        // Logical allocation cost: a 16-unit header plus 8 units per element,
        // or per leaf of a struct element.
        LocalGet(length);
        code.Byte(0xad); // i64.extend_i32_u
        code.I64(8L * frontend.BoxCharge(elementType));
        code.Byte(0x7e); // i64.mul
        code.I64(16);
        code.Byte(0x7c); // i64.add
        ChargeAllocation();
        LocalGet(length);
        // Of its own, exact type (an array of the covariant family is typed
        // as any of it).
        code.Gc(7, frontend.IsFamilyArray(arraySymbol) ? frontend.ArrayAllocationHeap(arraySymbol) : type.Heap); // array.new_default
        if (elementType.IsTuple)
        {
            int array = NewLocal(type);
            LocalSet(array);
            FillBoxes(array, length, type, frontend.StructOf(elementType));
            LocalGet(array);
        }

        return type;
    }

    // Fills a new array of structs with a zeroed box per element; the array's
    // charge counts them.
    private void FillBoxes(int array, int length, WType arrayType, StructLayout layout)
    {
        int index = NewLocal(WType.I32);
        code.I32(0);
        LocalSet(index);
        var exit = new object();
        var repeat = new object();
        OpenBlock(0x02, WType.Void, exit);
        OpenBlock(0x03, WType.Void, repeat);
        LocalGet(index);
        LocalGet(length);
        code.Byte(0x4f); // i32.ge_u
        Branch(exit, true);
        LocalGet(array);
        LocalGet(index);
        frontend.WriteNewBox(code, layout);
        code.Gc(14, arrayType.Heap); // array.set
        LocalGet(index);
        code.I32(1);
        code.Byte(0x6a); // i32.add
        LocalSet(index);
        Branch(repeat);
        CloseBlock();
        CloseBlock();
    }

    // The receiver and arguments are on the stack; a virtual call finds the
    // function in the vtable of the saved receiver, already checked for null.
    private void EmitCallTarget(CallTarget target, int receiver)
    {
        if (!target.IsVirtual)
        {
            if (target.Function < frontend.ImportCount)
            {
                CallImport(target.Function);
                return;
            }

            Call(target.Function);
            return;
        }

        if (target.Use is { } use)
        {
            SlotUses.Add(use);
        }

        if (target.EnumerableElement is { } element)
        {
            EmitEnumerableGetEnumerator(target, receiver, element);
            return;
        }

        if (target.ArrayCall is { } arrayCall)
        {
            EmitArrayInterfaceCall(target, receiver, arrayCall);
            return;
        }

        if (target.ObjectArrayCall is { } helper)
        {
            EmitObjectArrayInterfaceCall(target, receiver, helper);
            return;
        }

        LocalGet(receiver);
        code.Gc(2, target.Heap, 0); // struct.get: the vtable, or a delegate's function
        if (target.Interface >= 0)
        {
            code.Gc(2, target.VTable, 0); // struct.get: the itables
            code.I32(target.Interface);
            code.Gc(11, frontend.ITables); // array.get
            code.RefCast(WType.NonNullRef(target.Table));
            code.Gc(2, target.Table, target.Slot); // struct.get: the member
        }
        else if (target.VTable >= 0)
        {
            code.Gc(2, target.VTable, target.Slot); // struct.get: the slot
        }

        CallReference(target.Signature);
    }

    // An itable slot: `this` arrives as an $Object whose class implements
    // the interface, the arguments as they are. A thunk is no C# call of its
    // own, so it spends no fuel or depth; the implementation does.
    private WasmFunction EmitInterfaceThunk()
    {
        LocalGet(0);
        code.RefCast(locals[thisSlot - parameterCount]);
        LocalSet(thisSlot);
        LocalGet(thisSlot);
        var target = frontend.ResolveCall(plan.Symbol!, plan.ContainingType, false);
        // The member's parameters are its canonical form's (Frontend.Sharing).
        PushParametersFor(target, plan.Symbol!, 1, 1);
        EmitCallTarget(target, thisSlot);
        CastToShape(TargetShape(target, plan.Symbol!).Result, plan.Result);
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }

    // A generic virtual method's dispatcher: the receiver tested against
    // each concrete class, most derived first, and the class's
    // implementation called. A dispatcher is no C# call of its own; the
    // implementation spends the fuel and depth.
    private WasmFunction EmitGenericDispatch()
    {
        foreach (var (layout, implementation) in frontend.GenericDispatchTargets(plan.Symbol!))
        {
            EmitHeapTest(0, layout.Symbol, layout.Heap);
            OpenBlock(0x04, WType.Void, new object());
            LocalGet(0);
            if (layout.IsBox)
            {
                code.RefCast(WType.NonNullRef(layout.Heap));
                code.Gc(2, layout.Heap, frontend.BoxValueField); // struct.get: the storage
            }
            else
            {
                code.RefCast(frontend.MethodPlanOf(implementation).Parameters[0]);
            }

            int called = layout.IsBox ? frontend.BoxMethodIndex(implementation) : frontend.MethodIndex(implementation);
            PushParametersFor(new CallTarget(called), implementation, 1, 1);
            Call(called);
            if (plan.Result.IsRef && plan.Result != frontend.PlanOfFunction(called).Result)
            {
                code.RefCast(plan.Result);
            }

            code.Byte(0x0f); // return
            CloseBlock();
        }

        Trap(FaultCode.Unsupported);
        code.Byte(0x0b); // end
        return new(plan.Name, plan.Parameters, plan.Result, locals.ToArray(), code.ToArray());
    }
}
