// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * What is known about the models behind a ChatGPT subscription.
 *
 * {@link KNOWN_MODELS} is a snapshot of the catalog the open-source Codex
 * client ships (`codex-rs/models-manager/models.json`, main branch, read on
 * 2026-09-25). It is used for three things only: to pick the request
 * encoding Codex uses for a model (`use_responses_lite`), to refuse a
 * reasoning effort the model does not list, and to size inputs against the
 * context window. It is not a gate: any model id can be sent, and unknown
 * ids get the standard encoding and no effort check. `GET /models` is the
 * authority on what the integration actually serves.
 *
 * The GPT-6 family there is `gpt-6-astra`, `gpt-6-sol` and `gpt-6-luna`;
 * there is no bare `gpt-6`. {@link DEFAULT_MODEL} is `gpt-6-astra`, the
 * catalog's highest-priority entry. All three, and `gpt-5.5` with the
 * standard encoding, passed the live smoke test (`tests/live/smoke.ts`)
 * through a ChatGPT-backed integration on 2026-09-25.
 *
 * @module
 */

import {
  describeValue,
  isPlainObject,
  type Issue,
  type JsonObject,
} from "./json.ts";
import type { ModelCard, ReasoningEffort, Verbosity } from "./types.ts";

/** Facts about one model, from the Codex catalog snapshot. */
export interface ModelInfo {
  readonly id: string;
  readonly displayName: string;
  /** Context window in tokens. */
  readonly contextWindow: number;
  /**
   * Whether Codex sends this model the "responses lite" encoding: tools and
   * instructions as leading input items instead of top-level fields.
   */
  readonly lite: boolean;
  /** Reasoning efforts the model accepts on the wire. */
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort: ReasoningEffort;
  readonly defaultVerbosity: Verbosity;
  /** A specialisation, such as `cyber` for the Daybreak models. */
  readonly specialty: string | null;
  /** Whether Codex lists it in its picker (hidden models may need access). */
  readonly listed: boolean;
}

const BIG: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function info(
  id: string,
  displayName: string,
  fields: Partial<ModelInfo> = {},
): ModelInfo {
  return Object.freeze({
    id,
    displayName,
    contextWindow: 272_000,
    lite: true,
    efforts: BIG,
    defaultEffort: "medium",
    defaultVerbosity: "low",
    specialty: null,
    listed: true,
    ...fields,
  });
}

/**
 * The Codex catalog snapshot. Codex's `ultra` effort is left out: it is a
 * Codex harness feature (task delegation) that the client rewrites to
 * another effort before sending.
 */
export const KNOWN_MODELS: Readonly<Record<string, ModelInfo>> = Object.freeze(
  Object.fromEntries(
    [
      info("gpt-6-astra", "GPT-6-Astra", { defaultEffort: "low" }),
      info("gpt-6-sol", "GPT-6-Sol"),
      info("gpt-6-luna", "GPT-6-Luna"),
      info("gpt-5.6-sol", "GPT-5.6-Sol", { defaultEffort: "low" }),
      info("gpt-5.6-terra", "GPT-5.6-Terra"),
      info("gpt-5.6-luna", "GPT-5.6-Luna"),
      info("gpt-daybreak-blue-latest", "Daybreak Blue", {
        defaultEffort: "low",
        specialty: "cyber",
        listed: false,
      }),
      info("gpt-daybreak-red-latest", "Daybreak Red", {
        contextWindow: 372_000,
        defaultVerbosity: "high",
        specialty: "cyber",
        listed: false,
      }),
      info("gpt-5.5", "GPT-5.5", {
        lite: false,
        efforts: ["low", "medium", "high", "xhigh"],
      }),
      info("codex-auto-review", "Codex Auto Review", { listed: false }),
    ].map((model) => [model.id, model]),
  ),
);

/** The default model: the catalog's first GPT-6 entry. */
export const DEFAULT_MODEL = "gpt-6-astra";

/** Every effort value this library will send. */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** What the snapshot knows about `model`, or null. */
export function modelInfo(model: string): ModelInfo | null {
  return Object.hasOwn(KNOWN_MODELS, model) ? KNOWN_MODELS[model] : null;
}

/**
 * Decodes `GET /models` in any of the shapes it may take through the
 * integration: OpenAI's `{data: [{id}]}`, Codex's `{models: [{slug}]}`, or
 * a bare list. Entries without an id are reported.
 */
export function decodeModels(body: unknown, issues: Issue[]): ModelCard[] {
  const list = Array.isArray(body)
    ? body
    : isPlainObject(body) && Array.isArray(body.data)
    ? body.data
    : isPlainObject(body) && Array.isArray(body.models)
    ? body.models
    : null;
  if (list === null) {
    issues.push({
      path: [],
      message:
        `expected a model list ({data: [...]}, {models: [...]} or [...]), got ${
          describeValue(body)
        }`,
    });
    return [];
  }
  const out: ModelCard[] = [];
  list.forEach((entry, index) => {
    if (typeof entry === "string") {
      out.push({ id: entry, displayName: null, raw: { id: entry } });
      return;
    }
    if (!isPlainObject(entry)) {
      issues.push({
        path: [index],
        message: "a model entry must be an object",
      });
      return;
    }
    const id = typeof entry.id === "string"
      ? entry.id
      : typeof entry.slug === "string"
      ? entry.slug
      : null;
    if (id === null || id === "") {
      issues.push({
        path: [index],
        message: "a model entry needs an id or slug",
      });
      return;
    }
    const name = entry.display_name ?? entry.displayName ?? entry.name;
    out.push({
      id,
      displayName: typeof name === "string" ? name : null,
      raw: entry as JsonObject,
    });
  });
  return out;
}

/**
 * The first preference the list can serve: an exact id, else the first id
 * that starts with the preference followed by `-` (so `gpt-6` matches
 * `gpt-6-astra`). Null when none matches.
 */
export function pickModel(
  available: readonly (ModelCard | string)[],
  preferences: readonly string[],
): string | null {
  const ids = available.map((entry) =>
    typeof entry === "string" ? entry : entry.id
  );
  for (const preference of preferences) {
    if (ids.includes(preference)) return preference;
    const prefixed = ids.find((id) => id.startsWith(`${preference}-`));
    if (prefixed !== undefined) return prefixed;
  }
  return null;
}
