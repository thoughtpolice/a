// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import adder from "@fixture/wasm/add";

const instance = new WebAssembly.Instance(adder, {});
const exported = instance.exports.add as (a: number, b: number) => number;

/** Adds two 32-bit integers in wasm. */
export function add(a: number, b: number): number {
  return exported(a, b);
}

/** Whether the module arrived compiled, as celld and Deno both give it. */
export const COMPILED: boolean = adder instanceof WebAssembly.Module;
