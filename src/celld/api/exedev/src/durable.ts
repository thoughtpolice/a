// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable Objects for managing exe.dev from celld.
 *
 * {@link ExeFleet}: one instance per fleet. It stores a `FleetSpec` and the
 * fleet's ledger in its SQLite, runs the reconciler (on request or on an
 * alarm interval), and makes sure only one run acts at a time.
 *
 * Export it from the Worker and bind it, with `@celld/sec/ratelimit`'s
 * `RateLimitShard` to pace its calls:
 *
 * ```ts
 * export { ExeFleet } from "@celld/api/exedev/durable";
 * export { RateLimitShard } from "@celld/sec/ratelimit/durable";
 * ```
 *
 * ```python
 * celld.project(..., bindings = {"FLEET": "ExeFleet", "RATE_LIMITS": "RateLimitShard"})
 * ```
 *
 * `ExeFleet` builds its client with `ExeClient.fromEnv(env)` (so bind
 * `EXE_API_TOKEN` or `EXE_SSH_PRIVATE_KEY`), paced by `envLimiter(env)`: a
 * `durableLimiter` named `exedev` over `RATE_LIMITS` when that binding
 * exists, with the limits in the `EXE_LIMITS` var (JSON), under the limiter
 * key `EXE_LIMITER_KEY` (default `"default"`: use the SSH key's
 * fingerprint). Subclass it and override `createClient` to build the client
 * another way.
 *
 * Storage follows celld's rules: every statement is one synchronous
 * `sql.exec` whose cursor is consumed, and `storage.sync()` is awaited after
 * each intent write and before the external call it guards.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { ulid } from "@celld/core/ulid";
import type { RateLimitShardApi } from "@celld/sec/ratelimit";
import { ExeClient, type ExeEnv } from "./client.ts";
import { issuesFrom } from "./decode.ts";
import {
  type ExeErrorData,
  ExeInvalidRequestError,
  outcome,
} from "./errors.ts";
import {
  type FleetAction,
  type FleetClient,
  fleetIntervalIssues,
  type FleetPlan,
  FleetReconciler,
  FleetSpec,
  type FleetStore,
  type LedgerEntry,
  type ReconcileReport,
} from "./fleet.ts";
import type { Issue } from "./json.ts";
import { envLimiter } from "./limiter.ts";

/** The bindings {@link ExeFleet} reads. */
export interface ExeFleetEnv extends ExeEnv {
  /** Optional: the `RateLimitShard` objects that pace calls per SSH key. */
  readonly RATE_LIMITS?: DurableObjectNamespace<RateLimitShardApi>;
  /** The limiter key, the SSH key's fingerprint; default `"default"`. */
  readonly EXE_LIMITER_KEY?: string;
  /** Limits over the defaults, as JSON: `{"requestsPerSecond", "burst"}`. */
  readonly EXE_LIMITS?: string;
}

/** The current lease on a fleet's mutations. */
export interface FleetLease {
  readonly holder: string;
  readonly expiresAt: number;
}

/** What {@link ExeFleet.status} returns. */
export interface FleetStatus {
  readonly spec: FleetSpec | null;
  readonly intervalMs: number | null;
  readonly ledger: readonly LedgerEntry[];
  readonly lastReport: ReconcileReport | null;
  readonly lease: FleetLease | null;
  readonly alarm: number | null;
}

/** The RPC surface of {@link ExeFleet}, for typing its namespace binding. */
export interface ExeFleetApi {
  configure(
    spec: FleetSpec,
    options?: { readonly intervalMs?: number | null },
  ): Promise<
    { readonly ok: true } | {
      readonly ok: false;
      readonly issues: readonly Issue[];
    }
  >;
  reconcile(): Promise<ReconcileReport>;
  requestReconcile(): Promise<void>;
  plan(): Promise<
    { readonly ok: true; readonly plan: FleetPlan } | {
      readonly ok: false;
      readonly error: ExeErrorData;
    }
  >;
  status(): Promise<FleetStatus>;
}

/** How long a run's lease lasts between renewals. */
const LEASE_MS = 90_000;

/** The fleet Durable Object; see the module notes. */
export class ExeFleet<Env extends ExeFleetEnv = ExeFleetEnv>
  extends DurableObject<Env>
  implements ExeFleetApi {
  #running: Promise<ReconcileReport> | null = null;
  #queued: Promise<ReconcileReport> | null = null;
  #client: FleetClient | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS exe_fleet_spec (id INTEGER PRIMARY KEY CHECK (id = 1), spec TEXT NOT NULL, interval_ms INTEGER)",
    ).toArray();
    sql.exec(
      "CREATE TABLE IF NOT EXISTS exe_fleet_ledger (name TEXT PRIMARY KEY, entry TEXT NOT NULL)",
    ).toArray();
    sql.exec(
      "CREATE TABLE IF NOT EXISTS exe_fleet_lease (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    ).toArray();
    sql.exec(
      "CREATE TABLE IF NOT EXISTS exe_fleet_report (id INTEGER PRIMARY KEY CHECK (id = 1), report TEXT NOT NULL)",
    ).toArray();
  }

  /** The client the fleet uses. Override to build it another way. */
  protected createClient(): FleetClient {
    const env = this.env;
    return ExeClient.fromEnv(env, {
      limiter: envLimiter(env),
      limiterKey: env.EXE_LIMITER_KEY,
    });
  }

  #clientOnce(): FleetClient {
    this.#client ??= this.createClient();
    return this.#client;
  }

  #store(): FleetStore {
    const sql = this.ctx.storage.sql;
    return {
      list: () =>
        sql.exec<{ entry: string }>(
          "SELECT entry FROM exe_fleet_ledger ORDER BY name",
        ).toArray()
          .map((row) => JSON.parse(row.entry) as LedgerEntry),
      put: (entry) => {
        sql.exec(
          "INSERT INTO exe_fleet_ledger (name, entry) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET entry = excluded.entry",
          entry.name,
          JSON.stringify(entry),
        ).toArray();
      },
      delete: (name) => {
        sql.exec("DELETE FROM exe_fleet_ledger WHERE name = ?", name).toArray();
      },
      sync: () => this.ctx.storage.sync(),
    };
  }

  #spec(): { spec: FleetSpec; intervalMs: number | null } | null {
    const rows = this.ctx.storage.sql.exec<
      { spec: string; interval_ms: number | null }
    >(
      "SELECT spec, interval_ms FROM exe_fleet_spec WHERE id = 1",
    ).toArray();
    if (rows.length === 0) return null;
    return {
      spec: JSON.parse(rows[0].spec) as FleetSpec,
      intervalMs: rows[0].interval_ms,
    };
  }

  #lease(): FleetLease | null {
    const rows = this.ctx.storage.sql.exec<
      { holder: string; expires_at: number }
    >(
      "SELECT holder, expires_at FROM exe_fleet_lease WHERE id = 1",
    ).toArray();
    return rows.length === 0
      ? null
      : { holder: rows[0].holder, expiresAt: rows[0].expires_at };
  }

  #writeLease(holder: string, expiresAt: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO exe_fleet_lease (id, holder, expires_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at",
      holder,
      expiresAt,
    ).toArray();
  }

  /**
   * Stores the desired state (validated first). With `intervalMs`, an alarm
   * reconciles that often (from every 10 s to every 30 days); `null` stops
   * it; omitted keeps the current interval.
   */
  async configure(
    spec: FleetSpec,
    options: { readonly intervalMs?: number | null } = {},
  ): Promise<
    { readonly ok: true } | {
      readonly ok: false;
      readonly issues: readonly Issue[];
    }
  > {
    const parsed = FleetSpec.safeParse(spec);
    const issues: Issue[] = parsed.success
      ? []
      : issuesFrom(parsed.error.issues);
    if (options.intervalMs !== undefined && options.intervalMs !== null) {
      issues.push(...fleetIntervalIssues(options.intervalMs));
    }
    if (!parsed.success || issues.length > 0) return { ok: false, issues };
    const interval = options.intervalMs === undefined
      ? this.#spec()?.intervalMs ?? null
      : options.intervalMs;
    this.ctx.storage.sql.exec(
      "INSERT INTO exe_fleet_spec (id, spec, interval_ms) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET spec = excluded.spec, interval_ms = excluded.interval_ms",
      JSON.stringify(parsed.data),
      interval,
    ).toArray();
    await this.ctx.storage.sync();
    if (interval === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Date.now() + interval);
    return { ok: true };
  }

  /**
   * Reconciles now and returns the report. Concurrent calls do not overlap:
   * a call during a run waits for one more run after it, shared by every
   * caller that arrived meanwhile, so each caller's report reflects state no
   * older than its call.
   */
  reconcile(): Promise<ReconcileReport> {
    if (this.#running === null) {
      this.#running = this.#run().finally(() => {
        this.#running = null;
      });
      return this.#running;
    }
    this.#queued ??= this.#running.then(() => {
      this.#queued = null;
      return this.reconcile();
    }, () => {
      this.#queued = null;
      return this.reconcile();
    });
    return this.#queued;
  }

  /** Asks for a reconcile soon (an alarm now) without waiting for it. */
  async requestReconcile(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** A dry run: the plan from a fresh listing, without acting. */
  async plan(): Promise<
    { readonly ok: true; readonly plan: FleetPlan } | {
      readonly ok: false;
      readonly error: ExeErrorData;
    }
  > {
    const stored = this.#spec();
    if (stored === null) {
      return {
        ok: false,
        error: new ExeInvalidRequestError([{
          path: ["spec"],
          message: "not configured",
        }]).toJSON(),
      };
    }
    const reconciler = new FleetReconciler(this.#clientOnce(), this.#store());
    const planned = await outcome(() => reconciler.plan(stored.spec));
    return planned.ok
      ? { ok: true, plan: planned.value }
      : { ok: false, error: planned.error };
  }

  /** The spec, ledger, last report, lease and alarm. */
  async status(): Promise<FleetStatus> {
    const stored = this.#spec();
    const reports = this.ctx.storage.sql.exec<{ report: string }>(
      "SELECT report FROM exe_fleet_report WHERE id = 1",
    ).toArray();
    return {
      spec: stored?.spec ?? null,
      intervalMs: stored?.intervalMs ?? null,
      ledger: this.#store().list() as LedgerEntry[],
      lastReport: reports.length === 0
        ? null
        : JSON.parse(reports[0].report) as ReconcileReport,
      lease: this.#lease(),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  /** Reconciles, then schedules the next run when an interval is set. */
  async alarm(): Promise<void> {
    try {
      await this.reconcile();
    } finally {
      const interval = this.#spec()?.intervalMs ?? null;
      if (interval !== null && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + interval);
      }
    }
  }

  async #run(): Promise<ReconcileReport> {
    const stored = this.#spec();
    const now = Date.now();
    if (stored === null) {
      return this.#finish({
        startedAt: now,
        finishedAt: now,
        observed: [],
        results: [],
        drift: [],
        deferred: 0,
        converged: false,
        error: new ExeInvalidRequestError([{
          path: ["spec"],
          message: "not configured",
        }]).toJSON(),
      });
    }
    const current = this.#lease();
    if (current !== null && current.expiresAt > now) {
      // A run on an earlier instance of this object took the lease and has
      // not released it; it may still be acting, so do not overlap it.
      return this.#finish({
        startedAt: now,
        finishedAt: now,
        observed: [],
        results: [],
        drift: [],
        deferred: 0,
        converged: false,
        error: new ExeInvalidRequestError([{
          path: ["lease"],
          message: `another run holds the lease until ${
            Temporal.Instant.fromEpochMilliseconds(current.expiresAt)
              .toString({ fractionalSecondDigits: 3 })
          }`,
        }]).toJSON(),
      });
    }
    const holder = ulid();
    this.#writeLease(holder, now + LEASE_MS);
    await this.ctx.storage.sync();
    const reconciler = new FleetReconciler(this.#clientOnce(), this.#store(), {
      beforeMutation: (_action: FleetAction) => {
        const lease = this.#lease();
        if (lease === null || lease.holder !== holder) return false;
        this.#writeLease(holder, Date.now() + LEASE_MS);
        return true;
      },
    });
    try {
      const report = await reconciler.reconcile(stored.spec);
      return this.#finish(report);
    } finally {
      if (this.#lease()?.holder === holder) {
        this.ctx.storage.sql.exec(
          "DELETE FROM exe_fleet_lease WHERE id = 1 AND holder = ?",
          holder,
        ).toArray();
        await this.ctx.storage.sync();
      }
    }
  }

  #finish(report: ReconcileReport): ReconcileReport {
    this.ctx.storage.sql.exec(
      "INSERT INTO exe_fleet_report (id, report) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET report = excluded.report",
      JSON.stringify(report),
    ).toArray();
    return report;
  }
}
