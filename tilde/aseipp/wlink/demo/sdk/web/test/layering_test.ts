// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "../assert.ts";

/**
 * The core runs in three places, so it must name none of them. A host's own
 * layer may reach for its runtime; the pacing, input, file and audio decisions
 * every host shares may not, which is what keeps them testable here and
 * identical to the native runner.
 */
const DENO_ENTRIES = ["headless.ts", "mirror_dir.ts", "serve.ts"];
const DOM_ENTRIES = ["browser.ts", "canvas2d.ts", "gpu.ts", "storage.ts", "worklet.ts"];

const DENO_TOKENS = ["Deno."];
const DOM_TOKENS = [
  "document",
  "globalThis.window",
  "navigator",
  "requestAnimationFrame",
  "HTMLCanvasElement",
  "AudioContext",
  "indexedDB",
];

// The tests live in a subdirectory, so the modules under scrutiny are one
// level up, in the package root.
const PACKAGE = new URL("../", import.meta.url);

function sources(): string[] {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(PACKAGE)) {
    if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

function read(name: string): string {
  return Deno.readTextFileSync(new URL(name, PACKAGE));
}

Deno.test("the core names no runtime of its own", () => {
  const offences: string[] = [];
  for (const name of sources()) {
    if (DENO_ENTRIES.includes(name) || DOM_ENTRIES.includes(name)) continue;
    const text = read(name);
    for (const token of [...DENO_TOKENS, ...DOM_TOKENS]) {
      if (text.includes(token)) offences.push(`${name} mentions ${token}`);
    }
  }
  assertEquals(offences, []);
});

Deno.test("only a host's own layer reaches for its runtime", () => {
  const offences: string[] = [];
  for (const name of sources()) {
    if (!DENO_ENTRIES.includes(name)) continue;
    const text = read(name);
    for (const token of DOM_TOKENS) {
      if (text.includes(token)) offences.push(`${name} mentions ${token}`);
    }
  }
  for (const name of sources()) {
    if (!DOM_ENTRIES.includes(name)) continue;
    const text = read(name);
    for (const token of DENO_TOKENS) {
      if (text.includes(token)) offences.push(`${name} mentions ${token}`);
    }
  }
  assertEquals(offences, []);
});

Deno.test("every module of this package is accounted for", () => {
  const names = sources();
  for (const name of [...DENO_ENTRIES, ...DOM_ENTRIES]) {
    assertEquals(names.includes(name), true, `${name} is missing from the package`);
  }
});
