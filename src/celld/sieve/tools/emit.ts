// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Writes the JSON Schema bundle of a module's named schemas: one `$defs`
 * entry per exported schema with a `meta.id`, plus the named and lazy
 * schemas they reference. `sieve_json_schema` in `../defs.bzl` runs it in a
 * build action:
 *
 * ```sh
 * deno run --config <unit deno.json> --allow-read --allow-write \
 *   emit.ts <module specifier> <out.json> [--io input] [--unrepresentable any]
 * ```
 *
 * The module is a bare specifier resolved through the unit's import map,
 * so it must be exported by a library the unit depends on.
 *
 * @module
 */

import {
  type JsonSchemaOptions,
  toJSONSchemaBundle,
} from "@celld/sieve/json-schema";

function usage(): never {
  throw new Error(
    "usage: emit.ts <module> <out.json> [--io input|output] [--unrepresentable throw|any]",
  );
}

/** Parses the command line into a module, an output path and options. */
export function parseArgs(args: readonly string[]): {
  module: string;
  out: string;
  options: JsonSchemaOptions;
} {
  const positional: string[] = [];
  let io: JsonSchemaOptions["io"];
  let unrepresentable: JsonSchemaOptions["unrepresentable"];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--io") {
      const value = args[++index];
      if (value !== "input" && value !== "output") usage();
      io = value;
    } else if (arg === "--unrepresentable") {
      const value = args[++index];
      if (value !== "throw" && value !== "any") usage();
      unrepresentable = value;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) usage();
  return {
    module: positional[0],
    out: positional[1],
    options: {
      ...(io === undefined ? {} : { io }),
      ...(unrepresentable === undefined ? {} : { unrepresentable }),
    },
  };
}

if (import.meta.main) {
  const { module, out, options } = parseArgs(Deno.args);
  const exports = await import(module);
  const bundle = toJSONSchemaBundle(exports, options);
  await Deno.writeTextFile(out, JSON.stringify(bundle, null, 2) + "\n");
}
