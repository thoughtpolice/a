// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Deno-only stand-in for celld's "cloudflare:workers" module.
 * `celld.test(fake_runtime = True)` maps the module here; bundles keep the
 * real import. It has a value for every export types/celld.d.ts declares
 * (graph_test.py checks that), but emulates no platform behaviour:
 * integration fakes supply explicit ledgers.
 * @module
 */

/** Test-compatible DurableObject base; namespaces provide cloning and dispatch. */
export class DurableObject<
  Env = unknown,
  Exports extends object = Record<string, unknown>,
  Props = unknown,
  Id extends DurableObjectId | string = DurableObjectId,
> {
  constructor(
    protected readonly ctx: DurableObjectState<Exports, Props, Id>,
    protected readonly env: Env,
  ) {}
}

/** Test-compatible WorkerEntrypoint constructor. */
export class WorkerEntrypoint<
  Env = unknown,
  Exports extends object = Record<string, unknown>,
  Props = unknown,
> {
  constructor(
    protected readonly ctx: ExecutionContext<Exports, Props>,
    protected readonly env: Env,
  ) {}
}

/** Test-compatible WorkflowEntrypoint constructor. */
export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  constructor(
    protected readonly ctx: WorkflowExecutionContext,
    protected readonly env: Env,
  ) {}
  /** Concrete Workflow modules implement run. */
  abstract run(
    event: WorkflowEvent<Params>,
    step: WorkflowStep,
  ): Promise<unknown>;
}

export type WorkflowEvent<Params = unknown> = globalThis.WorkflowEvent<Params>;
export type WorkflowStep = globalThis.WorkflowStep;
export type WorkflowStepConfig = globalThis.WorkflowStepConfig;
export type WorkflowStepContext = globalThis.WorkflowStepContext;

/** Base class for objects passed by reference over RPC; a plain class here. */
export class RpcTarget {}

/** The asynchronous, disposable view celld hands out for an RPC target. */
export type RpcStub<T extends object = object> = CelldRpcStub<T>;

function project(target: object): unknown {
  return new Proxy(target, {
    get(object, key) {
      if (key === "dup") return () => project(target);
      if (key === Symbol.dispose) return () => {};
      const value = Reflect.get(object, key, object);
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          Promise.resolve().then(() => Reflect.apply(value, object, args));
      }
      return Promise.resolve(value);
    },
    apply(fn, _this, args) {
      return Promise.resolve().then(() =>
        Reflect.apply(fn as (...args: unknown[]) => unknown, target, args)
      );
    },
  });
}

/**
 * Wraps a local object or function the way celld does: members become
 * asynchronous, and the stub has `dup()` and `[Symbol.dispose]()`. There is
 * no serialization; arguments and results are passed as they are.
 */
export const RpcStub = function RpcStub(target: object) {
  return project(target);
} as unknown as {
  readonly prototype: object;
  new <T extends object>(target: T): RpcStub<T>;
};

/** Promise subclass celld uses for pipelined RPC results. */
export class RpcPromise<T> extends Promise<T> {}

/** Brand of celld's pipelined RPC property paths. */
export class RpcProperty {}

/** Brand of celld's service-binding stubs. */
export class ServiceStub {}

/**
 * Starts background work. There is no event to extend: the promise simply
 * runs, and a rejection surfaces as an unhandled rejection in the test.
 */
export function waitUntil(promise: Promise<unknown>): void {
  void promise;
}

/**
 * The Worker's bindings. Empty; a test that needs bindings assigns them
 * (`Object.assign(env, {...})`) before importing code that reads them.
 */
export const env: Record<string, unknown> = {};

const workerExports: Record<string, unknown> = {};

/** The Worker's loopback exports; empty, like `env`. */
export { workerExports as exports };
