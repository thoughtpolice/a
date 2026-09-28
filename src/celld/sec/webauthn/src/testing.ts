// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Test doubles: {@link VirtualAuthenticator}, a software authenticator
 * that answers creation and request options with the JSON a browser would
 * send (real keys, real signatures), and {@link memoryPasskeyStore}.
 *
 * The authenticator can also misbehave on request (another origin, no user
 * verification, a replayed counter, a missing user handle...), which is
 * how the refusals get tested. It is not a security boundary: its keys are
 * in memory.
 *
 * @module
 */

import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";
import { encodeCbor } from "./cbor.ts";
import type { CreationOptionsJSON, RequestOptionsJSON } from "./rp.ts";
import { DirectoryCore, MemoryTables, type PasskeyStore } from "./store.ts";

export { DirectoryCore, MemoryTables };

/** The algorithms a {@link VirtualAuthenticator} can create keys for. */
export type VirtualAlgorithm = -7 | -8 | -257;

/** How an authenticator behaves; each call may override any of it. */
export interface AuthenticatorBehaviour {
  /** The origin the client reports; default the authenticator's. */
  readonly origin?: string;
  /** The RP ID it hashes; default the one in the options. */
  readonly rpId?: string;
  /** The client data type; default the ceremony's. */
  readonly type?: string;
  /** Replace the challenge (base64url). */
  readonly challenge?: string;
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
  /** UP; default true. */
  readonly userPresent?: boolean;
  /** UV; default true. */
  readonly userVerified?: boolean;
  /** BE; default true (a synced passkey). */
  readonly backupEligible?: boolean;
  /** BS; default true. */
  readonly backupState?: boolean;
  /** Reserved authenticator-data flag bits, for refusal tests. */
  readonly reservedFlags?: number;
  /** Leave the user handle out of an assertion. */
  readonly omitUserHandle?: boolean;
  /** Use this counter instead of the credential's next one. */
  readonly signCount?: number;
  /** Corrupt the signature. */
  readonly badSignature?: boolean;
}

/** Options for a {@link VirtualAuthenticator}. */
export interface VirtualAuthenticatorOptions extends AuthenticatorBehaviour {
  /** The origin its client runs on, such as `https://example.com`. */
  readonly origin: string;
  /** The key type for new credentials; default ES256 (-7). */
  readonly algorithm?: VirtualAlgorithm;
  /** Count signatures (a security key) instead of keeping 0 (a synced passkey). */
  readonly counter?: boolean;
  /** Attest with a packed self attestation instead of none. */
  readonly selfAttestation?: boolean;
  /** The AAGUID; default 16 zero bytes. */
  readonly aaguid?: Uint8Array;
}

/** A credential a {@link VirtualAuthenticator} holds. */
export interface VirtualCredential {
  readonly id: string;
  readonly rpId: string;
  /** Base64url. */
  readonly userHandle: string;
  readonly algorithm: VirtualAlgorithm;
  signCount: number;
  readonly privateKey: CryptoKey;
  readonly backupEligible: boolean;
}

/** `RegistrationResponseJSON`, as a browser's `toJSON()` makes it. */
export interface RegistrationResponseJSON {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly authenticatorData: string;
    readonly transports: readonly string[];
    readonly publicKeyAlgorithm: number;
  };
  readonly authenticatorAttachment: string;
  readonly clientExtensionResults: Record<string, unknown>;
}

/** `AuthenticationResponseJSON`, as a browser's `toJSON()` makes it. */
export interface AuthenticationResponseJSON {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string;
  };
  readonly authenticatorAttachment: string;
  readonly clientExtensionResults: Record<string, unknown>;
}

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(data)),
  );
}

/** An IEEE P1363 `r || s` ECDSA signature as ASN.1 DER. */
export function p1363ToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const half = raw.length / 2;
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = bytes.subarray(start);
    const body = trimmed[0] >= 0x80
      ? concat(new Uint8Array([0]), trimmed)
      : trimmed;
    return concat(new Uint8Array([0x02, body.length]), body);
  };
  const body = concat(
    integer(raw.subarray(0, half)),
    integer(raw.subarray(half)),
  );
  const length = body.length < 0x80
    ? new Uint8Array([body.length])
    : new Uint8Array([0x81, body.length]);
  return concat(new Uint8Array([0x30]), length, body);
}

async function newKey(algorithm: VirtualAlgorithm) {
  if (algorithm === -7) {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, fromBase64Url(jwk.x!)!],
      [-3, fromBase64Url(jwk.y!)!],
    ]);
    return { privateKey: pair.privateKey, cose };
  }
  if (algorithm === -8) {
    const pair = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    ) as CryptoKeyPair;
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", pair.publicKey),
    );
    const cose = new Map<number, number | Uint8Array>([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, raw],
    ]);
    return { privateKey: pair.privateKey, cose };
  }
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const cose = new Map<number, number | Uint8Array>([
    [1, 3],
    [3, -257],
    [-1, fromBase64Url(jwk.n!)!],
    [-2, fromBase64Url(jwk.e!)!],
  ]);
  return { privateKey: pair.privateKey, cose };
}

async function sign(
  algorithm: VirtualAlgorithm,
  key: CryptoKey,
  data: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = Uint8Array.from(data);
  if (algorithm === -7) {
    return p1363ToDer(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          bytes,
        ),
      ),
    );
  }
  const name = algorithm === -8 ? "Ed25519" : "RSASSA-PKCS1-v1_5";
  return new Uint8Array(await crypto.subtle.sign({ name }, key, bytes));
}

function flagsByte(
  behaviour: AuthenticatorBehaviour,
  backupEligible: boolean,
  attested: boolean,
): number {
  return (behaviour.userPresent === false ? 0 : 0x01) |
    (behaviour.userVerified === false ? 0 : 0x04) |
    (backupEligible ? 0x08 : 0) |
    ((behaviour.backupState ?? backupEligible) ? 0x10 : 0) |
    (attested ? 0x40 : 0) |
    ((behaviour.reservedFlags ?? 0) & 0x22);
}

function uint32(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/**
 * A software authenticator with a client in front of it: `create` and
 * `get` take the options JSON a relying party issues and return the
 * response JSON a browser would post back.
 */
export class VirtualAuthenticator {
  readonly #options: VirtualAuthenticatorOptions;
  readonly #credentials = new Map<string, VirtualCredential>();

  constructor(options: VirtualAuthenticatorOptions) {
    this.#options = options;
  }

  /** The credentials it holds, oldest first. */
  credentials(): readonly VirtualCredential[] {
    return [...this.#credentials.values()];
  }

  /** Forgets a credential, as deleting a passkey from a device would. */
  forget(id: string): void {
    this.#credentials.delete(id);
  }

  #clientData(
    type: string,
    challenge: string,
    behaviour: AuthenticatorBehaviour,
  ): Uint8Array<ArrayBuffer> {
    const crossOrigin = behaviour.crossOrigin ?? false;
    return encoder.encode(JSON.stringify({
      type: behaviour.type ?? type,
      challenge: behaviour.challenge ?? challenge,
      origin: behaviour.origin ?? this.#options.origin,
      crossOrigin,
      ...(behaviour.topOrigin === undefined
        ? {}
        : { topOrigin: behaviour.topOrigin }),
    }));
  }

  /** Answers `navigator.credentials.create()` for `options`. */
  async create(
    options: CreationOptionsJSON,
    overrides: AuthenticatorBehaviour = {},
  ): Promise<RegistrationResponseJSON> {
    const behaviour = { ...this.#options, ...overrides };
    const rpId = behaviour.rpId ?? options.rp.id;
    const offered = options.pubKeyCredParams.map((param) => param.alg);
    const algorithm = this.#options.algorithm ?? -7;
    if (!offered.includes(algorithm)) {
      throw new DOMException("no offered algorithm", "NotSupportedError");
    }
    for (const excluded of options.excludeCredentials) {
      if (this.#credentials.has(excluded.id)) {
        throw new DOMException("already registered", "InvalidStateError");
      }
    }
    const { privateKey, cose } = await newKey(algorithm);
    const id = crypto.getRandomValues(new Uint8Array(32));
    const idText = toBase64Url(id);
    const backupEligible = behaviour.backupEligible ?? true;
    const signCount = behaviour.signCount ?? 0;
    const coseBytes = encodeCbor(cose);
    const authData = concat(
      await sha256(encoder.encode(rpId)),
      new Uint8Array([flagsByte(behaviour, backupEligible, true)]),
      uint32(signCount),
      this.#options.aaguid ?? new Uint8Array(16),
      new Uint8Array([id.length >> 8, id.length & 255]),
      id,
      coseBytes,
    );
    const clientDataJSON = this.#clientData(
      "webauthn.create",
      options.challenge,
      behaviour,
    );
    let attStmt: Map<string, number | Uint8Array> = new Map();
    let fmt = "none";
    if (this.#options.selfAttestation) {
      fmt = "packed";
      attStmt = new Map<string, number | Uint8Array>([
        ["alg", algorithm],
        [
          "sig",
          await sign(
            algorithm,
            privateKey,
            concat(authData, await sha256(clientDataJSON)),
          ),
        ],
      ]);
    }
    const attestationObject = encodeCbor(
      new Map<string, string | Uint8Array | Map<string, number | Uint8Array>>([
        ["fmt", fmt],
        ["attStmt", attStmt],
        ["authData", authData],
      ]),
    );
    this.#credentials.set(idText, {
      id: idText,
      rpId,
      userHandle: options.user.id,
      algorithm,
      signCount: this.#options.counter ? signCount : 0,
      privateKey,
      backupEligible,
    });
    return {
      id: idText,
      rawId: idText,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        attestationObject: toBase64Url(attestationObject),
        authenticatorData: toBase64Url(authData),
        transports: ["hybrid", "internal"],
        publicKeyAlgorithm: algorithm,
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: { credProps: { rk: true } },
    };
  }

  /**
   * Answers `navigator.credentials.get()` for `options`: with the credential
   * `credentialId` names, else the first allowed one, else the newest for
   * the RP ID (as a user picking from a passkey list might).
   */
  async get(
    options: RequestOptionsJSON,
    overrides: AuthenticatorBehaviour & { readonly credentialId?: string } = {},
  ): Promise<AuthenticationResponseJSON> {
    const behaviour = { ...this.#options, ...overrides };
    const allowed = options.allowCredentials.map((credential) => credential.id);
    const candidates = [...this.#credentials.values()].filter((credential) =>
      credential.rpId === options.rpId &&
      (allowed.length === 0 || allowed.includes(credential.id))
    );
    const credential = overrides.credentialId === undefined
      ? candidates.at(allowed.length === 0 ? -1 : 0)
      : this.#credentials.get(overrides.credentialId);
    if (credential === undefined) {
      throw new DOMException("no credential", "NotAllowedError");
    }
    if (this.#options.counter) credential.signCount++;
    const signCount = behaviour.signCount ?? credential.signCount;
    const authData = concat(
      await sha256(encoder.encode(behaviour.rpId ?? options.rpId)),
      new Uint8Array([
        flagsByte(
          behaviour,
          overrides.backupEligible ?? credential.backupEligible,
          false,
        ),
      ]),
      uint32(signCount),
    );
    const clientDataJSON = this.#clientData(
      "webauthn.get",
      options.challenge,
      behaviour,
    );
    const signature = await sign(
      credential.algorithm,
      credential.privateKey,
      concat(authData, await sha256(clientDataJSON)),
    );
    if (behaviour.badSignature) signature[signature.length - 1] ^= 1;
    return {
      id: credential.id,
      rawId: credential.id,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(signature),
        ...(behaviour.omitUserHandle
          ? {}
          : { userHandle: credential.userHandle }),
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }
}

/**
 * A {@link PasskeyStore} in memory, with the same rules as the Durable
 * Object's (it runs the same {@link DirectoryCore}), copying what goes in
 * and out as RPC would.
 */
export function memoryPasskeyStore(
  options: { readonly now?: () => number } = {},
): PasskeyStore & { readonly tables: MemoryTables } {
  const tables = new MemoryTables();
  const core = new DirectoryCore(tables, options.now);
  const call = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(structuredClone(fn()));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return {
    tables,
    user: (handle) => call(() => core.user(handle)),
    userByPrincipal: (key) => call(() => core.userByPrincipal(key)),
    credential: (id) => call(() => core.credential(id)),
    credentials: (handle) => call(() => core.credentials(handle)),
    register: (registration) =>
      call(() => core.register(structuredClone(registration))),
    authenticate: (authentication) =>
      call(() => core.authenticate(structuredClone(authentication))),
    rename: (handle, id, name) => call(() => core.rename(handle, id, name)),
    remove: (handle, id, options) =>
      call(() => core.remove(handle, id, structuredClone(options))),
  };
}
