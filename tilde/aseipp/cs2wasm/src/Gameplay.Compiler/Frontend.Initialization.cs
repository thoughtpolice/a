// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection.Metadata;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// How a class's static state is initialized: its static field initializers
// in declaration order, then its static constructor, as C# orders them.
//
// A class with a static constructor is initialized precisely, as the CLR
// does: on the first access to one of its static fields, the first call of
// one of its static methods (properties and operators included), or the
// first run of one of its instance constructors, whichever comes first. A
// class with only field initializers (beforefieldinit in the CLR, which
// may initialize it at any time before the first static field access) is
// initialized at the first access to one of its static fields. Two kinds
// of those need no code at all: when every initializer is a constant, the
// fields' globals start with those values; when every one is pure (it can
// neither throw nor have an effect beyond the class's own fields:
// constants, arithmetic without division, arrays of constant length, structs
// with trivial constructors), they run before the first entry's code, when
// no one can tell the difference.
//
// Otherwise the class has a state global and an initializer function that
// every access site not already known to be past it calls while the state
// is not "done". The function resets the class's static fields, runs the
// initializers, and records the result: done; or failed, with the
// TypeInitializationException wrapping what escaped, which it throws then
// and again from every later access, as the CLR does; or, while running,
// the depth of the entry running it, so that an access from inside
// (recursion, or a host import calling back in) sees the partially
// initialized state, as the CLR's same thread does.
//
// A trap (a budget, an unhandled exception, or the engine) ends the whole
// module, as it ends a .NET process. Entries count themselves in
// `__entries` and import calls in `__imports`; while nothing traps, an entry
// finds them equal. A trap leaves `__entries` ahead, and the entry or import
// call that notices poisons the module (`__poisoned`): every entry after
// faults with 18.
//
// With --recover-after-trap, a trap that stopped an initializer halfway
// leaves its class "running" with nothing running it instead, and the next
// entry that notices resets every class left running to uninitialized, so it is
// initialized again from the start (its fields reset first) instead of being
// seen half done. An import call that returns to find `__entries` ahead
// resets only the classes of the entries its host swallowed a trap from. A
// host that swallows a trap and enters again before returning makes the
// next entry treat every entry as abandoned: it bumps `__epoch`, and an
// abandoned entry traps with fault 12 when its import call returns, since
// the classes it was initializing have been reset under it.
internal sealed partial class Frontend
{
    internal sealed class ClassInitialization(INamedTypeSymbol type, bool precise)
    {
        public INamedTypeSymbol Type { get; } = type;

        public bool Precise { get; } = precise;

        public List<StaticInitializerPlan> Steps { get; } = [];

        public int Function { get; set; } = -1;

        public int State { get; set; } = -1;

        public int Error { get; set; } = -1;
    }

    // The states of a lazily initialized class; a running one stores
    // RunningState plus the depth of the entry running it.
    public const int InitDone = 1;
    public const int InitFailed = 2;
    public const int RunningState = 3;

    private readonly Dictionary<INamedTypeSymbol, ClassInitialization> lazyClasses = new(SymbolEqualityComparer.Default);
    private int recoverFunction = -1;

    public int EagerFlagGlobal { get; private set; } = -1;

    public int EntriesGlobal { get; private set; } = -1;

    public int ImportsGlobal { get; private set; } = -1;

    public int EpochGlobal { get; private set; } = -1;

    public int PoisonGlobal { get; private set; } = -1;

    public bool HasRecover => recoverFunction >= 0;

    private int importEnterFunction = -1;

    public int ImportEnter => imports.Count + importEnterFunction;

    public int ImportLeave => imports.Count + importEnterFunction + 1;

    // Without recovery, every import call does the same bookkeeping, shared
    // in two functions.
    private void RegisterImportBookkeeping()
    {
        if (imports.Count == 0 || Limits.RecoverAfterTrap)
        {
            return;
        }

        importEnterFunction = methods.Count;
        methods.Add(new(
            null, "<import enter>", [], WType.I32, true, null, MethodPlanKind.ImportEnter, Substitution.Empty));
        methods.Add(new(
            null, "<import leave>", [WType.I32], WType.Void, true, null, MethodPlanKind.ImportLeave,
            Substitution.Empty));
    }

    public int Recover => imports.Count + recoverFunction;

    public ClassInitialization? LazyClass(ITypeSymbol? type) =>
        type is INamedTypeSymbol named && lazyClasses.TryGetValue(named, out var initialization) ? initialization : null;

    public int InitializerIndex(ClassInitialization initialization) => imports.Count + initialization.Function;

    public IEnumerable<ClassInitialization> LazyClasses => lazyClasses.Values;

    public INamedTypeSymbol TypeInitializationException =>
        TypeNamed("System.TypeInitializationException")!;

    // What Activator.CreateInstance<T>() throws for a class without a public
    // parameterless constructor (a Lazy<T>'s default value, say), and
    // whether a class is one.
    public INamedTypeSymbol MissingMethodException => TypeNamed("System.MissingMethodException")!;

    public static bool LacksPublicParameterless(ITypeSymbol type) =>
        type.IsReferenceType && (type.IsAbstract || DefaultConstructor(type) is not { DeclaredAccessibility: Accessibility.Public });

    // Groups the static initialization steps class by class, each class's
    // field initializers in declaration order, then its static
    // constructor, and decides how each class is initialized. The eager
    // classes' steps stay in staticInitializers, in the order classes were
    // discovered.
    private void ClassifyStaticInitialization()
    {
        // An imported beforefieldinit class's static constructor is its
        // one step.
        var fieldSteps = staticInitializers.ToLookup(
            step => step.Constructor.ContainingType, SymbolEqualityComparer.Default);
        var eager = new List<StaticInitializerPlan>();
        foreach (var type in classOrder.Distinct<INamedTypeSymbol>(SymbolEqualityComparer.Default))
        {
            bool precise = staticConstructors.TryGetValue(type, out var constructor);
            var initialization = new ClassInitialization(type, precise);
            initialization.Steps.AddRange(fieldSteps[type]);
            if (precise)
            {
                initialization.Steps.Add(new(constructor!, SubstitutionOf(type)));
            }

            if (initialization.Steps.Count == 0)
            {
                continue;
            }

            if (!precise && initialization.Steps is [{ Constructor: var imported }]
                     && IsPureIlInitializer(imported, type))
            {
                eager.AddRange(initialization.Steps);
            }
            else
            {
                lazyClasses.Add(type, initialization);
                initialization.Function = methods.Count;
                methods.Add(new(
                    null, $"<initialize> {type.ToDisplayString()}", [], WType.Void, true, type,
                    MethodPlanKind.ClassInitializer, SubstitutionOf(type)));
            }
        }

        staticInitializers.Clear();
        staticInitializers.AddRange(eager);
        if (lazyClasses.Count == 0)
        {
            return;
        }

        // What escapes an initializer is wrapped and rethrown, so the
        // module handles exceptions.
        exceptions = true;
        RegisterFrameworkClass(TypeInitializationException);
        if (!Limits.RecoverAfterTrap)
        {
            return;
        }

        recoverFunction = methods.Count;
        methods.Add(new(
            null, "<recover>", [WType.I32], WType.Void, true, null, MethodPlanKind.Recover, Substitution.Empty));
    }

    // The globals of initialization follow the static fields: the eager
    // classes' flag, then the entry and import counters and the epoch (for
    // lazy classes and the boundary memory's arena, see Frontend.Memory),
    // the arena's end, then each lazy class's state and failure.
    private int AssignInitializationGlobals()
    {
        int next = FirstStaticGlobal + globals.Count;
        if (staticInitializers.Count != 0)
        {
            EagerFlagGlobal = next++;
        }

        EntriesGlobal = next++;
        if (imports.Count != 0)
        {
            ImportsGlobal = next++;
            if (Limits.RecoverAfterTrap)
            {
                EpochGlobal = next++;
            }
        }

        if (!Limits.RecoverAfterTrap)
        {
            PoisonGlobal = next++;
        }

        if (boundaryMemory)
        {
            HeapTopGlobal = next++;
            if (heapFloor)
            {
                HeapFloorGlobal = next++;
            }

            if (hostChain)
            {
                HostChainGlobal = next++;
            }
        }

        foreach (var initialization in lazyClasses.Values)
        {
            initialization.State = next++;
            initialization.Error = next++;
        }

        return next;
    }

    private List<WasmGlobal> InitializationGlobals()
    {
        var result = new List<WasmGlobal>();
        if (EagerFlagGlobal >= 0)
        {
            result.Add(new("__initialized", WType.I32));
        }

        if (EntriesGlobal >= 0)
        {
            result.Add(new("__entries", WType.I32));
        }

        if (ImportsGlobal >= 0)
        {
            result.Add(new("__imports", WType.I32));
        }

        if (EpochGlobal >= 0)
        {
            result.Add(new("__epoch", WType.I32));
        }

        if (PoisonGlobal >= 0)
        {
            result.Add(new("__poisoned", WType.I32));
        }

        if (HeapTopGlobal >= 0)
        {
            var heapBase = new WasmWriter();
            heapBase.I32(HeapBase);
            result.Add(new("__heap_top", WType.I32, Initializer: heapBase.ToArray()));
            if (HeapFloorGlobal >= 0)
            {
                result.Add(new("__heap_floor", WType.I32, Initializer: heapBase.ToArray()));
            }

            if (HostChainGlobal >= 0)
            {
                result.Add(new("__host_chain", WType.I32));
            }
        }

        foreach (var initialization in lazyClasses.Values)
        {
            result.Add(new("state " + initialization.Type.ToDisplayString(), WType.I32));
            result.Add(new("failure " + initialization.Type.ToDisplayString(), WType.Ref(ExceptionHeap)));
        }

        return result;
    }

    // A beforefieldinit class's static constructor (C#'s field
    // initializers) that only computes constants, arrays of constant
    // lengths and objects of trivial constructors, and stores them in the
    // class's own static fields, runs eagerly.
    private bool IsPureIlInitializer(IMethodSymbol constructor, INamedTypeSymbol type) =>
        IlPlanOf(constructor) is { } plan && IsPureIl(new IlAnalysis(this, plan), type, null, 0);

    private MethodPlan? IlPlanOf(IMethodSymbol method)
    {
        // The plans are only ever added to; the first of a method's counts.
        for (; ilPlansSeen < methods.Count; ilPlansSeen++)
        {
            if (methods[ilPlansSeen] is { Il: not null, Symbol: { } symbol } plan)
            {
                ilPlans.TryAdd(symbol, plan);
            }
        }

        return ilPlans.GetValueOrDefault(method);
    }

    private readonly Dictionary<IMethodSymbol, MethodPlan> ilPlans = new(SymbolEqualityComparer.Default);

    private int ilPlansSeen;

    // Whether code only computes and stores: a static constructor's
    // (`instance` null) into its class's static fields, a constructor's into
    // its own instance's fields from its parameters.
    private bool IsPureIl(IlAnalysis flow, INamedTypeSymbol type, INamedTypeSymbol? instance, int depth)
    {
        if (flow.Groups.Count != 0 || depth > 4)
        {
            return false;
        }

        for (int index = 0; index < flow.Instructions.Length; index++)
        {
            var instruction = flow.Instructions[index];
            var operand = flow.Operands[index];
            bool pure = instruction.OpCode switch
            {
                ILOpCode.Nop or ILOpCode.Ret or ILOpCode.Dup or ILOpCode.Pop => true,
                ILOpCode.Ldc_i4 or ILOpCode.Ldc_i8 or ILOpCode.Ldc_r4 or ILOpCode.Ldc_r8 or ILOpCode.Ldnull or ILOpCode.Ldstr => true,
                ILOpCode.Ldloc or ILOpCode.Stloc or ILOpCode.Ldloca => true,
                ILOpCode.Ldarg => instance is not null,
                ILOpCode.Conv_i1 or ILOpCode.Conv_i2 or ILOpCode.Conv_i4 or ILOpCode.Conv_i8 or ILOpCode.Conv_u1
                    or ILOpCode.Conv_u2 or ILOpCode.Conv_u4 or ILOpCode.Conv_u8 or ILOpCode.Conv_r4 or ILOpCode.Conv_r8
                    or ILOpCode.Conv_r_un or ILOpCode.Conv_i or ILOpCode.Conv_u => true,
                ILOpCode.Add or ILOpCode.Sub or ILOpCode.Mul or ILOpCode.And or ILOpCode.Or or ILOpCode.Xor
                    or ILOpCode.Shl or ILOpCode.Shr or ILOpCode.Shr_un or ILOpCode.Neg or ILOpCode.Not => true,
                // Division that cannot throw.
                ILOpCode.Div or ILOpCode.Rem => flow.Before[index][^1].Kind is IlKind.F32 or IlKind.F64,
                ILOpCode.Newarr => index > 0 && flow.Instructions[index - 1] is { OpCode: ILOpCode.Ldc_i4, Operand: var length }
                                   && length >= 0 && length <= Limits.ArrayLength,
                // An array initializer's elements, at constant indexes of the
                // array just made.
                ILOpCode.Stelem or ILOpCode.Stelem_i1 or ILOpCode.Stelem_i2 or ILOpCode.Stelem_i4 or ILOpCode.Stelem_i8
                    or ILOpCode.Stelem_r4 or ILOpCode.Stelem_r8 or ILOpCode.Stelem_ref => instance is null,
                ILOpCode.Ldtoken => operand is IFieldSymbol,
                ILOpCode.Initobj => true,
                ILOpCode.Ldsfld or ILOpCode.Ldsflda or ILOpCode.Stsfld =>
                    instance is null && operand is IFieldSymbol field && SymbolEqualityComparer.Default.Equals(field.ContainingType, type),
                ILOpCode.Stfld => instance is not null && operand is IFieldSymbol { IsStatic: false } own
                                  && SymbolEqualityComparer.Default.Equals(own.ContainingType, instance),
                ILOpCode.Call when operand is IMethodSymbol { Name: "InitializeArray", ContainingType.Name: "RuntimeHelpers" } => instance is null,
                ILOpCode.Call when instance is not null && operand is IMethodSymbol
                {
                    MethodKind: MethodKind.Constructor, ContainingType.SpecialType: SpecialType.System_Object,
                } => true,
                ILOpCode.Newobj or ILOpCode.Call when operand is IMethodSymbol { MethodKind: MethodKind.Constructor } made =>
                    IsTrivialIlConstructor(made, type, depth),
                _ => false,
            };
            if (!pure)
            {
                return false;
            }
        }

        return true;
    }

    // A constructor, of the module's struct or of its class deriving from
    // object, that only stores values of its parameters in its own fields.
    private bool IsTrivialIlConstructor(IMethodSymbol constructor, INamedTypeSymbol type, int depth)
    {
        var created = constructor.ContainingType;
        return !staticConstructors.ContainsKey(created) && IsModuleDefined(constructor)
               && (IsStruct(created) || (created.TypeKind == TypeKind.Class && created.BaseType?.SpecialType == SpecialType.System_Object
                                         && !IsException(created)))
               && IlPlanOf(constructor) is { } plan && IsPureIl(new IlAnalysis(this, plan), type, created, depth + 1);
    }

    public IEnumerable<(ISymbol Field, WType Type)> StaticFields(INamedTypeSymbol type) =>
        globals.Where(global => SymbolEqualityComparer.Default.Equals(global.Field.ContainingType, type));
}
