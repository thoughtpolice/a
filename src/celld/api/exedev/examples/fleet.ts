// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Desired-state VM fleets with the `ExeFleet` Durable Object.
 *
 * One object per fleet holds its spec (how many VMs, named `<prefix>-<n>`,
 * with which tags, comment, size and share settings) and a ledger of what it
 * created and applied. `reconcile()` lists the account, plans the
 * difference and applies it: creating, adopting a VM whose `new` answer was
 * lost, tagging, and with `prune` deleting VMs it owns that are no longer
 * wanted. Runs never overlap, and the ledger survives restarts, so a
 * repeated or interrupted run converges instead of creating twice.
 *
 * - `PUT /fleets/<name>` with a `FleetSpec` configures a fleet. The body is
 *   parsed by the library's `FleetSpec` schema (a strict object) before the
 *   Durable Object sees it, so a bad spec is a 400 with its issues by field.
 * - `GET /fleets/<name>/plan` is a dry run.
 * - `POST /fleets/<name>/reconcile` applies the plan and reports each action.
 * - `GET /fleets/<name>` returns the spec and ledger.
 *
 * ```sh
 * buck2 run root//src/celld/api/exedev/examples:fleet-dev
 * curl -sS -X PUT localhost:9876/fleets/web -H 'content-type: application/json' \
 *   -d '{"prefix": "web", "size": 2}'
 * curl -sS -X POST localhost:9876/fleets/web/reconcile
 * ```
 *
 * @module
 */

import type { ExeFleetApi } from "@celld/api/exedev/durable";
import { FleetSpec, type ReconcileReport } from "@celld/api/exedev/fleet";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

export { ExeFleet } from "@celld/api/exedev/durable";

interface Env {
  readonly FLEET: DurableObjectNamespace<ExeFleetApi>;
}

/** The report without timestamps: what each action did. */
function summary(report: ReconcileReport) {
  return {
    converged: report.converged,
    observed: report.observed,
    actions: report.results.map(({ action, ok, note, error }) => ({
      kind: action.kind,
      vm: action.vm,
      ok,
      ...(note === undefined ? {} : { note }),
      ...(error === undefined ? {} : { error: error.message }),
    })),
    drift: report.drift.map(({ vm, kind }) => ({ vm, kind })),
    ...(report.error === undefined ? {} : { error: report.error.message }),
  };
}

const ByName = v.object({ name: v.string().regex(/^[a-z0-9-]{1,63}$/) });

const app = router<Env>({ auth: "none" });

app.put("/fleets/:name", { params: ByName, body: FleetSpec }, async (c) => {
  const configured = await c.env.FLEET.getByName(c.params.name).configure(
    c.body,
  );
  return c.json(configured, configured.ok ? 200 : 400);
});

app.get("/fleets/:name", { params: ByName }, async (c) => {
  const { spec, ledger } = await c.env.FLEET.getByName(c.params.name).status();
  return c.json({
    spec,
    ledger: ledger.map(({ name, phase, applied }) => ({
      name,
      phase,
      tags: applied.tags,
    })),
  });
});

app.get("/fleets/:name/plan", { params: ByName }, async (c) => {
  const planned = await c.env.FLEET.getByName(c.params.name).plan();
  if (!planned.ok) return c.json({ error: planned.error.message }, 502);
  return c.json({
    desired: planned.plan.desired,
    actions: planned.plan.actions.map(({ kind, vm }) => ({ kind, vm })),
  });
});

app.post("/fleets/:name/reconcile", { params: ByName }, async (c) =>
  c.json(
    summary(await c.env.FLEET.getByName(c.params.name).reconcile()),
  ));

export default { fetch: app.fetch };
