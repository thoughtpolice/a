// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Runs tests/generator/Probe.cs as gameplayc compiled it with
// DescribeGenerator, and compares each export's result with the CLR's for
// the same file compiled by csc with the generator as an analyzer (the
// `name value` lines tests/generator/Program.cs printed). With --built,
// runs tests/generator/Built.cs's module, whose exports are all 1 when the
// generator learned the build's kind and names. Usage:
//
//   generators.mjs <probe.wasm> <clr-output.txt>
//   generators.mjs --built <built.wasm>
import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";

if (process.argv[2] === "--built") {
  const { instance } = await WebAssembly.instantiate(
    fs.readFileSync(process.argv[3]),
    {},
  );
  for (const name of ["ModuleKind", "LibraryKind", "Names"]) {
    const actual = instance.exports[`Probe.Built.${name}`]();
    console.log(`${name} ${actual}`);
    assert.equal(actual, 1, `${name}: the generator was not told the build`);
  }
  process.exit(0);
}

const [modulePath, clrPath] = process.argv.slice(2);
if (!modulePath || !clrPath) {
  throw new Error("Usage: generators.mjs <probe.wasm> <clr-output.txt>");
}

const { instance } = await WebAssembly.instantiate(
  fs.readFileSync(modulePath),
  {},
);
const expected = fs.readFileSync(clrPath, "utf8").trim().split("\n");
assert.ok(expected.length > 0, "the CLR printed nothing");
for (const line of expected) {
  const [name, value] = line.split(" ");
  const actual = instance.exports[`Probe.Checks.${name}`]();
  assert.equal(String(actual), value, `${name} differs from the CLR's`);
  console.log(`${name} ${actual}`);
}
assert.equal(
  instance.exports["Probe.Checks.DescribesPoint"](),
  1,
  "the generated description is not Point(X:int, Y:float)",
);
