// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Structured output: pulling an invoice out of free text.
 *
 * `POST /extract` with `{"text"}` asks for the `Invoice` schema below, a
 * `@celld/sieve` schema. One definition gives the strict JSON Schema sent as
 * the response format (sieve's `openai-strict` target), the TypeScript type
 * (`Infer<typeof Invoice>`), and the parse of the answer: every property is
 * required, an absent value is `null`, and extra properties (a strict
 * object), wrong types and non-JSON text are refused with their paths. The
 * request body is a sieve schema too, checked by the router.
 *
 * - a valid answer is a 200 with the typed invoice and a computed total;
 * - a model refusal is a 422 with its text;
 * - an answer that breaks the schema is a 502 listing the paths.
 *
 * ```sh
 * buck2 run root//src/celld/api/openai/examples:extract-dev
 * curl -sS -X POST localhost:9876/extract -H 'content-type: application/json' -d '{"text": "ACME, 2 widgets at $3"}'
 * ```
 *
 * The fake echoes when unscripted, which the schema refuses: script a turn
 * whose text is the JSON (see `extract.json`) to see a 200.
 *
 * @module
 */

import { GptClient, type GptEnv } from "@celld/api/openai";
import { router } from "@celld/router";
import { type Infer, v } from "@celld/sieve";

const Invoice = v.strictObject({
  vendor: v.string().describe("Who issued the invoice."),
  currency: v.enum(["USD", "EUR", "GBP"]),
  dueDate: v.iso.date().describe("ISO date, or null when none is given.")
    .nullable(),
  lines: v.array(v.strictObject({
    item: v.string(),
    quantity: v.int().min(1),
    unitPrice: v.number().min(0),
  })),
});
type Invoice = Infer<typeof Invoice>;

function total(invoice: Invoice): number {
  const cents = invoice.lines.reduce(
    (sum, line) => sum + Math.round(line.quantity * line.unitPrice * 100),
    0,
  );
  return cents / 100;
}

const app = router<GptEnv>({ auth: "none" });

app.post("/extract", {
  body: v.strictObject({ text: v.string().min(1) }),
  limits: { timeout: 600 },
}, async (c) => {
  const outcome = await GptClient.fromEnv(c.env).tryStructured({
    input: c.body.text,
    instructions: "Extract the invoice. Use null for anything not stated.",
    schema: Invoice,
    name: "invoice",
  }, { signal: c.signal });
  if (!outcome.ok) {
    const { kind, message, issues } = outcome.error;
    return c.json(
      { kind, error: message, issues },
      kind === "refusal" ? 422 : 502,
    );
  }
  const invoice = outcome.result.value;
  return c.json({ invoice, total: total(invoice) });
});

export default { fetch: app.fetch };
