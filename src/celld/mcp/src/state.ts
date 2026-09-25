// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Sealed `requestState` for multi round-trip requests.
 *
 * The server is stateless, so what it needs on the retry travels through the
 * client, which the spec says to treat as an attacker. Each state is
 * encrypted and authenticated with AES-256-GCM under a key derived (HKDF-
 * SHA-256) from the server's secret: the client can neither read nor alter
 * it, and any change fails to open. Inside, following the spec's replay
 * advice, it binds:
 *
 * - the method and a digest of the request's salient params (everything but
 *   `_meta`, `inputResponses` and `requestState`), so it only works on a
 *   retry of the same request;
 * - the authenticated principal, so another caller cannot present it;
 * - an expiry;
 * - the input request keys (and methods) it asked for, so the retry's
 *   `inputResponses` are only accepted for questions actually asked;
 * - the answers from earlier rounds, which the client does not resend;
 * - the handler's own state.
 *
 * This bounds replay but does not make a state single-use; a handler that
 * must consume something at most once has to enforce that itself.
 *
 * @module
 */

import {
  canonicalJson,
  fromBase64Url,
  isPlainObject,
  sha256,
  toBase64Url,
} from "./json.ts";
import type { InputResponses, JSONValue } from "./types.ts";

/** What a sealed state carries. */
export interface StatePayload {
  /** The method of the request it belongs to. */
  readonly method: string;
  /** {@link paramsDigest} of that request. */
  readonly digest: string;
  /** The principal that received it, or null when unauthenticated. */
  readonly principal: string | null;
  /** Expiry, in epoch milliseconds. */
  readonly expiresAt: number;
  /** The input requests it asked for: key to method. */
  readonly asked: Readonly<Record<string, string>>;
  /** Verified answers from earlier rounds. */
  readonly answers: InputResponses;
  /** The handler's own state. */
  readonly state: JSONValue | null;
}

const VERSION = "v1";
const INFO = new TextEncoder().encode("celld-mcp requestState v1");
const AAD = new TextEncoder().encode("celld-mcp requestState");

/** Seals and opens {@link StatePayload}s under one secret. */
export class StateSealer {
  readonly #key: Promise<CryptoKey>;

  /**
   * `secret` must hold at least 32 bytes (a string counts its UTF-8 bytes).
   * Every instance of a server must share it, or a retry that lands on
   * another instance fails.
   */
  constructor(secret: string | Uint8Array) {
    const bytes = typeof secret === "string"
      ? new TextEncoder().encode(secret)
      : secret;
    if (bytes.length < 32) {
      throw new RangeError("the requestState secret needs at least 32 bytes");
    }
    this.#key = crypto.subtle.importKey(
      "raw",
      new Uint8Array(bytes),
      "HKDF",
      false,
      ["deriveKey"],
    ).then((material) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: INFO },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      )
    );
  }

  /** The opaque token for a payload. */
  async seal(payload: StatePayload): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({
      m: payload.method,
      d: payload.digest,
      p: payload.principal,
      e: payload.expiresAt,
      k: payload.asked,
      r: payload.answers,
      s: payload.state,
    }));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: AAD },
        await this.#key,
        plain,
      ),
    );
    const out = new Uint8Array(iv.length + sealed.length);
    out.set(iv);
    out.set(sealed, iv.length);
    return `${VERSION}.${toBase64Url(out)}`;
  }

  /** The payload of a token, or null if it was not sealed by this secret or was altered. */
  async open(token: string): Promise<StatePayload | null> {
    if (!token.startsWith(`${VERSION}.`)) return null;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fromBase64Url(token.slice(VERSION.length + 1));
    } catch {
      return null;
    }
    if (bytes.length < 12 + 16) return null;
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: AAD },
        await this.#key,
        bytes.subarray(12),
      );
    } catch {
      return null;
    }
    const value = JSON.parse(new TextDecoder().decode(plain));
    if (!isPlainObject(value)) return null;
    return {
      method: value.m as string,
      digest: value.d as string,
      principal: value.p as string | null,
      expiresAt: value.e as number,
      asked: value.k as Record<string, string>,
      answers: value.r as InputResponses,
      state: value.s as JSONValue | null,
    };
  }
}

/**
 * A digest of the params that identify a request: everything except
 * `_meta`, `inputResponses` and `requestState`, canonically encoded.
 */
export function paramsDigest(
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<string> {
  const salient: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key !== "_meta" && key !== "inputResponses" && key !== "requestState") {
      salient[key] = value;
    }
  }
  return sha256(`${method}\n${canonicalJson(salient)}`);
}
