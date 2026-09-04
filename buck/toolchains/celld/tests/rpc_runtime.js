// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Native RPC contracts for the pinned celld runtime, independent of applications.
 * The public Worker exposes bounded scenarios to the Python harness. Calls use
 * real DO/service stubs, so argument/result copying and visibility cannot be
 * accidentally supplied by a same-object test double. One acknowledged SQLite
 * value is read again after the harness restarts the entire dev supervisor.
 * Error scenarios pin celld's separate enumerable-property envelope, including
 * custom-class identity loss and fallback when a property cannot be cloned.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

/** Custom errors retain their name/data on the wire, but not this prototype. */
class ContractError extends Error {
  constructor() {
    super("custom rejection");
    this.name = "ContractError";
    this.status = 409;
    this.metadata = { expected: 7, labels: ["fenced", "retry"] };
    Object.defineProperty(this, "hidden", { value: "non-enumerable" });
  }
}

/** Captures only stable error contracts, not runtime-specific stack frames. */
async function errorDetails(operation) {
  try {
    return { unexpectedSuccess: await operation() };
  } catch (error) {
    return {
      name: error.name,
      message: error.message,
      remote: error.remote,
      isError: error instanceof Error,
      isTypeError: error instanceof TypeError,
      isCustom: error instanceof ContractError,
      plainErrorPrototype: Object.getPrototypeOf(error) === Error.prototype,
      status: error.status ?? null,
      metadata: error.metadata ?? null,
      hidden: "hidden" in error,
      uncloneable: "uncloneable" in error,
      stackStartsWithMessage: error.stack.startsWith(
        error.name + ": " + error.message,
      ),
    };
  }
}

/** Captures a remote rejection without hiding unexpected successful dispatch. */
async function outcome(operation) {
  try {
    return { value: await operation() };
  } catch (error) {
    return { error: { name: error.name, message: error.message } };
  }
}

/** State owner used to pin cloning, persistence, and actual DO method visibility. */
export class RPCObject extends DurableObject {
  /** Own data is not callable, unlike the own function field below. */
  field = "private-looking but public";
  /** celld 0.5.0 DO RPC accepts callable own fields. */
  ownMethod = () => "own-method";
  /** Volatile state proves that returned values are not live references. */
  #memory;
  /** Only JavaScript privacy reliably removes a helper from runtime lookup. */
  #helper() {
    return "helper-result";
  }

  /** Public prototype helpers are remotely callable, regardless of their name. */
  publicHelper() {
    return this.#helper();
  }

  /** DO lifecycle names are currently callable through native RPC. */
  alarm() {
    return "alarm-rpc";
  }

  /** Mutates the received clone and returns it without mutating the caller. */
  transform(value) {
    value.nested.count += 1;
    value.bytes[0] += 1;
    value.map.set("callee", 2);
    this.#memory = value;
    return value;
  }

  /** Returns another clone of the retained state to check result isolation. */
  snapshot() {
    return this.#memory;
  }

  /** Missing values preserve null instead of inventing a response envelope. */
  absent() {
    return null;
  }

  /** Void returns preserve undefined over the native structured-clone transport. */
  nothing() {}

  /** Acknowledges an application write only after storage has synchronized it. */
  async write(value) {
    await this.ctx.storage.put("value", value);
    await this.ctx.storage.sync();
    return { value };
  }

  /** Reads the acknowledged record after supervisor restart. */
  async read() {
    return await this.ctx.storage.get("value") ?? null;
  }

  /** Throws representative error envelopes for the caller's reconstruction checks. */
  reject(mode) {
    if (mode === "standard") {
      const error = new TypeError("standard rejection");
      error.status = 422;
      error.metadata = { field: "count" };
      throw error;
    }
    const error = new ContractError();
    if (mode === "uncloneable") error.uncloneable = () => "not cloneable";
    throw error;
  }
}

/** Service entrypoints intentionally have stricter runtime visibility than DOs. */
export class RPCService extends WorkerEntrypoint {
  /** Own functions are unavailable over service RPC, despite their TS shape. */
  ownMethod = () => "must-not-be-exposed";
  /** Service RPC rejects lifecycle names before invoking their implementation. */
  alarm() {
    return "must-not-be-exposed";
  }
  /** Real private names never enter prototype lookup. */
  #helper() {
    return "service-helper";
  }
  /** Ordinary public prototype methods are part of the service RPC interface. */
  publicHelper() {
    return this.#helper();
  }
}

/** Converts typed clone values into JSON only at the external test boundary. */
function describe(value) {
  return {
    count: value.nested.count,
    bytes: [...value.bytes],
    map: [...value.map],
    date: value.date.toISOString(),
    typed: value.bytes instanceof Uint8Array && value.map instanceof Map &&
      value.date instanceof Date,
  };
}

export default {
  /** Dispatches one closed-set contract scenario; no arbitrary RPC passthrough. */
  async fetch(request, env) {
    const input = await request.json();
    const stub = env.OBJECT.getByName(input.name ?? "contract");
    switch (input.scenario) {
      case "clone": {
        const original = {
          nested: { count: 1 },
          bytes: new Uint8Array([3, 4]),
          map: new Map([["caller", 1]]),
          date: new Date("2026-01-02T03:04:05Z"),
        };
        const result = await stub.transform(original);
        const received = describe(result);
        result.nested.count = 99;
        result.bytes[0] = 99;
        result.map.set("caller", 99);
        return Response.json({
          original: describe(original),
          received,
          retained: describe(await stub.snapshot()),
          absent: await stub.absent(),
          voidIsUndefined: await stub.nothing() === undefined,
        });
      }
      case "visibility": {
        const object = {};
        const service = {};
        for (
          const name of [
            "publicHelper",
            "ownMethod",
            "alarm",
            "helper",
            "#helper",
            "field",
            "ctx",
            "missing",
          ]
        ) {
          object[name] = await outcome(() => stub[name]());
          service[name] = await outcome(() => env.SERVICE[name]());
        }
        return Response.json({ object, service });
      }
      case "errors": {
        const failures = {};
        for (const mode of ["custom", "standard", "uncloneable"]) {
          failures[mode] = await errorDetails(() => stub.reject(mode));
        }
        return Response.json(failures);
      }
      case "write":
        return Response.json(await stub.write(input.value));
      case "read":
        return Response.json({ value: await stub.read() });
      default:
        return Response.json({ error: "unknown scenario" }, { status: 400 });
    }
  },
};
