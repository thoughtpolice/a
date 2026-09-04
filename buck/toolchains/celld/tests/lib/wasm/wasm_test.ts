// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import adder from "@fixture/wasm/add";
import { add, COMPILED } from "@fixture/wasm";

Deno.test("a wasm specifier is a compiled module under deno test", () => {
  if (!COMPILED || !(adder instanceof WebAssembly.Module)) {
    throw new Error("expected a WebAssembly.Module");
  }
  const exports = WebAssembly.Module.exports(adder).map((e) => e.name);
  if (exports.join() !== "add") throw new Error(`exports: ${exports}`);
  if (add(2, 40) !== 42) throw new Error("add(2, 40) !== 42");
});
