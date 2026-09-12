// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

using System.Reflection;
using System.Reflection.Metadata;
using System.Text;

namespace BclScan;

public static class Program
{
    static readonly (string group, string tier, string[] types)[] Groups =
    [
        ("Math", "core", ["System.Math", "System.MathF"]),
        ("String/Char/StringBuilder", "core", ["System.String", "System.Char", "System.Text.StringBuilder"]),
        ("Span/Memory", "core", ["System.Span`1", "System.ReadOnlySpan`1", "System.Memory`1", "System.ReadOnlyMemory`1", "System.MemoryExtensions"]),
        ("Collections", "core", ["System.Collections.Generic.List`1", "System.Collections.Generic.Dictionary`2", "System.Collections.Generic.HashSet`1",
            "System.Collections.Generic.Queue`1", "System.Collections.Generic.Stack`1", "System.Collections.Generic.PriorityQueue`2",
            "System.Collections.Generic.SortedDictionary`2", "System.Collections.Generic.KeyValuePair`2",
            "System.Collections.Generic.Comparer`1", "System.Collections.Generic.EqualityComparer`1"]),
        ("LINQ", "core", ["System.Linq.Enumerable"]),
        ("Array", "core", ["System.Array"]),
        ("Random", "core", ["System.Random"]),
        ("Guid", "core", ["System.Guid"]),
        ("DateTime/TimeSpan/Stopwatch", "core", ["System.DateTime", "System.DateTimeOffset", "System.TimeSpan", "System.Diagnostics.Stopwatch"]),
        ("Lazy", "core", ["System.Lazy`1"]),
        ("Nullable/Tuple/HashCode", "core", ["System.Nullable`1", "System.Nullable", "System.Tuple", "System.Tuple`2", "System.Tuple`3",
            "System.ValueTuple", "System.ValueTuple`2", "System.ValueTuple`3", "System.ValueTuple`4", "System.HashCode"]),
        ("Enum", "core", ["System.Enum"]),
        ("Convert/BitConverter", "core", ["System.Convert", "System.BitConverter"]),
        ("Encoding.UTF8", "core", ["System.Text.Encoding", "System.Text.UTF8Encoding"]),
        ("Primitive parse/format", "core", ["System.Int32", "System.Int64", "System.UInt32", "System.UInt64", "System.Double", "System.Single",
            "System.Boolean", "System.Byte", "System.Int16"]),
        ("Decimal", "core", ["System.Decimal"]),
        ("Task/async", "core", ["System.Threading.Tasks.Task", "System.Threading.Tasks.Task`1", "System.Threading.Tasks.ValueTask",
            "System.Threading.Tasks.ValueTask`1", "System.Threading.Tasks.TaskCompletionSource", "System.Threading.Tasks.TaskCompletionSource`1",
            "System.Runtime.CompilerServices.AsyncTaskMethodBuilder", "System.Runtime.CompilerServices.AsyncTaskMethodBuilder`1",
            "System.Runtime.CompilerServices.AsyncValueTaskMethodBuilder", "System.Runtime.CompilerServices.AsyncValueTaskMethodBuilder`1",
            "System.Runtime.CompilerServices.AsyncVoidMethodBuilder", "System.Runtime.CompilerServices.TaskAwaiter",
            "System.Runtime.CompilerServices.TaskAwaiter`1", "System.Runtime.CompilerServices.ValueTaskAwaiter",
            "System.Runtime.CompilerServices.ValueTaskAwaiter`1", "System.Runtime.CompilerServices.YieldAwaitable",
            "System.Runtime.CompilerServices.YieldAwaitable/YieldAwaiter",
            "System.Threading.CancellationToken", "System.Threading.CancellationTokenSource"]),
        ("Numerics vectors", "core", ["System.Numerics.Vector2", "System.Numerics.Vector3", "System.Numerics.Vector4", "System.Numerics.Quaternion",
            "System.Numerics.Matrix4x4", "System.Numerics.Matrix3x2", "System.Numerics.Plane"]),
        ("BigInteger", "core", ["System.Numerics.BigInteger"]),
        ("Exceptions", "core", ["System.Exception", "System.ArgumentException", "System.ArgumentNullException", "System.ArgumentOutOfRangeException",
            "System.InvalidOperationException", "System.NotSupportedException", "System.NotImplementedException", "System.IndexOutOfRangeException",
            "System.NullReferenceException", "System.Collections.Generic.KeyNotFoundException", "System.FormatException", "System.OverflowException",
            "System.DivideByZeroException", "System.InvalidCastException", "System.ObjectDisposedException", "System.AggregateException",
            "System.OperationCanceledException"]),
        ("System.Text.Json", "heavy", ["System.Text.Json.JsonSerializer", "System.Text.Json.JsonDocument", "System.Text.Json.JsonElement",
            "System.Text.Json.Utf8JsonReader", "System.Text.Json.Utf8JsonWriter", "System.Text.Json.Nodes.JsonNode"]),
        ("Regex", "heavy", ["System.Text.RegularExpressions.Regex", "System.Text.RegularExpressions.Match",
            "System.Text.RegularExpressions.Group", "System.Text.RegularExpressions.Capture", "System.Text.RegularExpressions.MatchCollection"]),
    ];

    static Universe U;
    static Analyzer A;
    static StringBuilder Out = new();
    static void W(string s = "") => Out.AppendLine(s);

    public static int Main(string[] args)
    {
        if (args.Length < 2) { Console.Error.WriteLine("usage: bclscan <framework-dir> <out.md> [extra.dll...]"); return 2; }
        U = new Universe();
        foreach (var dir in args[0].Split(':'))
            foreach (var f in Directory.GetFiles(dir, "*.dll").OrderBy(x => x)) U.Load(f);
        var extras = args.Skip(2).ToList();
        foreach (var e in extras) U.Load(e);
        A = new Analyzer(U);
        A.FindFeatureSwitches();
        Console.Error.WriteLine($"loaded {U.Asms.Count} assemblies");

        W($"# bclscan report: {args[0]}");
        W();
        W($"{U.Asms.Count} assemblies loaded. Scenarios: **Raw** = importer with gameplayc's current byref model (locals/args/fields/statics/array elements, ref returns), no folding; " +
          "**Fold** = + `IsSupported`/`IsHardwareAccelerated` = false, `GlobalizationMode.Invariant` = true, dynamic code/EventSource off, dead IL pruned per method; " +
          "**FoldC** = Fold + element-stepping byref arithmetic (Unsafe.Add/Subtract/AreSame/ByteOffset on refs), `stackalloc` directly wrapped in a Span (-> fresh array), representation-preserving Unsafe.As/BitCast, " +
          "Unsafe.As<T>(object)/NullRef/SkipInit/SizeOf, ref fields, `string._firstChar`/GetRawStringData, MemoryMarshal.GetArrayDataReference/GetReference/CreateSpan, " +
          "RVA-backed `ReadOnlySpan<byte>` literals, IsReferenceOrContainsReferences/IsBitwiseEquatable/InitializeArray/CreateSpan, and single-threaded Interlocked/Volatile/Monitor/Lock/volatile. as compiler intrinsics.");
        W();

        var core = new List<MethodKey>();
        var groupEntries = new Dictionary<string, List<MethodKey>>();
        W("## Entry points");
        W();
        W("| group | tier | types found | public entry methods | excluded (pointer signature) |");
        W("|---|---|---|---|---|");
        foreach (var (g, tier, types) in Groups)
        {
            var list = new List<MethodKey>(); int found = 0, excl = 0;
            foreach (var tn in types)
            {
                var t = U.FindAnywhere(tn);
                if (t is null) { Console.Error.WriteLine($"missing type {tn}"); continue; }
                found++;
                var r = U.Asms[t.Value.Asm].R;
                foreach (var mh in r.GetTypeDefinition(t.Value.H).GetMethods())
                {
                    var md = r.GetMethodDefinition(mh);
                    var acc = md.Attributes & MethodAttributes.MemberAccessMask;
                    if (acc is not (MethodAttributes.Public or MethodAttributes.Family or MethodAttributes.FamORAssem)) continue;
                    var mk = new MethodKey(t.Value.Asm, mh);
                    var s = A.Scan(mk);
                    if (s.SigPtr || s.SigFn) { excl++; continue; }
                    list.Add(mk);
                }
            }
            groupEntries[g] = list;
            if (tier == "core") core.AddRange(list);
            W($"| {g} | {tier} | {found}/{types.Length} | {list.Count} | {excl} |");
        }
        W();

        var why = Environment.GetEnvironmentVariable("BCLSCAN_WHY");
        if (!string.IsNullOrEmpty(why))
        {
            // BCLSCAN_WHY="Group|substring;substring;..."
            var parts = why.Split('|');
            TP = TypeProxySet();
            var r = A.Closure(groupEntries[parts[0]], Scen.FoldC, parts.Length > 2 ? TP : null);
            var tr = new StringBuilder();
            tr.AppendLine($"{parts[0]}: {r.Reached.Count} reached");
            foreach (var target in parts[1].Split(';'))
            {
                var goal = r.Order.FirstOrDefault(m => U.Display(m).Contains(target));
                if (goal == default) { tr.AppendLine($"{target}: not reached"); continue; }
                var prev = new Dictionary<MethodKey, MethodKey?>();
                var bq = new Queue<MethodKey>();
                foreach (var e in r.Entries) { prev[e] = null; bq.Enqueue(e); }
                while (bq.Count > 0)
                {
                    var m = bq.Dequeue();
                    if (m == goal) break;
                    foreach (var n in r.Out.GetValueOrDefault(m) ?? []) if (!prev.ContainsKey(n)) { prev[n] = m; bq.Enqueue(n); }
                }
                var chain = new List<string>();
                for (MethodKey? c = goal; c is { } cc; c = prev.GetValueOrDefault(cc)) chain.Add(U.Display(cc) + (r.InDirect.GetValueOrDefault(cc)?.Contains(prev.GetValueOrDefault(cc) ?? default) == true ? "" : " [dispatch/cctor]"));
                chain.Reverse();
                tr.AppendLine($"{target}:\n    " + string.Join("\n -> ", chain));
            }
            foreach (var t in r.Instantiated.Where(t => U.Namespace(t).StartsWith("System.Reflection") || U.TypeName(t) == "System.RuntimeType").Take(15))
                tr.AppendLine($"  inst {U.TypeName(t)} by {(r.InstBy.TryGetValue(t, out var by) ? U.Display(by) : "?")}");
            // largest dominator-free fan: count of reached bodies per namespace
            foreach (var g in r.Order.GroupBy(m => U.Namespace(U.DeclType(m))).OrderByDescending(g => g.Count()).Take(25)) tr.AppendLine($"  ns {g.Key}: {g.Count()}");
            Console.Error.WriteLine(tr.ToString());
            return 0;
        }

        var coreRes = new Dictionary<Scen, Analyzer.Result>();
        foreach (Scen sc in Enum.GetValues<Scen>()) coreRes[sc] = A.Closure(core, sc);

        Summary("Core tier (union of all core groups)", coreRes);
        TagTable(coreRes);
        PerAssembly(coreRes[Scen.FoldC]);
        Externs(coreRes[Scen.Fold]);
        Primitives(coreRes[Scen.Fold]);
        Layout(coreRes[Scen.Fold]);
        TopBlocked(coreRes[Scen.FoldC], 60);
        TopBlockedTypes(coreRes[Scen.FoldC], 40);
        Proxies(coreRes[Scen.FoldC], [20, 50, 100, 200, 400]);
        Proxies(coreRes[Scen.Fold], [20, 50, 100, 200, 400]);

        TP = TypeProxySet();
        var tp = A.Closure(core, Scen.FoldC, TP);
        W("## FoldC + JSIL-style type proxies");
        W();
        W("Whole types replaced by hand-written proxies (their methods become leaves): " + string.Join(", ", TypeProxyNames.Select(x => $"`{x}`")) + ".");
        W();
        TPSummary("core", tp);
        TopBlocked(tp, 40);
        TopBlockedTypes(tp, 30);
        Proxies(tp, [20, 50, 100, 200, 400]);
        PerGroup(groupEntries);
        foreach (var g in new[] { "Guid", "Numerics vectors", "Task/async", "String/Char/StringBuilder", "Primitive parse/format", "LINQ", "Collections" })
            GroupDetail(g, groupEntries[g]);
        CoreFoldC = coreRes[Scen.FoldC];
        AsyncScan(extras);
        W("## Feature switches found ([FeatureSwitchDefinition] getters) and the values Fold uses");
        W();
        W("| switch | getter | folded value |");
        W("|---|---|---|");
        foreach (var (g, sw) in A.SwitchGetters.OrderBy(x => x.Value))
            W($"| {sw} | `{U.Display(g)}` | {(Analyzer.SwitchValues.TryGetValue(sw, out var v) ? v.ToString() : "(not folded)")} |");
        W();
        W();
        W($"Unresolved member references during the scan: {U.UnresolvedMethods}.");
        File.WriteAllText(args[1], Out.ToString());
        Console.Error.WriteLine($"wrote {args[1]}");
        return 0;
    }

    // ------------------------------------------------------------ helpers

    static IEnumerable<MethodKey> Bodies(Analyzer.Result r) => r.Order.Where(m => !r.Leaves.Contains(m) && A.Scan(m).HasBody);
    static bool Blocked(Analyzer.Result r, MethodKey m) => A.Classify(m, r.Scen).Block.Count > 0;
    static bool NeedsProxy(MethodKey m) { var e = A.Scan(m).Extern; return e is ExternKind.FCall or ExternKind.QCall or ExternKind.PInvoke; }
    static string Pct(long a, long b) => b == 0 ? "-" : $"{100.0 * a / b:F1}%";

    static (int bodies, int blocked, long il, long ilBlocked, int externs, int unsafeLeaves) Stats(Analyzer.Result r)
    {
        int bodies = 0, blocked = 0, ext = 0, uns = 0; long il = 0, ilb = 0;
        foreach (var m in r.Order)
        {
            if (r.Leaves.Contains(m)) { if (NeedsProxy(m)) ext++; else if (A.IsUnsafe(m)) uns++; continue; }
            var s = A.Scan(m);
            if (!s.HasBody) continue;
            bodies++; il += s.ILSize;
            if (Blocked(r, m)) { blocked++; ilb += s.ILSize; }
        }
        return (bodies, blocked, il, ilb, ext, uns);
    }

    static void Summary(string title, Dictionary<Scen, Analyzer.Result> res)
    {
        W($"## {title}");
        W();
        W("| scenario | reachable methods | IL bodies | IL bytes | safe bodies | safe % | safe IL % | blocked bodies | extern leaves (FCall/QCall/P/Invoke) | Unsafe.* leaves | instantiated types |");
        W("|---|---|---|---|---|---|---|---|---|---|---|");
        foreach (var (sc, r) in res)
        {
            var s = Stats(r);
            W($"| {sc} | {r.Reached.Count} | {s.bodies} | {s.il} | {s.bodies - s.blocked} | {Pct(s.bodies - s.blocked, s.bodies)} | {Pct(s.il - s.ilBlocked, s.il)} | {s.blocked} | {s.externs} | {s.unsafeLeaves} | {r.Instantiated.Count} |");
        }
        W();
    }

    static void TagTable(Dictionary<Scen, Analyzer.Result> res)
    {
        W("### Blocker tags (a body can carry several)");
        W();
        var tags = new SortedSet<string>();
        var counts = new Dictionary<(Scen, string), (int n, long il, int only)>();
        foreach (var (sc, r) in res)
            foreach (var m in Bodies(r))
            {
                var c = A.Classify(m, sc);
                foreach (var t in c.Block)
                {
                    tags.Add(t);
                    counts.TryGetValue((sc, t), out var v);
                    counts[(sc, t)] = (v.n + 1, v.il + A.Scan(m).ILSize, v.only + (c.Block.Count == 1 ? 1 : 0));
                }
            }
        W("| tag | " + string.Join(" | ", res.Keys.Select(k => $"{k} bodies (IL bytes) [sole blocker]")) + " |");
        W("|---|" + string.Join("", res.Keys.Select(_ => "---|")));
        foreach (var t in tags.OrderByDescending(t => counts.GetValueOrDefault((Scen.Raw, t)).n))
            W($"| {t} | " + string.Join(" | ", res.Keys.Select(k => { var v = counts.GetValueOrDefault((k, t)); return $"{v.n} ({v.il}) [{v.only}]"; })) + " |");
        W();
        W("Info (non-blocking) tags in FoldC: " + string.Join(", ", Bodies(res[Scen.FoldC]).SelectMany(m => A.Classify(m, Scen.FoldC).Info).GroupBy(x => x).Select(g => $"{g.Key}={g.Count()}")));
        W();
    }

    static void PerAssembly(Analyzer.Result r)
    {
        W($"### Per assembly ({r.Scen})");
        W();
        W("| assembly | bodies | IL bytes | blocked | safe % | externs |");
        W("|---|---|---|---|---|---|");
        foreach (var g in r.Order.GroupBy(m => U.Asms[m.Asm].Name).OrderByDescending(g => g.Count()))
        {
            int b = 0, bl = 0, ex = 0; long il = 0;
            foreach (var m in g)
            {
                if (r.Leaves.Contains(m)) { if (NeedsProxy(m)) ex++; continue; }
                var s = A.Scan(m); if (!s.HasBody) continue;
                b++; il += s.ILSize; if (Blocked(r, m)) bl++;
            }
            W($"| {g.Key} | {b} | {il} | {bl} | {Pct(b - bl, b)} | {ex} |");
        }
        W();
    }

    static void Externs(Analyzer.Result r)
    {
        W($"### Extern leaves reached ({r.Scen}): each needs a hand-written proxy");
        W();
        var ext = r.Order.Where(m => NeedsProxy(m)).ToList();
        W("| kind | count |");
        W("|---|---|");
        foreach (var g in ext.GroupBy(m => A.Scan(m).Extern == ExternKind.PInvoke ? "P/Invoke " + A.Scan(m).Module : A.Scan(m).Extern.ToString()).OrderByDescending(g => g.Count()))
            W($"| {g.Key} | {g.Count()} |");
        W();
        W("Top externs by fan-in (distinct reachable callers):");
        W();
        W("| extern | kind | callers |");
        W("|---|---|---|");
        foreach (var m in ext.OrderByDescending(m => r.In.GetValueOrDefault(m)?.Count ?? 0).Take(40))
            W($"| `{U.Display(m)}` | {A.Scan(m).Extern} | {r.In.GetValueOrDefault(m)?.Count ?? 0} |");
        W();
        W("<details><summary>All reached externs</summary>");
        W();
        foreach (var m in ext.OrderBy(m => U.Display(m))) W($"- `{U.Display(m)}` ({A.Scan(m).Extern}{(A.Scan(m).Module.Length > 0 ? " " + A.Scan(m).Module : "")})");
        W();
        W("</details>");
        W();
    }

    static void Primitives(Analyzer.Result r)
    {
        W($"### Unsafe.* and layout primitives by fan-in ({r.Scen})");
        W();
        W("| primitive | distinct callers | FoldC-supported? |");
        W("|---|---|---|");
        var rows = new Dictionary<string, (HashSet<MethodKey> callers, HashSet<bool> ok)>();
        foreach (var m in Bodies(r))
            foreach (var cs in A.Scan(m).Calls)
            {
                if (!A.Scan(m).LiveFold[cs.Idx] || cs.Target is not { } t) continue;
                string key; bool ok;
                if (A.IsUnsafe(t)) { var (tag, o) = A.UnsafeKind(t, cs.Inst); key = $"Unsafe.{U.MethodName(t)} [{tag}]"; ok = o; }
                else
                {
                    var tn = U.TypeName(U.DeclType(t));
                    if (!(tn.EndsWith("MemoryMarshal") || tn == "System.Buffer" || tn.EndsWith("RuntimeHelpers") || tn == "System.SpanHelpers" || tn.StartsWith("System.Numerics.BitOperations"))) continue;
                    key = tn.Split('.').Last() + "." + U.MethodName(t); ok = A.IsCIntrinsic(t);
                }
                if (!rows.TryGetValue(key, out var v)) rows[key] = v = (new(), new());
                v.callers.Add(m); v.ok.Add(ok);
            }
        foreach (var (k, v) in rows.OrderByDescending(x => x.Value.callers.Count).Take(60))
            W($"| {k} | {v.callers.Count} | {string.Join("/", v.ok.Select(o => o ? "yes" : "no"))} |");
        W();
    }

    static void Layout(Analyzer.Result r)
    {
        W($"### CoreCLR object-layout dependence ({r.Scen})");
        W();
        var probes = new (string label, Func<MethodKey, MScan, bool> pred)[]
        {
            ("ldfld/ldflda String._firstChar", (m, s) => s.Fields.Any(f => s.LiveFold[f.idx] && f.name == "_firstChar")),
            ("String.GetRawStringData / GetPinnableReference", (m, s) => Calls(s, "System.String", "GetRawStringData", "GetPinnableReference")),
            ("String.FastAllocateString (FCall)", (m, s) => Calls(s, "System.String", "FastAllocateString")),
            ("MemoryMarshal.GetArrayDataReference", (m, s) => Calls(s, "System.Runtime.InteropServices.MemoryMarshal", "GetArrayDataReference")),
            ("MemoryMarshal.GetReference", (m, s) => Calls(s, "System.Runtime.InteropServices.MemoryMarshal", "GetReference")),
            ("MemoryMarshal.Cast / AsBytes", (m, s) => Calls(s, "System.Runtime.InteropServices.MemoryMarshal", "Cast", "AsBytes")),
            ("GC.AllocateUninitializedArray / AllocateArray", (m, s) => Calls(s, "System.GC", "AllocateUninitializedArray", "AllocateArray")),
            ("RuntimeHelpers.GetMethodTable / MethodTable*", (m, s) => Calls(s, "System.Runtime.CompilerServices.RuntimeHelpers", "GetMethodTable") || s.Fields.Any(f => f.decl is { } d && U.TypeName(d) == "System.Runtime.CompilerServices.MethodTable")),
            ("RawData / RawArrayData / GetRawData", (m, s) => Calls(s, "System.Runtime.CompilerServices.RuntimeHelpers", "GetRawData") || s.Fields.Any(f => f.decl is { } d && U.TypeName(d) is "System.Runtime.CompilerServices.RawData" or "System.Runtime.CompilerServices.RawArrayData")),
            ("Buffer.Memmove (any overload)", (m, s) => Calls(s, "System.Buffer", "Memmove", "BulkMoveWithWriteBarrier")),
            ("SpanHelpers.* (any)", (m, s) => s.Calls.Any(c => s.LiveFold[c.Idx] && c.Target is { } t && U.TypeName(U.DeclType(t)).StartsWith("System.SpanHelpers"))),
            ("Span/ReadOnlySpan ctor(ref T, int) or (void*, int)", (m, s) => s.Calls.Any(c => s.LiveFold[c.Idx] && c.Op == Op.NewObj && c.Target is { } t && U.TypeName(U.DeclType(t)) is "System.Span`1" or "System.ReadOnlySpan`1" && A.Scan(t).M is var mk && U.MethodSigString(mk).Contains('&') || (c.Target is { } t2 && c.Op == Op.NewObj && A.Scan(t2).SigPtr))),
            ("RuntimeHelpers.IsReferenceOrContainsReferences<T>", (m, s) => Calls(s, "System.Runtime.CompilerServices.RuntimeHelpers", "IsReferenceOrContainsReferences")),
            ("typeof(T) == typeof(X) pattern (Type.op_Equality)", (m, s) => Calls(s, "System.Type", "op_Equality")),
        };
        W("| usage | reachable methods using it | of which declared in System.Private.CoreLib |");
        W("|---|---|---|");
        foreach (var (label, pred) in probes)
        {
            var ms = Bodies(r).Where(m => pred(m, A.Scan(m))).ToList();
            W($"| {label} | {ms.Count} | {ms.Count(m => U.Asms[m.Asm].Name == "System.Private.CoreLib")} |");
        }
        W();
    }
    static bool Calls(MScan s, string type, params string[] names)
        => s.Calls.Any(c => s.LiveFold[c.Idx] && c.Target is { } t && U.TypeName(U.DeclType(t)) == type && names.Contains(U.MethodName(t)));

    static void TopBlocked(Analyzer.Result r, int n)
    {
        W($"### Top blocked methods by direct fan-in ({r.Scen}; callers naming the method in a call/newobj/ldftn, virtual dispatch excluded)");
        W();
        W("| method | direct callers | all callers incl. dispatch | IL | blockers |");
        W("|---|---|---|---|---|");
        foreach (var m in Bodies(r).Where(m => Blocked(r, m)).OrderByDescending(m => r.InDirect.GetValueOrDefault(m)?.Count ?? 0).Take(n))
            W($"| `{U.Display(m)}` | {r.InDirect.GetValueOrDefault(m)?.Count ?? 0} | {r.In.GetValueOrDefault(m)?.Count ?? 0} | {A.Scan(m).ILSize} | {string.Join(",", A.Classify(m, r.Scen).Block.OrderBy(x => x))} |");
        W();
    }

    static void TopBlockedTypes(Analyzer.Result r, int n)
    {
        W($"### Blocked bodies per declaring type ({r.Scen})");
        W();
        W("| type | reachable bodies | blocked | blocked IL bytes |");
        W("|---|---|---|---|");
        foreach (var g in Bodies(r).GroupBy(m => U.TypeName(U.DeclType(m))).Select(g => (g.Key, all: g.Count(), bl: g.Where(m => Blocked(r, m)).ToList())).OrderByDescending(x => x.bl.Count).Take(n))
            W($"| {g.Key} | {g.all} | {g.bl.Count} | {g.bl.Sum(m => (long)A.Scan(m).ILSize)} |");
        W();
    }

    // ------------------------------------------------------------ proxies via dominator tree

    static void Proxies(Analyzer.Result r, int[] ks)
    {
        // Graph: node 0 = root -> entries; edges from r.Out.
        var nodes = r.Order.ToList();
        var idx = new Dictionary<MethodKey, int>();
        for (int i = 0; i < nodes.Count; i++) idx[nodes[i]] = i + 1;
        int N = nodes.Count + 1;
        var succ = new List<int>[N]; var pred = new List<int>[N];
        for (int i = 0; i < N; i++) { succ[i] = new(); pred[i] = new(); }
        foreach (var e in r.Entries) { succ[0].Add(idx[e]); pred[idx[e]].Add(0); }
        foreach (var (f, tos) in r.Out)
            foreach (var t in tos)
                if (idx.TryGetValue(f, out var a) && idx.TryGetValue(t, out var b)) { succ[a].Add(b); pred[b].Add(a); }
        // Nodes reached only via cctor/finalizer edges without a recorded from are rooted too.
        for (int i = 1; i < N; i++) if (pred[i].Count == 0) { succ[0].Add(i); pred[i].Add(0); }
        // RPO
        var rpo = new List<int>(); var seen = new bool[N];
        var st = new Stack<(int, int)>(); st.Push((0, 0)); seen[0] = true;
        var post = new List<int>();
        while (st.Count > 0)
        {
            var (v, k) = st.Pop();
            if (k < succ[v].Count) { st.Push((v, k + 1)); int w = succ[v][k]; if (!seen[w]) { seen[w] = true; st.Push((w, 0)); } }
            else post.Add(v);
        }
        post.Reverse(); rpo = post;
        var order = new int[N]; for (int i = 0; i < rpo.Count; i++) order[rpo[i]] = i;
        var idom = Enumerable.Repeat(-1, N).ToArray(); idom[0] = 0;
        bool changed = true;
        while (changed)
        {
            changed = false;
            foreach (var v in rpo)
            {
                if (v == 0) continue;
                int nd = -1;
                foreach (var p in pred[v])
                {
                    if (idom[p] == -1) continue;
                    if (nd == -1) { nd = p; continue; }
                    int a = p, b = nd;
                    while (a != b) { while (order[a] > order[b]) a = idom[a]; while (order[b] > order[a]) b = idom[b]; }
                    nd = a;
                }
                if (nd != -1 && idom[v] != nd) { idom[v] = nd; changed = true; }
            }
        }
        var bad = new int[N]; var badIl = new long[N];
        var isBody = new bool[N];
        for (int i = 1; i < N; i++)
        {
            var m = nodes[i - 1];
            if (r.Leaves.Contains(m)) { if (NeedsProxy(m)) bad[i] = 1; continue; }
            var s = A.Scan(m);
            if (!s.HasBody) continue;
            isBody[i] = true;
            if (Blocked(r, m)) { bad[i] = 1; badIl[i] = s.ILSize; }
        }
        var children = new List<int>[N]; for (int i = 0; i < N; i++) children[i] = new();
        for (int i = 1; i < N; i++) if (idom[i] >= 0) children[idom[i]].Add(i);
        var removed = new bool[N];
        int totalBad = bad.Sum();
        int totalBlockedBodies = Enumerable.Range(1, N - 1).Count(i => isBody[i] && bad[i] == 1);
        int totalExt = totalBad - totalBlockedBodies;
        var picks = new List<(int node, int gain)>();
        int maxK = ks.Max();
        var sub = new int[N];
        for (int step = 0; step < maxK; step++)
        {
            // subtree sums in reverse RPO (children after parents in RPO for dom tree)
            Array.Clear(sub);
            for (int j = rpo.Count - 1; j >= 0; j--)
            {
                int v = rpo[j];
                if (removed[v]) continue;
                sub[v] += bad[v];
                if (v != 0 && idom[v] >= 0 && !removed[idom[v]]) sub[idom[v]] += sub[v];
            }
            int best = -1;
            for (int v = 1; v < N; v++) if (!removed[v] && isBody[v] && (best == -1 || sub[v] > sub[best])) best = v;
            if (best == -1 || sub[best] == 0) break;
            picks.Add((best, sub[best]));
            var stack = new Stack<int>(); stack.Push(best);
            while (stack.Count > 0) { var v = stack.Pop(); if (removed[v]) continue; removed[v] = true; foreach (var c in children[v]) stack.Push(c); }
        }
        var stats = Stats(r);
        W($"### Greedy proxy set ({r.Scen}; dominator-tree cut, each proxy replaces a method body and everything only it reaches)");
        W();
        W($"Baseline: {stats.bodies} bodies, {totalBlockedBodies} blocked, {totalExt} extern leaves (total 'bad' = {totalBad}).");
        W();
        W("| K proxies | blocked bodies + externs removed | remaining blocked bodies | remaining externs | remaining bodies | safe % of remaining |");
        W("|---|---|---|---|---|---|");
        foreach (var k in ks)
        {
            var take = picks.Take(k).ToList();
            var rem = new bool[N];
            foreach (var (node, _) in take)
            {
                var stack = new Stack<int>(); stack.Push(node);
                while (stack.Count > 0) { var v = stack.Pop(); if (rem[v]) continue; rem[v] = true; foreach (var c in children[v]) stack.Push(c); }
            }
            int remBlocked = 0, remExt = 0, remBodies = 0;
            for (int i = 1; i < N; i++)
            {
                if (rem[i]) continue;
                if (isBody[i]) { remBodies++; if (bad[i] == 1) remBlocked++; }
                else if (bad[i] == 1) remExt++;
            }
            W($"| {k} (picked {take.Count}) | {take.Sum(x => x.gain)} | {remBlocked} | {remExt} | {remBodies} | {Pct(remBodies - remBlocked, remBodies)} |");
        }
        W();
        W("<details><summary>First 100 picks</summary>");
        W();
        W("| # | method | gain (bad nodes under it) | dominated nodes |");
        W("|---|---|---|---|");
        int n = 0;
        foreach (var (node, gain) in picks.Take(100))
        {
            int size = 0; var stack = new Stack<int>(); stack.Push(node);
            while (stack.Count > 0) { var v = stack.Pop(); size++; foreach (var c in children[v]) stack.Push(c); }
            W($"| {++n} | `{U.Display(nodes[node - 1])}` | {gain} | {size} |");
        }
        W();
        W("</details>");
        W();
    }

    // ------------------------------------------------------------ per group

    static HashSet<MethodKey> TP;
    static readonly string[] TypeProxyNames =
    [
        "System.Reflection.*", "System.Runtime.Intrinsics.*", "System.Diagnostics.Tracing.*", "Interop*",
        "System.RuntimeType", "System.RuntimeTypeHandle", "System.RuntimeMethodHandle", "System.RuntimeFieldHandle", "System.Type",
        "System.Object", "System.ValueType", "System.Enum", "System.Array", "System.Buffer", "System.SpanHelpers",
        "System.Span`1", "System.ReadOnlySpan`1", "System.Runtime.InteropServices.MemoryMarshal", "System.Runtime.InteropServices.Marshal",
        "System.Runtime.CompilerServices.RuntimeHelpers", "System.Runtime.CompilerServices.CastHelpers",
        "System.Runtime.CompilerServices.MethodTable", "System.Runtime.CompilerServices.TypeHandle",
        "System.GC", "System.Runtime.InteropServices.GCHandle", "System.WeakReference", "System.WeakReference`1", "System.Runtime.DependentHandle",
        "System.Runtime.CompilerServices.ConditionalWeakTable`2",
        "System.Threading.Thread", "System.Threading.ThreadPool", "System.Threading.PortableThreadPool", "System.Threading.Monitor",
        "System.Threading.WaitHandle", "System.Threading.TimerQueue", "System.Threading.TimerQueueTimer", "System.Threading.LowLevelLock",
        "System.Threading.LowLevelMonitor", "System.Threading.LowLevelLifoSemaphore", "System.Threading.WaitSubsystem",
        "System.Diagnostics.StackTrace", "System.Diagnostics.StackFrame", "System.Diagnostics.StackFrameHelper",
        "System.Numerics.Vector`1", "System.Numerics.Vector", "System.Delegate", "System.MulticastDelegate", "System.Activator",
        "System.Runtime.InteropServices.SafeHandle", "System.Environment", "System.AppContext",
    ];
    static HashSet<MethodKey> TypeProxySet()
    {
        var set = new HashSet<MethodKey>();
        foreach (var a in U.Asms)
            foreach (var th in a.R.TypeDefinitions)
            {
                var fn = Universe.FullName(a.R, th);
                bool hit = TypeProxyNames.Any(p => p.EndsWith("*") ? fn.StartsWith(p[..^1]) : fn == p || fn.StartsWith(p + "/"));
                if (hit) foreach (var mh in a.R.GetTypeDefinition(th).GetMethods()) set.Add(new MethodKey(a.Index, mh));
            }
        return set;
    }
    static void TPSummary(string label, Analyzer.Result r)
    {
        var st = Stats(r);
        int prox = r.Order.Count(m => TP.Contains(m));
        int proxBodies = r.Order.Count(m => TP.Contains(m) && A.Scan(m).HasBody);
        W("| closure | reachable methods | imported IL bodies | IL bytes | safe | safe % | blocked | proxied methods reached (with IL body / extern) | other extern leaves |");
        W("|---|---|---|---|---|---|---|---|---|");
        W($"| {label} | {r.Reached.Count} | {st.bodies} | {st.il} | {st.bodies - st.blocked} | {Pct(st.bodies - st.blocked, st.bodies)} | {st.blocked} | {prox} ({proxBodies} / {prox - proxBodies}) | {r.Order.Count(m => NeedsProxy(m) && !TP.Contains(m))} |");
        W();
        W("Proxied methods reached, by type (top 25): " + string.Join(", ", r.Order.Where(m => TP.Contains(m)).GroupBy(m => U.TypeName(U.DeclType(m))).OrderByDescending(g => g.Count()).Take(25).Select(g => $"{g.Key} {g.Count()}")));
        W();
    }

    static void PerGroup(Dictionary<string, List<MethodKey>> groups)
    {
        W("## Per allowlisted API group (each closure computed separately)");
        W();
        W("| group | entries | reachable bodies (FoldC) | IL bytes | safe Raw | safe Fold | safe FoldC | externs | top FoldC blockers | FoldC+TP: bodies, safe, proxied methods reached, other externs | top FoldC+TP blockers |");
        W("|---|---|---|---|---|---|---|---|---|---|---|");
        foreach (var (g, entries) in groups)
        {
            var rs = Enum.GetValues<Scen>().ToDictionary(s => s, s => A.Closure(entries, s));
            var st = rs.ToDictionary(kv => kv.Key, kv => Stats(kv.Value));
            var fc = rs[Scen.FoldC];
            var tags = Bodies(fc).SelectMany(m => A.Classify(m, Scen.FoldC).Block).GroupBy(x => x).OrderByDescending(x => x.Count()).Take(5).Select(x => $"{x.Key} {x.Count()}");
            string S(Scen s) => $"{st[s].bodies - st[s].blocked}/{st[s].bodies} ({Pct(st[s].bodies - st[s].blocked, st[s].bodies)})";
            var tp = A.Closure(entries, Scen.FoldC, TP); var tps = Stats(tp);
            var tptags = Bodies(tp).SelectMany(m => A.Classify(m, Scen.FoldC).Block).GroupBy(x => x).OrderByDescending(x => x.Count()).Take(4).Select(x => $"{x.Key} {x.Count()}");
            W($"| {g} | {entries.Count} | {st[Scen.FoldC].bodies} | {st[Scen.FoldC].il} | {S(Scen.Raw)} | {S(Scen.Fold)} | {S(Scen.FoldC)} | {st[Scen.FoldC].externs} | {string.Join(", ", tags)} | {tps.bodies}, {Pct(tps.bodies - tps.blocked, tps.bodies)}, {tp.Order.Count(m => TP.Contains(m))}, {tp.Order.Count(m => NeedsProxy(m) && !TP.Contains(m))} | {string.Join(", ", tptags)} |");
        }
        W();
    }

    static void GroupDetail(string g, List<MethodKey> entries)
    {
        var r = A.Closure(entries, Scen.FoldC, TP);
        W($"### Detail: {g} (FoldC + type proxies)");
        W();
        var ext = r.Order.Where(m => NeedsProxy(m) || TP.Contains(m)).Select(U.Display).OrderBy(x => x).ToList();
        W($"Proxied + extern leaves reached ({ext.Count}): " + string.Join(", ", ext.Take(60).Select(x => $"`{x}`")) + (ext.Count > 60 ? ", ..." : ""));
        W();
        W("| blocked method | blockers |");
        W("|---|---|");
        foreach (var m in Bodies(r).Where(m => Blocked(r, m)).OrderByDescending(m => r.In.GetValueOrDefault(m)?.Count ?? 0).Take(25))
            W($"| `{U.Display(m)}` | {string.Join(",", A.Classify(m, Scen.FoldC).Block.OrderBy(x => x))} |");
        W();
        W("Per-assembly reach: " + string.Join(", ", Bodies(r).GroupBy(m => U.Asms[m.Asm].Name).OrderByDescending(x => x.Count()).Select(x => $"{x.Key} {x.Count()}")));
        W();
    }

    // ------------------------------------------------------------ runtime async

    static Analyzer.Result CoreFoldC;
    static void AsyncScan(List<string> extras)
    {
        W("## Runtime async (MethodImplAttributes.Async) scan");
        W();
        // Discover the flag value from the framework's own enum.
        int asyncFlag = 0;
        foreach (var en in new[] { "System.Reflection.MethodImplAttributes", "System.Runtime.CompilerServices.MethodImplOptions" })
        {
            var t = U.FindAnywhere(en);
            if (t is null) continue;
            var r = U.Asms[t.Value.Asm].R;
            var vals = new List<string>();
            foreach (var fh in r.GetTypeDefinition(t.Value.H).GetFields())
            {
                var f = r.GetFieldDefinition(fh);
                if (f.GetDefaultValue().IsNil) continue;
                var c = r.GetConstant(f.GetDefaultValue());
                var br = r.GetBlobReader(c.Value);
                int v = c.TypeCode switch { ConstantTypeCode.Int16 => br.ReadInt16(), ConstantTypeCode.Int32 => br.ReadInt32(), _ => 0 };
                var name = r.GetString(f.Name);
                vals.Add($"{name}=0x{v:X}");
                if (name == "Async") asyncFlag = v;
            }
            W($"- `{en}`: {string.Join(", ", vals)}");
        }
        W();
        if (asyncFlag == 0) { W("No `Async` member found in MethodImplAttributes/MethodImplOptions."); return; }
        W($"| assembly | methods with Async impl flag (0x{asyncFlag:X}) | IAsyncStateMachine types | example async-flagged methods |");
        W("|---|---|---|---|");
        var asm = U.Asms.Where(a => a.Name is "System.Private.CoreLib" or "System.Linq" or "System.Net.Http" or "System.Text.Json" or "System.Threading.Channels" or "System.IO.Pipelines" || extras.Contains(a.Path)).ToList();
        var total = (flag: 0, sm: 0);
        foreach (var a in U.Asms)
        {
            var r = a.R; int flagged = 0, sm = 0; var ex = new List<string>();
            foreach (var th in r.TypeDefinitions)
            {
                var td = r.GetTypeDefinition(th);
                foreach (var ih in td.GetInterfaceImplementations())
                {
                    var it = U.ResolveTypeHandle(a.Index, r.GetInterfaceImplementation(ih).Interface);
                    if (it is { } k && U.TypeName(k) == "System.Runtime.CompilerServices.IAsyncStateMachine") sm++;
                }
                foreach (var mh in td.GetMethods())
                {
                    var md = r.GetMethodDefinition(mh);
                    if (((int)md.ImplAttributes & asyncFlag) != 0) { flagged++; if (ex.Count < 3) ex.Add(U.Display(new MethodKey(a.Index, mh))); }
                }
            }
            total.flag += flagged; total.sm += sm;
            if (asm.Contains(a) || flagged > 0)
                W($"| {a.Name} | {flagged} | {sm} | {string.Join("; ", ex.Select(x => $"`{x}`"))} |");
        }
        W($"| **all {U.Asms.Count} assemblies** | {total.flag} | {total.sm} | |");
        W();
        foreach (var a in U.Asms.Where(a => extras.Contains(a.Path)))
            foreach (var th in a.R.TypeDefinitions)
                foreach (var mh in a.R.GetTypeDefinition(th).GetMethods())
                {
                    var mk = new MethodKey(a.Index, mh); var sc = A.Scan(mk);
                    if (!sc.HasBody) continue;
                    W($"- `{a.Name}` `{U.Display(mk)}` impl=0x{(int)a.R.GetMethodDefinition(mh).ImplAttributes:X}, IL {sc.ILSize} bytes, calls: " + string.Join(", ", sc.Calls.Where(c => c.Target is not null).Select(c => U.Display(c.Target.Value)).Distinct()));
                }
        W();
        var reach = CoreFoldC.Order.Where(m => ((int)U.Asms[m.Asm].R.GetMethodDefinition(m.H).ImplAttributes & asyncFlag) != 0).ToList();
        W($"Async-flagged methods reachable from the core closure (FoldC): {reach.Count}: " + string.Join(", ", reach.Take(30).Select(m => $"`{U.Display(m)}`")));
        var helpers = CoreFoldC.Order.Where(m => U.TypeName(U.DeclType(m)) is "System.Runtime.CompilerServices.AsyncHelpers").ToList();
        W();
        W($"System.Runtime.CompilerServices.AsyncHelpers methods reachable: {helpers.Count}: " + string.Join(", ", helpers.Take(30).Select(m => $"`{U.Display(m)}` ({A.Scan(m).Extern}{(A.Scan(m).HasBody ? ", IL " + A.Scan(m).ILSize : "")})")));
        W();
    }
}
