// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The differential fuzzer's driver: generate programs from seeds, compile
// them with gameplayc and run them in Wasm, compare with the CLR oracle, and
// write (and optionally minimize) a reproducer for every finding.
//
//   fuzz.mjs --gameplayc G --oracle O --dotnet-root D [--seeds N] [--start S]
//            [--jobs J] [--out DIR] [--test] [--minimize] [--features a,b]
//            [--without a,b] [--all-features] [--size F]
//            [--compiler-flag F ...]
//   fuzz.mjs ... --repro FILE.json [--minimize]
//
// See README.md.
import { FEATURES, generate, KNOWN_ISSUES } from "./gen.mjs";
import { LIBRARY_FEATURES } from "./features.mjs";
import { check, NOT_FINDINGS, OraclePool, WasmPool } from "./run.mjs";
import { minimize } from "./minimize.mjs";

function parse(argv) {
  const options = {
    seeds: 100,
    start: 1,
    jobs: navigator.hardwareConcurrency ?? 4,
    size: 1,
    test: false,
    minimize: false,
    minimizePerSignature: 1,
    compilerFlags: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    switch (flag) {
      case "--gameplayc":
        options.gameplayc = value();
        break;
      case "--oracle":
        options.oracle = value();
        break;
      case "--dotnet-root":
        options.dotnetRoot = value();
        break;
      case "--seeds":
        options.seeds = Number(value());
        break;
      case "--start":
        options.start = Number(value());
        break;
      case "--jobs":
        options.jobs = Number(value());
        break;
      case "--out":
        options.out = value();
        break;
      case "--size":
        options.size = Number(value());
        break;
      case "--test":
        options.test = true;
        break;
      case "--each":
        options.each = true;
        break;
      case "--poison":
        options.poison = true;
        break;
      case "--minimize":
        options.minimize = true;
        break;
      // Passed to gameplayc before its own flags (--runtime-async).
      case "--compiler-flag":
        options.compilerFlags.push(value());
        break;
      case "--minimize-per-signature":
        options.minimizePerSignature = Number(value());
        break;
      case "--features":
        options.features = value().split(",").filter(Boolean);
        break;
      case "--without":
        options.without = value().split(",").filter(Boolean);
        break;
      case "--all-features":
        options.allFeatures = true;
        break;
      case "--emit":
        options.emit = Number(value());
        break;
      case "--repro":
        options.repro = value();
        break;
      case "--help":
        console.log("See tilde/aseipp/cs2wasm/fuzz/README.md.");
        Deno.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${flag}`);
    }
  }
  for (const required of ["gameplayc", "oracle", "dotnetRoot"]) {
    if (!options[required]) {
      throw new Error(
        `--${
          required.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())
        } is required`,
      );
    }
  }
  const known = [...FEATURES, ...LIBRARY_FEATURES];
  let features = options.features ??
    known.filter((f) => options.allFeatures || !KNOWN_ISSUES.includes(f));
  if (options.without) {
    features = features.filter((f) => !options.without.includes(f));
  }
  for (const f of features) {
    if (!known.includes(f)) {
      throw new Error(`Unknown feature ${f}; known: ${known.join(",")}`);
    }
  }
  options.featureList = features;
  return options;
}

function absolute(path) {
  return path.startsWith("/") ? path : `${Deno.cwd()}/${path}`;
}

const options = parse(Deno.args);
const gameplayc = absolute(options.gameplayc);
// The JIT layouts of both the compiler and the oracle find their runtime
// through DOTNET_ROOT.
const env = { DOTNET_ROOT: absolute(options.dotnetRoot) };
// The pinned runtime's JIT has bugs on linux-arm64 either way: unoptimized
// code miscomputes some intrinsics, and the optimizing JIT crashes on some
// programs. The oracle optimizes everything (no tiering, so the answer does
// not depend on how often a method ran), and a request that kills it is
// asked again of one that does not optimize.
const oracle = new OraclePool(
  absolute(options.oracle),
  { ...env, DOTNET_TieredCompilation: "0" },
  Math.max(1, Math.ceil(options.jobs / 2)),
  {
    path: absolute(options.oracle),
    env: { ...env, DOTNET_JITMinOpts: "1" },
  },
);
const wasm = new WasmPool(Math.max(1, Math.ceil(options.jobs / 4)));
const scratch = await Deno.makeTempDir({ prefix: "cs2wasm-fuzz-" });
const out = options.out ? absolute(options.out) : null;
if (out) await Deno.mkdir(out, { recursive: true });

async function checkProgram(name, source, calls) {
  return await check({
    gameplayc,
    env,
    oracle,
    wasm,
    dir: scratch,
    name,
    source,
    calls,
    poison: options.poison,
    flags: options.compilerFlags,
  });
}

// A class whose static field initializers have side effects must keep its
// static constructor: without one it is beforefieldinit, and the CLR may run
// them at any time before the first access.
function deterministic(source) {
  for (const m of source.matchAll(/public static \w+ (\w+?)v\d+ = Tr\./g)) {
    if (!source.includes(`static ${m[1]}()`)) return false;
  }
  return true;
}

// A minimizer's test: the same category and, where it is stable, signature.
function reproduces(finding) {
  let n = 0;
  return async (source, calls) => {
    if (!deterministic(source)) return false;
    const result = await checkProgram(
      `min-${finding.seed}-${n++}`,
      source,
      calls,
    );
    await Deno.remove(`${scratch}/min-${finding.seed}-${n - 1}.cs`).catch(
      () => {},
    );
    if (result.category !== finding.category) return false;
    if (
      ["wrong-value", "wrong-trace", "missing-fault"].includes(finding.category)
    ) return true;
    return result.signature === finding.signature;
  };
}

// One minimization at a time, with every job's worth of parallelism.
let reducing = Promise.resolve();

function reduce(finding) {
  const run = reducing.then(() => reduceNow(finding));
  reducing = run.catch(() => {});
  return run;
}

async function reduceNow(finding) {
  const started = Date.now();
  const result = await minimize({
    source: finding.source,
    calls: finding.calls,
    test: reproduces(finding),
    jobs: Math.max(2, options.jobs),
  });
  const confirm = await checkProgram(
    `confirm-${finding.seed}`,
    result.source,
    result.calls,
  );
  return { ...result, seconds: (Date.now() - started) / 1000, confirm };
}

async function save(finding, minimized) {
  if (!out) return;
  const dir = `${out}/${finding.category}`;
  await Deno.mkdir(dir, { recursive: true });
  const base = `${dir}/${finding.seed}`;
  await Deno.writeTextFile(`${base}.cs`, finding.source);
  const record = { ...finding };
  delete record.source;
  if (minimized) {
    await Deno.writeTextFile(`${base}.min.cs`, minimized.source);
    record.minimized = {
      calls: minimized.calls,
      tests: minimized.tests,
      seconds: minimized.seconds,
      confirm: minimized.confirm,
    };
  }
  await Deno.writeTextFile(
    `${base}.json`,
    JSON.stringify(record, null, 2) + "\n",
  );
}

// The calls of a program without a record: every entry of Fuzz.Entry, with
// zero arguments, each followed by Trace when the program has it.
function entryCalls(source) {
  const calls = [];
  const trace = /public static long Trace\(\)/.test(source);
  const entry = source.slice(
    Math.max(0, source.indexOf("public static class Entry")),
  );
  for (const m of entry.matchAll(/public static (\w+) (\w+)\(([^)]*)\)/g)) {
    if (m[2] === "Trace") continue;
    const params = m[3].trim()
      ? m[3].split(",").map((p) => p.trim().split(/\s+/)[0])
      : [];
    calls.push({
      method: `Fuzz.Entry.${m[2]}`,
      params,
      ret: m[1],
      args: params.map(() => "0"),
    });
    if (trace) {
      calls.push({
        method: "Fuzz.Entry.Trace",
        params: [],
        ret: "long",
        args: [],
      });
    }
  }
  return calls;
}

// --repro X.json checks X.cs with the recorded calls; --repro X.cs or
// X.min.cs uses the calls recorded in X.json (the minimized ones for
// X.min.cs), or every entry with zero arguments when there is no record.
async function repro() {
  const path = options.repro;
  const base = path.replace(/(\.min)?\.(cs|json)$/, "");
  const minimized = path.endsWith(".min.cs");
  const sourcePath = path.endsWith(".json") ? `${base}.cs` : path;
  const source = await Deno.readTextFile(sourcePath);
  let record = null;
  try {
    record = JSON.parse(await Deno.readTextFile(`${base}.json`));
  } catch {
    // No record.
  }
  const calls = (minimized ? record?.minimized?.calls : record?.calls) ??
    entryCalls(source);
  if (options.each) {
    // Every entry on its own: the program without the other entries of
    // Fuzz.Entry (so one rejected entry does not hide the others), on a fresh
    // instance and oracle load.
    const start = source.indexOf("public static class Entry");
    const entry = start < 0 ? "" : source.slice(start, source.lastIndexOf("}"));
    const members = entry.split(/\n(?= {4}public static )/);
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].method.endsWith(".Trace")) continue;
      const one = calls[i + 1]?.method.endsWith(".Trace")
        ? calls.slice(i, i + 2)
        : [calls[i]];
      const name = calls[i].method.slice(calls[i].method.lastIndexOf(".") + 1);
      const kept = members.filter((m, j) =>
        j === 0 || !/^ {4}public static \S+ \w+\(/.test(m) ||
        new RegExp(`^ {4}public static \\S+ (${name}|Trace)\\(`).test(m)
      );
      const own = start < 0
        ? source
        : `${source.slice(0, start)}${kept.join("\n")}\n}\n`;
      const r = await checkProgram(`each${i}`, own, one);
      console.log(
        `${calls[i].method}: ${r.category}${
          r.detail ? ` -- ${String(r.detail).split("\n")[0]}` : ""
        }`,
      );
    }
    return;
  }
  const result = await checkProgram("repro", source, calls);
  console.log(JSON.stringify(result, null, 2));
  if (options.minimize && result.category !== "ok") {
    const reduced = await reduce({ seed: "repro", ...result, calls, source });
    const out = sourcePath.replace(/(\.min)?\.cs$/, ".min.cs");
    await Deno.writeTextFile(out, reduced.source);
    console.log(
      `minimized to ${
        reduced.source.split("\n").length
      } lines in ${reduced.tests} tests (${out}): ${reduced.confirm.category}`,
    );
  }
}

async function campaign() {
  const counts = {};
  // How the calls of agreeing programs ended on the CLR.
  let calls = 0;
  const exceptions = {};
  const signatures = new Map();
  const findings = [];
  let next = options.start;
  const end = options.start + options.seeds;
  let done = 0;
  const started = Date.now();
  let lastReport = started;
  const minimizing = [];

  async function worker() {
    while (next < end) {
      const seed = next++;
      let program;
      try {
        program = generate(seed, {
          features: options.featureList,
          size: options.size,
        });
      } catch (error) {
        counts.generator = (counts.generator ?? 0) + 1;
        console.error(`seed ${seed}: generator threw: ${error.stack}`);
        continue;
      }
      const result = await checkProgram(
        `s${seed}`,
        program.source,
        program.calls,
      );
      await Deno.remove(`${scratch}/s${seed}.cs`).catch(() => {});
      counts[result.category] = (counts[result.category] ?? 0) + 1;
      if (result.category === "ok") {
        calls += result.calls;
        for (const [name, n] of Object.entries(result.faults)) {
          exceptions[name] = (exceptions[name] ?? 0) + n;
        }
      }
      done++;
      if (result.category !== "ok" && result.category !== "budget") {
        const key = `${result.category}: ${result.signature}`;
        const seen = signatures.get(key) ?? { count: 0, seeds: [] };
        seen.count++;
        if (seen.seeds.length < 10) seen.seeds.push(seed);
        signatures.set(key, seen);
        const finding = {
          seed,
          features: options.featureList,
          ...result,
          calls: program.calls,
          source: program.source,
        };
        if (!NOT_FINDINGS.has(result.category)) findings.push(finding);
        if (seen.count === 1) {
          console.log(
            `seed ${seed}: ${key}\n  ${
              String(result.detail).split("\n")[0].slice(0, 300)
            }`,
          );
        }
        const minimizeThis = options.minimize &&
          !NOT_FINDINGS.has(result.category) &&
          seen.count <= options.minimizePerSignature;
        if (minimizeThis) {
          // Fuzzing goes on meanwhile.
          await save(finding, null);
          minimizing.push(
            reduce(finding).then(async (m) => {
              console.log(
                `seed ${seed}: minimized to ${
                  m.source.split("\n").length
                } lines (${m.tests} tests, ${m.seconds.toFixed(0)} s)`,
              );
              await save(finding, m);
            }),
          );
        } else if (seen.count <= 20 || result.category === "generator") {
          await save(finding, null);
        }
      }
      const now = Date.now();
      if (now - lastReport > 30_000) {
        lastReport = now;
        console.log(
          `[${((now - started) / 1000).toFixed(0)} s] ${done} programs, ${
            (done / ((now - started) / 1000)).toFixed(1)
          }/s: ${JSON.stringify(counts)}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: options.jobs }, worker));
  await Promise.all(minimizing);
  const seconds = (Date.now() - started) / 1000;
  const summary = {
    seeds: [options.start, end - 1],
    features: options.featureList,
    seconds,
    perSecond: done / seconds,
    counts,
    calls,
    exceptions: Object.fromEntries(
      Object.entries(exceptions).sort((a, b) => b[1] - a[1]),
    ),
    signatures: Object.fromEntries(
      [...signatures.entries()].sort((a, b) => b[1].count - a[1].count),
    ),
  };
  if (out) {
    await Deno.writeTextFile(
      `${out}/summary.json`,
      JSON.stringify(summary, null, 2) + "\n",
    );
  }
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

let status = 0;
try {
  if (options.emit !== undefined) {
    // Print one seed's program and calls.
    const program = generate(options.emit, {
      features: options.featureList,
      size: options.size,
    });
    console.log(program.source);
    console.log(
      `// calls: ${
        JSON.stringify(
          program.calls.map((c) => `${c.method}(${c.args.join(", ")})`),
        )
      }`,
    );
  } else if (options.repro) {
    await repro();
  } else {
    const summary = await campaign();
    if (options.test) {
      const bad = Object.entries(summary.counts).filter(([category]) =>
        category !== "ok" && category !== "budget"
      );
      const budget = summary.counts.budget ?? 0;
      if (bad.length) {
        console.error(`FAIL: ${bad.map(([c, n]) => `${n} ${c}`).join(", ")}`);
        status = 1;
      } else if (budget > options.seeds / 20) {
        console.error(
          `FAIL: ${budget} programs ran out of a budget; the generator's estimates are off`,
        );
        status = 1;
      } else {
        console.log(
          `PASS: ${
            summary.counts.ok ?? 0
          } programs agree with the CLR (${budget} stopped at a budget).`,
        );
      }
    }
  }
} finally {
  await oracle.close();
  wasm.close();
  await Deno.remove(scratch, { recursive: true }).catch(() => {});
}
Deno.exit(status);
