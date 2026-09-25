// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { JevClient, noul } from "@celld/api/jev";
import {
  fakeBody,
  fakeFetch,
  jsonResponse,
  virtualRuntime,
} from "@celld/api/jev/testing";
import { askStep, DEFAULT_STEP_CONFIG } from "@celld/api/jev/workflow";

/**
 * A step runner with the replay property that matters here: a name that
 * already succeeded returns its stored (structured-cloned) result, and a
 * throwing callback is retried up to the config's limit.
 */
function fakeStep() {
  const stored = new Map<string, unknown>();
  const log: string[] = [];
  const step = {
    async do(
      name: string,
      config: WorkflowStepConfig,
      callback: (ctx: unknown) => Promise<unknown>,
    ) {
      if (stored.has(name)) {
        log.push(`replay ${name}`);
        return structuredClone(stored.get(name));
      }
      const limit = config.retries?.limit ?? 0;
      for (let attempt = 1;; attempt++) {
        try {
          log.push(`run ${name} #${attempt}`);
          const result = await callback({});
          stored.set(name, structuredClone(result));
          return result;
        } catch (error) {
          log.push(`threw ${(error as Error).name}`);
          if (attempt > limit) throw error;
        }
      }
    },
  } as unknown as WorkflowStep;
  return { step, log };
}

function client(statuses: number[]) {
  const fetch = fakeFetch(({ body }, index) =>
    index < statuses.length
      ? jsonResponse({ detail: "no" }, { status: statuses[index] })
      : jsonResponse(fakeBody(body.questions))
  );
  const jev = new JevClient({
    apiKey: "k",
    fetch,
    runtime: virtualRuntime(),
    retry: { maxRetries: 0 },
  });
  return { jev, fetch };
}

const request = { state: "s", questions: { urgent: noul("Urgent?") } };

Deno.test("an answered step is stored and replayed, not asked again", async () => {
  const { step, log } = fakeStep();
  const { jev, fetch } = client([]);
  const first = await askStep(step, "triage", jev, request);
  const replayed = await askStep(step, "triage", jev, request);
  assert(first.ok && replayed.ok, "both ok");
  assertEquals(replayed.result.answers.urgent.noul, 1);
  assertEquals(replayed, first);
  assertEquals(fetch.calls.length, 1);
  assertEquals(log, ["run triage #1", "replay triage"]);
});

Deno.test("transient failures throw so the step's durable retries run", async () => {
  const { step, log } = fakeStep();
  const { jev, fetch } = client([529, 503]);
  const outcome = await askStep(step, "triage", jev, request);
  assert(outcome.ok, "recovered");
  assertEquals(fetch.calls.length, 3);
  assertEquals(log, [
    "run triage #1",
    "threw JevError(overloaded)",
    "run triage #2",
    "threw JevError(server)",
    "run triage #3",
  ]);
});

Deno.test("permanent failures are stored as plain data", async () => {
  const { step, log } = fakeStep();
  const { jev } = client([401]);
  const outcome = await askStep(step, "triage", jev, request);
  assert(!outcome.ok, "failed");
  assertEquals([outcome.error.kind, outcome.error.status], [
    "authentication",
    401,
  ]);
  assertEquals(log, ["run triage #1"]);
});

Deno.test("the default step policy outlasts the client's own budget", () => {
  assertEquals(DEFAULT_STEP_CONFIG.timeout, "2 minutes");
  assertEquals(DEFAULT_STEP_CONFIG.retries?.limit, 5);
});
