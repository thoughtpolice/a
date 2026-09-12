// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Stylized statements that aim at the semantics a random expression rarely
// reaches: the evaluation order of compound assignments through receivers
// and indices with side effects, control leaving try/catch/finally, struct
// storage (array elements, fields, copies, boxes, constrained calls),
// records cloned through a base type, method groups, per-instantiation
// statics, property patterns, exceptions thrown from filters and finally
// blocks, and collections modified while enumerated. Every snippet logs
// what it observes into the trace.
import { indent, literal, T } from "./gen.mjs";

export function scenario(g, ctx, depth) {
  const rng = g.rng;
  const options = [
    [4, compoundAssignment],
    [3, finallyFlow],
    [2, enumerationChanges],
    [3, numericEdges],
    [2, equalityEdges],
  ];
  if (g.has("closures") && ctx.lambdaDepth === 0) {
    options.push([2, nestedClosures]);
  }
  if (
    g.has("exceptions") && g.has("filters") && g.excs.length && !ctx.inFinally
  ) options.push([3, filterStack]);
  if (
    g.has("statics") && g.has("exceptions") && g.excs.length &&
    ctx.tier < 160 && !ctx.inFinally
  ) options.push([2, staticInitialization]);
  if (g.has("generics")) options.push([2, genericHierarchy]);
  if (g.has("unions") && g.unions.length) options.push([2, unionValues]);
  // Printing an object reaches the ToString of every record that can be one,
  // and records over floats have none here (README.md, Records).
  if (
    g.has("strings") && g.has("boxing") && ctx.tier < 90 &&
    g.records.every((r) => r.printable)
  ) options.push([2, printing]);
  if (g.has("structs") && g.structs.some((s) => !s.record)) {
    options.push([3, structStorage]);
  }
  if (g.has("records") && g.records.some((r) => r.parent)) {
    options.push([2, recordWithBase]);
  }
  if (g.has("classes") && g.classes.length && ctx.tier < 90) {
    options.push([2, methodGroups]);
    options.push([2, propertyPatterns]);
  }
  if (g.has("generics")) options.push([1, genericStatics]);
  if (g.has("exceptions") && g.excs.length && !ctx.inFinally) {
    options.push([2, exceptionPaths]);
  }
  ctx.cost += 60 * ctx.weight;
  return rng.weighted(options)(g, ctx, depth);
}

const block = (lines) => `{\n${indent(lines.join("\n"))}\n}`;

// A small int, often a variable.
function small(g, ctx) {
  return `(${g.expr(ctx, T.int, 1)} & 3)`;
}

function compoundAssignment(g, ctx) {
  const rng = g.rng;
  const k = () => g.key();
  const op = () => rng.pick(["+=", "-=", "*=", "|=", "^=", "<<=", "="]);
  const rhs = () => `Tr.Pi(${k()}, ${g.expr(ctx, T.int, 1)})`;
  const lines = [];
  const kinds = ["array", "array", "string", "static"];
  const roots = g.classes.filter((c) => !c.abstract);
  if (g.has("classes") && roots.length && ctx.tier < 90) {
    kinds.push("object", "object", "property", "indexer");
  }
  const structs = g.structs.filter((s) =>
    !s.record && s.fields.some((f) => f.t.cs === "int")
  );
  if (g.has("structs") && structs.length) kinds.push("structs");
  const kind = rng.pick(kinds);
  const index = () =>
    rng.chance(0.85)
      ? `Tr.Pi(${k()}, ${small(g, ctx)})`
      : `Tr.Pi(${k()}, ${g.expr(ctx, T.int, 1)})`;
  switch (kind) {
    case "array": {
      const a = g.name("ca");
      lines.push(
        `int[] ${a} = new int[] { ${
          [0, 1, 2, 3].map(() => g.expr(ctx, T.int, 0)).join(", ")
        } };`,
      );
      const target = rng.chance(0.1)
        ? `Tr.Id(${k()}, (int[])null)`
        : `Tr.Id(${k()}, ${a})`;
      if (rng.chance(0.2)) {
        lines.push(`${target}[${index()}]${rng.pick(["++", "--"])};`);
      } else lines.push(`${target}[${index()}] ${op()} ${rhs()};`);
      lines.push(`Tr.L(${a}[0] + ${a}[1] * 3 + ${a}[2] * 7 + ${a}[3] * 11);`);
      break;
    }
    case "string": {
      const s = g.name("cs");
      lines.push(`string ${s} = ${g.expr(ctx, T.string, 1)};`);
      lines.push(`${s} += Tr.Id(${k()}, ${s} + ${g.expr(ctx, T.string, 0)});`);
      lines.push(`Tr.S(${s});`);
      break;
    }
    case "static": {
      const statics = g.statics.filter((st) => st.ready && ctx.tier < 160);
      if (!statics.length) return `Tr.L(${rhs()});`;
      const st = rng.pick(statics);
      const f = rng.pick(st.fields);
      lines.push(`${st.name}.${f.name} ${op()} ${rhs()};`);
      lines.push(`Tr.L(${st.name}.${f.name});`);
      break;
    }
    case "object":
    case "property":
    case "indexer": {
      const c = rng.pick(roots);
      const o = g.name("co");
      lines.push(`${c.name} ${o} = ${g.fresh(ctx, c.t)};`);
      const recv = rng.chance(0.1)
        ? `Tr.Id(${k()}, (${c.name})null)`
        : `Tr.Id(${k()}, ${o})`;
      if (kind === "object") {
        const f = c.all.find((x) => x.t.cs === "int");
        if (!f) return block([...lines, `Tr.L(${o} is null ? 1 : 0);`]);
        lines.push(`${recv}.${f.name} ${op()} ${rhs()};`);
        lines.push(`Tr.L(${o}.${f.name});`);
      } else if (kind === "property") {
        lines.push(
          rng.chance(0.3)
            ? `${recv}.Prop${rng.pick(["++", "--"])};`
            : `${recv}.Prop ${op()} ${rhs()};`,
        );
        lines.push(`Tr.L(${o}.PropValue);`);
      } else {
        lines.push(`${recv}[${index()}] ${op()} ${rhs()};`);
        lines.push(
          `Tr.L(${o}.Cells[0] + ${o}.Cells[1] * 3 + ${o}.Cells[2] * 7 + ${o}.Cells[3] * 11);`,
        );
      }
      break;
    }
    case "structs": {
      const s = rng.pick(structs);
      const f = s.fields.find((x) => x.t.cs === "int");
      const a = g.name("sa");
      lines.push(`${s.name}[] ${a} = new ${s.name}[3];`);
      lines.push(`${a}[${index()}].${f.name} ${op()} ${rhs()};`);
      lines.push(
        `Tr.L(${a}[0].Sum() + ${a}[1].Sum() * 3 + ${a}[2].Sum() * 7);`,
      );
      break;
    }
  }
  return block(lines);
}

// Control leaving try blocks: continue, break and return through finally,
// a return value taken before its finally changes the variable, rethrows,
// filters, and an exception from a finally replacing the one in flight.
function finallyFlow(g, ctx) {
  const rng = g.rng;
  const k = () => g.key();
  const exc = g.has("exceptions") && g.excs.length
    ? rng.pick(g.excs).name
    : null;
  const f = g.name("ff");
  const pieces = rng.shuffle([
    "if (i == (x & 3)) continue;",
    "if (i == 3 - (x & 1)) break;",
    "acc += i + 1;",
    "if (i == 2 && x > 5) return acc * 100;",
    ...(exc ? [`if (((x >> i) & 1) != 0) throw new ${exc}(i, "t");`] : []),
  ]).slice(0, rng.range(2, 4));
  const body = [`Tr.L(${k()});`, ...pieces];
  const lines = [
    `int acc = ${rng.range(0, 3)};`,
    "for (int i = 0; i < 4; i++)",
    "{",
    "    try",
    indent(block(body)),
  ];
  if (exc && rng.chance(0.7)) {
    const filter = rng.chance(0.5)
      ? ` when (Tr.F(${k()}, e.Code != (x & 1)))`
      : "";
    const handler = [`acc += 10;`, `Tr.L(e.Code);`];
    if (rng.chance(0.3)) handler.push("if (e.Code == 1) throw;");
    lines.push(`    catch (${exc} e)${filter}`, indent(block(handler)));
  }
  const fin = ["acc = acc * 2 + 1;", "Tr.L(acc);"];
  if (exc && rng.chance(0.25)) {
    fin.push(`if (i == 3 && x < 0) throw new ${exc}(99, "f");`);
  }
  if (exc && rng.chance(0.25)) {
    fin.push(
      "try",
      block([`if (acc > 20) throw new ${exc}(acc, "n");`]),
      `catch (${exc})`,
      block(["acc--;"]),
    );
  }
  lines.push("    finally", indent(block(fin)), "}", "return acc;");
  const decl = `${rng.chance(0.5) ? "static " : ""}int ${f}(int x)\n${
    block(lines)
  }`;
  const call = `Tr.L(${f}(${g.expr(ctx, T.int, 1)}));`;
  if (!exc) return `${decl}\n${call}`;
  return `${decl}\ntry\n${block([call])}\ncatch (Exception e)\n${
    block([`Tr.L(${k()});`, `Tr.L(e is ${exc} ? 1 : 2);`])
  }`;
}

// Conversions and operators over boundary values held in array elements,
// which Roslyn cannot fold, logging what each produces (or throws).
function numericEdges(g, ctx) {
  const rng = g.rng;
  const k = () => g.key();
  const types = g.scalarTypes().filter((t) => t.cs !== "bool");
  const from = rng.pick(types);
  const a = g.name("ne");
  const x = g.name("nx");
  const y = g.name("ny");
  const values = [];
  for (let i = rng.range(3, 6); i > 0; i--) values.push(literal(rng, from));
  const lines = [
    `${from.cs}[] ${a} = new ${from.cs}[] { ${values.join(", ")} };`,
  ];
  const logOf = (e, t) => g.log(ctx, e, t);
  const guarded = (
    stmt,
  ) => [
    "try",
    block([stmt]),
    "catch (Exception e)",
    block([
      `Tr.L(e is DivideByZeroException ? ${k()} : e is OverflowException ? ${k()} : ${k()});`,
    ]),
  ];
  switch (rng.int(3)) {
    case 0: {
      // Every conversion of every value to a few types.
      const targets = rng.shuffle(types).slice(0, 3);
      const body = targets.map((t) => logOf(`((${t.cs})${x})`, t));
      lines.push(`foreach (${from.cs} ${x} in ${a})`, block(body));
      break;
    }
    case 1: {
      // A binary operator over every pair.
      const wide = ["int", "uint", "long", "ulong", "float", "double"].includes(
        from.cs,
      );
      const t = wide ? from : T.int;
      const ops = ["float", "double"].includes(t.cs)
        ? ["+", "-", "*", "/"]
        : ["+", "-", "*", "/", "%", "&", "|", "^"];
      const op = rng.pick(ops);
      const cast = wide ? "" : "(int)";
      lines.push(
        `foreach (${from.cs} ${x} in ${a})`,
        block([
          `foreach (${from.cs} ${y} in ${a})`,
          block(guarded(logOf(`(${cast}${x} ${op} ${cast}${y})`, t))),
        ]),
      );
      break;
    }
    default: {
      // Shifts by boundary counts, and the Math members.
      if (["int", "uint", "long", "ulong"].includes(from.cs)) {
        const op = rng.pick(["<<", ">>", ">>>"]);
        const counts = [0, 1, 31, 32, 33, 63, 64, 65, -1].map((
          c,
        ) => (c < 0 ? `(${c})` : String(c)));
        lines.push(
          `foreach (${from.cs} ${x} in ${a})`,
          block([
            `foreach (int ${y} in new int[] { ${counts.join(", ")} })`,
            block([logOf(`(${x} ${op} ${y})`, from)]),
          ]),
        );
        if (from.cs === "int" || from.cs === "long") {
          lines.push(
            `foreach (${from.cs} ${x} in ${a})`,
            block(guarded(logOf(`Math.Abs(${x})`, from))),
          );
        }
      } else if (from.cs === "double" || from.cs === "float") {
        const m = from.cs === "double" ? "Math" : "MathF";
        const fns = rng.shuffle([
          "Floor",
          "Ceiling",
          "Truncate",
          "Round",
          "Abs",
          "Sqrt",
        ]).slice(0, 3);
        lines.push(
          `foreach (${from.cs} ${x} in ${a})`,
          block([
            ...fns.map((f) => logOf(`${m}.${f}(${x})`, from)),
            `foreach (${from.cs} ${y} in ${a})`,
            block([
              logOf(`${m}.Min(${x}, ${y})`, from),
              logOf(`${m}.Max(${x}, ${y})`, from),
              logOf(
                `${m}.CopySign(${x}, Tr.Sign${
                  from.cs === "float" ? "F" : ""
                }(${y}))`,
                from,
              ),
            ]),
          ]),
        );
      } else {
        lines.push(
          `foreach (${from.cs} ${x} in ${a})`,
          block([
            logOf(`(int)${x}`, T.int),
            logOf(`(${from.cs})(${x} + 1)`, from),
            logOf(`(${from.cs})(${x} << 9)`, from),
          ]),
        );
      }
    }
  }
  ctx.cost += 100 * ctx.weight;
  return block(lines);
}

// Equality where the CLR is particular: signed zeros and NaN under ==,
// Equals and hashing, and boxed values of different types.
function equalityEdges(g, ctx) {
  const rng = g.rng;
  const a = g.name("qe");
  const x = g.name("qx");
  const y = g.name("qy");
  const lines = [];
  const t = rng.pick(g.has("float") ? ["double", "float"] : ["long"]);
  const vals = t === "double"
    ? ["0.0", "(-0.0)", "double.NaN", "1.0", g.expr(ctx, T.double, 0)]
    : t === "float"
    ? ["0f", "(-0f)", "float.NaN", "1f", g.expr(ctx, T.float, 0)]
    : ["0L", "(-1L)", "long.MinValue", g.expr(ctx, T.long, 0)];
  lines.push(`${t}[] ${a} = new ${t}[] { ${vals.join(", ")} };`);
  const checks = rng.shuffle([
    `${x} == ${y}`,
    // Equals on the boxed value: gameplayc refuses the call on a scalar
    // receiver (see README.md).
    `((object)${x}).Equals(${y})`,
    `object.Equals(${x}, ${y})`,
    `${x} < ${y}`,
    ...(g.has("generics")
      ? [
        `new Pair<${t}, int>(${x}, 1).Equals(new Pair<${t}, int>(${y}, 1))`,
        `new Box<${t}>(${x}).Same(${y})`,
      ]
      : []),
  ]).slice(0, 3);
  lines.push(
    `foreach (${t} ${x} in ${a})`,
    block([
      `foreach (${t} ${y} in ${a})`,
      block(checks.map((c) => `Tr.L((${c}) ? 1 : 0);`)),
    ]),
  );
  if (g.has("collections")) {
    const s = g.name("qs");
    lines.push(
      `var ${s} = new HashSet<${t}>();`,
      `foreach (${t} ${x} in ${a}) Tr.L(${s}.Add(${x}) ? 1 : 0);`,
      `Tr.L(${s}.Count);`,
    );
    const d = g.name("qd");
    lines.push(
      `var ${d} = new Dictionary<${t}, int>();`,
      `foreach (${t} ${x} in ${a}) ${d}[${x}] = ${d}.Count;`,
      `foreach (var ${x}kv in ${d}) Tr.L(${x}kv.Value);`,
    );
  }
  if (g.has("boxing")) {
    const boxes = rng.shuffle([
      "(object)1",
      "(object)1L",
      "(object)(short)1",
      "(object)'a'",
      "(object)97",
      "(object)1u",
      "(object)1.0",
      "(object)true",
    ]).slice(0, 4);
    lines.push(`object[] ${a}o = new object[] { ${boxes.join(", ")} };`);
    lines.push(
      `foreach (object ${x} in ${a}o)`,
      block([
        `foreach (object ${y} in ${a}o)`,
        block([`Tr.L(${x}.Equals(${y}) ? 1 : 0);`]),
      ]),
    );
  }
  ctx.cost += 100 * ctx.weight;
  return block(lines);
}

// Closures returning closures: every call of the outer lambda gets fresh
// variables, shared by the closures it returns; the captured outer variable
// is shared by all of them.
function nestedClosures(g, ctx) {
  const rng = g.rng;
  const c = g.name("nc");
  const mk = g.name("nm");
  const p = g.name("np");
  const loc = g.name("nl");
  const f1 = g.name("nf");
  const f2 = g.name("nf");
  const lines = [
    `int ${c} = ${g.expr(ctx, T.int, 1)};`,
    `Func<int, Func<int>> ${mk} = ${p} =>`,
    block([
      `int ${loc} = ${p} * ${rng.range(2, 7)};`,
      `${c} += ${p};`,
      `return () => ${loc}++ + ${p} ${rng.pick(["+", "-", "^"])} ${c}${
        rng.chance(0.5) ? "++" : ""
      };`,
    ]) + ";",
    `var ${f1} = ${mk}(1);`,
    `var ${f2} = ${mk}(${g.expr(ctx, T.int, 1)});`,
    `Tr.L(${f1}() + ${f2}() * 3 + ${f1}() * 7);`,
    `Tr.L(${c});`,
  ];
  if (g.has("exceptions") && g.excs.length && !ctx.inFinally) {
    const x = rng.pick(g.excs).name;
    const f = g.name("ncf");
    lines.push(
      "try",
      block([`throw new ${x}(${g.expr(ctx, T.int, 1)}, "c");`]),
      `catch (${x} e)`,
      block([
        `Func<int> ${f} = () => e.Code + ${c};`,
        `${c}++;`,
        `Tr.L(${f}());`,
      ]),
    );
  }
  ctx.cost += 60 * ctx.weight;
  return block(lines);
}

// Nested try statements with filters inside a loop, left by break, continue,
// rethrow and exceptions; the filters read and write a variable the loop
// body changes.
function filterStack(g, ctx) {
  const rng = g.rng;
  const k = () => g.key();
  const x = rng.pick(g.excs).name;
  const acc = g.name("fa");
  const i = g.name("fi");
  const pick = () => rng.range(0, 3);
  const inner = [
    `${acc} += ${i};`,
    `if (${i} == ${pick()}) throw new ${x}(${i}, "i");`,
    ...rng.shuffle([
      `if (${i} == ${pick()}) break;`,
      `if (${i} == ${pick()}) continue;`,
      `Tr.L(${acc});`,
    ]).slice(0, 2),
  ];
  const handler = [`Tr.L(${k()});`, `${acc} *= 3;`];
  if (rng.chance(0.4)) handler.push(`if (${i} == ${pick()}) throw;`);
  if (rng.chance(0.3)) {
    handler.push(`if (${i} == ${pick()}) throw new ${x}(100 + ${i}, "h");`);
  }
  const lines = [
    `int ${acc} = ${g.expr(ctx, T.int, 0)};`,
    `for (int ${i} = 0; ${i} < 4; ${i}++)`,
    block([
      "try",
      block([
        "try",
        block(inner),
        `catch (${x} e) when (Tr.F(${k()}, (${acc} += 1) > ${
          rng.range(-2, 6)
        } && e.Code ${rng.pick(["==", "!=", "<="])} ${i}))`,
        block(handler),
        "finally",
        block([`Tr.L(${acc} + ${k()});`]),
      ]),
      `catch (Exception e) when (Tr.F(${k()}, e is ${x} && ${acc} ${
        rng.pick([">", "<", "!="])
      } ${rng.range(0, 20)}))`,
      block([`Tr.L(${k()});`, `if (e is ${x} f) Tr.L(f.Code);`]),
      "finally",
      block([`${acc}--;`]),
    ]),
    `Tr.L(${acc});`,
  ];
  ctx.cost += 60 * ctx.weight;
  return `try\n${block(lines)}\ncatch (Exception e)\n${
    block([`Tr.L(e is ${x} ? ${k()} : ${k()});`])
  }`;
}

// Two classes with static constructors that read each other (one sees the
// other partly initialized), one of which may fail: the same exception
// object comes back on every later use, in this entry or a later one.
function staticInitialization(g, ctx) {
  const rng = g.rng;
  const k = () => g.key();
  const a = g.name("SiA");
  const b = g.name("SiB");
  const x = rng.pick(g.excs).name;
  const fails = rng.chance(0.3);
  g.decls.push([
    6,
    `internal static class ${a}
{
    public static int X = Tr.Pi(${k()}, ${rng.range(1, 9)});
    public static int Y;

    static ${a}()
    {
        Tr.L(${k()});
        Y = ${b}.X + X;
    }
}

internal static class ${b}
{
    public static int X = Tr.Pi(${k()}, ${rng.range(1, 9)});

    static ${b}()
    {
        Tr.L(${k()});
        X += ${a}.Y + ${a}.X;
        ${
      fails
        ? `if (X ${rng.pick([">", "<", "!="])} ${
          rng.range(0, 12)
        }) throw new ${x}(X, "init");`
        : ""
    }
    }
}`,
  ]);
  const saved = g.name("sie");
  const first = rng.chance(0.5) ? a : b;
  const second = first === a ? b : a;
  const use = (cls) =>
    rng.pick([
      `Tr.L(${cls}.X);`,
      `${cls}.X += Tr.Pi(${k()}, 1);`,
      ...(cls === a ? [`Tr.L(${a}.Y);`] : []),
    ]);
  const lines = [
    `TypeInitializationException ${saved} = null;`,
    "try",
    block([use(first)]),
    "catch (TypeInitializationException e)",
    block([
      `${saved} = e;`,
      `Tr.L(e.InnerException is ${x} ? ${k()} : ${k()});`,
    ]),
    "try",
    block([use(second), use(first)]),
    "catch (TypeInitializationException e)",
    block([
      `Tr.L(object.ReferenceEquals(e, ${saved}) ? ${k()} : ${k()});`,
      `Tr.L(e.InnerException is ${x} f ? f.Code : -1);`,
    ]),
  ];
  ctx.cost += 40 * ctx.weight;
  return block(lines);
}

// A generic class hierarchy: virtual and abstract members of generic
// classes, overridden in generic and closed subclasses, base calls, and a
// generic interface.
function genericHierarchy(g, ctx) {
  const rng = g.rng;
  const k = () => g.key();
  if (!g.genericHierarchy) {
    g.genericHierarchy = true;
    g.decls.push([
      4,
      `internal abstract class GBase<TA>
{
    public TA Held;
    public int Calls;

    public abstract TA Pick(TA a, TA b);

    public virtual int Weight(TA x)
    {
        Calls++;
        Tr.L(${k()});
        return x.Equals(Held) ? 1 : 2;
    }
}

internal sealed class GDerived<TA> : GBase<TA>
{
    public override TA Pick(TA a, TA b)
    {
        Tr.L(${k()});
        Held = b;
        return a;
    }

    public override int Weight(TA x) => base.Weight(x) * 10 + Calls;
}

internal sealed class GInt : GBase<int>
{
    public override int Pick(int a, int b)
    {
        Held = a ^ b;
        return a > b ? a : b;
    }
}

internal interface IGet<TA>
{
    TA Get();
}

internal sealed class Getter<TA> : IGet<TA>
{
    private TA value;

    public Getter(TA value) => this.value = value;

    public TA Get()
    {
        Tr.L(${k()});
        return value;
    }
}`,
    ]);
  }
  const types = [
    T.int,
    T.long,
    T.bool,
    ...(g.has("strings") ? [T.string] : []),
    ...g.structs.filter((s) => !s.record).map((s) => s.t),
    ...g.records.map((r) => r.t),
  ];
  const t = rng.pick(types);
  const v = g.name("gh");
  const lines = [];
  if (t === T.int && rng.chance(0.5)) {
    lines.push(
      `GBase<int> ${v} = ${
        g.expr(ctx, T.bool, 1)
      } ? new GDerived<int>() : new GInt();`,
    );
  } else {
    lines.push(`GBase<${t.cs}> ${v} = new GDerived<${t.cs}>();`);
  }
  lines.push(
    g.log(ctx, `${v}.Pick(${g.expr(ctx, t, 1)}, ${g.expr(ctx, t, 1)})`, t) ??
      "Tr.L(0);",
  );
  lines.push(`Tr.L(${v}.Weight(${g.expr(ctx, t, 1)}));`);
  lines.push(g.log(ctx, `${v}.Held`, t) ?? "Tr.L(0);");
  const i = g.name("gi");
  lines.push(`IGet<${t.cs}> ${i} = new Getter<${t.cs}>(${g.expr(ctx, t, 1)});`);
  lines.push(g.log(ctx, `${i}.Get()`, t) ?? "Tr.L(0);");
  ctx.cost += 40 * ctx.weight;
  return block(lines);
}

// Objects printed: classes with and without ToString overrides, structs by
// their type's name, boxed scalars, strings, null in concatenations.
function printing(g, ctx) {
  const rng = g.rng;
  const items = [];
  for (
    const c of rng.shuffle(g.classes.filter((c) => !c.abstract)).slice(0, 2)
  ) items.push(g.fresh(ctx, c.t));
  for (const s of rng.shuffle(g.structs.filter((s) => !s.record)).slice(0, 1)) {
    items.push(`(object)${g.newStruct(ctx, s, 1)}`);
  }
  for (
    const r of rng.shuffle(g.records.filter((r) => r.printable)).slice(0, 1)
  ) items.push(g.newRecord(ctx, r, 1));
  items.push(
    ...rng.shuffle([
      `(object)${g.expr(ctx, T.int, 1)}`,
      `(object)${g.expr(ctx, T.long, 1)}`,
      `(object)'c'`,
      `(object)true`,
      `"s"`,
      "null",
      `(object)(byte)7`,
    ]).slice(0, 3),
  );
  const a = g.name("pr");
  const x = g.name("px");
  const lines = [
    `object[] ${a} = new object[] { ${rng.shuffle(items).join(", ")} };`,
    `foreach (object ${x} in ${a})`,
    block([
      `Tr.S(${
        rng.pick([
          `"<" + ${x} + ">"`,
          `$"[{${x}}]"`,
          `string.Concat("", ${x}?.ToString())`,
        ])
      });`,
      `if (${x} != null) Tr.S(${x}.ToString());`,
    ]),
  ];
  ctx.cost += 80 * ctx.weight;
  return block(lines);
}

// Union values in collections: switched over, compared, hashed.
function unionValues(g, ctx) {
  const rng = g.rng;
  const u = rng.pick(g.unions);
  const l = g.name("ul");
  const x = g.name("ux");
  const y = g.name("uy");
  const items = [];
  for (let i = rng.range(2, 4); i > 0; i--) {
    items.push(rng.chance(0.15) ? `default(${u.name})` : g.fresh(ctx, u.t));
  }
  const lines = [`var ${l} = new List<${u.name}> { ${items.join(", ")} };`];
  const arms = u.cases.map((c, i) => `${c.cs} => ${i + 1}`);
  lines.push(
    `foreach (var ${x} in ${l})`,
    block([
      `Tr.L(${x} switch { ${arms.join(", ")}, null => 0 });`,
      `foreach (var ${y} in ${l}) Tr.L(${x}.Equals(${y}) ? 1 : 0);`,
    ]),
  );
  // An array case has no hash here (fault 19; README.md, Objects and boxing).
  if (g.has("collections") && !u.cases.some((c) => c.k === "array")) {
    const s = g.name("us");
    lines.push(
      `var ${s} = new HashSet<${u.name}>();`,
      `foreach (var ${x} in ${l}) Tr.L(${s}.Add(${x}) ? 1 : 0);`,
      `Tr.L(${s}.Count);`,
    );
  }
  ctx.cost += 60 * ctx.weight;
  return block(lines);
}

function enumerationChanges(g, ctx) {
  const rng = g.rng;
  const k = () => g.key();
  const lines = [];
  const x = g.name("ex");
  if (rng.chance(0.5)) {
    const l = g.name("el");
    lines.push(
      `var ${l} = new List<int> { ${
        [0, 1, 2].map(() => g.expr(ctx, T.int, 0)).join(", ")
      } };`,
    );
    const change = rng.pick([
      `${l}.Add(${x});`,
      `${l}.Remove(${x});`,
      `${l}[0] = ${x};`,
      `${l}.Clear();`,
      `${l}.Insert(0, 1);`,
    ]);
    lines.push(
      `foreach (var ${x} in ${l})`,
      block([
        `Tr.L(${x});`,
        `if (${x} ${rng.pick(["==", "!=", ">"])} ${small(g, ctx)}) ${change}`,
      ]),
    );
    lines.push(`Tr.L(${l}.Count);`);
  } else {
    const d = g.name("ed");
    lines.push(
      `var ${d} = new Dictionary<int, int> { [1] = ${
        g.expr(ctx, T.int, 0)
      }, [2] = 5, [3] = 7 };`,
    );
    const change = rng.pick([
      `${d}.Remove(${x}.Key);`,
      `${d}[${x}.Key] = 9;`,
      `${d}.Add(${x}.Key + 10, 1);`,
      `${d}.TryAdd(1, 2);`,
      `${d}.Clear();`,
    ]);
    lines.push(
      `foreach (var ${x} in ${d})`,
      block([
        `Tr.L(${x}.Key * 100 + ${x}.Value);`,
        `if (${x}.Key ${rng.pick(["==", "!=", ">"])} ${
          small(g, ctx)
        }) ${change}`,
      ]),
    );
    lines.push(`Tr.L(${d}.Count);`);
  }
  return `try\n${block(lines)}\ncatch (InvalidOperationException)\n${
    block([`Tr.L(${k()});`])
  }`;
}

function structStorage(g, ctx) {
  const rng = g.rng;
  const k = () => g.key();
  const s = rng.pick(g.structs.filter((x) => !x.record));
  const a = g.name("st");
  const lines = [
    `${s.name}[] ${a} = new ${s.name}[3];`,
    `${a}[1] = ${g.fresh(ctx, s.t)};`,
  ];
  const steps = rng.shuffle([
    () => [
      `${a}[Tr.Pi(${k()}, ${small(g, ctx)}) & 1].Bump(${
        g.expr(ctx, T.int, 1)
      });`,
    ],
    () => {
      const v = g.name("sv");
      if (!g.has("foreachmutate")) {
        return [`foreach (var ${v} in ${a})`, block([`Tr.L(${v}.Sum());`])];
      }
      return [
        `foreach (var ${v} in ${a})`,
        block([`${v}.Bump(1);`, `Tr.L(${v}.Sum());`]),
      ];
    },
    () => {
      const c = g.name("sc");
      return [
        `${s.name} ${c} = ${a}[1];`,
        `${c}.Bump(5);`,
        `Tr.L(${a}[1].Sum() - ${c}.Sum());`,
      ];
    },
    () => {
      const l = g.name("sl");
      const c = g.name("sc");
      return [
        `var ${l} = new List<${s.name}> { ${a}[1] };`,
        `var ${c} = ${l}[0];`,
        `${c}.Bump(2);`,
        `Tr.L(${l}[0].Sum() * 3 + ${c}.Sum());`,
      ];
    },
    () => {
      const i = g.name("si");
      return [
        `ICounter ${i} = ${a}[0];`,
        `Tr.L(${i}.Next(3));`,
        `Tr.L(${i}.Next(1));`,
        `Tr.L(${a}[0].Sum());`,
        `Tr.L(((${s.name})${i}).Sum());`,
      ];
    },
    () =>
      g.has("generics")
        ? [
          `Tr.L(Gen.NextRef(ref ${a}[2], 2));`,
          `Tr.L(Gen.NextCopy(${a}[2], 2));`,
          `Tr.L(${a}[2].Sum());`,
        ]
        : [`Tr.L(${a}[2].Sum());`],
    () => {
      const t = g.name("so");
      return [
        `${s.name} ${t} = ${a}[2] + ${g.expr(ctx, T.int, 1)};`,
        `long ${t}l = ${t};`,
        `Tr.L(${t}l + ${a}[2].Sum());`,
      ];
    },
    () => {
      if (!g.has("closures")) return [`Tr.L(${a}[0].Sum());`];
      const c = g.name("sk");
      const f = g.name("sf");
      return [
        `${s.name} ${c} = ${a}[1];`,
        `Func<long> ${f} = () => { ${c}.Bump(1); return ${c}.Sum(); };`,
        `Tr.L(${f}() + ${f}());`,
        `Tr.L(${c}.Sum());`,
      ];
    },
    () => {
      const holders = g.classes.filter((c) =>
        !c.abstract && c.all.some((f) => f.t === s.t)
      );
      if (!holders.length || ctx.tier >= 90) return [`Tr.L(${a}[1].Sum());`];
      const c = rng.pick(holders);
      const f = c.all.find((x) => x.t === s.t);
      const o = g.name("sh");
      return [
        `${c.name} ${o} = ${g.fresh(ctx, c.t)};`,
        `if (${o} != null)`,
        block([
          `${o}.${f.name}.Bump(${g.expr(ctx, T.int, 1)});`,
          `${o}.${f.name}.Bump(1);`,
          `Tr.L(${o}.${f.name}.Sum());`,
        ]),
      ];
    },
  ]).slice(0, rng.range(2, 5));
  for (const step of steps) lines.push(...step());
  return block(lines);
}

function recordWithBase(g, ctx) {
  const rng = g.rng;
  const derived = rng.pick(g.records.filter((r) => r.parent));
  const base = derived.parent;
  const b = g.name("rb");
  const c = g.name("rc");
  const p = rng.pick(base.all);
  const lines = [
    `${base.name} ${b} = ${g.newRecord(ctx, derived, 1)};`,
    `${base.name} ${c} = ${b} with { ${p.name} = ${g.expr(ctx, p.t, 1)} };`,
    `Tr.L(${c} is ${derived.name} ? 1 : 0);`,
    `Tr.L(${c} == ${b} ? 1 : 0);`,
    `Tr.L(${c}.Equals((object)${b}) ? 1 : 0);`,
    `Tr.L(${b} == ${g.newRecord(ctx, base, 1)} ? 1 : 0);`,
  ];
  if (derived.printable) lines.push(`Tr.S(${c}.ToString());`);
  if (base.all.length >= 2) {
    const names = base.all.map(() => g.name("rd"));
    lines.push(`var (${names.join(", ")}) = ${c};`);
    base.all.forEach((q, i) => {
      const log = g.log(ctx, names[i], q.t);
      if (log) lines.push(log);
    });
  }
  return block(lines);
}

function methodGroups(g, ctx) {
  const rng = g.rng;
  const c = rng.pick(g.classes);
  const lines = [];
  const o = g.name("mo");
  lines.push(
    `${c.name} ${o} = ${
      rng.chance(0.15) ? `(${c.name})null` : g.fresh(ctx, c.t)
    };`,
  );
  const slot = c.slots.length ? rng.pick(c.slots) : null;
  if (slot) {
    const f = g.name("mg");
    const type = `Func<${
      [...slot.params, slot.ret].map((t) => t.cs).join(", ")
    }>`;
    lines.push(`${type} ${f} = ${o}.${slot.name};`);
    lines.push(
      `Tr.L(${f}(${slot.params.map((t) => g.expr(ctx, t, 1)).join(", ")}));`,
    );
    ctx.cost += (slot.cost ?? 30) * ctx.weight;
  }
  const ifaces = g.implemented(c);
  if (ifaces.length) {
    const i = rng.pick(ifaces);
    const f = g.name("mi");
    lines.push(`Func<int, int> ${f} = ((${i.name})${o}).Get${i.name};`);
    lines.push(`Tr.L(${f}(${g.expr(ctx, T.int, 1)}));`);
    ctx.cost += (i.cost ?? 30) * ctx.weight;
  }
  if (!slot && !ifaces.length) lines.push(`Tr.L(${o} is null ? 1 : 0);`);
  return block(lines);
}

function propertyPatterns(g, ctx) {
  const rng = g.rng;
  const root = g.classes[0];
  const o = g.name("po");
  const concrete = g.classes.filter((c) => !c.abstract);
  const lines = [
    `${root.name} ${o} = ${
      rng.chance(0.15)
        ? `(${root.name})null`
        : g.fresh(ctx, rng.pick(concrete).t)
    };`,
  ];
  const sub = (c) => {
    const f = c.all.find((x) => x.t.cs === "int");
    // Fields only: the order in which a pattern reads properties is
    // unspecified, so getters with side effects are left out.
    const parts = [`PropValue: ${g.openPattern(T.int)}`];
    if (f) {
      parts.unshift(
        `${f.name}: ${
          rng.chance(0.5) ? g.openPattern(T.int) : g.patternConstant(T.int)
        }`,
      );
    }
    return `${c.name} { ${
      rng.shuffle(parts).slice(0, rng.range(1, parts.length)).join(", ")
    } }`;
  };
  // Subtypes first; every arm has a property subpattern, so none subsumes another.
  const depth = (c) => {
    let d = 0;
    for (let x = c; x.parent; x = x.parent) d++;
    return d;
  };
  const arms = rng.shuffle(g.classes).slice(0, 3).sort((a, b) =>
    depth(b) - depth(a)
  );
  lines.push(
    `Tr.L(${o} switch { ${
      arms.map((c, i) => `${sub(c)} => ${i + 1}`).join(", ")
    }, null => -1, _ => 0 });`,
  );
  const c = rng.pick(g.classes);
  const q = g.name("pq");
  lines.push(`Tr.L(${o} is ${sub(c)} ${q} ? ${q}.PropValue : -2);`);
  return block(lines);
}

function genericStatics(g, ctx) {
  const rng = g.rng;
  const types = [
    T.int,
    T.long,
    T.bool,
    ...(g.has("strings") ? [T.string] : []),
    ...g.structs.filter((s) => !s.record).map((s) => s.t),
  ];
  const lines = [];
  for (let i = rng.range(1, 3); i > 0; i--) {
    const t = rng.pick(types);
    lines.push(`Tr.L(GS<${t.cs}>.Hit(${g.expr(ctx, t, 1)}));`);
  }
  const t = rng.pick(types);
  lines.push(`Tr.L(GS<${t.cs}>.Hits);`);
  return block(lines);
}

// Exceptions from filters (a throwing filter is false), from finally blocks
// (replacing the one in flight), and from constructors.
function exceptionPaths(g, ctx) {
  const rng = g.rng;
  const k = () => g.key();
  const exc = rng.pick(g.excs).name;
  const other = rng.pick(g.excs).name;
  const lines = [];
  switch (rng.int(3)) {
    case 0:
      lines.push(
        "try",
        block([`throw new ${exc}(${g.expr(ctx, T.int, 1)}, "a");`]),
        `catch (${exc} e) when (Tr.Throws(${k()}, e.Code & 1))`,
        block([`Tr.L(${k()});`]),
        `catch (${exc} e)`,
        block([`Tr.L(e.Code);`]),
      );
      break;
    case 1:
      lines.push(
        "try",
        block([
          "try",
          block([
            `if (${g.expr(ctx, T.bool, 1)}) throw new ${exc}(1, "a");`,
            `Tr.L(${k()});`,
          ]),
          "finally",
          block([
            `Tr.L(${k()});`,
            `if (${g.expr(ctx, T.bool, 1)}) throw new ${other}(2, "b");`,
          ]),
        ]),
        "catch (Exception e)",
        block([
          `Tr.L(e is ${exc} ? 1 : 0);`,
          `Tr.L(e is ${other} ? 2 : 0);`,
          `if (e is ${exc} || e is ${other}) Tr.S(e.Message);`,
        ]),
      );
      break;
    default: {
      const inner = g.name("xi");
      lines.push(
        `Exception ${inner} = null;`,
        "try",
        block([`throw new ${exc}(${g.expr(ctx, T.int, 1)}, "in");`]),
        `catch (${exc} e)`,
        block([
          `${inner} = e;`,
          "try",
          block([`throw new ${other}(3, "out", e);`]),
          `catch (${other} f) when (f.InnerException == ${inner})`,
          block([`Tr.L(${k()});`, `Tr.S(f.InnerException.Message);`]),
        ]),
      );
    }
  }
  return block(lines);
}
