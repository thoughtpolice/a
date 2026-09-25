// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi round-trip request pieces shared by both ends: builders for the
 * three input requests, the client capability each one needs, and the signal
 * a server handler throws to ask for input.
 *
 * @module
 */

import type {
  ClientCapabilities,
  CreateMessageRequestParams,
  ElicitRequest,
  ElicitRequestFormParams,
  InputRequest,
  InputRequests,
  JSONValue,
  ListRootsRequest,
} from "./types.ts";

/** A form-mode elicitation request. Never use form mode for secrets. */
export function elicitForm(
  message: string,
  requestedSchema: ElicitRequestFormParams["requestedSchema"],
): ElicitRequest {
  return {
    method: "elicitation/create",
    params: { mode: "form", message, requestedSchema },
  };
}

/**
 * A URL-mode elicitation request: the user completes an interaction at `url`
 * out of band, and the client's `accept` only means they consented to go.
 * The server learns the outcome on the retry from its own records.
 */
export function elicitUrl(message: string, url: string): ElicitRequest {
  return {
    method: "elicitation/create",
    params: { mode: "url", message, url },
  };
}

/**
 * A sampling request.
 *
 * @deprecated Sampling is deprecated as of 2026-07-28 (SEP-2577).
 */
export function sampling(params: CreateMessageRequestParams): InputRequest {
  return { method: "sampling/createMessage", params };
}

/**
 * A roots request.
 *
 * @deprecated Roots are deprecated as of 2026-07-28 (SEP-2577).
 */
export function listRoots(): ListRootsRequest {
  return { method: "roots/list" };
}

/** The client capabilities an input request needs. */
export function capabilityFor(request: InputRequest): ClientCapabilities {
  switch (request.method) {
    case "elicitation/create":
      return request.params.mode === "url"
        ? { elicitation: { url: {} } }
        : { elicitation: { form: {} } };
    case "sampling/createMessage": {
      const needs: {
        context?: Record<string, never>;
        tools?: Record<string, never>;
      } = {};
      const params = request.params;
      if (params.tools !== undefined || params.toolChoice !== undefined) {
        needs.tools = {};
      }
      if (
        params.includeContext === "thisServer" ||
        params.includeContext === "allServers"
      ) {
        needs.context = {};
      }
      return { sampling: needs };
    }
    case "roots/list":
      return { roots: {} };
  }
}

/**
 * The part of `required` that `declared` lacks, or null when nothing is
 * missing. An `elicitation` declared with neither `form` nor `url` means
 * form mode only, as the spec says for backward compatibility.
 */
export function missingCapabilities(
  declared: ClientCapabilities,
  required: ClientCapabilities,
): ClientCapabilities | null {
  const missing: ClientCapabilities = {};
  if (required.elicitation !== undefined) {
    const have = declared.elicitation;
    const canForm = have !== undefined &&
      (have.form !== undefined || have.url === undefined);
    const canUrl = have?.url !== undefined;
    const need: {
      form?: Record<string, JSONValue>;
      url?: Record<string, JSONValue>;
    } = {};
    if (required.elicitation.form !== undefined && !canForm) need.form = {};
    if (required.elicitation.url !== undefined && !canUrl) need.url = {};
    if (have === undefined || Object.keys(need).length > 0) {
      missing.elicitation = have === undefined ? required.elicitation : need;
    }
  }
  if (required.sampling !== undefined) {
    const have = declared.sampling;
    if (
      have === undefined ||
      (required.sampling.tools !== undefined && have.tools === undefined) ||
      (required.sampling.context !== undefined && have.context === undefined)
    ) {
      missing.sampling = required.sampling;
    }
  }
  if (required.roots !== undefined && declared.roots === undefined) {
    missing.roots = {};
  }
  for (const key of Object.keys(required.extensions ?? {})) {
    if (declared.extensions?.[key] === undefined) {
      missing.extensions ??= {};
      missing.extensions[key] = required.extensions![key];
    }
  }
  for (const key of Object.keys(required.experimental ?? {})) {
    if (declared.experimental?.[key] === undefined) {
      missing.experimental ??= {};
      missing.experimental[key] = required.experimental![key];
    }
  }
  return Object.keys(missing).length === 0 ? null : missing;
}

/** Merges capability requirements. */
export function mergeCapabilities(
  ...all: readonly ClientCapabilities[]
): ClientCapabilities {
  const out: ClientCapabilities = {};
  for (const caps of all) {
    for (const [key, value] of Object.entries(caps)) {
      const record = out as Record<string, Record<string, unknown>>;
      record[key] = { ...(record[key] ?? {}), ...(value as object) };
    }
  }
  return out;
}

/**
 * Thrown by a handler (through the context helpers) to answer with an
 * `InputRequiredResult`. The server catches it; handlers never need to.
 */
export class InputRequired extends Error {
  /** The input requests to send, keyed by id. */
  readonly requests: InputRequests;
  /** The handler state to seal into `requestState`. */
  readonly state: JSONValue | null;

  constructor(requests: InputRequests, state: JSONValue | null = null) {
    super(`input required: ${Object.keys(requests).join(", ") || "(retry)"}`);
    this.name = "InputRequired";
    this.requests = requests;
    this.state = state;
  }
}
