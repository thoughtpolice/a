// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Stylized statements for the language and library features gameplayc
// gained after the generator was written: tuples, nullable value types,
// iterators, LINQ, anonymous types, indices and ranges with list patterns,
// checked arithmetic, goto, number formatting, sorting, seeded Random,
// events and multicast delegates, ref locals and returns, System.Type,
// generic virtual and default interface methods, decimal, multidimensional
// arrays, spans and stackalloc, iterators in structs and local functions
// and with gotos, comparers, the sorted collections, PriorityQueue and
// LinkedList, Cast, OfType, ToLookup, wide anonymous types and `with`,
// Memory<T>, interface events, and decimal's styles, providers and span
// overloads with Convert and enum conversions.
// Each snippet takes its inputs from random expressions and logs what it
// observes into the trace; the declarations some of them need are in the
// prelude.
import { indent, T } from "./gen.mjs";

export const NEW_FEATURES = [
  "tuples",
  "nullable",
  "iterators",
  "linq",
  "anonymous",
  "ranges",
  "checked",
  "goto",
  "formatting",
  "sorting",
  "random",
  "events",
  "reflocals",
  "types",
  "gvm",
  "decimals",
  "mdarrays",
  "spans",
  "iterators2",
  "comparers",
  "sorted",
  "linq2",
  "memory",
  "ifaceevents",
  "convert",
];

// What runs over the gameplay CoreLib and the framework: the framework
// assemblies the compiler imports from the SDK (System.Collections' and
// System.Linq's own IL, where the exact number of selector calls, cheap
// counts and .NET's messages show) and variance, and async methods over the
// CoreLib's task library (each run under a single-threaded
// SynchronizationContext of the snippet's own, so that the CLR runs the
// continuations in the order the module does). And vectors: Vector128 (Wasm
// SIMD) and System.Numerics' vectors, quaternions and matrices over small
// integers, whose products and sums are exact (where the CLR fuses a
// multiply-add and the module rounds twice, as .NET's MultiplyAddEstimate
// allows). And bignum: BigInteger (dotnet/runtime's, in the CoreLib) over
// values built from the program's ints (arithmetic, division and its
// faults, shifts and bitwise operations of negative numbers, powers,
// modular powers, gcd, conversions, text and parsing), and Complex's exact
// arithmetic over small integers.
export const LIBRARY_FEATURES = [
  "framework",
  "variance",
  "async",
  "vectors",
  "bignum",
];

// What the snippets call: iterators (which must be methods of a class),
// a ref-returning helper, an event source, and a small hierarchy with a
// default interface method, generic virtual methods and a covariant
// return.
const CORE = `internal static class Fx
{
    public static IEnumerable<int> Squares(int n, int stop)
    {
        try
        {
            for (int i = 0; i < n; i++)
            {
                if (i == stop)
                {
                    yield break;
                }

                Tr.L(-100 - i);
                yield return i * i + stop;
            }
        }
        finally
        {
            Tr.L(-101);
        }
    }

    public static IEnumerable<int> Evens(IEnumerable<int> source)
    {
        foreach (int v in source)
        {
            if ((v & 1) == 0)
            {
                yield return v;
            }
        }
    }

    public static IEnumerator<char> Letters(string s)
    {
        int i = 0;
        while (i < s.Length)
        {
            if (s[i] != ' ')
            {
                yield return s[i];
            }

            i++;
        }
    }

    public static ref int Pick(int[] a, int i) => ref a[i & 3];

    public static void Bump(ref int v, int by) => v += by;
}

internal sealed class FxBus
{
    public event Action<int> Fired;

    public void Raise(int v) => Fired?.Invoke(v);
}

internal interface IFxShape
{
    int Area();

    int Twice() => Area() * 2;
}

internal abstract class FxBase : IFxShape
{
    public abstract int Area();

    public virtual TV Echo<TV>(TV v)
    {
        Tr.L(1);
        return v;
    }

    public virtual FxBase Self() => this;
}

internal sealed class FxSquare : FxBase
{
    private readonly int side;

    public FxSquare(int side)
    {
        this.side = side;
    }

    public override int Area() => side * side;

    public override TV Echo<TV>(TV v)
    {
        Tr.L(2);
        return base.Echo(v);
    }

    public override FxSquare Self() => this;
}

internal sealed class FxRect : FxBase, IFxShape
{
    private readonly int w;
    private readonly int h;

    public FxRect(int w, int h)
    {
        this.w = w;
        this.h = h;
    }

    public override int Area() => w * h;

    int IFxShape.Twice() => -Area();
}
`;

// decimal's bits, scale included, into the trace, and an enum decimal
// converts to and from.
const DECIMALS = `internal enum FxLevel : short
{
    A = -3,
    B = 400,
}

internal static class FxDec
{
    public static void L(decimal d)
    {
        int[] bits = decimal.GetBits(d);
        Tr.L(bits[0]);
        Tr.L(bits[1]);
        Tr.L(bits[2]);
        Tr.L(bits[3]);
    }
}
`;

// An iterator of a struct, which runs on a copy of it.
const ITERATORS2 = `internal struct FxCounter
{
    public int Start;

    public IEnumerable<int> Up(int n)
    {
        for (int i = 0; i < n; i++)
        {
            Start++;
            if (i == 3)
            {
                goto done;
            }

            yield return Start * 10 + i;
        }

    done:
        Tr.L(-120 - Start);
    }
}
`;

// Interfaces' events: a field-like implementation, one with accessors and
// an explicit one, and a default accessor pair.
const IFACEEVENTS = `internal interface IFxBus
{
    event Action<int> Fired;

    void Raise(int v);
}

internal interface IFxNoted
{
    event Action Noted
    {
        add => Tr.L(-140);
        remove => Tr.L(-141);
    }
}

internal sealed class FxFieldBus : IFxBus, IFxNoted
{
    public event Action<int> Fired;

    public void Raise(int v) => Fired?.Invoke(v);
}

internal sealed class FxAccessorBus : IFxBus
{
    private Action<int> handlers;

    event Action<int> IFxBus.Fired
    {
        add
        {
            Tr.L(-142);
            handlers += value;
        }

        remove
        {
            Tr.L(-143);
            handlers -= value;
        }
    }

    public void Raise(int v) => handlers?.Invoke(v * 3);
}
`;

// A small hierarchy for the variance snippets.
const VARIANCE = `internal class VxBase
{
    public virtual int Id => 1;
}

internal sealed class VxDerived : VxBase
{
    public int V;

    public VxDerived(int v) => V = v;

    public override int Id => 2 + V;
}

internal interface IVxSource<out T>
{
    T Take(int i);
}

internal interface IVxSink<in T>
{
    int Put(T value);
}

internal sealed class VxBoth : IVxSource<VxDerived>, IVxSink<VxBase>
{
    public VxDerived Take(int i) => new VxDerived(i);

    public int Put(VxBase value) => value.Id * 7;
}
`;

// A pump that runs an async snippet: what is posted runs when it drains,
// in order, on the CLR's thread and in the module alike; and async methods
// the snippets await.
const ASYNC =
  `internal sealed class AxPump : System.Threading.SynchronizationContext
{
    private readonly Queue<KeyValuePair<System.Threading.SendOrPostCallback, object>> work = new Queue<KeyValuePair<System.Threading.SendOrPostCallback, object>>();

    public override void Post(System.Threading.SendOrPostCallback d, object state) => work.Enqueue(new KeyValuePair<System.Threading.SendOrPostCallback, object>(d, state));

    public override void Send(System.Threading.SendOrPostCallback d, object state) => d(state);

    public static void Run(Func<System.Threading.Tasks.Task> body)
    {
        var previous = Current;
        var pump = new AxPump();
        SetSynchronizationContext(pump);
        try
        {
            var task = body();
            Tr.L(task.IsCompleted ? 1 : 0);
            while (pump.work.Count > 0)
            {
                var item = pump.work.Dequeue();
                item.Key(item.Value);
            }

            Tr.L((int)task.Status);
            if (task.IsFaulted)
            {
                Tr.S(task.Exception.InnerException.Message);
            }
        }
        finally
        {
            SetSynchronizationContext(previous);
        }
    }
}

internal static class Ax
{
    public static async System.Threading.Tasks.Task<int> Twice(int v)
    {
        Tr.L(v);
        await System.Threading.Tasks.Task.Yield();
        Tr.L(-v);
        return v * 2;
    }

    public static async System.Threading.Tasks.Task<int> Checked(int v)
    {
        await System.Threading.Tasks.Task.Yield();
        if (v > 3)
        {
            throw new InvalidOperationException("ax " + v);
        }

        return v + 1;
    }

    public static async System.Threading.Tasks.ValueTask<int> Maybe(int v)
    {
        if ((v & 1) == 0)
        {
            await System.Threading.Tasks.Task.Yield();
        }

        return v + 3;
    }

    public static async IAsyncEnumerable<int> Range(int n)
    {
        try
        {
            for (int i = 0; i < n; i++)
            {
                await System.Threading.Tasks.Task.Yield();
                Tr.L(-200 - i);
                yield return i * n;
            }
        }
        finally
        {
            Tr.L(-201);
        }
    }

    public static async System.Threading.Tasks.Task<int> Waiting(System.Threading.Tasks.Task<int> task, int add)
    {
        int v = await task;
        Tr.L(v + add);
        return v + add;
    }
}
`;

// The declarations the snippets of the features a program uses need.
export function prelude(has) {
  return [
    CORE,
    has("variance") ? VARIANCE : "",
    has("async") ? ASYNC : "",
    has("decimals") ? DECIMALS : "",
    has("iterators2") ? ITERATORS2 : "",
    has("ifaceevents") ? IFACEEVENTS : "",
    has("convert") && !has("decimals") ? DECIMALS : "",
  ].join("");
}

const block = (lines) => `{\n${indent(lines.join("\n"))}\n}`;

export function featureStatement(g, ctx, depth) {
  const options = [];
  const add = (feature, weight, fn) => {
    if (g.has(feature)) options.push([weight, fn]);
  };
  add("tuples", 2, tuples);
  add("nullable", 2, nullable);
  add("iterators", 2, iterators);
  add("linq", 2, linq);
  add("anonymous", 1, anonymous);
  add("ranges", 2, ranges);
  add("checked", 2, checkedArithmetic);
  add("goto", 1, gotos);
  add("formatting", 2, formatting);
  add("sorting", 2, sorting);
  add("random", 1, random);
  add("events", 1, events);
  add("reflocals", 1, refLocals);
  add("types", 1, types);
  add("gvm", 1, gvm);
  add("decimals", 2, decimals);
  add("mdarrays", 1, mdArrays);
  // stackalloc may not be in a catch or finally block.
  if (!ctx.inCatch && !ctx.inFinally) add("spans", 1, spans);
  add("iterators2", 1, iterators2);
  add("comparers", 1, comparers);
  add("sorted", 1, sorted);
  add("linq2", 1, linq2);
  add("memory", 1, memory);
  add("ifaceevents", 1, ifaceEvents);
  add("convert", 1, convert);
  add("framework", 2, framework);
  add("variance", 1, variance);
  add("async", 1, asyncMethods);
  add("vectors", 2, vectors);
  add("bignum", 2, bignum);
  if (!options.length) return `Tr.L(${g.key()});`;
  ctx.cost += 150 * ctx.weight;
  return g.rng.weighted(options)(g, ctx, depth);
}

const int = (g, ctx) => g.expr(ctx, T.int, 1);
// A small non-negative int.
const small = (g, ctx, mask = 7) => `(${int(g, ctx)} & ${mask})`;
const ints = (g, ctx, n, mask = 255) =>
  Array.from({ length: n }, () => `(${int(g, ctx)} & ${mask})`).join(", ");

function tuples(g, ctx) {
  const t = g.name("tu");
  const u = g.name("tv");
  const p = g.name("tp");
  const q = g.name("tq");
  return block([
    `var ${t} = (A: ${int(g, ctx)}, B: ${int(g, ctx)});`,
    `var ${u} = (${t}.B, ${t}.A);`,
    `(${t}.A, ${t}.B) = (${t}.B + 1, ${t}.A);`,
    `Tr.L(${t}.A * 3 + ${t}.B);`,
    `Tr.L(${t} == ${u} ? 1 : 0);`,
    `Tr.L(${t}.Equals(${u}) ? 1 : 0);`,
    `Tr.S(${t}.ToString());`,
    `var (${p}, ${q}) = ${u};`,
    `Tr.L(${p} - ${q});`,
    `Tr.S((${p}, "s" + ${q}, ${p} > ${q}).ToString());`,
  ]);
}

function nullable(g, ctx) {
  const n = g.name("nn");
  const m = g.name("nm");
  const w = g.name("nw");
  return block([
    `int? ${n} = (${int(g, ctx)} & 1) == 0 ? null : ${int(g, ctx)};`,
    `int? ${m} = ${n} + ${int(g, ctx)};`,
    `Tr.L(${m} ?? -5);`,
    `Tr.L(${n}.HasValue ? 1 : 0);`,
    `Tr.L(${n}.GetValueOrDefault(9));`,
    `Tr.L(${n} > 3 ? 1 : 0);`,
    `Tr.L(${n} == ${m} ? 1 : 0);`,
    `${n} ??= ${int(g, ctx)};`,
    `Tr.L(${n}.Value);`,
    `long? ${w} = ${n};`,
    `Tr.L(${w} ?? 0);`,
    `Tr.L(${m} is int ${g.name("ni")} ? 1 : 0);`,
  ]);
}

function iterators(g, ctx) {
  const rng = g.rng;
  const v = g.name("iv");
  const e = g.name("ie");
  const lines = [
    `foreach (int ${v} in Fx.Squares(${small(g, ctx)}, ${small(g, ctx)}))`,
    block([`Tr.L(${v});`, `if (${v} > ${small(g, ctx, 31)}) break;`]),
  ];
  if (rng.chance(0.5)) {
    lines.push(
      `foreach (int ${v} in Fx.Evens(Fx.Squares(${small(g, ctx)}, 9)))`,
      block([`Tr.L(${v});`]),
    );
  }
  lines.push(
    `var ${e} = Fx.Letters(${g.expr(ctx, T.string, 1)});`,
    `while (${e}.MoveNext()) Tr.L(${e}.Current);`,
    `${e}.Dispose();`,
    `Tr.L(${e}.MoveNext() ? 1 : 0);`,
  );
  return block(lines);
}

function linq(g, ctx) {
  const rng = g.rng;
  const a = g.name("la");
  // In a local: an expression may declare pattern variables, so it is
  // never written twice.
  const c = g.name("lc");
  const lines = [
    `int[] ${a} = { ${ints(g, ctx, rng.range(3, 7))} };`,
    `int ${c} = ${small(g, ctx, 63)};`,
  ];
  // Lambda parameters and range variables of their own, so that no
  // enclosing local (or the foreach variable) shadows them.
  const [v, p, u, x, gr] = ["lv", "lp", "lu", "lx", "lg"].map((n) => g.name(n));
  const queries = [
    `Tr.L(${a}.Where(${v} => ${v} > ${c}).Select(${v} => ${v} * 2).Sum());`,
    `Tr.L(${a}.OrderBy(${v} => ${v} % 3).ThenByDescending(${v} => ${v}).First());`,
    `Tr.L(${a}.Distinct().Count());`,
    `Tr.L(${a}.Any(${v} => ${v} == ${c}) ? 1 : 0);`,
    `Tr.L(${a}.All(${v} => ${v} < 200) ? 1 : 0);`,
    `foreach (var ${gr} in ${a}.GroupBy(${v} => ${v} & 1)) Tr.L(${gr}.Key * 100 + ${gr}.Count());`,
    `Tr.L(${a}.Aggregate(0, (${p}, ${v}) => ${p} * 3 + ${v}));`,
    `Tr.L(${a}.Skip(1).Take(2).Max());`,
    `Tr.L(${a}.Min() + ${a}.Last());`,
    `Tr.LD(${a}.Average());`,
    `foreach (int ${u} in ${a}.OrderByDescending(${v} => ${v} & 7).Reverse()) Tr.L(${u});`,
    `foreach (int ${u} in from ${x} in ${a} where ${x} % 2 == 0 orderby ${x} select ${x} + 1) Tr.L(${u});`,
    `Tr.L(${a}.Zip(${a}.Skip(1), (${p}, ${x}) => ${p} - ${x}).Sum());`,
    `Tr.L(${a}.ToList().IndexOf(${c}));`,
    `Tr.L(${a}.SequenceEqual(${a}.Reverse().Reverse()) ? 1 : 0);`,
    `Tr.L(${a}.FirstOrDefault(${v} => ${v} > ${c}, -1));`,
    `Tr.L(Enumerable.Range(${
      small(g, ctx)
    }, 4).Select(${v} => ${v} * ${v}).Sum());`,
  ];
  for (const query of rng.shuffle(queries).slice(0, rng.range(2, 5))) {
    lines.push(query);
  }
  return block(lines);
}

function anonymous(g, ctx) {
  const o = g.name("ao");
  const p = g.name("ap");
  return block([
    `var ${o} = new { A = ${int(g, ctx)}, B = ${small(g, ctx)} };`,
    `var ${p} = new { A = ${o}.A, B = ${small(g, ctx)} };`,
    `Tr.L(${o}.Equals(${p}) ? 1 : 0);`,
    `Tr.L(${o}.GetHashCode());`,
    `Tr.S(${o}.ToString());`,
    `Tr.L(${o}.A + ${p}.B);`,
    `Tr.S(new { N = ${o}.B, Inner = ${p} }.ToString());`,
  ]);
}

function ranges(g, ctx) {
  const a = g.name("ra");
  const s = g.name("rs");
  const f = g.name("rf");
  // A local, used twice (an expression may declare pattern variables).
  const i = g.name("ri");
  const e = g.name("re");
  return block([
    `int[] ${a} = { ${ints(g, ctx, 5)} };`,
    `int ${i} = ${small(g, ctx, 1)};`,
    `int[] ${s} = ${a}[${i}..^1];`,
    `Tr.L(${s}.Length);`,
    `foreach (int ${e} in ${s}) Tr.L(${e});`,
    `Tr.L(${a}[^1] + ${a}[^${1 + g.rng.int(5)}]);`,
    `Tr.L(${a} is [var ${f}, .., > 100] ? ${f} : -1);`,
    `Tr.L(${a} is [_, _, ..] ? 1 : 0);`,
    `Tr.S("hello, world"[${i}..^${small(g, ctx, 3)}]);`,
    `Tr.L(${a}[..2].Length + ${a}[3..].Length);`,
  ]);
}

function checkedArithmetic(g, ctx) {
  const k = g.key();
  // The operands are unchecked locals: inside checked(...), a constant
  // (sub)expression that overflows is a compile-time error.
  const [a, b, c] = ["ka", "kb", "kc"].map((n) => g.name(n));
  const w = g.name("kw");
  const lines = [
    `int ${a} = ${int(g, ctx)}, ${b} = ${int(g, ctx)}, ${c} = ${int(g, ctx)};`,
    `long ${w} = ${g.expr(ctx, T.long, 1)};`,
  ];
  const ops = [
    `checked(${a} * ${b} + ${c})`,
    `checked((byte)${a})`,
    `checked((int)${w})`,
    `checked(-${b})`,
    `checked((short)(${a} - ${c}))`,
    `checked(${w} * ${w})`,
    `checked((uint)${c} + (uint)${b})`,
  ];
  for (const op of g.rng.shuffle(ops).slice(0, 2)) {
    lines.push(
      "try",
      block([`Tr.L(${op});`]),
      "catch (OverflowException)",
      block([`Tr.L(${k});`]),
    );
  }
  return block(lines);
}

function gotos(g, ctx) {
  const i = g.name("gi");
  const s = g.name("gs");
  const label = g.name("again");
  return block([
    `int ${i} = 0, ${s} = ${int(g, ctx)};`,
    `${label}:`,
    `${s} += ${i} * 3 + 1;`,
    `if (++${i} < 4) goto ${label};`,
    `Tr.L(${s});`,
    `switch (${small(g, ctx, 3)})`,
    block([
      "case 0:",
      `    ${s}++;`,
      "    goto case 2;",
      "case 1:",
      "    goto default;",
      "case 2:",
      `    ${s} *= 3;`,
      "    break;",
      "default:",
      `    ${s} -= 5;`,
      "    break;",
    ]),
    `Tr.L(${s});`,
  ]);
}

function formatting(g, ctx) {
  const rng = g.rng;
  const lines = [];
  const pieces = [
    () => `Tr.S((${g.expr(ctx, T.double, 1)}).ToString());`,
    () => `Tr.S((${g.expr(ctx, T.float, 1)}).ToString());`,
    () =>
      `Tr.S((${int(g, ctx)}).ToString("${
        rng.pick(["X", "x8", "D5", "N0", "0000"])
      }"));`,
    () => `Tr.S((${g.expr(ctx, T.long, 1)}).ToString());`,
    () =>
      `Tr.S((${g.expr(ctx, T.double, 1)}).ToString("${
        rng.pick(["F2", "E3", "G5", "R", "0.###", "N1"])
      }"));`,
    () =>
      `Tr.S($"{${int(g, ctx)},6}|{${g.expr(ctx, T.double, 1)}:F1}|{${
        int(g, ctx)
      }:X}");`,
    () =>
      `Tr.S(string.Format("{0} {1:D3}", ${g.expr(ctx, T.double, 1)}, ${
        int(g, ctx)
      }));`,
  ];
  for (let n = rng.range(1, 3); n > 0; n--) lines.push(rng.pick(pieces)());
  return block(lines);
}

function sorting(g, ctx) {
  const rng = g.rng;
  const a = g.name("sa");
  const l = g.name("sl");
  const n = rng.pick([4, 9, 17, 24]);
  const lines = [
    `int[] ${a} = { ${ints(g, ctx, n, 15)} };`,
    `var ${l} = new List<int>(${a});`,
  ];
  const sorts = [
    `Array.Sort(${a});`,
    `Array.Sort(${a}, (p, q) => (p & 3).CompareTo(q & 3));`,
    `${l}.Sort((p, q) => (q >> 1) - (p >> 1));`,
    `${l}.Sort();`,
    `Array.Reverse(${a});`,
    `Array.Sort(${a}, 1, ${a}.Length - 2);`,
  ];
  for (const s of rng.shuffle(sorts).slice(0, 2)) lines.push(s);
  lines.push(
    `foreach (int v in ${a}) Tr.L(v);`,
    `foreach (int v in ${l}) Tr.L(v);`,
    `Tr.L(Array.IndexOf(${a}, ${small(g, ctx, 15)}));`,
  );
  return block(lines);
}

function random(g, ctx) {
  const r = g.name("rr");
  return block([
    `var ${r} = new Random(${int(g, ctx)});`,
    `Tr.L(${r}.Next());`,
    `Tr.L(${r}.Next(${small(g, ctx, 127)} + 1));`,
    `Tr.L(${r}.Next(-5, ${small(g, ctx, 63)}));`,
    `Tr.LD(${r}.NextDouble());`,
  ]);
}

function events(g, ctx) {
  const b = g.name("eb");
  const a1 = g.name("ea");
  const a2 = g.name("ec");
  const f = g.name("ef");
  return block([
    `var ${b} = new FxBus();`,
    `Action<int> ${a1} = v => Tr.L(v);`,
    `Action<int> ${a2} = v => Tr.L(v * 2 + 1);`,
    `${b}.Fired += ${a1};`,
    `${b}.Fired += ${a2};`,
    `${b}.Fired += ${a1};`,
    `${b}.Raise(${int(g, ctx)});`,
    `${b}.Fired -= ${a1};`,
    `${b}.Raise(${int(g, ctx)});`,
    `Func<int> ${f} = () => 1;`,
    `${f} += () => ${int(g, ctx)};`,
    `Tr.L(${f}());`,
    `Tr.L((${a1} + ${a2} - ${a1}) == ${a2} ? 1 : 0);`,
  ]);
}

function refLocals(g, ctx) {
  const a = g.name("fa");
  const r = g.name("fr");
  const m = g.name("fm");
  return block([
    `int[] ${a} = { ${ints(g, ctx, 4)} };`,
    `ref int ${r} = ref ${a}[${small(g, ctx, 3)}];`,
    `${r} += ${int(g, ctx)};`,
    `ref int ${m} = ref Fx.Pick(${a}, ${int(g, ctx)});`,
    `${m} *= 2;`,
    `Fx.Bump(ref ${r}, 3);`,
    `foreach (int v in ${a}) Tr.L(v);`,
    `Tr.L(${r} + ${m});`,
  ]);
}

function types(g, ctx) {
  const o = g.name("to");
  return block([
    `object ${o} = (${int(g, ctx)} & 3) switch { 0 => (object)${
      int(g, ctx)
    }, 1 => (object)"s", 2 => (object)2.5, _ => (object)new FxSquare(2) };`,
    `Tr.S(${o}.GetType().Name);`,
    `Tr.L(${o}.GetType() == typeof(int) ? 1 : 0);`,
    `Tr.L(${o}.GetType() == typeof(FxSquare) ? 1 : 0);`,
    `Tr.S(typeof(List<int>).Name);`,
    `Tr.S(typeof(FxBase).Name);`,
  ]);
}

function gvm(g, ctx) {
  const s = g.name("gs");
  const b = g.name("gb");
  return block([
    `IFxShape ${s} = (${int(g, ctx)} & 1) == 0 ? new FxSquare(${
      small(g, ctx)
    }) : new FxRect(${small(g, ctx)}, 3);`,
    `Tr.L(${s}.Area());`,
    `Tr.L(${s}.Twice());`,
    `FxBase ${b} = (FxBase)${s};`,
    `Tr.L(${b}.Echo(${int(g, ctx)}));`,
    `Tr.S(${b}.Echo("e"));`,
    `Tr.L(${b}.Self().Area());`,
    `Tr.L(new FxSquare(${small(g, ctx)}).Self().Area());`,
  ]);
}

// decimal: values of several shapes, the arithmetic's results and scales,
// comparisons, rounding, text and parsing, conversions both ways.
function decimals(g, ctx) {
  const rng = g.rng;
  const k = g.key();
  const [a, b, c, p, n] = ["da", "db", "dc", "dp", "dn"].map((x) => g.name(x));
  const lines = [
    `decimal ${a} = (decimal)${int(g, ctx)} * ${
      rng.pick(["0.01m", "1.5m", "-0.125m", "1000000.0000001m", "1m"])
    };`,
    `decimal ${b} = new decimal(${int(g, ctx)}, ${int(g, ctx)}, ${
      int(g, ctx)
    } & ${rng.pick(["0", "0xFFFF", "0x7FFFFFFF", "-1"])}, (${
      int(g, ctx)
    } & 1) == 0, (byte)(${small(g, ctx, 31)} % 29));`,
    `decimal ${c} = ${
      rng.pick([
        "decimal.MaxValue",
        "decimal.MinValue",
        "0.0000m",
        "-1m",
        "7m",
        "2.5m",
      ])
    } / (${small(g, ctx, 15)} + Tr.Zero - 3);`,
  ];
  const guarded = [
    `FxDec.L(${a} + ${b});`,
    `FxDec.L(${b} - ${c});`,
    `FxDec.L(${a} * ${b});`,
    `FxDec.L(${b} / ${a});`,
    `FxDec.L(${c} % ${a});`,
    `FxDec.L(${b} * ${c} / 7);`,
    `Tr.L((int)${b});`,
    `Tr.L((long)${a});`,
    `Tr.L((byte)${c});`,
    `FxDec.L((decimal)(${g.expr(ctx, T.double, 1)} + Tr.Zero));`,
    `FxDec.L((decimal)(float)(${g.expr(ctx, T.double, 1)} + Tr.Zero));`,
    `FxDec.L(${a}++ + --${b});`,
    `FxDec.L(${a} += ${b} % 3);`,
  ];
  const plain = [
    `Tr.L(decimal.Compare(${a}, ${b}) + (${a} == ${b} * 1.0m ? 10 : 0) + (${b} >= ${c} ? 100 : 0));`,
    `FxDec.L(Math.Round(${b}, ${small(g, ctx, 31)} % 29, MidpointRounding.${
      rng.pick([
        "ToEven",
        "AwayFromZero",
        "ToZero",
        "ToNegativeInfinity",
        "ToPositiveInfinity",
      ])
    }));`,
    `FxDec.L(decimal.Floor(${b}) + Math.Ceiling(${c}) - decimal.Truncate(${a}));`,
    `Tr.S(${b}.ToString());`,
    `Tr.S(${a}.ToString("${
      rng.pick(["F2", "N0", "E3", "G5", "C", "P1", "0.00", "#,##0.###", "G"])
    }"));`,
    `Tr.S($"{${c}:F3}|{${b},12}|{${a}}");`,
    `Tr.L(decimal.TryParse(${b}.ToString(), out decimal ${p}) && ${p} == ${b} ? ${p}.Scale : -1);`,
    `Tr.L(decimal.TryParse(${
      g.expr(ctx, T.string, 1)
    }, out decimal ${p}) ? ${p}.GetHashCode() : -2);`,
    `Tr.LD((double)${b});`,
    `Tr.L(${b}.GetHashCode() ^ ${a}.GetHashCode());`,
    `Tr.L(${b} switch { < 0m => 1, 0m => 2, > 1000m and < 1000000m => 3, _ => 4 });`,
    `decimal? ${n} = (${
      int(g, ctx)
    } & 1) == 0 ? null : ${a}; FxDec.L((${n} * 2) ?? -1m);`,
    `FxDec.L(new[] { ${a}, 1.5m, -2.25m }.Where(x => x < 1000m).Sum());`,
    `FxDec.L(Math.Max(${a}, ${c}) - Math.Abs(${b} % 100m));`,
  ];
  for (const op of rng.shuffle(guarded).slice(0, rng.range(1, 4))) {
    lines.push(
      "try",
      block([op]),
      "catch (OverflowException)",
      block([`Tr.L(${k});`]),
      "catch (DivideByZeroException)",
      block([`Tr.L(${k} + 1);`]),
    );
  }
  for (const op of rng.shuffle(plain).slice(0, rng.range(2, 5))) {
    lines.push(block([op]));
  }
  return block(lines);
}

function mdArrays(g, ctx) {
  const k = g.key();
  const [m, c, i, v] = ["mm", "mc", "mi", "mv"].map((x) => g.name(x));
  return block([
    `int[,] ${m} = new int[${small(g, ctx, 3)} + 1, ${small(g, ctx, 3)} + 2];`,
    `int ${i} = ${small(g, ctx, 15)};`,
    `${m}[${i} % ${m}.GetLength(0), ${i} % ${m}.GetLength(1)] = ${
      int(g, ctx)
    };`,
    `${m}[0, ${m}.GetUpperBound(1)] += ${int(g, ctx)};`,
    `foreach (int ${v} in ${m}) Tr.L(${v});`,
    `Tr.L(${m}.Length * 100 + ${m}.Rank * 10 + ${m}.GetLength(1));`,
    `long[,,] ${c} = new long[2, ${small(g, ctx, 1)} + 1, 3];`,
    `${c}[1, 0, 2] = ${int(g, ctx)};`,
    `Tr.L(${c}[1, 0, 2] + ${c}.LongLength);`,
    `Tr.L(new[,] { { ${int(g, ctx)}, 2 }, { 3, ${
      int(g, ctx)
    } } }[1, ${i} & 1]);`,
    `try`,
    block([`Tr.L(${m}[${i}, 0]);`]),
    `catch (IndexOutOfRangeException)`,
    block([`Tr.L(${k});`]),
  ]);
}

function spans(g, ctx) {
  const rng = g.rng;
  const [a, s, t, r, v, c] = ["sa", "ss", "st", "sr", "sv", "sc"].map((x) =>
    g.name(x)
  );
  const lines = [
    `int[] ${a} = { ${ints(g, ctx, 6)} };`,
    `Span<int> ${s} = ${a}.AsSpan(1, 4);`,
    `${s}[0] += ${int(g, ctx)};`,
  ];
  const ops = [
    `${s}.Slice(${small(g, ctx, 3)}).Fill(${int(g, ctx)});`,
    `foreach (ref int ${r} in ${s}) ${r} = ${r} * 2 + 1;`,
    `${s}.Reverse();`,
    `${a}.AsSpan().Sort();`,
    `${s}[1..].CopyTo(${a});`,
    `Tr.L(${s}.IndexOf(${a}[2]) + ${s}.LastIndexOf(${a}[0]) * 10);`,
    `Tr.L(${s}.SequenceEqual(${a}.AsSpan(1, 4)) ? 1 : 0);`,
    `ReadOnlySpan<char> ${c} = "${
      rng.pick(["hello, world", "  padded  ", "a,b,c"])
    }".AsSpan(${small(g, ctx, 1)});
Tr.S(${c}.Trim().ToString()); Tr.L(${c}.IndexOf(',')); Tr.S(new string(${c}.Slice(0, 2)));`,
    `Span<int> ${t} = stackalloc int[${small(g, ctx, 7)} + 1]; ${t}[0] = ${
      int(g, ctx)
    }; Tr.L(${t}.Length * 1000 + ${t}[0]); foreach (int ${v} in ${t}) Tr.L(${v});`,
    `Span<long> ${t} = stackalloc long[] { ${
      int(g, ctx)
    }, 2, 3 }; ${t}.Clear(); Tr.L(${t}.Length);`,
    `Tr.L(${s}.ToArray().Length + ${s}.Slice(2, 1)[0]);`,
  ];
  for (const op of rng.shuffle(ops).slice(0, rng.range(2, 5))) {
    lines.push(block([op]));
  }
  lines.push(`foreach (int ${v} in ${a}) Tr.L(${v});`);
  return block(lines);
}

function iterators2(g, ctx) {
  const [f, v, c, e] = ["lf", "lv", "lc", "le"].map((x) => g.name(x));
  const bound = small(g, ctx, 7);
  return block([
    `IEnumerable<int> ${f}(int limit)`,
    block([
      `for (int i = 0; i < limit; i++)`,
      block([
        `if (i == 2) goto skip;`,
        `yield return i * 7;`,
        `skip:`,
        `Tr.L(-130 - i);`,
      ]),
      `yield return -1;`,
    ]),
    `foreach (int ${v} in ${f}(${bound})) Tr.L(${v});`,
    `var ${c} = new FxCounter { Start = ${int(g, ctx)} & 255 };`,
    `foreach (int ${v} in ${c}.Up(${small(g, ctx, 7)})) Tr.L(${v});`,
    `Tr.L(${c}.Start);`,
    `using (var ${e} = ${f}(3).GetEnumerator())`,
    block([`while (${e}.MoveNext()) Tr.L(${e}.Current);`]),
  ]);
}

function comparers(g, ctx) {
  const rng = g.rng;
  const [d, h, w, a] = ["cd", "ch", "cw", "ca"].map((x) => g.name(x));
  const words = rng.shuffle([
    '"b"',
    '"A"',
    '"a"',
    '"B"',
    '"ab"',
    '"Ab"',
    '""',
    '"z"',
  ]).slice(0, 5).join(", ");
  const lines = [
    `string[] ${w} = { ${words} };`,
    `int[] ${a} = { ${ints(g, ctx, 6, 31)} };`,
  ];
  const ops = [
    `var ${d} = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase); foreach (string x in ${w}) ${d}[x] = ${d}.TryGetValue(x, out int n) ? n + 1 : 1; foreach (var kv in ${d}) { Tr.S(kv.Key); Tr.L(kv.Value); }`,
    `var ${h} = new HashSet<string>(${w}, StringComparer.OrdinalIgnoreCase); Tr.L(${h}.Count); Tr.L(${h}.Contains("AB") ? 1 : 0);`,
    `Array.Sort(${w}, StringComparer.Ordinal); foreach (string x in ${w}) Tr.S(x);`,
    `foreach (string x in ${w}.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ThenBy(x => x.Length)) Tr.S(x);`,
    `Array.Sort(${a}, Comparer<int>.Create((p, q) => q.CompareTo(p))); foreach (int x in ${a}) Tr.L(x);`,
    `Tr.L(${a}.Distinct(EqualityComparer<int>.Create((p, q) => p % 3 == q % 3, x => x % 3)).Count());`,
    `var ${h} = new List<int>(${a}); ${h}.Sort(Comparer<int>.Default); Tr.L(${h}.BinarySearch(${a}[0], Comparer<int>.Default));`,
    `Tr.L(Math.Sign(StringComparer.Ordinal.Compare(${w}[0], ${w}[1])) + 3 * Math.Sign(StringComparer.OrdinalIgnoreCase.Compare(${w}[2], ${w}[3])));`,
    `Tr.L(StringComparer.OrdinalIgnoreCase.Equals(${w}[0], ${w}[1]) ? 1 : 0);`,
    `Tr.L(EqualityComparer<int>.Default.Equals(${a}[0], ${a}[1]) ? 1 : 0); Tr.L(Comparer<int>.Default.Compare(${a}[0], ${a}[1]));`,
  ];
  for (const op of rng.shuffle(ops).slice(0, rng.range(2, 4))) {
    lines.push(block([op]));
  }
  return block(lines);
}

function sorted(g, ctx) {
  const rng = g.rng;
  const [l, d, s, q, n, a] = ["ql", "qd", "qs", "qq", "qn", "qa"].map((x) =>
    g.name(x)
  );
  const lines = [`int[] ${a} = { ${ints(g, ctx, rng.range(3, 9), 31)} };`];
  const ops = [
    `var ${l} = new SortedList<int, int>(); foreach (int x in ${a}) ${l}[x] = x * 2; foreach (var kv in ${l}) Tr.L(kv.Key * 100 + kv.Value); Tr.L(${l}.IndexOfKey(${a}[0])); ${l}.RemoveAt(0); Tr.L(${l}.Keys[0]);`,
    `var ${d} = new SortedDictionary<int, string>(); foreach (int x in ${a}) ${d}[x & 15] = "v" + x; foreach (var kv in ${d}) { Tr.L(kv.Key); Tr.S(kv.Value); } Tr.L(${d}.Remove(${a}[1] & 15) ? 1 : 0); Tr.L(${d}.Count);`,
    `var ${s} = new SortedSet<int>(${a}); Tr.L(${s}.Min * 1000 + ${s}.Max); ${s}.Remove(${a}[0]); foreach (int x in ${s}.Reverse()) Tr.L(x); Tr.L(${s}.Contains(${a}[1]) ? 1 : 0);`,
    `var ${q} = new PriorityQueue<int, int>(); foreach (int x in ${a}) ${q}.Enqueue(x, x & 7); Tr.L(${q}.Peek()); while (${q}.TryDequeue(out int item, out int priority)) Tr.L(item * 10 + priority);`,
    `var ${q} = new PriorityQueue<string, int>(Comparer<int>.Create((p, r) => r - p)); ${q}.Enqueue("a", ${a}[0]); ${q}.Enqueue("b", ${a}[1]); Tr.S(${q}.EnqueueDequeue("c", ${a}[2])); Tr.L(${q}.Count); Tr.S(${q}.Dequeue());`,
    `var ${n} = new LinkedList<int>(${a}); ${n}.AddFirst(-1); var node = ${n}.Find(${a}[1]); if (node != null) { ${n}.AddAfter(node, 99); ${n}.Remove(node); } ${n}.RemoveLast(); foreach (int x in ${n}) Tr.L(x); Tr.L(${n}.Count + ${n}.First.Value);`,
  ];
  for (const op of rng.shuffle(ops).slice(0, rng.range(1, 3))) {
    lines.push(block([op]));
  }
  return block(lines);
}

function linq2(g, ctx) {
  const rng = g.rng;
  const [o, a, lk, an, bn] = ["xo", "xa", "xl", "xn", "xb"].map((x) =>
    g.name(x)
  );
  const lines = [
    `object[] ${o} = { ${int(g, ctx)}, "s", 2.5, ${
      small(g, ctx)
    }, null, "t" };`,
    `int[] ${a} = { ${ints(g, ctx, rng.range(3, 8), 63)} };`,
  ];
  const ops = [
    `foreach (int x in ${o}.OfType<int>()) Tr.L(x);`,
    `foreach (string x in ${o}.OfType<string>()) Tr.S(x);`,
    `foreach (int x in new object[] { 1, ${
      int(g, ctx)
    }, 3 }.Cast<int>()) Tr.L(x);`,
    `var ${lk} = ${a}.ToLookup(x => x % 3); Tr.L(${lk}.Count); Tr.L(${lk}[1].Count()); foreach (var grp in ${lk}) Tr.L(grp.Key * 1000 + grp.Sum());`,
    `foreach (int x in ${a}.GroupBy(x => x & 1, x => x * 2, (key, xs) => key * 1000 + xs.Sum())) Tr.L(x);`,
    `foreach (var x in ${a}.Join(${a}, p => p % 4, q => q % 5, (p, q) => p * 100 + q).Take(6)) Tr.L(x);`,
    `var ${an} = new { A = ${int(g, ctx)}, B = ${small(g, ctx)}, C = "c", D = ${
      small(g, ctx)
    } * 0.5, E = true, F = (long)${
      int(g, ctx)
    } }; var ${bn} = ${an} with { C = "d", A = ${
      small(g, ctx)
    } }; Tr.S(${bn}.ToString()); Tr.L(${an}.Equals(${bn}) ? 1 : 0); Tr.L(${an}.Equals(${an} with { }) ? 1 : 0);`,
    `var ${an} = new { P1 = 1, P2 = 2, P3 = 3, P4 = 4, P5 = 5, P6 = 6, P7 = 7, P8 = 8, P9 = ${
      int(g, ctx)
    }, P10 = 10 }; Tr.L(${an}.P9 + ${an}.P10); Tr.S((${an} with { P1 = 0 }).ToString());`,
  ];
  for (const op of rng.shuffle(ops).slice(0, rng.range(2, 4))) {
    lines.push(block([op]));
  }
  return block(lines);
}

// The framework assemblies' own IL: how often selectors run,
// cheap counts, sets, messages.
function framework(g, ctx) {
  const rng = g.rng;
  const [a, o, n, e] = ["fa", "fo", "fn", "fe"].map((x) => g.name(x));
  const lines = [
    `int[] ${a} = { ${ints(g, ctx, rng.range(3, 9), 31)} };`,
    `object[] ${o} = { ${small(g, ctx)}, "s", null, ${int(g, ctx)} };`,
    `int ${n} = 0;`,
  ];
  const ops = [
    `Tr.L(${a}.Select(x => { ${n}++; return x * 3; }).Last() * 100 + ${n});`,
    `Tr.L(new List<int>(${a}).Select(x => { ${n}++; return x + 1; }).ElementAt(${
      small(g, ctx, 1)
    }) * 100 + ${n});`,
    `Tr.L(${a}.Select(x => { ${n}++; return x; }).Count() * 100 + ${n});`,
    `Tr.L(${a}.Where(x => { ${n}++; return (x & 1) == 0; }).Skip(1).FirstOrDefault(-1) * 100 + ${n});`,
    `Tr.L(${o}.Cast<string>().Count()); Tr.L(${o}.OfType<int>().Sum());`,
    `try { Tr.L(${o}.Cast<string>().ToList().Count); } catch (InvalidCastException) { Tr.L(-7); }`,
    `foreach (var c in ${a}.Chunk(${
      small(g, ctx, 3)
    } + 1)) Tr.L(c.Length * 100 + c.Sum());`,
    `foreach (var (i, x) in ${a}.Index()) Tr.L(i * 1000 + x);`,
    `foreach (var kv in ${a}.CountBy(x => x % 3)) Tr.L(kv.Key * 100 + kv.Value);`,
    `foreach (var kv in ${a}.AggregateBy(x => x & 1, 0, (s, x) => s + x)) Tr.L(kv.Key * 1000 + kv.Value);`,
    `foreach (int x in ${a}.Order().TakeLast(3)) Tr.L(x);`,
    `foreach (int x in ${a}.Distinct().OrderDescending()) Tr.L(x); Tr.L(${a}.Distinct().ToArray().Length);`,
    `try { Tr.L(${a}.Where(x => x > 1000).Max()); } catch (InvalidOperationException ${e}) { Tr.S(${e}.Message); }`,
    `try { Tr.L(${a}.Single()); } catch (InvalidOperationException ${e}) { Tr.S(${e}.Message); }`,
    `try { Tr.L(${a}.ToDictionary(x => x & 3).Count); } catch (ArgumentException ${e}) { Tr.S(${e}.Message); }`,
    `var s = new SortedSet<int>(${a}); s.IntersectWith(new[] { ${
      ints(g, ctx, 3, 31)
    } }); Tr.L(s.Count); s.SymmetricExceptWith(${a}); foreach (int x in s) Tr.L(x);`,
    `var h = new HashSet<int>(${a}); h.ExceptWith(new[] { ${
      ints(g, ctx, 3, 31)
    } }); Tr.L(h.IsSubsetOf(${a}) ? 1 : 0); foreach (int x in h) Tr.L(x);`,
    `var st = new Stack<int>(${a}); Tr.L(st.Pop()); Tr.L(st.TryPeek(out int top) ? top : -1); try { st.Clear(); st.Pop(); } catch (InvalidOperationException ${e}) { Tr.S(${e}.Message); }`,
    `var od = new OrderedDictionary<int, int>(); foreach (int x in ${a}) od.TryAdd(x, x * 2); od.Insert(0, -1, -2); foreach (var kv in od) Tr.L(kv.Key * 100 + kv.Value); Tr.L(od.IndexOf(${a}[0]));`,
  ];
  for (const op of rng.shuffle(ops).slice(0, rng.range(1, 4))) {
    lines.push(block([op]));
  }
  return block(lines);
}

// Variance: variant interfaces of classes and arrays, variant
// delegates.
function variance(g, ctx) {
  const rng = g.rng;
  const [d, b] = ["vd", "vb"].map((x) => g.name(x));
  const lines = [
    `var ${d} = new VxDerived[] { new VxDerived(${
      small(g, ctx)
    }), new VxDerived(${small(g, ctx)}) };`,
    `var ${b} = new VxBoth();`,
  ];
  const ops = [
    `IEnumerable<VxBase> e = new List<VxDerived>(${d}); foreach (var x in e) Tr.L(x.Id);`,
    `IReadOnlyList<VxBase> l = ${d}; Tr.L(l[${
      small(g, ctx, 1)
    }].Id + l.Count * 100);`,
    `IEnumerable<object> e = ${d}; Tr.L(e.Count()); Tr.L(e.OfType<VxBase>().Sum(x => x.Id));`,
    `IVxSource<VxBase> src = ${b}; IVxSink<VxDerived> sink = ${b}; Tr.L(src.Take(${
      small(g, ctx)
    }).Id + sink.Put(new VxDerived(1)));`,
    `object o = ${b}; Tr.L((o is IVxSource<VxBase> ? 1 : 0) + (o is IVxSink<VxDerived> ? 10 : 0) + (o is IVxSource<string> ? 100 : 0));`,
    `Func<VxDerived> make = () => new VxDerived(${
      small(g, ctx)
    }); Func<VxBase> made = make; Tr.L(made().Id);`,
    `Action<VxBase> put = x => Tr.L(x.Id * 3); Action<VxDerived> narrowed = put; narrowed(new VxDerived(${
      small(g, ctx)
    }));`,
    `IList<VxBase> w = ${d}; try { w[0] = new VxBase(); Tr.L(0); } catch (ArrayTypeMismatchException) { Tr.L(-5); }`,
    `var sorted = new List<VxDerived>(${d}); sorted.Sort(Comparer<VxBase>.Create((p, q) => q.Id - p.Id)); foreach (var x in sorted) Tr.L(x.Id);`,
    `VxBase[] cov = ${d}; Tr.L(cov[${
      small(g, ctx, 1)
    }].Id + (cov is VxDerived[] ? 100 : 0)); try { cov[0] = new VxBase(); Tr.L(0); } catch (ArrayTypeMismatchException) { Tr.L(-7); }`,
    `object[] objs = new string[] { "${
      rng.pick(["b", "a", "c"])
    }", "q" }; objs[1] = null; Tr.L(objs.Length + (objs[1] is null ? 10 : 0)); try { objs[0] = ${
      small(g, ctx)
    }; Tr.L(0); } catch (ArrayTypeMismatchException) { Tr.L(-9); }`,
  ];
  for (const op of rng.shuffle(ops).slice(0, rng.range(1, 3))) {
    lines.push(block([op]));
  }
  return block(lines);
}

// Vector128 lanes of random integers, and System.Numerics' types of small
// ones.
function vectors(g, ctx) {
  const rng = g.rng;
  const [a, b, v, w] = ["va", "vb", "vv", "vw"].map((x) => g.name(x));
  const component = () => `(float)((${int(g, ctx)} & 15) - 8)`;
  const lines = [
    `var ${a} = Vector128.Create(${int(g, ctx)}, ${int(g, ctx)}, ${
      int(g, ctx)
    }, ${int(g, ctx)});`,
    `var ${b} = Vector128.Create(${small(g, ctx)}, ${int(g, ctx)}, ${
      small(g, ctx, 255)
    }, ${int(g, ctx)});`,
    `var ${v} = new Vector3(${component()}, ${component()}, ${component()});`,
    `var ${w} = new Vector3(${component()}, ${component()}, ${component()});`,
  ];
  const V = "Vector128";
  const ops = [
    `Tr.L(${V}.Sum(${a} + ${b} * ${b}));`,
    `Tr.L(${V}.ExtractMostSignificantBits(${V}.GreaterThan(${a}, ${b})));`,
    `Tr.L(${V}.Max(${a}, ${b}).GetElement(${small(g, ctx, 3)}));`,
    `Tr.L((${a} << ${small(g, ctx, 31)}).ToScalar() + (${a} >>> ${
      small(g, ctx)
    }).GetElement(1) + (${a} >> 3).GetElement(2));`,
    `Tr.L(${V}.Dot(${a}, ${b}) + ${V}.Min(${a}, ${b})[3]);`,
    `Tr.L((${a}.AsByte() + ${V}.Create((byte)${
      small(g, ctx, 255)
    })).GetElement(${small(g, ctx, 15)}));`,
    `Tr.LD(${V}.Sum(${V}.ConvertToSingle(${a}) / ${V}.Create(4f)));`,
    `Tr.L(${V}.Narrow(${a}, ${b}).GetElement(${
      small(g, ctx)
    }) + ${V}.NarrowWithSaturation(${a}, ${b})[1]);`,
    `Tr.L(${V}.Shuffle(${a}, ${b} & ${V}.Create(7)).GetElement(${
      small(g, ctx, 3)
    }));`,
    `Tr.L((${a} == ${b} ? 1 : 0) + (${a}.Equals(${a}) ? 10 : 0) + (${V}.EqualsAny(${a}, ${b}) ? 100 : 0));`,
    `var lanes = new Vector128<int>[(${
      small(g, ctx)
    }) + 1]; lanes[0] = ${a}; lanes[lanes.Length - 1] += ${b}; Tr.L(${V}.Sum(lanes[0] + lanes[lanes.Length - 1]));`,
    `object boxed = ${a}; Tr.L(boxed.Equals(${b}) ? 1 : 0); Tr.S(${b}.ToString());`,
    `Tr.L(${V}.WidenUpper(${a}).GetElement(1) + ${V}.AddSaturate(${a}.AsInt16(), ${b}.AsInt16()).GetElement(${
      small(g, ctx)
    }));`,
    `Tr.LD(Vector3.Dot(${v}, ${w})); Tr.LD(Vector3.Cross(${v}, ${w}).Y);`,
    `Tr.LD(Vector3.Transform(${v}, Matrix4x4.CreateTranslation(${w}) * Matrix4x4.CreateScale(2f)).X);`,
    `Tr.LD(Vector3.Lerp(${v}, ${w}, 0.25f).Z); Tr.LD(${v}.LengthSquared());`,
    `Tr.LD(Vector3.Distance(${v}, ${w})); Tr.LD(Vector3.Normalize(${v} + Vector3.One * 9f).X);`,
    `var q = new Quaternion(${v}, 1f); Tr.LD((q * new Quaternion(${w}, -2f)).W);`,
    `Tr.S(new Vector2(${v}.X, ${w}.Y).ToString());`,
    `Tr.L(Vector3.Min(${v}, ${w}) == ${v} ? 1 : 0); Tr.LD(Vector3.Clamp(${v}, -Vector3.One, Vector3.One).Y);`,
    `var m4 = Matrix4x4.CreateTranslation(${v}) * Matrix4x4.CreateScale(${w}.X + 9f); Tr.L(Matrix4x4.Invert(m4, out var inverse) ? 1 : 0); Tr.LD(inverse.M41 + inverse.M43 + m4.GetDeterminant());`,
    `var bodies = new Vector3[] { ${v}, ${w} }; bodies[${
      small(g, ctx, 1)
    }] *= 2f; Tr.LD(bodies[0].X + bodies[1].Z);`,
  ];
  for (const op of rng.shuffle(ops).slice(0, rng.range(1, 4))) {
    lines.push(block([op]));
  }
  return block(lines);
}

function bignum(g, ctx) {
  const rng = g.rng;
  const [a, b, m] = ["ba", "bb", "bm"].map((x) => g.name(x));
  const lines = [
    `BigInteger ${a} = BigInteger.Pow(${int(g, ctx)}, ${
      small(g, ctx, 15)
    }) - (new BigInteger(${int(g, ctx)}) << ${small(g, ctx, 127)});`,
    `BigInteger ${b} = new BigInteger(${int(g, ctx)}) * ${int(g, ctx)} * ${
      int(g, ctx)
    } - ${small(g, ctx, 255)};`,
    `BigInteger ${m} = BigInteger.Abs(${b}) + ${small(g, ctx, 63)} + 2;`,
  ];
  const text = () =>
    `${a}.ToString("${
      rng.pick(["D", "X", "B", "N0", "E4", "D30", "x8", "G", "#,##0"])
    }", CultureInfo.InvariantCulture)`;
  const ops = [
    `Tr.S((${a} + ${b} * ${b}).ToString());`,
    `Tr.S((${a} * ${b} - ${b}).ToString());`,
    `try { Tr.S((${a} / ${b}).ToString()); Tr.S((${a} % ${b}).ToString()); } catch (DivideByZeroException) { Tr.L(-1); }`,
    `Tr.S(BigInteger.DivRem(${a}, ${m}, out BigInteger rem).ToString()); Tr.S(rem.ToString());`,
    `Tr.S((${a} << ${small(g, ctx, 63)}).ToString()); Tr.S((${a} >> ${
      small(g, ctx, 63)
    }).ToString()); Tr.S((${a} >>> ${small(g, ctx, 31)}).ToString());`,
    `Tr.S((${a} & ${b}).ToString()); Tr.S((${a} | ~${b}).ToString()); Tr.S((${a} ^ ${b}).ToString());`,
    `Tr.S(BigInteger.ModPow(${a}, ${
      small(g, ctx, 63)
    }, ${m}).ToString()); Tr.S(BigInteger.GreatestCommonDivisor(${a}, ${b}).ToString());`,
    `Tr.L(${a}.CompareTo(${b})); Tr.L(${a} == ${b} ? 1 : 0); Tr.L(${a}.Sign); Tr.L(${a}.IsEven ? 1 : 0); Tr.L(${a}.GetBitLength());`,
    `try { Tr.L((long)${a}); } catch (OverflowException) { Tr.L(-2); } Tr.L(unchecked((long)(ulong)(${b} & ulong.MaxValue)));`,
    `Tr.S(${text()});`,
    `byte[] bytes = ${a}.ToByteArray(); Tr.L(bytes.Length); Tr.S(new BigInteger(bytes, isBigEndian: false).ToString());`,
    `Tr.L(BigInteger.TryParse(${a}.ToString(), out BigInteger parsed) && parsed == ${a} ? 1 : 0); Tr.L(BigInteger.TryParse("${
      rng.pick(["12x", " 42 ", "-0", "1e3", "(7)"])
    }", NumberStyles.Any, CultureInfo.InvariantCulture, out BigInteger other) ? (long)(other % 1000) : -3);`,
    `Tr.S(BigInteger.Max(${a}, ${b}).ToString()); Tr.L((long)BigInteger.PopCount(${m}) + (long)BigInteger.TrailingZeroCount(${m}));`,
    `Tr.LD((double)(${b} % 1000000)); Tr.S($"{${m}:X4}");`,
    `var z = new Complex(${small(g, ctx)} - 4, ${
      small(g, ctx)
    }) * new Complex(${small(g, ctx)}, -${
      small(g, ctx, 3)
    }) + Complex.Conjugate(new Complex(${
      small(g, ctx, 3)
    }, 1)); Tr.LD(z.Real); Tr.LD(z.Imaginary); Tr.S(z.ToString());`,
  ];
  for (const op of rng.shuffle(ops).slice(0, rng.range(1, 4))) {
    lines.push(block([op]));
  }
  return block(lines);
}

// An async lambda under a pump of its own (AxPump.Run): its inputs are
// evaluated first, since a lambda captures no ref locals or spans.
function asyncMethods(g, ctx) {
  const rng = g.rng;
  const [a, b, c] = ["xa", "xb", "xc"].map((x) => g.name(x));
  const lines = [
    `int ${a} = ${small(g, ctx)};`,
    `int ${b} = ${small(g, ctx)};`,
    `int ${c} = ${int(g, ctx)};`,
  ];
  const T = "System.Threading.Tasks.Task";
  const ops = [
    `Tr.L(await Ax.Twice(${a}) + await Ax.Twice(${b}));`,
    `var all = await ${T}.WhenAll(Ax.Twice(${a}), Ax.Twice(${b}), Ax.Checked(${a} & 3)); Tr.L(all[0] + all[1] * 10 + all[2] * 100);`,
    `try { Tr.L(await Ax.Checked(${a})); } catch (InvalidOperationException e) { Tr.S(e.Message); }`,
    `var first = await ${T}.WhenAny(Ax.Twice(${a}), ${T}.FromResult(${c})); Tr.L(first.Result);`,
    `Tr.L(await Ax.Maybe(${a}) + await Ax.Maybe(${c}));`,
    `await foreach (int v in Ax.Range(${a} & 3)) { Tr.L(v); if (v > ${b}) break; }`,
    `var source = new ${T}CompletionSource<int>(); var w1 = Ax.Waiting(source.Task, 1); var w2 = Ax.Waiting(source.Task, 2); source.SetResult(${c}); Tr.L(w1.IsCompleted ? 1 : 0); Tr.L(await w2);`,
    `var cts = new System.Threading.CancellationTokenSource(); cts.Token.Register(() => Tr.L(${a})); cts.Token.Register(() => Tr.L(${b})); cts.Cancel(); try { await ${T}.Delay(5, cts.Token); } catch (OperationCanceledException) { Tr.L(-3); }`,
    `var faults = ${T}.WhenAll(Ax.Checked(${a} + 4), Ax.Checked(${b} + 5)); try { await faults; } catch (InvalidOperationException e) { Tr.S(e.Message); } Tr.L(faults.Exception.InnerExceptions.Count);`,
    `await ${T}.Yield(); Tr.L(${c}); await ${T}.CompletedTask; Tr.L(-${c});`,
  ];
  const body = rng.shuffle(ops).slice(0, rng.range(1, 3));
  lines.push(`AxPump.Run(async () =>`, block(body) + ");");
  return block(lines);
}

function memory(g, ctx) {
  const rng = g.rng;
  const [a, m, r, s, t, h] = ["ma", "mm", "mr", "ms", "mt", "mh"].map((x) =>
    g.name(x)
  );
  const lines = [
    `int[] ${a} = { ${ints(g, ctx, 6)} };`,
    `Memory<int> ${m} = ${a};`,
    `Memory<int> ${s} = ${m}.Slice(${small(g, ctx, 3)}, 2);`,
    `${s}.Span[0] = ${int(g, ctx)};`,
  ];
  const ops = [
    `Tr.L(${s}.Length * 100 + ${s}.Span[1] + ${m}[1..^1].Length);`,
    `foreach (int v in ${s}.ToArray()) Tr.L(v);`,
    `Memory<int> ${t} = new int[4]; ${s}.CopyTo(${t}); Tr.L(${t}.Span[1]); Tr.L(${m}.TryCopyTo(${t}) ? 1 : 0);`,
    `ReadOnlyMemory<char> ${r} = "${
      rng.pick(["memory text", "a,b,c", "  x  "])
    }".AsMemory(${
      small(g, ctx, 3)
    }); Tr.S(${r}.ToString()); Tr.L(${r}.Span.IndexOf(',')); Tr.L(${r}.Equals("zz".AsMemory()) ? 1 : 0);`,
    `var ${h} = new List<ReadOnlyMemory<int>> { ${m}, ${s} }; Func<int> f = () => ${h}[1].Span[0]; Tr.L(f()); Tr.L(${h}[0].Equals(${m}) ? 1 : 0);`,
    `Tr.S(${m}.ToString()); Tr.S(((ReadOnlyMemory<int>)${s}).ToString());`,
    `Tr.L(${a}.AsMemory(${
      small(g, ctx, 3)
    }).Length + ${a}.AsMemory(1..3).Span[0]);`,
  ];
  for (const op of rng.shuffle(ops).slice(0, rng.range(2, 4))) {
    lines.push(block([op]));
  }
  lines.push(`foreach (int v in ${a}) Tr.L(v);`);
  return block(lines);
}

function ifaceEvents(g, ctx) {
  const [b, h, n] = ["eb", "eh", "en"].map((x) => g.name(x));
  return block([
    `IFxBus ${b} = (${
      int(g, ctx)
    } & 1) == 0 ? new FxFieldBus() : new FxAccessorBus();`,
    `Action<int> ${h} = v => Tr.L(v + 7);`,
    `${b}.Fired += ${h};`,
    `${b}.Fired += v => Tr.L(-v);`,
    `${b}.Raise(${int(g, ctx)});`,
    `${b}.Fired -= ${h};`,
    `${b}.Raise(${small(g, ctx)});`,
    `IFxNoted ${n} = new FxFieldBus();`,
    `${n}.Noted += () => Tr.L(1);`,
    `${n}.Noted -= () => Tr.L(2);`,
  ]);
}

function convert(g, ctx) {
  const rng = g.rng;
  const k = g.key();
  const [d, p] = ["cd", "cp"].map((x) => g.name(x));
  const targets = [
    "ToInt32",
    "ToByte",
    "ToInt64",
    "ToUInt32",
    "ToDecimal",
    "ToDouble",
    "ToSByte",
    "ToChar",
    "ToBoolean",
    "ToString",
    "ToInt16",
  ];
  const sources = [
    () => `${g.expr(ctx, T.double, 1)}`,
    () => `${int(g, ctx)}`,
    () => `(${int(g, ctx)} * 0.25m)`,
    () => `(long)${int(g, ctx)} * 3`,
    () => `"${rng.pick(["12", " -7 ", "300", "x", "1.5", "true", "A"])}"`,
    () => `(${int(g, ctx)} & 1) == 0`,
  ];
  const lines = [`decimal ${d} = ${int(g, ctx)} * 0.125m;`];
  for (let n = rng.range(2, 5); n > 0; n--) {
    const target = rng.pick(targets);
    const call = `Convert.${target}(${rng.pick(sources)()})`;
    lines.push(
      "try",
      block([
        target === "ToString"
          ? `Tr.S(${call});`
          : target === "ToDouble"
          ? `Tr.LD(${call});`
          : target === "ToDecimal"
          ? `FxDec.L(${call});`
          : target === "ToBoolean"
          ? `Tr.L(${call} ? 1 : 0);`
          : `Tr.L(${call});`,
      ]),
      "catch (OverflowException)",
      block([`Tr.L(${k});`]),
      "catch (FormatException)",
      block([`Tr.L(${k} + 1);`]),
      "catch (InvalidCastException)",
      block([`Tr.L(${k} + 2);`]),
    );
  }
  const style = rng.pick([
    "Float",
    "Any",
    "Number",
    "Currency",
    "AllowExponent | NumberStyles.AllowDecimalPoint",
  ]);
  lines.push(
    block([
      `Tr.L(decimal.TryParse("${
        rng.pick(["1.5e3", "(4)", "¤2.5", " -3 ", "1,000", "7e40"])
      }", NumberStyles.${style}, CultureInfo.InvariantCulture, out decimal ${p}) ? ${p}.GetHashCode() : -1);`,
    ]),
    `Tr.S(${d}.ToString("${rng.pick(["F2", "N1", "E2", "G"])}", ${
      rng.pick([
        "CultureInfo.InvariantCulture",
        "NumberFormatInfo.InvariantInfo",
        "null",
      ])
    }));`,
    `Tr.L((int)(FxLevel)(${d} * 2m));`,
    `FxDec.L((decimal)FxLevel.B + (decimal)(FxLevel)${small(g, ctx)});`,
  );
  return block(lines);
}
