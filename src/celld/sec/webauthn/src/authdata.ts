// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticator data (§6.1): the RP ID hash, flags, signature counter,
 * and, when present, the attested credential (§6.5.1) and extension
 * outputs, each of whose length is known only by decoding its CBOR.
 *
 * @module
 */

import { CborError, type CborMap, decodeCbor } from "./cbor.ts";
import { type CoseKey, parseCoseKey } from "./cose.ts";
import { WebAuthnError } from "./errors.ts";

/** The flags byte, bit by bit. */
export interface AuthenticatorFlags {
  /** UP (0x01): a user was present. */
  readonly userPresent: boolean;
  /** UV (0x04): the user was verified (PIN, biometric). */
  readonly userVerified: boolean;
  /** BE (0x08): the credential may be backed up (a synced passkey). */
  readonly backupEligible: boolean;
  /** BS (0x10): the credential is backed up now. */
  readonly backupState: boolean;
  /** AT (0x40): an attested credential follows. */
  readonly attestedCredentialData: boolean;
  /** ED (0x80): extension outputs follow. */
  readonly extensionData: boolean;
}

/** The credential a registration's authenticator data carries. */
export interface AttestedCredential {
  /** The authenticator model, 16 bytes (zeros when withheld). */
  readonly aaguid: Uint8Array<ArrayBuffer>;
  /** The credential ID, at most 1023 bytes. */
  readonly id: Uint8Array<ArrayBuffer>;
  /** The COSE key as the authenticator wrote it: what to store. */
  readonly publicKeyBytes: Uint8Array<ArrayBuffer>;
  /** The same key, checked. */
  readonly publicKey: CoseKey;
}

/** Parsed authenticator data. */
export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array<ArrayBuffer>;
  readonly flags: AuthenticatorFlags;
  readonly signCount: number;
  readonly attestedCredential?: AttestedCredential;
  /** Authenticator extension outputs, by identifier. */
  readonly extensions?: CborMap;
}

/** The longest credential ID (§4, §6.5.1). */
export const MAX_CREDENTIAL_ID_BYTES = 1023;

function invalid(message: string, cause?: unknown): WebAuthnError {
  return new WebAuthnError("invalid_response", message, { cause });
}

function decodeAt(bytes: Uint8Array, offset: number, what: string) {
  try {
    return decodeCbor(bytes, { offset, partial: true });
  } catch (cause) {
    if (cause instanceof CborError) {
      throw invalid(
        `the authenticator data's ${what} is not valid CBOR`,
        cause,
      );
    }
    throw cause;
  }
}

/**
 * Parses authenticator data, requiring it to end exactly where its parts
 * do. A credential ID over {@link MAX_CREDENTIAL_ID_BYTES} or a key this
 * library cannot verify is refused here.
 */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw invalid("authenticator data is too short");
  const byte = bytes[32];
  // Bits 1 and 5 are reserved for future use (§6.1). Accepting them would
  // give a future authenticator meaning this version of the RP does not
  // understand, so fail closed instead of silently discarding them.
  if ((byte & 0x22) !== 0) {
    throw invalid("reserved authenticator flag bits are set");
  }
  const flags: AuthenticatorFlags = Object.freeze({
    userPresent: (byte & 0x01) !== 0,
    userVerified: (byte & 0x04) !== 0,
    backupEligible: (byte & 0x08) !== 0,
    backupState: (byte & 0x10) !== 0,
    attestedCredentialData: (byte & 0x40) !== 0,
    extensionData: (byte & 0x80) !== 0,
  });
  const signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4)
    .getUint32(0);
  let offset = 37;
  let attestedCredential: AttestedCredential | undefined;
  if (flags.attestedCredentialData) {
    if (bytes.length < offset + 18) {
      throw invalid("the attested credential data is truncated");
    }
    const aaguid = bytes.slice(offset, offset + 16);
    const length = bytes[offset + 16] << 8 | bytes[offset + 17];
    offset += 18;
    if (length === 0 || length > MAX_CREDENTIAL_ID_BYTES) {
      throw invalid(
        `a credential ID is 1 to ${MAX_CREDENTIAL_ID_BYTES} bytes, got ${length}`,
      );
    }
    if (bytes.length < offset + length) {
      throw invalid("the credential ID is truncated");
    }
    const id = bytes.slice(offset, offset + length);
    offset += length;
    const key = decodeAt(bytes, offset, "credential public key");
    const publicKeyBytes = bytes.slice(offset, key.end);
    offset = key.end;
    attestedCredential = Object.freeze({
      aaguid,
      id,
      publicKeyBytes,
      publicKey: parseCoseKey(key.value),
    });
  }
  let extensions: CborMap | undefined;
  if (flags.extensionData) {
    const decoded = decodeAt(bytes, offset, "extensions");
    if (!(decoded.value instanceof Map)) {
      throw invalid("the authenticator extensions are not a CBOR map");
    }
    for (const key of decoded.value.keys()) {
      if (typeof key !== "string") {
        throw invalid("an authenticator extension identifier is not text");
      }
    }
    extensions = decoded.value;
    offset = decoded.end;
  }
  if (offset !== bytes.length) {
    throw invalid("bytes follow the authenticator data");
  }
  return Object.freeze({
    rpIdHash: bytes.slice(0, 32),
    flags,
    signCount,
    ...(attestedCredential === undefined ? {} : { attestedCredential }),
    ...(extensions === undefined ? {} : { extensions }),
  });
}

/** An AAGUID as a UUID string. */
export function formatAaguid(aaguid: Uint8Array): string {
  const hex = Array.from(aaguid, (b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}
