// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using Microsoft.CodeAnalysis;

namespace Gameplay.Compiler;

// What an instruction of a shared method's code is to its instantiations:
// a Thunk site runs as each exact instantiation runs it, through a function
// its dictionary holds (an ExactStep plan); a Function site calls the exact
// instantiation's method, whose function its dictionary holds; a Direct
// site is lowered once, over the canonical form, but reaches something
// each exact instantiation has of its own (a method of it), which
// discovery finds per instantiation.
internal enum SiteKind
{
    Thunk,
    Function,
    Direct,
}

internal sealed record SharedSite(int Index, SiteKind Kind, int Pops, bool Pushes);

// A method's code shared by its instantiations over reference types (see
// Frontend.SharedCode): the canonical method, its analysis under the
// canonical instantiation, and the instructions whose lowering depends on
// the exact type arguments.
internal sealed class SharedCode(IMethodSymbol method, IlAnalysis flow, Substitution generic, HashSet<ITypeParameterSymbol> parameters)
{
    public IMethodSymbol Method { get; } = method;

    public IlAnalysis Flow { get; } = flow;

    public Substitution Generic { get; } = generic;

    // The type parameters whose arguments the instantiations differ in.
    public HashSet<ITypeParameterSymbol> Parameters { get; } = parameters;

    public List<SharedSite> Sites { get; } = [];

    public Dictionary<int, SharedSite> SiteAt { get; } = [];

    // Whose dictionary holds the thunks (null without Thunk sites), and
    // whether the code finds it through `this`'s vtable (an instance
    // method of a class) or takes it as its last parameter.
    public DictionaryOwner? Owner { get; set; }

    public bool FromThis { get; set; }

    public bool HiddenDictionary => Owner is not null && !FromThis;

    public bool HasThunks => Sites.Any(site => site.Kind is SiteKind.Thunk or SiteKind.Function);

    public int Plan { get; set; } = -1;

    // The exact instantiations (their types', or their methods') that use
    // the code.
    public HashSet<ISymbol> Users { get; } = new(SymbolEqualityComparer.Default);

    // Each Thunk site's entry among its owner's own and function type.
    public Dictionary<int, int> EntryOf { get; } = [];

    public Dictionary<int, int> SignatureOf { get; } = [];
}

// A dictionary type: the canonical class, struct, interface or generic
// method whose shared code's Thunk sites it holds the functions of, after
// (for a class) its base class's.
internal sealed class DictionaryOwner(ISymbol symbol, bool statics, int type)
{
    public ISymbol Symbol { get; } = symbol;

    // A class's static methods' dictionary, apart from its instances'.
    public bool Statics { get; } = statics;

    // A class's is made at the end of discovery, after its base class's,
    // as the group declares supertypes first; the others' at once.
    public int Type { get; set; } = type;

    public List<(SharedCode Code, SharedSite Site)> Entries { get; } = [];

    public DictionaryOwner? Base { get; set; }

    public int First => Base?.Count ?? 0;

    public int Count => First + Entries.Count;
}

// An exact instantiation's dictionary: the ExactStep function of each
// Thunk site of the shared code it uses, a global made of them.
internal sealed class DictionaryInstance(int id, DictionaryOwner owner, ISymbol exact)
{
    public int Id { get; } = id;

    public DictionaryOwner Owner { get; } = owner;

    public ISymbol Exact { get; } = exact;

    // Each entry's function: an ExactStep's, or (-1 until discovery is
    // done) the exact method's in Functions.
    public Dictionary<(SharedCode Code, int Site), int> Thunks { get; } = [];

    public Dictionary<(SharedCode Code, int Site), IMethodSymbol> Functions { get; } = [];

    // A class's: its base class's dictionary, whose entries come first.
    public DictionaryInstance? Base { get; set; }
}

// Shared generics' code (docs/IMPORTER.md, "Shared generics"). A method of
// an instantiation over reference types runs its canonical form's code,
// compiled once over object (Frontend.Sharing gives every instantiation
// that representation), where that code's lowering does not depend on the
// exact type arguments. Where it does (a cast to T, `new T[n]`, `new
// List<T>()`, a static field of C<T>, a call of another instantiation's
// method), the instruction becomes a call through the exact
// instantiation's dictionary: a struct of functions, one per such
// instruction, each the instruction lowered as the exact instantiation
// lowers it (an ExactStep). An instance method of a class finds its
// dictionary in `this`'s vtable (a class's dictionary extends its base
// class's); a static method, a struct's method and a generic method take it
// as their last parameter, which an exact instantiation's entry function
// (a SharedEntry) passes. A method whose code folds by its exact type
// arguments, or that has filters, catch clauses of them or static state,
// is compiled per instantiation, as before.
internal sealed partial class Frontend
{
    private readonly Dictionary<IMethodSymbol, SharedCode?> sharedCodes = new(SymbolEqualityComparer.Default);
    private readonly Dictionary<(ISymbol Symbol, bool Statics), DictionaryOwner> dictionaryOwners = new(OwnerKeyComparer.Instance);
    private readonly Dictionary<(ISymbol Symbol, bool Statics), DictionaryInstance> dictionaryInstances = new(OwnerKeyComparer.Instance);

    private sealed class OwnerKeyComparer : IEqualityComparer<(ISymbol Symbol, bool Statics)>
    {
        public static readonly OwnerKeyComparer Instance = new();

        public bool Equals((ISymbol Symbol, bool Statics) left, (ISymbol Symbol, bool Statics) right) =>
            left.Statics == right.Statics && SymbolEqualityComparer.Default.Equals(left.Symbol, right.Symbol);

        public int GetHashCode((ISymbol Symbol, bool Statics) key) =>
            HashCode.Combine(SymbolEqualityComparer.Default.GetHashCode(key.Symbol), key.Statics);
    }
    private readonly List<DictionaryInstance> dictionaryOrder = [];
    private readonly List<(IMethodSymbol Exact, SharedCode Code)> pendingSharedUses = [];
    private readonly Dictionary<Instance, IlAnalysis> exactFlows = [];

    // Whether a type argument is one instantiations differ in: object (a
    // reference type's canonical form) or a struct over one.
    private static bool ContainsObject(ITypeSymbol type) => type switch
    {
        { SpecialType: SpecialType.System_Object } => true,
        IArrayTypeSymbol array => ContainsObject(array.ElementType),
        INamedTypeSymbol named => named.TypeArguments.Any(ContainsObject)
                                  || (named.ContainingType is { } outer && ContainsObject(outer)),
        _ => false,
    };

    // The type parameters of a canonical method's code whose arguments its
    // instantiations differ in.
    private static HashSet<ITypeParameterSymbol> SharedParameters(IMethodSymbol canonical)
    {
        var shared = new HashSet<ITypeParameterSymbol>(SymbolEqualityComparer.Default);
        for (var current = canonical.ContainingType; current is not null; current = current.ContainingType)
        {
            var parameters = current.OriginalDefinition.TypeParameters;
            for (int index = 0; index < parameters.Length; index++)
            {
                if (ContainsObject(current.TypeArguments[index]))
                {
                    shared.Add(parameters[index]);
                }
            }
        }

        if (canonical.IsGenericMethod)
        {
            var parameters = canonical.ConstructedFrom.OriginalDefinition.TypeParameters;
            for (int index = 0; index < parameters.Length; index++)
            {
                if (ContainsObject(canonical.TypeArguments[index]))
                {
                    shared.Add(parameters[index]);
                }
            }
        }

        return shared;
    }

    // The canonical methods only one exact instantiation used in the first
    // discovery: compiled per instantiation after all (Frontend.CoreLib
    // starts discovery again without sharing them), since one
    // instantiation's own code is smaller than shared code, its dictionary
    // and its functions.
    private readonly IReadOnlySet<string> unshared;

    private sealed class SharingRevised(HashSet<string> unshared, bool off) : Exception
    {
        public HashSet<string> Unshared { get; } = unshared;

        // No code is left to share: nothing gains by representations
        // shared over reference type arguments either.
        public bool Off { get; } = off;
    }

    private static string SharingKey(IMethodSymbol canonical) => SymbolKey(canonical);

    private readonly bool revised;

    private void ReviseSharing()
    {
        if (revised || !sharing)
        {
            return;
        }

        var planned = sharedCodes.Values.Where(code => code is { Plan: >= 0 }).Select(code => code!).ToList();
        var single = planned
            .Where(code => code.Users.Count <= 1)
            .Select(code => SharingKey(code.Method))
            .ToHashSet(StringComparer.Ordinal);
        bool off = single.Count == planned.Count;
        if (single.Count != 0 || (off && (representationLayouts.Count != 0 || refArrayHeap >= 0)))
        {
            throw new SharingRevised(single, off);
        }
    }

    // Whether an open symbol (as a definition names it) depends on a type
    // parameter the instantiations differ in.
    private static bool DependsOn(ISymbol? symbol, HashSet<ITypeParameterSymbol> shared) => symbol switch
    {
        null => false,
        ITypeParameterSymbol parameter => shared.Contains(parameter.OriginalDefinition) || shared.Contains(parameter),
        IArrayTypeSymbol array => DependsOn(array.ElementType, shared),
        IPointerTypeSymbol pointer => DependsOn(pointer.PointedAtType, shared),
        INamedTypeSymbol named => named.TypeArguments.Any(argument => DependsOn(argument, shared))
                                  || (named.ContainingType is { } outer && DependsOn(outer, shared)),
        IMethodSymbol method => DependsOn(method.ContainingType, shared)
                                || method.TypeArguments.Any(argument => DependsOn(argument, shared)),
        IFieldSymbol field => DependsOn(field.ContainingType, shared),
        IEventSymbol eventSymbol => DependsOn(eventSymbol.ContainingType, shared),
        _ => false,
    };

    // Whether a method's code must first initialize its class (a static
    // constructor C# runs precisely), which is each exact instantiation's
    // own: of a type its instantiations differ in.
    private bool HasStaticState(INamedTypeSymbol? type)
    {
        for (var current = type; current is not null; current = current.ContainingType)
        {
            if (ContainsObject(current)
                && current.GetMembers().Any(member => member is IMethodSymbol { MethodKind: MethodKind.StaticConstructor })
                && !IsBeforeFieldInit(current))
            {
                return true;
            }
        }

        return false;
    }

    // The shared code of a canonical method, or null where the method is
    // compiled per instantiation.
    public SharedCode? SharedCodeOf(IMethodSymbol canonical)
    {
        if (!sharing)
        {
            return null;
        }

        if (sharedCodes.TryGetValue(canonical, out var known))
        {
            return known;
        }

        if (unshared.Contains(SharingKey(canonical)))
        {
            // One instantiation uses it, whose own code is smaller.
            sharedCodes[canonical] = null;
            return null;
        }

        // Unshared while its analysis is in progress: a call of it from
        // its own callees is a Thunk site.
        sharedCodes[canonical] = null;
        var code = AnalyzeShared(canonical);
        sharedCodes[canonical] = code;
        if (Environment.GetEnvironmentVariable("GAMEPLAYC_DEBUG_SHARING") is not null)
        {
            Console.Error.WriteLine($"shared {(code is null ? "no " + unsharedReason : "yes " + code.Sites.Count(site => site.Kind == SiteKind.Thunk))} {canonical.ToDisplayString()}");
            foreach (var site in code?.Sites ?? [])
            {
                var operand = code!.Flow.Operands[site.Index];
                string what = operand switch
                {
                    IMethodSymbol m => (m.IsStatic ? "static " : m.ContainingType.TypeKind == TypeKind.Interface ? "interface " : m.IsVirtual || m.IsAbstract || m.IsOverride ? "virtual " : "instance ") + (m.IsGenericMethod ? "generic " : "") + (m.MethodKind == MethodKind.Constructor ? "ctor " + (m.ContainingType.TypeKind) : m.MethodKind.ToString()),
                    _ => operand?.GetType().Name ?? "",
                };
                Console.Error.WriteLine($"site {site.Kind} {code.Flow.Instructions[site.Index].OpCode} {what} :: {operand}");
            }
        }

        return code;
    }

    private string unsharedReason = "";

    private SharedCode? AnalyzeShared(IMethodSymbol canonical)
    {
        unsharedReason = "kind";
        if (canonical.MethodKind is not (MethodKind.Ordinary or MethodKind.Constructor or MethodKind.PropertyGet
                or MethodKind.PropertySet or MethodKind.EventAdd or MethodKind.EventRemove or MethodKind.ExplicitInterfaceImplementation
                or MethodKind.UserDefinedOperator or MethodKind.Conversion)
            || canonical.IsAbstract || IsSurfaceBody(canonical) || IsRuntimeIntrinsic(canonical)
            || !IsModuleDefined(canonical) || IsException(canonical.ContainingType))
        {
            return null;
        }

        var parameters = SharedParameters(canonical);
        unsharedReason = parameters.Count == 0 ? "exact" : IlOf(canonical) is null ? "body" : "static";
        if (parameters.Count == 0 || IlOf(canonical) is not { } body || HasStaticState(canonical.ContainingType))
        {
            return null;
        }

        var generic = SubstitutionOf(canonical.ContainingType, canonical);
        var context = new MethodPlan(
            canonical, canonical.ToDisplayString(), [], WType.Void, canonical.IsStatic, canonical.ContainingType,
            canonical.MethodKind == MethodKind.Constructor ? MethodPlanKind.Constructor : MethodPlanKind.Ordinary, generic, Il: body);
        IlAnalysis flow;
        try
        {
            flow = new IlAnalysis(this, context, symbol => DependsOn(symbol, parameters));
        }
        catch (CompileError error)
        {
            unsharedReason = "analysis " + error.Message;
            return null;
        }

        unsharedReason = flow.FoldedByShared ? "folding" : "filters";
        if (flow.FoldedByShared || flow.Groups.Any(group => group.Filters.Any(filter => filter is not null)))
        {
            return null;
        }

        foreach (var group in flow.Groups)
        {
            foreach (var clause in group.Clauses.Where(clause => clause.Kind == ExceptionRegionKind.Catch))
            {
                var open = body.Module.ResolveType(MetadataTokens.EntityHandle(clause.CatchToken), flow.Context);
                if (DependsOn(open, parameters))
                {
                    unsharedReason = "catch";
                    return null;
                }
            }
        }

        var code = new SharedCode(canonical, flow, generic, parameters);
        for (int index = 0; index < flow.Instructions.Length; index++)
        {
            if (flow.After[index] is null)
            {
                // Unreachable.
                continue;
            }

            switch (Classify(code, index))
            {
                case null:
                    break;
                case { } site when site.Kind == SiteKind.Thunk && !CanThunk(flow, index, site):
                    unsharedReason = $"site {flow.Instructions[index].OpCode} {flow.Operands[index]}";
                    return null;
                case { } site:
                    code.Sites.Add(site);
                    code.SiteAt[index] = site;
                    break;
            }
        }

        if (code.HasThunks)
        {
            if (canonical.IsGenericMethod)
            {
                code.Owner = OwnerOf(canonical);
            }
            else if (!canonical.IsStatic && UsesRepresentation(canonical.ContainingType))
            {
                code.Owner = OwnerOf(canonical.ContainingType);
                code.FromThis = true;
            }
            else
            {
                code.Owner = OwnerOf(canonical.ContainingType, statics: canonical.ContainingType.TypeKind == TypeKind.Class);
            }
        }

        return code;
    }

    private DictionaryOwner OwnerOf(ISymbol symbol, bool statics = false)
    {
        if (!dictionaryOwners.TryGetValue((symbol, statics), out var owner))
        {
            bool instances = symbol is INamedTypeSymbol { TypeKind: TypeKind.Class } && !statics;
            owner = new DictionaryOwner(symbol, statics, instances ? -1 : AddType(null));
            dictionaryOwners.Add((symbol, statics), owner);
        }

        return owner;
    }

    // What an instruction of shared code is: nothing of its instantiations'
    // (null), or a site.
    private SharedSite? Classify(SharedCode code, int index)
    {
        var flow = code.Flow;
        var instruction = flow.Instructions[index];
        var opcode = instruction.OpCode;
        bool dependent = DependsOn(flow.OpenOperands[index], code.Parameters)
                         || (flow.Operands[index] is IlExactTypeTest exact && DependsOn(exact.Open, code.Parameters));
        if (opcode is ILOpCode.Call or ILOpCode.Callvirt && flow.Constrained[index] is not null
            && DependsOn(ConstrainedOpen(flow, index), code.Parameters))
        {
            dependent = true;
        }

        if (!dependent && opcode is ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj && index > 0
            && flow.Instructions[index - 1].OpCode is ILOpCode.Ldtoken or ILOpCode.Ldftn or ILOpCode.Ldvirtftn
            && flow.Before[index] is { Length: > 0 } consumed && consumed[^1].Kind is IlKind.Token or IlKind.Method
            && DependsOn(flow.OpenOperands[index - 1], code.Parameters))
        {
            // What a token or method pointer of the exact arguments makes.
            dependent = true;
        }

        if (!dependent)
        {
            return null;
        }

        int pushes = flow.After[index]!.Value.Length - flow.Before[index].Length;
        switch (opcode)
        {
            case ILOpCode.Ldfld or ILOpCode.Stfld or ILOpCode.Ldflda or ILOpCode.Ldobj or ILOpCode.Stobj or ILOpCode.Cpobj
                or ILOpCode.Initobj or ILOpCode.Ldelem or ILOpCode.Stelem or ILOpCode.Ldtoken or ILOpCode.Ldftn
                or ILOpCode.Ldvirtftn or ILOpCode.Constrained:
                // Of the canonical representation, or what the next
                // instruction takes.
                return null;
            case ILOpCode.Castclass or ILOpCode.Isinst or ILOpCode.Unbox_any or ILOpCode.Unbox or ILOpCode.Box
                or ILOpCode.Newarr:
                return new(index, SiteKind.Thunk, 1, true);
            case ILOpCode.Ldelema:
                return new(index, SiteKind.Thunk, 2, true);
            case ILOpCode.Ldsfld or ILOpCode.Ldsflda or ILOpCode.Sizeof:
                return new(index, SiteKind.Thunk, 0, true);
            case ILOpCode.Stsfld:
                return new(index, SiteKind.Thunk, 1, false);
            case ILOpCode.Call or ILOpCode.Callvirt or ILOpCode.Newobj:
                int pops = flow.Operands[index] switch
                {
                    IlExactTypeTest => 1,
                    IlArrayMethod accessor => accessor.Parameters + (accessor.Name == ".ctor" ? 0 : 1),
                    IMethodSymbol method => method.Parameters.Length + (method.IsStatic || opcode == ILOpCode.Newobj ? 0 : 1),
                    _ => -1,
                };
                if (pops < 0)
                {
                    return new(index, SiteKind.Thunk, -1, false);
                }

                bool pushed = pops + pushes == 1;
                if (opcode != ILOpCode.Newobj && flow.Constrained[index] is null && flow.Operands[index] is IMethodSymbol callee)
                {
                    if (callee.MethodKind == MethodKind.DelegateInvoke
                        || (AutoGetterField(callee) is not null && UsesRepresentation(callee.ContainingType)))
                    {
                        // A canonical delegate's call, or a read of a
                        // shared class's field.
                        return null;
                    }

                    if (!callee.IsStatic && !callee.IsGenericMethod && UsesRepresentation(callee.ContainingType)
                        && opcode == ILOpCode.Callvirt && IsDispatched(callee) && !callee.IsSealed)
                    {
                        // A slot every instantiation's vtable fills.
                        return new(index, SiteKind.Direct, pops, pushed);
                    }

                    if (IsPlainCall(callee) && (callee.IsStatic || UsesRepresentation(callee.ContainingType))
                        && !(callee.ContainingType.TypeKind == TypeKind.Interface && !callee.IsStatic))
                    {
                        // Shared code that needs no dictionary of the
                        // caller's, or the exact instantiation's function.
                        return SharedCodeOf(CanonicalMember(callee)) is { FromThis: true } or { Owner: null }
                            ? new(index, SiteKind.Direct, pops, pushed)
                            : new(index, SiteKind.Function, pops, pushed);
                    }
                }

                return new(index, SiteKind.Thunk, pops, pushed);
            default:
                return new(index, SiteKind.Thunk, -1, false);
        }
    }

    // A call the importer lowers as a call of the method's function (see
    // FunctionEmitter.EmitModuleCall), which a dictionary can hold: a
    // method of the module's own that is no intrinsic, shim or member the
    // lowering stands in for.
    private bool IsPlainCall(IMethodSymbol method) =>
        IsModuleDefined(method) && !method.IsAbstract && !IsRuntimeIntrinsic(method) && IntrinsicOf(method) is null
        && ShimOf(method) is null && !IsObjectMember(method) && !IsGetType(method) && !IsSurfaceBody(method)
        && method.ContainingType.SpecialType is SpecialType.None
        && !IsInterpolationHandler(method.ContainingType) && !IsPrivateImplementation(method.ContainingType)
        && method.ContainingType.MetadataName is not ("Span`1" or "ReadOnlySpan`1") && !IsMdArrayClass(method.ContainingType)
        && method.MethodKind != MethodKind.Constructor && AutoGetterField(method) is null && IlOf(method) is not null;

    // The open type a call's `constrained.` prefix names.
    private static ISymbol? ConstrainedOpen(IlAnalysis flow, int index)
    {
        for (int prefix = index - 1; prefix >= 0; prefix--)
        {
            var opcode = flow.Instructions[prefix].OpCode;
            if (opcode == ILOpCode.Constrained)
            {
                return flow.OpenOperands[prefix];
            }

            if (opcode is not (ILOpCode.Readonly or ILOpCode.Volatile or ILOpCode.Tail or ILOpCode.Unaligned))
            {
                break;
            }
        }

        return null;
    }

    // Whether a Thunk site can be one: its stack effect is known, and what
    // it takes has a value or is made again (a null, the token or method
    // pointer just before).
    private static bool CanThunk(IlAnalysis flow, int index, SharedSite site)
    {
        if (site.Pops < 0 || flow.Before[index].Length < site.Pops)
        {
            return false;
        }

        var before = flow.Before[index];
        for (int depth = before.Length - site.Pops; depth < before.Length; depth++)
        {
            switch (before[depth].Kind)
            {
                case IlKind.Token or IlKind.Method:
                    if (depth != before.Length - 1 || index == 0
                        || flow.Instructions[index - 1].OpCode is not (ILOpCode.Ldtoken or ILOpCode.Ldftn or ILOpCode.Ldvirtftn))
                    {
                        return false;
                    }

                    break;
            }
        }

        if (site.Pushes && flow.After[index]!.Value[^1].Kind is IlKind.Token or IlKind.Method)
        {
            return false;
        }

        return true;
    }

    // What a Thunk site's function takes and gives: the canonical types of
    // the values the instruction takes and leaves (nulls, tokens and method
    // pointers are made again).
    private (WType[] Parameters, WType Result) SiteShape(SharedCode code, SharedSite site)
    {
        var flow = code.Flow;
        var before = flow.Before[site.Index];
        var parameters = new List<WType>();
        for (int depth = before.Length - site.Pops; depth < before.Length; depth++)
        {
            if (SlotWType(before[depth]) is { } type)
            {
                parameters.Add(type);
            }
        }

        var result = site.Pushes ? SlotWType(flow.After[site.Index]!.Value[^1]) ?? WType.Ref(EqHeap) : WType.Void;
        return ([.. parameters], result);
    }

    // The Wasm type of a stack entry that is a value, or null.
    public WType? SlotWType(IlSlot slot) => slot.Kind switch
    {
        IlKind.I32 => WType.I32,
        IlKind.I64 => WType.I64,
        IlKind.F32 => WType.F32,
        IlKind.F64 => WType.F64,
        IlKind.Ref or IlKind.Value => MapType(slot.Type),
        IlKind.ByRef => RefParameterType(slot.Type!),
        _ => null,
    };

    // A method's function when it is shared code: the shared function, or,
    // where the code takes a dictionary, an entry passing the exact
    // instantiation's. RegisterMethod's shared path.
    private bool TryRegisterShared(IMethodSymbol symbol, MethodPlanKind kind)
    {
        if (!sharing || kind is not (MethodPlanKind.Ordinary or MethodPlanKind.Constructor)
            || symbol.MethodKind == MethodKind.StaticConstructor || IsRuntimeAsync(symbol))
        {
            // A runtime-async method's frame is its instantiation's.
            return false;
        }

        var canonical = CanonicalMember(symbol);
        if (SharedCodeOf(canonical) is not { } code)
        {
            return false;
        }

        EnsureSharedPlan(code);
        code.Users.Add(code.Method.IsGenericMethod ? symbol : symbol.ContainingType);
        bool box = IsStruct(symbol.ContainingType) && !symbol.IsStatic;
        var ids = box ? boxMethodIds : methodIds;
        if (code.HiddenDictionary)
        {
            if (!ids.ContainsKey(symbol))
            {
                var instance = DictionaryInstanceOf(code.Owner!, ExactOwnerOf(symbol, code));
                var shared = methods[code.Plan];
                ids.Add(symbol, methods.Count);
                methods.Add(new(
                    symbol,
                    "",
                    shared.Parameters[..^1],
                    shared.Result,
                    shared.IsStatic,
                    symbol.ContainingType,
                    MethodPlanKind.SharedEntry,
                    SubstitutionOf(symbol.ContainingType, symbol),
                    Bound: instance.Id,
                    IlGroup: code.Plan));
            }
        }
        else
        {
            ids.TryAdd(symbol, code.Plan);
        }

        pendingSharedUses.Add((symbol, code));
        return true;
    }

    // What a Function site's entry takes and gives: its method's canonical
    // form's function's parameters (a receiver first) and result.
    public (WType[] Parameters, WType Result) FunctionShape(IMethodSymbol method)
    {
        var canonical = CanonicalMember(method);
        var parameters = PlanParameters(canonical);
        return (canonical.IsStatic ? [.. parameters] : [ReceiverType(canonical), .. parameters], PlanResult(canonical));
    }

    // The exact instantiation whose dictionary an exact method's shared
    // code reads: the method's, for a generic method's code, else its type's.
    private static ISymbol ExactOwnerOf(IMethodSymbol exact, SharedCode code) =>
        code.Method.IsGenericMethod ? exact : exact.ContainingType;

    private DictionaryInstance DictionaryInstanceOf(DictionaryOwner owner, ISymbol exact)
    {
        if (!dictionaryInstances.TryGetValue((exact, owner.Statics), out var instance))
        {
            instance = new DictionaryInstance(dictionaryOrder.Count, owner, exact);
            dictionaryInstances.Add((exact, owner.Statics), instance);
            dictionaryOrder.Add(instance);
        }

        return instance;
    }

    // The shared function of a method's code, registered on first use.
    private void EnsureSharedPlan(SharedCode code)
    {
        if (code.Plan >= 0)
        {
            return;
        }

        var canonical = code.Method;
        var parameters = PlanParameters(canonical);
        WType? receiver = canonical.IsStatic
            ? null
            : IsStruct(canonical.ContainingType)
                ? WType.Ref(StructOf(canonical.ContainingType).Box)
                : ReceiverType(canonical);
        if (code.HiddenDictionary)
        {
            parameters.Add(WType.Ref(code.Owner!.Type));
        }

        code.Plan = methods.Count;
        methods.Add(new(
            canonical,
            canonical.ToDisplayString() + " [shared]",
            receiver is { } type ? [type, .. parameters] : [.. parameters],
            PlanResult(canonical),
            receiver is null,
            canonical.ContainingType,
            canonical.MethodKind == MethodKind.Constructor ? MethodPlanKind.Constructor : MethodPlanKind.Ordinary,
            code.Generic,
            Il: IlOf(canonical),
            Shared: code));

        foreach (var site in code.Sites.Where(site => site.Kind is SiteKind.Thunk or SiteKind.Function))
        {
            code.EntryOf[site.Index] = code.Owner!.Entries.Count;
            code.Owner.Entries.Add((code, site));
            var (siteParameters, siteResult) = site.Kind == SiteKind.Function
                ? FunctionShape((IMethodSymbol)code.Flow.Operands[site.Index]!)
                : SiteShape(code, site);
            code.SignatureOf[site.Index] = SignatureType(siteParameters, siteResult);
        }
    }

    // An exact method's analysis, once: it folds what the code folds
    // (Frontend.ClosedWorld), so the two agree on every instruction.
    public IlAnalysis ExactFlow(MethodPlan plan, SharedCode? code = null)
    {
        var key = new Instance(plan.Symbol!, plan.Generic);
        if (!exactFlows.TryGetValue(key, out var flow))
        {
            if (code is null)
            {
                throw new InternalCompilerError($"'{plan.Name}' has no analysis of its exact instantiation.");
            }

            flow = new IlAnalysis(this, plan, symbol => DependsOn(symbol, code.Parameters));
            exactFlows.Add(key, flow);
        }

        return flow;
    }

    // What each exact use of shared code needs: the functions its Thunk
    // sites run for it in its dictionary, and the methods its Direct sites
    // call, as the exact instantiation's code would call them.
    private void DrainSharedUses()
    {
        while (pendingSharedUses.Count != 0)
        {
            var pending = pendingSharedUses.ToList();
            pendingSharedUses.Clear();
            foreach (var (exact, code) in pending)
            {
                var generic = SubstitutionOf(exact.ContainingType, exact);
                var context = new MethodPlan(
                    exact, exact.ToDisplayString(), [], WType.Void, exact.IsStatic, exact.ContainingType,
                    MethodPlanKind.Ordinary, generic, Il: IlOf(code.Method));
                // In exact types: what its sites reach, and what it converts.
                var flow = ExactFlow(context, code);
                NoteEscapes(flow);
                var instance = code.HasThunks ? DictionaryInstanceOf(code.Owner!, ExactOwnerOf(exact, code)) : null;
                foreach (var site in code.Sites)
                {
                    switch (site.Kind)
                    {
                        case SiteKind.Thunk when !instance!.Thunks.ContainsKey((code, site.Index)):
                            instance.Thunks.Add((code, site.Index), ExactStepOf(exact, generic, code, site, flow!));
                            break;
                        case SiteKind.Function when !instance!.Thunks.ContainsKey((code, site.Index)):
                            // The exact method's function, once discovery
                            // has registered it (FinishDictionaries).
                            var function = (IMethodSymbol)flow!.Operands[site.Index]!;
                            EnsureMethod(function, generic);
                            instance.Thunks.Add((code, site.Index), -1);
                            instance.Functions[(code, site.Index)] = function;
                            break;
                        case SiteKind.Direct when flow!.Operands[site.Index] is IMethodSymbol callee && IsModuleDefined(callee):
                            EnsureMethod(callee, generic);
                            break;
                    }
                }
            }
        }
    }

    // The ExactStep function of a Thunk site in an exact instantiation: one
    // per what the instruction does there (its operands, exactly, and the
    // stack it takes and leaves), which every site doing that shares.
    private int ExactStepOf(IMethodSymbol exact, Substitution generic, SharedCode code, SharedSite site, IlAnalysis flow)
    {
        int index = site.Index;
        var before = flow.Before[index];
        var key = new System.Text.StringBuilder();
        key.Append(flow.Instructions[index].OpCode).Append('|').Append(SymbolKey(flow.Operands[index]))
            .Append('|').Append(SymbolKey(flow.Constrained[index]))
            .Append('|').Append(index > 0 && flow.Instructions[index - 1].OpCode is ILOpCode.Ldtoken or ILOpCode.Ldftn or ILOpCode.Ldvirtftn
                ? flow.Instructions[index - 1].OpCode + SymbolKey(flow.Operands[index - 1])
                : "")
            .Append('|').Append(InCoreLibrary(exact) || InFramework(exact));
        for (int depth = before.Length - site.Pops; depth < before.Length; depth++)
        {
            key.Append('|').Append(before[depth].Kind).Append(SymbolKey(before[depth].Type));
        }

        if (site.Pushes)
        {
            key.Append("|=").Append(flow.After[index]!.Value[^1].Kind).Append(SymbolKey(flow.After[index]!.Value[^1].Type));
        }

        string text = key.ToString();
        if (exactSteps.TryGetValue(text, out int known))
        {
            return known;
        }

        var (parameters, result) = SiteShape(code, site);
        int function = imports.Count + methods.Count;
        exactSteps.Add(text, function);
        methods.Add(new(
            exact,
            "",
            parameters,
            result,
            true,
            exact.ContainingType,
            MethodPlanKind.ExactStep,
            generic,
            Bound: site.Pops,
            Il: IlOf(code.Method),
            IlGroup: index));
        return function;
    }

    private readonly Dictionary<string, int> exactSteps = new(StringComparer.Ordinal);

    // A symbol as a key: its display text, with its definition's metadata
    // token and assembly where display texts could be alike.
    private static string SymbolKey(object? operand) => operand switch
    {
        null => "",
        ISymbol symbol => KeyOf(symbol),
        IlExactTypeTest test => "exact " + SymbolKey(test.Type) + test.Negated,
        IlArrayMethod accessor => "md " + SymbolKey(accessor.Type) + accessor.Name,
        var other => other.ToString() ?? "",
    };

    private static string KeyOf(ISymbol symbol)
    {
        symbolKeys ??= new(SymbolEqualityComparer.IncludeNullability);
        if (!symbolKeys.TryGetValue(symbol, out var key))
        {
            key = symbol.ToDisplayString() + "#" + symbol.OriginalDefinition.MetadataToken
                  + "@" + symbol.OriginalDefinition.ContainingAssembly?.Name
                  + (symbol.ContainingType is { } containing ? "/" + containing.ToDisplayString() : "");
            symbolKeys.Add(symbol, key);
        }

        return key;
    }

    // Of the compilation alone, so for every compilation of the module.
    [ThreadStatic]
    private static Dictionary<ISymbol, string>? symbolKeys;

    // Discovery of an ExactStep: its one instruction, in its exact
    // instantiation, with the token or method pointer it takes.
    private void WalkExactStep(MethodPlan plan)
    {
        var flow = ExactFlow(plan);
        int index = plan.IlGroup;
        foreach (var slot in flow.Before[index].Concat(flow.After[index] ?? []))
        {
            switch (slot.Kind)
            {
                case IlKind.Ref or IlKind.Value:
                    MapType(slot.Type);
                    break;
                case IlKind.ByRef:
                    RefParameterType(slot.Type!);
                    break;
            }
        }

        if (index > 0 && flow.Instructions[index - 1].OpCode is ILOpCode.Ldtoken)
        {
            WalkIlInstruction(flow, index - 1, plan.Generic);
        }

        WalkIlInstruction(flow, index, plan.Generic);
    }

    // At the end of discovery: each class owner's base (its dictionary's
    // prefix), each class instantiation's base dictionary, and the
    // dictionary types.
    private void FinishDictionaries()
    {
        if (dictionaryOwners.Count == 0)
        {
            return;
        }

        foreach (var instance in dictionaryOrder)
        {
            foreach (var (key, method) in instance.Functions)
            {
                instance.Thunks[key] = MethodIndex(method);
            }
        }

        foreach (var owner in dictionaryOwners.Values)
        {
            if (owner.Symbol is INamedTypeSymbol { TypeKind: TypeKind.Class } type && !owner.Statics)
            {
                owner.Base = BaseOwner(type);
            }
        }

        // The exact classes whose vtables hold dictionaries, and their bases'.
        foreach (var layout in layouts.Values.Where(layout => !layout.IsBox).ToList())
        {
            _ = DictionaryFor(layout);
        }

        foreach (var instance in dictionaryOrder.ToList())
        {
            if (instance.Owner.Base is not null && instance.Exact is INamedTypeSymbol exact && SourceBase(exact) is { } baseType
                && layouts.TryGetValue(baseType, out var baseLayout))
            {
                instance.Base = DictionaryFor(baseLayout);
            }
        }

        // Base owners first, as the group declares supertypes first.
        var defined = new HashSet<DictionaryOwner>();
        void Define(DictionaryOwner owner)
        {
            if (!defined.Add(owner))
            {
                return;
            }

            if (owner.Base is { } baseOwner)
            {
                Define(baseOwner);
            }

            var fields = new List<WField>();
            for (var current = owner; current is not null; current = current.Base)
            {
                fields.InsertRange(0, current.Entries.Select(entry =>
                    new WField(WType.Ref(entry.Code.SignatureOf[entry.Site.Index]), Mutable: false)));
            }

            var definition = TypeDefinition.Struct(
                "dictionary " + owner.Symbol.ToDisplayString(), [.. fields], owner.Base?.Type ?? -1, final: false);
            if (owner.Type < 0)
            {
                owner.Type = AddType(definition);
            }
            else
            {
                types[owner.Type] = definition;
            }
        }

        foreach (var owner in dictionaryOwners.Values)
        {
            Define(owner);
        }
    }

    // The dictionary owner of a class's nearest shared ancestor (itself
    // excluded) that has one.
    private DictionaryOwner? BaseOwner(INamedTypeSymbol type)
    {
        for (var current = SourceBase(type); current is not null; current = SourceBase(current))
        {
            if (dictionaryOwners.TryGetValue((Canonical(current), false), out var owner))
            {
                return owner;
            }
        }

        return null;
    }

    // The dictionary an exact class's vtable holds: its own instantiation's,
    // or its nearest base class's that has one; null for none.
    public DictionaryInstance? DictionaryFor(ClassLayout layout)
    {
        for (var current = layout; current is not null; current = current.Base)
        {
            if (current.Representation is not null
                && dictionaryOwners.TryGetValue((Canonical(current.Symbol), false), out var owner))
            {
                if (frozen && !dictionaryInstances.ContainsKey((current.Symbol, false)))
                {
                    throw new InternalCompilerError($"'{current.Symbol.ToDisplayString()}' has no dictionary.");
                }

                return DictionaryInstanceOf(owner, current.Symbol);
            }
        }

        return null;
    }

    public int DictionaryField => ClassIdField + 1;

    // A vtable's dictionary, in its constant expression: the global of the
    // class's, or null.
    private void WriteDictionary(ClassLayout layout, WasmWriter code, List<Relocation> relocations)
    {
        if (!classDictionaries)
        {
            return;
        }

        if (layout.IsBox || DictionaryFor(layout) is not { } dictionary)
        {
            code.Byte(0xd0); // ref.null
            code.Signed(WType.StructHeap);
            return;
        }

        code.Byte(0x23); // global.get
        relocations.Add(new(code.Length, RelocationKind.Dictionary, dictionary.Id));
    }

    // The layout a call dispatches through on a receiver of a type: its
    // class's, or for shared code's canonical receiver, its
    // representation's (whose slots every instantiation's vtable fills).
    public bool TryDispatchLayout(ITypeSymbol? type, out ClassLayout layout)
    {
        if (TryLayout(type, out layout))
        {
            return true;
        }

        return UsesRepresentation(type) && representationLayouts.TryGetValue(Canonical((INamedTypeSymbol)type!), out layout!);
    }

    // Whether a class is or derives from an instantiation of a canonical
    // form: what a dispatch on shared code's receiver reaches.
    private bool DerivesFromCanonical(INamedTypeSymbol type, INamedTypeSymbol canonical)
    {
        for (INamedTypeSymbol? current = type; current is not null; current = current.BaseType)
        {
            if (UsesRepresentation(current) && SymbolEqualityComparer.Default.Equals(Canonical(current), canonical))
            {
                return true;
            }
        }

        return false;
    }

    // A dictionary's fields in order, its base class's first: each Thunk
    // site's shared code and instruction, and the ExactStep plan filling
    // it (-1 where the instantiation does not use that code).
    public IEnumerable<(SharedCode Code, int Site, int Thunk)> DictionaryEntries(DictionaryInstance dictionary) =>
        DictionaryEntries(dictionary.Owner, dictionary);

    private static IEnumerable<(SharedCode Code, int Site, int Thunk)> DictionaryEntries(DictionaryOwner owner, DictionaryInstance? instance)
    {
        if (owner.Base is { } baseOwner)
        {
            foreach (var entry in DictionaryEntries(baseOwner, instance?.Base))
            {
                yield return entry;
            }
        }

        foreach (var (code, site) in owner.Entries)
        {
            yield return (code, site.Index,
                instance is not null && instance.Thunks.TryGetValue((code, site.Index), out int thunk) ? thunk : -1);
        }
    }
}
