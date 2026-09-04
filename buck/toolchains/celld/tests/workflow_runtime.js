// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-runtime Workflow lifecycle contracts, independent of any application.
 * The HTTP adapter runs small, bounded scenarios and reports observed binding
 * results/errors to Python assertions. No fake Workflow implementation is used.
 * @module
 */
import { WorkflowEntrypoint } from "cloudflare:workers";

/** Completes, fails, or sleeps durably according to the test's payload. */
export class ContractWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    if (event.payload.mode === "error") throw new Error("contract failure");
    if (event.payload.mode === "wait") await step.sleep("hold", "1 hour");
    return { value: event.payload.value };
  }
}

/** Preserve the error actually transported across celld's internal RPC. */
async function capture(operation) {
  try {
    return { value: await operation() };
  } catch (error) {
    return { error: { name: error.name, message: error.message } };
  }
}

/** Wait briefly for a Workflow to reach an expected durable status. */
async function waitForStatus(instance, expected = ["complete", "errored"]) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await instance.status();
    if (expected.includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Workflow did not reach " + expected.join("/") + " within 5 seconds",
  );
}

/** Run one independent lifecycle scenario, using unique instance IDs. */
async function scenario(flow, name, mode) {
  const id = name + "-" + crypto.randomUUID();
  const options = { id, params: { value: "original" } };
  if (name === "missing") {
    return await capture(() => flow.get(id));
  }
  if (name === "duplicate") {
    const instance = await flow.create(options);
    const status = await waitForStatus(instance);
    const fetched = await flow.get(id);
    return {
      id,
      status,
      fetched: { id: fetched.id, status: await fetched.status() },
      duplicate: await capture(() => flow.create(options)),
      batch: (await flow.createBatch([
        options,
        { id: id + "-new", params: { value: "first" } },
        { id: id + "-new", params: { value: "ignored" } },
      ])).map((instance) => instance.id),
      batchStatus: await waitForStatus(await flow.get(id + "-new")),
    };
  }
  if (name === "retention") {
    const instance = await flow.create({
      ...options,
      params: { value: "original", mode },
      retention: { successRetention: "1 second", errorRetention: "1 second" },
    });
    const status = await waitForStatus(instance);
    // Poll the *same handle*: expiry is discovered by an ordinary status call,
    // not an explicit deletion or a made-up NotFound Workflow state.
    const deadline = Date.now() + 5000;
    let expired;
    while (Date.now() < deadline) {
      expired = await capture(() => instance.status());
      if (expired.error) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!expired?.error) {
      throw new Error("Workflow did not expire within 5 seconds");
    }
    const missing = await capture(() => flow.get(id));
    const recreated = await flow.create({
      ...options,
      params: { value: "replacement" },
    });
    return {
      status,
      expired,
      missing,
      recreated: await waitForStatus(recreated),
    };
  }
  if (name === "delete") {
    const instance = await flow.create({
      ...options,
      params: { mode, value: "original" },
    });
    await waitForStatus(instance, mode === "wait" ? ["waiting"] : ["complete"]);
    await instance.delete();
    const missing = await capture(() => flow.get(id));
    const staleStatus = await capture(() => instance.status());
    const staleDelete = await capture(() => instance.delete());
    const replacement = await flow.create({
      ...options,
      params: { value: "replacement" },
    });
    await waitForStatus(replacement);
    // Handles address an ID, not a generation: after recreation even an old
    // handle observes the new instance. Callers must not infer fencing here.
    return {
      missing,
      staleStatus,
      staleDelete,
      reusedHandle: await instance.status(),
    };
  }
  if (name === "delete-batch") {
    await flow.createBatch([
      options,
      { id: id + "-other", params: { value: "other" } },
    ]);
    const result = await flow.deleteBatch([
      id,
      id,
      id + "-other",
      id + "-missing",
    ]);
    return {
      id,
      result,
      first: await capture(() => flow.get(id)),
      other: await capture(() => flow.get(id + "-other")),
    };
  }
  throw new Error("Unknown scenario: " + name);
}

/** JSON-only adapter; unexpected fixture failures use a real HTTP 500. */
export default {
  async fetch(request, env) {
    try {
      const { name, mode } = await request.json();
      return Response.json(await scenario(env.FLOW, name, mode));
    } catch (error) {
      return Response.json({
        error: { name: error.name, message: error.message },
      }, { status: 500 });
    }
  },
};
