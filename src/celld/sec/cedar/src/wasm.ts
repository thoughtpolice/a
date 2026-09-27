// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The binding to cedar-wasm's module, written by hand in place of the
 * JavaScript glue wasm-bindgen generates for the npm package.
 *
 * cedar-wasm (`@cedar-policy/cedar-wasm`, Apache-2.0, Copyright Cedar
 * Contributors) is Cedar's Rust `ffi` module compiled with wasm-bindgen in
 * externref mode. Its ABI is small:
 *
 * - JSON-shaped arguments and answers cross as externrefs. The Rust side
 *   reads an argument with `JSON.stringify` and builds an answer with
 *   `JSON.parse`, both imported, so only plain JSON data survives the trip
 *   (a `Map` becomes `{}`, `undefined` fields vanish).
 * - Strings cross as UTF-8 in linear memory: `__wbindgen_malloc` and
 *   `__wbindgen_realloc` for arguments, which Rust then owns, and a
 *   `[pointer, length]` pair for answers, which the caller frees.
 * - A throwing import stores its exception with `__wbindgen_exn_store`,
 *   and Rust sees an `Err`.
 *
 * Imports are matched by name without wasm-bindgen's per-build hash suffix
 * (`__wbg_parse_545d1139...` is `parse`), and an import this file does not
 * know fails the load, so a new cedar-wasm build either binds or says why.
 *
 * Rust panics abort (`unreachable`), leaving the instance's state (borrow
 * flags, allocator, thread-local caches) wherever it stopped. Any exception
 * out of a call therefore retires the instance, and the next call starts a
 * fresh one from the compiled module, which is cheap: celld compiles the
 * module once per node. Linear memory only grows, so an instance whose
 * memory passes `maxMemoryBytes` is retired after the call that grew it.
 * Every retirement bumps {@link CedarEngine.generation}, which is how
 * preparsed policy sets (kept inside the instance) know to parse again.
 *
 * @module
 */

import cedarWasm from "@celld/sec/cedar/wasm";
import type * as ffi from "./ffi.ts";

/**
 * A call the engine could not answer, as opposed to an answer saying the
 * policies or request are wrong (those are `failure` answers).
 *
 * - `load`: the module does not bind (an unknown import or missing export).
 * - `rejected`: the FFI threw instead of answering, which it does when an
 *   argument does not deserialize (a missing field, nesting past serde's
 *   recursion limit, a value `JSON.stringify` refuses).
 * - `trap`: the instance aborted (a Rust panic).
 *
 * Both of the last two retire the instance.
 */
export class CedarEngineError extends Error {
  override readonly name = "CedarEngineError";
  readonly code: "load" | "rejected" | "trap";
  constructor(
    code: "load" | "rejected" | "trap",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

/** What the FFI throws through `__wbindgen_throw` (its `unwrap_throw`). */
class Thrown extends Error {}

/** Options for a {@link CedarEngine}. */
export interface EngineOptions {
  /**
   * Retire an instance once its linear memory is larger than this after a
   * call (default 256 MiB). Parsing a large policy set or entity list grows
   * memory for good; retiring gives it back.
   */
  readonly maxMemoryBytes?: number;
}

const DEFAULT_MAX_MEMORY = 256 * 1024 * 1024;

interface Exports {
  readonly memory: WebAssembly.Memory;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  __wbindgen_malloc(size: number, align: number): number;
  __wbindgen_realloc(
    ptr: number,
    old: number,
    size: number,
    align: number,
  ): number;
  __wbindgen_free(ptr: number, size: number, align: number): void;
  __wbindgen_exn_store(index: number): void;
  __externref_table_alloc(): number;
  __wbindgen_start(): void;
  getCedarSDKVersion(): [number, number];
  getCedarLangVersion(): [number, number];
  checkParseContext(call: unknown): unknown;
  checkParseEntities(call: unknown): unknown;
  checkParsePolicySet(call: unknown): unknown;
  checkParseSchema(call: unknown): unknown;
  formatPolicies(call: unknown): unknown;
  getValidRequestEnvsPolicy(policy: unknown, schema: unknown): unknown;
  getValidRequestEnvsTemplate(template: unknown, schema: unknown): unknown;
  isAuthorized(call: unknown): unknown;
  isAuthorizedPartial(call: unknown): unknown;
  policySetTextToParts(ptr: number, len: number): unknown;
  policyToJson(policy: unknown): unknown;
  policyToText(policy: unknown): unknown;
  preparsePolicySet(ptr: number, len: number, policies: unknown): unknown;
  preparseSchema(ptr: number, len: number, schema: unknown): unknown;
  schemaToJson(schema: unknown): unknown;
  schemaToJsonWithResolvedTypes(ptr: number, len: number): unknown;
  schemaToText(schema: unknown): unknown;
  statefulIsAuthorized(call: unknown): unknown;
  templateToJson(template: unknown): unknown;
  templateToText(template: unknown): unknown;
  validate(call: unknown): unknown;
}

/** The exports this binding calls, checked when an instance starts. */
const REQUIRED_EXPORTS: readonly (keyof Exports)[] = [
  "memory",
  "__wbindgen_externrefs",
  "__wbindgen_malloc",
  "__wbindgen_realloc",
  "__wbindgen_free",
  "__wbindgen_exn_store",
  "__externref_table_alloc",
  "__wbindgen_start",
  "getCedarSDKVersion",
  "getCedarLangVersion",
  "checkParseContext",
  "checkParseEntities",
  "checkParsePolicySet",
  "checkParseSchema",
  "formatPolicies",
  "getValidRequestEnvsPolicy",
  "getValidRequestEnvsTemplate",
  "isAuthorized",
  "isAuthorizedPartial",
  "policySetTextToParts",
  "policyToJson",
  "policyToText",
  "preparsePolicySet",
  "preparseSchema",
  "schemaToJson",
  "schemaToJsonWithResolvedTypes",
  "schemaToText",
  "statefulIsAuthorized",
  "templateToJson",
  "templateToText",
  "validate",
];

/** One live instance and the memory views wasm-bindgen's ABI needs. */
class Instance {
  readonly exports: Exports;
  #bytes: Uint8Array | null = null;
  #view: DataView | null = null;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder("utf-8", {
    ignoreBOM: true,
    fatal: true,
  });

  constructor(module: WebAssembly.Module) {
    const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
    for (const entry of WebAssembly.Module.imports(module)) {
      if (entry.kind !== "function") {
        throw new CedarEngineError(
          "load",
          `cedar-wasm imports a ${entry.kind} (${entry.module}.${entry.name}), which this binding does not provide`,
        );
      }
      (imports[entry.module] ??= {})[entry.name] = this.#importFor(entry.name);
    }
    const instance = new WebAssembly.Instance(module, imports);
    const exports = instance.exports as unknown as Exports;
    for (const name of REQUIRED_EXPORTS) {
      if (!(name in exports)) {
        throw new CedarEngineError(
          "load",
          `cedar-wasm does not export ${name}; this binding expects cedar-wasm 4.x`,
        );
      }
    }
    this.exports = exports;
    exports.__wbindgen_start();
  }

  /** The implementation of one import, by its name without the hash. */
  #importFor(name: string): (...args: never[]) => unknown {
    const base = name.replace(/_[0-9a-f]{16}$/, "");
    switch (base) {
      case "__wbindgen_init_externref_table":
        return () => {
          // Index 0 and four well-known values, where wasm-bindgen's Rust
          // side expects them.
          const table = this.exports.__wbindgen_externrefs;
          const offset = table.grow(4);
          table.set(0, undefined);
          table.set(offset + 0, undefined);
          table.set(offset + 1, null);
          table.set(offset + 2, true);
          table.set(offset + 3, false);
        };
      case "__wbg_parse":
        return this.#catching((ptr: number, len: number) =>
          JSON.parse(this.#readString(ptr, len))
        );
      case "__wbg_stringify":
        return this.#catching((value: unknown) => JSON.stringify(value));
      case "__wbg___wbindgen_is_undefined":
        return (value: unknown) => value === undefined;
      case "__wbg___wbindgen_string_get":
        return (out: number, value: unknown) => {
          // Writes the string's [pointer, length], or [0, 0] for a
          // non-string, to the two i32s at `out`.
          const string = typeof value === "string" ? value : undefined;
          const [ptr, len] = string === undefined
            ? [0, 0]
            : this.#writeString(string);
          const view = this.#dataView();
          view.setInt32(out + 4, len, true);
          view.setInt32(out, ptr, true);
        };
      case "__wbg___wbindgen_throw":
        return (ptr: number, len: number) => {
          throw new Thrown(this.#readString(ptr, len));
        };
      default:
        throw new CedarEngineError(
          "load",
          `cedar-wasm imports ${name}, which this binding does not provide`,
        );
    }
  }

  /** An import whose exception Rust receives as an `Err`. */
  #catching<A extends unknown[]>(
    fn: (...args: A) => unknown,
  ): (...args: A) => unknown {
    return (...args: A) => {
      try {
        return fn(...args);
      } catch (error) {
        const index = this.exports.__externref_table_alloc();
        this.exports.__wbindgen_externrefs.set(index, error);
        this.exports.__wbindgen_exn_store(index);
        return undefined;
      }
    };
  }

  #memory(): Uint8Array {
    // Growing memory detaches the old buffer, which empties the view.
    if (this.#bytes === null || this.#bytes.byteLength === 0) {
      this.#bytes = new Uint8Array(this.exports.memory.buffer);
    }
    return this.#bytes;
  }

  #dataView(): DataView {
    if (
      this.#view === null || this.#view.buffer !== this.exports.memory.buffer
    ) {
      this.#view = new DataView(this.exports.memory.buffer);
    }
    return this.#view;
  }

  #readString(ptr: number, len: number): string {
    return this.#decoder.decode(
      this.#memory().subarray(ptr >>> 0, (ptr >>> 0) + len),
    );
  }

  /** Copies `text` into memory Rust will own; returns [pointer, length]. */
  #writeString(text: string): [number, number] {
    const bytes = this.#encoder.encode(text);
    const ptr = this.exports.__wbindgen_malloc(bytes.length, 1) >>> 0;
    this.#memory().set(bytes, ptr);
    return [ptr, bytes.length];
  }

  /** Calls an export that takes a string first, then other arguments. */
  withString(
    text: string,
    call: (ptr: number, len: number) => unknown,
  ): unknown {
    const [ptr, len] = this.#writeString(text);
    return call(ptr, len);
  }

  /** Calls an export that answers a string, and frees it. */
  takeString(call: () => [number, number]): string {
    const [ptr, len] = call();
    try {
      return this.#readString(ptr, len);
    } finally {
      this.exports.__wbindgen_free(ptr, len, 1);
    }
  }

  get memoryBytes(): number {
    return this.exports.memory.buffer.byteLength;
  }
}

/**
 * Cedar's FFI calls over one module. Calls are synchronous and run on the
 * current instance, which is replaced after a trap or when its memory grows
 * past the limit. Answers are Cedar's own JSON (see ./ffi.ts); the typed API
 * in ./cedar.ts is built on these.
 */
export class CedarEngine {
  readonly #module: WebAssembly.Module;
  readonly #maxMemory: number;
  #instance: Instance | null = null;
  #generation = 0;
  #busy = false;

  constructor(module: WebAssembly.Module, options: EngineOptions = {}) {
    if (!(module instanceof WebAssembly.Module)) {
      throw new TypeError("CedarEngine needs a compiled WebAssembly.Module");
    }
    const max = options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY;
    if (!Number.isSafeInteger(max) || max <= 0) {
      throw new RangeError("maxMemoryBytes must be a positive safe integer");
    }
    this.#module = module;
    this.#maxMemory = max;
    // Instantiate now, so a module that does not bind fails here.
    this.#current();
  }

  /**
   * Bumped whenever the instance is replaced. Anything cached inside the
   * instance (preparsed policy sets and schemas) is gone after a bump.
   */
  get generation(): number {
    return this.#generation;
  }

  /** The current instance's linear memory, in bytes. */
  get memoryBytes(): number {
    return this.#current().memoryBytes;
  }

  /** Retires the current instance; the next call starts a fresh one. */
  reset(): void {
    if (this.#instance !== null) {
      this.#instance = null;
      this.#generation++;
    }
  }

  #current(): Instance {
    if (this.#instance === null) {
      this.#instance = new Instance(this.#module);
    }
    return this.#instance;
  }

  #run<T>(name: string, call: (instance: Instance) => unknown): T {
    if (this.#busy) {
      // Only reachable through a JSON.stringify of an argument that runs
      // code (a toJSON) and calls back in; Rust's borrows would panic.
      throw new CedarEngineError(
        "rejected",
        `cedar ${name} called while another call is running`,
      );
    }
    const instance = this.#current();
    this.#busy = true;
    try {
      return call(instance) as T;
    } catch (error) {
      // A throw unwinds past Rust frames without running their destructors,
      // so the instance is not trusted after either kind.
      this.reset();
      if (error instanceof Thrown) {
        throw new CedarEngineError(
          "rejected",
          `cedar ${name} rejected its input: ${error.message}`,
        );
      }
      throw new CedarEngineError(
        "trap",
        `cedar ${name} aborted: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    } finally {
      this.#busy = false;
      if (
        this.#instance === instance && instance.memoryBytes > this.#maxMemory
      ) this.reset();
    }
  }

  sdkVersion(): string {
    return this.#run(
      "getCedarSDKVersion",
      (i) => i.takeString(() => i.exports.getCedarSDKVersion()),
    );
  }

  langVersion(): string {
    return this.#run(
      "getCedarLangVersion",
      (i) => i.takeString(() => i.exports.getCedarLangVersion()),
    );
  }

  checkParsePolicySet(policies: ffi.PolicySet): ffi.CheckParseAnswer {
    return this.#run(
      "checkParsePolicySet",
      (i) => i.exports.checkParsePolicySet(policies),
    );
  }

  checkParseSchema(schema: ffi.Schema): ffi.CheckParseAnswer {
    return this.#run(
      "checkParseSchema",
      (i) => i.exports.checkParseSchema(schema),
    );
  }

  checkParseEntities(call: ffi.EntitiesParsingCall): ffi.CheckParseAnswer {
    return this.#run(
      "checkParseEntities",
      (i) => i.exports.checkParseEntities(call),
    );
  }

  checkParseContext(call: ffi.ContextParsingCall): ffi.CheckParseAnswer {
    return this.#run(
      "checkParseContext",
      (i) => i.exports.checkParseContext(call),
    );
  }

  formatPolicies(call: ffi.FormattingCall): ffi.FormattingAnswer {
    return this.#run("formatPolicies", (i) => i.exports.formatPolicies(call));
  }

  policySetTextToParts(text: string): ffi.PolicySetTextToPartsAnswer {
    return this.#run(
      "policySetTextToParts",
      (i) => i.withString(text, (p, l) => i.exports.policySetTextToParts(p, l)),
    );
  }

  policyToJson(policy: ffi.Policy): ffi.PolicyToJsonAnswer {
    return this.#run("policyToJson", (i) => i.exports.policyToJson(policy));
  }

  policyToText(policy: ffi.Policy): ffi.PolicyToTextAnswer {
    return this.#run("policyToText", (i) => i.exports.policyToText(policy));
  }

  templateToJson(template: ffi.Template): ffi.PolicyToJsonAnswer {
    return this.#run(
      "templateToJson",
      (i) => i.exports.templateToJson(template),
    );
  }

  templateToText(template: ffi.Template): ffi.PolicyToTextAnswer {
    return this.#run(
      "templateToText",
      (i) => i.exports.templateToText(template),
    );
  }

  schemaToJson(schema: ffi.Schema): ffi.SchemaToJsonAnswer {
    return this.#run("schemaToJson", (i) => i.exports.schemaToJson(schema));
  }

  schemaToJsonWithResolvedTypes(text: string): ffi.SchemaToJsonAnswer {
    return this.#run(
      "schemaToJsonWithResolvedTypes",
      (i) =>
        i.withString(
          text,
          (p, l) => i.exports.schemaToJsonWithResolvedTypes(p, l),
        ),
    );
  }

  schemaToText(schema: ffi.Schema): ffi.SchemaToTextAnswer {
    return this.#run("schemaToText", (i) => i.exports.schemaToText(schema));
  }

  validate(call: ffi.ValidationCall): ffi.ValidationAnswer {
    return this.#run("validate", (i) => i.exports.validate(call));
  }

  validRequestEnvsPolicy(
    policy: ffi.Policy,
    schema: ffi.Schema,
  ): ffi.GetValidRequestEnvsResult {
    return this.#run(
      "getValidRequestEnvsPolicy",
      (i) => i.exports.getValidRequestEnvsPolicy(policy, schema),
    );
  }

  validRequestEnvsTemplate(
    template: ffi.Template,
    schema: ffi.Schema,
  ): ffi.GetValidRequestEnvsResult {
    return this.#run(
      "getValidRequestEnvsTemplate",
      (i) => i.exports.getValidRequestEnvsTemplate(template, schema),
    );
  }

  isAuthorized(call: ffi.AuthorizationCall): ffi.AuthorizationAnswer {
    return this.#run("isAuthorized", (i) => i.exports.isAuthorized(call));
  }

  isAuthorizedPartial(
    call: ffi.PartialAuthorizationCall,
  ): ffi.PartialAuthorizationAnswer {
    return this.#run(
      "isAuthorizedPartial",
      (i) => i.exports.isAuthorizedPartial(call),
    );
  }

  /**
   * Parses a policy set into the instance under `id`, replacing what was
   * there. Returns the generation it was parsed in; it is gone once
   * {@link generation} moves on.
   */
  preparsePolicySet(id: string, policies: ffi.PolicySet): ffi.CheckParseAnswer {
    return this.#run(
      "preparsePolicySet",
      (i) =>
        i.withString(id, (p, l) => i.exports.preparsePolicySet(p, l, policies)),
    );
  }

  preparseSchema(name: string, schema: ffi.Schema): ffi.CheckParseAnswer {
    return this.#run(
      "preparseSchema",
      (i) =>
        i.withString(name, (p, l) => i.exports.preparseSchema(p, l, schema)),
    );
  }

  statefulIsAuthorized(
    call: ffi.StatefulAuthorizationCall,
  ): ffi.AuthorizationAnswer {
    return this.#run(
      "statefulIsAuthorized",
      (i) => i.exports.statefulIsAuthorized(call),
    );
  }
}

let shared: CedarEngine | null = null;

/**
 * The isolate's engine over the bundled cedar-wasm module, made on first
 * use. Every Worker request in the isolate shares it; calls are
 * synchronous, so they never interleave.
 */
export function sharedEngine(): CedarEngine {
  return shared ??= new CedarEngine(cedarWasm);
}

/** The bundled cedar-wasm module, for {@link CedarEngine} with options. */
export const CEDAR_WASM: WebAssembly.Module = cedarWasm;
