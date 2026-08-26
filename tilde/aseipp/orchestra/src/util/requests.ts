// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0
/**
 * Validate public HTTP JSON before invoking typed object APIs. These adapters
 * retain the existing Go-agent wire format; object methods also defend their
 * durable invariants against malformed internal calls. @module
 */
import type {
  ClaimRequest,
  CompleteRequest,
  RenewRequest,
} from "../agent_broker.ts";
import type { Job, JsonObject } from "../model.ts";
import type { EpochSubmission } from "../repository.ts";
import { artifactRef } from "./artifacts.ts";
import { MAX_LEASE_MS, MIN_LEASE_MS } from "./constants.ts";
import { requireInteger, requireName, requireString } from "./http.ts";
import { parsePolicy } from "./workflow.ts";

/** Validate a finite, nonempty capability list without silently deduplicating. */
function capabilities(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) {
    throw new TypeError(`${field} must contain 1 to 64 capabilities`);
  }
  const values = value.map((entry) => requireString(entry, field));
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${field} contains duplicate capabilities`);
  }
  return values;
}

/** Narrow the supported agent kinds; never cast arbitrary strings to Job kinds. */
function jobKind(value: string): Job["kind"] {
  if (
    value === "plan_epoch" || value === "run_tests" || value === "plan_culprit"
  ) {
    return value;
  }
  throw new TypeError("unsupported job kind capability");
}

/** Preserve omission so the broker retains ownership of its default grant. */
function leaseDuration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const duration = requireInteger(value, "lease_ms", MIN_LEASE_MS);
  if (duration > MAX_LEASE_MS) {
    throw new TypeError(`lease_ms must be at most ${MAX_LEASE_MS}`);
  }
  return duration;
}

/** Parse the public lease-claim request into the broker's actual method input. */
export function claimRequest(input: JsonObject): ClaimRequest {
  return {
    agent_id: requireName(input.agent_id, "agent_id"),
    lease_ms: leaseDuration(input.lease_ms),
    platforms: capabilities(input.platforms, "platforms"),
    kinds: capabilities(input.kinds, "kinds").map(jobKind),
  };
}

/** Validate the identity/fence shared by renewal and completion. */
function holder(input: JsonObject) {
  return {
    job_id: requireString(input.job_id, "job_id"),
    agent_id: requireName(input.agent_id, "agent_id"),
    lease_token: requireInteger(input.lease_token, "lease_token", 1),
  };
}

/** Parse a renewal without granting authority to change its job or fence. */
export function renewRequest(input: JsonObject): RenewRequest {
  return { ...holder(input), lease_ms: leaseDuration(input.lease_ms) };
}

/** Validate the completion's content-addressed artifact reference. */
export function completeRequest(input: JsonObject): CompleteRequest {
  return { ...holder(input), result_ref: artifactRef(input.result_ref) };
}

/** Preserve absent policy on duplicate submissions instead of applying new defaults. */
export function epochSubmission(
  repo: string,
  input: JsonObject,
): EpochSubmission {
  return {
    repo,
    revision: requireString(input.revision, "revision"),
    ...(input.queue === undefined || input.queue === null
      ? {}
      : { queue: requireName(input.queue, "queue") }),
    ...(input.policy === undefined
      ? {}
      : { policy: parsePolicy(input.policy) }),
  };
}
