// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// One differential check: compile a program with gameplayc and with Roslyn
// for the CLR oracle, run the same calls on both, and classify the outcome.

// The budgets a generated program is compiled with: the compiler's maxima,
// so that traps come from the program's own exceptions (the generator keeps
// its programs well under them; see gen.mjs).
export const COMPILER_FLAGS = [
  "--recover-after-trap",
  "--fuel",
  "1000000",
  "--depth",
  "128",
  "--alloc-units",
  "16777216",
  "--max-array",
  "1048576",
];

// Outcomes that are not compiler findings.
export const NOT_FINDINGS = new Set([
  "ok",
  "budget", // a budget ran out where the CLR has none
  "generator", // Roslyn rejects the program: a generator bug
  "oracle", // the oracle timed out or died
  "clr-jit", // the CLR's optimized and unoptimized code disagree
]);

const BUDGET_FAULTS = new Set([1, 2, 3]);

// The fault code of a CLR exception, by the first class in its chain that has
// one (tests/differential.mjs, expectedFault); OverflowException stands for
// three checks.
const FAULT_CODES = {
  NullReferenceException: [5],
  IndexOutOfRangeException: [6],
  DivideByZeroException: [7],
  OverflowException: [4, 8, 9],
  ArgumentOutOfRangeException: [16],
  ArgumentNullException: [10],
  ArgumentException: [10],
  SwitchExpressionException: [11],
  InvalidCastException: [13],
  InvalidOperationException: [14],
  KeyNotFoundException: [15],
};

export function expectedFaults(outcome) {
  for (const name of outcome.Chain ?? [outcome.Exception]) {
    if (name in FAULT_CODES) return FAULT_CODES[name];
  }
  return [17];
}

// ---------------------------------------------------------------------------
// The oracle: a pool of long-running processes, one request at a time each.

async function* lines(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
    }
  }
}

const STARTUP_MS = 120_000;

// A child process answering one JSON line with one JSON line.
class LineProcess {
  constructor(path, env, args = []) {
    this.path = path;
    this.env = env;
    this.args = args;
    this.start();
  }
  start() {
    this.used = 0;
    this.child = new Deno.Command(this.path, {
      args: this.args,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
      env: this.env,
    }).spawn();
    this.writer = this.child.stdin.getWriter();
    this.reader = lines(this.child.stdout);
  }
  kill() {
    try {
      this.child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    this.child.status.catch(() => {});
  }
  async request(request, timeoutMs) {
    // A process's first answer also pays for starting it (the oracle
    // JIT-compiles Roslyn without tiering), which a loaded machine stretches
    // past a program's own limit: every process of a pool starts at once.
    const limit = this.used === 0 ? timeoutMs + STARTUP_MS : timeoutMs;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), limit);
    });
    try {
      this.used++;
      await this.writer.write(
        new TextEncoder().encode(JSON.stringify(request) + "\n"),
      );
      const next = await Promise.race([this.reader.next(), timeout]);
      if (next.timeout || next.done) {
        this.kill();
        this.start();
        return { failed: next.timeout ? "timeout" : "exited" };
      }
      return JSON.parse(next.value);
    } catch (error) {
      this.kill();
      this.start();
      return { failed: String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class OraclePool {
  constructor(path, env, size, fallback = null) {
    this.idle = [];
    this.waiting = [];
    this.all = [];
    this.id = 0;
    for (let i = 0; i < size; i++) {
      const p = new LineProcess(path, env);
      this.idle.push(p);
      this.all.push(p);
    }
    this.fallbackOptions = fallback;
    this.fallback = null;
  }
  async run(source, calls, timeoutMs = 60_000) {
    const result = await this.ask(source, calls, timeoutMs);
    if (result.failed === "exited" && this.fallbackOptions) {
      this.fallback ??= new OraclePool(
        this.fallbackOptions.path,
        this.fallbackOptions.env,
        1,
      );
      return await this.fallback.run(source, calls, timeoutMs);
    }
    return result;
  }
  // The same request, of the fallback oracle.
  second(source, calls, timeoutMs = 60_000) {
    if (!this.fallbackOptions) {
      return Promise.resolve({ failed: "no fallback" });
    }
    this.fallback ??= new OraclePool(
      this.fallbackOptions.path,
      this.fallbackOptions.env,
      1,
    );
    return this.fallback.run(source, calls, timeoutMs);
  }
  async ask(source, calls, timeoutMs) {
    const process = this.idle.pop() ??
      await new Promise((resolve) => this.waiting.push(resolve));
    try {
      return await process.request({
        id: ++this.id,
        source,
        calls: calls.map((c) => ({ method: c.method, args: c.args })),
      }, timeoutMs);
    } finally {
      const next = this.waiting.shift();
      if (next) next(process);
      else this.idle.push(process);
    }
  }
  async close() {
    await this.fallback?.close();
    for (const p of this.all) {
      try {
        await p.writer.close();
      } catch {
        // Already closed.
      }
      p.kill();
    }
  }
}

// ---------------------------------------------------------------------------
// The compiler

export async function compile(
  gameplayc,
  env,
  sourcePath,
  wasmPath,
  poison = false,
  timeoutMs = 120_000,
  flags = [],
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await new Deno.Command(gameplayc, {
      args: [
        ...flags,
        ...COMPILER_FLAGS.filter((f) =>
          !poison || f !== "--recover-after-trap"
        ),
        "-o",
        wasmPath,
        sourcePath,
      ],
      stdout: "piped",
      stderr: "piped",
      env,
      signal: controller.signal,
    }).output();
    return {
      code: result.code,
      signal: result.signal,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } catch (error) {
    return {
      code: -1,
      signal: controller.signal.aborted ? "timeout" : String(error),
      stdout: "",
      stderr: "",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Running the module

const I64 = new Set(["long", "ulong"]);
const FLOATING = new Set(["float", "double"]);

function wasmArgument(type, text) {
  if (I64.has(type)) return BigInt.asIntN(64, BigInt(text));
  if (FLOATING.has(type)) return Number(text);
  if (type === "uint") return Number(text) | 0;
  return Number(text);
}

// Encoded as tests/reference/Program.cs encodes CLR results.
function encode(type, value) {
  if (type === "void") return "void";
  if (I64.has(type)) return `i64:${BigInt.asIntN(64, value)}`;
  if (FLOATING.has(type)) {
    if (Number.isNaN(value)) return "f64:NaN";
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    return "f64:" + view.getBigUint64(0).toString(16).padStart(16, "0");
  }
  return `i32:${value}`;
}

export function runWasm(bytes, calls) {
  if (!WebAssembly.validate(bytes)) {
    let message = "";
    try {
      new WebAssembly.Module(bytes);
    } catch (error) {
      message = String(error);
    }
    return { error: "invalid", message };
  }
  let instance;
  try {
    instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  } catch (error) {
    return {
      error: error instanceof WebAssembly.RuntimeError ? "start-trap" : "link",
      message: String(error),
    };
  }
  const results = [];
  for (const call of calls) {
    const fn = instance.exports[call.method];
    if (typeof fn !== "function") {
      results.push({ kind: "missing" });
      continue;
    }
    try {
      const value = fn(
        ...call.args.map((a, i) => wasmArgument(call.params[i], a)),
      );
      results.push({
        kind: "value",
        value: encode(call.ret, value),
        fault: instance.exports.__fault?.value ?? 0,
      });
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        results.push({
          kind: "trap",
          fault: instance.exports.__fault?.value ?? 0,
          message: error.message,
        });
      } else {
        results.push({ kind: "engine", message: String(error) });
      }
    }
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Classification

export function normalizeMessage(text) {
  return text
    .split("\n")[0]
    .replace(/'[^']*'/g, "'#'")
    .replace(/"[^"]*"/g, '"#"')
    .replace(/^.*?\(\d+,\d+\): /, "")
    .replace(
      /\b(v|p|a|i|e|x|cp|ub|uc|oc|oi|tv|rv|qx|kx|sx|kv|d|f|fs|c|lf)\d+\b/g,
      "$1#",
    )
    .replace(/\b([A-Z][A-Za-z]*?)\d+\b/g, "$1#")
    .replace(/\d+/g, "#")
    .slice(0, 200);
}

function internalSignature(stderr) {
  const lines = stderr.split("\n");
  const head = normalizeMessage(lines[0] ?? "");
  const frames = lines.filter((l) => l.trim().startsWith("at ")).slice(0, 2)
    .map((l) => l.trim().replace(/ in .*$/, ""));
  return `${head} | ${frames.join(" < ")}`.slice(0, 300);
}

// The outcome of one program: {category, signature, detail, index}.
// Processes that run modules (runner.mjs), each replaced after `lifetime`
// modules: V8 never frees the GC types it canonicalizes.
export class WasmPool {
  constructor(size, lifetime = 300) {
    this.lifetime = lifetime;
    this.idle = [];
    this.waiting = [];
    this.all = [];
    this.id = 0;
    const runner = new URL("./runner.mjs", import.meta.url).pathname;
    for (let i = 0; i < size; i++) {
      const p = new LineProcess(Deno.execPath(), {}, [
        "run",
        "--quiet",
        "--no-config",
        "--no-lock",
        runner,
      ]);
      this.idle.push(p);
      this.all.push(p);
    }
  }
  async run(bytes, calls, timeoutMs = 60_000) {
    const process = this.idle.pop() ??
      await new Promise((resolve) => this.waiting.push(resolve));
    try {
      if (process.used >= this.lifetime) {
        await process.writer.close().catch(() => {});
        process.kill();
        process.start();
      }
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const answer = await process.request({
        id: ++this.id,
        bytes: btoa(binary),
        calls,
      }, timeoutMs);
      if (answer.failed) {
        return {
          error: answer.failed === "timeout" ? "wasm-timeout" : "engine-error",
          message: `the Wasm runner: ${answer.failed}`,
        };
      }
      return answer.result;
    } finally {
      const next = this.waiting.shift();
      if (next) next(process);
      else this.idle.push(process);
    }
  }
  close() {
    for (const p of this.all) {
      p.writer.close().catch(() => {});
      p.kill();
    }
  }
}

// The first call on which the CLR and Wasm disagree, or null.
function compare(reference, run, calls) {
  for (let i = 0; i < calls.length; i++) {
    const clr = reference.results[i];
    const wasm = run.results[i];
    const where = `${calls[i].method}(${calls[i].args.join(", ")})`;
    if (wasm.kind === "missing") {
      return {
        category: "missing-export",
        signature: calls[i].method.replace(/\d+$/, "#"),
        detail: where,
        index: i,
      };
    }
    if (wasm.kind === "engine") {
      return {
        category: "engine-error",
        signature: normalizeMessage(wasm.message),
        detail: `${where}: ${wasm.message}`,
        index: i,
      };
    }
    if (clr.Kind === "value") {
      if (wasm.kind === "trap") {
        if (BUDGET_FAULTS.has(wasm.fault) || wasm.fault === 4) {
          // Fault 4 where the CLR allocated: the maximum array length.
          return {
            category: "budget",
            signature: `fault ${wasm.fault}`,
            detail: where,
            index: i,
          };
        }
        return {
          category: "spurious-fault",
          signature: `fault ${wasm.fault}`,
          detail:
            `${where}: CLR returned ${clr.Value}; Wasm trapped with fault ${wasm.fault} (${wasm.message})`,
          index: i,
        };
      }
      if (wasm.value !== clr.Value) {
        const trace = calls[i].method.endsWith(".Trace");
        return {
          category: trace ? "wrong-trace" : "wrong-value",
          signature: trace ? "trace" : `value ${calls[i].ret}`,
          detail: `${where}: CLR ${clr.Value}, Wasm ${wasm.value}`,
          index: i,
        };
      }
      if (wasm.fault !== 0) {
        return {
          category: "stale-fault",
          signature: `fault ${wasm.fault}`,
          detail: `${where}: __fault ${wasm.fault} after success`,
          index: i,
        };
      }
    } else {
      const expected = expectedFaults(clr);
      if (wasm.kind !== "trap") {
        return {
          category: "missing-fault",
          signature: clr.Exception,
          detail:
            `${where}: CLR threw ${clr.Exception}; Wasm returned ${wasm.value}`,
          index: i,
        };
      }
      if (!expected.includes(wasm.fault)) {
        if (
          BUDGET_FAULTS.has(wasm.fault) ||
          (wasm.fault === 4 && clr.Exception !== "OverflowException")
        ) {
          return {
            category: "budget",
            signature: `fault ${wasm.fault}`,
            detail: where,
            index: i,
          };
        }
        return {
          category: "wrong-fault",
          signature: `${clr.Exception} -> ${wasm.fault}`,
          detail: `${where}: CLR threw ${clr.Exception} (${
            (clr.Chain ?? []).join(" < ")
          }), expected fault ${
            expected.join("/")
          }; Wasm fault ${wasm.fault} (${wasm.message})`,
          index: i,
        };
      }
    }
  }
  return null;
}

const MISMATCHES = new Set([
  "wrong-value",
  "wrong-trace",
  "stale-fault",
  "missing-fault",
  "spurious-fault",
  "wrong-fault",
]);

// With `poison`, the module is compiled without --recover-after-trap: once
// an entry traps, every later entry must fault with 18 (README.md, Static
// state), whatever the CLR does next.
export async function check(
  {
    gameplayc,
    env,
    oracle,
    wasm,
    dir,
    name,
    source,
    calls,
    poison = false,
    flags = [],
  },
) {
  const sourcePath = `${dir}/${name}.cs`;
  const wasmPath = `${dir}/${name}.wasm`;
  await Deno.writeTextFile(sourcePath, source);
  const [compiled, reference] = await Promise.all([
    compile(gameplayc, env, sourcePath, wasmPath, poison, undefined, flags),
    oracle.run(source, calls),
  ]);
  try {
    if (reference.failed) {
      return {
        category: "oracle",
        signature: reference.failed,
        detail: reference.failed,
      };
    }
    if (!reference.compiled) {
      return {
        category: "generator",
        signature: normalizeMessage(reference.diagnostics[0] ?? ""),
        detail: reference.diagnostics.join("\n"),
      };
    }
    if (reference.results.some((r) => r.Kind === "missing")) {
      return {
        category: "generator",
        signature: "missing entry",
        detail: "An entry the calls name is missing.",
      };
    }
    if (compiled.code === 1) {
      return {
        category: "reject",
        signature: normalizeMessage(compiled.stderr),
        detail: compiled.stderr,
      };
    }
    if (compiled.code === 3) {
      return {
        category: "ice",
        signature: internalSignature(compiled.stderr),
        detail: compiled.stderr,
      };
    }
    if (compiled.code !== 0) {
      return {
        category: "crash",
        signature: `exit ${compiled.code} ${compiled.signal ?? ""}`,
        detail: compiled.stderr,
      };
    }
    const bytes = await Deno.readFile(wasmPath);
    const run = wasm ? await wasm.run(bytes, calls) : runWasm(bytes, calls);
    if (run.error === "invalid") {
      return {
        category: "invalid",
        signature: normalizeMessage(run.message.replace(/@\+\d+/g, "")),
        detail: run.message,
      };
    }
    if (run.error) {
      return {
        category: run.error,
        signature: normalizeMessage(run.message),
        detail: run.message,
      };
    }
    let mismatch = null;
    if (poison) {
      const first = run.results.findIndex((r) => r.kind === "trap");
      if (first >= 0) {
        const after = run.results.findIndex((r, i) =>
          i > first && !(r.kind === "trap" && r.fault === 18)
        );
        if (after >= 0) {
          const r = run.results[after];
          return {
            category: "poison",
            signature: r.kind === "trap" ? `fault ${r.fault}` : r.kind,
            detail: `${calls[after].method} after a trap in ${
              calls[first].method
            }: ${r.kind} ${r.fault ?? ""} ${r.value ?? ""}`,
            index: after,
          };
        }
        // Up to the first trap, the CLR must agree.
        mismatch = compare({ results: reference.results.slice(0, first + 1) }, {
          results: run.results.slice(0, first + 1),
        }, calls.slice(0, first + 1));
      } else {
        mismatch = compare(reference, run, calls);
      }
    } else {
      mismatch = compare(reference, run, calls);
    }
    if (mismatch) {
      if (MISMATCHES.has(mismatch.category) && oracle.second) {
        // The CLR's JIT has bugs of its own (README.md): when its
        // unoptimized code answers differently, this is one of them.
        const second = await oracle.second(source, calls);
        if (
          second.compiled &&
          JSON.stringify(second.results) !== JSON.stringify(reference.results)
        ) {
          return {
            ...mismatch,
            category: "clr-jit",
            detail: `${mismatch.detail} (the CLR's JIT modes disagree)`,
          };
        }
      }
      // Both sides call by call, for the reproducer.
      return { ...mismatch, clr: reference.results, wasm: run.results };
    }
    const faults = {};
    for (const r of reference.results) {
      if (r.Kind === "exception") {
        faults[r.Exception] = (faults[r.Exception] ?? 0) + 1;
      }
    }
    return { category: "ok", calls: calls.length, faults };
  } finally {
    await Deno.remove(wasmPath).catch(() => {});
  }
}
