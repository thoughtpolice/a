// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The behavior suites, rejection cases and corpus programs, run against
// whatever compiler command the arguments name, such as the JIT layout's
// `dotnet exec gameplayc.dll`. Each suite, case and program is a case of its own,
// and the run reports every one that fails (tests/failures.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runSuite, suites } from "./suites.mjs";
import { acceptedCases, rejectionCases } from "./rejections.mjs";
import { reportFailures } from "./failures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiler = process.argv.slice(2);
if (compiler.length === 0) {
  throw new Error("Usage: behavior.mjs <compiler command...>");
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gameplayc-behavior-"));
let checks = 0;

function runCompiler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(compiler[0], [...compiler.slice(1), ...args], {
      timeout: 120_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// Runs `worker` over `items` with at most one compiler per CPU at a time; the
// results come back in the items' order, so checking them stays deterministic.
async function parallel(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function drain() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }
  const workers = Math.min(os.availableParallelism(), items.length);
  await Promise.all(Array.from({ length: workers }, drain));
  return results;
}

async function run() {
  const failures = new Map();
  const passed = new Set();

  // The compiler describes itself, and compiles the same module twice.
  const info = await runCompiler(["--info"]);
  if (info.status === 0 && /^gameplayc /.test(info.stdout)) {
    passed.add("info");
  } else {
    failures.set("info", `exit ${info.status}: ${info.stdout}${info.stderr}`);
  }
  const casesSuite = suites.find((suite) => suite.name === "cases");
  const twice = await parallel(
    ["cases-once.wasm", "cases-twice.wasm"],
    (output) =>
      runCompiler([
        ...casesSuite.compilerArgs,
        "-o",
        path.join(scratch, output),
        path.join(root, casesSuite.source),
      ]),
  );
  if (
    twice.every((result) => result.status === 0) &&
    fs.readFileSync(path.join(scratch, "cases-once.wasm")).equals(
      fs.readFileSync(path.join(scratch, "cases-twice.wasm")),
    )
  ) {
    passed.add("deterministic");
  } else {
    failures.set(
      "deterministic",
      "Repeated compilation must produce identical Wasm",
    );
  }
  const results = await parallel(suites, (suite) =>
    runCompiler([
      ...(suite.compilerArgs ?? []),
      "-o",
      path.join(scratch, `${suite.name}.wasm`),
      path.join(root, suite.source),
    ]));
  suites.forEach((suite, index) => {
    const key = `suite:${suite.name}`;
    const result = results[index];
    if (result.status !== 0) {
      const text = (result.stdout + result.stderr).trim().split("\n");
      failures.set(
        key,
        `exit ${result.status}: ${
          text.find((line) => /GP\d|rror/.test(line)) ?? text[0]
        }`,
      );
      return;
    }

    try {
      const bytes = fs.readFileSync(path.join(scratch, `${suite.name}.wasm`));
      assert.ok(
        !suite.maxBytes || bytes.length <= suite.maxBytes,
        `${bytes.length} bytes, over the budget of ${suite.maxBytes}`,
      );
      checks += runSuite(suite, new WebAssembly.Module(bytes), assert);
      passed.add(key);
    } catch (error) {
      failures.set(key, String(error.message).split("\n")[0]);
    }
  });

  // The rejection cases, rejected without partial output, and the
  // programs once rejected that compile (acceptedCases), into valid modules.
  const rejections = [
    ...Object.entries(rejectionCases),
    ...Object.entries(acceptedCases).map((
      [name, { source }],
    ) => [name, source]),
  ];
  const rejected = await parallel(rejections, ([name, source]) => {
    const input = path.join(scratch, `bad-${name}.cs`);
    fs.writeFileSync(input, source);
    return runCompiler([
      "-o",
      path.join(scratch, `bad-${name}.wasm`),
      input,
    ]);
  });
  rejections.forEach(([name], index) => {
    const key = `rejection:${name}`;
    const result = rejected[index];
    const text = (result.stdout + result.stderr).trim();
    const output = path.join(scratch, `bad-${name}.wasm`);
    if (Object.hasOwn(acceptedCases, name)) {
      if (result.status !== 0) {
        failures.set(
          key,
          `exit ${result.status}, expected a module: ${text.split("\n")[0]}`,
        );
      } else if (!WebAssembly.validate(fs.readFileSync(output))) {
        failures.set(key, "invalid Wasm");
      } else {
        passed.add(key);
      }
    } else if (result.status !== 1 || /Internal compiler error/.test(text)) {
      failures.set(
        key,
        `exit ${result.status}, expected a rejection: ${text.split("\n")[0]}`,
      );
    } else if (fs.existsSync(output)) {
      failures.set(key, "partial output");
    } else {
      passed.add(key);
    }
  });
  // API control (corelib/allowlist.txt): a member the rules refuse is an
  // error at the line that calls it, whatever the CoreLib has.
  const refusedCalls = {
    timer: "System.Threading.Timer::.ctor",
    app_context: "System.AppContext::TryGetSwitch",
    gc_array: "System.GC::AllocateUninitializedArray",
    unsafe_null: "System.Runtime.CompilerServices.Unsafe::NullRef",
  };
  const refusedSources = {
    timer: "var t = new System.Threading.Timer(null);",
    app_context: 'System.AppContext.TryGetSwitch("x", out bool on);',
    gc_array: "var a = System.GC.AllocateUninitializedArray<int>(4);",
    unsafe_null:
      "ref int r = ref System.Runtime.CompilerServices.Unsafe.NullRef<int>();",
  };
  const refused = await parallel(Object.keys(refusedCalls), (name) => {
    const input = path.join(scratch, `refused-${name}.cs`);
    fs.writeFileSync(
      input,
      `public static class Refused\n{\n    public static int F()\n    {\n        ${
        refusedSources[name]
      }\n        return 1;\n    }\n}\n`,
    );
    return runCompiler([
      "-o",
      path.join(scratch, `refused-${name}.wasm`),
      input,
    ]);
  });
  Object.keys(refusedCalls).forEach((name, index) => {
    const key = `refused:${name}`;
    const result = refused[index];
    const text = (result.stdout + result.stderr).trim();
    if (
      result.status === 1 &&
      text.includes(`refused-${name}.cs(5,`) &&
      text.includes(`'${refusedCalls[name]}' is not in the gameplay API`)
    ) {
      passed.add(key);
    } else {
      failures.set(key, `exit ${result.status}: ${text.split("\n")[0]}`);
    }
  });

  // A call nothing implements says what it calls and why nothing runs it:
  // .NET's declaration the CoreLib does not implement, reached directly or
  // as a type argument's implementation of a generic-math member.
  const unsupportedCalls = {
    surface: [
      "return (int)System.Math.Asinh(x);",
      "'System.Math.Asinh(double)' is unsupported: .NET declares it, but the gameplay CoreLib does not implement it.",
    ],
    constrained: [
      'return Parse<int>("7") + x;',
      "'int.Parse(string, System.IFormatProvider?)' is unsupported: .NET declares it, but the gameplay CoreLib does not implement it.",
    ],
  };
  const unsupported = await parallel(Object.keys(unsupportedCalls), (name) => {
    const input = path.join(scratch, `unsupported-${name}.cs`);
    fs.writeFileSync(
      input,
      `public static class Unsupported\n{\n    public static int F(int x)\n    {\n        ${
        unsupportedCalls[name][0]
      }\n    }\n\n    private static T Parse<T>(string s) where T : System.IParsable<T> => T.Parse(s, null);\n}\n`,
    );
    return runCompiler([
      "-o",
      path.join(scratch, `unsupported-${name}.wasm`),
      input,
    ]);
  });
  Object.keys(unsupportedCalls).forEach((name, index) => {
    const key = `unsupported:${name}`;
    const result = unsupported[index];
    const text = (result.stdout + result.stderr).trim();
    if (
      result.status === 1 && text.includes(`unsupported-${name}.cs(`) &&
      text.includes(unsupportedCalls[name][1])
    ) {
      passed.add(key);
    } else {
      failures.set(key, `exit ${result.status}: ${text.split("\n")[0]}`);
    }
  });

  // Libraries (gameplayc --library, --reference): checked where they are
  // compiled, their code the module's but not their exports.
  {
    const write = (name, text) => {
      const file = path.join(scratch, name);
      fs.writeFileSync(file, text);
      return file;
    };
    const library = path.join(scratch, "library");
    const helper = write(
      "library-helper.cs",
      "namespace Helpers;\n\npublic static class Helper\n{\n    public static int Twice(int x) => x * 2;\n\n    internal static int Hidden(int x) => x;\n}\n",
    );
    const built = await runCompiler([
      "--library",
      "Helpers",
      "-o",
      path.join(library, "Helpers.dll"),
      helper,
    ]);
    const libraryChecks = {
      // Its calls are checked against the gameplay API where it compiles.
      refused: [
        [
          "--library",
          "Refused",
          "-o",
          path.join(scratch, "refused-library", "Refused.dll"),
          write(
            "library-refused.cs",
            'namespace Refused;\n\npublic static class Leak\n{\n    public static string Home() => System.Environment.GetEnvironmentVariable("HOME");\n}\n',
          ),
        ],
        1,
        [
          "library-refused.cs(5,",
          "'System.Environment::GetEnvironmentVariable' is not in the gameplay API",
        ],
      ],
      // Its public static methods are the module's code, not its exports.
      exports: [
        [
          "--reference",
          library,
          "-o",
          path.join(scratch, "library-module.wasm"),
          write(
            "library-module.cs",
            "public static class UsesHelper\n{\n    public static int F(int x) => Helpers.Helper.Twice(x) + 1;\n}\n",
          ),
        ],
        0,
        ["export UsesHelper.F"],
        ["export Helpers."],
      ],
      // Its internals are its own (a library can make them visible to
      // modules, which are assemblies named Gameplay).
      internal: [
        [
          "--reference",
          library,
          "-o",
          path.join(scratch, "library-internal.wasm"),
          write(
            "library-internal.cs",
            "public static class UsesHidden\n{\n    public static int F(int x) => Helpers.Helper.Hidden(x);\n}\n",
          ),
        ],
        1,
        ["library-internal.cs(3,", "'Hidden'"],
      ],
      // A module is not a library.
      "not-a-library": [
        [
          "--reference",
          path.join(scratch, "library-module.wasm"),
          "-o",
          path.join(scratch, "library-wasm.wasm"),
          path.join(scratch, "library-module.cs"),
        ],
        1,
        ["is not an assembly"],
      ],
      // Nor is a library named as the module or the framework.
      name: [
        [
          "--library",
          "System.Helpers",
          "-o",
          path.join(scratch, "library-name", "System.Helpers.dll"),
          helper,
        ],
        1,
        ["'System.Helpers' is not a library name"],
      ],
    };
    const names = Object.keys(libraryChecks);
    const results = [];
    for (const name of names) {
      // In order: the module the not-a-library case references is the
      // exports case's.
      results.push(
        built.status === 0 ? await runCompiler(libraryChecks[name][0]) : built,
      );
    }
    names.forEach((name, index) => {
      const key = `library:${name}`;
      const result = results[index];
      const [, status, present, absent = []] = libraryChecks[name];
      const text = (result.stdout + result.stderr).trim();
      if (
        result.status === status &&
        present.every((part) => text.includes(part)) &&
        absent.every((part) => !text.includes(part))
      ) {
        passed.add(key);
      } else {
        failures.set(key, `exit ${result.status}: ${text.split("\n")[0]}`);
      }
    });
  }

  const corpusDirectory = path.join(root, "tests/corpus");
  const corpus = fs.readdirSync(corpusDirectory).filter((name) =>
    name.endsWith(".cs")
  ).sort();
  const compiled = await parallel(corpus, (name) =>
    runCompiler([
      "-o",
      path.join(scratch, `corpus-${name}.wasm`),
      path.join(corpusDirectory, name),
    ]));
  corpus.forEach((name, index) => {
    const key = `corpus:${name}`;
    const result = compiled[index];
    const text = result.stdout + result.stderr;
    if (result.status === 0) {
      const bytes = fs.readFileSync(path.join(scratch, `corpus-${name}.wasm`));
      if (!WebAssembly.validate(bytes)) {
        failures.set(key, "invalid Wasm");
        return;
      }
    } else if (result.status !== 1 || /Internal compiler error/.test(text)) {
      failures.set(key, `exit ${result.status}: ${text.split("\n")[0]}`);
      return;
    } else if (!/error|GP\d{4}|unsupported|required/i.test(text)) {
      failures.set(
        key,
        `rejected without a diagnostic: ${text.split("\n")[0]}`,
      );
      return;
    }

    passed.add(key);
  });

  if (!reportFailures(failures, passed)) {
    throw new Error("Behavior checks failed.");
  }
  console.log(
    `PASS: ${checks} behavior checks across ${suites.length} suites, ` +
      `${rejections.length} rejection and accepted cases, ${
        Object.keys(refusedCalls).length
      } refused calls, ${
        Object.keys(unsupportedCalls).length
      } unsupported calls and ${corpus.length} corpus programs.`,
  );
}

try {
  await run();
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
