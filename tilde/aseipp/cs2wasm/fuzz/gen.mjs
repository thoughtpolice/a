// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// A seeded generator of well-typed, terminating C# programs in gameplayc's
// subset. The same seed and options always give the same program.
//
// Termination and budgets: every loop has a constant trip count and a
// counter the body cannot assign; calls only go from a callable to callables
// of a higher tier (overrides share their slot's tier), so the call graph is
// acyclic but for bounded recursion helpers; and every callable carries a
// cost estimate (method entries and loop iterations, roughly what the
// compiler's fuel counts) that call sites multiply by their loop weight, so
// an entry stays under the fuel it is compiled with.
//
// CLR determinism: nothing observes hash codes, float or enum text, type
// names, or the default messages of the BCL's exceptions; classes whose
// static initializers have side effects declare static constructors (a
// beforefieldinit class may be initialized at any time before first use).

import { scenario } from "./scenarios.mjs";
import {
  featureStatement,
  LIBRARY_FEATURES,
  NEW_FEATURES,
  prelude,
} from "./features.mjs";

export const FEATURES = [
  "arith", // integer arithmetic, shifts, bit operations
  "float", // float and double arithmetic
  "conv", // numeric conversions, incl. float to integer saturation
  "math", // Math, MathF, BitOperations
  "narrow", // sbyte, byte, short, ushort, char locals
  "divfault", // unguarded division and remainder (faults)
  "control", // if, conditionals, early returns
  "loops", // for, while, do, foreach over arrays
  "switch", // switch statements and expressions, patterns
  "arrays", // arrays, jagged arrays, index faults
  "strings", // strings, concatenation, interpolation, members
  "ordinalvalue", // the value of string.CompareOrdinal, not only its sign
  "enums",
  "classes", // inheritance, virtual dispatch, constructors, field initializers
  "interfaces",
  "structs", // copies, mutation through this, nested structs
  "refout", // ref and out parameters
  "foreachmutate", // mutating struct methods called on foreach variables
  "records", // records and record structs: equality, with, deconstruction
  "unions", // C# 15 unions and their patterns
  "unionctor", // union constructors over value-type cases (new U(5))
  "generics", // generic classes, structs, methods
  "delegates", // Func/Action, lambdas, method groups
  "closures", // captured variables, loop-fresh captures, local functions
  "exceptions", // throw, try/catch/finally
  "filters", // exception filters with side effects
  "statics", // static constructors, init order, failing initializers
  "collections", // List, Dictionary, HashSet, Queue, Stack
  "boxing", // object, boxing, unboxing, type patterns on objects
  "declpatterns", // declaration patterns of value types on objects (o is int i)
  "objectpatterns", // constant and relational patterns on objects (o is 5, o is int and > 3)
  "recursion", // bounded recursion
  "scenarios", // stylized snippets: evaluation order, finally flow, struct paths... (scenarios.mjs)
  // Stylized snippets of later features (features.mjs): tuples, nullable,
  // iterators, linq, anonymous, ranges, checked, goto, formatting, sorting,
  // random, events, reflocals, types, gvm, decimals, mdarrays, spans,
  // iterators2, comparers, sorted, linq2, memory, ifaceevents, convert.
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

// Features known to trip compiler bugs today are left out of the default
// profile the CI test uses; see README.md.
export const KNOWN_ISSUES = [];

// ---------------------------------------------------------------------------
// Random numbers

export class Rng {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  next() {
    // Mulberry32.
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  int(n) {
    return n <= 1 ? 0 : this.next() % n;
  }
  range(lo, hi) {
    return lo + this.int(hi - lo + 1);
  }
  chance(p) {
    return this.next() / 4294967296 < p;
  }
  pick(list) {
    return list[this.int(list.length)];
  }
  // [[weight, value], ...]
  weighted(entries) {
    let total = 0;
    for (const [w] of entries) total += w;
    let r = this.next() / 4294967296 * total;
    for (const [w, v] of entries) {
      if ((r -= w) < 0) return v;
    }
    return entries[entries.length - 1][1];
  }
  shuffle(list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
}

// ---------------------------------------------------------------------------
// Types

const scalar = (cs) => ({ k: "scalar", cs });
export const T = {
  bool: scalar("bool"),
  sbyte: scalar("sbyte"),
  byte: scalar("byte"),
  short: scalar("short"),
  ushort: scalar("ushort"),
  int: scalar("int"),
  uint: scalar("uint"),
  long: scalar("long"),
  ulong: scalar("ulong"),
  char: scalar("char"),
  float: scalar("float"),
  double: scalar("double"),
  string: { k: "string", cs: "string" },
  object: { k: "object", cs: "object" },
};
const WIDE_INTS = ["int", "uint", "long", "ulong"];
const NARROW = ["sbyte", "byte", "short", "ushort", "char"];
const FLOATS = ["float", "double"];

const isScalar = (t) => t.k === "scalar";
const isInt = (t) => isScalar(t) && !FLOATS.includes(t.cs) && t.cs !== "bool";
const isFloat = (t) => isScalar(t) && FLOATS.includes(t.cs);
const same = (a, b) => a.cs === b.cs;
const arrayOf = (of) => ({ k: "array", of, cs: `${of.cs}[]` });
const listOf = (of) => ({ k: "list", of, cs: `List<${of.cs}>` });
const setOf = (of) => ({ k: "set", of, cs: `HashSet<${of.cs}>` });
const queueOf = (of) => ({ k: "queue", of, cs: `Queue<${of.cs}>` });
const stackOf = (of) => ({ k: "stack", of, cs: `Stack<${of.cs}>` });
const dictOf = (key, val) => ({
  k: "dict",
  key,
  val,
  cs: `Dictionary<${key.cs}, ${val.cs}>`,
});
const funcOf = (params, ret) => ({
  k: "func",
  params,
  ret,
  cs: ret
    ? `Func<${[...params, ret].map((t) => t.cs).join(", ")}>`
    : params.length
    ? `Action<${params.map((t) => t.cs).join(", ")}>`
    : "Action",
});
// A reference type: its values may be null.
const isRef = (t) =>
  [
    "string",
    "object",
    "array",
    "list",
    "set",
    "queue",
    "stack",
    "dict",
    "func",
    "class",
    "iface",
    "record",
    "box",
  ]
    .includes(t.k);
// Types whose values have no side-effect-free, CLR-deterministic text.
const printable = (t) => (isScalar(t) && !isFloat(t)) || t.k === "string";

// ---------------------------------------------------------------------------
// Literals

const INT_VALUES = [
  0,
  1,
  -1,
  2,
  3,
  5,
  7,
  8,
  15,
  16,
  31,
  32,
  33,
  63,
  64,
  100,
  127,
  128,
  255,
  256,
  -128,
  -129,
  1000,
  65535,
  65536,
  -65536,
  0x7fffffff,
  -0x80000000,
  0x40000000,
  123456789,
];
const FLOAT_SPECIAL = [
  0,
  -0,
  1,
  -1,
  0.5,
  1.5,
  2.5,
  -2.5,
  3.5,
  0.1,
  1e10,
  -1e10,
  2147483648,
  -2147483648,
  2147483520,
  4294967296,
  9.223372036854776e18,
  1.8446744073709552e19,
  16777217,
  3.4028234663852886e38,
  1.401298464324817e-45,
  1e-7,
  100.75,
  -7.25,
  255.5,
  65535.9,
  NaN,
  Infinity,
  -Infinity,
];
const DOUBLE_EXTRA = [
  1e308,
  -1e308,
  5e-324,
  2.2250738585072014e-308,
  9007199254740993,
  4503599627370496.5,
  0.30000000000000004,
  1e300,
  4294967295.5,
  -9.223372036854778e18,
];

function intText(v) {
  if (v === -0x80000000) return "int.MinValue";
  return v < 0 ? `(${v})` : `${v}`;
}

function literal(rng, t) {
  switch (t.cs) {
    case "bool":
      return rng.chance(0.5) ? "true" : "false";
    case "int":
      return intText(rng.chance(0.8) ? rng.pick(INT_VALUES) : (rng.next() | 0));
    case "uint": {
      const v = rng.chance(0.7)
        ? rng.pick([
          0,
          1,
          2,
          7,
          31,
          32,
          255,
          65536,
          0x7fffffff,
          0x80000000,
          0xffffffff,
          0xfffffffe,
        ])
        : rng.next();
      return `${v >>> 0}u`;
    }
    case "long": {
      const picks = [
        "0L",
        "1L",
        "(-1L)",
        "long.MaxValue",
        "long.MinValue",
        "4294967296L",
        "(-4294967296L)",
        "2147483648L",
        "(-2147483649L)",
        "9007199254740993L",
        "0x123456789abcL",
      ];
      if (rng.chance(0.7)) return rng.pick(picks);
      const v = BigInt.asIntN(
        64,
        (BigInt(rng.next()) << 32n) | BigInt(rng.next()),
      );
      return v < 0n
        ? (v === -(1n << 63n) ? "long.MinValue" : `(${v}L)`)
        : `${v}L`;
    }
    case "ulong": {
      const picks = [
        "0UL",
        "1UL",
        "ulong.MaxValue",
        "9223372036854775808UL",
        "4294967295UL",
        "4294967296UL",
        "18446744073709551614UL",
      ];
      if (rng.chance(0.7)) return rng.pick(picks);
      return `${(BigInt(rng.next()) << 32n) | BigInt(rng.next())}UL`;
    }
    case "sbyte":
      return `((sbyte)${intText(rng.pick([0, 1, -1, 127, -128, 5, -100]))})`;
    case "byte":
      return `((byte)${rng.pick([0, 1, 127, 128, 200, 255, 7])})`;
    case "short":
      return `((short)${
        intText(rng.pick([0, 1, -1, 32767, -32768, 1000, -300]))
      })`;
    case "ushort":
      return `((ushort)${rng.pick([0, 1, 32767, 32768, 65535, 1000])})`;
    case "char": {
      const c = rng.pick([
        48,
        65,
        97,
        122,
        0,
        32,
        0x7f,
        0xff,
        0x100,
        0xd800,
        0xffff,
        0x3a9,
      ]);
      return c >= 0x20 && c < 0x7f && c !== 39 && c !== 92
        ? `'${String.fromCharCode(c)}'`
        : `'\\u${c.toString(16).padStart(4, "0")}'`;
    }
    case "float": {
      let v = rng.chance(0.75)
        ? rng.pick(FLOAT_SPECIAL)
        : Math.round((rng.next() / 4294967296 - 0.5) * 2e6) / 64;
      v = Math.fround(v);
      return floatText(v, "f", "float");
    }
    case "double": {
      const v = rng.chance(0.75)
        ? rng.pick([...FLOAT_SPECIAL, ...DOUBLE_EXTRA])
        : (rng.next() / 4294967296 - 0.5) * Math.pow(2, rng.range(-20, 70));
      return floatText(v, "d", "double");
    }
  }
  throw new Error(`no literal for ${t.cs}`);
}

function floatText(v, suffix, type) {
  if (Number.isNaN(v)) return `${type}.NaN`;
  if (v === Infinity) return `${type}.PositiveInfinity`;
  if (v === -Infinity) return `${type}.NegativeInfinity`;
  if (Object.is(v, -0)) return `(-0.0${suffix})`;
  const text = String(Math.abs(v)) + suffix;
  return v < 0 ? `(-${text})` : text;
}

// The values the driver passes to entries: {text} is what the oracle parses.
function argumentValue(rng, t) {
  switch (t.cs) {
    case "bool":
      return rng.chance(0.5) ? "1" : "0";
    case "int":
      return String(rng.chance(0.6) ? rng.pick(INT_VALUES) : rng.next() | 0);
    case "uint":
      return String(
        rng.chance(0.5)
          ? rng.pick([0, 1, 3, 0xffffffff, 0x80000000])
          : rng.next(),
      );
    case "long":
      return String(
        rng.chance(0.5)
          ? rng.pick([0n, 1n, -1n, 1n << 40n, -(1n << 63n), (1n << 63n) - 1n])
          : BigInt.asIntN(64, (BigInt(rng.next()) << 32n) | BigInt(rng.next())),
      );
    case "ulong":
      return String(
        rng.chance(0.5)
          ? rng.pick([0n, 1n, (1n << 64n) - 1n, 1n << 63n])
          : (BigInt(rng.next()) << 32n) | BigInt(rng.next()),
      );
    case "sbyte":
      return String(rng.range(-128, 127));
    case "byte":
      return String(rng.range(0, 255));
    case "short":
      return String(rng.range(-32768, 32767));
    case "ushort":
    case "char":
      return String(rng.range(0, 65535));
    case "float": {
      const v = Math.fround(
        rng.chance(0.6)
          ? rng.pick(FLOAT_SPECIAL)
          : (rng.next() / 4294967296 - 0.5) * 1e5,
      );
      return Object.is(v, -0) ? "-0" : String(v);
    }
    case "double": {
      const v = rng.chance(0.6)
        ? rng.pick([...FLOAT_SPECIAL, ...DOUBLE_EXTRA])
        : (rng.next() / 4294967296 - 0.5) * 1e9;
      return Object.is(v, -0) ? "-0" : String(v);
    }
  }
  throw new Error(`no argument for ${t.cs}`);
}

// ---------------------------------------------------------------------------
// Scopes and function contexts

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.vars = [];
  }
  all() {
    const out = [...this.vars];
    for (let s = this.parent; s; s = s.parent) out.push(...s.vars);
    return out;
  }
}

// Fuel estimates: calls and loop iterations the compiler charges.
const FN_BUDGET = 4000;
const ENTRY_BUDGET = 60000;

// ---------------------------------------------------------------------------
// The generator

export function generate(seed, options = {}) {
  const features = new Set(options.features ?? FEATURES);
  const g = new Generator(seed >>> 0, features, options.size ?? 1);
  return g.program();
}

class Generator {
  constructor(seed, features, size) {
    this.rng = new Rng(seed ^ 0x9e3779b9);
    this.seed = seed;
    this.f = features;
    this.size = size;
    this.counter = 0;
    this.logKey = 1;
    this.callables = [];
    this.enums = [];
    this.structs = [];
    this.classes = [];
    this.ifaces = [];
    this.records = [];
    this.unions = [];
    this.excs = [];
    this.statics = [];
    this.boxes = [];
    this.decls = []; // [order, text]
  }

  has(feature) {
    return this.f.has(feature);
  }
  name(prefix) {
    return `${prefix}${this.counter++}`;
  }
  key() {
    return this.logKey++;
  }

  // -------------------------------------------------------------------------
  // Type choices

  scalarTypes() {
    const out = [T.int, T.long, T.bool];
    if (this.has("arith")) out.push(T.uint, T.ulong);
    if (this.has("float")) out.push(T.float, T.double);
    if (this.has("narrow")) {
      out.push(T.sbyte, T.byte, T.short, T.ushort, T.char);
    }
    return out;
  }

  // A type for a local, field or parameter.
  valueType(depth = 0, allowFunc = true) {
    const rng = this.rng;
    const options = [[10, () => rng.pick(this.scalarTypes())], [
      4,
      () => T.int,
    ]];
    if (this.has("strings")) options.push([2, () => T.string]);
    if (this.has("enums") && this.enums.length) {
      options.push([1, () => rng.pick(this.enums).t]);
    }
    if (depth < 2) {
      if (this.has("arrays")) {
        options.push([2, () => arrayOf(this.elementType(depth + 1))]);
      }
      if (this.has("classes") && this.classes.length) {
        options.push([3, () => rng.pick(this.classes).t]);
      }
      if (this.has("interfaces") && this.ifaces.length) {
        options.push([1, () => rng.pick(this.ifaces).t]);
      }
      if (this.has("structs") && this.structs.length) {
        options.push([2, () => rng.pick(this.structs).t]);
      }
      if (this.has("records") && this.records.length) {
        options.push([2, () => rng.pick(this.records).t]);
      }
      if (this.has("unions") && this.unions.length) {
        options.push([1, () => rng.pick(this.unions).t]);
      }
      if (this.has("generics") && this.boxes.length) {
        options.push([1, () => rng.pick(this.boxes).t]);
      }
      if (this.has("collections")) {
        options.push([3, () => this.collectionType(depth + 1)]);
      }
      if (this.has("boxing")) options.push([1, () => T.object]);
      if (allowFunc && this.has("delegates")) {
        options.push([1, () => this.funcType()]);
      }
    }
    return rng.weighted(options)();
  }

  elementType(depth) {
    const rng = this.rng;
    const options = [[6, () => T.int], [3, () => rng.pick(this.scalarTypes())]];
    if (this.has("strings")) options.push([1, () => T.string]);
    if (this.has("structs") && this.structs.length) {
      options.push([1, () => rng.pick(this.structs).t]);
    }
    if (this.has("classes") && this.classes.length) {
      options.push([1, () => rng.pick(this.classes).t]);
    }
    if (this.has("records") && this.records.length) {
      options.push([1, () => rng.pick(this.records).t]);
    }
    if (depth < 2 && this.has("arrays")) {
      options.push([1, () => arrayOf(T.int)]);
    }
    return rng.weighted(options)();
  }

  keyType() {
    const rng = this.rng;
    const options = [[6, () => T.int], [1, () => T.long], [1, () => T.char]];
    if (this.has("strings")) options.push([2, () => T.string]);
    if (this.has("enums") && this.enums.length) {
      options.push([2, () => rng.pick(this.enums).t]);
    }
    if (this.has("records") && this.records.length) {
      options.push([1, () => rng.pick(this.records).t]);
    }
    if (this.has("structs") && this.structs.length) {
      options.push([1, () => rng.pick(this.structs).t]);
    }
    if (this.has("classes") && this.classes.length) {
      options.push([1, () => rng.pick(this.classes).t]);
    }
    if (this.has("float")) options.push([1, () => T.double]);
    return rng.weighted(options)();
  }

  collectionType(depth) {
    const rng = this.rng;
    return rng.weighted([
      [5, () => listOf(this.elementType(depth))],
      [4, () => dictOf(this.keyType(), this.elementType(depth))],
      [2, () => setOf(this.keyType())],
      [1, () => queueOf(this.elementType(depth))],
      [1, () => stackOf(this.elementType(depth))],
    ])();
  }

  funcType() {
    const rng = this.rng;
    const n = rng.int(3);
    const params = [];
    for (let i = 0; i < n; i++) {
      params.push(rng.pick([T.int, T.int, T.long, T.double, T.bool]));
    }
    const ret = rng.chance(0.85)
      ? rng.pick([T.int, T.int, T.long, T.bool, T.double])
      : null;
    return funcOf(params, ret);
  }

  // -------------------------------------------------------------------------
  // Declarations

  declareTypes() {
    const rng = this.rng;
    if (this.has("enums")) {
      for (let i = rng.range(1, 2); i > 0; i--) this.declareEnum();
    }
    if (this.has("exceptions")) this.declareExceptions();
    if (this.has("structs")) {
      for (let i = rng.range(1, 2); i > 0; i--) this.declareStruct();
    }
    if (this.has("records")) {
      for (let i = rng.range(1, 2); i > 0; i--) this.declareRecord();
    }
    if (this.has("interfaces")) {
      for (let i = rng.range(1, 2); i > 0; i--) this.declareInterface();
    }
    if (this.has("classes")) this.declareHierarchy();
    if (this.has("generics")) this.declareGenerics();
    if (this.has("unions")) {
      for (let i = rng.range(1, 2); i > 0; i--) this.declareUnion();
    }
    if (this.has("statics")) {
      for (let i = rng.range(1, 3); i > 0; i--) this.declareStatic();
    }
  }

  declareEnum() {
    const rng = this.rng;
    const name = this.name("En");
    const under = rng.pick(["int", "byte", "long", "short", "uint"]);
    const flags = rng.chance(0.3);
    const count = rng.range(2, 5);
    const members = [];
    let value = rng.int(3);
    for (let i = 0; i < count; i++) {
      members.push({ name: `M${i}`, value: flags ? 1 << i : value });
      value += rng.range(1, 3);
    }
    const e = { name, under, members, t: { k: "enum", cs: name } };
    e.t.decl = e;
    this.enums.push(e);
    this.decls.push([
      0,
      `${flags ? "[Flags]\n" : ""}internal enum ${name} : ${under}\n{\n${
        members.map((m) => `    ${m.name} = ${m.value},`).join("\n")
      }\n}`,
    ]);
  }

  declareExceptions() {
    const rng = this.rng;
    const bases = [
      "Exception",
      "InvalidOperationException",
      "ArgumentException",
      "Exception",
      "ApplicationException",
    ];
    for (let i = rng.range(1, 3); i > 0; i--) {
      const name = this.name("Err");
      const parent = this.excs.length && rng.chance(0.3)
        ? rng.pick(this.excs).name
        : rng.pick(bases);
      const user = this.excs.find((e) => e.name === parent);
      const x = { name, parent, user: true, depth: user ? user.depth + 1 : 5 };
      this.excs.push(x);
      const ctor = user
        ? `    public ${name}(int code, string message) : base(code, message) { }\n    public ${name}(int code, string message, Exception inner) : base(code, message, inner) { }`
        : `    public ${name}(int code, string message) : base(message) { Code = code; }\n    public ${name}(int code, string message, Exception inner) : base(message, inner) { Code = code; }`;
      this.decls.push([
        1,
        `internal class ${name} : ${parent}\n{\n${
          user ? "" : "    public int Code;\n"
        }${ctor}\n}`,
      ]);
    }
  }

  // Scalar fields plus perhaps a nested struct.
  declareStruct() {
    const rng = this.rng;
    const name = this.name("S");
    const fields = [];
    const n = rng.range(1, 3);
    for (let i = 0; i < n; i++) {
      fields.push({
        name: `F${i}`,
        t: rng.pick([T.int, T.int, T.long, ...this.scalarTypes()]),
      });
    }
    if (this.structs.length && rng.chance(0.3)) {
      fields.push({ name: `N${n}`, t: rng.pick(this.structs).t });
    }
    const s = { name, fields, t: { k: "struct", cs: name }, methods: [] };
    s.t.decl = s;
    this.structs.push(s);
  }

  declareRecord() {
    const rng = this.rng;
    const isStruct = rng.chance(0.3);
    const name = this.name(isStruct ? "RS" : "R");
    const params = [];
    for (let i = rng.range(1, 3); i > 0; i--) {
      params.push({
        name: `Q${this.counter++}`,
        t: rng.pick([
          T.int,
          T.int,
          T.long,
          T.bool,
          ...(this.has("strings") ? [T.string] : []),
          ...(this.has("float") ? [T.double] : []),
        ]),
      });
    }
    let parent = null;
    if (!isStruct) {
      const bases = this.records.filter((r) => !r.isStruct && !r.sealed);
      if (bases.length && rng.chance(0.4)) parent = rng.pick(bases);
    }
    const all = parent ? [...parent.all, ...params] : params;
    const r = {
      name,
      isStruct,
      params,
      all,
      parent,
      sealed: !isStruct && rng.chance(0.3),
      t: { k: isStruct ? "struct" : "record", cs: name },
    };
    r.t.decl = r;
    r.t.record = r;
    // Records with float members have no CLR-matching ToString here.
    r.printable = all.every((p) => printable(p.t));
    // ToString through a base dispatches to the derived record's.
    if (!r.printable) {
      for (let x = parent; x; x = x.parent) x.printable = false;
    }
    this.records.push(r);
    const header = isStruct
      ? "internal record struct"
      : `internal ${r.sealed ? "sealed " : ""}record`;
    const ps = all.map((p) => `${p.t.cs} ${p.name}`).join(", ");
    const base = parent
      ? ` : ${parent.name}(${parent.all.map((p) => p.name).join(", ")})`
      : "";
    this.decls.push([2, `${header} ${name}(${ps})${base};`]);
  }

  declareInterface() {
    const name = this.name("I");
    const i = {
      name,
      t: { k: "iface", cs: name },
      method: { name: `Get${name}`, tier: 120 + this.ifaces.length },
      prop: `P${name}`,
    };
    i.t.decl = i;
    this.ifaces.push(i);
    this.decls.push([
      3,
      `internal interface ${name}\n{\n    int Get${name}(int x);\n    int P${name} { get; }\n}`,
    ]);
  }

  // A small hierarchy: a root (abstract or not), subclasses, sealed leaves.
  declareHierarchy() {
    const rng = this.rng;
    const count = rng.range(2, 4);
    for (let i = 0; i < count; i++) {
      const name = this.name("C");
      const parent = i === 0
        ? null
        : rng.pick(this.classes.filter((c) => !c.sealed));
      const abstract = i === 0 && rng.chance(0.4);
      const sealed = i > 0 && rng.chance(0.4);
      const fields = [];
      for (let j = rng.range(1, 2); j > 0; j--) {
        fields.push({
          name: `${name}f${j}`,
          t: rng.pick([T.int, T.int, T.long, ...this.scalarTypes()]),
          init: rng.chance(0.4),
        });
      }
      if (this.structs.length && rng.chance(0.3)) {
        fields.push({ name: `${name}s`, t: rng.pick(this.structs).t });
      }
      const c = {
        name,
        parent,
        abstract,
        sealed,
        fields,
        all: parent ? [...parent.all, ...fields] : fields,
        t: { k: "class", cs: name },
        ifaces: [],
        slots: parent ? [...parent.slots] : [],
        staticCtor: this.has("statics") && rng.chance(0.2),
      };
      c.t.decl = c;
      if (!parent) {
        for (let j = rng.range(1, 2); j > 0; j--) {
          const params = rng.chance(0.5)
            ? [T.int]
            : [T.int, rng.pick([T.long, T.int, T.bool])];
          c.slots.push({
            name: `V${j}`,
            params,
            ret: rng.pick([T.int, T.long]),
            tier: 100 + this.counter++,
            owner: c,
            abstract: abstract && rng.chance(0.5),
          });
        }
      }
      if (this.ifaces.length && rng.chance(0.6)) {
        for (
          const iface of rng.shuffle(this.ifaces).slice(
            0,
            rng.range(1, this.ifaces.length),
          )
        ) {
          if (
            !c.ifaces.includes(iface) &&
            !(parent && this.implemented(parent).includes(iface))
          ) c.ifaces.push(iface);
        }
      }
      this.classes.push(c);
    }
    // Abstract slots must be implemented by concrete subclasses: every
    // concrete class overrides what its chain leaves abstract.
  }

  implemented(c) {
    const out = [];
    for (let x = c; x; x = x.parent) out.push(...x.ifaces);
    return out;
  }

  declareGenerics() {
    const rng = this.rng;
    // Box<TA>: a generic class, instantiated over a few element types.
    const args = rng.shuffle([
      T.int,
      T.long,
      T.double,
      T.string,
      T.bool,
      ...this.structs.map((s) => s.t),
      ...this.classes.map((c) => c.t),
      ...this.records.map((r) => r.t),
    ])
      .filter((t) => this.has("strings") || t !== T.string)
      .slice(0, rng.range(1, 3));
    this.decls.push([
      4,
      `internal sealed class Box<TA>
{
    public TA Value;
    public int Reads;
    public Box(TA value) { Value = value; }
    public TA Get() { Reads++; return Value; }
    public bool Same(TA other) => Value.Equals(other);
    public TA Swap(TA other) { TA old = Value; Value = other; return old; }
}

internal struct Pair<TA, TB>
{
    public TA First;
    public TB Second;
    public Pair(TA first, TB second) { First = first; Second = second; }
    public void SetFirst(TA value) { First = value; }
}

internal static class Gen
{
    public static TA Pick<TA>(bool first, TA a, TA b) => first ? a : b;
    public static int Count<TA>(TA[] items, TA value)
    {
        int n = 0;
        foreach (TA item in items)
        {
            if (item.Equals(value)) n++;
        }
        return n;
    }
    public static TA Last<TA>(List<TA> items, TA fallback) => items.Count == 0 ? fallback : items[items.Count - 1];
    public static void Swap<TA>(ref TA a, ref TA b) { TA t = a; a = b; b = t; }
    public static TA Default<TA>() => default(TA);
    public static TA Make<TA>() where TA : new() => new TA();
    public static int NextRef<TA>(ref TA counter, int d) where TA : ICounter => counter.Next(d);
    public static int NextCopy<TA>(TA counter, int d) where TA : ICounter => counter.Next(d) + counter.Next(d);
}

internal static class GS<TA>
{
    public static int Hits;
    public static TA Last;

    static GS()
    {
        Tr.L(Hits + 1000);
    }

    public static int Hit(TA value)
    {
        Last = value;
        return ++Hits;
    }
}`,
    ]);
    for (const a of args) {
      this.boxes.push({ t: { k: "box", cs: `Box<${a.cs}>`, arg: a } });
    }
  }

  declareUnion() {
    const rng = this.rng;
    const name = this.name("U");
    const pool = [T.int, T.long, T.bool, T.double].filter((t) =>
      this.has("float") || t !== T.double
    );
    const cases = [];
    const scalarCase = rng.pick(pool);
    if (rng.chance(0.8)) cases.push(scalarCase);
    if (this.has("strings") && rng.chance(0.4)) cases.push(T.string);
    for (
      const c of rng.shuffle(this.classes.filter((c) => c.sealed)).slice(0, 2)
    ) cases.push(c.t);
    for (const s of rng.shuffle(this.structs).slice(0, 1)) {
      if (rng.chance(0.5)) cases.push(s.t);
    }
    for (const r of rng.shuffle(this.records).slice(0, 1)) {
      if (rng.chance(0.5)) cases.push(r.t);
    }
    if (this.has("arrays") && rng.chance(0.2)) cases.push(arrayOf(T.int));
    if (cases.length < 2) cases.push(T.int === scalarCase ? T.long : T.int);
    const u = { name, cases, t: { k: "union", cs: name } };
    u.t.decl = u;
    this.unions.push(u);
    this.decls.push([
      6,
      `internal union ${name}(${cases.map((t) => t.cs).join(", ")});`,
    ]);
  }

  declareStatic() {
    const rng = this.rng;
    const name = this.name("St");
    const fields = [];
    for (let i = rng.range(1, 3); i > 0; i--) {
      fields.push({
        name: `${name}v${i}`,
        t: rng.pick([T.int, T.long, T.int]),
      });
    }
    const st = {
      name,
      fields,
      fails: this.has("exceptions") && this.excs.length > 0 && rng.chance(0.1),
    };
    this.statics.push(st);
  }

  // -------------------------------------------------------------------------
  // Callables

  addCallable(c) {
    this.callables.push(c);
    return c;
  }

  // Callables reachable from a context (only higher tiers).
  callable(ctx, ret) {
    return this.callables.filter((c) =>
      c.tier > ctx.tier && c.ready &&
      (ret === undefined || (c.ret && same(c.ret, ret))) &&
      c.cost * ctx.weight <= ctx.budget - ctx.cost
    );
  }

  // -------------------------------------------------------------------------
  // Expressions

  // An expression of exactly type t.
  expr(ctx, t, depth = 2) {
    const rng = this.rng;
    if (depth <= 0) return this.leaf(ctx, t, true);
    if (rng.chance(0.25)) {
      const leaf = this.leaf(ctx, t);
      if (leaf !== null) return leaf;
    }
    const builders = this.builders(ctx, t, depth);
    if (builders.length === 0) {
      const leaf = this.leaf(ctx, t, true);
      if (leaf !== null) return leaf;
      throw new Error(`cannot build ${t.cs}`);
    }
    return rng.weighted(builders)();
  }

  // A variable, field, literal or other simple value of type t; null if none.
  leaf(ctx, t, force = false) {
    const rng = this.rng;
    const options = [];
    const vars = this.readable(ctx).filter((v) => same(v.t, t));
    if (vars.length) options.push([6, () => rng.pick(vars).name]);
    const fields = this.fieldReads(ctx, t);
    if (fields.length) options.push([2, () => rng.pick(fields)]);
    if (isScalar(t)) options.push([vars.length ? 1 : 3, () => literal(rng, t)]);
    if (t.k === "string") options.push([2, () => this.stringLiteral()]);
    if (t.k === "enum") {
      options.push([3, () => `${t.cs}.${rng.pick(t.decl.members).name}`]);
    }
    if (options.length === 0) {
      if (!force) return null;
      return this.fresh(ctx, t);
    }
    return rng.weighted(options)();
  }

  stringLiteral() {
    return JSON.stringify(
      this.rng.pick([
        "",
        "a",
        "ab",
        "hello",
        "x-y",
        "été",
        "0123456789",
        "  ",
        "A\tB",
        "zz",
        "😀",
      ]),
    )
      .replace(
        /[\u007f-￿]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
  }

  // A newly built value of type t (for references: a new object).
  fresh(ctx, t) {
    const rng = this.rng;
    const d = 1;
    switch (t.k) {
      case "scalar":
        return literal(rng, t);
      case "string":
        return this.stringLiteral();
      case "enum":
        return `${t.cs}.${rng.pick(t.decl.members).name}`;
      case "array":
        this.alloc(ctx, 4);
        if (rng.chance(0.5)) {
          const n = rng.range(0, 4);
          const items = [];
          for (let i = 0; i < n; i++) items.push(this.expr(ctx, t.of, 0));
          return t.of.k === "array"
            ? `new ${t.of.of.cs}[][] { ${items.join(", ")} }`
            : `new ${t.of.cs}[] { ${items.join(", ")} }`;
        }
        return t.of.k === "array"
          ? `new ${t.of.of.cs}[${rng.range(0, 4)}][]`
          : `new ${t.of.cs}[${this.arrayLength(ctx)}]`;
      case "list":
      case "set":
      case "queue":
      case "stack": {
        this.alloc(ctx, 4);
        if (t.k !== "queue" && t.k !== "stack" && rng.chance(0.4)) {
          const items = [];
          for (let i = rng.range(0, 3); i > 0; i--) {
            items.push(this.expr(ctx, t.of, 0));
          }
          return `new ${t.cs} { ${items.join(", ")} }`;
        }
        return t.k === "list" && rng.chance(0.2)
          ? `new ${t.cs}(${rng.range(0, 5)})`
          : `new ${t.cs}()`;
      }
      case "dict": {
        this.alloc(ctx, 4);
        if (rng.chance(0.3)) {
          const items = [];
          for (let i = rng.range(1, 2); i > 0; i--) {
            items.push(
              `[${this.expr(ctx, t.key, 0)}] = ${this.expr(ctx, t.val, 0)}`,
            );
          }
          return `new ${t.cs} { ${items.join(", ")} }`;
        }
        return `new ${t.cs}()`;
      }
      case "class":
        return this.construct(
          ctx,
          rng.pick(this.concreteSubclasses(t.decl)),
          d,
        );
      case "iface": {
        const impls = this.classes.filter((c) =>
          !c.abstract && this.implemented(c).includes(t.decl)
        );
        if (!impls.length) return `((${t.cs})null)`;
        return this.construct(ctx, rng.pick(impls), d);
      }
      case "struct":
        if (t.record) return this.newRecord(ctx, t.record, d);
        return this.newStruct(ctx, t.decl, d);
      case "record": {
        const subs = this.records.filter((r) =>
          !r.isStruct && this.recordDerives(r, t.record)
        );
        return this.newRecord(ctx, rng.pick(subs), d);
      }
      case "union": {
        const c = rng.pick(t.decl.cases);
        if (rng.chance(0.1)) return `default(${t.cs})`;
        const valueCase = c.k === "scalar" || c.k === "struct" ||
          c.k === "enum";
        const ctor = rng.chance(0.3) && (!valueCase || this.has("unionctor"));
        return ctor
          ? `new ${t.cs}(${this.expr(ctx, c, 0)})`
          : `(${t.cs})(${this.expr(ctx, c, 0)})`;
      }
      case "box":
        this.alloc(ctx, 3);
        return `new ${t.cs}(${this.expr(ctx, t.arg, 0)})`;
      case "func":
        return this.lambda(ctx, t);
      case "object": {
        const inner = this.valueType(2, false);
        return `(object)(${this.expr(ctx, inner, 0)})`;
      }
    }
    throw new Error(`cannot build ${t.cs}`);
  }

  arrayLength(ctx) {
    const rng = this.rng;
    if (this.has("arrays") && this.has("divfault") && rng.chance(0.05)) {
      // Perhaps negative (OverflowException, fault 4), but never above the
      // maximum array length, whose fault 4 the CLR has no counterpart of.
      return `Tr.Pi(${this.key()}, ${this.expr(ctx, T.int, 0)} % 1000)`;
    }
    if (rng.chance(0.3)) return `(${this.expr(ctx, T.int, 1)} & 7)`;
    return String(rng.range(0, 5));
  }

  alloc(ctx, units) {
    ctx.cost += units * ctx.weight / 8;
  }

  recordDerives(r, base) {
    for (let x = r; x; x = x.parent) if (x === base) return true;
    return false;
  }

  concreteSubclasses(c) {
    return this.classes.filter((x) => !x.abstract && this.derives(x, c));
  }

  derives(x, c) {
    for (let y = x; y; y = y.parent) if (y === c) return true;
    return false;
  }

  construct(ctx, c, depth) {
    this.alloc(ctx, 8);
    const ctor = c.ctor;
    if (
      ctor && ctor.tier > ctx.tier &&
      ctx.cost + ctor.cost * ctx.weight <= ctx.budget
    ) {
      ctx.cost += ctor.cost * ctx.weight;
      return `new ${c.name}(${
        ctor.params.map((p) => this.expr(ctx, p, depth - 1)).join(", ")
      })`;
    }
    return `((${c.name})null)`;
  }

  newStruct(ctx, s, depth) {
    const rng = this.rng;
    if (rng.chance(0.15)) return `default(${s.name})`;
    if (rng.chance(0.1)) return `new ${s.name}()`;
    if (rng.chance(0.2)) {
      return `new ${s.name} { ${
        s.fields.filter(() => rng.chance(0.7)).map((f) =>
          `${f.name} = ${this.expr(ctx, f.t, 0)}`
        ).join(", ")
      } }`;
    }
    return `new ${s.name}(${
      s.fields.map((f) => this.expr(ctx, f.t, depth - 1)).join(", ")
    })`;
  }

  newRecord(ctx, r, depth) {
    this.alloc(ctx, 6);
    return `new ${r.name}(${
      r.all.map((p) => this.expr(ctx, p.t, depth - 1)).join(", ")
    })`;
  }

  // Variables visible here (captured variables only from capturable ones).
  // A filter's selector captures what it reads, like a lambda (README.md,
  // Exceptions), so filters read only capturable variables and the catch
  // variable.
  readable(ctx) {
    return ctx.scope.all().filter((v) =>
      (v.fn === ctx.fn && !ctx.inFilter) || v.capturable ||
      (ctx.inFilter && v.filterOk)
    );
  }

  assignable(ctx) {
    return this.readable(ctx).filter((v) => v.mutable);
  }

  // Field reads of type t from locals and this.
  fieldReads(ctx, t) {
    const out = [];
    for (const v of this.readable(ctx)) {
      if (v.t.k === "class" || v.t.k === "struct" && !v.t.record) {
        for (const f of v.t.decl.all ?? v.t.decl.fields) {
          if (same(f.t, t)) out.push(`${v.name}.${f.name}`);
        }
      }
      if (v.t.record) {
        for (const p of v.t.record.all) {
          if (same(p.t, t)) out.push(`${v.name}.${p.name}`);
        }
      }
      if (v.t.k === "box" && same(v.t.arg, t)) out.push(`${v.name}.Value`);
    }
    if (ctx.self) {
      for (const f of ctx.self.all ?? ctx.self.fields) {
        if (same(f.t, t)) out.push(`this.${f.name}`);
      }
    }
    for (const st of this.statics) {
      if (st.ready && ctx.tier < 160) {
        for (const f of st.fields) {
          if (same(f.t, t)) out.push(`${st.name}.${f.name}`);
        }
      }
    }
    return out;
  }

  builders(ctx, t, depth) {
    const rng = this.rng;
    const out = [];
    const sub = (u) => this.expr(ctx, u, depth - 1);
    const callables = this.callable(ctx, t).filter((c) =>
      c.params.every((p) => p.mode === "val")
    );
    if (callables.length) {
      out.push([4, () => this.call(ctx, rng.pick(callables), depth)]);
    }
    if (this.has("control")) {
      out.push([
        1,
        () =>
          isScalar(t)
            ? `(${sub(T.bool)} ? ${sub(t)} : ${sub(t)})`
            : `(${sub(T.bool)} ? (${t.cs})(${sub(t)}) : (${t.cs})(${sub(t)}))`,
      ]);
    }
    if (this.has("switch") && (isScalar(t) || t.k === "string") && depth >= 2) {
      out.push([1, () => this.switchExpr(ctx, t, depth)]);
    }
    if (isScalar(t)) this.scalarBuilders(ctx, t, depth, out);
    switch (t.k) {
      case "string":
        this.stringBuilders(ctx, depth, out);
        break;
      case "enum":
        out.push([2, () => `((${t.cs})(${sub(scalar(t.decl.under))}))`]);
        if (rng.chance(0.3)) out.push([1, () => `(${sub(t)} | ${sub(t)})`]);
        break;
      case "object":
        out.push([3, () => `(object)(${sub(this.valueType(2, false))})`]);
        break;
      case "union":
        out.push([3, () => this.fresh(ctx, t)]);
        break;
      case "func":
        out.push([3, () => this.lambda(ctx, t)]);
        break;
      case "class":
      case "iface":
      case "record":
        out.push([3, () => this.fresh(ctx, t)]);
        if (t.k === "record") {
          const recs = this.readable(ctx).filter((v) =>
            v.t.k === "record" && same(v.t, t)
          );
          if (recs.length) {
            out.push([
              2,
              () => this.withExpr(ctx, rng.pick(recs).name, t.record, depth),
            ]);
          }
        }
        if (t.k === "class" && this.has("boxing")) {
          const objs = this.readable(ctx).filter((v) => v.t.k === "object");
          if (objs.length) {
            out.push([1, () => `(${rng.pick(objs).name} as ${t.cs})`]);
          }
        }
        if (t.k === "iface") {
          const impls = this.readable(ctx).filter((v) =>
            v.t.k === "class" && this.implemented(v.t.decl).includes(t.decl)
          );
          if (impls.length) {
            out.push([2, () => `((${t.cs})${rng.pick(impls).name})`]);
          }
        }
        if (t.k === "class") {
          const subs = this.readable(ctx).filter((v) =>
            v.t.k === "class" && this.derives(v.t.decl, t.decl) &&
            v.t.decl !== t.decl
          );
          if (subs.length) {
            out.push([2, () => `((${t.cs})${rng.pick(subs).name})`]);
          }
          const bases = this.readable(ctx).filter((v) =>
            v.t.k === "class" && this.derives(t.decl, v.t.decl) &&
            v.t.decl !== t.decl
          );
          if (bases.length) {
            out.push([1, () => `((${t.cs})${rng.pick(bases).name})`]);
          }
        }
        break;
      case "struct":
        out.push([3, () => this.fresh(ctx, t)]);
        if (t.record) {
          const recs = this.readable(ctx).filter((v) => same(v.t, t));
          if (recs.length) {
            out.push([
              2,
              () => this.withExpr(ctx, rng.pick(recs).name, t.record, depth),
            ]);
          }
        }
        break;
      default:
        out.push([2, () => this.fresh(ctx, t)]);
    }
    if (
      this.has("generics") && depth >= 1 &&
      (isScalar(t) || t.k === "string" || t.k === "class" || t.k === "struct")
    ) {
      out.push([
        1,
        () => `Gen.Pick<${t.cs}>(${sub(T.bool)}, ${sub(t)}, ${sub(t)})`,
      ]);
      const boxes = this.readable(ctx).filter((v) =>
        v.t.k === "box" && same(v.t.arg, t)
      );
      if (boxes.length) {
        out.push([
          2,
          () =>
            `${rng.pick(boxes).name}.${
              rng.pick(["Get()", "Value", `Swap(${sub(t)})`])
            }`,
        ]);
      }
    }
    if (this.has("collections")) {
      for (const v of this.readable(ctx)) {
        if ((v.t.k === "list" || v.t.k === "array") && same(v.t.of, t)) {
          out.push([2, () => this.elementRead(ctx, v, depth)]);
        }
        if (v.t.k === "dict" && same(v.t.val, t)) {
          out.push([1, () => `${v.name}[${sub(v.t.key)}]`]);
        }
        if ((v.t.k === "queue" || v.t.k === "stack") && same(v.t.of, t)) {
          out.push([
            1,
            () =>
              `${v.name}.${
                rng.pick(
                  v.t.k === "queue"
                    ? ["Peek()", "Dequeue()"]
                    : ["Peek()", "Pop()"],
                )
              }`,
          ]);
        }
      }
    }
    if (
      this.has("boxing") && (isScalar(t) || t.k === "struct" || t.k === "enum")
    ) {
      const objs = this.readable(ctx).filter((v) => v.t.k === "object");
      if (objs.length) {
        const o = rng.pick(objs).name;
        const test = this.has("declpatterns") && isScalar(t)
          ? `${t.cs} ${this.name("ub")}`
          : t.cs;
        out.push([
          1,
          () =>
            rng.chance(0.5)
              ? `((${t.cs})${o})`
              : `(${o} is ${test} ? (${t.cs})${o} : ${sub(t)})`,
        ]);
      }
    }
    if (this.has("unions") && depth >= 2 && (isScalar(t) || t.k === "string")) {
      const us = this.readable(ctx).filter((v) => v.t.k === "union");
      if (us.length) {
        out.push([1, () => this.unionSwitch(ctx, rng.pick(us), t, depth)]);
      }
    }
    if (this.has("delegates") && ctx.lambdaDepth === 0) {
      const fs = this.readable(ctx).filter((v) =>
        v.t.k === "func" && v.t.ret && same(v.t.ret, t)
      );
      if (fs.length && ctx.cost + 40 * ctx.weight <= ctx.budget) {
        const f = rng.pick(fs);
        ctx.cost += 40 * ctx.weight;
        const args = f.t.params.map((p) => sub(p)).join(", ");
        out.push([
          2,
          () =>
            rng.chance(0.3)
              ? `${f.name}.Invoke(${args})`
              : `${f.name}(${args})`,
        ]);
      }
    }
    return out;
  }

  elementRead(ctx, v, depth) {
    const rng = this.rng;
    const len = v.t.k === "list" ? "Count" : "Length";
    if (rng.chance(0.7)) {
      return `${v.name}[${this.expr(ctx, T.int, depth - 1)} & 3]`;
    }
    return `(${v.name}.${len} > 0 ? ${v.name}[(${
      this.expr(ctx, T.int, depth - 1)
    } & 0x7fffffff) % ${v.name}.${len}] : ${this.expr(ctx, v.t.of, 0)})`;
  }

  withExpr(ctx, name, r, depth) {
    const rng = this.rng;
    const ps = rng.shuffle(r.all).slice(0, rng.range(1, r.all.length));
    this.alloc(ctx, 6);
    return `(${name} with { ${
      ps.map((p) => `${p.name} = ${this.expr(ctx, p.t, depth - 1)}`).join(", ")
    } })`;
  }

  scalarBuilders(ctx, t, depth, out) {
    const rng = this.rng;
    const sub = (u) => this.expr(ctx, u, depth - 1);
    const cs = t.cs;
    if (cs === "bool") {
      out.push([3, () => this.comparison(ctx, depth)]);
      out.push([
        2,
        () =>
          `(${sub(T.bool)} ${
            rng.pick(["&&", "||", "^", "&", "|", "==", "!="])
          } ${sub(T.bool)})`,
      ]);
      out.push([1, () => `(!${sub(T.bool)})`]);
      if (this.has("switch")) out.push([2, () => this.isPattern(ctx, depth)]);
      if (this.has("float")) {
        out.push([
          1,
          () =>
            `${
              rng.pick(["double.IsNaN", "double.IsInfinity", "double.IsFinite"])
            }(${sub(T.double)})`,
        ]);
        out.push([
          1,
          () =>
            `${
              rng.pick(["float.IsNaN", "float.IsInfinity", "float.IsFinite"])
            }(${sub(T.float)})`,
        ]);
      }
      if (this.has("strings")) {
        out.push([
          1,
          () => `(${sub(T.string)} ${rng.pick(["==", "!="])} ${sub(T.string)})`,
        ]);
        out.push([1, () => `string.IsNullOrEmpty(${sub(T.string)})`]);
        out.push([
          1,
          () => `string.Equals(${sub(T.string)}, ${sub(T.string)})`,
        ]);
        out.push([
          1,
          () => `${this.nonNullString(ctx, depth)}.Contains(${sub(T.char)})`,
        ]);
      }
      this.referenceTests(ctx, depth, out);
      out.push([1, () => `Tr.F(${this.key()}, ${sub(T.bool)})`]);
      return;
    }
    // Numeric.
    if (WIDE_INTS.includes(cs)) {
      if (this.has("arith")) {
        out.push([6, () => this.intBinary(ctx, t, depth)]);
        out.push([1, () => `(~${sub(t)})`]);
        if (cs === "int" || cs === "long") out.push([1, () => `(-${sub(t)})`]);
      } else {
        out.push([
          6,
          () => `(${sub(t)} ${rng.pick(["+", "-", "*"])} ${sub(t)})`,
        ]);
      }
    } else if (isFloat(t) && this.has("float")) {
      out.push([
        6,
        () => `(${sub(t)} ${rng.pick(["+", "-", "*", "/"])} ${sub(t)})`,
      ]);
      out.push([1, () => `(-${sub(t)})`]);
    } else if (NARROW.includes(cs)) {
      // Narrow arithmetic promotes to int; the result is cast back.
      out.push([4, () => `((${cs})(${sub(T.int)}))`]);
      out.push([
        3,
        () =>
          `((${cs})(${sub(t)} ${
            rng.pick(["+", "-", "*", "&", "|", "^", "<<", ">>"])
          } ${rng.chance(0.5) ? sub(t) : sub(T.int)}))`,
      ]);
    }
    if (this.has("conv") && depth >= 1) {
      out.push([
        3,
        () =>
          `((${cs})${
            sub(rng.pick(this.scalarTypes().filter((u) => u.cs !== "bool")))
          })`,
      ]);
    }
    if (cs === "int") {
      out.push([1, () => `Tr.Pi(${this.key()}, ${sub(T.int)})`]);
      if (this.has("strings")) {
        out.push([1, () => `${this.nonNullString(ctx, depth)}.Length`]);
        out.push([
          1,
          () => `${this.nonNullString(ctx, depth)}.IndexOf(${sub(T.char)})`,
        ]);
        out.push([
          1,
          () =>
            this.has("ordinalvalue")
              ? `string.CompareOrdinal(${sub(T.string)}, ${sub(T.string)})`
              : `Math.Clamp(string.CompareOrdinal(${sub(T.string)}, ${
                sub(T.string)
              }), -1, 1)`,
        ]);
      }
      if (this.has("enums") && this.enums.length) {
        const e = rng.pick(this.enums);
        out.push([1, () => `((int)${sub(e.t)})`]);
      }
      if (this.has("records") && this.records.length) {
        const rs = this.readable(ctx).filter((v) => v.t.record);
        if (rs.length) {
          out.push([1, () => this.recordPattern(ctx, rng.pick(rs), depth)]);
        }
      }
      for (const v of this.readable(ctx)) {
        if (v.t.k === "array") out.push([1, () => `${v.name}.Length`]);
        if (["list", "dict", "set", "queue", "stack"].includes(v.t.k)) {
          out.push([1, () => `${v.name}.Count`]);
        }
        if (v.t.k === "list" && rng.chance(0.3)) {
          out.push([
            1,
            () =>
              `${v.name}.${rng.pick(["Capacity", `IndexOf(${sub(v.t.of)})`])}`,
          ]);
        }
        if (v.t.k === "list" && rng.chance(0.3) && v.t.of.cs === "int") {
          out.push([
            1,
            () => `${v.name}.FindIndex(${this.predicate(ctx, v.t.of)})`,
          ]);
        }
        if (v.t.k === "iface") out.push([1, () => `${v.name}.P${v.t.cs}`]);
      }
      if (this.has("generics") && this.has("arrays")) {
        const arrs = this.readable(ctx).filter((v) =>
          v.t.k === "array" && (isScalar(v.t.of) || v.t.of.k === "string")
        );
        if (arrs.length) {
          const a = rng.pick(arrs);
          out.push([
            1,
            () => `Gen.Count<${a.t.of.cs}>(${a.name}, ${sub(a.t.of)})`,
          ]);
        }
      }
    }
    if (cs === "long") {
      out.push([1, () => `Tr.Pl(${this.key()}, ${sub(T.long)})`]);
    }
    if (this.has("generics")) {
      out.push([1, () => {
        const other = rng.pick(this.scalarTypes());
        return rng.chance(0.5)
          ? `new Pair<${cs}, ${other.cs}>(${sub(t)}, ${sub(other)}).First`
          : `new Pair<${other.cs}, ${cs}>(${sub(other)}, ${sub(t)}).Second`;
      }]);
      out.push([1, () => `Gen.Default<${cs}>()`]);
      const lists = this.readable(ctx).filter((v) =>
        v.t.k === "list" && same(v.t.of, t)
      );
      if (lists.length) {
        out.push([
          1,
          () => `Gen.Last<${cs}>(${rng.pick(lists).name}, ${sub(t)})`,
        ]);
      }
    }
    if (cs === "double" && this.has("float")) {
      out.push([1, () => `Tr.Pd(${this.key()}, ${sub(T.double)})`]);
    }
    if (this.has("math") && depth >= 1) this.mathBuilders(ctx, t, depth, out);
    if (cs === "char" && this.has("strings")) {
      out.push([
        2,
        () => `${this.nonNullString(ctx, depth)}[${sub(T.int)} & 7]`,
      ]);
    }
    // Increments of locals, as expressions.
    const locals = this.assignable(ctx).filter((v) =>
      same(v.t, t) && !v.noSideEffects
    );
    if (locals.length && !ctx.inFilter && t.cs !== "bool") {
      const v = rng.pick(locals).name;
      out.push([
        1,
        () => rng.pick([`${v}++`, `++${v}`, `${v}--`, `(${v} = ${sub(t)})`]),
      ]);
    }
  }

  nonNullString(ctx, depth) {
    const vars = this.readable(ctx).filter((v) => v.t.k === "string");
    if (vars.length && this.rng.chance(0.6)) return this.rng.pick(vars).name;
    return `(${this.expr(ctx, T.string, depth - 1)} ?? "n")`;
  }

  intBinary(ctx, t, depth) {
    const rng = this.rng;
    const sub = (u) => this.expr(ctx, u, depth - 1);
    const op = rng.weighted([
      [4, "+"],
      [3, "-"],
      [3, "*"],
      [2, "/"],
      [2, "%"],
      [2, "&"],
      [2, "|"],
      [2, "^"],
      [2, "<<"],
      [2, ">>"],
      [1, ">>>"],
    ]);
    if (op === "<<" || op === ">>" || op === ">>>") {
      return `(${sub(t)} ${op} ${sub(T.int)})`;
    }
    if (op === "/" || op === "%") {
      const lit = t.cs === "int"
        ? ""
        : t.cs === "uint"
        ? "u"
        : t.cs === "long"
        ? "L"
        : "UL";
      if (this.has("divfault") && rng.chance(0.25)) {
        const vars = this.readable(ctx).filter((v) => same(v.t, t));
        const wrap = { int: "Pi", uint: "Pu", long: "Pl", ulong: "Pul" }[t.cs];
        const divisor = vars.length && rng.chance(0.7)
          ? rng.pick(vars).name
          : `Tr.${wrap}(${this.key()}, ${sub(t)})`;
        return `(${sub(t)} ${op} ${divisor})`;
      }
      return `(${sub(t)} ${op} ((${sub(t)} & 15${lit}) + 1${lit}))`;
    }
    return `(${sub(t)} ${op} ${sub(t)})`;
  }

  mathBuilders(ctx, t, depth, out) {
    const rng = this.rng;
    const sub = (u) => this.expr(ctx, u, depth - 1);
    // The CLR's JIT folds BitOperations over constants wrongly (a 64-bit
    // result where C# has an int; see README.md): their arguments are made
    // opaque with a mutable static that is always zero.
    const opaque = (u) => {
      const zero = {
        int: "Tr.Zero",
        uint: "(uint)Tr.Zero",
        long: "Tr.ZeroL",
        ulong: "(ulong)Tr.ZeroL",
      }[u.cs];
      return `(${sub(u)} ^ ${zero})`;
    };
    const cs = t.cs;
    if (cs === "int" || cs === "long") {
      out.push([1, () => `Math.Abs(${sub(t)})`]);
      out.push([
        1,
        () => `Math.${rng.pick(["Min", "Max"])}(${sub(t)}, ${sub(t)})`,
      ]);
      out.push([1, () => `Math.Clamp(${sub(t)}, ${sub(t)}, ${sub(t)})`]);
    }
    if (cs === "uint" || cs === "ulong") {
      out.push([
        1,
        () => `Math.${rng.pick(["Min", "Max"])}(${sub(t)}, ${sub(t)})`,
      ]);
      out.push([
        1,
        () =>
          `BitOperations.${rng.pick(["RotateLeft", "RotateRight"])}(${
            opaque(t)
          }, ${sub(T.int)})`,
      ]);
    }
    if (cs === "int") {
      out.push([
        1,
        () =>
          `BitOperations.${
            rng.pick(["PopCount", "LeadingZeroCount", "TrailingZeroCount"])
          }(${opaque(rng.pick([T.uint, T.ulong]))})`,
      ]);
      out.push([
        1,
        () =>
          `BitOperations.TrailingZeroCount(${
            opaque(rng.pick([T.int, T.long]))
          })`,
      ]);
    }
    if (cs === "double" && this.has("float")) {
      out.push([
        2,
        () =>
          `Math.${
            rng.pick(["Sqrt", "Floor", "Ceiling", "Truncate", "Round", "Abs"])
          }(${sub(t)})`,
      ]);
      out.push([
        1,
        () =>
          rng.chance(0.3)
            ? `Math.CopySign(${sub(t)}, Tr.Sign(${sub(t)}))`
            : `Math.${rng.pick(["Min", "Max"])}(${sub(t)}, ${sub(t)})`,
      ]);
      out.push([1, () => `Math.Clamp(${sub(t)}, ${sub(t)}, ${sub(t)})`]);
    }
    if (cs === "float" && this.has("float")) {
      out.push([
        2,
        () =>
          `MathF.${
            rng.pick(["Sqrt", "Floor", "Ceiling", "Truncate", "Round", "Abs"])
          }(${sub(t)})`,
      ]);
      out.push([
        1,
        () =>
          rng.chance(0.3)
            ? `MathF.CopySign(${sub(t)}, Tr.SignF(${sub(t)}))`
            : `MathF.${rng.pick(["Min", "Max"])}(${sub(t)}, ${sub(t)})`,
      ]);
      out.push([
        1,
        () =>
          rng.chance(0.5)
            ? `Math.Abs(${sub(t)})`
            : `Math.${rng.pick(["Min", "Max"])}(${sub(t)}, ${sub(t)})`,
      ]);
    }
  }

  comparison(ctx, depth) {
    const rng = this.rng;
    const types = this.scalarTypes().filter((u) => u.cs !== "bool");
    if (this.has("enums") && this.enums.length) {
      types.push(rng.pick(this.enums).t);
    }
    const u = rng.pick(types);
    const op = rng.pick(["<", "<=", ">", ">=", "==", "!="]);
    return `(${this.expr(ctx, u, depth - 1)} ${op} ${
      this.expr(ctx, u, depth - 1)
    })`;
  }

  // x is <pattern> over scalars.
  isPattern(ctx, depth) {
    const rng = this.rng;
    const u = rng.pick(
      [T.int, T.int, T.long, T.char, T.double, T.byte].filter((x) =>
        this.scalarTypes().includes(x)
      ),
    );
    return `(${this.expr(ctx, u, depth - 1)} is ${this.pattern(u)})`;
  }

  // A constant, relational or combined pattern for a scalar type that can
  // match something (Roslyn rejects patterns that never match).
  pattern(u) {
    const rng = this.rng;
    const values = PATTERN_VALUES[u.cs];
    const [min, max] = PATTERN_RANGE[u.cs];
    const relational = () => {
      for (;;) {
        const [c, v] = rng.pick(values.filter(([, v]) => !Number.isNaN(v)));
        const op = rng.pick(["<", "<=", ">", ">="]);
        if ((op === "<" && v <= min) || (op === ">" && v >= max)) continue;
        return `${op} ${c}`;
      }
    };
    const constant = () => rng.pick(values)[0];
    const simple = () => rng.chance(0.5) ? constant() : relational();
    return rng.weighted([
      [3, simple],
      [1, () => {
        // A nonempty range.
        const sorted = values.filter(([, v]) => !Number.isNaN(v)).sort((a, b) =>
          a[1] - b[1]
        );
        const i = rng.int(sorted.length);
        const j = i + rng.int(sorted.length - i);
        return `>= ${sorted[i][0]} and <= ${sorted[j][0]}`;
      }],
      [1, () => `${simple()} or ${simple()}`],
      [1, () => `not ${constant()}`],
    ])();
  }

  // A relational pattern matching many values, which a few constant cases
  // before it cannot cover.
  openPattern(u) {
    const rng = this.rng;
    const [min, max] = PATTERN_RANGE[u.cs];
    for (;;) {
      const [c, v] = rng.pick(
        PATTERN_VALUES[u.cs].filter(([, v]) => !Number.isNaN(v)),
      );
      const op = rng.pick(["<", ">"]);
      if ((op === "<" && v - min > 8) || (op === ">" && max - v > 8)) {
        return `${op} ${c}`;
      }
    }
  }

  // A constant usable in a pattern or case label.
  patternConstant(u) {
    return this.rng.pick(PATTERN_VALUES[u.cs])[0];
  }

  referenceTests(ctx, depth, out) {
    const rng = this.rng;
    for (const v of this.readable(ctx)) {
      if (isRef(v.t) && v.t.k !== "func" && rng.chance(0.3)) {
        out.push([1, () => `(${v.name} ${rng.pick(["==", "!="])} null)`]);
      }
      if (v.t.k === "class" && this.has("classes")) {
        const subs = this.classes.filter((c) =>
          this.derives(c, v.t.decl) && c !== v.t.decl
        );
        if (subs.length) {
          out.push([1, () => `(${v.name} is ${rng.pick(subs).name})`]);
        }
      }
      if (v.t.k === "object") {
        const u = this.valueType(2, false);
        if (
          u.k !== "array" &&
          !(u.k in { list: 1, dict: 1, set: 1, queue: 1, stack: 1 })
        ) {
          out.push([1, () => `(${v.name} is ${u.cs})`]);
        }
        out.push([
          1,
          () => `${v.name}.Equals(${this.expr(ctx, T.object, depth - 1)})`,
        ]);
        out.push([
          1,
          () =>
            `object.Equals(${v.name}, ${this.expr(ctx, T.object, depth - 1)})`,
        ]);
        out.push([
          1,
          () =>
            `object.ReferenceEquals(${v.name}, ${
              this.expr(ctx, T.object, depth - 1)
            })`,
        ]);
        if (this.has("objectpatterns")) {
          out.push([
            2,
            () =>
              `(${v.name} is ${
                rng.pick([
                  this.patternConstant(T.int),
                  this.patternConstant(T.long),
                  this.patternConstant(T.string),
                  `int and ${this.pattern(T.int)}`,
                  `long and ${this.openPattern(T.long)}`,
                ])
              })`,
          ]);
        }
      }
      if (v.t.k === "record" || v.t.record) {
        out.push([
          2,
          () =>
            `(${v.name} ${rng.pick(["==", "!="])} ${
              this.expr(ctx, v.t, depth - 1)
            })`,
        ]);
        out.push([
          1,
          () => `${v.name}.Equals(${this.expr(ctx, v.t, depth - 1)})`,
        ]);
      }
      if (v.t.k === "struct" && !v.t.record) {
        out.push([
          1,
          () => `${v.name}.Equals(${this.expr(ctx, v.t, depth - 1)})`,
        ]);
      }
      if (v.t.k === "box") {
        out.push([
          1,
          () => `${v.name}.Same(${this.expr(ctx, v.t.arg, depth - 1)})`,
        ]);
      }
      if (v.t.k === "list") {
        out.push([
          1,
          () => `${v.name}.Contains(${this.expr(ctx, v.t.of, depth - 1)})`,
        ]);
        if (v.t.of.cs === "int") {
          out.push([
            1,
            () =>
              `${v.name}.${rng.pick(["Exists", "TrueForAll"])}(${
                this.predicate(ctx, v.t.of)
              })`,
          ]);
        }
      }
      if (v.t.k === "set" || v.t.k === "queue" || v.t.k === "stack") {
        out.push([
          1,
          () => `${v.name}.Contains(${this.expr(ctx, v.t.of, depth - 1)})`,
        ]);
      }
      if (v.t.k === "set" && !ctx.inFilter) {
        out.push([
          1,
          () =>
            `${v.name}.${rng.pick(["Add", "Remove"])}(${
              this.expr(ctx, v.t.of, depth - 1)
            })`,
        ]);
      }
      if (v.t.k === "dict") {
        out.push([
          1,
          () => `${v.name}.ContainsKey(${this.expr(ctx, v.t.key, depth - 1)})`,
        ]);
        if (!ctx.inFilter) {
          out.push([
            1,
            () =>
              `${v.name}.TryAdd(${this.expr(ctx, v.t.key, depth - 1)}, ${
                this.expr(ctx, v.t.val, 0)
              })`,
          ]);
          out.push([
            1,
            () => `${v.name}.Remove(${this.expr(ctx, v.t.key, depth - 1)})`,
          ]);
        }
        out.push([
          1,
          () =>
            `${v.name}.ContainsValue(${this.expr(ctx, v.t.val, depth - 1)})`,
        ]);
      }
    }
  }

  // A lambda predicate over one element type; captures nothing mutable.
  predicate(ctx, t) {
    // No lambdas in filters (README.md, Exceptions); a null predicate throws.
    if (ctx.inFilter) return `((Predicate<${t.cs}>)null)`;
    const x = this.name("p");
    const k = this.patternConstant(T.int);
    return this.rng.pick([
      `${x} => ${x} > ${k}`,
      `${x} => (${x} & 1) == 0`,
      `${x} => ${x} == ${k}`,
      `static ${x} => ${x} < ${k}`,
    ]);
  }

  recordPattern(ctx, v, depth) {
    const rng = this.rng;
    const r = v.t.record;
    const intProps = r.all.filter((p) => p.t.cs === "int");
    if (!intProps.length) return this.expr(ctx, T.int, 0);
    const p = rng.pick(intProps);
    const pat = rng.chance(0.5)
      ? `{ ${p.name}: ${this.pattern(T.int)} }`
      : `${r.name}(${
        r.all.map((q) => q === p ? this.pattern(T.int) : "_").join(", ")
      })`;
    return `(${v.name} is ${pat} ? ${this.expr(ctx, T.int, depth - 1)} : ${
      this.expr(ctx, T.int, depth - 1)
    })`;
  }

  stringBuilders(ctx, depth, out) {
    const rng = this.rng;
    const sub = (u) => this.expr(ctx, u, depth - 1);
    out.push([3, () => `(${sub(T.string)} + ${sub(T.string)})`]);
    const printables = this.scalarTypes().filter((u) => printable(u));
    out.push([2, () => `(${sub(T.string)} + ${sub(rng.pick(printables))})`]);
    out.push([2, () => {
      const parts = [];
      for (let i = rng.range(1, 3); i > 0; i--) {
        parts.push(
          rng.chance(0.5)
            ? rng.pick(["a", "-", ":", "x=", ""])
            : `{${sub(rng.pick([T.string, ...printables]))}}`,
        );
      }
      return `$"${parts.join("")}"`;
    }]);
    out.push([1, () => `(${sub(rng.pick(printables))}).ToString()`]);
    out.push([
      1,
      () =>
        `string.Concat(${sub(T.string)}, ${sub(T.string)}${
          rng.chance(0.5) ? `, ${sub(T.string)}` : ""
        })`,
    ]);
    out.push([
      1,
      () =>
        `${this.nonNullString(ctx, depth)}.Substring(${sub(T.int)} & 3${
          rng.chance(0.5) ? `, ${sub(T.int)} & 3` : ""
        })`,
    ]);
    out.push([1, () => `(${sub(T.string)} ?? ${sub(T.string)})`]);
    if (this.has("records")) {
      const rs = this.readable(ctx).filter((v) => v.t.record?.printable);
      if (rs.length) out.push([1, () => `${rng.pick(rs).name}.ToString()`]);
    }
    const objs = this.readable(ctx).filter((v) =>
      v.t.k === "object" && v.printable
    );
    if (objs.length) out.push([1, () => `${rng.pick(objs).name}.ToString()`]);
  }

  switchExpr(ctx, t, depth) {
    const rng = this.rng;
    const gov = rng.pick([
      T.int,
      T.int,
      T.char,
      T.long,
      ...(this.has("strings") ? [T.string] : []),
      ...(this.enums.length && this.has("enums")
        ? [rng.pick(this.enums).t]
        : []),
    ]);
    const arms = [];
    const used = new Set();
    for (let i = rng.range(1, 4); i > 0; i--) {
      if (gov.k === "enum") {
        const m = rng.pick(gov.decl.members).name;
        if (used.has(m)) continue;
        used.add(m);
        arms.push(`${gov.cs}.${m} => ${this.expr(ctx, t, depth - 1)}`);
      } else {
        const c = this.patternConstant(gov);
        if (used.has(c) || c === "double.NaN") continue;
        used.add(c);
        arms.push(`${c} => ${this.expr(ctx, t, depth - 1)}`);
      }
    }
    if (gov.k === "scalar" && rng.chance(0.5)) {
      arms.push(
        `${this.openPattern(gov)} when Tr.F(${this.key()}, ${
          this.expr(ctx, T.bool, 1)
        }) => ${this.expr(ctx, t, depth - 1)}`,
      );
    }
    // No default arm: the CLR throws SwitchExpressionException.
    if (rng.chance(this.has("divfault") ? 0.9 : 1)) {
      arms.push(`_ => ${this.expr(ctx, t, depth - 1)}`);
    }
    return `(${this.expr(ctx, gov, depth - 1)} switch { ${arms.join(", ")} })`;
  }

  unionSwitch(ctx, v, t, depth) {
    const rng = this.rng;
    const u = v.t.decl;
    const arms = [];
    let covered = 0;
    for (const c of rng.shuffle(u.cases)) {
      const x = this.name("uc");
      const inner = new Scope(ctx.scope);
      inner.vars.push({
        name: x,
        t: c,
        fn: ctx.fn,
        mutable: false,
        capturable: false,
      });
      const saved = ctx.scope;
      ctx.scope = inner;
      if (
        c.k === "scalar" && ["int", "long"].includes(c.cs) && rng.chance(0.4)
      ) {
        arms.push(
          `${c.cs} ${x} when ${x} > ${c.cs === "long" ? "3L" : "3"} => ${
            this.expr(ctx, t, depth - 1)
          }`,
        );
      }
      if (rng.chance(0.9)) {
        arms.push(`${c.cs} ${x} => ${this.expr(ctx, t, depth - 1)}`);
        covered++;
      }
      ctx.scope = saved;
    }
    if (rng.chance(0.6)) {
      arms.push(`null => ${this.expr(ctx, t, depth - 1)}`);
      covered++;
    }
    // A discard after every case and null would never match.
    if (covered < u.cases.length + 1 && rng.chance(0.3)) {
      arms.push(`_ => ${this.expr(ctx, t, depth - 1)}`);
    }
    return `(${v.name} switch { ${arms.join(", ")} })`;
  }

  call(ctx, c, depth) {
    ctx.cost += c.cost * ctx.weight;
    const args = [];
    for (const p of c.params) {
      if (p.mode === "ref" || p.mode === "out") {
        const vs = this.assignable(ctx).filter((v) =>
          same(v.t, p.t) && v.refable && v.fn === ctx.fn
        );
        if (!vs.length) return null;
        args.push(`${p.mode} ${this.rng.pick(vs).name}`);
      } else {
        args.push(this.expr(ctx, p.t, depth - 1));
      }
    }
    return `${c.target ? c.target(ctx) : c.name}(${args.join(", ")})`;
  }

  // -------------------------------------------------------------------------
  // Lambdas and closures

  lambda(ctx, t) {
    const rng = this.rng;
    // Method groups of leaf helpers with the same shape.
    const groups = this.callables.filter((c) =>
      c.group && c.ready && c.tier > ctx.tier &&
      c.params.length === t.params.length &&
      c.params.every((p, i) => p.mode === "val" && same(p.t, t.params[i])) &&
      (t.ret ? c.ret && same(c.ret, t.ret) : !c.ret)
    );
    if (groups.length && rng.chance(0.3)) {
      return `((${t.cs})${rng.pick(groups).name})`;
    }
    const names = t.params.map(() => this.name("a"));
    const scope = new Scope(ctx.scope);
    names.forEach((n, i) =>
      scope.vars.push({
        name: n,
        t: t.params[i],
        fn: null,
        mutable: true,
        capturable: false,
      })
    );
    const inner = this.childFn(ctx, scope);
    inner.budget = 40;
    inner.lambdaDepth = ctx.lambdaDepth + 1;
    if (ctx.inFilter) return `((${t.cs})null)`;
    for (const v of scope.vars) v.fn = inner.fn;
    const head = names.length === 1 && rng.chance(0.5)
      ? names[0]
      : `(${names.join(", ")})`;
    if (t.ret && rng.chance(0.6)) {
      return `((${t.cs})(${head} => ${this.expr(inner, t.ret, 2)}))`;
    }
    const body = this.block(inner, 2, t.ret);
    return `((${t.cs})(${head} =>\n${body}))`;
  }

  childFn(ctx, scope) {
    // Delegates may reach code of any tier: their bodies only call the
    // leaf tiers, so no cycle passes through them.
    return {
      ...ctx,
      tier: Math.max(ctx.tier, 189),
      scope,
      fn: {},
      cost: 0,
      weight: 1,
      loops: 0,
      breakable: false,
      continuable: false,
      inFinally: false,
      inCatch: null,
      inFilter: false,
    };
  }

  // -------------------------------------------------------------------------
  // Statements

  block(ctx, depth, ret, prelude = []) {
    const saved = ctx.scope;
    ctx.scope = new Scope(saved);
    const lines = [...prelude];
    if (!ctx.seeded) {
      // A function starts with locals holding constants, so that its
      // expressions have operands Roslyn cannot fold.
      ctx.seeded = true;
      const types = this.scalarTypes();
      for (let i = this.rng.range(2, 4); i > 0; i--) {
        const t = this.rng.pick([T.int, T.int, T.long, ...types]);
        lines.push(this.declare(ctx, t, literal(this.rng, t)));
      }
    }
    const n = this.rng.range(1, depth > 1 ? 5 : 3);
    for (let i = 0; i < n && ctx.cost < ctx.budget; i++) {
      const s = this.statement(ctx, depth);
      if (s) lines.push(s);
    }
    if (ret !== undefined) {
      if (ret) lines.push(`return ${this.expr(ctx, ret, 2)};`);
    }
    ctx.scope = saved;
    return `{\n${indent(lines.join("\n"))}\n}`;
  }

  declare(ctx, t, init, opts = {}) {
    const name = this.name("v");
    const capturable = opts.capturable ??
      (this.has("closures") && this.rng.chance(0.3));
    ctx.scope.vars.push({
      name,
      t,
      fn: ctx.fn,
      mutable: opts.mutable ?? true,
      capturable,
      refable: !capturable,
      printable: opts.printable,
    });
    return `${t.cs} ${name} = ${init};`;
  }

  statement(ctx, depth) {
    const rng = this.rng;
    const options = [
      [6, () => this.declStatement(ctx)],
      [5, () => this.assignStatement(ctx)],
      [4, () => this.logStatement(ctx)],
    ];
    if (depth > 0) {
      if (this.has("control")) {
        options.push([3, () => this.ifStatement(ctx, depth)]);
        if (ctx.ret !== undefined && !ctx.inFinally && ctx.lambdaDepth === 0) {
          options.push([
            1,
            () =>
              `if (${this.expr(ctx, T.bool, 2)}) ${
                ctx.ret ? `return ${this.expr(ctx, ctx.ret, 1)};` : "return;"
              }`,
          ]);
        }
      }
      if (this.has("loops") && ctx.loops < 3) {
        options.push([3, () => this.loopStatement(ctx, depth)]);
      }
      if (this.has("switch")) {
        options.push([2, () => this.switchStatement(ctx, depth)]);
      }
      if (this.has("exceptions") && !ctx.inFinally) {
        options.push([3, () => this.tryStatement(ctx, depth)]);
        options.push([1, () => this.throwStatement(ctx)]);
      }
      if (this.has("closures") && ctx.lambdaDepth === 0) {
        options.push([2, () => this.closureStatement(ctx)]);
      }
      if (this.has("collections")) {
        options.push([3, () => this.collectionStatement(ctx)]);
      }
      if (this.has("structs")) {
        options.push([2, () => this.structStatement(ctx)]);
      }
      if (this.has("records")) {
        options.push([1, () => this.deconstructStatement(ctx)]);
      }
      if (this.has("refout")) options.push([1, () => this.refStatement(ctx)]);
      if (this.has("scenarios")) {
        options.push([3, () => scenario(this, ctx, depth)]);
      }
      if (this.has("boxing")) {
        options.push([1, () => this.objectSwitchStatement(ctx, depth)]);
      }
      if ([...NEW_FEATURES, ...LIBRARY_FEATURES].some((f) => this.has(f))) {
        options.push([3, () => featureStatement(this, ctx, depth)]);
      }
    }
    if (ctx.breakable && !ctx.inFinally && rng.chance(0.3)) {
      options.push([
        1,
        () =>
          `if (${this.expr(ctx, T.bool, 1)}) ${
            rng.pick(ctx.continuable ? ["break;", "continue;"] : ["break;"])
          }`,
      ]);
    }
    ctx.cost += ctx.weight;
    return rng.weighted(options)();
  }

  declStatement(ctx) {
    const t = this.valueType();
    const init = this.expr(ctx, t, 2);
    return this.declare(ctx, t, init, {
      printable: t.k === "object" ? false : undefined,
    });
  }

  assignStatement(ctx) {
    const rng = this.rng;
    const targets = this.assignTargets(ctx);
    if (!targets.length) return this.declStatement(ctx);
    const [lhs, t] = rng.pick(targets);
    if (isScalar(t) && t.cs !== "bool" && rng.chance(0.5)) {
      const ops = ["+=", "-=", "*=", "&=", "|=", "^="];
      if (isInt(t)) ops.push("<<=", ">>=", ">>>=", "%=", "/=");
      if (isFloat(t)) ops.push("/=");
      const op = rng.pick(ops);
      if (op === "<<=" || op === ">>=" || op === ">>>=") {
        return `${lhs} ${op} ${this.expr(ctx, T.int, 1)};`;
      }
      if (isFloat(t) && ["&=", "|=", "^="].includes(op)) {
        return `${lhs} += ${this.expr(ctx, t, 1)};`;
      }
      if ((op === "%=" || op === "/=") && isInt(t) && !this.has("divfault")) {
        return `${lhs} ${op} (${t.cs})((${this.expr(ctx, t, 1)} & 7) + 1);`;
      }
      if (rng.chance(0.2)) return `${lhs}${rng.pick(["++", "--"])};`;
      return `${lhs} ${op} ${this.expr(ctx, t, 1)};`;
    }
    if (t.k === "string" && rng.chance(0.4)) {
      return `${lhs} += ${
        this.expr(ctx, rng.pick([T.string, T.int, T.char]), 1)
      };`;
    }
    return `${lhs} = ${this.expr(ctx, t, 2)};`;
  }

  assignTargets(ctx) {
    const out = [];
    for (const v of this.assignable(ctx)) {
      out.push([v.name, v.t]);
      if (v.t.k === "class" || (v.t.k === "struct" && !v.t.record)) {
        for (const f of v.t.decl.all ?? v.t.decl.fields) {
          out.push([`${v.name}.${f.name}`, f.t]);
        }
      }
      if (v.t.k === "array" && this.rng.chance(0.5)) {
        out.push([`${v.name}[${this.expr(ctx, T.int, 1)} & 3]`, v.t.of]);
      }
      if (v.t.k === "list" && this.rng.chance(0.3)) {
        out.push([`${v.name}[${this.expr(ctx, T.int, 1)} & 3]`, v.t.of]);
      }
      if (v.t.k === "dict" && this.rng.chance(0.5)) {
        out.push([`${v.name}[${this.expr(ctx, v.t.key, 1)}]`, v.t.val]);
      }
      if (v.t.k === "box") out.push([`${v.name}.Value`, v.t.arg]);
    }
    if (ctx.self && ctx.selfMutable) {
      for (const f of ctx.self.all ?? ctx.self.fields) {
        out.push([`this.${f.name}`, f.t]);
      }
    }
    if (ctx.tier < 160) {
      for (const st of this.statics) {
        if (st.ready) {
          for (const f of st.fields) out.push([`${st.name}.${f.name}`, f.t]);
        }
      }
    }
    return out;
  }

  logStatement(ctx) {
    const t = this.rng.chance(0.5)
      ? this.rng.pick(this.scalarTypes())
      : this.valueType();
    return this.log(ctx, this.expr(ctx, t, 2), t) ??
      `Tr.L(${this.expr(ctx, T.long, 2)});`;
  }

  // A statement recording a value of type t in the trace.
  log(_ctx, e, t) {
    const q = () => this.name("q");
    switch (t.k) {
      case "scalar":
        if (t.cs === "bool") return `Tr.L(${e} ? 1 : 0);`;
        if (isFloat(t)) return `Tr.LD(${e});`;
        if (t.cs === "ulong") return `Tr.L((long)${e});`;
        return `Tr.L(${e});`;
      case "enum":
        return `Tr.L((long)${e});`;
      case "string":
        return `Tr.S(${e});`;
      case "array":
        return `Tr.L(${e}.Length);`;
      case "list":
      case "dict":
      case "set":
      case "queue":
      case "stack":
        return `Tr.L(${e}.Count);`;
      case "class":
      case "record": {
        const f = (t.decl.all ?? []).find((x) =>
          ["int", "long", "short", "sbyte", "byte", "ushort", "char"].includes(
            x.t.cs,
          )
        );
        if (!f) return `Tr.L(${e} is null ? 1 : 0);`;
        const v = q();
        return `Tr.L(${e} is ${t.cs} ${v} ? ${v}.${f.name} : -7);`;
      }
      case "struct": {
        const decl = t.decl;
        const f = (decl.all ?? decl.fields).find((x) =>
          isScalar(x.t) && isInt(x.t) && x.t.cs !== "ulong"
        );
        return f ? `Tr.L(${e}.${f.name});` : null;
      }
      case "iface": {
        const v = q();
        return `Tr.L(${e} is ${t.cs} ${v} ? ${v}.P${t.cs} : -8);`;
      }
      case "box": {
        const v = q();
        return `Tr.L(${e} is ${t.cs} ${v} ? ${v}.Reads : -1);`;
      }
      case "object":
        return this.has("declpatterns")
          ? `Tr.L(${e} is int ${q()} ? 1 : 2);`
          : `Tr.L(${e} is int ? 1 : 2);`;
      case "union":
        return `Tr.L(${e} is null ? 1 : 0);`;
      case "func":
        return `Tr.L(${e} == null ? 1 : 0);`;
    }
    return null;
  }

  ifStatement(ctx, depth) {
    const cond = this.expr(ctx, T.bool, 2);
    const then = this.block(ctx, depth - 1);
    if (this.rng.chance(0.4)) {
      return `if (${cond})\n${then}\nelse\n${this.block(ctx, depth - 1)}`;
    }
    return `if (${cond})\n${then}`;
  }

  // A loop with a constant trip count and a counter the body cannot assign.
  loopStatement(ctx, depth) {
    const rng = this.rng;
    const trips = rng.range(0, ctx.weight > 8 ? 2 : 5);
    const saved = {
      weight: ctx.weight,
      breakable: ctx.breakable,
      continuable: ctx.continuable,
      scope: ctx.scope,
    };
    ctx.weight *= trips + 1;
    ctx.loops++;
    ctx.breakable = true;
    ctx.continuable = true;
    ctx.cost += ctx.weight;
    const i = this.name("i");
    ctx.scope = new Scope(saved.scope);
    const counter = {
      name: i,
      t: T.int,
      fn: ctx.fn,
      mutable: false,
      capturable: this.has("closures") && rng.chance(0.4),
    };
    let text;
    const kind = rng.weighted([[4, "for"], [2, "while"], [1, "do"], [
      2,
      "foreach",
    ]]);
    if (kind === "for") {
      ctx.scope.vars.push(counter);
      text = `for (int ${i} = 0; ${i} < ${trips}; ${i}++)\n${
        this.block(ctx, depth - 1)
      }`;
    } else if (kind === "while") {
      const pre = `int ${i} = ${trips};`;
      ctx.scope = saved.scope;
      saved.scope.vars.push({ ...counter, capturable: false });
      text = `${pre}\nwhile (${i}-- > 0)\n${this.block(ctx, depth - 1)}`;
    } else if (kind === "do") {
      ctx.scope = saved.scope;
      saved.scope.vars.push({ ...counter, capturable: false });
      text = `int ${i} = ${trips};\ndo\n${
        this.block(ctx, depth - 1)
      }\nwhile (--${i} > 0);`;
    } else {
      const arrays = this.readable(ctx).filter((v) =>
        v.t.k === "array" || v.t.k === "list" || v.t.k === "set" ||
        v.t.k === "dict"
      );
      if (arrays.length && rng.chance(0.7) && trips > 0) {
        const a = rng.pick(arrays);
        // The collection is short: arrays up to 5, collections bounded by adds.
        ctx.weight = saved.weight * 8;
        const elem = a.t.k === "dict"
          ? { k: "kvp", cs: `KeyValuePair<${a.t.key.cs}, ${a.t.val.cs}>` }
          : a.t.of;
        if (a.t.k === "dict") {
          const keys = rng.chance(0.5);
          const et = keys ? a.t.key : a.t.val;
          ctx.scope.vars.push({
            name: i,
            t: et,
            fn: ctx.fn,
            mutable: false,
            capturable: counter.capturable,
          });
          text = `foreach (${et.cs} ${i} in ${a.name}.${
            keys ? "Keys" : "Values"
          })\n${this.block(ctx, depth - 1)}`;
        } else {
          ctx.scope.vars.push({
            name: i,
            t: elem,
            fn: ctx.fn,
            mutable: false,
            capturable: counter.capturable,
          });
          text = `foreach (${
            rng.chance(0.5) ? "var" : elem.cs
          } ${i} in ${a.name})\n${this.block(ctx, depth - 1)}`;
        }
      } else {
        ctx.scope.vars.push(counter);
        text = `for (int ${i} = ${trips}; ${i} > 0; ${i} -= ${
          rng.range(1, 2)
        })\n${this.block(ctx, depth - 1)}`;
      }
    }
    ctx.weight = saved.weight;
    ctx.breakable = saved.breakable;
    ctx.continuable = saved.continuable;
    ctx.scope = saved.scope;
    ctx.loops--;
    return text;
  }

  switchStatement(ctx, depth) {
    const rng = this.rng;
    const gov = rng.pick([
      T.int,
      T.int,
      T.char,
      T.long,
      ...(this.has("strings") ? [T.string] : []),
      ...(this.enums.length && this.has("enums")
        ? [rng.pick(this.enums).t]
        : []),
    ]);
    const sections = [];
    const used = new Set();
    const saved = { breakable: ctx.breakable };
    ctx.breakable = true;
    for (let i = rng.range(1, 4); i > 0; i--) {
      const labels = [];
      for (let j = rng.range(1, 2); j > 0; j--) {
        const c = gov.k === "enum"
          ? `${gov.cs}.${rng.pick(gov.decl.members).name}`
          : this.patternConstant(gov);
        if (used.has(c) || c === "double.NaN") continue;
        used.add(c);
        labels.push(`case ${c}:`);
      }
      if (!labels.length) continue;
      sections.push(
        `${labels.join("\n")}\n${indent(this.block(ctx, depth - 1))}\n${
          indent("break;")
        }`,
      );
    }
    if (gov.k === "scalar" && gov.cs !== "string" && rng.chance(0.5)) {
      sections.push(
        `case ${this.openPattern(gov)} when Tr.F(${this.key()}, ${
          this.expr(ctx, T.bool, 1)
        }):\n${indent(this.block(ctx, depth - 1))}\n${indent("break;")}`,
      );
    }
    if (rng.chance(0.6)) {
      sections.push(
        `default:\n${indent(this.block(ctx, depth - 1))}\n${indent("break;")}`,
      );
    }
    ctx.breakable = saved.breakable;
    return `switch (${this.expr(ctx, gov, 2)})\n{\n${
      indent(sections.join("\n"))
    }\n}`;
  }

  objectSwitchStatement(ctx, depth) {
    const rng = this.rng;
    const objs = this.readable(ctx).filter((v) => v.t.k === "object");
    if (!objs.length) {
      return this.declare(ctx, T.object, this.fresh(ctx, T.object), {
        printable: false,
      });
    }
    const o = rng.pick(objs);
    const depthOf = (t) => {
      let d = 0;
      for (let x = t.decl; x && x.parent; x = x.parent) d++;
      return d;
    };
    // A case for a base type after one for its subtype: never subsumed.
    const cases = rng.shuffle([
      T.int,
      T.long,
      T.bool,
      ...(this.has("strings") ? [T.string] : []),
      ...this.structs.map((s) => s.t),
      ...this.classes.map((c) => c.t),
      ...this.records.map((r) => r.t),
    ])
      .slice(0, 3)
      .sort((a, b) => depthOf(b) - depthOf(a));
    const saved = { breakable: ctx.breakable, scope: ctx.scope };
    ctx.breakable = true;
    const sections = [];
    for (const c of cases) {
      const x = this.name("oc");
      ctx.scope = new Scope(saved.scope);
      // A declaration pattern of a value type (`declpatterns`).
      const declare =
        !(c.k === "scalar" || c.k === "struct" || c.k === "enum") ||
        this.has("declpatterns");
      if (declare) {
        ctx.scope.vars.push({
          name: x,
          t: c,
          fn: ctx.fn,
          mutable: true,
          capturable: false,
          refable: false,
        });
      }
      sections.push(
        `case ${c.cs}${declare ? ` ${x}` : ""}:\n${
          indent(this.block(ctx, depth - 1))
        }\n${indent("break;")}`,
      );
    }
    ctx.scope = saved.scope;
    sections.push(
      `case null:\n${indent("Tr.L(" + this.key() + ");")}\n${indent("break;")}`,
    );
    if (rng.chance(0.5)) {
      sections.push(
        `default:\n${indent(this.block(ctx, depth - 1))}\n${indent("break;")}`,
      );
    }
    ctx.breakable = saved.breakable;
    return `switch (${o.name})\n{\n${indent(sections.join("\n"))}\n}`;
  }

  throwStatement(ctx) {
    const rng = this.rng;
    const inCatch = ctx.inCatch && !ctx.lambdaDepth;
    if (inCatch && rng.chance(0.4)) {
      return `if (${this.expr(ctx, T.bool, 1)}) throw;`;
    }
    return `if (${this.expr(ctx, T.bool, 2)}) throw ${this.newException(ctx)};`;
  }

  newException(ctx) {
    const rng = this.rng;
    this.alloc(ctx, 8);
    if (this.excs.length && rng.chance(0.7)) {
      const x = rng.pick(this.excs);
      return `new ${x.name}(${this.expr(ctx, T.int, 1)}, ${
        this.has("strings") ? `${this.expr(ctx, T.string, 1)} ?? "m"` : '"m"'
      })`;
    }
    // ArgumentOutOfRangeException(string) takes a parameter name, which the
    // subset does not have; its parameterless constructor is.
    if (rng.chance(0.15)) return "new ArgumentOutOfRangeException()";
    return `new ${
      rng.pick([
        "InvalidOperationException",
        "ArgumentException",
        "NotSupportedException",
        "Exception",
        "KeyNotFoundException",
      ])
    }(${this.has("strings") ? this.expr(ctx, T.string, 1) : '"m"'})`;
  }

  tryStatement(ctx, depth) {
    const rng = this.rng;
    const k = this.key();
    const body = this.block(ctx, depth - 1);
    const catches = [];
    const available = [
      { name: "Exception", depth: 0 },
      { name: "SystemException", depth: 1 },
      { name: "ArithmeticException", depth: 2 },
      { name: "DivideByZeroException", depth: 3 },
      { name: "OverflowException", depth: 3 },
      { name: "InvalidOperationException", depth: 2 },
      { name: "ArgumentException", depth: 2 },
      { name: "ArgumentOutOfRangeException", depth: 3 },
      { name: "IndexOutOfRangeException", depth: 2 },
      { name: "NullReferenceException", depth: 2 },
      { name: "InvalidCastException", depth: 2 },
      { name: "KeyNotFoundException", depth: 2 },
      { name: "TypeInitializationException", depth: 2 },
      ...this.excs.map((x) => ({ name: x.name, depth: x.depth, user: x })),
    ];
    const chosen = rng.shuffle(available).slice(0, rng.range(0, 3));
    // Unfiltered clauses for derived types must come before their bases.
    chosen.sort((a, b) => b.depth - a.depth);
    const hasFinally = rng.chance(0.4) || chosen.length === 0;
    const seen = new Set();
    for (const x of chosen) {
      if (seen.has(x.name)) continue;
      seen.add(x.name);
      const v = this.name("e");
      const filtered = this.has("filters") && rng.chance(0.4);
      const saved = { scope: ctx.scope, inCatch: ctx.inCatch };
      ctx.scope = new Scope(saved.scope);
      const et = { k: "exc", cs: x.name, decl: x };
      let filter = "";
      if (filtered) {
        ctx.inFilter = true;
        const cond = x.user && rng.chance(0.6)
          ? `${v}.Code ${rng.pick([">", "<", "==", "!="])} ${
            this.expr(ctx, T.int, 1)
          }`
          : this.expr(ctx, T.bool, 1);
        filter = ` when (Tr.F(${this.key()}, ${cond}))`;
        ctx.inFilter = false;
      }
      ctx.inCatch = true;
      const prelude = [`Tr.L(${this.key()});`];
      if (x.user) {
        prelude.push(`Tr.L(${v}.Code);`);
        if (this.has("strings") && rng.chance(0.5)) {
          prelude.push(`Tr.S(${v}.Message);`);
        }
      } else if (x.name === "TypeInitializationException") {
        prelude.push(`Tr.L(${v}.InnerException is null ? 0 : 1);`);
      }
      ctx.scope.vars.push({
        name: v,
        t: et,
        fn: ctx.fn,
        mutable: false,
        capturable: false,
        filterOk: true,
      });
      const handler = this.block(ctx, depth - 1, undefined, prelude);
      ctx.scope = saved.scope;
      ctx.inCatch = saved.inCatch;
      catches.push(`catch (${x.name} ${v})${filter}\n${handler}`);
    }
    if (!catches.length && !hasFinally) return this.logStatement(ctx);
    let text = `Tr.L(${k});\ntry\n${body}\n${catches.join("\n")}`;
    if (hasFinally || !catches.length) {
      const saved = {
        inFinally: ctx.inFinally,
        breakable: ctx.breakable,
        continuable: ctx.continuable,
        inCatch: ctx.inCatch,
      };
      ctx.inFinally = true;
      ctx.breakable = false;
      ctx.continuable = false;
      ctx.inCatch = null;
      text += `\nfinally\n${
        this.block(ctx, Math.min(depth - 1, 1), undefined, [
          `Tr.L(${this.key()});`,
        ])
      }`;
      ctx.inFinally = saved.inFinally;
      ctx.breakable = saved.breakable;
      ctx.continuable = saved.continuable;
      ctx.inCatch = saved.inCatch;
    }
    return text;
  }

  // Closures capturing loop variables, invoked after the loop.
  closureStatement(ctx) {
    const rng = this.rng;
    const saved = ctx.scope;
    if (rng.chance(0.3)) {
      // A local function over captured variables.
      const name = this.name("lf");
      const a = this.name("a");
      const scope = new Scope(ctx.scope);
      scope.vars.push({
        name: a,
        t: T.int,
        fn: null,
        mutable: true,
        capturable: false,
      });
      const inner = this.childFn(ctx, scope);
      inner.budget = 40;
      inner.lambdaDepth = 1;
      scope.vars[0].fn = inner.fn;
      const body = this.expr(inner, T.int, 2);
      return `int ${name}(int ${a}) => ${body};\nTr.L(${name}(${
        this.expr(ctx, T.int, 1)
      }));`;
    }
    const list = this.name("fs");
    const i = this.name("i");
    const trips = rng.range(1, 4);
    const kind = rng.pick(["for", "foreach", "body"]);
    ctx.scope = new Scope(saved);
    const counter = {
      name: i,
      t: T.int,
      fn: ctx.fn,
      mutable: false,
      capturable: true,
    };
    ctx.scope.vars.push(counter);
    const lines = [];
    let fresh = null;
    if (kind === "body") {
      fresh = this.name("c");
      ctx.scope.vars.push({
        name: fresh,
        t: T.int,
        fn: ctx.fn,
        mutable: true,
        capturable: true,
      });
      lines.push(`int ${fresh} = ${i} * ${rng.range(2, 9)};`);
    }
    const inner = this.childFn(ctx, new Scope(ctx.scope));
    inner.budget = 40;
    inner.lambdaDepth = 1;
    const body = this.expr(inner, T.int, 2);
    lines.push(`${list}.Add(() => ${body});`);
    if (fresh && rng.chance(0.5)) lines.push(`${fresh} += ${rng.range(1, 5)};`);
    ctx.scope = saved;
    this.alloc(ctx, 8 * trips);
    ctx.cost += 50 * trips * ctx.weight;
    const header = kind === "foreach"
      ? `foreach (int ${i} in new int[] { ${
        Array.from({ length: trips }, () => rng.range(-3, 9)).join(", ")
      } })`
      : `for (int ${i} = 0; ${i} < ${trips}; ${i}++)`;
    const f = this.name("f");
    return [
      `var ${list} = new List<Func<int>>();`,
      `${header}\n{\n${indent(lines.join("\n"))}\n}`,
      `foreach (var ${f} in ${list}) Tr.L(${f}());`,
    ].join("\n");
  }

  collectionStatement(ctx) {
    const rng = this.rng;
    const cols = this.readable(ctx).filter((v) =>
      ["list", "dict", "set", "queue", "stack"].includes(v.t.k)
    );
    if (!cols.length) {
      const t = this.collectionType(1);
      return this.declare(ctx, t, this.fresh(ctx, t));
    }
    const v = rng.pick(cols);
    const sub = (u) => this.expr(ctx, u, 1);
    ctx.cost += 10 * ctx.weight;
    this.alloc(ctx, 2);
    switch (v.t.k) {
      case "list":
        return rng.weighted([
          [5, () => `${v.name}.Add(${sub(v.t.of)});`],
          [1, () => `${v.name}.Insert(${sub(T.int)} & 3, ${sub(v.t.of)});`],
          [1, () => `${v.name}.RemoveAt(${sub(T.int)} & 3);`],
          [1, () => `Tr.L(${v.name}.Remove(${sub(v.t.of)}) ? 1 : 0);`],
          [1, () => `${v.name}.Clear();`],
          [1, () => `${v.name}.Reverse();`],
          [
            1,
            () =>
              v.t.of.cs === "int"
                ? `Tr.L(${v.name}.RemoveAll(${this.predicate(ctx, v.t.of)}));`
                : `Tr.L(${v.name}.Count);`,
          ],
          [1, () => `${this.log(ctx, `${v.name}.ToArray()`, arrayOf(v.t.of))}`],
          [1, () => {
            const x = this.name("x");
            return v.t.of.cs === "int"
              ? `${v.name}.ForEach(${x} => Tr.L(${x}));`
              : `Tr.L(${v.name}.Count);`;
          }],
          [
            1,
            () =>
              v.t.of.cs === "int"
                ? `Tr.L(${v.name}.Find(${this.predicate(ctx, v.t.of)}));`
                : `Tr.L(${v.name}.Count);`,
          ],
        ])();
      case "dict":
        return rng.weighted([
          [4, () => `${v.name}[${sub(v.t.key)}] = ${sub(v.t.val)};`],
          [2, () => `${v.name}.Add(${sub(v.t.key)}, ${sub(v.t.val)});`],
          [2, () => `Tr.L(${v.name}.Remove(${sub(v.t.key)}) ? 1 : 0);`],
          [1, () => {
            const out = this.name("tv");
            return `if (${v.name}.TryGetValue(${
              sub(v.t.key)
            }, out ${v.t.val.cs} ${out}))\n{\n${
              indent(this.log(ctx, out, v.t.val) ?? "Tr.L(1);")
            }\n}`;
          }],
          [1, () => {
            const out = this.name("rv");
            return `if (${v.name}.Remove(${
              sub(v.t.key)
            }, out var ${out}))\n{\n${
              indent(this.log(ctx, out, v.t.val) ?? "Tr.L(2);")
            }\n}`;
          }],
          [1, () => `${v.name}.Clear();`],
          [2, () => {
            const kv = this.name("kv");
            return `foreach (var ${kv} in ${v.name})\n{\n${
              indent(
                [
                  this.log(ctx, `${kv}.Key`, v.t.key) ?? "Tr.L(3);",
                  this.log(ctx, `${kv}.Value`, v.t.val) ?? "Tr.L(4);",
                ].join("\n"),
              )
            }\n}`;
          }],
        ])();
      case "set":
        return rng.weighted([
          [3, () => `Tr.L(${v.name}.Add(${sub(v.t.of)}) ? 1 : 0);`],
          [1, () => `Tr.L(${v.name}.Remove(${sub(v.t.of)}) ? 1 : 0);`],
          [1, () => `${v.name}.Clear();`],
          [2, () => {
            const x = this.name("sx");
            return `foreach (var ${x} in ${v.name})\n{\n${
              indent(this.log(ctx, x, v.t.of) ?? "Tr.L(5);")
            }\n}`;
          }],
        ])();
      case "queue":
        return rng.weighted([
          [3, () => `${v.name}.Enqueue(${sub(v.t.of)});`],
          [
            1,
            () =>
              `${this.log(ctx, `${v.name}.Dequeue()`, v.t.of) ?? "Tr.L(6);"}`,
          ],
          [1, () => {
            const x = this.name("qx");
            return `if (${v.name}.TryDequeue(out var ${x}))\n{\n${
              indent(this.log(ctx, x, v.t.of) ?? "Tr.L(7);")
            }\n}`;
          }],
          [1, () => `${this.log(ctx, `${v.name}.ToArray()`, arrayOf(v.t.of))}`],
        ])();
      case "stack":
        return rng.weighted([
          [3, () => `${v.name}.Push(${sub(v.t.of)});`],
          [
            1,
            () => `${this.log(ctx, `${v.name}.Pop()`, v.t.of) ?? "Tr.L(8);"}`,
          ],
          [1, () => {
            const x = this.name("kx");
            return `if (${v.name}.TryPeek(out var ${x}))\n{\n${
              indent(this.log(ctx, x, v.t.of) ?? "Tr.L(9);")
            }\n}`;
          }],
          [1, () => `${this.log(ctx, `${v.name}.ToArray()`, arrayOf(v.t.of))}`],
        ])();
    }
    return null;
  }

  structStatement(ctx) {
    const rng = this.rng;
    const locals = this.assignable(ctx).filter((v) =>
      v.t.k === "struct" && !v.t.record
    );
    if (!locals.length) {
      if (!this.structs.length) return this.logStatement(ctx);
      const s = rng.pick(this.structs);
      return this.declare(ctx, s.t, this.newStruct(ctx, s, 1));
    }
    const v = rng.pick(locals);
    const s = v.t.decl;
    const options = [
      [3, () => {
        // A copy is independent of the original.
        const copy = this.name("cp");
        const f = rng.pick(s.fields);
        ctx.scope.vars.push({
          name: copy,
          t: v.t,
          fn: ctx.fn,
          mutable: true,
          capturable: false,
          refable: true,
        });
        return `${s.name} ${copy} = ${v.name};\n${copy}.${f.name} = ${
          this.expr(ctx, f.t, 1)
        };\n${this.log(ctx, v.name, v.t) ?? "Tr.L(10);"}`;
      }],
    ];
    const bump = s.methods.find((m) => m.mutating);
    if (bump && bump.tier > ctx.tier && v.fn === ctx.fn) {
      options.push([3, () => {
        ctx.cost += bump.cost * ctx.weight;
        return `${v.name}.${bump.name}(${this.expr(ctx, T.int, 1)});`;
      }]);
      const nested = s.fields.find((f) =>
        f.t.k === "struct" && f.t.decl.methods.some((m) => m.mutating)
      );
      if (nested) {
        const m = nested.t.decl.methods.find((m) => m.mutating);
        if (m.tier > ctx.tier) {
          options.push([
            2,
            () =>
              `${v.name}.${nested.name}.${m.name}(${
                this.expr(ctx, T.int, 1)
              });`,
          ]);
        }
      }
    }
    if (this.has("refout") && v.refable && v.fn === ctx.fn) {
      const refs = this.callables.filter((c) =>
        c.ready && c.tier > ctx.tier &&
        c.params.some((p) => p.mode !== "val" && same(p.t, v.t))
      );
      if (refs.length) {
        options.push([
          2,
          () => `${this.call(ctx, rng.pick(refs), 1) ?? "Tr.L(11)"};`,
        ]);
      }
    }
    return rng.weighted(options)();
  }

  // A call passing locals by ref or out.
  refStatement(ctx) {
    const rng = this.rng;
    const refs = this.callable(ctx).filter((c) =>
      c.params.some((p) => p.mode !== "val")
    );
    if (this.has("generics")) {
      const vs = this.assignable(ctx).filter((v) =>
        v.refable && v.fn === ctx.fn &&
        (isScalar(v.t) || v.t.k === "string" || v.t.k === "struct")
      );
      if (vs.length && rng.chance(0.3)) {
        const v = rng.pick(vs);
        const w = rng.pick(vs.filter((x) => same(x.t, v.t)));
        return `Gen.Swap<${v.t.cs}>(ref ${v.name}, ref ${w.name});`;
      }
    }
    if (!refs.length) return this.logStatement(ctx);
    const text = this.call(ctx, rng.pick(refs), 1);
    if (text === null) {
      const ints = [T.int, T.long];
      const t = rng.pick(ints);
      return this.declare(ctx, t, literal(rng, t), { capturable: false });
    }
    return `${text};`;
  }

  deconstructStatement(ctx) {
    const rng = this.rng;
    const rs = this.readable(ctx).filter((v) =>
      v.t.record && v.t.record.all.length >= 2
    );
    if (!rs.length) {
      if (!this.records.length) return this.logStatement(ctx);
      const r = rng.pick(this.records);
      return this.declare(ctx, r.t, this.newRecord(ctx, r, 1));
    }
    const v = rng.pick(rs);
    const names = v.t.record.all.map((p) => {
      if (rng.chance(0.2)) return null;
      const n = this.name("d");
      ctx.scope.vars.push({
        name: n,
        t: p.t,
        fn: ctx.fn,
        mutable: true,
        capturable: false,
        refable: true,
      });
      return [n, p.t];
    });
    const decon = `var (${
      names.map((x) => x ? x[0] : "_").join(", ")
    }) = ${v.name};`;
    const logs = names.filter(Boolean).map(([n, t]) => this.log(ctx, n, t))
      .filter(Boolean);
    if (v.t.k === "record") {
      // Declarations inside the guard are not visible after it.
      for (const x of names) {
        if (x) {
          ctx.scope.vars = ctx.scope.vars.filter((y) => y.name !== x[0]);
        }
      }
      return `if (${v.name} is not null)\n{\n${
        indent([decon, ...logs].join("\n"))
      }\n}`;
    }
    return [decon, ...logs].join("\n");
  }

  // -------------------------------------------------------------------------
  // Bodies of declared types

  // A function context for a callable body.
  fnCtx(tier, ret, params, extra = {}) {
    const scope = new Scope(null);
    const fn = {};
    for (const p of params) {
      scope.vars.push({
        name: p.name,
        t: p.t,
        fn,
        mutable: p.mode !== "in",
        capturable: p.mode === "val" && this.has("closures") &&
          this.rng.chance(0.3),
        refable: p.mode === "val" ? false : true,
      });
      const v = scope.vars[scope.vars.length - 1];
      if (p.mode !== "val") v.refable = true;
      else v.refable = !v.capturable;
    }
    return {
      tier,
      ret,
      scope,
      fn,
      cost: 1,
      weight: 1,
      budget: FN_BUDGET,
      loops: 0,
      breakable: false,
      continuable: false,
      inFinally: false,
      inCatch: null,
      inFilter: false,
      lambdaDepth: 0,
      self: null,
      selfMutable: false,
      ...extra,
    };
  }

  // Leaf helpers: scalar signatures, calling only higher leaves.
  declareLeaves() {
    const rng = this.rng;
    const n = rng.range(2, 4);
    const leaves = [];
    for (let i = 0; i < n; i++) {
      const name = this.name("L");
      const params = [];
      for (let j = rng.range(1, 2); j > 0; j--) {
        params.push({
          name: this.name("p"),
          t: rng.pick(
            [T.int, T.int, T.long, T.double, T.bool].filter((t) =>
              this.scalarTypes().includes(t)
            ),
          ),
          mode: "val",
        });
      }
      const ret = rng.pick([
        T.int,
        T.int,
        T.long,
        T.bool,
        ...(this.has("float") ? [T.double] : []),
      ]);
      leaves.push(
        this.addCallable({
          name: `Lf.${name}`,
          short: name,
          tier: 300 - i,
          params: params.map((p) => ({ t: p.t, mode: "val" })),
          ret,
          cost: 1,
          group: true,
          decl: params,
        }),
      );
    }
    const out = [];
    for (const c of leaves) {
      const ctx = this.fnCtx(c.tier, c.ret, c.decl);
      ctx.budget = 60;
      const body = unchecked(this.block(ctx, 1, c.ret));
      c.cost = ctx.cost;
      c.ready = true;
      out.push(
        `public static ${c.ret.cs} ${c.short}(${
          c.decl.map((p) => `${p.t.cs} ${p.name}`).join(", ")
        })\n${body}`,
      );
    }
    this.decls.push([
      7,
      `internal static class Lf\n{\n${indent(out.join("\n\n"))}\n}`,
    ]);
  }

  // Bounded recursion: the depth argument is masked below 16.
  declareRecursion() {
    const rng = this.rng;
    const name = this.name("Rec");
    const c = this.addCallable({
      name: `Lf2.${name}`,
      tier: 190,
      params: [{ t: T.int, mode: "val" }, { t: T.int, mode: "val" }],
      ret: T.int,
      cost: 200,
    });
    const ctx = this.fnCtx(191, T.int, [{ name: "n", t: T.int, mode: "val" }, {
      name: "acc",
      t: T.int,
      mode: "val",
    }]);
    ctx.budget = 10;
    const step = this.expr(ctx, T.int, 1);
    const tail = rng.chance(0.5);
    const body = tail
      ? `if (n <= 0) return acc;\nTr.L(n);\nreturn ${name}(n - 1, acc * 3 + ${step});`
      : `if (n <= 0) return acc;\nint r = ${name}(n - 1, acc + 1);\nTr.L(r);\nreturn r * 7 + ${step};`;
    const method = `public static int ${name}(int n, int acc)\n${
      unchecked(`{\n${indent(`n &= 15;\n${body}`)}\n}`)
    }`;
    this.decls.push([7, `internal static class Lf2\n{\n${indent(method)}\n}`]);
    c.ready = true;
  }

  declareStructBodies() {
    for (const s of this.structs) {
      if (s.record) continue;
      const tier = 250 + this.structs.indexOf(s);
      const bump = { name: "Bump", tier, mutating: true, cost: 5 };
      const sum = { name: "Sum", tier, cost: 5 };
      s.methods = [bump, sum];
      const intField = s.fields.find((f) => isInt(f.t) && f.t.cs !== "char") ??
        null;
      const bumpBody = s.fields.filter((f) =>
        isScalar(f.t) && f.t.cs !== "bool"
      ).map((f) =>
        f.t.cs === "int"
          ? `${f.name} += d;`
          : isFloat(f.t)
          ? `${f.name} += d;`
          : `${f.name} = (${f.t.cs})(${f.name} + ${
            f.t.cs === "ulong" ? "(ulong)d" : "d"
          });`
      );
      const nestedBump = s.fields.filter((f) => f.t.k === "struct").map((f) =>
        `${f.name}.Bump(d + 1);`
      );
      const sumTerms = s.fields.filter((f) =>
        isScalar(f.t) && isInt(f.t) && f.t.cs !== "ulong"
      ).map((f) => `(long)${f.name}`);
      const text = `internal struct ${s.name} : ICounter
{
${s.fields.map((f) => `    public ${f.t.cs} ${f.name};`).join("\n")}

    public ${s.name}(${
        s.fields.map((f) => `${f.t.cs} ${f.name.toLowerCase()}`).join(", ")
      })
    {
${
        s.fields.map((f) => `        ${f.name} = ${f.name.toLowerCase()};`)
          .join("\n")
      }
    }

    public void Bump(int d)
    {
${
        [
          ...bumpBody,
          ...nestedBump,
          `Tr.L(${intField ? `(long)${intField.name}` : "d"});`,
        ].map((l) => "        " + l).join("\n")
      }
    }

    public readonly long Sum() => ${
        sumTerms.length ? sumTerms.join(" + ") : "0L"
      };

    public int Next(int d)
    {
        Bump(d);
        return (int)Sum();
    }

    public static ${s.name} operator +(${s.name} a, int d)
    {
        a.Bump(d);
        return a;
    }

    public static implicit operator long(${s.name} value) => value.Sum();
}`;
      this.decls.push([2, text]);
      bump.ready = true;
      // The struct's ref/out helpers.
      if (this.has("refout")) {
        const r = this.addCallable({
          name: `Refs.Swap${s.name}`,
          tier: 240,
          params: [{ t: s.t, mode: "ref" }, { t: s.t, mode: "ref" }],
          cost: 2,
        });
        const o = this.addCallable({
          name: `Refs.Make${s.name}`,
          tier: 240,
          params: [{ t: T.int, mode: "val" }, { t: s.t, mode: "out" }],
          ret: T.bool,
          cost: 2,
        });
        const b = this.addCallable({
          name: `Refs.Bump${s.name}`,
          tier: 240,
          params: [{ t: s.t, mode: "ref" }, { t: T.int, mode: "val" }],
          ret: T.long,
          cost: 8,
        });
        r.ready = o.ready = b.ready = true;
        this.refsDecls = this.refsDecls ?? [];
        this.refsDecls.push(
          `public static void Swap${s.name}(ref ${s.name} a, ref ${s.name} b)
{
    ${s.name} t = a;
    a = b;
    b = t;
}

public static bool Make${s.name}(int seed, out ${s.name} value)
{
    value = default;
${
            s.fields.filter((f) => isScalar(f.t) && f.t.cs !== "bool").map((
              f,
            ) => `    value.${f.name} = (${f.t.cs})seed;`).join("\n")
          }
    return seed > 0;
}

public static long Bump${s.name}(ref ${s.name} value, int d)
{
    value.Bump(d);
    ${s.name} copy = value;
    copy.Bump(d);
    return value.Sum() - copy.Sum();
}`,
        );
      }
    }
    if (this.has("refout")) {
      const inc = this.addCallable({
        name: "Refs.Inc",
        tier: 240,
        params: [{ t: T.int, mode: "ref" }, { t: T.int, mode: "val" }],
        ret: T.int,
        cost: 1,
      });
      const split = this.addCallable({
        name: "Refs.Split",
        tier: 240,
        params: [{ t: T.long, mode: "val" }, { t: T.int, mode: "out" }, {
          t: T.int,
          mode: "out",
        }],
        cost: 1,
      });
      inc.ready = split.ready = true;
      this.refsDecls = this.refsDecls ?? [];
      this.refsDecls.push(`public static int Inc(ref int x, int by)
{
    int old = x;
    x += by;
    Tr.L(x);
    return old;
}

public static void Split(long v, out int lo, out int hi)
{
    lo = (int)v;
    hi = (int)(v >> 32);
}`);
      this.decls.push([
        7,
        `internal static class Refs\n{\n${
          indent(this.refsDecls.join("\n\n"))
        }\n}`,
      ]);
    }
  }

  declareClassBodies() {
    const rng = this.rng;
    // Virtual slot bodies, then constructors, root first.
    const texts = new Map();
    for (const c of this.classes) {
      const members = [];
      for (const f of c.fields) {
        const init = f.init
          ? ` = ${
            f.t.cs === "int"
              ? `Tr.Pi(${this.key()}, ${literal(rng, T.int)})`
              : literal(rng, f.t)
          }`
          : "";
        members.push(`public ${f.t.cs} ${f.name}${init};`);
      }
      if (this.has("strings") && rng.chance(0.4)) {
        // Some classes print themselves; the others print their type's name.
        const f = c.fields.find((x) => printable(x.t));
        members.push(
          `public override string ToString() => "${c.name}:" + ${
            f ? f.name : '"-"'
          };`,
        );
      }
      if (!c.parent) {
        // Accessors with side effects, for compound assignments through them.
        members.push(`public int PropValue;`);
        members.push(
          `public int Prop\n{\n    get { Tr.L(${this.key()}); return PropValue; }\n    set { Tr.L(${this.key()}); PropValue = value; }\n}`,
        );
        members.push(`public int[] Cells = new int[4];`);
        members.push(
          `public int this[int i]\n{\n    get { Tr.L(${this.key()}); return Cells[i]; }\n    set { Tr.L(${this.key()}); Cells[i] = value; }\n}`,
        );
      }
      if (c.staticCtor) {
        members.push(`public static int Instances;`);
        members.push(
          `static ${c.name}()\n{\n    Tr.L(${this.key()});\n    Instances = ${
            rng.range(1, 9)
          };\n}`,
        );
      }
      // Constructor: parameters for this class's own fields plus the base's.
      const params = [];
      const base = c.parent?.ctorParams ?? [];
      const own = c.fields.filter((f) => f.t.k !== "struct").map((f) => ({
        name: this.name("cp"),
        t: f.t,
        field: f,
      }));
      c.ctorParams = [...base.map((p) => ({ ...p })), ...own];
      params.push(...c.ctorParams);
      const ctx = this.fnCtx(
        90,
        undefined,
        params.map((p) => ({ name: p.name, t: p.t, mode: "val" })),
        { self: c, selfMutable: true },
      );
      ctx.budget = 200;
      const body = [`Tr.L(${this.key()});`];
      for (const p of own) body.push(`${p.field.name} = ${p.name};`);
      // A virtual call from a constructor reaches the override.
      if (c.slots.length && rng.chance(0.4)) {
        const s = rng.pick(c.slots);
        body.push(
          `Tr.L(${s.name}(${
            s.params.map((t) => this.expr(ctx, t, 0)).join(", ")
          }));`,
        );
        ctx.cost += 30;
      }
      if (rng.chance(0.4)) body.push(this.statement(ctx, 1));
      const baseCall = c.parent
        ? ` : base(${base.map((p) => p.name).join(", ")})`
        : "";
      if (!c.abstract) {
        members.push(
          `public ${c.name}(${
            params.map((p) => `${p.t.cs} ${p.name}`).join(", ")
          })${baseCall}\n${unchecked(`{\n${indent(body.join("\n"))}\n}`)}`,
        );
      } else {
        members.push(
          `protected ${c.name}(${
            params.map((p) => `${p.t.cs} ${p.name}`).join(", ")
          })${baseCall}\n${unchecked(`{\n${indent(body.join("\n"))}\n}`)}`,
        );
      }
      c.ctor = {
        tier: 90,
        params: params.map((p) => p.t),
        cost: (c.parent?.ctor?.cost ?? 0) + ctx.cost + 30,
      };
      // Slots: declare (root) or override.
      c.overrides = new Set();
      c.sealedSlots = new Set(c.parent?.sealedSlots ?? []);
      for (const s of c.slots) {
        const declaredHere = s.owner === c;
        const abstractAbove = !declaredHere && this.slotAbstractIn(c.parent, s);
        const mustOverride = abstractAbove && !c.abstract;
        if (
          !declaredHere &&
          (c.sealedSlots.has(s) || (!mustOverride && !rng.chance(0.5)))
        ) continue;
        const pnames = s.params.map(() => this.name("x"));
        const signature = `${s.ret.cs} ${s.name}(${
          pnames.map((n, i) => `${s.params[i].cs} ${n}`).join(", ")
        })`;
        if (declaredHere && s.abstract) {
          members.push(`public abstract ${signature};`);
          continue;
        }
        c.overrides.add(s);
        const mctx = this.fnCtx(
          s.tier,
          s.ret,
          pnames.map((n, i) => ({ name: n, t: s.params[i], mode: "val" })),
          { self: c, selfMutable: true },
        );
        mctx.budget = 300;
        const prelude = [`Tr.L(${this.key()});`];
        if (!declaredHere && !abstractAbove && rng.chance(0.6)) {
          prelude.push(`Tr.L(base.${s.name}(${pnames.join(", ")}));`);
          mctx.cost += s.cost ?? 30;
        }
        const bodyText = unchecked(this.block(mctx, 2, s.ret, prelude));
        s.cost = Math.max(s.cost ?? 0, mctx.cost + 20);
        let mod = "virtual";
        if (!declaredHere) {
          mod = "override";
          if (!c.sealed && rng.chance(0.2)) {
            mod = "sealed override";
            c.sealedSlots.add(s);
          }
        }
        members.push(`public ${mod} ${signature}\n${bodyText}`);
      }
      // Interfaces.
      for (const i of c.ifaces) {
        const explicit = rng.chance(0.3);
        const x = this.name("x");
        const mctx = this.fnCtx(i.method.tier, T.int, [{
          name: x,
          t: T.int,
          mode: "val",
        }], { self: c, selfMutable: true });
        mctx.budget = 200;
        const bodyText = unchecked(
          this.block(mctx, 1, T.int, [`Tr.L(${this.key()});`]),
        );
        i.cost = Math.max(i.cost ?? 0, mctx.cost + 20);
        members.push(
          explicit
            ? `int ${i.name}.Get${i.name}(int ${x})\n${bodyText}`
            : `public int Get${i.name}(int ${x})\n${bodyText}`,
        );
        const f = c.all.find((f) => f.t.cs === "int");
        members.push(
          explicit
            ? `int ${i.name}.P${i.name} => ${f ? f.name : rng.range(0, 9)};`
            : `public int P${i.name} => ${f ? f.name : rng.range(0, 9)};`,
        );
      }
      const bases = [c.parent?.name, ...c.ifaces.map((i) => i.name)].filter(
        Boolean,
      );
      texts.set(
        c,
        `internal ${
          c.abstract ? "abstract " : c.sealed ? "sealed " : ""
        }class ${c.name}${bases.length ? " : " + bases.join(", ") : ""}\n{\n${
          indent(members.join("\n\n"))
        }\n}`,
      );
    }
    for (const [, text] of texts) this.decls.push([5, text]);
    // Callables: virtual slots (through a receiver of the root's type or a
    // subclass), interface methods.
    for (const c of this.classes) {
      for (const s of c.slots) {
        if (s.owner !== c) continue;
        s.cost = s.cost ?? 30;
      }
    }
  }

  slotAbstractIn(c, s) {
    // Whether slot s is still abstract along the chain ending in c.
    for (let x = c; x; x = x.parent) {
      if (x.overrides?.has(s)) return false;
    }
    return s.abstract;
  }

  declareStaticBodies() {
    const rng = this.rng;
    for (const st of this.statics) {
      const ctx = this.fnCtx(160, undefined, []);
      ctx.budget = 100;
      const lines = [];
      for (const f of st.fields) {
        if (rng.chance(0.5)) {
          lines.push(
            `public static ${f.t.cs} ${f.name} = Tr.P${
              f.t.cs === "int" ? "i" : "l"
            }(${this.key()}, ${literal(rng, f.t)});`,
          );
        } else lines.push(`public static ${f.t.cs} ${f.name};`);
      }
      const body = [`Tr.L(${this.key()});`];
      for (const f of st.fields) {
        if (rng.chance(0.5)) {
          body.push(`${f.name} = ${this.expr(ctx, f.t, 1)};`);
        }
      }
      // Another initialized class, read from this one's initializer.
      const others = this.statics.filter((o) => o !== st && o.ready);
      if (others.length && rng.chance(0.5)) {
        const o = rng.pick(others);
        body.push(`Tr.L(${o.name}.${rng.pick(o.fields).name});`);
      }
      if (st.fails) {
        body.push(
          `if (${st.fields[0].name} ${rng.pick([">", "<", "!="])} ${
            rng.range(-5, 5)
          }) throw new ${rng.pick(this.excs).name}(${
            rng.range(1, 99)
          }, "init");`,
        );
      }
      lines.push(
        `static ${st.name}()\n${unchecked(`{\n${indent(body.join("\n"))}\n}`)}`,
      );
      const x = this.name("x");
      lines.push(
        `public static int Touch(int ${x})\n{\n    Tr.L(${x});\n    return ${x} + (int)${
          st.fields[0].name
        };\n}`,
      );
      this.decls.push([
        6,
        `internal static class ${st.name}\n{\n${indent(lines.join("\n\n"))}\n}`,
      ]);
      st.ready = true;
      this.addCallable({
        name: `${st.name}.Touch`,
        tier: 150,
        params: [{ t: T.int, mode: "val" }],
        ret: T.int,
        cost: 20,
        ready: true,
      });
    }
  }

  // Receiver-based callables: virtual and interface calls need a receiver
  // of the type in scope.
  receiverCallables() {
    for (const c of this.classes) {
      for (const s of c.slots) {
        if (s.owner !== c) continue;
        this.addCallable({
          name: s.name,
          tier: s.tier,
          params: s.params.map((t) => ({ t, mode: "val" })),
          ret: s.ret,
          cost: s.cost,
          ready: true,
          receiver: c.t,
          method: s.name,
        });
      }
    }
    for (const i of this.ifaces) {
      this.addCallable({
        name: i.method.name,
        tier: i.method.tier,
        params: [{ t: T.int, mode: "val" }],
        ret: T.int,
        cost: i.cost ?? 30,
        ready: true,
        receiver: i.t,
        method: i.method.name,
      });
    }
    // A receiver call needs a variable of a type deriving from the receiver.
    for (const c of this.callables) {
      if (!c.receiver) continue;
      const recv = c.receiver;
      c.target = (ctx) => {
        const vs = this.readable(ctx).filter((v) =>
          (v.t.k === "class" && recv.k === "class" &&
            this.derives(v.t.decl, recv.decl)) ||
          (v.t.k === "class" && recv.k === "iface" &&
            this.implemented(v.t.decl).includes(recv.decl)) ||
          (v.t.k === "iface" && recv.k === "iface" && v.t.decl === recv.decl)
        );
        if (!vs.length) {
          return `((${recv.cs})${this.fresh(ctx, recv)}).${c.method}`;
        }
        const v = this.rng.pick(vs);
        return recv.k === "iface" && v.t.k === "class"
          ? `((${recv.cs})${v.name}).${c.method}`
          : `${v.name}.${c.method}`;
      };
    }
  }

  // Helper methods: arbitrary signatures, generated from the highest tier down.
  declareHelpers() {
    const rng = this.rng;
    const n = Math.round(rng.range(3, 8) * this.size);
    const helpers = [];
    for (let i = 0; i < n; i++) {
      const params = [];
      for (let j = rng.range(0, 3); j > 0; j--) {
        params.push({
          name: this.name("p"),
          t: this.valueType(1),
          mode: "val",
        });
      }
      const ret = rng.chance(0.15) ? null : this.valueType(1);
      helpers.push({
        name: `H.${this.name("M")}`,
        tier: 10 + n - i,
        decl: params,
        params: params.map((p) => ({ t: p.t, mode: "val" })),
        ret,
        cost: 1,
      });
    }
    const out = [];
    // Highest tier first: its callees are ready when a lower one is built.
    for (const h of helpers) {
      const ctx = this.fnCtx(h.tier, h.ret, h.decl);
      const body = unchecked(this.block(ctx, 3, h.ret));
      h.cost = ctx.cost + 1;
      h.ready = true;
      this.addCallable(h);
      out.push(
        `public static ${h.ret ? h.ret.cs : "void"} ${h.name.slice(2)}(${
          h.decl.map((p) => `${p.t.cs} ${p.name}`).join(", ")
        })\n${body}`,
      );
    }
    this.decls.push([
      8,
      `internal static class H\n{\n${indent(out.join("\n\n"))}\n}`,
    ]);
  }

  declareEntries() {
    const rng = this.rng;
    const n = Math.round(rng.range(2, 5) * this.size);
    const out = [];
    const entries = [];
    for (let i = 0; i < n; i++) {
      const params = [];
      for (let j = rng.range(0, 3); j > 0; j--) {
        params.push({
          name: this.name("a"),
          t: rng.pick(this.scalarTypes()),
          mode: "val",
        });
      }
      const ret = rng.pick(this.scalarTypes());
      const ctx = this.fnCtx(0, ret, params, { budget: ENTRY_BUDGET });
      const body = unchecked(this.block(ctx, 3, ret, [`Tr.H = ${i + 1};`]));
      const name = `E${i}`;
      out.push(
        `public static ${ret.cs} ${name}(${
          params.map((p) => `${p.t.cs} ${p.name}`).join(", ")
        })\n${body}`,
      );
      entries.push({ name, params: params.map((p) => p.t.cs), ret: ret.cs });
    }
    out.push("public static long Trace() => Tr.H;");
    this.decls.push([
      9,
      `public static class Entry\n{\n${indent(out.join("\n\n"))}\n}`,
    ]);
    return entries;
  }

  program() {
    const rng = this.rng;
    this.declareTypes();
    this.declareLeaves();
    if (this.has("recursion")) this.declareRecursion();
    if (this.has("structs")) this.declareStructBodies();
    if (this.has("classes")) this.declareClassBodies();
    if (this.has("statics")) this.declareStaticBodies();
    this.receiverCallables();
    this.declareHelpers();
    const entries = this.declareEntries();
    const calls = [];
    // Each entry runs a few times with different inputs; static state
    // carries over between calls, as in one instance.
    for (let round = 0; round < 2; round++) {
      for (const e of entries) {
        if (round === 1 && rng.chance(0.5)) continue;
        calls.push({
          method: `Fuzz.Entry.${e.name}`,
          params: e.params,
          ret: e.ret,
          args: e.params.map((p) => argumentValue(rng, T[p])),
        });
        calls.push({
          method: "Fuzz.Entry.Trace",
          params: [],
          ret: "long",
          args: [],
        });
      }
    }
    this.decls.push([
      2,
      "internal interface ICounter\n{\n    int Next(int d);\n}",
    ]);
    const later = [...NEW_FEATURES, ...LIBRARY_FEATURES].some((f) =>
      this.has(f)
    );
    if (later) this.decls.push([2, prelude((f) => this.has(f))]);
    this.decls.sort((a, b) => a[0] - b[0]);
    const source = [
      "// Generated by tilde/aseipp/cs2wasm/fuzz (seed " + this.seed + ").",
      "using System;",
      "using System.Collections.Generic;",
      ...(later ? ["using System.Linq;", "using System.Globalization;"] : []),
      "using System.Numerics;",
      ...(this.has("vectors") ? ["using System.Runtime.Intrinsics;"] : []),
      "",
      "namespace Fuzz;",
      "",
      TRACE,
      ...this.decls.map((d) => d[1] + "\n"),
    ].join("\n");
    return { source, calls };
  }
}

const TRACE = `internal static class Tr
{
    public static long H;

    public static int Zero;

    public static long ZeroL;

    public static void L(long v) { H = H * 1000003L + v; }

    public static void LD(double d) { L(double.IsNaN(d) ? 0x7ff8L : (long)(d * 4096.0)); L(d < 0 ? 1 : 0); }

    public static void S(string s)
    {
        if (s == null) { L(-77); return; }
        L(s.Length);
        for (int i = 0; i < s.Length; i++) L(s[i]);
    }

    public static bool F(long k, bool b) { L(k); return b; }

    public static int Pi(long k, int v) { L(k); L(v); return v; }

    public static long Pl(long k, long v) { L(k); L(v); return v; }

    public static uint Pu(long k, uint v) { L(k); L(v); return v; }

    public static ulong Pul(long k, ulong v) { L(k); L((long)v); return v; }

    public static double Pd(long k, double v) { L(k); LD(v); return v; }

    public static TA Id<TA>(long k, TA v) { L(k); return v; }

    // The sign of a NaN is unspecified in Wasm (and the CLR's double.NaN is
    // negative where JavaScript's is not): CopySign takes its sign from these.
    public static double Sign(double v) => double.IsNaN(v) ? 1.0 : v;

    public static float SignF(float v) => float.IsNaN(v) ? 1f : v;

    public static bool Throws(long k, int v)
    {
        L(k);
        if (v != 0) throw new InvalidOperationException("filter");
        return true;
    }
}
`;

const PATTERN_VALUES = {
  int: [0, 1, 2, 3, 5, 7, -1, 100, 255].map((
    v,
  ) => [v < 0 ? `(${v})` : String(v), v]),
  long: [0, 1, 2, 5, 7, -1, 100].map((v) => [v < 0 ? `(${v}L)` : `${v}L`, v]),
  byte: [0, 1, 2, 7, 128, 255].map((v) => [String(v), v]),
  char: [["'a'", 97], ["'0'", 48], ["'z'", 122], ["'\\u0000'", 0], ["'A'", 65]],
  double: [["0.0", 0], ["1.5", 1.5], ["(-1.0)", -1], ["double.NaN", NaN], [
    "100.0",
    100,
  ], ["2.5", 2.5]],
  string: [['""', 0], ['"a"', 1], ['"ab"', 2], ['"hello"', 3], ["null", 4]],
};
const PATTERN_RANGE = {
  int: [-2147483648, 2147483647],
  long: [-(2 ** 63), 2 ** 63],
  byte: [0, 255],
  char: [0, 65535],
  double: [-Infinity, Infinity],
};

// Constant expressions are checked by default; the program's arithmetic is
// meant to wrap, as the CLR's unchecked arithmetic does.
function unchecked(block) {
  return `{\n${indent(`unchecked\n${block}`)}\n}`;
}

export { indent, literal };

function indent(text) {
  return text.split("\n").map((l) => (l.length ? "    " + l : l)).join("\n");
}
