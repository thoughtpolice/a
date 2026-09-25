// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link SecretStore}: where the broker keeps what must not leak from a
 * store dump, its users' upstream access and refresh tokens, and
 * {@link encryptedSecretStore}, which keeps them in any `RecordStore`
 * encrypted at rest.
 *
 * `@celld/sec/oauth`'s `RecordStore` is for records whose secrets are stored
 * hashed (the authorization server hashes its codes and refresh tokens);
 * the broker must use its upstream tokens again, so it cannot hash them.
 * A {@link SecretStore} is the same versioned, expiring, one-key-at-a-time
 * contract with that difference named in the type.
 *
 * {@link encryptedSecretStore} seals each value with AES-256-GCM under a
 * key derived (HKDF-SHA-256) from an operator secret. The record's key is
 * the associated data, so a value copied to another key (another user)
 * does not open; a value that does not open under the current or a
 * previous secret reads as absent. Versions and expiry are the underlying
 * store's.
 *
 * Rotating the secret: make the new one `secret` and the old one first in
 * `previous`. A value that opens only under a previous secret is sealed
 * again under the current one when it is read (a compare-and-swap at its
 * version, keeping its expiry; best effort: a lost race or a store error
 * leaves it as it was, and the next read tries again). Values never read
 * stay under the old secret until they expire, so an old secret may be
 * dropped once the longest expiry of the values sealed under it has
 * passed since the rotation: for the broker, its `keepSec` (default 30
 * days). Dropping it earlier makes those values read as absent (the users
 * log in upstream again), never readable by anyone else.
 *
 * @module
 */

import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";
import {
  jsonSnapshot,
  opaqueIdentity,
  parseJsonBounded,
  strictRecord,
} from "@celld/core/bounds";
import type { RecordStore, StoredRecord } from "@celld/sec/oauth/server";
import { isObject, rotationSecrets, secretBytes } from "../util.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A keyed store of secret JSON-compatible records with versions and
 * expiry; see the module documentation. An implementation must keep the
 * values confidential at rest (encrypted, or in storage that is itself
 * confidential).
 */
export interface SecretStore {
  /** Stable opaque identity key, using a secret independent of encryption rotation. */
  identityKey(issuer: string, subject: string): Promise<string>;
  get<T>(key: string): Promise<StoredRecord<T> | null>;
  /** Writes a record whatever was there. */
  put<T>(key: string, value: T, expiresAt: number | null): Promise<void>;
  /**
   * Replaces the record at `version` with `value` (or deletes it, for
   * null); false, changing nothing, when the record is at another version
   * or gone.
   */
  swap<T>(
    key: string,
    version: number,
    value: T | null,
    expiresAt: number | null,
  ): Promise<boolean>;
}

/** Options for {@link encryptedSecretStore}. */
export interface EncryptedSecretStoreOptions {
  /** Stable independent key for broker identities. Defaults to secret; retain it when rotating encryption keys. */
  readonly identitySecret?: string | Uint8Array;
  /**
   * 32 random bytes (base64url) or more, kept as a secret; the same in
   * every isolate. Shorter, or with fewer than `SECRET_MIN_DISTINCT_BYTES`
   * distinct bytes, is a `TypeError`.
   */
  readonly secret: string | Uint8Array;
  /**
   * Older secrets that still open values (never used to seal), newest
   * first. A value opened with one is sealed again under `secret`; see
   * the module documentation for when one may be dropped.
   */
  readonly previous?: readonly (string | Uint8Array)[];
}

interface Sealed {
  readonly sealed: "v1";
  readonly iv: string;
  readonly data: string;
}

async function deriveKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const bytes = secretBytes(secret, "a secret store secret");
  const base = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(bytes),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode("@celld/sec/oidc secret store v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function associated(key: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`@celld/sec/oidc secret v1\n${key}`);
}

/**
 * A {@link SecretStore} over `store` that encrypts every value; see the
 * module documentation. Throws `TypeError` for a secret (current or
 * previous) shorter than 32 bytes or plainly not random.
 */
export async function encryptedSecretStore(
  store: RecordStore,
  options: EncryptedSecretStoreOptions,
): Promise<SecretStore> {
  strictRecord(
    options,
    ["secret", "previous", "identitySecret"],
    "encryptedSecretStore options",
  );
  const identity = Uint8Array.from(
    secretBytes(
      options.identitySecret === undefined
        ? options.secret
        : options.identitySecret,
      "identity secret",
    ),
  );
  const secrets = rotationSecrets(
    options.secret,
    options.previous,
    "encryption secret",
  );
  const identityKey = await crypto.subtle.importKey(
    "raw",
    identity,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const keys = await Promise.all(secrets.map(deriveKey));
  const seal = async (key: string, value: unknown): Promise<Sealed> => {
    value = jsonSnapshot(value, {
      maxDepth: 24,
      maxItems: 4096,
      maxBytes: 262144,
    });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: associated(key) },
        keys[0],
        encoder.encode(JSON.stringify(value)),
      ),
    );
    return { sealed: "v1", iv: toBase64Url(iv), data: toBase64Url(data) };
  };
  /** The value and the index of the key that opened it, or null. */
  const open = async <T>(
    key: string,
    value: unknown,
  ): Promise<{ value: T; by: number } | null> => {
    if (
      !isObject(value) || value.sealed !== "v1" ||
      typeof value.data !== "string" || value.data.length > 350000 ||
      typeof value.iv !== "string" || value.iv.length !== 16
    ) return null;
    const iv = typeof value.iv === "string" ? fromBase64Url(value.iv) : null;
    const data = typeof value.data === "string"
      ? fromBase64Url(value.data)
      : null;
    if (iv === null || data === null || iv.length !== 12) return null;
    for (const [by, candidate] of keys.entries()) {
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: associated(key) },
          candidate,
          data,
        );
        return {
          value: parseJsonBounded(decoder.decode(plain), {
            maxBytes: 262144,
            maxDepth: 24,
            maxKeys: 1024,
            maxItems: 4096,
          }) as T,
          by,
        };
      } catch {
        continue;
      }
    }
    return null;
  };
  const read = async <T>(
    key: string,
    reseal: boolean,
  ): Promise<StoredRecord<T> | null> => {
    const stored = await store.get<Sealed>(key);
    if (stored === null) return null;
    const opened = await open<T>(key, stored.value);
    if (opened === null) return null;
    const record = {
      value: opened.value,
      version: stored.version,
      expiresAt: stored.expiresAt,
    };
    if (opened.by === 0 || !reseal) return record;
    // Opened with a previous secret: seal it under the current one, then
    // answer what the store now holds (the new version, or whatever won).
    try {
      await store.swap(
        key,
        stored.version,
        await seal(key, opened.value),
        stored.expiresAt,
      );
    } catch {
      return record;
    }
    return await read<T>(key, false);
  };
  return {
    async identityKey(issuer: string, subject: string): Promise<string> {
      if (
        typeof issuer !== "string" || issuer.length === 0 ||
        issuer.length > 2048 || typeof subject !== "string" ||
        subject.length === 0 || subject.length > 2048
      ) throw new TypeError("broker identity is invalid or oversized");
      return `broker:v2:${await opaqueIdentity(
        identityKey,
        "@celld/sec/oidc broker identity v2",
        JSON.stringify([issuer, subject]),
      )}`;
    },
    async get<T>(key: string): Promise<StoredRecord<T> | null> {
      return await read<T>(key, true);
    },
    async put<T>(key: string, value: T, expiresAt: number | null) {
      await store.put(key, await seal(key, value), expiresAt);
    },
    async swap<T>(
      key: string,
      version: number,
      value: T | null,
      expiresAt: number | null,
    ): Promise<boolean> {
      return await store.swap(
        key,
        version,
        value === null ? null : await seal(key, value),
        expiresAt,
      );
    },
  };
}
