// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Screening job applications with a composite score.
 *
 * `POST /screen` with `{"resume"}` asks two Scores and a Noul in one
 * request, then weighs them with `composite`: Score answers are normalised
 * to 0 to 1 (`normalizeScore`), a Noul counts as its probability, and the
 * result is a weighted mean whose parts say what each input contributed.
 * `mostLikelyLevel` names the single most probable level, where `score` is
 * the probability-weighted mean. Requests pin `jev-1.13.0`, since a
 * threshold like the 0.6 shortlist bar is tuned against one version.
 *
 * ```sh
 * buck2 run root//src/celld/api/jev/examples:scoring-dev
 * curl -sS -X POST localhost:9876/screen -H 'content-type: application/json' \
 *   -d '{"resume": "10 years of Python"}'
 * ```
 *
 * @module
 */

import {
  composite,
  JevClient,
  type JevEnv,
  mostLikelyLevel,
  noul,
  score,
} from "@celld/api/jev";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

const LEVELS = ["None", "Some", "Solid", "Expert"] as const;

const questions = {
  python: score("How much Python experience does the resume show?", LEVELS),
  design: score("How much systems design experience does it show?", LEVELS),
  leadership: noul("Has the candidate led a team?"),
};

const round = (value: number) => Math.round(value * 1000) / 1000;

const Resume = v.object({ resume: v.string().min(1).max(20_000) });

const app = router<JevEnv>({ auth: "none" });

app.post("/screen", { public: true, body: Resume }, async (c) => {
  const outcome = await JevClient.fromEnv(c.env, { model: "jev-1.13.0" })
    .tryAsk({ state: { resume: c.body.resume }, questions });
  if (!outcome.ok) return c.json(outcome.error, 502);
  const { answers } = outcome.result;
  const fit = composite(
    { python: 0.5, design: 0.3, leadership: 0.2 },
    answers,
  );
  return c.json({
    fit: round(fit.value),
    shortlist: fit.value >= 0.6,
    contributions: Object.fromEntries(
      Object.entries(fit.parts).map((
        [name, part],
      ) => [name, round(part.contribution)]),
    ),
    python: LEVELS[mostLikelyLevel(answers.python)],
    design: LEVELS[mostLikelyLevel(answers.design)],
  });
});

export default { fetch: app.fetch };
