// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Deno-only constructors for celld builtin imports. `celld.test(fake_runtime =
 * True)` maps "cloudflare:workers" here; bundles keep the real import.
 * These do not emulate persistence: integration fakes supply explicit ledgers.
 * @module
 */
/** Test-compatible DurableObject base; namespaces provide cloning and dispatch. */
export class DurableObject<Env> {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: Env,
  ) {}
}
/** Test-compatible WorkerEntrypoint constructor. */
export class WorkerEntrypoint<Env> {
  constructor(protected readonly ctx: unknown, protected readonly env: Env) {}
}
/** Test-compatible WorkflowEntrypoint constructor. */
export abstract class WorkflowEntrypoint<Env, Params> {
  constructor(protected readonly ctx: unknown, protected readonly env: Env) {}
  /** Type marker; concrete Workflow modules implement run. */
  abstract run(
    event: WorkflowEvent<Params>,
    step: WorkflowStep,
  ): Promise<unknown>;
}
