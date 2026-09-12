// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Runs Kiln's checks (engine/tests/*.cs) in the module gameplayc compiled
// and compares each result with the CLR's for the same sources compiled
// by csc (with the same generator), then checks the results that have a
// value of their own. The `wide` suite is tests/Wide.cs's, a program of
// 133 components. Usage:
//
//   engine.mjs [--suite engine|wide] <tests.wasm> <scratch-directory> <clr-program command...>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

let argv = process.argv.slice(2);
let suite = "engine";
if (argv[0] === "--suite") {
  suite = argv[1];
  argv = argv.slice(2);
}
const [modulePath, scratch, ...clrProgram] = argv;
if (!modulePath || !scratch || clrProgram.length === 0) {
  throw new Error(
    "Usage: engine.mjs [--suite engine|wide] <tests.wasm> <scratch> <clr-program...>",
  );
}

// Each case: a Checks method and its arguments, and what it must return
// where that is known independently of either engine.
const engine = [
  ["Checks.ScheduleHash", []],
  ["Checks.SystemCount", [], 15],
  ["Checks.PluginOrder", [], 1],
  ["Checks.RenderOrder", [], 1],
  ["Checks.RunIf", [], 1],
  ["Checks.Movement", [0]],
  ["Checks.Movement", [1]],
  ["Checks.Movement", [10]],
  ["Checks.Movement", [60]],
  ["Checks.Events", [1], 3330],
  ["Checks.Events", [3], 3330],
  ["Checks.Events", [7], 3330],
  ["Checks.EventTrace", [3]],
  ["Checks.Deferred", [10]],
  ["Checks.Deferred", [17]],
  ["Checks.Generations", [], 11],
  ["Checks.Describe", []],
  ["Checks.Scripts", [5]],
  ["Checks.Scripts", [20]],
  ["Checks.ScriptLines", [20], 24],
  ["Checks.Plugin", [0]],
  ["Checks.Plugin", [7]],
  ["Checks.Plugin", [20]],
  ["Checks.PluginLaps", [12], 9],
  ["Checks.Worlds", [0]],
  ["Checks.Worlds", [10]],
  ["Checks.Resources", [], 11111],
  ["Checks.WorldSparks", [0], 10],
  ["Checks.WorldSparks", [4]],
  ["Checks.WorldSparks", [8], 0],
  ["Services.Random", [1]],
  ["Services.Random", [12345]],
  ["Services.Easing", []],
  ["Services.Tweens", [40]],
  ["Services.Collisions", [3]],
  ["Services.Collisions", [99]],
  ["Services.Drawing", []],
  ["Services.Sparks", [0]],
  ["Services.Sparks", [12]],
  ["Services.Audio", [4]],
  ["Services.Audio", [7]],
  ["Services.Song", [1]],
  ["Services.Song", [9]],
  ["Services.Saved", []],
];

const wide = [
  ["Wide.Shape", [], 111],
  ["Wide.ScheduleHash", []],
  ["Wide.Describe", [], 1],
  ["Wide.Queries", [], 11],
  ["Wide.Model", [1, 24], 0],
  ["Wide.Model", [2, 24], 0],
  ["Wide.Model", [3, 24], 0],
  ["Wide.Model", [4, 24], 0],
  ["Wide.ModelHash", [1, 24]],
  ["Wide.ModelHash", [2, 24]],
  ["Wide.ModelHash", [3, 24]],
  ["Wide.ModelHash", [4, 24]],
];

const cases = { engine, wide }[suite];
if (!cases) {
  throw new Error(`no suite ${suite}`);
}

const requests = path.join(scratch, "cases.txt");
fs.writeFileSync(
  requests,
  cases.map(([method, args]) => [method, ...args].join(" ")).join("\n") +
    "\n",
);
const clr = spawnSync(clrProgram[0], [...clrProgram.slice(1), requests], {
  encoding: "utf8",
});
if (clr.status !== 0) {
  throw new Error(`the CLR program failed: ${clr.stderr}`);
}
const expected = clr.stdout.trim().split("\n");

// Each case on a fresh instance, so a trap in one does not poison the rest.
const module = new WebAssembly.Module(fs.readFileSync(modulePath));
let failures = 0;
cases.forEach(([method, args, value], index) => {
  const instance = new WebAssembly.Instance(module, {});
  let result;
  try {
    result = instance.exports[`Kiln.Tests.${method}`](...args);
  } catch (error) {
    result = `fault ${instance.exports.__fault.value}: ${error.message}`;
  }
  const line = `${method}(${args.join(",")}) = ${result}`;
  console.log(line);
  if (line !== expected[index]) {
    console.error(`  differs from the CLR: ${expected[index]}`);
    failures++;
  }
  if (value !== undefined && result !== value) {
    console.error(`  expected ${value}`);
    failures++;
  }
});
assert.equal(failures, 0, `${failures} checks failed`);
