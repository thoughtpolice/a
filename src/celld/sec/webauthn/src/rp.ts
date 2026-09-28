// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link RelyingParty}: the two WebAuthn ceremonies of Level 3, as a
 * relying party runs them: options to hand the browser, and the
 * verification of what it sends back (§7.1, §7.2).
 *
 * It keeps no state. Storing the challenge until the response arrives,
 * using it once, finding the credential and saving what changed are the
 * caller's (`@celld/sec/webauthn/router` does all of it over a
 * `PasskeyStore`).
 *
 * @module
 */

import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";
import {
  type AttestedCredential,
  type AuthenticatorData,
  formatAaguid,
  MAX_CREDENTIAL_ID_BYTES,
  parseAuthenticatorData,
} from "./authdata.ts";
import { CborError, type CborMap, decodeCbor } from "./cbor.ts";
import { checkClientData, parseClientData } from "./clientdata.ts";
import {
  type CoseAlgorithm,
  DEFAULT_ALGORITHMS,
  importCoseKey,
  isSupportedAlgorithm,
  parseCoseKey,
  verifySignature,
} from "./cose.ts";
import { WebAuthnError } from "./errors.ts";

/** Options for a {@link RelyingParty}. */
export interface RelyingPartyOptions {
  /**
   * The RP ID: the domain credentials are scoped to (`example.com`), which
   * every origin must be or be under, unless listed in `relatedOrigins`.
   */
  readonly id: string;
  /** Shown by some authenticators; default the ID (§5.4.1). */
  readonly name?: string;
  /**
   * The origins ceremonies may come from, exactly as browsers serialize
   * them: `https://host[:port]`, or `http://localhost[:port]` for
   * development.
   */
  readonly origins: readonly string[];
  /**
   * Origins on other domains that use this RP ID through Related Origin
   * Requests (§5.11); they must also be listed in the well-known document
   * (see `relatedOriginsDocument`).
   */
  readonly relatedOrigins?: readonly string[];
  /**
   * Pages allowed to embed a ceremony in a cross-origin frame, or `"any"`.
   * Default none: a ceremony in a cross-origin frame is refused.
   */
  readonly topOrigins?: readonly string[] | "any";
  /**
   * The algorithms offered, most preferred first; a credential with any
   * other is refused. Default EdDSA, ES256, RS256.
   */
  readonly algorithms?: readonly CoseAlgorithm[];
  /**
   * Whether ceremonies need user verification (a PIN or biometric). Default
   * `"required"`, so a passkey alone is two factors; `"preferred"` asks for
   * it but accepts a credential without it.
   */
  readonly userVerification?: "required" | "preferred";
  /**
   * Whether registrations ask for a discoverable credential (a passkey, which
   * signs in without a user name). Default `"required"`.
   */
  readonly residentKey?: "required" | "preferred" | "discouraged";
  /** How long a ceremony may take, 30 seconds to 10 minutes; default 5 minutes. */
  readonly timeoutMs?: number;
  /**
   * What to do when a credential's signature counter does not advance, a
   * sign the authenticator may be cloned (§6.1.1): `"reject"` (default)
   * refuses the sign-in, `"accept"` allows it and says so in the result.
   * Synced passkeys keep the counter at 0, which is never a regression.
   */
  readonly counterRegression?: "reject" | "accept";
}

/** A credential for `excludeCredentials` or `allowCredentials`. */
export interface CredentialDescriptor {
  /** The credential ID, base64url. */
  readonly id: string;
  readonly transports?: readonly string[];
}

/** `PublicKeyCredentialCreationOptionsJSON` (§5.4). */
export interface CreationOptionsJSON {
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly displayName: string;
  };
  readonly challenge: string;
  readonly pubKeyCredParams: readonly {
    readonly type: "public-key";
    readonly alg: number;
  }[];
  readonly timeout: number;
  readonly excludeCredentials: readonly {
    readonly type: "public-key";
    readonly id: string;
    readonly transports?: readonly string[];
  }[];
  readonly authenticatorSelection: {
    readonly residentKey: "required" | "preferred" | "discouraged";
    readonly requireResidentKey: boolean;
    readonly userVerification: "required" | "preferred";
    readonly authenticatorAttachment?: "platform" | "cross-platform";
  };
  readonly hints?: readonly string[];
  readonly attestation: "none";
  readonly extensions: { readonly credProps: true };
}

/** `PublicKeyCredentialRequestOptionsJSON` (§5.5). */
export interface RequestOptionsJSON {
  readonly challenge: string;
  readonly timeout: number;
  readonly rpId: string;
  readonly allowCredentials: readonly {
    readonly type: "public-key";
    readonly id: string;
    readonly transports?: readonly string[];
  }[];
  readonly userVerification: "required" | "preferred";
  readonly hints?: readonly string[];
}

/** A hint for which authenticator to offer first (§5.8.8). */
export type Hint = "security-key" | "client-device" | "hybrid";

/** What {@link RelyingParty.registrationOptions} needs. */
export interface RegistrationInput {
  readonly user: {
    /** The user handle: 1 to 64 bytes, random, no personal data (§14.6.1). */
    readonly id: Uint8Array;
    /** A name the user recognizes the account by (an email, a login). */
    readonly name: string;
    readonly displayName?: string;
  };
  /** The user's existing credentials, so an authenticator is not registered twice. */
  readonly exclude?: readonly CredentialDescriptor[];
  readonly hints?: readonly Hint[];
  readonly attachment?: "platform" | "cross-platform";
}

/** Options for the browser and the challenge to keep for the response. */
export interface Issued<T> {
  readonly options: T;
  /** The challenge, base64url: keep it (server-side or sealed) until the response. */
  readonly challenge: string;
}

/** A verified registration: what to store as the credential record (§4). */
export interface VerifiedRegistration {
  /** The credential ID, base64url. */
  readonly id: string;
  /** The COSE public key as the authenticator wrote it, base64url. */
  readonly publicKey: string;
  readonly algorithm: CoseAlgorithm;
  readonly signCount: number;
  /** Transports the browser reported, for later `allowCredentials`. */
  readonly transports: readonly string[];
  readonly backupEligible: boolean;
  readonly backupState: boolean;
  /** Whether the user was verified: the record's `uvInitialized`. */
  readonly userVerified: boolean;
  /** The authenticator model, as a UUID (all zeros when withheld). */
  readonly aaguid: string;
  readonly attestationFormat: "none" | "packed";
  /** `platform` or `cross-platform` when the browser said. */
  readonly authenticatorAttachment?: string;
  /** Whether the credential is discoverable, when the browser said (credProps). */
  readonly discoverable?: boolean;
}

/** A stored credential, as {@link RelyingParty.verifyAuthentication} needs it. */
export interface StoredCredential {
  /** Base64url. */
  readonly id: string;
  /** The user handle it was registered to, base64url. */
  readonly userHandle: string;
  /** The COSE public key, base64url. */
  readonly publicKey: string;
  readonly algorithm: number;
  readonly signCount: number;
  readonly backupEligible: boolean;
  /** Whether this RP has established that this credential's UV is trustworthy. */
  readonly uvInitialized: boolean;
}

/** What {@link RelyingParty.verifyAuthentication} checks against. */
export interface ExpectedAuthentication {
  /** The challenge issued with the options. */
  readonly challenge: string;
  /** The credential the response names (looked up by its `rawId`). */
  readonly credential: StoredCredential;
  /**
   * Whether the user was identified before the ceremony (a user name, an
   * existing session) rather than by the credential; then `allowCredentials`
   * were sent and the response need not carry a user handle. Default false:
   * a discoverable sign-in, which must carry one (§7.2 step 6).
   */
  readonly identified?: boolean;
  /** The IDs sent as `allowCredentials`, when any were. */
  readonly allowed?: readonly string[];
}

/** A verified sign-in: what to update in the credential record (§7.2 step 24). */
export interface VerifiedAuthentication {
  readonly credentialId: string;
  readonly userHandle: string;
  readonly signCount: number;
  readonly backupState: boolean;
  /**
   * Whether UV may be relied upon: the assertion set UV and the stored
   * credential's `uvInitialized` was already true.
   */
  readonly userVerified: boolean;
  /** The assertion's raw UV flag, even when it is not initialized yet. */
  readonly authenticatorUserVerified: boolean;
  /** The stored trust state used for this verification. */
  readonly uvInitialized: boolean;
  /**
   * True when the counter did not advance and `counterRegression` is
   * `"accept"`: worth an alert, since the authenticator may be cloned.
   */
  readonly counterRegressed: boolean;
}

const RP_ID =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TRANSPORT = /^[a-z0-9-]{1,32}$/;
const HINTS: readonly string[] = ["security-key", "client-device", "hybrid"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Bounds on what the browser sends, in bytes once decoded. */
const MAX_ATTESTATION_OBJECT = 32 * 1024;
const MAX_AUTHENTICATOR_DATA = 16 * 1024;
const MAX_SIGNATURE = 2048;

function checkOrigin(origin: unknown, rpId: string, related: boolean): string {
  if (typeof origin !== "string") {
    throw new TypeError("an origin must be a string");
  }
  if (related && origin.startsWith("android:apk-key-hash:")) return origin;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError(`${JSON.stringify(origin)} is not an origin`);
  }
  if (url.origin !== origin) {
    throw new TypeError(
      `write the origin as the browser does: ${
        JSON.stringify(url.origin)
      }, not ${JSON.stringify(origin)}`,
    );
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError(
      `${origin} is not https (plain http is only for localhost)`,
    );
  }
  const host = url.hostname;
  if (!related && host !== rpId && !host.endsWith(`.${rpId}`)) {
    throw new TypeError(
      `${origin} is not on ${rpId}; list it in relatedOrigins if it shares the RP ID`,
    );
  }
  return origin;
}

function descriptors(
  list: readonly CredentialDescriptor[] | undefined,
  what: string,
) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 64) {
    throw new TypeError(`${what} is a list of at most 64 credentials`);
  }
  return list.map((credential) => {
    const id = credential?.id;
    if (
      typeof id !== "string" ||
      fromBase64Url(id, MAX_CREDENTIAL_ID_BYTES) === null || id === ""
    ) {
      throw new TypeError(`${what}: a credential ID must be base64url`);
    }
    const transports = (credential.transports ?? []).filter((t: unknown) =>
      typeof t === "string" && TRANSPORT.test(t)
    );
    return Object.freeze({
      type: "public-key" as const,
      id,
      ...(transports.length === 0 ? {} : { transports }),
    });
  });
}

function hints(list: readonly Hint[] | undefined) {
  if (list === undefined) return {};
  if (!Array.isArray(list) || list.some((hint) => !HINTS.includes(hint))) {
    throw new TypeError(`hints are ${HINTS.join(", ")}`);
  }
  return { hints: [...new Set(list)] };
}

function invalid(message: string, cause?: unknown): WebAuthnError {
  return new WebAuthnError("invalid_response", message, { cause });
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function bytes(
  value: unknown,
  what: string,
  max: number,
): Uint8Array<ArrayBuffer> {
  const decoded = typeof value === "string" ? fromBase64Url(value, max) : null;
  if (decoded === null) {
    throw invalid(`${what} is not base64url of at most ${max} bytes`);
  }
  return decoded;
}

/** The credential's common JSON members (§5.1): `id`, `rawId`, `type`. */
function credentialId(response: Record<string, unknown>): string {
  const { id, rawId, type } = response;
  if (type !== "public-key") {
    throw invalid('the credential type is not "public-key"');
  }
  bytes(rawId, "rawId", MAX_CREDENTIAL_ID_BYTES);
  if (id !== rawId) throw invalid("the credential's id and rawId differ");
  return rawId as string;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(data)),
  );
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function randomChallenge(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * A WebAuthn relying party. Build one at startup; its methods keep no
 * state.
 *
 * ```ts
 * const rp = new RelyingParty({ id: "example.com", origins: ["https://example.com"] });
 * const { options, challenge } = rp.registrationOptions({ user: { id, name: "ada" } });
 * // ... the browser runs navigator.credentials.create(options) ...
 * const credential = await rp.verifyRegistration(response, { challenge });
 * ```
 */
export class RelyingParty {
  readonly id: string;
  readonly name: string;
  readonly origins: readonly string[];
  readonly relatedOrigins: readonly string[];
  readonly algorithms: readonly CoseAlgorithm[];
  readonly userVerification: "required" | "preferred";
  readonly residentKey: "required" | "preferred" | "discouraged";
  readonly timeoutMs: number;
  readonly counterRegression: "reject" | "accept";
  readonly #origins: ReadonlySet<string>;
  readonly #topOrigins: ReadonlySet<string> | "any";
  readonly #rpIdHash: Promise<Uint8Array<ArrayBuffer>>;

  /** Throws a `TypeError` or `RangeError` for a bad option. */
  constructor(options: RelyingPartyOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("RelyingParty takes an options object");
    }
    for (const key of Object.keys(options)) {
      if (
        ![
          "id",
          "name",
          "origins",
          "relatedOrigins",
          "topOrigins",
          "algorithms",
          "userVerification",
          "residentKey",
          "timeoutMs",
          "counterRegression",
        ].includes(key)
      ) {
        throw new TypeError(
          `RelyingParty has no option ${JSON.stringify(key)}`,
        );
      }
    }
    if (typeof options.id !== "string" || !RP_ID.test(options.id)) {
      throw new TypeError(
        `the RP ID must be a lower-case domain, got ${
          JSON.stringify(options.id)
        }`,
      );
    }
    this.id = options.id;
    const name = options.name ?? options.id;
    if (typeof name !== "string" || name === "" || name.length > 256) {
      throw new TypeError("the RP name must be 1 to 256 characters");
    }
    this.name = name;
    if (!Array.isArray(options.origins) || options.origins.length === 0) {
      throw new TypeError("a relying party needs at least one origin");
    }
    this.origins = Object.freeze(
      options.origins.map((origin) => checkOrigin(origin, this.id, false)),
    );
    this.relatedOrigins = Object.freeze(
      (options.relatedOrigins ?? []).map((origin) =>
        checkOrigin(origin, this.id, true)
      ),
    );
    this.#origins = new Set([...this.origins, ...this.relatedOrigins]);
    const top = options.topOrigins ?? [];
    this.#topOrigins = top === "any"
      ? "any"
      : new Set(top.map((origin) => checkOrigin(origin, this.id, true)));
    const algorithms = options.algorithms ?? DEFAULT_ALGORITHMS;
    if (
      !Array.isArray(algorithms) || algorithms.length === 0 ||
      algorithms.some((alg) => !isSupportedAlgorithm(alg)) ||
      new Set(algorithms).size !== algorithms.length
    ) {
      throw new TypeError(
        "algorithms must be distinct supported COSE algorithms (-8, -7, -257, ...)",
      );
    }
    this.algorithms = Object.freeze([...algorithms]);
    this.userVerification = options.userVerification ?? "required";
    if (!["required", "preferred"].includes(this.userVerification)) {
      throw new TypeError('userVerification is "required" or "preferred"');
    }
    this.residentKey = options.residentKey ?? "required";
    if (!["required", "preferred", "discouraged"].includes(this.residentKey)) {
      throw new TypeError(
        'residentKey is "required", "preferred" or "discouraged"',
      );
    }
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 30_000 ||
      this.timeoutMs > 600_000
    ) {
      throw new RangeError("timeoutMs must be 30000 to 600000");
    }
    this.counterRegression = options.counterRegression ?? "reject";
    if (!["reject", "accept"].includes(this.counterRegression)) {
      throw new TypeError('counterRegression is "reject" or "accept"');
    }
    this.#rpIdHash = sha256(new TextEncoder().encode(this.id));
  }

  /**
   * Options for `navigator.credentials.create()`, with a fresh challenge
   * and `attestation: "none"`: this library verifies self attestation at
   * most, and asking for more would only put identifying data in the way.
   */
  registrationOptions(input: RegistrationInput): Issued<CreationOptionsJSON> {
    const user = input?.user;
    if (
      !(user?.id instanceof Uint8Array) || user.id.length < 1 ||
      user.id.length > 64
    ) {
      throw new TypeError("the user handle must be 1 to 64 bytes");
    }
    if (
      typeof user.name !== "string" || user.name === "" ||
      user.name.length > 256
    ) {
      throw new TypeError("the user name must be 1 to 256 characters");
    }
    const displayName = user.displayName ?? user.name;
    if (typeof displayName !== "string" || displayName.length > 256) {
      throw new TypeError("the display name must be at most 256 characters");
    }
    if (
      input.attachment !== undefined &&
      !["platform", "cross-platform"].includes(input.attachment)
    ) {
      throw new TypeError('attachment is "platform" or "cross-platform"');
    }
    const challenge = randomChallenge();
    const options: CreationOptionsJSON = {
      rp: { id: this.id, name: this.name },
      user: { id: toBase64Url(user.id), name: user.name, displayName },
      challenge,
      pubKeyCredParams: this.algorithms.map((alg) => ({
        type: "public-key" as const,
        alg,
      })),
      timeout: this.timeoutMs,
      excludeCredentials: descriptors(input.exclude, "exclude"),
      authenticatorSelection: {
        residentKey: this.residentKey,
        requireResidentKey: this.residentKey === "required",
        userVerification: this.userVerification,
        ...(input.attachment === undefined
          ? {}
          : { authenticatorAttachment: input.attachment }),
      },
      ...hints(input.hints),
      attestation: "none",
      extensions: { credProps: true },
    };
    return { options, challenge };
  }

  /**
   * Options for `navigator.credentials.get()`. With no `allow` list the
   * browser offers every passkey for this RP ID (a discoverable sign-in,
   * which also serves conditional mediation); with one, only those.
   */
  authenticationOptions(
    input: {
      readonly allow?: readonly CredentialDescriptor[];
      readonly hints?: readonly Hint[];
    } = {},
  ): Issued<RequestOptionsJSON> {
    const challenge = randomChallenge();
    return {
      options: {
        challenge,
        timeout: this.timeoutMs,
        rpId: this.id,
        allowCredentials: descriptors(input.allow, "allow"),
        userVerification: this.userVerification,
        ...hints(input.hints),
      },
      challenge,
    };
  }

  async #checkAuthenticatorData(
    data: AuthenticatorData,
    requirePresence: boolean,
  ): Promise<void> {
    if (!equalBytes(data.rpIdHash, await this.#rpIdHash)) {
      throw new WebAuthnError(
        "rp_id_mismatch",
        `the credential is not scoped to ${this.id}`,
      );
    }
    if (requirePresence && !data.flags.userPresent) {
      throw new WebAuthnError(
        "user_not_present",
        "the authenticator did not test for a user",
      );
    }
    if (this.userVerification === "required" && !data.flags.userVerified) {
      throw new WebAuthnError(
        "user_not_verified",
        "user verification was required",
      );
    }
    if (data.flags.backupState && !data.flags.backupEligible) {
      throw new WebAuthnError(
        "backup_flags",
        "a credential cannot be backed up (BS) without being eligible (BE)",
      );
    }
  }

  #clientData(
    bytes: Uint8Array,
    type: "webauthn.create" | "webauthn.get",
    challenge: string,
  ): void {
    checkClientData(parseClientData(bytes), {
      type,
      challenge,
      origins: this.#origins,
      topOrigins: this.#topOrigins,
    });
  }

  /**
   * Verifies a `RegistrationResponseJSON` (§7.1). Everything that matters
   * comes from the signed-over attestation object, never from the
   * convenience members (`publicKey`, `authenticatorData`) the browser adds
   * beside it. Checking that the credential ID is new, and storing it, are
   * the caller's (§7.1 steps 26 and 29).
   *
   * @param expected.conditional the registration came from conditional
   * creation, which may skip the user-presence test (§7.1 step 15). It
   * cannot pass `userVerification: "required"`.
   */
  async verifyRegistration(
    response: unknown,
    expected: { readonly challenge: string; readonly conditional?: boolean },
  ): Promise<VerifiedRegistration> {
    const credential = record(response, "the registration");
    const rawId = credentialId(credential);
    const inner = record(credential.response, "the registration's response");
    const clientDataJSON = bytes(inner.clientDataJSON, "clientDataJSON", 16384);
    this.#clientData(clientDataJSON, "webauthn.create", expected.challenge);
    const attestation = bytes(
      inner.attestationObject,
      "attestationObject",
      MAX_ATTESTATION_OBJECT,
    );
    let object: CborMap;
    try {
      const decoded = decodeCbor(attestation).value;
      if (!(decoded instanceof Map)) throw invalid("not a map");
      object = decoded;
    } catch (cause) {
      if (cause instanceof WebAuthnError || cause instanceof CborError) {
        throw invalid("the attestation object is not a CBOR map", cause);
      }
      throw cause;
    }
    const fmt = object.get("fmt");
    const attStmt = object.get("attStmt");
    const authDataBytes = object.get("authData");
    if (
      typeof fmt !== "string" || !(attStmt instanceof Map) ||
      !(authDataBytes instanceof Uint8Array)
    ) {
      throw invalid("the attestation object lacks fmt, attStmt or authData");
    }
    const authData = parseAuthenticatorData(authDataBytes);
    await this.#checkAuthenticatorData(authData, expected.conditional !== true);
    const attested = authData.attestedCredential;
    if (attested === undefined) {
      throw invalid("the registration carries no attested credential");
    }
    if (!this.algorithms.includes(attested.publicKey.alg)) {
      throw new WebAuthnError(
        "unsupported_algorithm",
        `the credential uses algorithm ${attested.publicKey.alg}, which was not offered`,
      );
    }
    if (toBase64Url(attested.id) !== rawId) {
      throw invalid("the credential ID in the authenticator data is not rawId");
    }
    const format = await this.#verifyAttestation(
      fmt,
      attStmt,
      authDataBytes,
      clientDataJSON,
      attested,
    );
    const extensions = credential.clientExtensionResults;
    const credProps = typeof extensions === "object" && extensions !== null
      ? (extensions as Record<string, unknown>).credProps
      : undefined;
    const rk = typeof credProps === "object" && credProps !== null
      ? (credProps as Record<string, unknown>).rk
      : undefined;
    const attachment = credential.authenticatorAttachment;
    const transports = Array.isArray(inner.transports)
      ? [
        ...new Set(
          inner.transports.filter((t): t is string =>
            typeof t === "string" && TRANSPORT.test(t)
          ),
        ),
      ].sort().slice(0, 16)
      : [];
    return Object.freeze({
      id: rawId,
      publicKey: toBase64Url(attested.publicKeyBytes),
      algorithm: attested.publicKey.alg,
      signCount: authData.signCount,
      transports: Object.freeze(transports),
      backupEligible: authData.flags.backupEligible,
      backupState: authData.flags.backupState,
      userVerified: authData.flags.userVerified,
      aaguid: formatAaguid(attested.aaguid),
      attestationFormat: format,
      ...(attachment === "platform" || attachment === "cross-platform"
        ? { authenticatorAttachment: attachment }
        : {}),
      ...(typeof rk === "boolean" ? { discoverable: rk } : {}),
    });
  }

  async #verifyAttestation(
    fmt: string,
    attStmt: CborMap,
    authData: Uint8Array,
    clientDataJSON: Uint8Array,
    attested: AttestedCredential,
  ): Promise<"none" | "packed"> {
    if (fmt === "none") {
      if (attStmt.size !== 0) {
        throw invalid('a "none" attestation statement must be empty');
      }
      return "none";
    }
    if (fmt === "packed" && !attStmt.has("x5c")) {
      // Self attestation (§8.2): signed by the credential key itself.
      const alg = attStmt.get("alg");
      const sig = attStmt.get("sig");
      if (typeof alg !== "number" || !(sig instanceof Uint8Array)) {
        throw invalid("a packed attestation needs alg and sig");
      }
      if (alg !== attested.publicKey.alg) {
        throw invalid("a self attestation's alg must be the credential's");
      }
      const key = await importCoseKey(attested.publicKey);
      const signed = concat(authData, await sha256(clientDataJSON));
      if (!await verifySignature(attested.publicKey.alg, key, sig, signed)) {
        throw new WebAuthnError(
          "bad_signature",
          "the self attestation signature does not verify",
        );
      }
      return "packed";
    }
    throw new WebAuthnError(
      "unsupported_attestation",
      `attestation format ${JSON.stringify(fmt)}${
        fmt === "packed" ? " with a certificate" : ""
      } is not supported; the options asked for none`,
    );
  }

  /**
   * Verifies an `AuthenticationResponseJSON` (§7.2) against the stored
   * credential its `rawId` names. Saving the new counter and backup state,
   * and using the challenge up, are the caller's.
   */
  async verifyAuthentication(
    response: unknown,
    expected: ExpectedAuthentication,
  ): Promise<VerifiedAuthentication> {
    const credential = record(response, "the authentication");
    const rawId = credentialId(credential);
    const stored = expected.credential;
    if (rawId !== stored.id) {
      throw new WebAuthnError(
        "unknown_credential",
        "the response names another credential",
      );
    }
    if (
      expected.allowed !== undefined && expected.allowed.length > 0 &&
      !expected.allowed.includes(rawId)
    ) {
      throw new WebAuthnError(
        "unknown_credential",
        "the credential was not among those allowed",
      );
    }
    const inner = record(credential.response, "the authentication's response");
    const handle = inner.userHandle;
    if (handle !== undefined && handle !== null && handle !== "") {
      bytes(handle, "userHandle", 64);
      if (handle !== stored.userHandle) {
        throw new WebAuthnError(
          "user_handle_mismatch",
          "the credential belongs to another user",
        );
      }
    } else if (expected.identified !== true) {
      throw new WebAuthnError(
        "user_handle_mismatch",
        "a discoverable sign-in must carry the user handle",
      );
    }
    const clientDataJSON = bytes(inner.clientDataJSON, "clientDataJSON", 16384);
    this.#clientData(clientDataJSON, "webauthn.get", expected.challenge);
    const authDataBytes = bytes(
      inner.authenticatorData,
      "authenticatorData",
      MAX_AUTHENTICATOR_DATA,
    );
    const signature = bytes(inner.signature, "signature", MAX_SIGNATURE);
    const authData = parseAuthenticatorData(authDataBytes);
    if (authData.attestedCredential !== undefined) {
      throw invalid("an assertion must not carry attested credential data");
    }
    await this.#checkAuthenticatorData(authData, true);
    if (this.userVerification === "required" && !stored.uvInitialized) {
      throw new WebAuthnError(
        "user_not_verified",
        "the credential's user verification has not been independently initialized",
      );
    }
    if (authData.flags.backupEligible !== stored.backupEligible) {
      throw new WebAuthnError(
        "backup_flags",
        "the credential's backup eligibility changed since registration",
      );
    }
    let key;
    try {
      const decoded = decodeCbor(
        bytes(stored.publicKey, "the stored public key", 4096),
      ).value;
      const cose = parseCoseKey(decoded);
      if (cose.alg !== stored.algorithm) throw invalid("algorithm mismatch");
      key = { cose, crypto: await importCoseKey(cose) };
    } catch (cause) {
      throw new Error("the stored credential's public key is unusable", {
        cause,
      });
    }
    const signed = concat(authDataBytes, await sha256(clientDataJSON));
    if (!await verifySignature(key.cose.alg, key.crypto, signature, signed)) {
      throw new WebAuthnError(
        "bad_signature",
        "the assertion signature does not verify",
      );
    }
    const counted = authData.signCount !== 0 || stored.signCount !== 0;
    const regressed = counted && authData.signCount <= stored.signCount;
    if (regressed && this.counterRegression === "reject") {
      throw new WebAuthnError(
        "counter_regressed",
        `the signature counter went from ${stored.signCount} to ${authData.signCount}: the authenticator may be cloned`,
      );
    }
    return Object.freeze({
      credentialId: rawId,
      userHandle: stored.userHandle,
      signCount: regressed ? stored.signCount : authData.signCount,
      backupState: authData.flags.backupState,
      userVerified: authData.flags.userVerified && stored.uvInitialized,
      authenticatorUserVerified: authData.flags.userVerified,
      uvInitialized: stored.uvInitialized,
      counterRegressed: regressed,
    });
  }

  /**
   * The `/.well-known/webauthn` document for Related Origin Requests
   * (§5.11), served from `https://<RP ID>` as `application/json`: the
   * origins and related origins of this relying party.
   */
  relatedOriginsDocument(): { readonly origins: readonly string[] } {
    return Object.freeze({
      origins: Object.freeze([
        ...new Set(
          [...this.origins, ...this.relatedOrigins].filter((origin) =>
            origin.startsWith("https://")
          ),
        ),
      ]),
    });
  }
}
