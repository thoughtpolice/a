// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// The behavior suites and rejection cases, run against whatever compiler
// command the arguments name: a Native AOT executable, or the JIT layout's
// `dotnet exec gameplayc.dll`. Unlike integration.mjs, nothing is copied or
// isolated; this is the check every build configuration can run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runSuite, suites } from "./suites.mjs";
import { rejectionCases } from "./rejections.mjs";

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

// Compiles and reads back each [source, output, compilerArgs] job; checked in
// order once every job has finished.
async function compileAll(jobs) {
  const results = await parallel(
    jobs,
    ([source, output, compilerArgs = []]) =>
      runCompiler([...compilerArgs, "-o", path.join(scratch, output), source]),
  );
  return jobs.map(([source, output], index) => {
    const result = results[index];
    assert.equal(
      result.status,
      0,
      `${source}\n${result.stdout}\n${result.stderr}`,
    );
    const bytes = fs.readFileSync(path.join(scratch, output));
    assert.equal(
      WebAssembly.validate(bytes),
      true,
      `${output}: Wasm validation`,
    );
    checks++;
    return bytes;
  });
}

try {
  const info = await runCompiler(["--info"]);
  assert.equal(info.status, 0, info.stderr);
  assert.match(info.stdout, /^gameplayc /);
  checks++;

  const cases = path.join(root, "tests/Cases.cs");
  const modules = await compileAll([
    ...suites.map((suite) => [
      path.join(root, suite.source),
      `${suite.name}.wasm`,
      suite.compilerArgs,
    ]),
    [cases, "cases-again.wasm"],
  ]);
  suites.forEach((suite, index) => {
    checks += runSuite(suite, new WebAssembly.Module(modules[index]), assert);
  });

  assert.deepEqual(
    modules[suites.length],
    fs.readFileSync(path.join(scratch, "cases.wasm")),
    "Repeated compilation must produce identical Wasm",
  );

  const rejections = Object.entries(rejectionCases);
  const results = await parallel(rejections, ([name, source]) => {
    const input = path.join(scratch, `bad-${name}.cs`);
    fs.writeFileSync(input, source);
    return runCompiler(["-o", path.join(scratch, `bad-${name}.wasm`), input]);
  });
  rejections.forEach(([name], index) => {
    const result = results[index];
    assert.equal(
      result.status,
      1,
      `${name}: expected a policy or Roslyn rejection, not a crash: ${result.stderr}`,
    );
    assert.equal(
      fs.existsSync(path.join(scratch, `bad-${name}.wasm`)),
      false,
      `${name}: partial output`,
    );
    checks++;
  });

  console.log(
    `PASS: ${checks} behavior checks across ${suites.length} suites and ` +
      `${rejections.length} rejection cases.`,
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
