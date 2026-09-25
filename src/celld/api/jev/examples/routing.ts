// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A banking assistant's intent router, gated on Jev's confidence.
 *
 * `POST /route` with `{"message"}` asks for the customer's intent and
 * whether they want a person. `gateChoice` turns the intent into a decision:
 * below the floor of 0.6 escalate whatever was chosen, act only when the
 * chosen option's own bar is met (higher for moving money or closing an
 * account), and review in between. `noulBand` reads the Noul as yes, no or
 * uncertain rather than rounding the middle away, and `topK` lists the
 * runner-up intents for the reviewer. Every result carries the confidence
 * it was decided on.
 *
 * The answers are model output over the customer's own words, which can
 * steer them (prompt injection): a high confidence is not authorization,
 * so moving money still needs the bank's own checks after an `act`. A
 * failed question is a 502 with only the error's kind. The route is
 * deliberately unauthenticated, for the demo: any caller spends the
 * TypeSafe key's quota. Bodies over 64 KiB are a 413.
 *
 * ```sh
 * buck2 run root//src/celld/api/jev/examples:routing-dev
 * curl -sS -X POST localhost:9876/route -H 'content-type: application/json' \
 *   -d '{"message": "Send $500 to Sam"}'
 * ```
 *
 * @module
 */

import {
  choice,
  gateChoice,
  JevClient,
  type JevEnv,
  noul,
  noulBand,
  topK,
} from "@celld/api/jev";
import { router } from "@celld/web/router";
import { v } from "@celld/sieve";

const questions = {
  intent: choice("What does this message to a bank's chat want to do?", [
    "check_balance",
    "transfer_money",
    "close_account",
    "other",
  ]),
  human: noul("Is the customer asking to speak to a person?"),
};

const Message = v.object({ message: v.string().min(1).max(4_000) });

// Deliberately unauthenticated demo: any caller can POST /route, spending the
// TypeSafe key's quota. A real deployment puts it behind an auth scheme.
const app = router<JevEnv>({ auth: "none", limits: { body: 64 * 1024 } });

app.post("/route", { public: true, body: Message }, async (c) => {
  // Routing a message twice costs a second evaluation and nothing else, so
  // the ask may be retried after a 429 or 5xx.
  const outcome = await JevClient.fromEnv(c.env).tryAsk({
    state: c.body.message,
    questions,
  }, { idempotent: true });
  if (!outcome.ok) {
    // Callers get the kind only; TypeSafe's text stays in the log.
    console.error("jev failed:", outcome.error.message);
    return c.json({ error: "upstream_error", kind: outcome.error.kind }, 502);
  }
  const { intent, human } = outcome.result.answers;
  const routed = gateChoice(intent, {
    floor: 0.6,
    act: { transfer_money: 0.85, close_account: 0.95 },
  });
  return c.json({
    ...routed,
    alternatives: topK(intent, 3).slice(1).map((ranked) => ranked.option),
    human: noulBand(human, { yes: 0.7, no: 0.3 }),
  });
});

export default { fetch: app.fetch };
