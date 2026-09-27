// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Table-driven policy tests: the requests a policy set must allow and
 * deny, and which policies must decide them.
 *
 * ```ts
 * import { assertCases } from "@celld/sec/cedar/testing";
 *
 * Deno.test("document policies", () => {
 *   const report = assertCases(authorizer, [
 *     { name: "owners edit", principal: alice, action: "edit", resource: plan, entities, expect: "allow", reasons: ["owners"] },
 *     { name: "strangers do not", principal: bob, action: "edit", resource: plan, entities, expect: "deny" },
 *   ]);
 *   // Policies no case exercised, to find dead or untested rules.
 *   console.log(report.unused);
 * });
 * ```
 *
 * @module
 */

import type { Authorizer, Decision, Request } from "./authorizer.ts";

/** One request and what must come of it. */
export interface PolicyCase extends Request {
  readonly name?: string;
  readonly expect: "allow" | "deny";
  /** The exact set of deciding policies, in any order. */
  readonly reasons?: readonly string[];
  /** Fail when the request is invalid, even for an expected deny (default true). */
  readonly valid?: boolean;
}

/** What went wrong with one case. */
export interface CaseFailure {
  readonly name: string;
  readonly problem: string;
  readonly decision: Decision;
}

/** The outcome of a table of cases. */
export interface CaseReport {
  readonly failures: readonly CaseFailure[];
  /** Policies and links that decided no case. */
  readonly unused: readonly string[];
}

/** Runs the cases with exactly their own entities (no loader). */
export function checkCases(
  authorizer: Authorizer,
  cases: readonly PolicyCase[],
): CaseReport {
  const failures: CaseFailure[] = [];
  const used = new Set<string>();
  cases.forEach((c, i) => {
    const name = c.name ?? `case ${i}`;
    const decision = authorizer.check(c);
    decision.reasons.forEach((id) => used.add(id));
    if ((c.valid ?? true) && decision.invalid !== undefined) {
      failures.push({
        name,
        decision,
        problem: `the request is invalid: ${
          decision.invalid.map((d) => d.message).join("; ")
        }`,
      });
      return;
    }
    if (decision.decision !== c.expect) {
      failures.push({
        name,
        decision,
        problem: `expected ${c.expect}, got ${decision.decision}`,
      });
      return;
    }
    if (c.reasons !== undefined) {
      const want = [...c.reasons].sort();
      const got = [...decision.reasons].sort();
      if (want.join("\0") !== got.join("\0")) {
        failures.push({
          name,
          decision,
          problem: `expected reasons [${want.join(", ")}], got [${
            got.join(", ")
          }]`,
        });
      }
    }
    for (const error of decision.errors) {
      failures.push({
        name,
        decision,
        problem: `policy ${error.policyId} errored: ${error.message}`,
      });
    }
  });
  const ids = [
    ...authorizer.policies.policies().map((p) => p.id),
    ...authorizer.policies.links().map((l) => l.id),
  ];
  return { failures, unused: ids.filter((id) => !used.has(id)).sort() };
}

/** {@link checkCases}, throwing one error listing every failure. */
export function assertCases(
  authorizer: Authorizer,
  cases: readonly PolicyCase[],
): CaseReport {
  const report = checkCases(authorizer, cases);
  if (report.failures.length > 0) {
    const lines = report.failures.map((f) => `  ${f.name}: ${f.problem}`);
    throw new Error(
      `${report.failures.length} of ${cases.length} policy cases failed:\n${
        lines.join("\n")
      }`,
    );
  }
  return report;
}
