// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory celld test utilities for Orchestra integration tests.
 *
 * This module supplies the reusable fake runtime boundary: named Durable Object
 * namespaces, structured-clone storage, alarms, a purpose-built D1 projection,
 * request construction, and assertions. Test modules can therefore contain
 * scenarios only, while production object modules are exercised unchanged.
 *
 * @module
 */

import { EpochLedger } from "../epoch_ledger.ts";
import { EpochWorkflow } from "../epoch_workflow.ts";
import { Notifications } from "../notifications.ts";
import consumer from "../queue_consumer.ts";
import { AgentBroker } from "../agent_broker.ts";
import type {
  ArtifactRef,
  EpochIdentity,
  EpochState,
  Job,
  JobResult,
  Notification,
  OrchestraEnvironment,
  PlannedTest,
  TargetManifest,
} from "../model.ts";
import { routeRequest } from "../router.ts";
import { Repository } from "../repository.ts";

/** Narrows a test value and fails with a readable assertion message. */
export function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

/** Compares JSON-compatible test values structurally. */
export function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "values differ",
): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} != ${right}`);
}

/** Requires a rejected promise with the exact runtime error message. */
export async function assertRejects(
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof Error);
    assertEquals(error.message, message);
    return;
  }
  throw new Error(`expected rejection: ${message}`);
}

/** Minimal structured-clone storage and alarm implementation used by fake cells. */
export class MemoryStorage {
  /** Persisted values keyed by the same strings used by production objects. */
  private readonly values = new Map<string, unknown>();

  /** Most recently armed alarm time, or `null` when no alarm is active. */
  alarmAt: number | null = null;

  /** Reads an isolated clone of one stored value. */
  get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return Promise.resolve(
      value === undefined ? undefined : structuredClone(value) as T,
    );
  }

  /** Support atomic multi-key puts as well as single-key writes. */
  put<T>(
    key: string | Record<string, T> | Map<string, T>,
    value?: T,
  ): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {for (
        const [name, item] of key instanceof Map ? key : Object.entries(key)
      ) this.values.set(name, structuredClone(item));}
    return Promise.resolve();
  }
  /** Delete one key. */
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
  /** Ordered prefix listing used by the agent outbox. */
  list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(options.prefix ?? "")
        ).sort(([a], [b]) => a.localeCompare(b)).map((
          [k, v],
        ) => [k, structuredClone(v) as T]),
      ),
    );
  }
  /** Read the fake alarm's durable deadline. */
  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarmAt);
  }

  /** Models celld's explicit durability boundary; writes are already in memory. */
  sync(): Promise<void> {
    return Promise.resolve();
  }

  /** Records the next alarm occurrence. */
  setAlarm(at: number | Date): Promise<void> {
    this.alarmAt = Number(at);
    return Promise.resolve();
  }

  /** Clears the recorded alarm occurrence. */
  deleteAlarm(): Promise<void> {
    this.alarmAt = null;
    return Promise.resolve();
  }
}

/** Common surface required by the generic in-memory Durable Object namespace. */
export interface DurableObjectInstance {
  /** Fake celld state associated with this named instance. */
  readonly state: DurableObjectState;
}

/** Constructor signature shared by Orchestra's three Durable Object classes. */
export type DurableObjectConstructor<T extends DurableObjectInstance> = new (
  /** Fake celld state created for the named instance. */
  state: DurableObjectState,
  /** Recursively composed Orchestra test environment. */
  env: OrchestraEnvironment,
) => T;

/**
 * Model celld's RPC exception envelope, not a same-isolate thrown reference.
 * Standard Error subclasses survive cloning, custom prototypes do not, and
 * enumerable own fields travel separately. Uncloneable exceptions degrade to
 * an Error carrying the original message/name, as in __rpcErrOut. Arguments
 * that fail to clone before dispatch remain local errors and bypass this path.
 */
function rpcRejection(error: unknown): unknown {
  let reply: [unknown, Record<string, unknown>];
  try {
    reply = structuredClone([
      error,
      error instanceof Error ? { ...error, name: error.name } : {},
    ]);
  } catch {
    const properties = Object(error);
    reply = [
      new Error(String(Reflect.get(properties, "message") ?? error)),
      { name: String(Reflect.get(properties, "name") ?? "Error") },
    ];
  }
  const [received, properties] = reply;
  if (received instanceof Error) {
    Object.assign(received, properties, { remote: true });
    const local = new Error().stack;
    if (local !== undefined) {
      received.stack = received.name + ": " + received.message +
        local.slice(local.indexOf("\n"));
    }
  }
  return received;
}

/**
 * Named-object registry emulating the `getByName()` portion of a celld namespace.
 *
 * A name is instantiated at most once and retains its in-memory storage for the
 * test's lifetime, matching the identity behavior needed by integration flows.
 */
export class Namespace<T extends DurableObjectInstance> {
  /** Live object instances keyed by celld name; exposed for alarm tests. */
  readonly instances = new Map<string, T>();

  /** Creates a namespace for one object class and its recursively built environment. */
  constructor(
    /** Durable Object class instantiated for new names. */
    private readonly ObjectClass: DurableObjectConstructor<T>,
    /** Deferred environment provider that breaks namespace construction cycles. */
    private readonly environment: () => OrchestraEnvironment,
  ) {
  }

  /**
   * Return an asynchronous, clone-isolated native RPC stub. Cloning arguments
   * at invocation time and values on return models celld's data boundary; a
   * direct method call would incorrectly let save() mutate its caller's epoch.
   * DO dispatch deliberately allows any callable member, as celld 0.5.0 does.
   * #private helpers have no visible property and therefore cannot be called.
   */
  getByName(name: string): DurableObjectStub<T> {
    let instance = this.instances.get(name);
    if (instance === undefined) {
      const state = {
        storage: new MemoryStorage(),
      } as unknown as DurableObjectState;
      instance = new this.ObjectClass(state, this.environment());
      this.instances.set(name, instance);
    }
    const target = instance;
    return new Proxy({}, {
      get(_target, property) {
        if (property === "then" || typeof property !== "string") {
          return undefined;
        }
        if (property === "name") return name;
        return (...args: unknown[]) => {
          // Reject asynchronously even when cloning or method resolution fails.
          let copied: unknown[];
          try {
            copied = structuredClone(args);
          } catch (error) {
            return Promise.reject(error);
          }
          return Promise.resolve().then(async () => {
            try {
              const method = Reflect.get(target, property);
              if (typeof method !== "function") {
                throw new TypeError(`unknown object RPC method: ${property}`);
              }
              return structuredClone(
                await Reflect.apply(method, target, copied),
              );
            } catch (error) {
              throw rpcRejection(error);
            }
          });
        };
      },
    }) as DurableObjectStub<T>;
  }
}

/** Creates deterministic celld-shaped D1 execution metadata for the fake. */
function d1Meta(changes = 0): D1Meta {
  return {
    duration: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: 0,
    changes,
    changed_db: changes > 0,
    size_after: 0,
    served_by: "celld",
    served_by_region: "local",
    served_by_primary: true,
  };
}

/**
 * Builds a chainable prepared statement that delegates execution to `MemoryD1`.
 *
 * @param database Fake database that interprets the eventual statement.
 * @param sql SQL text emitted by the production history adapter.
 * @param values Current positional bindings, initially empty.
 */
function memoryStatement<Row extends D1Row>(
  database: MemoryD1,
  sql: string,
  values: D1Bindable[] = [],
): D1PreparedStatement<Row> {
  const statement = {
    bind: (...bound: D1Bindable[]) =>
      memoryStatement<Row>(database, sql, bound),
    all: () => database.execute<Row>(sql, values),
    run: () => database.execute<Row>(sql, values),
    async first(column?: string) {
      const result = await database.execute<Row>(sql, values);
      const row = result.results[0] ?? null;
      return column === undefined || row === null ? row : row[column];
    },
    async raw(options?: { columnNames?: boolean }) {
      const result = await database.execute<Row>(sql, values);
      const columns = result.results.length === 0
        ? []
        : Object.keys(result.results[0]);
      const rows = result.results.map((row) =>
        columns.map((column) => row[column])
      );
      return options?.columnNames ? [columns, ...rows] : rows;
    },
  };
  return statement as unknown as D1PreparedStatement<Row>;
}

/**
 * Purpose-built D1 fake for the history adapter's schema and query shapes.
 *
 * It does not attempt to parse SQL generally. Recognized statements update
 * relational maps, which verifies projection bindings and public history reads.
 */
export class MemoryD1 implements D1Database {
  /** Projected epoch summaries keyed by repository and epoch. */
  private readonly epochs = new Map<string, D1Row>();

  /** Projected test results keyed by repository, epoch, and test. */
  private readonly results = new Map<string, D1Row>();

  /** Number of distinct projected test results, used by integration assertions. */
  get resultCount(): number {
    return this.results.size;
  }

  /** Creates a fake prepared statement for later binding and execution. */
  prepare<Row extends D1Row = D1Row>(sql: string): D1PreparedStatement<Row> {
    return memoryStatement<Row>(this, sql);
  }

  /** Accepts lazy schema initialization; map allocation already supplies the schema. */
  exec(_sql: string): Promise<D1ExecResult> {
    return Promise.resolve({ count: 0, duration: 0 });
  }

  /** Executes statements in order, modeling the successful path of a D1 batch. */
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  /** Returns a primary-only fake D1 session. */
  withSession(_constraintOrBookmark?: string): D1DatabaseSession {
    return {
      prepare: <Row extends D1Row = D1Row>(sql: string) =>
        this.prepare<Row>(sql),
      batch: (statements: D1PreparedStatement[]) => this.batch(statements),
      getBookmark: () => "celld:primary",
    };
  }

  /** Mirrors celld's unsupported D1 dump operation. */
  dump(): Promise<ArrayBuffer> {
    return Promise.reject(new Error("dump is not implemented"));
  }

  /** Interprets the finite SQL statement set emitted by the history adapter. */
  execute<Row extends D1Row>(
    sql: string,
    values: D1Bindable[],
  ): Promise<D1Result<Row>> {
    const normalized = sql.replaceAll(/\s+/g, " ").trim();
    let rows: D1Row[] = [];
    let changes = 0;
    if (normalized.startsWith("INSERT INTO epochs")) {
      const row: D1Row = {
        repo: String(values[0]),
        epoch_id: String(values[1]),
        sequence: Number(values[2]),
        previous_revision: values[3] === null ? null : String(values[3]),
        revision: String(values[4]),
        queue: String(values[5]),
        state: String(values[6]),
        expected: Number(values[7]),
        completed: Number(values[8]),
        passed: Number(values[9]),
        failed: Number(values[10]),
        infra_failed: Number(values[11]),
        created_at: Number(values[12]),
        completed_at: values[13] === null ? null : Number(values[13]),
      };
      const key = `${row.repo}:${row.epoch_id}`;
      const previous = this.epochs.get(key);
      // Match indexEpoch's terminal-monotonic UPSERT: an abandoned Workflow
      // activity may finish after terminal publication and must not regress it.
      if (
        !previous ||
        !["complete", "failed"].includes(String(previous.state)) ||
        ["complete", "failed"].includes(String(row.state))
      ) {
        this.epochs.set(key, row);
        changes = 1;
      }
    } else if (normalized.startsWith("INSERT INTO test_results")) {
      const row: D1Row = {
        repo: String(values[0]),
        epoch_id: String(values[1]),
        test_id: String(values[2]),
        label: String(values[3]),
        outcome: String(values[4]),
        duration_ms: Number(values[5]),
        attempt: Number(values[6]),
        agent_id: String(values[7]),
        completed_at: Number(values[8]),
      };
      this.results.set(`${row.repo}:${row.epoch_id}:${row.test_id}`, row);
      changes = 1;
    } else if (normalized.startsWith("UPDATE epochs")) {
      const key = `${String(values[6])}:${String(values[7])}`;
      const row = this.epochs.get(key);
      if (row !== undefined) {
        Object.assign(row, {
          state: String(values[0]),
          completed: Number(values[1]),
          passed: Number(values[2]),
          failed: Number(values[3]),
          infra_failed: Number(values[4]),
          completed_at: values[5] === null ? null : Number(values[5]),
        });
        changes = 1;
      }
    } else if (normalized.startsWith("SELECT repo")) {
      const repo = String(values[0]);
      const limit = Number(values[1]);
      rows = [...this.epochs.values()]
        .filter((row) => row.repo === repo)
        .sort((left, right) => Number(right.sequence) - Number(left.sequence))
        .slice(0, limit);
    }
    return Promise.resolve({
      success: true,
      meta: d1Meta(changes),
      results: rows as Row[],
    });
  }
}

/** Byte-preserving R2 fake with create-only puts and deliberate corruption hooks. */
export class MemoryR2 {
  readonly values = new Map<string, Uint8Array>();
  async put(
    key: string,
    value: Uint8Array,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    if (options?.onlyIf && this.values.has(key)) return null;
    this.values.set(key, value.slice());
    return await this.get(key);
  }
  get(key: string): Promise<R2ObjectBody | null> {
    const value = this.values.get(key)?.slice();
    if (!value) return Promise.resolve(null);
    return Promise.resolve({
      key,
      size: value.length,
      etag: "fake",
      httpEtag: '"fake"',
      uploaded: new Date(0),
      arrayBuffer: () => Promise.resolve(value.buffer),
      text: () => Promise.resolve(new TextDecoder().decode(value)),
      json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(value))),
    } as R2ObjectBody);
  }
}

/** In-memory Queue retains notifications until consumer ack; send can fail once. */
export class MemoryQueue {
  readonly messages: Notification[] = [];
  failNext = false;
  send(message: Notification): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("injected Queue outage");
    }
    this.messages.push(structuredClone(message));
    return Promise.resolve();
  }
  metrics(): Promise<QueueMetrics> {
    return Promise.resolve(
      {
        backlogCount: this.messages.length,
        backlogBytes: 0,
        oldestMessageTimestamp: null,
      } as unknown as QueueMetrics,
    );
  }
}

/** Runtime state for one fake Workflow; step results survive replay of run(). */
interface MemoryRun {
  id: string;
  params: EpochIdentity;
  status: WorkflowInstanceStatus;
  output?: unknown;
  error?: { name: string; message: string };
  events: unknown[];
  waiting?: {
    kind: "sleep" | "event";
    resolve(value: WorkflowStepEvent): void;
    reject(error: Error): void;
  };
  steps: Map<string, unknown>;
  /** Terminal-only cleanup deadline; live instances do not expire. */
  expiresAt?: number;
}

/** celld's default and maximum terminal history retention, in milliseconds. */
export const WORKFLOW_RETENTION_MS = 30 * 86_400_000;

/** Parse the small duration contract used for fake terminal retention policies. */
function retentionMilliseconds(value?: WorkflowDuration): number {
  if (value === undefined) return WORKFLOW_RETENTION_MS;
  const units: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: WORKFLOW_RETENTION_MS,
    year: 365 * 86_400_000,
  };
  const match = typeof value === "string"
    ? /^\s*(\d+(?:\.\d+)?)\s+(second|minute|hour|day|week|month|year)s?\s*$/
      .exec(value)
    : null;
  const duration = typeof value === "number"
    ? value
    : match
    ? Number(match[1]) * units[match[2]]
    : NaN;
  if (
    !Number.isFinite(duration) || duration < 0 ||
    duration > WORKFLOW_RETENTION_MS
  ) {
    throw new Error("fake Workflow retention must be between zero and 30 days");
  }
  return duration;
}

/**
 * Execute Orchestra's Workflow against narrow step/event and lifecycle fakes.
 *
 * Terminal retention and stale-handle lookup match celld 0.5.0's boundary;
 * this is not a scheduler, retry engine, transaction model, or runtime emulator.
 * get() validates existence like celld's implicit status transaction, while
 * counters distinguish explicit client calls so unnecessary lookups are visible.
 */
export class MemoryWorkflows {
  /** Retained engine records, independently of Orchestra's epoch/D1/R2 history. */
  readonly runs = new Map<string, MemoryRun>();
  /** Number of actual run() starts, excluding duplicate batch requests. */
  creations = 0;
  /** Explicit client operations; reset individual fields around an assertion. */
  readonly calls = {
    get: 0,
    status: 0,
    createBatch: 0,
    sendEvent: 0,
    delete: 0,
  };
  /** One-shot binding outage, distinct from a legitimate missing instance. */
  failNextGet: Error | undefined;
  /** One-shot status RPC outage after get() has successfully returned a handle. */
  failNextStatus: Error | undefined;
  private clockOffset = 0;
  /** Inject a clock without advancing application deadlines or real timers. */
  constructor(
    private readonly environment: () => OrchestraEnvironment,
    private readonly now: () => number = Date.now,
  ) {}
  /** Move only engine-history time forward; ordinary Workflow waits stay manual. */
  advanceTime(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new TypeError("fake time advance must be finite and nonnegative");
    }
    this.clockOffset += milliseconds;
  }
  /** Read through expiry on every operation, including previously acquired handles. */
  private lookup(id: string): MemoryRun | undefined {
    const run = this.runs.get(id);
    if (
      run?.expiresAt !== undefined &&
      run.expiresAt <= this.now() + this.clockOffset
    ) {
      this.runs.delete(id);
      return undefined;
    }
    return run;
  }
  /** celld signals both never-created and expired/deleted history identically. */
  private requireRun(id: string): MemoryRun {
    const run = this.lookup(id);
    if (!run) throw new Error("WORKFLOW_ERROR: instance does not exist");
    return run;
  }
  /** Preserve an asynchronous RPC boundary and promise rejection for lookups. */
  private readRun(id: string): Promise<MemoryRun> {
    return Promise.resolve().then(() => this.requireRun(id));
  }
  /** Create a single ID, rejecting retained duplicates rather than replacing them. */
  async create(
    option: WorkflowInstanceCreateOptions<EpochIdentity>,
  ): Promise<WorkflowInstance> {
    const existing = option.id && this.lookup(option.id);
    if (existing) {
      throw new Error(
        `WORKFLOW_ERROR: instance ${
          JSON.stringify(option.id)
        } already exists with status ` +
          JSON.stringify(existing.status),
      );
    }
    const [instance] = await this.createBatch([option]);
    return instance;
  }
  /** Create only absent IDs, reusing expired/deleted IDs just like the engine. */
  async createBatch(
    options: WorkflowInstanceCreateOptions<EpochIdentity>[],
  ): Promise<WorkflowInstance[]> {
    this.calls.createBatch++;
    await Promise.resolve();
    const instances: WorkflowInstance[] = [];
    for (const option of options) {
      if (!option.id || !option.params || this.lookup(option.id)) continue;
      const successRetention = retentionMilliseconds(
        option.retention?.successRetention,
      );
      const errorRetention = retentionMilliseconds(
        option.retention?.errorRetention,
      );
      const run: MemoryRun = {
        id: option.id,
        params: structuredClone(option.params),
        status: "running",
        events: [],
        steps: new Map(),
      };
      this.runs.set(run.id, run);
      this.creations++;
      const step = {
        do: async (
          name: string,
          configOrCallback: unknown,
          callback?: () => Promise<unknown>,
        ) => {
          if (run.steps.has(name)) return structuredClone(run.steps.get(name));
          run.status = "running";
          const result = await (typeof configOrCallback === "function"
            ? configOrCallback as () => Promise<unknown>
            : callback!)();
          run.steps.set(name, structuredClone(result));
          return result;
        },
        waitForEvent: (_name: string, _options: unknown) => {
          if (run.events.length) {
            return Promise.resolve({ payload: run.events.shift() });
          }
          run.status = "waiting";
          return new Promise<WorkflowStepEvent>((resolve, reject) => {
            run.waiting = { kind: "event", resolve, reject };
          });
        },
        sleep: (name: string, _duration: unknown) => {
          if (run.steps.has(name)) {
            return Promise.resolve();
          }
          run.status = "waiting";
          return new Promise<void>((resolve, reject) => {
            run.waiting = {
              kind: "sleep",
              resolve: () => {
                run.steps.set(name, true);
                resolve();
              },
              reject,
            };
          });
        },
      } as unknown as WorkflowStep;
      const workflow = new EpochWorkflow(
        {} as WorkflowExecutionContext,
        this.environment(),
      );
      const event = {
        payload: run.params,
        instanceId: run.id,
        timestamp: new Date(0),
      } as WorkflowEvent<EpochIdentity>;
      void workflow.run(event, step).then((output) => {
        if (this.runs.get(run.id) !== run) {
          return;
        }
        run.status = "complete";
        run.output = output;
        run.expiresAt = this.now() + this.clockOffset + successRetention;
      })
        .catch((error) => {
          if (this.runs.get(run.id) !== run) {
            return;
          }
          run.status = "errored";
          run.error = {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          };
          run.expiresAt = this.now() + this.clockOffset + errorRetention;
        });
      instances.push(this.handle(run.id));
    }
    return instances;
  }
  /** Lookup never implicitly creates a Workflow. */
  async get(id: string): Promise<WorkflowInstance> {
    this.calls.get++;
    if (this.failNextGet) {
      const error = this.failNextGet;
      this.failNextGet = undefined;
      throw error;
    }
    await this.readRun(id);
    return this.handle(id);
  }
  /** Handles resolve the current record on every call, never a captured old run. */
  private handle(id: string): WorkflowInstance {
    return {
      id,
      status: async () => {
        this.calls.status++;
        if (this.failNextStatus) {
          const error = this.failNextStatus;
          this.failNextStatus = undefined;
          throw error;
        }
        const run = await this.readRun(id);
        return {
          status: run.status,
          rollback: null,
          ...(run.output === undefined
            ? {}
            : { output: structuredClone(run.output) }),
          ...(run.error === undefined
            ? {}
            : { error: structuredClone(run.error) }),
        };
      },
      delete: async () => {
        this.calls.delete++;
        await this.readRun(id);
        this.runs.delete(id);
      },
      sendEvent: async (event: WorkflowInstanceEvent) => {
        this.calls.sendEvent++;
        const run = await this.readRun(id);
        if (["complete", "errored", "terminated"].includes(run.status)) {
          throw new Error(
            `WORKFLOW_ERROR: cannot send an event to an instance with status ${
              JSON.stringify(run.status)
            }`,
          );
        }
        if (run.waiting?.kind === "event") {
          const waiting = run.waiting;
          run.waiting = undefined;
          run.status = "running";
          waiting.resolve({ payload: event.payload } as WorkflowStepEvent);
        } else run.events.push(structuredClone(event.payload));
        return Promise.resolve();
      },
    } as WorkflowInstance;
  }
  /** Force a durable timeout tick to prove progress without Queue result delivery. */
  timeout(): void {
    for (const run of this.runs.values()) {
      if (run.waiting) {
        const waiting = run.waiting;
        run.waiting = undefined;
        run.status = "running";
        if (waiting.kind === "sleep") waiting.resolve({} as WorkflowStepEvent);
        else waiting.reject(new Error("event timeout"));
      }
    }
  }
}

/** Typed fake runtime plus test-only fault injection/inspection seams. */
export interface FakeEnvironment extends OrchestraEnvironment {
  REPOSITORY: Namespace<Repository>;
  EPOCH: Namespace<EpochLedger>;
  JOB_QUEUE: Namespace<AgentBroker>;
  HISTORY: MemoryD1;
  ARTIFACTS: R2Bucket & MemoryR2;
  EVENTS: Queue<Notification> & MemoryQueue;
  EPOCH_RUNS: Workflow<EpochIdentity> & MemoryWorkflows;
}
/** Compose actual objects, Workflow, Queue consumer, and fake primitive bindings. */
export function fakeEnvironment(
  options: {
    /** Production polling is the default; event-specific tests opt in explicitly. */
    wakeMode?: "poll" | "events";
    /** Clock for engine-history retention only, independent of application time. */
    now?: () => number;
  } = {},
): FakeEnvironment {
  const env: FakeEnvironment = {
    WORKFLOW_WAKE_MODE: options.wakeMode ?? "poll",
    REPOSITORY: new Namespace(Repository, () => env),
    EPOCH: new Namespace(EpochLedger, () => env),
    JOB_QUEUE: new Namespace(AgentBroker, () => env),
    HISTORY: new MemoryD1(),
    ARTIFACTS: new MemoryR2() as R2Bucket & MemoryR2,
    EVENTS: new MemoryQueue() as Queue<Notification> & MemoryQueue,
    EPOCH_RUNS: new MemoryWorkflows(() => env, options.now) as
      & Workflow<EpochIdentity>
      & MemoryWorkflows,
  };
  return env;
}
/** Deliver one bounded notification batch through the production consumer/RPC. */
export async function flushEvents(env: FakeEnvironment): Promise<void> {
  const messages = env.EVENTS.messages.splice(0, 10);
  const notifications = new Notifications({} as ExecutionContext, env);
  await consumer.queue({
    queue: "orchestra-events",
    messages: messages.map((body, index) => ({
      id: String(index),
      timestamp: new Date(),
      body,
      attempts: 1,
      ack() {},
      retry() {
        env.EVENTS.messages.push(body);
      },
    })),
  } as unknown as MessageBatch<Notification>, { ORCHESTRA: notifications });
}
/** Let asynchronous activities reach their next durable wait; no real-time policy sleeps. */
export async function settle(env: FakeEnvironment, rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await flushEvents(env);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
/** Construct a public API request. */
export function api(
  path: string,
  method = "GET",
  body: unknown = undefined,
): Request {
  return new Request(`http://orchestra.test${path}`, {
    method,
    headers: body === undefined
      ? undefined
      : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Agent-visible flat claim with a numeric fencing token. */
export type TestClaim = Job & { lease_token: number; agent_id: string };
/** Small unchanged-lineage fixture for graph manifests. */
export function plannedTest(
  id = "alpha",
  platform = "linux-x86_64",
  changed = false,
): PlannedTest {
  return {
    id,
    test_key: platform + ":" + id,
    label: "root//tests:" + id,
    platform,
    rule_type: "rust_test",
    changed,
    selection_depth: changed ? 0 : 1,
    affected_dependency: changed ? null : "root//lib:changed",
    selection_reason: "fixture",
  };
}
/** Produce the same endpoint-bound manifest shape as the real tdutil adapter. */
export function testManifest(
  job: Extract<Job, { kind: "plan_epoch" }>,
  tests = [plannedTest()],
): TargetManifest {
  return {
    version: 2,
    digest: "fixture-manifest-" + job.revision,
    base_revision: job.base_revision,
    revision: job.revision,
    base_commit: job.base_revision ?? job.revision,
    revision_commit: job.revision,
    universe: ["root//..."],
    tests,
  };
}
/** Submit a milestone through the actual public ingress. */
export async function seed(
  env: FakeEnvironment,
  revision: string,
  policy?: unknown,
  repo = "repo",
): Promise<EpochIdentity> {
  const response = await routeRequest(
    api("/v1/repos/" + repo + "/epochs", "POST", { revision, policy }),
    env,
  );
  assert(response.ok, await response.clone().text());
  return await response.json();
}
/** Claim using the real external-agent capability protocol. */
export async function claim(
  env: FakeEnvironment,
  agent = "agent",
  platforms = ["linux-x86_64", "darwin-arm64"],
): Promise<TestClaim | null> {
  const response = await routeRequest(
    api("/v1/queues/default/claim", "POST", {
      agent_id: agent,
      platforms,
      kinds: ["plan_epoch", "run_tests", "plan_culprit"],
    }),
    env,
  );
  if (response.status === 204) return null;
  assert(response.ok, await response.clone().text());
  return await response.json();
}
/** Upload exact bytes then submit a result_ref with the accepted lease fence. */
export async function complete(
  env: FakeEnvironment,
  job: TestClaim,
  result: JobResult,
): Promise<{ response: Response; ref: ArtifactRef }> {
  const upload = await routeRequest(api("/v1/artifacts", "POST", result), env);
  assert(upload.ok, await upload.clone().text());
  const ref: ArtifactRef = await upload.json();
  const response = await routeRequest(
    api("/v1/queues/default/complete", "POST", {
      job_id: job.id,
      agent_id: job.agent_id,
      lease_token: job.lease_token,
      result_ref: ref,
    }),
    env,
  );
  return { response, ref };
}
/** Read the public epoch view, including queued repository reservations. */
export async function epochView(
  env: FakeEnvironment,
  id: EpochIdentity,
): Promise<EpochState> {
  const response = await routeRequest(
    api(`/v1/repos/${id.repo}/epochs/${id.epoch_id}`),
    env,
  );
  assert(response.ok, await response.clone().text());
  return await response.json();
}
/** Drain production Workflow/Queue/object logic using caller-controlled agent evidence. */
export async function finishEpoch(
  env: FakeEnvironment,
  id: EpochIdentity,
  result: (job: TestClaim) => JobResult,
): Promise<EpochState> {
  for (let round = 0; round < 100; round++) {
    await settle(env, 2);
    const epoch = await epochView(env, id);
    if (epoch.state === "complete" || epoch.state === "failed") return epoch;
    const job = await claim(env);
    if (job) {
      const completed = await complete(env, job, result(job));
      assert(completed.response.ok, await completed.response.clone().text());
    } else env.EPOCH_RUNS.timeout();
  }
  throw new Error("fixture epoch did not finish");
}
