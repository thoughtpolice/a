// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Runs modules for run.mjs's WasmPool, one request per line on stdin and one
// answer per line on stdout. V8 canonicalizes the GC types of every module a
// process compiles and never frees them (it aborts after a few million), so
// the pool replaces this process after a few hundred modules.
import { runWasm } from "./run.mjs";

function decode(base64) {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();
let buffer = "";
for await (
  const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())
) {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const { id, bytes, calls } = JSON.parse(line);
    const result = runWasm(decode(bytes), calls);
    await Deno.stdout.write(
      encoder.encode(JSON.stringify({ id, result }) + "\n"),
    );
  }
}
