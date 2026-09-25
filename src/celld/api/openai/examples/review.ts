// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Blue Team endpoints: a security review of a diff, and alert triage.
 *
 * - `POST /review` with `{"diff", "context"?}` runs `securityReview`: the
 *   diff is split into chunks when large, each chunk is reviewed against
 *   the strict `SecurityReview` schema, and the findings are merged,
 *   duplicates dropped. The response keeps findings of medium severity and
 *   up, most severe first, and says whether the change should be blocked.
 * - `POST /triage` with `{"alert", "context"?}` runs `triage`, which answers
 *   the `Triage` schema: verdict, severity, priority and next steps.
 *
 * Both reason at high effort by default; the prompts are exported
 * (`SECURITY_REVIEW_INSTRUCTIONS`, ...) and meant to be replaced.
 *
 * ```sh
 * buck2 run root//src/celld/api/openai/examples:review-dev
 * git diff | jq -Rs '{diff: .}' | curl -sS -X POST localhost:9876/review -H 'content-type: application/json' -d @-
 * ```
 *
 * @module
 */

import { GptClient, type GptEnv, GptError } from "@celld/api/openai";
import { atLeast, securityReview, triage } from "@celld/api/openai/blueteam";
import { middleware, router } from "@celld/router";
import { v } from "@celld/sieve";

/** A model failure is a 502 carrying its kind; anything else is the router's 500. */
const gptErrors = middleware(async (_c, next) => {
  try {
    return await next();
  } catch (error) {
    if (!(error instanceof GptError)) throw error;
    const { kind, message } = error.toJSON();
    return Response.json({ kind, error: message }, { status: 502 });
  }
});

const app = router<GptEnv>({
  auth: "none",
  // A review reasons at high effort, chunk by chunk: minutes, not seconds.
  limits: { body: 4 * 1024 * 1024, timeout: 900 },
});

app.post("/review", {
  body: v.strictObject({
    diff: v.string().min(1),
    context: v.string().optional(),
  }),
  use: [gptErrors],
}, async (c) => {
  const { result, findings, chunks } = await securityReview(
    GptClient.fromEnv(c.env),
    c.body,
    { call: { signal: c.signal } },
  );
  const reported = atLeast(findings, "medium");
  return c.json({
    summary: result.summary,
    chunks,
    block: reported.some((finding) =>
      finding.severity === "critical" || finding.severity === "high"
    ),
    findings: reported.map((finding) => ({
      title: finding.title,
      severity: finding.severity,
      cwe: finding.cwe,
      where: `${finding.location.path}:${finding.location.startLine ?? "?"}`,
      confidence: finding.confidence,
      fix: finding.remediation,
    })),
  });
});

app.post("/triage", {
  body: v.strictObject({
    alert: v.string().min(1),
    context: v.string().optional(),
  }),
  use: [gptErrors],
}, async (c) => {
  const { triage: verdict } = await triage(
    GptClient.fromEnv(c.env),
    c.body,
    { call: { signal: c.signal } },
  );
  return c.json(verdict);
});

export default { fetch: app.fetch };
