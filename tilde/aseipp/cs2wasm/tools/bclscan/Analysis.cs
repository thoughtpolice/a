// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;

namespace BclScan;

public enum Scen { Raw = 0, Fold = 1, FoldC = 2 }

public enum ExternKind { None, FCall, QCall, PInvoke, Runtime, Abstract }

public sealed class CallSite
{
    public int Idx; public Op Op; public MethodKey? Target; public ImmutableArray<Sig> Inst; public bool Constrained;
}

public sealed class MScan
{
    public MethodKey M;
    public bool HasBody; public int ILSize;
    public ExternKind Extern; public string Module = "";
    public List<Instr> Ins = new();
    public bool[] LiveFold = [];
    public List<CallSite> Calls = new();
    public List<(int idx, ILOpCode op, TypeKey? decl, string name, Sig type, FieldKey? f)> Fields = new();
    public List<(int idx, ILOpCode op, Sig t)> Types = new();
    public List<(int idx, Sig t)> ParentSpecs = new();
    public bool SigPtr, SigFn, LocPtr, LocFn, Pinned, TypedRef;
}

public sealed class Cls
{
    public HashSet<string> Block = new();
    public HashSet<string> Info = new();
    public List<(Op op, MethodKey m, bool slot)> Edges = new();
    public HashSet<TypeKey> Inst = new();
    public HashSet<TypeKey> Touched = new();
}

public sealed class Analyzer
{
    public readonly Universe U;
    public Analyzer(Universe u)
    {
        U = u;
        unsafeType = u.FindAnywhere("System.Runtime.CompilerServices.Unsafe");
        szArrayHelper = u.FindAnywhere("System.SZArrayHelper");
        arrayType = u.FindAnywhere("System.Array");
        objectType = u.FindAnywhere("System.Object");
        foreach (var n in new[] { "System.Collections.Generic.IList`1", "System.Collections.Generic.ICollection`1", "System.Collections.Generic.IEnumerable`1", "System.Collections.Generic.IReadOnlyList`1", "System.Collections.Generic.IReadOnlyCollection`1" })
            if (u.FindAnywhere(n) is { } k) arrayIfaces.Add(k);
        foreach (var n in ReflectionCreated)
            if (u.FindAnywhere(n) is { } k) reflectionCreated.Add(k);
    }
    readonly TypeKey? unsafeType, szArrayHelper, arrayType, objectType;
    readonly HashSet<TypeKey> arrayIfaces = new();
    readonly HashSet<TypeKey> reflectionCreated = new();

    // Types the runtime instantiates through reflection (Comparer<T>.Default and
    // friends); the IL call graph cannot see these.
    static readonly string[] ReflectionCreated =
    [
        "System.Collections.Generic.GenericComparer`1", "System.Collections.Generic.NullableComparer`1",
        "System.Collections.Generic.ObjectComparer`1", "System.Collections.Generic.EnumComparer`1",
        "System.Collections.Generic.GenericEqualityComparer`1", "System.Collections.Generic.NullableEqualityComparer`1",
        "System.Collections.Generic.ObjectEqualityComparer`1", "System.Collections.Generic.EnumEqualityComparer`1",
        "System.Collections.Generic.ByteEqualityComparer",
    ];

    // ---------------------------------------------------------------- scanning

    readonly Dictionary<MethodKey, MScan> scans = new();
    public MScan Scan(MethodKey m)
    {
        if (scans.TryGetValue(m, out var s)) return s;
        s = new MScan { M = m };
        scans[m] = s;
        var a = U.Asms[m.Asm]; var r = a.R;
        var md = r.GetMethodDefinition(m.H);
        var sig = md.DecodeSignature(U.P, null);
        s.SigPtr = sig.ReturnType.HasPointer || sig.ParameterTypes.Any(p => p.HasPointer);
        s.SigFn = sig.ReturnType.HasFnPtr || sig.ParameterTypes.Any(p => p.HasFnPtr);
        s.TypedRef = sig.ParameterTypes.Any(p => p.HasTypedRef) || sig.Header.CallingConvention == SignatureCallingConvention.VarArgs;
        if ((md.Attributes & MethodAttributes.PinvokeImpl) != 0)
        {
            var imp = md.GetImport();
            s.Module = imp.Module.IsNil ? "?" : r.GetString(r.GetModuleReference(imp.Module).Name);
            s.Extern = s.Module == "QCall" ? ExternKind.QCall : ExternKind.PInvoke;
            return s;
        }
        if ((md.ImplAttributes & MethodImplAttributes.InternalCall) != 0) { s.Extern = ExternKind.FCall; return s; }
        if ((md.ImplAttributes & MethodImplAttributes.CodeTypeMask) == MethodImplAttributes.Runtime) { s.Extern = ExternKind.Runtime; return s; }
        if (md.RelativeVirtualAddress == 0) { s.Extern = (md.Attributes & MethodAttributes.Abstract) != 0 ? ExternKind.Abstract : ExternKind.FCall; return s; }

        var body = a.Pe.GetMethodBody(md.RelativeVirtualAddress);
        s.HasBody = true;
        s.ILSize = body.GetILBytes().Length;
        if (!body.LocalSignature.IsNil)
        {
            var locals = r.GetStandaloneSignature(body.LocalSignature).DecodeLocalSignature(U.P, null);
            foreach (var l in locals)
            {
                if (l is SPinned) s.Pinned = true;
                if (l.HasPointer && !(l is SPinned)) s.LocPtr = true;
                if (l.HasFnPtr) s.LocFn = true;
                if (l.HasTypedRef) s.TypedRef = true;
            }
        }
        s.Ins = IL.Decode(body.GetILReader());
        bool constrained = false;
        for (int i = 0; i < s.Ins.Count; i++)
        {
            var ins = s.Ins[i];
            switch (ins.Code)
            {
                case ILOpCode.Call: case ILOpCode.Callvirt: case ILOpCode.Newobj: case ILOpCode.Ldftn: case ILOpCode.Ldvirtftn: case ILOpCode.Jmp:
                    {
                        var h = MetadataTokens.EntityHandle(ins.Token);
                        var (t, inst) = U.ResolveMethod(m.Asm, h);
                        var op = ins.Code switch { ILOpCode.Call => Op.Call, ILOpCode.Callvirt => Op.CallVirt, ILOpCode.Newobj => Op.NewObj, ILOpCode.Ldftn => Op.LdFtn, ILOpCode.Ldvirtftn => Op.LdVirtFtn, _ => Op.Jmp };
                        s.Calls.Add(new CallSite { Idx = i, Op = op, Target = t, Inst = inst, Constrained = constrained });
                        // Generic arguments carried by the member reference's parent.
                        EntityHandle mh = h;
                        if (h.Kind == HandleKind.MethodSpecification) mh = r.GetMethodSpecification((MethodSpecificationHandle)h).Method;
                        if (mh.Kind == HandleKind.MemberReference)
                        {
                            var par = r.GetMemberReference((MemberReferenceHandle)mh).Parent;
                            if (par.Kind == HandleKind.TypeSpecification) s.ParentSpecs.Add((i, U.DecodeType(m.Asm, par)));
                        }
                        break;
                    }
                case ILOpCode.Ldfld: case ILOpCode.Ldflda: case ILOpCode.Stfld: case ILOpCode.Ldsfld: case ILOpCode.Ldsflda: case ILOpCode.Stsfld:
                    {
                        var h = MetadataTokens.EntityHandle(ins.Token);
                        var (decl, name, type, f) = U.ResolveField(m.Asm, h);
                        s.Fields.Add((i, ins.Code, decl, name, type, f));
                        if (h.Kind == HandleKind.MemberReference)
                        {
                            var par = r.GetMemberReference((MemberReferenceHandle)h).Parent;
                            if (par.Kind == HandleKind.TypeSpecification) s.ParentSpecs.Add((i, U.DecodeType(m.Asm, par)));
                        }
                        break;
                    }
                case ILOpCode.Cpobj: case ILOpCode.Ldobj: case ILOpCode.Castclass: case ILOpCode.Isinst: case ILOpCode.Unbox:
                case ILOpCode.Stobj: case ILOpCode.Box: case ILOpCode.Newarr: case ILOpCode.Ldelema: case ILOpCode.Ldelem:
                case ILOpCode.Stelem: case ILOpCode.Unbox_any: case ILOpCode.Refanyval: case ILOpCode.Mkrefany:
                case ILOpCode.Initobj: case ILOpCode.Constrained: case ILOpCode.Sizeof:
                    s.Types.Add((i, ins.Code, U.DecodeType(m.Asm, MetadataTokens.EntityHandle(ins.Token))));
                    break;
                case ILOpCode.Ldtoken:
                    {
                        var h = MetadataTokens.EntityHandle(ins.Token);
                        if (h.Kind is HandleKind.TypeDefinition or HandleKind.TypeReference or HandleKind.TypeSpecification)
                            s.Types.Add((i, ins.Code, U.DecodeType(m.Asm, h)));
                        break;
                    }
            }
            constrained = ins.Code == ILOpCode.Constrained;
        }
        s.LiveFold = Liveness(s, body);
        return s;
    }

    // ---------------------------------------------------------------- folding

    // Trimming feature switches a size-conscious single-threaded Wasm build would set.
    public static readonly Dictionary<string, bool> SwitchValues = new()
    {
        ["System.Diagnostics.Debugger.IsSupported"] = false,
        ["System.Diagnostics.Tracing.EventSource.IsSupported"] = false,
        ["System.Diagnostics.Tracing.EventSource.IsMeterSupported"] = false,
        ["System.Diagnostics.Metrics.Meter.IsSupported"] = false,
        ["System.Diagnostics.StackTrace.IsSupported"] = false,
        ["System.Resources.UseSystemResourceKeys"] = true,
        ["System.Resources.ResourceManager.AllowCustomResourceTypes"] = false,
        ["System.Globalization.Invariant"] = true,
        ["System.Globalization.PredefinedCulturesOnly"] = true,
        ["System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported"] = false,
        ["System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeCompiled"] = false,
        ["System.Runtime.InteropServices.BuiltInComInterop.IsSupported"] = false,
        ["System.Runtime.InteropServices.EnableConsumingManagedCodeFromNativeHosting"] = false,
        ["System.Runtime.InteropServices.EnableCppCLIHostActivation"] = false,
        ["System.Runtime.Serialization.EnableUnsafeBinaryFormatterSerialization"] = false,
        ["System.StartupHookProvider.IsSupported"] = false,
        ["System.Text.Encoding.EnableUnsafeUTF7Encoding"] = false,
        ["System.Reflection.Metadata.MetadataUpdater.IsSupported"] = false,
        ["System.Threading.Thread.IsThreadStartSupported"] = false,
        ["System.Threading.IsMultithreadingSupported"] = false,
        ["System.Threading.ThreadPool.UseWindowsThreadPool"] = false,
        ["System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault"] = false,
        ["System.Linq.Enumerable.IsSizeOptimized"] = true,
        ["System.Runtime.CompilerServices.RuntimeFeature.IsMultithreadingSupported"] = false,
    };
    public readonly Dictionary<MethodKey, string> SwitchGetters = new();
    public void FindFeatureSwitches()
    {
        foreach (var a in U.Asms)
        {
            var r = a.R;
            foreach (var th in r.TypeDefinitions)
            {
                var td = r.GetTypeDefinition(th);
                foreach (var ph in td.GetProperties())
                {
                    var pd = r.GetPropertyDefinition(ph);
                    foreach (var ch in pd.GetCustomAttributes())
                    {
                        var ca = r.GetCustomAttribute(ch);
                        if (ca.Constructor.Kind != HandleKind.MemberReference && ca.Constructor.Kind != HandleKind.MethodDefinition) continue;
                        var (ctor, _) = U.ResolveMethod(a.Index, ca.Constructor);
                        string an = ctor is { } ck ? U.TypeName(U.DeclType(ck)) : "";
                        if (ctor is null && ca.Constructor.Kind == HandleKind.MemberReference)
                        {
                            var mr = r.GetMemberReference((MemberReferenceHandle)ca.Constructor);
                            if (mr.Parent.Kind == HandleKind.TypeReference) an = r.GetString(r.GetTypeReference((TypeReferenceHandle)mr.Parent).Name);
                        }
                        if (!an.EndsWith("FeatureSwitchDefinitionAttribute")) continue;
                        var br = r.GetBlobReader(ca.Value);
                        br.ReadUInt16();
                        var sw = br.ReadSerializedString();
                        var getter = pd.GetAccessors().Getter;
                        if (!getter.IsNil) SwitchGetters[new MethodKey(a.Index, getter)] = sw;
                    }
                }
            }
        }
    }

    public bool? ConstValue(MethodKey m)
    {
        var name = U.MethodName(m);
        if (SwitchGetters.TryGetValue(m, out var sw) && SwitchValues.TryGetValue(sw, out var swv)) return swv;
        if (name == "UsingResourceKeys" && U.TypeName(U.DeclType(m)) == "System.SR") return true;
        // ILLink.Substitutions: EventSource.IsEnabled(...) stubs to false when EventSource is unsupported.
        if (name == "IsEnabled" && U.TypeName(U.DeclType(m)) == "System.Diagnostics.Tracing.EventSource") return false;
        if (!name.StartsWith("get_")) return null;
        var t = U.DeclType(m);
        var ns = U.Namespace(t);
        var tn = U.TypeName(t);
        if (name == "get_IsSupported" && ns.StartsWith("System.Runtime.Intrinsics.")) return false;
        if (name == "get_IsHardwareAccelerated" && (ns == "System.Runtime.Intrinsics" || tn == "System.Numerics.Vector")) return false;
        if (tn == "System.Runtime.CompilerServices.RuntimeFeature" && name is "get_IsDynamicCodeSupported" or "get_IsDynamicCodeCompiled") return false;
        if (tn == "System.Globalization.GlobalizationMode" && name == "get_Invariant") return true;
        if (tn == "System.Globalization.GlobalizationMode" && name is "get_UseNls" or "get_Hybrid") return false;
        if (tn == "System.Diagnostics.Tracing.EventSource" && name == "get_IsSupported") return false;
        if (tn == "System.Diagnostics.Tracing.EventSource" && name == "get_IsMeterSupported") return false;
        return null;
    }

    bool[] Liveness(MScan s, MethodBodyBlock body)
    {
        var ins = s.Ins;
        var live = new bool[ins.Count];
        var byOff = new Dictionary<int, int>();
        for (int i = 0; i < ins.Count; i++) byOff[ins[i].Offset] = i;
        var consts = new Dictionary<int, bool>();
        foreach (var c in s.Calls)
            if (c.Op is Op.Call or Op.CallVirt && c.Target is { } t && ConstValue(t) is { } v) consts[c.Idx] = v;
        var work = new Stack<int>();
        void Push(int off) { if (byOff.TryGetValue(off, out var i) && !live[i]) { live[i] = true; work.Push(i); } }
        Push(0);
        bool changed = true;
        while (changed)
        {
            while (work.Count > 0)
            {
                int i = work.Pop();
                var x = ins[i];
                if (IL.IsTerminal(x.Code)) continue;
                if (IL.IsUncond(x.Code)) { foreach (var tg in x.Targets) Push(tg); continue; }
                if (x.Code == ILOpCode.Switch) { foreach (var tg in x.Targets) Push(tg); Push(x.Next); continue; }
                if (x.Targets.Length > 0)
                {
                    if (i > 0 && consts.TryGetValue(i - 1, out var v) && x.Code is ILOpCode.Brtrue or ILOpCode.Brtrue_s or ILOpCode.Brfalse or ILOpCode.Brfalse_s)
                    {
                        bool taken = x.Code is ILOpCode.Brtrue or ILOpCode.Brtrue_s ? v : !v;
                        Push(taken ? x.Targets[0] : x.Next);
                        continue;
                    }
                    Push(x.Targets[0]); Push(x.Next); continue;
                }
                Push(x.Next);
            }
            changed = false;
            foreach (var er in body.ExceptionRegions)
            {
                if (byOff.TryGetValue(er.TryOffset, out var ti) && AnyLive(er.TryOffset, er.TryOffset + er.TryLength))
                {
                    if (byOff.TryGetValue(er.HandlerOffset, out var hi) && !live[hi]) { Push(er.HandlerOffset); changed = true; }
                    if (er.Kind == ExceptionRegionKind.Filter && byOff.TryGetValue(er.FilterOffset, out var fi) && !live[fi]) { Push(er.FilterOffset); changed = true; }
                }
            }
        }
        return live;

        bool AnyLive(int from, int to)
        {
            for (int i = 0; i < ins.Count; i++) if (ins[i].Offset >= from && ins[i].Offset < to && live[i]) return true;
            return false;
        }
    }

    // ---------------------------------------------------------------- classification

    public bool IsUnsafe(MethodKey m) => unsafeType is { } u && U.DeclType(m) == u;

    static readonly HashSet<string> CIntrinsics =
    [
        "System.Runtime.InteropServices.MemoryMarshal::GetArrayDataReference",
        "System.Runtime.InteropServices.MemoryMarshal::GetReference",
        "System.Runtime.InteropServices.MemoryMarshal::CreateSpan",
        "System.Runtime.InteropServices.MemoryMarshal::CreateReadOnlySpan",
        "System.Runtime.CompilerServices.RuntimeHelpers::IsReferenceOrContainsReferences",
        "System.Runtime.CompilerServices.RuntimeHelpers::IsBitwiseEquatable",
        "System.Runtime.CompilerServices.RuntimeHelpers::CreateSpan",
        "System.Runtime.CompilerServices.RuntimeHelpers::InitializeArray",
        "System.Runtime.CompilerServices.RuntimeHelpers::EnsureSufficientExecutionStack",
        "System.Runtime.CompilerServices.RuntimeHelpers::TryEnsureSufficientExecutionStack",
        "System.Runtime.CompilerServices.RuntimeHelpers::IsKnownConstant",
        "System.String::GetRawStringData",
        "System.String::GetPinnableReference",
        "System.Threading.Thread::MemoryBarrier",
        "System.Threading.Monitor::Enter",
        "System.Threading.Monitor::Exit",
        "System.Threading.Monitor::TryEnter",
        "System.Threading.Monitor::IsEntered",
        "System.GC::KeepAlive",
    ];
    static readonly HashSet<string> CTypes = ["System.Threading.Interlocked", "System.Threading.Volatile", "System.Threading.Lock", "System.Threading.Lock/Scope"];

    public bool IsCIntrinsic(MethodKey m)
    {
        var tn = U.TypeName(U.DeclType(m));
        return CTypes.Contains(tn) || CIntrinsics.Contains(tn + "::" + U.MethodName(m));
    }

    public static readonly HashSet<string> LayoutObjectTypes =
    [
        "System.Runtime.CompilerServices.MethodTable", "System.Runtime.CompilerServices.RawData", "System.Runtime.CompilerServices.RawArrayData",
        "System.Runtime.CompilerServices.TypeHandle", "System.Runtime.CompilerServices.MethodTableAuxiliaryData",
    ];
    static readonly HashSet<string> LayoutObjectMethods =
    [
        "GetMethodTable", "GetRawData", "ObjectHasComponentSize", "GetRawObjectDataSize", "GetMultiDimensionalArrayBounds",
        "GetMultiDimensionalArrayRank", "GetRawArrayData", "GetMethodTableAuxiliaryData",
    ];

    static string StorageClass(Universe u, Sig s)
    {
        switch (s)
        {
            case SPrim p:
                return p.Code switch
                {
                    PrimitiveTypeCode.Boolean or PrimitiveTypeCode.Byte or PrimitiveTypeCode.SByte => "i8",
                    PrimitiveTypeCode.Char or PrimitiveTypeCode.Int16 or PrimitiveTypeCode.UInt16 => "i16",
                    PrimitiveTypeCode.Int32 or PrimitiveTypeCode.UInt32 => "i32",
                    PrimitiveTypeCode.Int64 or PrimitiveTypeCode.UInt64 => "i64",
                    PrimitiveTypeCode.IntPtr or PrimitiveTypeCode.UIntPtr => "iptr",
                    PrimitiveTypeCode.Single => "f32",
                    PrimitiveTypeCode.Double => "f64",
                    PrimitiveTypeCode.Object or PrimitiveTypeCode.String => "ref",
                    _ => "?" + p.Code,
                };
            case SDef d when d.Key is { } k:
                {
                    var tn = u.TypeName(k);
                    if (u.BaseOf(k) is { } b && u.TypeName(b) == "System.Enum")
                    {
                        var r = u.Asms[k.Asm].R;
                        foreach (var fh in r.GetTypeDefinition(k.H).GetFields())
                        {
                            var f = r.GetFieldDefinition(fh);
                            if (r.GetString(f.Name) == "value__") return StorageClass(u, f.DecodeSignature(u.P, null));
                        }
                    }
                    return d.IsValueType ? "vt:" + tn : "ref";
                }
            case SVar v: return "var:" + v;
        }
        return s is SArr || s is SGen { Def: SDef { IsValueType: false } } ? "ref" : "?" + s;
    }
    static bool HasVar(Sig s) => s switch { SVar => true, SGen g => g.Args.Any(HasVar), SArr a => HasVar(a.E), SByRef r => HasVar(r.E), SPtr p => HasVar(p.E), _ => false };
    bool IsVec(Sig s) => Universe.DefOf(s) is { } k && U.TypeName(k) is "System.Runtime.Intrinsics.Vector64`1" or "System.Runtime.Intrinsics.Vector128`1" or "System.Runtime.Intrinsics.Vector256`1" or "System.Numerics.Vector`1";
    // Flattened numeric storage of a value type (null when it holds references or unknowns).
    List<string> Flatten(Sig s, int depth)
    {
        if (depth > 6) return null;
        var sc = StorageClass(U, s);
        if (Size(sc) > 0) return [sc];
        TypeKey? k = Universe.DefOf(s);
        if (k is null || !U.IsValueType(k.Value)) return null;
        var r = U.Asms[k.Value.Asm].R;
        var res = new List<string>();
        var args = s is SGen g ? g.Args : ImmutableArray<Sig>.Empty;
        foreach (var fh in r.GetTypeDefinition(k.Value.H).GetFields())
        {
            var f = r.GetFieldDefinition(fh);
            if ((f.Attributes & FieldAttributes.Static) != 0) continue;
            var ft = f.DecodeSignature(U.P, null);
            if (ft is SVar v && !v.Method && v.Index < args.Length) ft = args[v.Index];
            else if (ft is SGen fg && fg.Args.Any(a => a is SVar)) ft = new SGen(fg.Def, fg.Args.Select(a => a is SVar av && !av.Method && av.Index < args.Length ? args[av.Index] : a).ToImmutableArray());
            var sub = Flatten(ft, depth + 1);
            if (sub == null) return null;
            res.AddRange(sub);
        }
        return res;
    }
    static int Size(string sc) => sc switch { "i8" => 1, "i16" => 2, "i32" or "f32" => 4, "i64" or "f64" or "iptr" => 8, _ => -1 };

    // Returns (tag, supportedUnderC)
    public (string tag, bool ok) UnsafeKind(MethodKey m, ImmutableArray<Sig> inst)
    {
        var name = U.MethodName(m);
        var sig = U.Asms[m.Asm].R.GetMethodDefinition(m.H).DecodeSignature(U.P, null);
        bool ptr = sig.ParameterTypes.Any(p => p.HasPointer) || sig.ReturnType.HasPointer;
        switch (name)
        {
            case "As":
                if (sig.GenericParameterCount == 1) return ("unsafe-cast", true);
                if (inst.Length == 2)
                {
                    var a = StorageClass(U, inst[0]); var b = StorageClass(U, inst[1]);
                    if (a == b && !a.StartsWith("?")) return ("unsafe-cast", true);
                    if (a == "ref" && b == "ref") return ("unsafe-cast", true);
                }
                if (inst.Length == 2 && (HasVar(inst[0]) || HasVar(inst[1]))) return ("unsafe-reinterpret-generic", false);
                if (inst.Length == 2)
                {
                    var fa = Flatten(inst[0], 0); var fb = Flatten(inst[1], 0);
                    if (fa != null && fb != null)
                    {
                        if (fa.SequenceEqual(fb)) return ("unsafe-reinterpret-samelayout", false);
                        if (fa.Sum(Size) == fb.Sum(Size) && fa.Count > 1 | fb.Count > 1) return ("unsafe-reinterpret-samesize", false);
                    }
                    if (StorageClass(U, inst[0]) == "i8" || StorageClass(U, inst[1]) == "i8") return ("unsafe-reinterpret-bytes", false);
                }
                return ("unsafe-reinterpret", false);
            case "BitCast":
                if (inst.Length == 2)
                {
                    var a = StorageClass(U, inst[0]); var b = StorageClass(U, inst[1]);
                    if (Size(a) > 0 && Size(a) == Size(b)) return ("unsafe-cast", true);
                    if (HasVar(inst[0]) || HasVar(inst[1])) return ("unsafe-reinterpret-generic", false);
                    var fa = Flatten(inst[0], 0); var fb = Flatten(inst[1], 0);
                    if (fa != null && fb != null)
                    {
                        if (fa.SequenceEqual(fb)) return ("unsafe-reinterpret-samelayout", false);
                        if (fa.Sum(Size) == fb.Sum(Size) && fa.Count > 1 | fb.Count > 1) return ("unsafe-reinterpret-samesize", false);
                    }
                    if (StorageClass(U, inst[0]) == "i8" || StorageClass(U, inst[1]) == "i8") return ("unsafe-reinterpret-bytes", false);
                }
                return ("unsafe-reinterpret", false);
            case "AsRef": return ptr ? ("unsafe-pointer", false) : ("unsafe-cast", true);
            case "Add": case "Subtract": return ptr ? ("unsafe-pointer", false) : ("unsafe-arith", true);
            case "ByteOffset": case "AreSame": case "IsAddressGreaterThan": case "IsAddressLessThan":
            case "IsAddressGreaterThanOrEqualTo": case "IsAddressLessThanOrEqualTo":
                return ("unsafe-arith", true);
            case "AddByteOffset": case "SubtractByteOffset": return ptr ? ("unsafe-pointer", false) : ("unsafe-byteoffset", false);
            case "NullRef": case "IsNullRef": case "SkipInit": case "SizeOf": case "Unbox": return ("unsafe-cast", true);
            case "AsPointer": return ("unsafe-pointer", false);
            case "Read": case "Write": case "ReadUnaligned": case "WriteUnaligned": case "Copy": case "CopyBlock":
            case "CopyBlockUnaligned": case "InitBlock": case "InitBlockUnaligned":
                return ptr ? ("unsafe-pointer", false) : ("unsafe-unaligned", false);
        }
        return ("unsafe-" + name, false);
    }

    public string Category(MethodKey m)
    {
        var t = U.DeclType(m); var tn = U.TypeName(t); var ns = U.Namespace(t); var name = U.MethodName(m);
        if (ns.StartsWith("System.Runtime.Intrinsics.")) return "isa";
        if (ns == "System.Runtime.Intrinsics" || tn is "System.Numerics.Vector" || tn.StartsWith("System.Numerics.Vector`1")) return "vector";
        if (tn is "System.Threading.Interlocked" or "System.Threading.Volatile" or "System.Threading.Lock" or "System.Threading.Lock/Scope") return "thread-trivial";
        if (tn == "System.Threading.Monitor") return name is "Enter" or "Exit" or "TryEnter" or "IsEntered" ? "thread-trivial" : "thread-real";
        if (tn == "System.Threading.Thread") return name is "MemoryBarrier" or "get_CurrentThread" or "get_ManagedThreadId" or "get_CurrentManagedThreadId" ? "thread-trivial" : "thread-real";
        if (tn is "System.Threading.ThreadPool" or "System.Threading.WaitHandle" or "System.Threading.SpinWait" or "System.Threading.LowLevelMonitor"
            or "System.Threading.LowLevelLock" or "System.Threading.LowLevelLifoSemaphore" or "System.Threading.TimerQueue" or "System.Threading.PortableThreadPool"
            or "System.Threading.WaitSubsystem" or "System.Threading.Thread/StartHelper") return "thread-real";
        if (tn == "System.GC") return name is "KeepAlive" or "SuppressFinalize" or "ReRegisterForFinalize" ? "" : "gc";
        if (tn is "System.Runtime.InteropServices.GCHandle" or "System.WeakReference" or "System.WeakReference`1" or "System.Runtime.DependentHandle"
            or "System.Runtime.CompilerServices.ConditionalWeakTable`2") return "gc";
        if (ns.StartsWith("System.Reflection.Emit")) return "reflection-emit";
        if (tn == "System.Type") return name is "GetTypeFromHandle" or "op_Equality" or "op_Inequality" or "get_TypeHandle" or "Equals" ? "typeof" : "reflection";
        if (ns.StartsWith("System.Reflection") || tn is "System.RuntimeType" or "System.Activator" or "System.RuntimeTypeHandle" or "System.RuntimeMethodHandle"
            or "System.RuntimeFieldHandle" or "System.Reflection.MethodBase" or "System.Delegate" && name is "get_Method" or "CreateDelegate" or "DynamicInvoke")
            return "reflection";
        if (tn == "System.Runtime.CompilerServices.RuntimeHelpers" && LayoutObjectMethods.Contains(name)) return "layout-object";
        if (LayoutObjectTypes.Contains(tn)) return "layout-object";
        return "";
    }

    readonly Dictionary<(MethodKey, Scen), Cls> clsCache = new();
    public Cls Classify(MethodKey m, Scen sc)
    {
        if (clsCache.TryGetValue((m, sc), out var c)) return c;
        c = new Cls();
        clsCache[(m, sc)] = c;
        var s = Scan(m);
        if (!s.HasBody) return c;
        bool fold = sc != Scen.Raw, cc = sc == Scen.FoldC;
        bool Live(int i) => !fold || s.LiveFold[i];
        if (s.SigPtr || s.LocPtr) c.Block.Add("ptr");
        if (s.SigFn || s.LocFn) c.Block.Add("fnptr");
        if (s.Pinned) c.Block.Add("pinned");
        if (s.TypedRef) c.Block.Add("typedref");
        for (int i = 0; i < s.Ins.Count; i++)
        {
            if (!Live(i)) continue;
            var x = s.Ins[i];
            switch (x.Code)
            {
                case ILOpCode.Calli: c.Block.Add("fnptr"); break;
                case ILOpCode.Localloc:
                    {
                        bool toSpan = false;
                        for (int k = i + 1; k <= i + 3 && k < s.Ins.Count; k++)
                            if (s.Ins[k].Code == ILOpCode.Newobj && s.Calls.FirstOrDefault(p => p.Idx == k)?.Target is { } st
                                && U.TypeName(U.DeclType(st)) is "System.Span`1" or "System.ReadOnlySpan`1") toSpan = true;
                        if (!toSpan) c.Block.Add("stackalloc");
                        else if (!cc) c.Block.Add("stackalloc-span");
                        break;
                    }
                case ILOpCode.Cpblk: case ILOpCode.Initblk: case ILOpCode.Unaligned: c.Block.Add("memblk"); break;
                case ILOpCode.Volatile: if (!cc) c.Block.Add("thread-trivial"); break;
                case ILOpCode.Arglist: case ILOpCode.Mkrefany: case ILOpCode.Refanyval: case ILOpCode.Refanytype: c.Block.Add("typedref"); break;
            }
        }
        foreach (var cs in s.Calls)
        {
            if (!Live(cs.Idx)) continue;
            if (cs.Target is not { } t) { c.Info.Add("unresolved-call"); continue; }
            if (fold && cs.Op is Op.Call or Op.CallVirt && ConstValue(t) is not null) continue;
            var tt = U.DeclType(t);
            c.Touched.Add(tt);
            foreach (var a in cs.Inst) AddValueTypes(a, c.Inst);
            if (cs.Op == Op.NewObj && !U.IsValueType(tt)) c.Inst.Add(tt);
            var ts = Scan(t);
            // pointer-typed callee signature (the caller manufactures a pointer)
            if (ts.SigPtr || ts.SigFn)
            {
                bool rva = cs.Op == Op.NewObj && U.TypeName(tt) == "System.ReadOnlySpan`1" && cs.Idx >= 2
                    && s.Ins[cs.Idx - 2].Code == ILOpCode.Ldsflda;
                bool sspan = cs.Op == Op.NewObj && U.TypeName(tt) is "System.Span`1" or "System.ReadOnlySpan`1"
                    && Enumerable.Range(Math.Max(0, cs.Idx - 3), Math.Min(3, cs.Idx)).Any(k => s.Ins[k].Code == ILOpCode.Localloc);
                if (rva) { if (!cc) c.Block.Add("rvaspan"); }
                else if (sspan) { if (!cc) c.Block.Add("stackalloc-span"); }
                else if (!IsUnsafe(t)) c.Block.Add(ts.SigFn ? "fnptr" : "ptr");
            }
            if (cs.Op == Op.LdFtn)
            {
                int n = cs.Idx + 1;
                if (n >= s.Ins.Count || s.Ins[n].Code != ILOpCode.Newobj) c.Block.Add("fnptr");
            }
            if (IsUnsafe(t))
            {
                var (tag, ok) = UnsafeKind(t, cs.Inst);
                if (!(cc && ok)) c.Block.Add(tag);
                c.Info.Add("uses-unsafe");
                continue;
            }
            var cat = Category(t);
            // typeof(T).IsValueType & co: JIT intrinsics, constant per instantiation under monomorphization.
            if (cat == "reflection" && U.TypeName(tt) == "System.Type" && cs.Idx > 0 && s.Ins[cs.Idx - 1].Code == ILOpCode.Call
                && s.Calls.FirstOrDefault(p => p.Idx == cs.Idx - 1)?.Target is { } pt && U.MethodName(pt) == "GetTypeFromHandle")
                cat = cc ? "typeof" : "reflection";
            if (cat == "vector") c.Info.Add("vector");
            else if (cat == "typeof") c.Info.Add("typeof");
            else if (cat == "thread-trivial") { if (!cc) c.Block.Add(cat); }
            else if (cat != "") c.Block.Add(cat);
            if (cc && IsCIntrinsic(t)) { c.Edges.Add((cs.Op, t, false)); continue; }
            var md = U.Asms[t.Asm].R.GetMethodDefinition(t.H);
            bool isVirt = (md.Attributes & MethodAttributes.Virtual) != 0 && (md.Attributes & MethodAttributes.Final) == 0;
            bool slot = isVirt && (cs.Op is Op.CallVirt or Op.LdVirtFtn || (md.Attributes & MethodAttributes.Static) != 0 || cs.Constrained);
            c.Edges.Add((cs.Op, t, slot));
        }
        foreach (var f in s.Fields)
        {
            if (!Live(f.idx)) continue;
            if (f.decl is { } d)
            {
                var dn = U.TypeName(d);
                if (f.op is ILOpCode.Ldsfld or ILOpCode.Ldsflda or ILOpCode.Stsfld) c.Touched.Add(d);
                if (LayoutObjectTypes.Contains(dn)) c.Block.Add("layout-object");
                if (dn == "System.String" && f.name == "_firstChar") { if (!cc) c.Block.Add("layout-string"); }
            }
            if (f.type is SByRef) { if (!cc) c.Block.Add("reffield"); }
            else if (f.type.HasPointer) c.Block.Add("ptr");
            if (f.type.HasTypedRef) c.Block.Add("typedref");
        }
        foreach (var (idx, op, t) in s.Types)
        {
            if (!Live(idx)) continue;
            if (t.HasPointer) c.Block.Add(t.HasFnPtr ? "fnptr" : "ptr");
            if (t.HasTypedRef) c.Block.Add("typedref");
            if (op is ILOpCode.Box or ILOpCode.Constrained) AddValueTypes(t, c.Inst);
            if (op == ILOpCode.Newarr && szArrayHelper is { } sz) { c.Inst.Add(sz); if (arrayType is { } at) c.Inst.Add(at); }
            if (Universe.DefOf(t) is { } k && LayoutObjectTypes.Contains(U.TypeName(k))) c.Block.Add("layout-object");
        }
        foreach (var (idx, t) in s.ParentSpecs) if (Live(idx)) AddValueTypes(t, c.Inst);
        return c;
    }

    void AddValueTypes(Sig s, HashSet<TypeKey> into)
    {
        switch (s)
        {
            case SDef d when d.Key is { } k && d.IsValueType: into.Add(k); break;
            case SGen g:
                if (g.Def is SDef gd && gd.Key is { } gk && gd.IsValueType) into.Add(gk);
                foreach (var a in g.Args) AddValueTypes(a, into);
                break;
            case SArr a: AddValueTypes(a.E, into); break;
            case SByRef r: AddValueTypes(r.E, into); break;
        }
    }

    // ---------------------------------------------------------------- closure (rough RTA)

    public sealed class Result
    {
        public Scen Scen;
        public List<MethodKey> Order = new();
        public HashSet<MethodKey> Reached = new();
        public Dictionary<MethodKey, HashSet<MethodKey>> Out = new();
        public Dictionary<MethodKey, HashSet<MethodKey>> In = new();
        public Dictionary<MethodKey, HashSet<MethodKey>> InDirect = new();
        public HashSet<TypeKey> Instantiated = new();
        public Dictionary<TypeKey, MethodKey> InstBy = new();
        public HashSet<MethodKey> Entries = new();
        public HashSet<MethodKey> Leaves = new(); // not traversed: externs, Unsafe, C-intrinsics, proxies
    }

    public Result Closure(IEnumerable<MethodKey> entries, Scen sc, HashSet<MethodKey> proxies = null)
    {
        var R = new Result { Scen = sc };
        var q = new Queue<MethodKey>();
        var slotCallers = new Dictionary<(TypeKey, string, int), List<MethodKey>>();
        var slotImpls = new Dictionary<(TypeKey, string, int), HashSet<MethodKey>>();
        var slotsByKey = new Dictionary<(string, int), List<TypeKey>>();
        var implementors = new Dictionary<TypeKey, List<TypeKey>>();
        var cctorDone = new HashSet<TypeKey>();

        void Edge(MethodKey? from, MethodKey to)
        {
            if (from is { } f)
            {
                if (!R.Out.TryGetValue(f, out var o)) R.Out[f] = o = new();
                o.Add(to);
                if (!R.In.TryGetValue(to, out var i)) R.In[to] = i = new();
                i.Add(f);
            }
        }
        void Reach(MethodKey? from, MethodKey m)
        {
            Edge(from, m);
            if (!R.Reached.Add(m)) return;
            R.Order.Add(m);
            var s = Scan(m);
            bool leaf = !s.HasBody || IsUnsafe(m) || (proxies != null && proxies.Contains(m)) || (sc == Scen.FoldC && IsCIntrinsic(m));
            if (leaf) { R.Leaves.Add(m); if (s.HasBody || s.Extern != ExternKind.Abstract) Touch(m, U.DeclType(m)); return; }
            q.Enqueue(m);
        }
        void Touch(MethodKey from, TypeKey t)
        {
            if (!cctorDone.Add(t)) return;
            foreach (var mh in U.MethodsNamed(t, ".cctor")) Reach(from, new MethodKey(t.Asm, mh));
        }
        (string, int) KeyOf(MethodKey m)
        {
            var md = U.Asms[m.Asm].R.GetMethodDefinition(m.H);
            return (U.MethodName(m), md.GetParameters().Count(p => U.Asms[m.Asm].R.GetParameter(p).SequenceNumber > 0));
        }
        // Virtual methods (and method impls) of C's chain matching a slot.
        IEnumerable<MethodKey> Implementations(TypeKey c, TypeKey slotDecl, string name, int pc)
        {
            bool sz = szArrayHelper is { } szh && c == szh;
            for (TypeKey? t = c; t is { } tk; t = U.BaseOf(tk))
            {
                var r = U.Asms[tk.Asm].R;
                foreach (var mh in U.MethodsNamed(tk, name))
                {
                    var mk = new MethodKey(tk.Asm, mh);
                    var md = r.GetMethodDefinition(mh);
                    if (!sz && (md.Attributes & MethodAttributes.Virtual) == 0 && (md.Attributes & MethodAttributes.Static) == 0) continue;
                    if (KeyOf(mk).Item2 != pc) continue;
                    yield return mk;
                }
                foreach (var ih in r.GetTypeDefinition(tk.H).GetMethodImplementations())
                {
                    var mi = r.GetMethodImplementation(ih);
                    var (decl, _) = U.ResolveMethod(tk.Asm, mi.MethodDeclaration);
                    if (decl is not { } dk || U.MethodName(dk) != name) continue;
                    var dt = U.DeclType(dk);
                    if (dt != slotDecl && !U.Supertypes(dt).Contains(slotDecl)) continue;
                    var (body, _) = U.ResolveMethod(tk.Asm, mi.MethodBody);
                    if (body is { } bk) yield return bk;
                }
            }
        }
        HashSet<TypeKey> SupersOf(TypeKey c)
        {
            if (szArrayHelper is { } sz && c == sz) { var h = new HashSet<TypeKey>(U.Supertypes(c)); h.UnionWith(arrayIfaces); return h; }
            return U.Supertypes(c);
        }
        void Match((TypeKey, string, int) slot, TypeKey c)
        {
            if (!slotImpls.TryGetValue(slot, out var impls)) slotImpls[slot] = impls = new();
            foreach (var impl in Implementations(c, slot.Item1, slot.Item2, slot.Item3))
            {
                if (!impls.Add(impl)) continue;
                foreach (var caller in slotCallers[slot]) Reach(caller, impl);
            }
        }
        void Instantiate(MethodKey? from, TypeKey c)
        {
            if (U.IsByRefLike(c)) return;
            if (!R.Instantiated.Add(c)) return;
            if (from is { } fr) R.InstBy[c] = fr;
            foreach (var st in SupersOf(c))
            {
                if (!implementors.TryGetValue(st, out var l)) implementors[st] = l = new();
                l.Add(c);
            }
            if (from is { } f) Touch(f, c);
            // finalizer
            for (TypeKey? t = c; t is { } tk && tk != objectType; t = U.BaseOf(tk))
                foreach (var mh in U.MethodsNamed(tk, "Finalize")) { if (from is { } ff) Reach(ff, new MethodKey(tk.Asm, mh)); }
            foreach (var slot in slotCallers.Keys.ToList())
                if (SupersOf(c).Contains(slot.Item1)) Match(slot, c);
        }
        void AddSlot(MethodKey caller, MethodKey target)
        {
            var (name, pc) = KeyOf(target);
            var slot = (U.DeclType(target), name, pc);
            bool isNew = !slotCallers.TryGetValue(slot, out var callers);
            if (isNew) slotCallers[slot] = callers = new();
            callers.Add(caller);
            if (isNew)
            {
                if (implementors.TryGetValue(slot.Item1, out var cs)) foreach (var c in cs.ToList()) Match(slot, c);
            }
            else if (slotImpls.TryGetValue(slot, out var impls)) foreach (var i in impls) Edge(caller, i);
        }

        foreach (var e in entries) { R.Entries.Add(e); Reach(null, e); var t = U.DeclType(e); Touch(e, t); if (U.MethodName(e) == ".ctor") Instantiate(e, t); }
        bool rootsAdded = false;
        while (q.Count > 0)
        {
            var m = q.Dequeue();
            var c = Classify(m, sc);
            foreach (var t in c.Touched) Touch(m, t);
            foreach (var t in c.Inst) Instantiate(m, t);
            foreach (var (op, t, slot) in c.Edges)
            {
                var ts = Scan(t);
                    if (ts.Extern != ExternKind.Abstract)
                {
                    Reach(m, t);
                    if (!R.InDirect.TryGetValue(t, out var d)) R.InDirect[t] = d = new();
                    d.Add(m);
                    // CoreCLR string constructors are FCalls the VM redirects to String.Ctor overloads.
                    if (ts.Extern == ExternKind.FCall && U.MethodName(t) == ".ctor" && U.TypeName(U.DeclType(t)) == "System.String")
                    {
                        var want = U.MethodSigString(t).Split('(')[1];
                        foreach (var ch in U.MethodsNamed(U.DeclType(t), "Ctor"))
                        {
                            var ck = new MethodKey(t.Asm, ch);
                            if (U.MethodSigString(ck).Split('(')[1] == want) Reach(m, ck);
                        }
                    }
                }
                if (slot) AddSlot(m, t);
                if (!rootsAdded && U.TypeName(U.DeclType(t)) is "System.Collections.Generic.Comparer`1" or "System.Collections.Generic.EqualityComparer`1")
                {
                    rootsAdded = true;
                    foreach (var rc in reflectionCreated) Instantiate(m, rc);
                }
            }
        }
        return R;
    }
}
