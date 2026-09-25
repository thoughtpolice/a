// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Ticket triage: `POST /tickets` with `{"subject", "body"}` asks Jev three
 * questions about the ticket in one request (a Choice for the team, a Noul
 * for urgency, a Score for the customer's mood) and answers with where the
 * ticket goes. The answers are typed by the questions, so `team` below is
 * `"billing" | "technical" | "sales"` with no cast.
 *
 * The router checks the body against a sieve schema before the handler
 * runs: anything but a JSON `{subject, body}` of non-empty strings is a 400
 * (415 for a body that is not JSON) and nothing is sent to TypeSafe.
 * Failures come back from `tryAsk` as plain data, never as a thrown error,
 * and become a 502 carrying the error's kind.
 *
 * Run it against the fake TypeSafe server:
 *
 * ```sh
 * buck2 run root//src/celld/api/jev/examples:triage-dev
 * curl -sS -X POST localhost:9876/tickets -H 'content-type: application/json' \
 *   -d '{"subject": "Payouts failing", "body": "Since this morning..."}'
 * ```
 *
 * Add `-- --live --var TYPESAFE_API_KEY=...` to ask the real API instead.
 *
 * @module
 */

import {
  choice,
  JevClient,
  type JevEnv,
  mostLikelyLevel,
  noul,
  score,
} from "@celld/api/jev";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

const questions = {
  team: choice("Which team should handle this ticket?", {
    billing: "Payments, invoicing, refunds",
    technical: "Bugs, outages, integrations",
    sales: "Pricing, plans, new accounts",
  }),
  urgent: noul("Does the ticket convey urgency?", { true: "Time-sensitive" }),
  mood: score("How frustrated is the customer?", [
    "Calm",
    "Frustrated",
    "Very angry",
  ]),
};

const Ticket = v.object({
  subject: v.string().min(1).max(500),
  body: v.string().min(1).max(20_000),
});

const app = router<JevEnv>({ auth: "none" });

app.post("/tickets", { public: true, body: Ticket }, async (c) => {
  const outcome = await JevClient.fromEnv(c.env).tryAsk({
    state: { ticket: c.body },
    questions,
  });
  if (!outcome.ok) {
    const { kind, message } = outcome.error;
    return c.json({ error: message, kind }, 502);
  }
  const { answers, model } = outcome.result;
  return c.json({
    team: answers.team.choice,
    urgent: answers.urgent.noul >= 0.5,
    mood: questions.mood.criteria[mostLikelyLevel(answers.mood)],
    model,
  });
});

export default { fetch: app.fetch };
