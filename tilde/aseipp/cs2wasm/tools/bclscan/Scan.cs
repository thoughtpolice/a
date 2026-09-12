// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// bclscan: reachability + blocker classification of framework IL, for
// estimating how much of the real BCL a CIL importer could lower to Wasm GC.

using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text;

namespace BclScan;

public readonly record struct TypeKey(int Asm, TypeDefinitionHandle H);
public readonly record struct MethodKey(int Asm, MethodDefinitionHandle H);
public readonly record struct FieldKey(int Asm, FieldDefinitionHandle H);

// ---------------------------------------------------------------- signatures

public abstract class Sig
{
    public abstract override string ToString();
    public virtual bool HasPointer => false;
    public virtual bool HasFnPtr => false;
    public virtual bool HasTypedRef => false;
}
public sealed class SPrim(PrimitiveTypeCode c) : Sig
{
    public PrimitiveTypeCode Code = c;
    public override string ToString() => Code.ToString();
    public override bool HasTypedRef => Code == PrimitiveTypeCode.TypedReference;
}
public sealed class SDef(TypeKey? k, string name, bool vt) : Sig
{
    public TypeKey? Key = k; public string Name = name; public bool IsValueType = vt;
    public override string ToString() => Name;
}
public sealed class SPtr(Sig e) : Sig { public Sig E = e; public override string ToString() => E + "*"; public override bool HasPointer => true; public override bool HasFnPtr => E.HasFnPtr; }
public sealed class SByRef(Sig e) : Sig { public Sig E = e; public override string ToString() => E + "&"; public override bool HasPointer => E.HasPointer; public override bool HasFnPtr => E.HasFnPtr; public override bool HasTypedRef => E.HasTypedRef; }
public sealed class SArr(Sig e, int rank) : Sig
{
    public Sig E = e; public int Rank = rank;
    public override string ToString() => E + (Rank == 0 ? "[]" : "[" + new string(',', Rank - 1) + "]");
    public override bool HasPointer => E.HasPointer; public override bool HasFnPtr => E.HasFnPtr;
}
public sealed class SGen(Sig d, ImmutableArray<Sig> a) : Sig
{
    public Sig Def = d; public ImmutableArray<Sig> Args = a;
    public override string ToString() => Def + "<" + string.Join(",", Args) + ">";
    public override bool HasPointer => Args.Any(x => x.HasPointer); public override bool HasFnPtr => Args.Any(x => x.HasFnPtr);
}
public sealed class SVar(int i, bool m) : Sig { public int Index = i; public bool Method = m; public override string ToString() => (Method ? "!!" : "!") + Index; }
public sealed class SFn(MethodSignature<Sig> s) : Sig
{
    public MethodSignature<Sig> S = s;
    public override string ToString() => "fnptr(" + S.ReturnType + ";" + string.Join(",", S.ParameterTypes) + ")";
    public override bool HasPointer => true; public override bool HasFnPtr => true;
}
public sealed class SPinned(Sig e) : Sig { public Sig E = e; public override string ToString() => E + " pinned"; public override bool HasPointer => E.HasPointer; public override bool HasFnPtr => E.HasFnPtr; }

public sealed class Provider(Universe u) : ISignatureTypeProvider<Sig, object>
{
    public Sig GetPrimitiveType(PrimitiveTypeCode c) => new SPrim(c);
    public Sig GetTypeFromDefinition(MetadataReader r, TypeDefinitionHandle h, byte k)
    {
        var key = new TypeKey(u.AsmOf(r), h);
        return new SDef(key, u.TypeName(key), k == (byte)SignatureTypeKind.ValueType || u.IsValueType(key));
    }
    public Sig GetTypeFromReference(MetadataReader r, TypeReferenceHandle h, byte k)
    {
        var key = u.ResolveTypeRef(u.AsmOf(r), h);
        if (key is { } kk) return new SDef(kk, u.TypeName(kk), k == (byte)SignatureTypeKind.ValueType || u.IsValueType(kk));
        var tr = r.GetTypeReference(h);
        return new SDef(null, "?" + r.GetString(tr.Namespace) + "." + r.GetString(tr.Name), k == (byte)SignatureTypeKind.ValueType);
    }
    public Sig GetTypeFromSpecification(MetadataReader r, object ctx, TypeSpecificationHandle h, byte k)
        => r.GetTypeSpecification(h).DecodeSignature(this, ctx);
    public Sig GetSZArrayType(Sig e) => new SArr(e, 0);
    public Sig GetArrayType(Sig e, ArrayShape s) => new SArr(e, s.Rank);
    public Sig GetByReferenceType(Sig e) => new SByRef(e);
    public Sig GetPointerType(Sig e) => new SPtr(e);
    public Sig GetGenericInstantiation(Sig g, ImmutableArray<Sig> a) => new SGen(g, a);
    public Sig GetGenericTypeParameter(object ctx, int i) => new SVar(i, false);
    public Sig GetGenericMethodParameter(object ctx, int i) => new SVar(i, true);
    public Sig GetFunctionPointerType(MethodSignature<Sig> s) => new SFn(s);
    public Sig GetModifiedType(Sig m, Sig t, bool req) => t;
    public Sig GetPinnedType(Sig e) => new SPinned(e);
}

// ---------------------------------------------------------------- universe

public sealed class Asm
{
    public int Index; public string Name; public string Path; public PEReader Pe; public MetadataReader R;
    public Dictionary<string, TypeDefinitionHandle> Types = new();
    public Dictionary<string, string> Forwards = new();
}

public sealed class Universe
{
    public List<Asm> Asms = new();
    public Dictionary<string, Asm> ByName = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<MetadataReader, int> readerIdx = new(ReferenceEqualityComparer.Instance);
    public Provider P;
    public Universe() { P = new Provider(this); }

    public void Load(string path)
    {
        try
        {
            var pe = new PEReader(File.OpenRead(path));
            if (!pe.HasMetadata) return;
            var r = pe.GetMetadataReader();
            if (!r.IsAssembly) return;
            var a = new Asm { Index = Asms.Count, Path = path, Pe = pe, R = r, Name = r.GetString(r.GetAssemblyDefinition().Name) };
            if (ByName.ContainsKey(a.Name)) return;
            Asms.Add(a); ByName[a.Name] = a; readerIdx[r] = a.Index;
            foreach (var th in r.TypeDefinitions) a.Types[FullName(r, th)] = th;
            foreach (var eh in r.ExportedTypes)
            {
                var et = r.GetExportedType(eh);
                string fn = ExportedFullName(r, eh, out var asmRef);
                if (asmRef is { } ar) a.Forwards[fn] = r.GetString(r.GetAssemblyReference(ar).Name);
            }
        }
        catch (BadImageFormatException) { }
    }

    static string ExportedFullName(MetadataReader r, ExportedTypeHandle h, out AssemblyReferenceHandle? asmRef)
    {
        var et = r.GetExportedType(h);
        string name = r.GetString(et.Name);
        if (et.Implementation.Kind == HandleKind.ExportedType)
        {
            var outer = ExportedFullName(r, (ExportedTypeHandle)et.Implementation, out asmRef);
            return outer + "/" + name;
        }
        asmRef = et.Implementation.Kind == HandleKind.AssemblyReference ? (AssemblyReferenceHandle)et.Implementation : null;
        var ns = r.GetString(et.Namespace);
        return ns.Length == 0 ? name : ns + "." + name;
    }

    public static string FullName(MetadataReader r, TypeDefinitionHandle h)
    {
        var td = r.GetTypeDefinition(h);
        var name = r.GetString(td.Name);
        var decl = td.GetDeclaringType();
        if (!decl.IsNil) return FullName(r, decl) + "/" + name;
        var ns = r.GetString(td.Namespace);
        return ns.Length == 0 ? name : ns + "." + name;
    }

    public int AsmOf(MetadataReader r) => readerIdx[r];
    readonly Dictionary<TypeKey, string> names = new();
    public string TypeName(TypeKey k)
    {
        if (!names.TryGetValue(k, out var n)) names[k] = n = FullName(Asms[k.Asm].R, k.H);
        return n;
    }
    public string Namespace(TypeKey k)
    {
        var r = Asms[k.Asm].R; var td = r.GetTypeDefinition(k.H);
        while (!td.GetDeclaringType().IsNil) td = r.GetTypeDefinition(td.GetDeclaringType());
        return r.GetString(td.Namespace);
    }

    public TypeKey? Find(string asmName, string fullName, int depth = 0)
    {
        if (depth > 8 || !ByName.TryGetValue(asmName, out var a)) return null;
        if (a.Types.TryGetValue(fullName, out var h)) return new TypeKey(a.Index, h);
        if (a.Forwards.TryGetValue(fullName, out var to)) return Find(to, fullName, depth + 1);
        return null;
    }
    public TypeKey? FindAnywhere(string fullName)
    {
        foreach (var a in Asms) if (a.Types.TryGetValue(fullName, out var h)) return new TypeKey(a.Index, h);
        return null;
    }

    readonly Dictionary<(int, TypeReferenceHandle), TypeKey?> trCache = new();
    public TypeKey? ResolveTypeRef(int asm, TypeReferenceHandle h)
    {
        if (trCache.TryGetValue((asm, h), out var c)) return c;
        var r = Asms[asm].R; var tr = r.GetTypeReference(h);
        TypeKey? res = null;
        string name = r.GetString(tr.Name), ns = r.GetString(tr.Namespace);
        string fn = ns.Length == 0 ? name : ns + "." + name;
        var scope = tr.ResolutionScope;
        switch (scope.Kind)
        {
            case HandleKind.AssemblyReference:
                res = Find(r.GetString(r.GetAssemblyReference((AssemblyReferenceHandle)scope).Name), fn); break;
            case HandleKind.TypeReference:
                var outer = ResolveTypeRef(asm, (TypeReferenceHandle)scope);
                if (outer is { } o) res = Find(Asms[o.Asm].Name, TypeName(o) + "/" + name);
                break;
            default:
                res = Find(Asms[asm].Name, fn); break;
        }
        trCache[(asm, h)] = res;
        return res;
    }

    public TypeKey? ResolveTypeHandle(int asm, EntityHandle h)
    {
        var r = Asms[asm].R;
        switch (h.Kind)
        {
            case HandleKind.TypeDefinition: return new TypeKey(asm, (TypeDefinitionHandle)h);
            case HandleKind.TypeReference: return ResolveTypeRef(asm, (TypeReferenceHandle)h);
            case HandleKind.TypeSpecification:
                return DefOf(r.GetTypeSpecification((TypeSpecificationHandle)h).DecodeSignature(P, null));
        }
        return null;
    }
    public Sig DecodeType(int asm, EntityHandle h)
    {
        var r = Asms[asm].R;
        return h.Kind switch
        {
            HandleKind.TypeDefinition => P.GetTypeFromDefinition(r, (TypeDefinitionHandle)h, 0),
            HandleKind.TypeReference => P.GetTypeFromReference(r, (TypeReferenceHandle)h, 0),
            HandleKind.TypeSpecification => r.GetTypeSpecification((TypeSpecificationHandle)h).DecodeSignature(P, null),
            _ => new SDef(null, "?", false),
        };
    }
    public static TypeKey? DefOf(Sig s) => s switch { SDef d => d.Key, SGen g => DefOf(g.Def), _ => null };

    readonly Dictionary<TypeKey, bool> vtCache = new();
    public bool IsValueType(TypeKey k)
    {
        if (vtCache.TryGetValue(k, out var v)) return v;
        vtCache[k] = false;
        var r = Asms[k.Asm].R; var td = r.GetTypeDefinition(k.H);
        var bt = td.BaseType;
        bool res = false;
        if (!bt.IsNil)
        {
            var b = ResolveTypeHandle(k.Asm, bt);
            if (b is { } bk) { var n = TypeName(bk); res = (n == "System.ValueType" || n == "System.Enum") && TypeName(k) != "System.Enum"; }
        }
        vtCache[k] = res;
        return res;
    }
    public TypeKey? BaseOf(TypeKey k)
    {
        var td = Asms[k.Asm].R.GetTypeDefinition(k.H);
        return td.BaseType.IsNil ? null : ResolveTypeHandle(k.Asm, td.BaseType);
    }
    readonly Dictionary<TypeKey, bool> brl = new();
    public bool IsByRefLike(TypeKey k)
    {
        if (brl.TryGetValue(k, out var v)) return v;
        var r = Asms[k.Asm].R; v = false;
        foreach (var ch in r.GetTypeDefinition(k.H).GetCustomAttributes())
        {
            var ca = r.GetCustomAttribute(ch);
            EntityHandle parent = ca.Constructor.Kind == HandleKind.MemberReference ? r.GetMemberReference((MemberReferenceHandle)ca.Constructor).Parent
                : ca.Constructor.Kind == HandleKind.MethodDefinition ? r.GetMethodDefinition((MethodDefinitionHandle)ca.Constructor).GetDeclaringType() : default;
            string n = parent.Kind switch
            {
                HandleKind.TypeReference => r.GetString(r.GetTypeReference((TypeReferenceHandle)parent).Name),
                HandleKind.TypeDefinition => r.GetString(r.GetTypeDefinition((TypeDefinitionHandle)parent).Name),
                _ => "",
            };
            if (n == "IsByRefLikeAttribute") { v = true; break; }
        }
        brl[k] = v;
        return v;
    }
    public bool IsInterface(TypeKey k) => (Asms[k.Asm].R.GetTypeDefinition(k.H).Attributes & TypeAttributes.Interface) != 0;

    readonly Dictionary<TypeKey, HashSet<TypeKey>> supers = new();
    public HashSet<TypeKey> Supertypes(TypeKey k)
    {
        if (supers.TryGetValue(k, out var s)) return s;
        s = new HashSet<TypeKey> { k };
        supers[k] = s;
        var r = Asms[k.Asm].R; var td = r.GetTypeDefinition(k.H);
        if (BaseOf(k) is { } b) s.UnionWith(Supertypes(b));
        foreach (var ih in td.GetInterfaceImplementations())
        {
            var ii = r.GetInterfaceImplementation(ih);
            if (ResolveTypeHandle(k.Asm, ii.Interface) is { } ik) s.UnionWith(Supertypes(ik));
        }
        return s;
    }

    // ------------------------------------------------ methods and fields

    readonly Dictionary<MethodKey, string> msigCache = new();
    public string MethodSigString(MethodKey m)
    {
        if (msigCache.TryGetValue(m, out var s)) return s;
        var md = Asms[m.Asm].R.GetMethodDefinition(m.H);
        s = SigString(md.DecodeSignature(P, null));
        msigCache[m] = s;
        return s;
    }
    public static string SigString(MethodSignature<Sig> s)
        => s.GenericParameterCount + "|" + (s.Header.IsInstance ? "i" : "s") + "|" + s.ReturnType + "(" + string.Join(",", s.ParameterTypes) + ")";

    public string MethodName(MethodKey m) => Asms[m.Asm].R.GetString(Asms[m.Asm].R.GetMethodDefinition(m.H).Name);
    public TypeKey DeclType(MethodKey m) => new(m.Asm, Asms[m.Asm].R.GetMethodDefinition(m.H).GetDeclaringType());
    public string Display(MethodKey m)
    {
        var md = Asms[m.Asm].R.GetMethodDefinition(m.H);
        var sig = md.DecodeSignature(P, null);
        return TypeName(DeclType(m)) + "::" + MethodName(m) + (sig.GenericParameterCount > 0 ? "<" + sig.GenericParameterCount + ">" : "") + "(" + string.Join(",", sig.ParameterTypes.Select(Short)) + ")";
    }
    static string Short(Sig s)
    {
        var t = s.ToString();
        int lt = t.IndexOf('<');
        var head = lt < 0 ? t : t[..lt];
        int dot = head.LastIndexOfAny(['.', '/']);
        return dot < 0 ? t : t[(dot + 1)..];
    }

    readonly Dictionary<TypeKey, Dictionary<string, List<MethodDefinitionHandle>>> methodsByName = new();
    public List<MethodDefinitionHandle> MethodsNamed(TypeKey t, string name)
    {
        if (!methodsByName.TryGetValue(t, out var d))
        {
            d = new();
            var r = Asms[t.Asm].R;
            foreach (var mh in r.GetTypeDefinition(t.H).GetMethods())
            {
                var n = r.GetString(r.GetMethodDefinition(mh).Name);
                if (!d.TryGetValue(n, out var l)) d[n] = l = new();
                l.Add(mh);
            }
            methodsByName[t] = d;
        }
        return d.TryGetValue(name, out var res) ? res : [];
    }

    public int UnresolvedMethods;
    readonly Dictionary<(int, EntityHandle), (MethodKey?, ImmutableArray<Sig>)> mrCache = new();
    public (MethodKey? m, ImmutableArray<Sig> inst) ResolveMethod(int asm, EntityHandle h)
    {
        if (mrCache.TryGetValue((asm, h), out var c)) return c;
        var r = Asms[asm].R;
        (MethodKey?, ImmutableArray<Sig>) res = (null, ImmutableArray<Sig>.Empty);
        switch (h.Kind)
        {
            case HandleKind.MethodDefinition: res = (new MethodKey(asm, (MethodDefinitionHandle)h), res.Item2); break;
            case HandleKind.MethodSpecification:
                {
                    var ms = r.GetMethodSpecification((MethodSpecificationHandle)h);
                    var inner = ResolveMethod(asm, ms.Method);
                    res = (inner.m, ms.DecodeSignature(P, null));
                    break;
                }
            case HandleKind.MemberReference:
                {
                    var mr = r.GetMemberReference((MemberReferenceHandle)h);
                    if (mr.GetKind() != MemberReferenceKind.Method) break;
                    var name = r.GetString(mr.Name);
                    TypeKey? parent = mr.Parent.Kind switch
                    {
                        HandleKind.TypeDefinition or HandleKind.TypeReference or HandleKind.TypeSpecification => ResolveTypeHandle(asm, mr.Parent),
                        HandleKind.MethodDefinition => DeclType(new MethodKey(asm, (MethodDefinitionHandle)mr.Parent)),
                        _ => null,
                    };
                    if (parent is null) { UnresolvedMethods++; break; }
                    var sig = SigString(mr.DecodeMethodSignature(P, null));
                    for (TypeKey? t = parent; t is { } tk; t = BaseOf(tk))
                    {
                        foreach (var mh in MethodsNamed(tk, name))
                            if (MethodSigString(new MethodKey(tk.Asm, mh)) == sig) { res = (new MethodKey(tk.Asm, mh), res.Item2); goto done; }
                    }
                    // Fallback: unique by name + arity.
                    {
                        var ms = mr.DecodeMethodSignature(P, null);
                        var cands = MethodsNamed(parent.Value, name).Where(mh => Asms[parent.Value.Asm].R.GetMethodDefinition(mh).DecodeSignature(P, null) is var s2 && s2.ParameterTypes.Length == ms.ParameterTypes.Length && s2.GenericParameterCount == ms.GenericParameterCount).ToList();
                        if (cands.Count >= 1) res = (new MethodKey(parent.Value.Asm, cands[0]), res.Item2);
                        else UnresolvedMethods++;
                    }
                done:
                    break;
                }
        }
        mrCache[(asm, h)] = res;
        return res;
    }

    public (TypeKey? decl, string name, Sig type, FieldKey? f) ResolveField(int asm, EntityHandle h)
    {
        var r = Asms[asm].R;
        if (h.Kind == HandleKind.FieldDefinition)
        {
            var fd = r.GetFieldDefinition((FieldDefinitionHandle)h);
            return (new TypeKey(asm, fd.GetDeclaringType()), r.GetString(fd.Name), fd.DecodeSignature(P, null), new FieldKey(asm, (FieldDefinitionHandle)h));
        }
        if (h.Kind == HandleKind.MemberReference)
        {
            var mr = r.GetMemberReference((MemberReferenceHandle)h);
            var name = r.GetString(mr.Name);
            var t = ResolveTypeHandle(asm, mr.Parent);
            var sig = mr.DecodeFieldSignature(P, null);
            FieldKey? fk = null;
            if (t is { } tk)
            {
                var tr = Asms[tk.Asm].R;
                foreach (var fh in tr.GetTypeDefinition(tk.H).GetFields())
                    if (tr.GetString(tr.GetFieldDefinition(fh).Name) == name) { fk = new FieldKey(tk.Asm, fh); break; }
            }
            return (t, name, sig, fk);
        }
        return (null, "?", new SDef(null, "?", false), null);
    }
}

// ---------------------------------------------------------------- IL decoding

public enum Op { Call, CallVirt, NewObj, LdFtn, LdVirtFtn, Jmp }

public sealed class Instr
{
    public int Offset; public ILOpCode Code; public int Next;
    public int Token; public int[] Targets = [];
    public bool Prefixed; // volatile./unaligned. preceded it
}

public static class IL
{
    public static int OperandSize(ILOpCode op, ref BlobReader br)
    {
        int v = (int)op;
        switch (op)
        {
            case ILOpCode.Ldarg_s: case ILOpCode.Ldarga_s: case ILOpCode.Starg_s:
            case ILOpCode.Ldloc_s: case ILOpCode.Ldloca_s: case ILOpCode.Stloc_s:
            case ILOpCode.Ldc_i4_s: case ILOpCode.Unaligned:
                return 1;
            case ILOpCode.Ldarg: case ILOpCode.Ldarga: case ILOpCode.Starg:
            case ILOpCode.Ldloc: case ILOpCode.Ldloca: case ILOpCode.Stloc:
                return 2;
            case ILOpCode.Ldc_i8: case ILOpCode.Ldc_r8: return 8;
            case (ILOpCode)0xFE19: return 1;
        }
        if (v >= 0x2B && v <= 0x37) return 1; // short branches
        if (op == ILOpCode.Leave_s) return 1;
        if (v >= 0x38 && v <= 0x44) return 4;
        if (op == ILOpCode.Leave) return 4;
        switch (op)
        {
            case ILOpCode.Ldc_i4: case ILOpCode.Ldc_r4:
            case ILOpCode.Jmp: case ILOpCode.Call: case ILOpCode.Calli: case ILOpCode.Callvirt: case ILOpCode.Newobj:
            case ILOpCode.Ldftn: case ILOpCode.Ldvirtftn:
            case ILOpCode.Cpobj: case ILOpCode.Ldobj: case ILOpCode.Castclass: case ILOpCode.Isinst: case ILOpCode.Unbox:
            case ILOpCode.Stobj: case ILOpCode.Box: case ILOpCode.Newarr: case ILOpCode.Ldelema: case ILOpCode.Ldelem:
            case ILOpCode.Stelem: case ILOpCode.Unbox_any: case ILOpCode.Refanyval: case ILOpCode.Mkrefany:
            case ILOpCode.Initobj: case ILOpCode.Constrained: case ILOpCode.Sizeof:
            case ILOpCode.Ldstr:
            case ILOpCode.Ldfld: case ILOpCode.Ldflda: case ILOpCode.Stfld: case ILOpCode.Ldsfld: case ILOpCode.Ldsflda: case ILOpCode.Stsfld:
            case ILOpCode.Ldtoken:
                return 4;
        }
        return 0;
    }

    public static List<Instr> Decode(BlobReader br)
    {
        var list = new List<Instr>();
        int length = br.Length;
        bool prefix = false;
        while (br.Offset < length)
        {
            int off = br.Offset;
            int b = br.ReadByte();
            ILOpCode op = b == 0xFE ? (ILOpCode)(0xFE00 | br.ReadByte()) : (ILOpCode)b;
            var ins = new Instr { Offset = off, Code = op, Prefixed = prefix };
            prefix = op is ILOpCode.Volatile or ILOpCode.Unaligned;
            if (op == ILOpCode.Switch)
            {
                int n = br.ReadInt32();
                var tg = new int[n];
                for (int i = 0; i < n; i++) tg[i] = br.ReadInt32();
                int end = br.Offset;
                for (int i = 0; i < n; i++) tg[i] += end;
                ins.Targets = tg;
            }
            else
            {
                int sz = OperandSize(op, ref br);
                int v = (int)op;
                bool shortBr = (v >= 0x2B && v <= 0x37) || op == ILOpCode.Leave_s;
                bool longBr = (v >= 0x38 && v <= 0x44) || op == ILOpCode.Leave;
                if (shortBr) { int d = br.ReadSByte(); ins.Targets = [br.Offset + d]; }
                else if (longBr) { int d = br.ReadInt32(); ins.Targets = [br.Offset + d]; }
                else if (sz == 4) ins.Token = br.ReadInt32();
                else br.Offset += sz;
            }
            ins.Next = br.Offset;
            list.Add(ins);
        }
        return list;
    }

    public static bool IsUncond(ILOpCode op) => op is ILOpCode.Br or ILOpCode.Br_s or ILOpCode.Leave or ILOpCode.Leave_s;
    public static bool IsTerminal(ILOpCode op) => op is ILOpCode.Ret or ILOpCode.Throw or ILOpCode.Rethrow or ILOpCode.Endfinally or ILOpCode.Endfilter or ILOpCode.Jmp;
}
