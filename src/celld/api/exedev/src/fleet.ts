// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Desired state for a set of VMs, and the loop that makes it true.
 *
 * A {@link FleetSpec} names VMs deterministically (`<prefix>-0`,
 * `<prefix>-1`, ... or an explicit list) and says what each should look like.
 * {@link planFleet} compares it with `ls` and a **ledger** of what this fleet
 * has done, and returns the actions to take; {@link FleetReconciler} runs
 * them. The `ExeFleet` Durable Object in `@celld/api/exedev/durable` keeps the
 * ledger in SQLite and serializes runs.
 *
 * Correctness under retries and partial failure rests on four rules:
 *
 * 1. **Names are the idempotency keys.** `new` is not idempotent, but a VM
 *    name is unique, so a second `new --name=web-0` fails instead of making a
 *    second VM. The planner only ever creates desired names, and a failed or
 *    ambiguous `new` is followed by a fresh `ls`: if the VM is there, it is
 *    adopted.
 * 2. **Intent before action.** Before `new` or `rm`, the ledger records
 *    `creating`/`deleting` and the store is synced; a crash between the two
 *    leaves a record that the next run resolves by listing. A `creating`
 *    record younger than `creatingGraceMs` is waited on, not retried, which
 *    also backs off definite failures.
 * 3. **Only touch what is ours.** Tags are removed only if this fleet applied
 *    them; VMs are deleted (with `prune`) only when the ledger created or
 *    adopted them or they carry the fleet's owner tag, and never when they are
 *    desired.
 * 4. **Every change is convergent.** Tagging, commenting, resizing,
 *    attaching and sharing set a target value, so repeating one after an
 *    ambiguous failure is harmless; the ledger records what was applied so
 *    the next run only sends what differs.
 *
 * What `ls` reports decides what can be observed: the documented listing has
 * no tags, comment or sizes, so for those the ledger's record of what was
 * applied stands in. When `ls` does report `tags` or `comment`, they are
 * used. Changes made outside the fleet to unobservable settings are not
 * detected.
 *
 * @module
 */

import { v } from "@celld/sieve";
import type { AttachSpec } from "./api.ts";
import {
  type CreatedVm,
  issuesFrom,
  type LsResult,
  type VmSummary,
} from "./decode.ts";
import {
  type ExeErrorData,
  ExeInvalidRequestError,
  outcome,
} from "./errors.ts";
import type { Issue, JsonValue } from "./json.ts";
import type { NewVmOptions } from "./client.ts";
import type { CallOptions } from "./transport.ts";
import { defaultRuntime, type Runtime } from "./runtime.ts";
import { Port, Region, Size, sizeInGb, VmName, word } from "./validate.ts";

/** The desired state of a fleet. */
export interface FleetSpec {
  /** Names are `<prefix>-<index>`; also the default owner tag's suffix. */
  readonly prefix: string;
  /** How many VMs; default 0. Ignored when `names` is given. */
  readonly size?: number;
  /** Explicit VM names instead of `<prefix>-<index>`. */
  readonly names?: readonly string[];
  readonly image?: string;
  readonly cpu?: number;
  readonly memory?: Size;
  readonly disk?: Size;
  readonly comment?: string;
  /** Tags besides the owner tag. */
  readonly tags?: readonly string[];
  /** Integrations attached to each VM (`vm:<name>`). */
  readonly integrations?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly setupScript?: string;
  readonly pool?: string;
  /**
   * The region the VMs are expected in. Placement follows the account's
   * region (`set-region`), so this is checked and reported, never enforced.
   */
  readonly region?: string;
  /** The HTTPS proxy's port and visibility. */
  readonly share?: { readonly public?: boolean; readonly port?: number };
  /** Delete owned VMs that are no longer desired; default false. */
  readonly prune?: boolean;
  /** Tag that marks the fleet's VMs; default `fleet-<prefix>`. */
  readonly ownerTag?: string;
  /** Skip the email `new` sends; default true. */
  readonly noEmail?: boolean;
}

const PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A string of at most `max` UTF-8 bytes. */
function utf8Text(max: number) {
  return v.string().check((ctx) => {
    const bytes = new TextEncoder().encode(ctx.value).length;
    if (bytes > max) ctx.addIssue(`is ${bytes} bytes; at most ${max}`);
  });
}

/**
 * The schema of a {@link FleetSpec}: a strict object, so a misspelled key
 * is an error rather than a setting silently ignored. `size` and `names`
 * exclude each other, and `names` may not repeat.
 */
export const FleetSpec: v.Schema<FleetSpec, unknown> = v.strictObject({
  prefix: v.string().regex(
    PREFIX,
    "must be 1-42 lowercase letters, digits and hyphens",
  ),
  size: v.int().min(0).max(1000).optional(),
  names: v.array(VmName).optional(),
  image: word("image reference").optional(),
  cpu: v.int().min(1).optional(),
  memory: Size.optional(),
  disk: Size.optional(),
  comment: utf8Text(200).refine(
    (text) => !text.startsWith("-"),
    "must not start with '-'",
  ).optional(),
  tags: v.array(word("tag")).optional(),
  integrations: v.array(word("integration name")).optional(),
  env: v.record(
    v.string().regex(ENV_NAME, "must be a variable name"),
    v.string(),
  ).optional(),
  setupScript: utf8Text(10 * 1024).optional(),
  pool: word("pool name").optional(),
  region: Region.optional(),
  share: v.strictObject({
    public: v.boolean().optional(),
    port: Port.optional(),
  }).optional(),
  prune: v.boolean().optional(),
  ownerTag: word("tag").optional(),
  noEmail: v.boolean().optional(),
}).check((ctx) => {
  const { names, size } = ctx.value;
  if (names !== undefined && size !== undefined) {
    ctx.addIssue({ path: ["size"], message: "give size or names, not both" });
  }
  if (names !== undefined && new Set(names).size !== names.length) {
    ctx.addIssue({ path: ["names"], message: "has duplicates" });
  }
}).meta({ id: "FleetSpec" });

/**
 * Every rule a spec breaks, as {@link FleetSpec} reports them. The
 * cross-field rules (`size` with `names`, duplicate names) are checked once
 * every field is valid.
 */
export function fleetSpecIssues(spec: unknown): Issue[] {
  const result = FleetSpec.safeParse(spec);
  return result.success ? [] : issuesFrom(result.error.issues);
}

/** The owner tag of a spec. */
export function ownerTag(spec: FleetSpec): string {
  return spec.ownerTag ?? `fleet-${spec.prefix}`;
}

/** The VM names a spec wants, in order. */
export function desiredNames(spec: FleetSpec): string[] {
  if (spec.names !== undefined) return [...spec.names];
  return Array.from(
    { length: spec.size ?? 0 },
    (_, index) => `${spec.prefix}-${index}`,
  );
}

/** What the fleet last applied to a VM successfully. */
export interface AppliedState {
  readonly tags: readonly string[];
  readonly comment: string | null;
  readonly cpu: number | null;
  readonly memory: string | null;
  readonly disk: string | null;
  readonly integrations: readonly string[];
  readonly sharePublic: boolean | null;
  readonly sharePort: number | null;
}

/** Nothing applied yet. */
export const NOTHING_APPLIED: AppliedState = Object.freeze({
  tags: [],
  comment: null,
  cpu: null,
  memory: null,
  disk: null,
  integrations: [],
  sharePublic: null,
  sharePort: null,
});

/** The fleet's record of one VM. */
export interface LedgerEntry {
  readonly name: string;
  /** `creating`/`deleting`: the request was (maybe) sent; `present`: seen or created. */
  readonly phase: "creating" | "present" | "deleting";
  /** When the current phase's intent was recorded, epoch ms. */
  readonly intentAt: number;
  readonly updatedAt: number;
  /** Create or delete attempts in the current phase. */
  readonly attempts: number;
  readonly applied: AppliedState;
  readonly lastError: ExeErrorData | null;
}

/** One step of a plan. */
export type FleetAction =
  | {
    readonly kind: "create";
    readonly vm: string;
    readonly options: NewVmOptions;
  }
  | {
    readonly kind: "adopt";
    readonly vm: string;
    readonly applied: AppliedState;
  }
  | {
    readonly kind: "await";
    readonly vm: string;
    readonly phase: "creating" | "deleting";
    readonly sinceMs: number;
  }
  | {
    readonly kind: "tag";
    readonly vm: string;
    readonly tags: readonly string[];
  }
  | {
    readonly kind: "untag";
    readonly vm: string;
    readonly tags: readonly string[];
  }
  | { readonly kind: "comment"; readonly vm: string; readonly text: string }
  | {
    readonly kind: "resize";
    readonly vm: string;
    readonly cpu?: number;
    readonly memory?: string;
    readonly disk?: string;
  }
  | {
    readonly kind: "attach";
    readonly vm: string;
    readonly integration: string;
  }
  | {
    readonly kind: "detach";
    readonly vm: string;
    readonly integration: string;
  }
  | { readonly kind: "share-port"; readonly vm: string; readonly port: number }
  | {
    readonly kind: "share-visibility";
    readonly vm: string;
    readonly public: boolean;
  }
  | { readonly kind: "delete"; readonly vm: string }
  | { readonly kind: "forget"; readonly vm: string };

/** Something the fleet cannot or will not fix, for a person or a brain. */
export interface FleetDrift {
  readonly vm: string;
  readonly kind:
    | "region"
    | "status"
    | "disk-shrink"
    | "unowned-extra"
    | "extra"
    | "setting-unapplied";
  readonly message: string;
}

/** The output of {@link planFleet}. */
export interface FleetPlan {
  readonly desired: readonly string[];
  readonly actions: readonly FleetAction[];
  readonly drift: readonly FleetDrift[];
}

/** Timing of {@link planFleet}. */
export interface PlanOptions {
  /** How long a `creating` intent is waited on before `new` is sent again. */
  readonly creatingGraceMs?: number;
  /** How long a `deleting` intent is waited on before `rm` is sent again. */
  readonly deletingGraceMs?: number;
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function diff(left: readonly string[], right: readonly string[]): string[] {
  const set = new Set(right);
  return left.filter((item) => !set.has(item));
}

/** The `new` settings for one VM of a spec. */
export function newVmOptions(spec: FleetSpec, name: string): NewVmOptions {
  return {
    name,
    ...(spec.image === undefined ? {} : { image: spec.image }),
    ...(spec.cpu === undefined ? {} : { cpu: spec.cpu }),
    ...(spec.memory === undefined ? {} : { memory: String(spec.memory) }),
    ...(spec.disk === undefined ? {} : { disk: String(spec.disk) }),
    ...(spec.comment === undefined ? {} : { comment: spec.comment }),
    tags: uniq([ownerTag(spec), ...(spec.tags ?? [])]),
    ...(spec.integrations === undefined || spec.integrations.length === 0
      ? {}
      : { integrations: [...spec.integrations] }),
    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
    ...(spec.setupScript === undefined
      ? {}
      : { setupScript: spec.setupScript }),
    ...(spec.pool === undefined ? {} : { pool: spec.pool }),
    noEmail: spec.noEmail ?? true,
  };
}

/** What a successful `new` applied. */
export function appliedByCreate(options: NewVmOptions): AppliedState {
  return {
    tags: [...(options.tags ?? [])],
    comment: options.comment ?? null,
    cpu: options.cpu ?? null,
    memory: options.memory === undefined ? null : String(options.memory),
    disk: options.disk === undefined ? null : String(options.disk),
    integrations: [...(options.integrations ?? [])],
    sharePublic: null,
    sharePort: null,
  };
}

function convergeActions(
  spec: FleetSpec,
  vm: string,
  observed: VmSummary,
  applied: AppliedState,
  drift: FleetDrift[],
): FleetAction[] {
  const actions: FleetAction[] = [];
  const wanted = uniq([ownerTag(spec), ...(spec.tags ?? [])]);
  const current = observed.tags ?? applied.tags;
  const add = diff(wanted, current);
  if (add.length > 0) actions.push({ kind: "tag", vm, tags: add });
  const remove = diff(
    applied.tags.filter((tag) => current.includes(tag)),
    wanted,
  );
  if (remove.length > 0) actions.push({ kind: "untag", vm, tags: remove });
  if (spec.comment !== undefined) {
    const now = observed.comment ?? applied.comment;
    if (now !== spec.comment) {
      actions.push({ kind: "comment", vm, text: spec.comment });
    }
  }
  const resize: { cpu?: number; memory?: string; disk?: string } = {};
  if (spec.cpu !== undefined && applied.cpu !== spec.cpu) resize.cpu = spec.cpu;
  if (
    spec.memory !== undefined &&
    sizeInGb(applied.memory ?? undefined) !== sizeInGb(spec.memory)
  ) {
    resize.memory = String(spec.memory);
  }
  if (spec.disk !== undefined) {
    const want = sizeInGb(spec.disk);
    const have = sizeInGb(applied.disk ?? undefined);
    if (have === undefined) {
      drift.push({
        vm,
        kind: "setting-unapplied",
        message:
          `disk size is unknown (the listing does not report it); not resizing to ${spec.disk}`,
      });
    } else if (want !== undefined && want > have) {
      resize.disk = String(spec.disk);
    } else if (want !== undefined && want < have) {
      drift.push({
        vm,
        kind: "disk-shrink",
        message: `disk is ${applied.disk}; it cannot shrink to ${spec.disk}`,
      });
    }
  }
  if (Object.keys(resize).length > 0) {
    actions.push({ kind: "resize", vm, ...resize });
  }
  const integrations = spec.integrations ?? [];
  for (const integration of diff(integrations, applied.integrations)) {
    actions.push({ kind: "attach", vm, integration });
  }
  for (const integration of diff(applied.integrations, integrations)) {
    actions.push({ kind: "detach", vm, integration });
  }
  if (spec.share?.port !== undefined && applied.sharePort !== spec.share.port) {
    actions.push({ kind: "share-port", vm, port: spec.share.port });
  }
  if (
    spec.share?.public !== undefined &&
    applied.sharePublic !== spec.share.public
  ) {
    actions.push({ kind: "share-visibility", vm, public: spec.share.public });
  }
  if (
    spec.region !== undefined && observed.region !== undefined &&
    observed.region !== spec.region
  ) {
    drift.push({
      vm,
      kind: "region",
      message: `is in ${observed.region}, expected ${spec.region}`,
    });
  }
  if (observed.status !== "running") {
    drift.push({ vm, kind: "status", message: `status is ${observed.status}` });
  }
  return actions;
}

/**
 * The actions that move the observed VMs toward `spec`, given the ledger.
 * Pure: no I/O, and the same inputs give the same plan.
 */
export function planFleet(
  spec: FleetSpec,
  observed: readonly VmSummary[],
  ledger: readonly LedgerEntry[],
  now: number,
  options: PlanOptions = {},
): FleetPlan {
  const issues = fleetSpecIssues(spec);
  if (issues.length > 0) throw new ExeInvalidRequestError(issues);
  const creatingGrace = options.creatingGraceMs ?? 120_000;
  const deletingGrace = options.deletingGraceMs ?? 120_000;
  const desired = desiredNames(spec);
  const desiredSet = new Set(desired);
  const seen = new Map(observed.map((vm) => [vm.vm_name, vm]));
  const records = new Map(ledger.map((entry) => [entry.name, entry]));
  const actions: FleetAction[] = [];
  const drift: FleetDrift[] = [];
  const owner = ownerTag(spec);

  for (const vm of desired) {
    const found = seen.get(vm);
    const record = records.get(vm);
    if (found === undefined) {
      if (
        record?.phase === "creating" && now - record.intentAt < creatingGrace
      ) {
        actions.push({
          kind: "await",
          vm,
          phase: "creating",
          sinceMs: now - record.intentAt,
        });
      } else {
        actions.push({ kind: "create", vm, options: newVmOptions(spec, vm) });
      }
      continue;
    }
    let applied = record?.applied ?? NOTHING_APPLIED;
    if (record === undefined || record.phase !== "present") {
      applied = record?.phase === "creating"
        ? appliedByCreate(newVmOptions(spec, vm))
        : {
          ...applied,
          tags: found.tags === undefined
            ? applied.tags
            : found.tags.filter((tag) => tag === owner),
          comment: found.comment ?? applied.comment,
        };
      actions.push({ kind: "adopt", vm, applied });
    }
    actions.push(...convergeActions(spec, vm, found, applied, drift));
  }

  for (const entry of ledger) {
    if (desiredSet.has(entry.name)) continue;
    const found = seen.get(entry.name);
    if (found === undefined) {
      actions.push({ kind: "forget", vm: entry.name });
    } else if (
      entry.phase === "deleting" && now - entry.intentAt < deletingGrace
    ) {
      actions.push({
        kind: "await",
        vm: entry.name,
        phase: "deleting",
        sinceMs: now - entry.intentAt,
      });
    } else if (spec.prune) {
      actions.push({ kind: "delete", vm: entry.name });
    } else {
      drift.push({
        vm: entry.name,
        kind: "extra",
        message: "is owned by the fleet but not desired (prune is off)",
      });
    }
  }
  for (const vm of observed) {
    if (desiredSet.has(vm.vm_name) || records.has(vm.vm_name)) continue;
    if (vm.tags?.includes(owner)) {
      if (spec.prune) actions.push({ kind: "delete", vm: vm.vm_name });
      else {drift.push({
          vm: vm.vm_name,
          kind: "extra",
          message: `carries ${owner} but is not desired (prune is off)`,
        });}
    } else if (
      spec.names === undefined &&
      new RegExp(`^${spec.prefix}-\\d+$`).test(vm.vm_name)
    ) {
      drift.push({
        vm: vm.vm_name,
        kind: "unowned-extra",
        message:
          "matches the fleet's names but the fleet has no record of it; left alone",
      });
    }
  }
  return { desired, actions, drift };
}

/** Where a reconciler keeps its ledger. */
export interface FleetStore {
  /** Every ledger entry. */
  list(): LedgerEntry[] | Promise<LedgerEntry[]>;
  put(entry: LedgerEntry): void | Promise<void>;
  delete(name: string): void | Promise<void>;
  /** Waits until earlier writes are durable (a Durable Object's `sync()`). */
  sync(): Promise<void>;
}

/** A ledger in memory, for tests and single-process use. */
export function memoryFleetStore(): FleetStore & {
  readonly entries: Map<string, LedgerEntry>;
} {
  const entries = new Map<string, LedgerEntry>();
  return {
    entries,
    list: () => [...entries.values()].map((entry) => structuredClone(entry)),
    put: (entry) => {
      entries.set(entry.name, structuredClone(entry));
    },
    delete: (name) => {
      entries.delete(name);
    },
    sync: () => Promise.resolve(),
  };
}

/** The client methods a reconciler uses; `ExeClient` has them all. */
export interface FleetClient {
  ls(
    flags?: { readonly long?: boolean },
    options?: CallOptions,
  ): Promise<LsResult>;
  "new"(settings: NewVmOptions, options?: CallOptions): Promise<CreatedVm>;
  rm(
    vms: string | readonly string[],
    options?: CallOptions,
  ): Promise<JsonValue>;
  tag(
    vm: string,
    tags: readonly string[],
    options?: CallOptions,
  ): Promise<JsonValue>;
  untag(
    vm: string,
    tags: readonly string[],
    options?: CallOptions,
  ): Promise<JsonValue>;
  comment(vm: string, text: string, options?: CallOptions): Promise<JsonValue>;
  resize(
    vm: string,
    settings: { cpu?: number; memory?: Size; disk?: Size },
    options?: CallOptions,
  ): Promise<JsonValue>;
  readonly integrations: {
    attach(
      name: string,
      spec: AttachSpec,
      flags?: object,
      options?: CallOptions,
    ): Promise<JsonValue>;
    detach(
      name: string,
      spec: AttachSpec,
      flags?: object,
      options?: CallOptions,
    ): Promise<JsonValue>;
  };
  readonly share: {
    port(vm: string, port?: number, options?: CallOptions): Promise<JsonValue>;
    setPublic(vm: string, options?: CallOptions): Promise<JsonValue>;
    setPrivate(vm: string, options?: CallOptions): Promise<JsonValue>;
  };
}

/** How one action went. */
export interface ActionResult {
  readonly action: FleetAction;
  readonly ok: boolean;
  readonly error?: ExeErrorData;
  /** What the action turned into after a re-list (e.g. an ambiguous create adopted). */
  readonly note?: string;
}

/** The outcome of one reconcile run. Plain data. */
export interface ReconcileReport {
  readonly startedAt: number;
  readonly finishedAt: number;
  /** The VMs `ls` reported that belong to the fleet (desired or recorded). */
  readonly observed: readonly string[];
  readonly results: readonly ActionResult[];
  readonly drift: readonly FleetDrift[];
  /** Actions left for a later run (the per-run mutation cap was reached). */
  readonly deferred: number;
  /** True when nothing was left to do or wait for. */
  readonly converged: boolean;
  /** Set when the run could not observe the fleet (no action was taken). */
  readonly error?: ExeErrorData;
}

/** How a {@link FleetReconciler} behaves. */
export interface ReconcilerOptions extends PlanOptions {
  readonly runtime?: Pick<Runtime, "now">;
  /** At most this many API mutations per run; default 50. */
  readonly maxMutations?: number;
  /** List with `ls -l` (more fields, when the server reports them). */
  readonly longListing?: boolean;
  /**
   * Called before each mutation; returning false stops the run. The
   * Durable Object uses it to check that its lease is still held.
   */
  readonly beforeMutation?: (action: FleetAction) => boolean | Promise<boolean>;
}

const MUTATING = new Set<FleetAction["kind"]>([
  "create",
  "tag",
  "untag",
  "comment",
  "resize",
  "attach",
  "detach",
  "share-port",
  "share-visibility",
  "delete",
]);

/** Runs plans against a client and a store; see the module notes. */
export class FleetReconciler {
  readonly #client: FleetClient;
  readonly #store: FleetStore;
  readonly #options: ReconcilerOptions;
  readonly #runtime: Pick<Runtime, "now">;

  constructor(
    client: FleetClient,
    store: FleetStore,
    options: ReconcilerOptions = {},
  ) {
    this.#client = client;
    this.#store = store;
    this.#options = options;
    this.#runtime = options.runtime ?? defaultRuntime;
  }

  async #list(): Promise<VmSummary[]> {
    return [
      ...(await this.#client.ls({ long: this.#options.longListing })).vms,
    ];
  }

  async #record(entry: LedgerEntry, durable: boolean): Promise<void> {
    await this.#store.put(entry);
    if (durable) await this.#store.sync();
  }

  /** Plans without acting, from a fresh listing. */
  async plan(spec: FleetSpec): Promise<FleetPlan> {
    return planFleet(
      spec,
      await this.#list(),
      await this.#store.list(),
      this.#runtime.now(),
      this.#options,
    );
  }

  /** Observes, plans and acts once. Failures are reported, not thrown. */
  async reconcile(spec: FleetSpec): Promise<ReconcileReport> {
    const startedAt = this.#runtime.now();
    const issues = fleetSpecIssues(spec);
    if (issues.length > 0) throw new ExeInvalidRequestError(issues);
    const listed = await outcome(() => this.#list());
    if (!listed.ok) {
      return {
        startedAt,
        finishedAt: this.#runtime.now(),
        observed: [],
        results: [],
        drift: [],
        deferred: 0,
        converged: false,
        error: listed.error,
      };
    }
    const ledger = await this.#store.list();
    const plan = planFleet(
      spec,
      listed.value,
      ledger,
      startedAt,
      this.#options,
    );
    const records = new Map(ledger.map((entry) => [entry.name, entry]));
    const names = new Set([...plan.desired, ...records.keys()]);
    const results: ActionResult[] = [];
    const max = this.#options.maxMutations ?? 50;
    let mutations = 0;
    let deferred = 0;
    let stopped = false;
    for (const action of plan.actions) {
      if (MUTATING.has(action.kind)) {
        if (stopped || mutations >= max) {
          deferred++;
          continue;
        }
        if (
          this.#options.beforeMutation !== undefined &&
          !await this.#options.beforeMutation(action)
        ) {
          stopped = true;
          deferred++;
          continue;
        }
        mutations++;
      }
      results.push(await this.#apply(action, records));
    }
    const converged = deferred === 0 &&
      results.every((result) => result.ok && result.action.kind !== "await") &&
      results.filter((result) => MUTATING.has(result.action.kind)).length ===
        0 &&
      plan.drift.filter((item) => item.kind !== "unowned-extra").length === 0;
    return {
      startedAt,
      finishedAt: this.#runtime.now(),
      observed: listed.value.map((vm) => vm.vm_name).filter((name) =>
        names.has(name)
      ),
      results,
      drift: plan.drift,
      deferred,
      converged,
    };
  }

  #entry(records: Map<string, LedgerEntry>, name: string): LedgerEntry {
    const now = this.#runtime.now();
    return records.get(name) ?? {
      name,
      phase: "present",
      intentAt: now,
      updatedAt: now,
      attempts: 0,
      applied: NOTHING_APPLIED,
      lastError: null,
    };
  }

  async #update(
    records: Map<string, LedgerEntry>,
    name: string,
    change: Partial<LedgerEntry>,
    durable = false,
  ): Promise<void> {
    const next: LedgerEntry = {
      ...this.#entry(records, name),
      ...change,
      name,
      updatedAt: this.#runtime.now(),
    };
    records.set(name, next);
    await this.#record(next, durable);
  }

  async #setting(
    records: Map<string, LedgerEntry>,
    action: FleetAction,
    call: () => Promise<unknown>,
    applied: (current: AppliedState) => AppliedState,
  ): Promise<ActionResult> {
    const result = await outcome(call);
    const entry = this.#entry(records, action.vm);
    if (result.ok) {
      await this.#update(records, action.vm, {
        applied: applied(entry.applied),
        lastError: null,
      });
      return { action, ok: true };
    }
    await this.#update(records, action.vm, { lastError: result.error });
    return { action, ok: false, error: result.error };
  }

  async #apply(
    action: FleetAction,
    records: Map<string, LedgerEntry>,
  ): Promise<ActionResult> {
    const client = this.#client;
    const vm = action.vm;
    switch (action.kind) {
      case "await":
        return { action, ok: true };
      case "forget":
        records.delete(vm);
        await this.#store.delete(vm);
        return { action, ok: true };
      case "adopt":
        await this.#update(records, vm, {
          phase: "present",
          attempts: 0,
          applied: action.applied,
          lastError: null,
        });
        return { action, ok: true };
      case "create": {
        const previous = records.get(vm);
        await this.#update(records, vm, {
          phase: "creating",
          intentAt: this.#runtime.now(),
          attempts: (previous?.phase === "creating" ? previous.attempts : 0) +
            1,
          applied: previous?.applied ?? NOTHING_APPLIED,
        }, true);
        const created = await outcome(() => client.new(action.options));
        if (created.ok) {
          await this.#update(records, vm, {
            phase: "present",
            attempts: 0,
            applied: appliedByCreate(action.options),
            lastError: null,
          }, true);
          return { action, ok: true };
        }
        // Whatever went wrong, the VM may exist now (an ambiguous failure, or
        // an earlier attempt that did land). Look before deciding.
        const again = await outcome(() => this.#list());
        if (again.ok && again.value.some((item) => item.vm_name === vm)) {
          await this.#update(records, vm, {
            phase: "present",
            attempts: 0,
            applied: appliedByCreate(action.options),
            lastError: null,
          }, true);
          return {
            action,
            ok: true,
            note:
              `new failed (${created.error.kind}) but ${vm} exists; adopted`,
          };
        }
        await this.#update(records, vm, { lastError: created.error }, true);
        return { action, ok: false, error: created.error };
      }
      case "delete": {
        const previous = records.get(vm);
        await this.#update(records, vm, {
          phase: "deleting",
          intentAt: this.#runtime.now(),
          attempts: (previous?.phase === "deleting" ? previous.attempts : 0) +
            1,
        }, true);
        const removed = await outcome(() => client.rm(vm));
        if (removed.ok) {
          records.delete(vm);
          await this.#store.delete(vm);
          await this.#store.sync();
          return { action, ok: true };
        }
        const again = await outcome(() => this.#list());
        if (again.ok && !again.value.some((item) => item.vm_name === vm)) {
          records.delete(vm);
          await this.#store.delete(vm);
          await this.#store.sync();
          return {
            action,
            ok: true,
            note: `rm failed (${removed.error.kind}) but ${vm} is gone`,
          };
        }
        await this.#update(records, vm, { lastError: removed.error }, true);
        return { action, ok: false, error: removed.error };
      }
      case "tag":
        return await this.#setting(
          records,
          action,
          () => client.tag(vm, action.tags),
          (applied) => ({
            ...applied,
            tags: uniq([...applied.tags, ...action.tags]),
          }),
        );
      case "untag":
        return await this.#setting(
          records,
          action,
          () => client.untag(vm, action.tags),
          (applied) => ({
            ...applied,
            tags: diff(applied.tags, action.tags),
          }),
        );
      case "comment":
        return await this.#setting(
          records,
          action,
          () => client.comment(vm, action.text),
          (applied) => ({
            ...applied,
            comment: action.text,
          }),
        );
      case "resize":
        return await this.#setting(
          records,
          action,
          () =>
            client.resize(vm, {
              cpu: action.cpu,
              memory: action.memory,
              disk: action.disk,
            }),
          (applied) => ({
            ...applied,
            cpu: action.cpu ?? applied.cpu,
            memory: action.memory ?? applied.memory,
            disk: action.disk ?? applied.disk,
          }),
        );
      case "attach":
        return await this.#setting(
          records,
          action,
          () => client.integrations.attach(action.integration, `vm:${vm}`),
          (applied) => ({
            ...applied,
            integrations: uniq([...applied.integrations, action.integration]),
          }),
        );
      case "detach":
        return await this.#setting(
          records,
          action,
          () => client.integrations.detach(action.integration, `vm:${vm}`),
          (applied) => ({
            ...applied,
            integrations: diff(applied.integrations, [action.integration]),
          }),
        );
      case "share-port":
        return await this.#setting(
          records,
          action,
          () => client.share.port(vm, action.port),
          (applied) => ({
            ...applied,
            sharePort: action.port,
          }),
        );
      case "share-visibility":
        return await this.#setting(
          records,
          action,
          () =>
            action.public
              ? client.share.setPublic(vm)
              : client.share.setPrivate(vm),
          (applied) => ({ ...applied, sharePublic: action.public }),
        );
    }
    throw new Error(`unknown action ${(action as FleetAction).kind}`);
  }
}
