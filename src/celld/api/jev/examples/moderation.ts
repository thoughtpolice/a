// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Comment moderation as a Workflow, with `askStep`.
 *
 * `POST /comments` with `{"id", "text"}` starts one `Moderation` run per
 * comment (the id is the instance id, so a repeated POST is refused rather
 * than asked twice). The run asks Jev whether the comment is fine, spam or
 * abusive; only abusive comments cost a second question, how severe they
 * are. Each question is an `askStep`: a `step.do` with a stable name, so
 * when the Workflow replays after a suspension or a retry it reuses the
 * stored answer instead of paying for it again. The verdict is written to
 * KV in a final step. `GET /comments/<id>` returns the run's status and
 * output.
 *
 * ```sh
 * buck2 run root//src/celld/api/jev/examples:moderation-dev
 * curl -sS -X POST localhost:9876/comments -H 'content-type: application/json' \
 *   -d '{"id": "c1", "text": "Nice post"}'
 * curl -sS localhost:9876/comments/c1
 * ```
 *
 * @module
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import { choice, JevClient, type JevEnv, score } from "@celld/api/jev";
import { askStep } from "@celld/api/jev/workflow";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

interface Comment {
  readonly id: string;
  readonly text: string;
}

interface Verdict {
  readonly verdict: "publish" | "hide" | "remove";
  readonly category: "fine" | "spam" | "abusive";
  readonly severity: string | null;
}

interface Env extends JevEnv {
  readonly MODERATION: Workflow<Comment, Verdict>;
  readonly VERDICTS: KVNamespace;
}

const category = choice("What kind of comment is this?", {
  fine: "On topic and civil",
  spam: "Advertising, scams or links unrelated to the post",
  abusive: "Insults, threats or harassment",
});

const severity = score("How severe is the abuse?", [
  "Rude",
  "Hostile",
  "Threatening",
]);

/** Classifies one comment and records what to do with it. */
export class Moderation extends WorkflowEntrypoint<Env, Comment> {
  async run(event: WorkflowEvent<Comment>, step: WorkflowStep) {
    const jev = JevClient.fromEnv(this.env);
    const { id, text } = event.payload;
    const first = await askStep(step, "category", jev, {
      state: text,
      questions: { category },
    });
    if (!first.ok) throw new Error(`jev: ${first.error.message}`);
    const kind = first.result.answers.category.choice;
    let verdict: Verdict = {
      verdict: kind === "fine" ? "publish" : "hide",
      category: kind,
      severity: null,
    };
    if (kind === "abusive") {
      const second = await askStep(step, "severity", jev, {
        state: text,
        questions: { severity },
      });
      if (!second.ok) throw new Error(`jev: ${second.error.message}`);
      const level = second.result.answers.severity.score;
      verdict = {
        verdict: level >= 1.5 ? "remove" : "hide",
        category: kind,
        severity: severity.criteria[Math.round(level)],
      };
    }
    await step.do("record", async () => {
      await this.env.VERDICTS.put(id, JSON.stringify(verdict));
    });
    return verdict;
  }
}

const NewComment = v.object({
  id: v.string().regex(
    /^[\w-]{1,64}$/,
    "must be 1 to 64 letters, digits, _ or -",
  ),
  text: v.string().min(1).max(10_000),
});

const ById = v.object({ id: v.string().regex(/^[\w-]{1,64}$/) });

const app = router<Env>({ auth: "none" });

app.post("/comments", { public: true, body: NewComment }, async (c) => {
  try {
    const instance = await c.env.MODERATION.create({
      id: c.body.id,
      params: c.body,
    });
    return c.json({ id: instance.id }, 202);
  } catch (error) {
    // The id is taken: this comment was already submitted.
    return c.json({ error: String(error) }, 409);
  }
});

app.get("/comments/:id", { public: true, params: ById }, async (c) => {
  const { id } = c.params;
  const instance = await c.env.MODERATION.get(id).catch(() => null);
  if (instance === null) return c.fail(404, "no such comment");
  const stored = await c.env.VERDICTS.get(id);
  return c.json({
    ...(await instance.status()),
    stored: stored === null ? null : JSON.parse(stored),
  });
});

export default { fetch: app.fetch };
