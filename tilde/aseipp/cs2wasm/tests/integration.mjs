// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// End-to-end acceptance tests require a published Native AOT compiler.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isolateCompiler } from "./compiler.mjs";
import { runSuite, suites } from "./suites.mjs";
import { rejectionCases } from "./rejections.mjs";
import { heapExamples } from "./heap-gameplay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [nativeCompiler, ...options] = process.argv.slice(2);
const supportedOptions = [
  "--wasm-tools",
  "--binaryen",
  "--spidermonkey",
  "--all-tools",
  "--differential",
];
if (
  !nativeCompiler ||
  options.some((option) => !supportedOptions.includes(option))
) {
  throw new Error(
    "Usage: node tests/integration.mjs ./publish/gameplayc " +
      "[--wasm-tools] [--binaryen] [--spidermonkey] [--differential] [--all-tools]",
  );
}

const enabled = (option) =>
  options.includes(option) || options.includes("--all-tools");
const withWasmTools = enabled("--wasm-tools");
const withBinaryen = enabled("--binaryen");
const withSpiderMonkey = enabled("--spidermonkey");
const withDifferential = enabled("--differential");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gameplayc-native-"));
let nativeChecks = 0;
let toolChecks = 0;

try {
  const { executable, environment: compilerEnvironment } = isolateCompiler(
    nativeCompiler,
    scratch,
  );

  function runCompiler(args) {
    const result = spawnSync(executable, args, {
      cwd: scratch,
      env: compilerEnvironment,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) {
      throw result.error;
    }
    return result;
  }

  // Independent tools use the test runner's environment, not the compiler's.
  function runTool(command, args) {
    const result = spawnSync(command, args, {
      cwd: scratch,
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) {
      throw result.error;
    }
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
    );
    return result.stdout.trim();
  }

  function readModule(file) {
    const bytes = fs.readFileSync(path.join(scratch, file));
    assert.equal(WebAssembly.validate(bytes), true, `${file}: Wasm validation`);
    const module = new WebAssembly.Module(bytes);
    assert.equal(
      WebAssembly.Module.exports(module).some(
        (entry) => entry.kind === "memory" || entry.kind === "table",
      ),
      false,
    );
    return module;
  }

  function validateRoundTrip(file) {
    const textFile = file + ".wat";
    const roundTripFile = file + ".roundtrip.wasm";
    runTool("wasm-tools", ["validate", file]);
    runTool("wasm-tools", ["print", file, "-o", textFile]);
    runTool("wasm-tools", ["parse", textFile, "-o", roundTripFile]);
    runTool("wasm-tools", ["validate", roundTripFile]);
    readModule(roundTripFile);
    toolChecks++;
  }

  function compile(source, output, compilerArgs = []) {
    const result = runCompiler([...compilerArgs, "-o", output, source]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    nativeChecks++;
    if (withWasmTools) {
      validateRoundTrip(output);
    }
    return readModule(output);
  }

  if (withWasmTools) {
    console.log(runTool("wasm-tools", ["--version"]));
    console.log(runTool("wasmtime", ["--version"]));
  }
  if (withBinaryen) {
    console.log(runTool("wasm-opt", ["--version"]));
  }
  if (withSpiderMonkey) {
    console.log(runTool("js140", ["--version"]));
  }

  const info = runCompiler(["--info"]);
  assert.equal(info.status, 0, info.stderr);
  assert.match(info.stdout, /native-aot=True/);
  nativeChecks++;

  for (const suite of suites) {
    const source = path.basename(suite.source);
    fs.copyFileSync(path.join(root, suite.source), path.join(scratch, source));
    const module = compile(source, `${suite.name}.wasm`, suite.compilerArgs);
    nativeChecks += runSuite(suite, module, assert);
  }

  compile("Cases.cs", "cases-again.wasm");
  assert.deepEqual(
    fs.readFileSync(path.join(scratch, "cases.wasm")),
    fs.readFileSync(path.join(scratch, "cases-again.wasm")),
    "Repeated compilation must produce identical Wasm",
  );
  nativeChecks++;

  for (const [name, source] of Object.entries(rejectionCases)) {
    fs.writeFileSync(path.join(scratch, "Bad.cs"), source);
    const output = `bad-${name}.wasm`;
    const result = runCompiler(["-o", output, "Bad.cs"]);
    assert.equal(
      result.status,
      1,
      `${name}: expected policy/Roslyn rejection, not a crash: ${result.stderr}`,
    );
    if (name === "versiondirective") {
      assert.match(result.stderr, /<unknown>/);
    }
    assert.equal(
      fs.existsSync(path.join(scratch, output)),
      false,
      `${name}: partial output`,
    );
    nativeChecks++;
  }

  if (withWasmTools) {
    const invocations = [
      ...heapExamples.map(([name, args, expected]) => [
        "heap-gameplay.wasm",
        "Demo.HeapGameplay." + name,
        args,
        expected,
      ]),
      ["constructors.wasm", "Tests.Constructors.NamedArgumentOrder", [], 212],
      ["constructors.wasm", "Tests.Constructors.InitializerAfterBody", [], 22],
      ["cases.wasm", "Tests.Cases.GcFields", [39], 42],
      ["cases.wasm", "Tests.Cases.ArrayRefs", [], 23],
      ["cases.wasm", "Tests.Cases.Jagged", [], 17],
      ["gameplay.wasm", "Demo.Gameplay.SumSquares", [5], 30],
      ["gameplay.wasm", "Demo.Gameplay.VectorLengthSquared", [2, 3, 6], 49],
      ["gameplay.wasm.roundtrip.wasm", "Demo.Gameplay.SumSquares", [5], 30],
      [
        "gameplay.wasm.roundtrip.wasm",
        "Demo.Gameplay.VectorLengthSquared",
        [2, 3, 6],
        49,
      ],
    ];
    for (const [file, name, args, expected] of invocations) {
      const result = runTool("wasmtime", [
        "run",
        "--invoke",
        name,
        file,
        ...args.map(String),
      ]);
      assert.equal(result, String(expected), name);
      toolChecks++;
    }
    console.log(
      `PASS: ${toolChecks} independent Wasm validation/round-trip and Wasmtime execution checks.`,
    );
  }

  if (withBinaryen) {
    // wasm-opt validates its input and output. Re-run all behavior checks after
    // optimization to catch invalid encodings or optimizer-sensitive semantics.
    let optimizedChecks = 0;
    for (const suite of suites) {
      const file = suite.name;
      runTool("wasm-opt", [
        `${file}.wasm`,
        "--enable-gc",
        "--enable-reference-types",
        "--enable-nontrapping-float-to-int",
        "--enable-sign-ext",
        "-O2",
        "-o",
        `${file}.optimized.wasm`,
      ]);
      if (withWasmTools) {
        runTool("wasm-tools", ["validate", `${file}.optimized.wasm`]);
      }
      optimizedChecks += runSuite(
        suite,
        readModule(`${file}.optimized.wasm`),
        assert,
      );
    }
    console.log(
      `PASS: ${optimizedChecks} behavior checks after Binaryen -O2 optimization.`,
    );
  }

  if (withSpiderMonkey) {
    const runner = path.join(root, "tests/spidermonkey.mjs");
    // The shell reserves its first positional argument for a script, even when
    // --module already names the runner. Supply an empty script so the Wasm
    // paths become scriptArgs. A real file also works with piped stdin.
    const argumentScript = "spidermonkey-arguments.js";
    fs.writeFileSync(path.join(scratch, argumentScript), "");
    console.log(
      runTool("js140", [
        "--module",
        runner,
        argumentScript,
        ...suites.map((suite) => `${suite.name}.wasm`),
      ]),
    );
    if (withBinaryen) {
      console.log(
        runTool("js140", [
          "--module",
          runner,
          argumentScript,
          ...suites.map((suite) => `${suite.name}.optimized.wasm`),
        ]),
      );
    }
  }

  console.log(
    `PASS: ${nativeChecks} native compiler/integration assertions, SDK-less isolated executable.`,
  );
  if (withDifferential) {
    // The independent CLR oracle comes prebuilt through GAMEPLAYC_REFERENCE;
    // under Deno the child needs its permissions spelled out again.
    const runtimeArguments = process.versions.deno
      ? ["run", "--allow-all"]
      : [];
    const result = spawnSync(
      process.execPath,
      [
        ...runtimeArguments,
        path.join(root, "tests/differential.mjs"),
        path.resolve(nativeCompiler),
      ],
      { cwd: root, encoding: "utf8", timeout: 180_000 },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
    console.log(result.stdout.trim());
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
