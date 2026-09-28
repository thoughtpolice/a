// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkeys for celld: a WebAuthn Level 3 relying party on WebCrypto, a
 * credential store, and (in the subpaths) a Durable Object, router routes,
 * a browser client and a software authenticator for tests.
 *
 * ```ts
 * import { RelyingParty } from "@celld/sec/webauthn";
 *
 * const rp = new RelyingParty({
 *   id: "example.com",
 *   origins: ["https://example.com"],
 * });
 * const { options, challenge } = rp.authenticationOptions();
 * // ... the browser signs; its response comes back ...
 * const result = await rp.verifyAuthentication(response, { challenge, credential });
 * ```
 *
 * | Import | What it has |
 * | --- | --- |
 * | `@celld/sec/webauthn` | `RelyingParty`, the parsers, `PasskeyStore` and its records |
 * | `@celld/sec/webauthn/durable` | `PasskeyDirectory`, the Durable Object |
 * | `@celld/sec/webauthn/router` | `passkeyRoutes` for `@celld/web/router` |
 * | `@celld/sec/webauthn/browser` | `passkeyClient` and the JSON conversions, for pages |
 * | `@celld/sec/webauthn/testing` | `VirtualAuthenticator`, `memoryPasskeyStore` |
 *
 * @module
 */

export {
  type AttestedCredential,
  type AuthenticatorData,
  type AuthenticatorFlags,
  formatAaguid,
  MAX_CREDENTIAL_ID_BYTES,
  parseAuthenticatorData,
} from "./authdata.ts";
export {
  CborError,
  type CborInput,
  type CborMap,
  type CborValue,
  decodeCbor,
  type DecodeOptions,
  encodeCbor,
} from "./cbor.ts";
export {
  checkClientData,
  type ClientData,
  type ExpectedClientData,
  MAX_CLIENT_DATA_BYTES,
  parseClientData,
} from "./clientdata.ts";
export {
  type DirectoryNamespace,
  durablePasskeys,
  type DurablePasskeyScope,
  type PasskeyDirectoryApi,
} from "./client.ts";
export {
  type CoseAlgorithm,
  type CoseKey,
  DEFAULT_ALGORITHMS,
  derToP1363,
  importCoseKey,
  isSupportedAlgorithm,
  onCurve,
  parseCoseKey,
  verifySignature,
} from "./cose.ts";
export { WebAuthnError, type WebAuthnErrorCode } from "./errors.ts";
export {
  type CreationOptionsJSON,
  type CredentialDescriptor,
  type ExpectedAuthentication,
  type Hint,
  type Issued,
  type RegistrationInput,
  RelyingParty,
  type RelyingPartyOptions,
  type RequestOptionsJSON,
  type StoredCredential,
  type VerifiedAuthentication,
  type VerifiedRegistration,
} from "./rp.ts";
export {
  type AuthenticateResult,
  type Authentication,
  type ChallengeUse,
  checkCredentialName,
  type DirectoryTables,
  MAX_CREDENTIAL_NAME,
  MAX_CREDENTIALS_PER_USER,
  type PasskeyCredential,
  type PasskeyPrincipal,
  type PasskeyStore,
  type PasskeyUser,
  type RegisterResult,
  type Registration,
  type RemoveOptions,
  type RemoveResult,
  type UserVerificationInitialization,
} from "./store.ts";
