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
 * - the authenticated principal's `key` (scheme, issuer, tenant, client
 *   and subject), so another caller cannot present it, even one with the
 *   same subject; an anonymous caller's state is bound to no one, and the
 *   token itself is the capability;
 * - the scopes the request needed, which the server checks against the
 *   caller's current scopes on every later round;
 * - an expiry;
 * - the input request keys (and methods) it asked for, so the retry's
 *   `inputResponses` are only accepted for questions actually asked;
 * - the answers from earlier rounds, which the client does not resend;
 * - the handler's own state.
 *
 * The key is derived for one audience (the server's `stateAudience`, by
 * default its name), so a state sealed by another server sharing the
 * secret does not open.
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
  /** The `key` of the principal that received it, or null when anonymous. */
  readonly principal: string | null;
  /** The scopes the request needed; every round rechecks them. */
  readonly scopes: readonly string[];
  /** Expiry, in epoch milliseconds. */
  readonly expiresAt: number;
  /** The input requests it asked for: key to method. */
  readonly asked: Readonly<Record<string, string>>;
  /** Verified answers from earlier rounds. */
  readonly answers: InputResponses;
  /** The handler's own state. */
  readonly state: JSONValue | null;
}

// v2 binds the principal's key and the scopes; v1 bound a bare subject and
// no longer opens (a separate derived key, so it cannot even decrypt). The
// HKDF info also names the audience, so each server derives its own key.
const VERSION = "v2";
const INFO = "celld-mcp requestState v2";
const AAD = new TextEncoder().encode("celld-mcp requestState");

/** Seals and opens {@link StatePayload}s under one secret. */
export class StateSealer {
  readonly #key: Promise<CryptoKey>;

  /**
   * `secret` must hold at least 32 bytes (a string counts its UTF-8 bytes).
   * Every instance of a server must share it, or a retry that lands on
   * another instance fails. `audience` names the server (a non-empty
   * string without NUL); a state opens only under the audience that
   * sealed it.
   */
  constructor(secret: string | Uint8Array, audience: string) {
    if (
      typeof audience !== "string" || audience === "" ||
      audience.includes("\0")
    ) {
      throw new TypeError(
        "the requestState audience must be a non-empty string without NUL",
      );
    }
    const info = new TextEncoder().encode(`${INFO}\0${audience}`);
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
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
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
      c: payload.scopes,
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
    const scopes = value.c;
    if (
      !Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")
    ) {
      return null;
    }
    return {
      method: value.m as string,
      digest: value.d as string,
      principal: value.p as string | null,
      scopes,
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
  // No prototype: a peer's own `__proto__` key stays a key (workerd has
  // the accessor that assignment would call).
  const salient: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key !== "_meta" && key !== "inputResponses" && key !== "requestState") {
      salient[key] = value;
    }
  }
  return sha256(`${method}\n${canonicalJson(salient)}`);
}
