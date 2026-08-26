// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Durable scheduling contracts for the real EpochWorkflow entrypoint. A narrow
 * WorkflowStep fake replays structured-cloned activity checkpoints and advances
 * virtual time on suspension; domain reconciliation itself is tested separately.
 * These tests cover day-long waiting, independent progress limits, old checkpoint
 * replay, and deadline-safe event fallbacks without sleeping or changing a repo.
 * @module
 */
import { EpochWorkflow } from "./epoch_workflow.ts";
import type { EpochIdentity, OrchestraEnvironment } from "./model.ts";
import { assert, assertEquals } from "./util/testing.ts";
import type { Progress } from "./util/workflow.ts";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const ID: EpochIdentity = {
  repo: "schedule-test",
  epoch_id: "epoch-one",
  workflow_id: "schedule-test-one",
};
const ACTIVITY_OPTIONS = {
  retries: { limit: 5, delay: "1 second", backoff: "exponential" },
  timeout: "5 minutes",
};

/** Checkpoints written before scheduling metadata existed remain replayable. */
type Checkpoint = Progress | Pick<Progress, "done" | "wait" | "state">;

/** A current activity checkpoint, with its timing supplied by the activity. */
function checkpoint(now: number, updates: Partial<Progress> = {}): Progress {
  return {
    done: false,
    wait: true,
    state: "running",
    changed: false,
    observed_at: now,
    deadline_at: DAY,
    ...updates,
  };
}

/** Convert only the millisecond/second/minute forms used by this Workflow. */
function milliseconds(duration: WorkflowDuration): number {
  if (typeof duration === "number") return duration;
  const match = /^(\d+(?:\.\d+)?) (second|minute)s?$/.exec(duration);
  assert(match, "unexpected Workflow duration: " + duration);
  return Number(match[1]) * (match[2] === "minute" ? 60_000 : 1_000);
}

/** Recorded durable suspension, retaining the actual wire-format duration. */
interface Suspension {
  name: string;
  duration: WorkflowDuration;
  milliseconds: number;
}

/**
 * Simulate the engine boundary, not Orchestra's scheduling algorithm. Each
 * reconciliation receives an injected cached result; record-failure is recorded
 * as an activity, with domain failure/persistence exercised by workflow_test.ts.
 */
function harness(
  next: (round: number, now: number) => Checkpoint,
  options: {
    wakeMode?: "poll" | "events";
    now?: number;
    eventTimeout?: boolean;
    failureState?: "failed" | "complete";
  } = {},
) {
  const trace = {
    now: options.now ?? 0,
    reconciliations: 0,
    failureActivities: 0,
    sleeps: [] as Suspension[],
    events: [] as Suspension[],
  };
  const step = {
    do: (
      name: string,
      configOrCallback: unknown,
      callback?: () => Promise<unknown>,
    ) =>
      Promise.resolve().then(() => {
        if (name === "record-failure") {
          assert(typeof configOrCallback === "function");
          trace.failureActivities++;
          return options.failureState ?? "failed";
        }
        const round = trace.reconciliations++;
        assertEquals(name, "reconcile-" + round);
        assertEquals(configOrCallback, ACTIVITY_OPTIONS);
        assert(typeof callback === "function");
        return structuredClone(next(round, trace.now));
      }),
    sleep: (name: string, duration: WorkflowDuration) => {
      assertEquals(name, "poll-" + (trace.reconciliations - 1));
      const ms = milliseconds(duration);
      assert(ms > 0, "sleep must have a positive duration");
      trace.sleeps.push({ name, duration, milliseconds: ms });
      trace.now += ms;
      return Promise.resolve();
    },
    waitForEvent: (
      name: string,
      eventOptions: WorkflowWaitForEventOptions,
    ) => {
      assertEquals(name, "wake-" + (trace.reconciliations - 1));
      assertEquals(eventOptions.type, "result");
      assert(eventOptions.timeout !== undefined);
      const ms = milliseconds(eventOptions.timeout);
      assert(ms >= 1_000, "celld rejects subsecond event timeouts");
      trace.events.push({
        name,
        duration: eventOptions.timeout,
        milliseconds: ms,
      });
      if (options.eventTimeout) {
        trace.now += ms;
        return Promise.reject(new Error("event timeout"));
      }
      return Promise.resolve({
        payload: {},
        timestamp: new Date(trace.now),
        type: "result",
      });
    },
  } as unknown as WorkflowStep;
  const workflow = new EpochWorkflow(
    {} as WorkflowExecutionContext,
    { WORKFLOW_WAKE_MODE: options.wakeMode ?? "poll" } as OrchestraEnvironment,
  );
  return {
    trace,
    run: () =>
      workflow.run({
        payload: ID,
        instanceId: ID.workflow_id,
        workflowName: "EpochWorkflow",
        timestamp: new Date(0),
      }, step),
  };
}

Deno.test("Workflow polling backs off and only domain progress resets it", async () => {
  const cached: Partial<Progress>[] = [
    {},
    {},
    {},
    { changed: true },
    {},
    {},
    { wait: false, changed: true },
    {},
    {},
    { done: true, wait: false, state: "complete" },
  ];
  const run = harness((round, now) => checkpoint(now, cached[round]));
  assertEquals(await run.run(), { ...ID, state: "complete" });
  assertEquals(run.trace.sleeps.map((sleep) => sleep.milliseconds), [
    1_000,
    2_000,
    4_000,
    1_000,
    1_000,
    2_000,
    1_000,
    2_000,
  ]);
  assertEquals(run.trace.failureActivities, 0);
});

Deno.test("Workflow polling completes healthy work after the former 2.8-hour limit", async () => {
  const run = harness((_round, now) =>
    checkpoint(
      now,
      now >= 4 * HOUR ? { done: true, wait: false, state: "complete" } : {},
    )
  );
  assertEquals(await run.run(), { ...ID, state: "complete" });
  assert(run.trace.now >= 4 * HOUR);
  assert(run.trace.now < 4 * HOUR + 30_000);
  assertEquals(
    run.trace.sleeps.slice(0, 7).map((sleep) => sleep.milliseconds),
    [
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
    ],
  );
  assertEquals(run.trace.failureActivities, 0);
});

Deno.test("Workflow idle polling reaches the full day without activity-budget failure", async () => {
  const run = harness((_round, now) => checkpoint(now));
  const output = await run.run() as { state: string; error: string };
  assertEquals(output.state, "failed");
  assert(output.error.includes("deadline"));
  assertEquals(run.trace.now, DAY);
  assertEquals(run.trace.failureActivities, 1);
  assert(run.trace.reconciliations < 3_000);
  assert(run.trace.sleeps.every((sleep) => sleep.milliseconds <= 30_000));
  const last = run.trace.sleeps.at(-1)!;
  assert(last.milliseconds < 30_000, "last poll is capped to the deadline");
});

Deno.test("Workflow replays more than 10,000 old idle polling checkpoints", async () => {
  const run = harness((round, now) =>
    round < 10_050
      ? { done: false, wait: true, state: "running" }
      : checkpoint(now, { done: true, wait: false, state: "complete" })
  );
  assertEquals(await run.run(), { ...ID, state: "complete" });
  assertEquals(run.trace.reconciliations, 10_051);
  assertEquals(run.trace.now, 10_050_000);
  assert(run.trace.sleeps.every((sleep) => sleep.milliseconds === 1_000));
  assertEquals(run.trace.failureActivities, 0);
});

Deno.test("Workflow event notifications do not consume the immediate-activity budget", async () => {
  const run = harness(
    (round, now) =>
      checkpoint(
        now,
        round < 10_050 ? {} : { done: true, wait: false, state: "complete" },
      ),
    { wakeMode: "events" },
  );
  assertEquals(await run.run(), { ...ID, state: "complete" });
  assertEquals(run.trace.events.length, 10_050);
  assert(run.trace.events.every((event) => event.milliseconds === 60_000));
  assertEquals(run.trace.now, 0);
  assertEquals(run.trace.failureActivities, 0);
});

Deno.test("Workflow still bounds immediate reconciliation without waiting", async () => {
  const run = harness((_round, now) =>
    checkpoint(now, { wait: false, changed: true })
  );
  const output = await run.run() as { state: string; error: string };
  assertEquals(output.state, "failed");
  assert(output.error.includes("budget"));
  assertEquals(run.trace.reconciliations, 10_000);
  assertEquals(run.trace.sleeps.length, 0);
  assertEquals(run.trace.failureActivities, 1);
});

Deno.test("Workflow waiting does not reset the cumulative immediate-activity guard", async () => {
  const run = harness((round, now) =>
    checkpoint(now, { wait: round % 2 === 1, changed: round % 2 === 0 })
  );
  const output = await run.run() as { state: string; error: string };
  assertEquals(output.state, "failed");
  assertEquals(
    output.error,
    "Workflow immediate reconciliation budget exhausted",
  );
  assertEquals(run.trace.reconciliations, 19_999);
  assertEquals(run.trace.sleeps.length, 9_999);
  assertEquals(run.trace.failureActivities, 1);
});

Deno.test("Workflow total safety guard bounds frozen-clock event storms", async () => {
  const run = harness((_round, now) => checkpoint(now), {
    wakeMode: "events",
  });
  const output = await run.run() as { state: string; error: string };
  assertEquals(output.state, "failed");
  assertEquals(output.error, "Workflow total activity safety limit exhausted");
  assertEquals(run.trace.reconciliations, 10_000 + DAY / 1_000 + 1);
  assertEquals(run.trace.failureActivities, 1);
});

Deno.test("Workflow replay uses only recorded timestamps, including legacy checkpoints", async () => {
  const cached: Checkpoint[] = [
    { done: false, wait: true, state: "planning" },
    checkpoint(1_000),
    checkpoint(2_000),
    checkpoint(4_000, { changed: true }),
    checkpoint(5_000),
    checkpoint(6_000, { done: true, wait: false, state: "complete" }),
  ];
  const originalNow = Date.now;
  Date.now = () => {
    throw new Error("the Workflow wrapper must not consult the replay clock");
  };
  try {
    const first = harness((round) => cached[round]);
    const replay = harness((round) => cached[round], { now: 2 * DAY });
    assertEquals(await first.run(), { ...ID, state: "complete" });
    assertEquals(await replay.run(), { ...ID, state: "complete" });
    assertEquals(replay.trace.sleeps, first.trace.sleeps);
    assertEquals(first.trace.failureActivities, 0);
    assertEquals(replay.trace.failureActivities, 0);
  } finally {
    Date.now = originalNow;
  }
});

Deno.test("Workflow's first expired checkpoint fails after cached pre-downtime waits", async () => {
  const run = harness((round) =>
    round === 0
      ? { done: false, wait: true, state: "running" }
      : checkpoint(DAY + HOUR)
  );
  const output = await run.run() as { state: string; error: string };
  assertEquals(output.state, "failed");
  assert(output.error.includes("deadline"));
  assertEquals(run.trace.reconciliations, 2);
  assertEquals(run.trace.sleeps.map((sleep) => sleep.milliseconds), [1_000]);
  assertEquals(run.trace.failureActivities, 1);
});

for (const wakeMode of ["poll", "events"] as const) {
  Deno.test(`Workflow ${wakeMode} preserves terminal success after its deadline`, async () => {
    const run = harness(
      () => checkpoint(2 * DAY, { done: true, wait: false, state: "complete" }),
      {
        wakeMode,
      },
    );
    assertEquals(await run.run(), { ...ID, state: "complete" });
    assertEquals(run.trace.failureActivities, 0);
    assertEquals(run.trace.sleeps.length, 0);
    assertEquals(run.trace.events.length, 0);
  });

  Deno.test(`Workflow ${wakeMode} caps a subsecond final wait to the deadline`, async () => {
    const run = harness((_round, now) => checkpoint(now), {
      wakeMode,
      now: DAY - 250,
    });
    const output = await run.run() as { state: string; error: string };
    assertEquals(output.state, "failed");
    assert(output.error.includes("deadline"));
    assertEquals(run.trace.sleeps.map((sleep) => sleep.milliseconds), [250]);
    assertEquals(run.trace.events.length, 0);
    assertEquals(run.trace.now, DAY);
  });
}

Deno.test("Workflow event timeouts reconcile and cap the final event wait", async () => {
  const run = harness((_round, now) => checkpoint(now), {
    wakeMode: "events",
    eventTimeout: true,
    now: DAY - 70_000,
  });
  const output = await run.run() as { state: string; error: string };
  assertEquals(output.state, "failed");
  assert(output.error.includes("deadline"));
  assertEquals(run.trace.events.map((event) => event.milliseconds), [
    60_000,
    10_000,
  ]);
  assertEquals(run.trace.now, DAY);
  assertEquals(run.trace.failureActivities, 1);
});

Deno.test("Workflow activity errors retain durable failure handling and retry options", async () => {
  const run = harness(() => {
    throw new Error("storage.transaction: database is locked");
  });
  assertEquals(await run.run(), {
    ...ID,
    state: "failed",
    error: "storage.transaction: database is locked",
  });
  assertEquals(run.trace.reconciliations, 1);
  assertEquals(run.trace.failureActivities, 1);
  assertEquals(run.trace.sleeps.length, 0);
});

Deno.test("Workflow failure acknowledgement cannot overwrite a raced terminal success", async () => {
  const run = harness(() => {
    throw new Error("late transient activity failure");
  }, { failureState: "complete" });
  assertEquals(await run.run(), { ...ID, state: "complete" });
  assertEquals(run.trace.failureActivities, 1);
});
