// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Client data (§5.8.1): what the browser says about the ceremony, parsed
 * as JSON (never compared against a template: browsers add members, and
 * Chromium sometimes adds one on purpose) and checked against what the
 * relying party expects.
 *
 * @module
 */

import { parseJsonBounded } from "@celld/core/bounds";
import { WebAuthnError } from "./errors.ts";

/** The members of client data a relying party checks. */
export interface ClientData {
  readonly type: string;
  /** The challenge, base64url. */
  readonly challenge: string;
  readonly origin: string;
  /** True when the ceremony ran in a frame not same-origin with its ancestors. */
  readonly crossOrigin: boolean;
  /** The top-level page's origin, for a cross-origin frame. */
  readonly topOrigin?: string;
}

/** The largest client data accepted, in bytes. */
export const MAX_CLIENT_DATA_BYTES = 16 * 1024;

// A byte-order mark is stripped (§7.1 step 5); invalid UTF-8 is refused.
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(message: string, cause?: unknown): WebAuthnError {
  return new WebAuthnError("invalid_response", message, { cause });
}

/** Parses client data JSON bytes; unknown members are ignored. */
export function parseClientData(bytes: Uint8Array): ClientData {
  if (bytes.length > MAX_CLIENT_DATA_BYTES) {
    throw invalid("the client data is too large");
  }
  let value: unknown;
  try {
    value = parseJsonBounded(decoder.decode(bytes), {
      maxDepth: 8,
      maxKeys: 64,
      maxItems: 64,
      maxBytes: MAX_CLIENT_DATA_BYTES,
    });
  } catch (cause) {
    throw invalid("the client data is not a JSON object", cause);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("the client data is not a JSON object");
  }
  const data = value as Record<string, unknown>;
  const { type, challenge, origin, crossOrigin, topOrigin } = data;
  if (
    typeof type !== "string" || typeof challenge !== "string" ||
    typeof origin !== "string"
  ) {
    throw invalid("the client data lacks its type, challenge or origin");
  }
  if (crossOrigin !== undefined && typeof crossOrigin !== "boolean") {
    throw invalid("the client data's crossOrigin is not a boolean");
  }
  if (topOrigin !== undefined && typeof topOrigin !== "string") {
    throw invalid("the client data's topOrigin is not a string");
  }
  return Object.freeze({
    type,
    challenge,
    origin,
    crossOrigin: crossOrigin === true,
    ...(topOrigin === undefined ? {} : { topOrigin }),
  });
}

/** What {@link checkClientData} expects. */
export interface ExpectedClientData {
  readonly type: "webauthn.create" | "webauthn.get";
  readonly challenge: string;
  /** Origins a ceremony may come from, serialized (`https://host[:port]`). */
  readonly origins: ReadonlySet<string>;
  /**
   * Top-level origins allowed to embed a ceremony in a cross-origin frame
   * (empty refuses every cross-origin frame), or `"any"` for any page,
   * including a client that does not say which (§16.4's does not).
   */
  readonly topOrigins: ReadonlySet<string> | "any";
}

/**
 * Checks client data against what the relying party expects (§7.1 steps
 * 7 to 11, §7.2 steps 10 to 14), in the order that gives the most useful
 * error.
 */
export function checkClientData(
  data: ClientData,
  expected: ExpectedClientData,
): void {
  if (data.type !== expected.type) {
    throw new WebAuthnError(
      "wrong_ceremony",
      `the client data is for ${
        JSON.stringify(data.type)
      }, not ${expected.type}`,
    );
  }
  if (data.challenge !== expected.challenge) {
    throw new WebAuthnError(
      "challenge_mismatch",
      "the client data's challenge is not the one issued",
    );
  }
  if (!expected.origins.has(data.origin)) {
    throw new WebAuthnError(
      "origin_not_allowed",
      `the origin ${JSON.stringify(data.origin)} is not allowed`,
    );
  }
  if (data.crossOrigin || data.topOrigin !== undefined) {
    const { topOrigins } = expected;
    if (!data.crossOrigin) {
      throw new WebAuthnError(
        "origin_not_allowed",
        "a top origin without crossOrigin is not a frame the client reported",
      );
    }
    if (
      topOrigins !== "any" &&
      (data.topOrigin === undefined || !topOrigins.has(data.topOrigin))
    ) {
      throw new WebAuthnError(
        "origin_not_allowed",
        data.topOrigin === undefined
          ? "a cross-origin frame without a top origin is not allowed"
          : `a frame on ${JSON.stringify(data.topOrigin)} is not allowed`,
      );
    }
  }
}
