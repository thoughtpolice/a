// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Clients, as the authorization server knows them: the
 * {@link RegisteredClient} record, where records come from (configured,
 * dynamically registered, or a Client ID Metadata Document), redirect URI
 * matching, validating registration metadata, and authenticating a client
 * at an endpoint.
 *
 * @module
 */

import { bytes } from "@celld/core/bounds";
import { boundedFetch, type EgressPolicy } from "@celld/http/egress";
import {
  type JwsAlgorithm,
  type KeySet,
  localJwks,
  publicVerificationKeys,
  RemoteJwks,
  tryDecode,
  verify,
} from "@celld/sec/jwt";
import { v } from "@celld/sieve";
import { JWT_BEARER_ASSERTION } from "../constants.ts";
import type { ReplayStore } from "../dpop/verify.ts";
import { egressUrlProblem, metadataEgressPolicy } from "../egress.ts";
import { ProtocolError } from "../errors.ts";
import {
  type ClientMetadata,
  redirectUriProblem,
  secureUrlProblem,
} from "../metadata.ts";
export { redirectUriProblem } from "../metadata.ts";
import {
  type Clock,
  type FetchLike,
  isObject,
  isScopeToken,
  parseBasicAuthorization,
  rethrowRuntimeUnsupported,
  sha256,
  snapshot,
  timingSafeEqual,
} from "../util.ts";
import { SIGNING_ALGORITHMS } from "./tokens.ts";
import { jsonSnapshot } from "@celld/core/bounds";

/** The client authentication methods the server implements. */
export type AuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post"
  | "private_key_jwt";

/** Every {@link AuthMethod}. */
export const AUTH_METHODS: readonly AuthMethod[] = Object.freeze([
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
]);

/** A client as configured or stored; {@link registeredClient} fills in the defaults. */
export interface ClientConfig extends ClientMetadata {
  readonly client_id: string;
  /** A configured client's secret, in plain text. */
  readonly client_secret?: string;
  /** A registered client's secret, as its SHA-256 (base64url). */
  readonly client_secret_hash?: string;
  /** Epoch seconds; 0 or absent for never. */
  readonly client_secret_expires_at?: number;
  readonly token_endpoint_auth_method?: AuthMethod;
  readonly redirect_uris?: readonly string[];
  readonly grant_types?: readonly string[];
  /** The scopes it may ask for, space-separated; absent for any the server supports. */
  readonly scope?: string;
  readonly client_id_issued_at?: number;
  /** Where the record came from. */
  readonly source?: "static" | "dynamic" | "metadata_document" | "resolved";
  /** Trusted resolver generation (for example a federation chain digest + expiry), never registration input. */
  readonly registration_generation?: string;
}

/** A client the server knows, with every default filled in. */
export interface RegisteredClient extends ClientConfig {
  readonly token_endpoint_auth_method: AuthMethod;
  readonly redirect_uris: readonly string[];
  readonly grant_types: readonly string[];
}

/** A configured client with its defaults: `client_secret_basic` with a secret, `private_key_jwt` with keys, else `none`; the code and refresh grants. */
export function registeredClient(config: ClientConfig): RegisteredClient {
  config = jsonSnapshot(config);
  if (
    typeof config.client_id !== "string" || config.client_id.length === 0 ||
    config.client_id.length > 4096
  ) throw new TypeError("client_id must be a nonempty bounded string");
  if (
    config.registration_generation !== undefined &&
    (typeof config.registration_generation !== "string" ||
      config.registration_generation.length === 0 ||
      config.registration_generation.length > 4096)
  ) {
    throw new TypeError(
      "registration_generation must be a bounded nonempty string",
    );
  }
  const method = config.token_endpoint_auth_method ??
    (config.client_secret !== undefined ||
        config.client_secret_hash !== undefined
      ? "client_secret_basic"
      : config.jwks !== undefined || config.jwks_uri !== undefined
      ? "private_key_jwt"
      : "none");
  const normalized = {
    ...config,
    token_endpoint_auth_method: method,
    grant_types: config.grant_types ?? ["authorization_code", "refresh_token"],
    redirect_uris: config.redirect_uris ?? [],
    source: config.source ?? "static",
  };
  const metadata = validateClientMetadata(normalized, {
    authMethods: AUTH_METHODS,
    grantTypes: [
      "authorization_code",
      "refresh_token",
      "client_credentials",
      "urn:ietf:params:oauth:grant-type:device_code",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ],
    network: "any",
  });
  const hasSecret = config.client_secret !== undefined ||
    config.client_secret_hash !== undefined;
  if (
    (method === "client_secret_basic" || method === "client_secret_post") !==
      hasSecret
  ) {
    throw new TypeError(
      "client credentials do not match its authentication method",
    );
  }
  if (
    config.client_secret !== undefined &&
    (typeof config.client_secret !== "string" ||
      config.client_secret.length === 0 || config.client_secret.length > 4096)
  ) throw new TypeError("invalid client secret");
  if (
    config.client_secret_expires_at !== undefined &&
    (!Number.isSafeInteger(config.client_secret_expires_at) ||
      config.client_secret_expires_at < 0)
  ) throw new TypeError("invalid client secret expiry");
  if (
    config.client_secret_hash !== undefined &&
    (typeof config.client_secret_hash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(config.client_secret_hash))
  ) throw new TypeError("invalid client secret hash");
  if (
    config.client_secret !== undefined &&
    config.client_secret_hash !== undefined
  ) throw new TypeError("choose a client secret or its hash, not both");
  return snapshot({ ...normalized, ...metadata });
}

/**
 * `client` as the server shows it outside client authentication (to
 * hooks, `AuthorizationServer.client`, grant records): a frozen copy
 * without `client_secret` or `client_secret_hash`.
 */
export function clientView(client: RegisteredClient): RegisteredClient {
  const {
    client_secret: _secret,
    client_secret_hash: _hash,
    ...visible
  } = client;
  return snapshot(visible);
}

/** Whether a client is confidential: it authenticates with something only it has. */
export function isConfidential(client: RegisteredClient): boolean {
  return client.token_endpoint_auth_method !== "none";
}

const LOOPBACK_LITERAL = /^(127(\.\d{1,3}){3}|\[::1\])$/;

/**
 * Whether `requested` matches a registered redirect URI: exactly, by
 * simple string comparison, except that a registered loopback IP literal
 * URI (`http://127.0.0.1/cb`, `http://[::1]/cb`) accepts any port, as RFC
 * 8252 section 7.3 and OAuth 2.1 require for native apps. `localhost` gets
 * no such allowance.
 */
export function redirectUriMatches(
  registered: readonly string[],
  requested: string,
): boolean {
  if (registered.includes(requested)) return true;
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return false;
  }
  if (
    url.protocol !== "http:" || !LOOPBACK_LITERAL.test(url.hostname) ||
    url.href !== requested
  ) {
    return false;
  }
  const withoutPort = (u: URL) =>
    `${u.protocol}//${u.hostname}${u.pathname}${u.search}`;
  return registered.some((uri) => {
    try {
      const candidate = new URL(uri);
      return candidate.href === uri && candidate.hash === "" &&
        withoutPort(candidate) === withoutPort(url);
    } catch {
      return false;
    }
  });
}

/** The most keys a client's registered `jwks` may hold. */
export const MAX_CLIENT_KEYS = 64;

/**
 * The egress policy for what the server fetches because a client said so
 * (`jwks_uri`, Client ID Metadata Documents): https only, no redirects, a
 * 5 s deadline, 64 KiB, and public addresses only. An operator's
 * `egress` option is merged over it.
 */
export function clientEgressPolicy(
  override: Partial<EgressPolicy> = {},
): EgressPolicy {
  return metadataEgressPolicy({ egress: override }, {
    json: { maxDepth: 8, maxKeys: 128, maxItems: 256 },
  });
}

const ClientMetadataSchema = v.looseObject({
  redirect_uris: v.array(v.string()).optional(),
  token_endpoint_auth_method: v.string().optional(),
  grant_types: v.array(v.string()).optional(),
  response_types: v.array(v.string()).optional(),
  client_name: v.string().max(200).optional(),
  client_uri: v.string().optional(),
  logo_uri: v.string().optional(),
  scope: v.string().optional(),
  contacts: v.array(v.string()).optional(),
  tos_uri: v.string().optional(),
  policy_uri: v.string().optional(),
  jwks_uri: v.string().optional(),
  jwks: v.looseObject({ keys: v.array(v.looseObject({})) }).optional(),
  software_id: v.string().optional(),
  software_version: v.string().optional(),
  application_type: v.enum(["web", "native"]).optional(),
  dpop_bound_access_tokens: v.boolean().optional(),
  require_pushed_authorization_requests: v.boolean().optional(),
});

/**
 * The client metadata members a registration keeps: RFC 7591 section 2,
 * `token_endpoint_auth_signing_alg`, `application_type` and the other
 * OpenID Connect Dynamic Client Registration 1.0 members (with the
 * logout specifications' URIs), RFC 9449's `dpop_bound_access_tokens` and
 * RFC 9126's `require_pushed_authorization_requests`.
 * {@link validateClientMetadata} drops every other member, as RFC 7591
 * section 2 has a server do with metadata it does not understand, and
 * with them the members the server assigns (`client_id`,
 * `client_secret`, `client_secret_expires_at`, `client_id_issued_at`,
 * `registration_access_token`), so a client never chooses its own id,
 * secret or expiry.
 */
const clientMetadataMembers = new Set([
  "redirect_uris",
  "token_endpoint_auth_method",
  "grant_types",
  "response_types",
  "client_name",
  "client_uri",
  "logo_uri",
  "scope",
  "contacts",
  "tos_uri",
  "policy_uri",
  "jwks_uri",
  "jwks",
  "software_id",
  "software_version",
  "token_endpoint_auth_signing_alg",
  "application_type",
  "sector_identifier_uri",
  "subject_type",
  "id_token_signed_response_alg",
  "id_token_encrypted_response_alg",
  "id_token_encrypted_response_enc",
  "userinfo_signed_response_alg",
  "userinfo_encrypted_response_alg",
  "userinfo_encrypted_response_enc",
  "request_object_signing_alg",
  "request_object_encryption_alg",
  "request_object_encryption_enc",
  "default_max_age",
  "require_auth_time",
  "default_acr_values",
  "initiate_login_uri",
  "request_uris",
  "post_logout_redirect_uris",
  "frontchannel_logout_uri",
  "frontchannel_logout_session_required",
  "backchannel_logout_uri",
  "backchannel_logout_session_required",
  "dpop_bound_access_tokens",
  "require_pushed_authorization_requests",
]);

/** Immutable view; no mutable Set escapes into client validation policy. */
export const CLIENT_METADATA_MEMBERS: ReadonlySet<string> = Object.freeze({
  get size() {
    return clientMetadataMembers.size;
  },
  has: (value: string) => clientMetadataMembers.has(value),
  keys: () => clientMetadataMembers.keys(),
  values: () => clientMetadataMembers.values(),
  entries: () => clientMetadataMembers.entries(),
  union: <U>(other: ReadonlySetLike<U>) => clientMetadataMembers.union(other),
  intersection: <U>(other: ReadonlySetLike<U>) =>
    clientMetadataMembers.intersection(other),
  difference: <U>(other: ReadonlySetLike<U>) =>
    clientMetadataMembers.difference(other),
  symmetricDifference: <U>(other: ReadonlySetLike<U>) =>
    clientMetadataMembers.symmetricDifference(other),
  isSubsetOf: (other: ReadonlySetLike<unknown>) =>
    clientMetadataMembers.isSubsetOf(other),
  isSupersetOf: (other: ReadonlySetLike<unknown>) =>
    clientMetadataMembers.isSupersetOf(other),
  isDisjointFrom: (other: ReadonlySetLike<unknown>) =>
    clientMetadataMembers.isDisjointFrom(other),
  [Symbol.iterator]: () => clientMetadataMembers[Symbol.iterator](),
  forEach: (
    callback: (value: string, value2: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown,
  ) =>
    clientMetadataMembers.forEach((v) =>
      callback.call(thisArg, v, v, CLIENT_METADATA_MEMBERS)
    ),
});

/** What a registration may use. */
export interface MetadataPolicy {
  readonly authMethods: readonly AuthMethod[];
  readonly grantTypes: readonly string[];
  readonly scopes?: readonly string[];
  /** The network a `jwks_uri` must be on; default `public`. */
  readonly network?: EgressPolicy["network"];
  /**
   * Whether a `jwks_uri` may be `http:` to a loopback IP literal (off the
   * public network), as the fetch policy allows; default false.
   */
  readonly allowCleartextLoopbackForDevelopment?: boolean;
}

/**
 * Validates client metadata for registration (RFC 7591 section 2), for
 * Dynamic Client Registration and Client ID Metadata Documents alike.
 * Throws `invalid_redirect_uri` or `invalid_client_metadata`
 * {@link ProtocolError}s. Returns the metadata with defaults filled in,
 * holding only the members in {@link CLIENT_METADATA_MEMBERS}.
 */
export function validateClientMetadata(
  body: unknown,
  policy: MetadataPolicy,
): ClientMetadata & {
  readonly token_endpoint_auth_method: AuthMethod;
  readonly grant_types: readonly string[];
  readonly redirect_uris: readonly string[];
  readonly application_type: "web" | "native";
} {
  const bad = (description: string) =>
    new ProtocolError("invalid_client_metadata", { description });
  try {
    body = jsonSnapshot(body);
  } catch {
    throw bad("metadata must be bounded plain JSON");
  }
  const parsed = ClientMetadataSchema.safeParse(body);
  if (!parsed.success) throw bad(parsed.error.message);
  const metadata = parsed.data;
  const method = (metadata.token_endpoint_auth_method ??
    "client_secret_basic") as AuthMethod;
  if (!policy.authMethods.includes(method)) {
    throw bad(`token_endpoint_auth_method ${method} is not supported`);
  }
  if (
    metadata.token_endpoint_auth_signing_alg !== undefined &&
    (!(SIGNING_ALGORITHMS as readonly unknown[]).includes(
      metadata.token_endpoint_auth_signing_alg,
    ) || method !== "private_key_jwt")
  ) {
    throw bad(
      "token_endpoint_auth_signing_alg requires a supported asymmetric private_key_jwt algorithm",
    );
  }
  const grants = metadata.grant_types ?? ["authorization_code"];
  if (
    grants.length > 16 ||
    new Set(grants).size !== grants.length
  ) throw bad("grant_types must be a unique bounded list");
  for (const grant of grants) {
    if (!policy.grantTypes.includes(grant)) {
      throw bad(`grant type ${grant} is not supported`);
    }
  }
  const responses = metadata.response_types ??
    (grants.includes("authorization_code") ? ["code"] : []);
  if (responses.some((type) => type !== "code")) {
    throw bad("only the code response type is supported");
  }
  if (responses.includes("code") !== grants.includes("authorization_code")) {
    throw bad("response_types and grant_types disagree");
  }
  const redirects = metadata.redirect_uris ?? [];
  if (redirects.length > 64 || new Set(redirects).size !== redirects.length) {
    throw bad("redirect_uris must be a unique bounded list");
  }
  const applicationType = metadata.application_type ?? "web";
  if (grants.includes("authorization_code") && redirects.length === 0) {
    throw new ProtocolError("invalid_redirect_uri", {
      description: "redirect_uris is required for the code grant",
    });
  }
  for (const uri of redirects) {
    const problem = redirectUriProblem(uri, applicationType);
    if (problem !== null) {
      throw new ProtocolError("invalid_redirect_uri", {
        description: `${uri} ${problem}`,
      });
    }
  }
  if (method === "private_key_jwt") {
    if ((metadata.jwks === undefined) === (metadata.jwks_uri === undefined)) {
      throw bad("private_key_jwt needs exactly one of jwks and jwks_uri");
    }
  }
  if (metadata.jwks_uri !== undefined) {
    const problem = egressUrlProblem(metadata.jwks_uri, {
      network: policy.network ?? "public",
      allowCleartextLoopbackForDevelopment:
        policy.allowCleartextLoopbackForDevelopment,
    });
    if (problem !== null) throw bad(`jwks_uri ${problem}`);
  }
  if (
    metadata.jwks !== undefined &&
    metadata.jwks.keys.length > MAX_CLIENT_KEYS
  ) {
    throw bad(`jwks may hold at most ${MAX_CLIENT_KEYS} keys`);
  }
  // Client metadata is public, so a symmetric or private key in it is no
  // secret, whatever it is for: private_key_jwt verifies asymmetric
  // signatures only. Encryption keys a client publishes alongside (for
  // encrypted responses) are skipped, not refused.
  if (metadata.jwks !== undefined) {
    let verification: readonly unknown[];
    try {
      verification = publicVerificationKeys(metadata.jwks.keys);
    } catch {
      throw bad(
        "jwks must hold only public keys, and valid signature-verification keys",
      );
    }
    if (method === "private_key_jwt" && verification.length === 0) {
      throw bad("jwks has no signature-verification key for private_key_jwt");
    }
  }
  if (metadata.scope !== undefined) {
    if (
      metadata.scope.length > 4096 || metadata.scope.split(" ").some((s) =>
        !isScopeToken(s) || s.length > 256
      ) ||
      new Set(metadata.scope.split(" ")).size !==
        metadata.scope.split(" ").length
    ) {
      throw bad("scope must contain unique bounded scope tokens");
    }
    for (
      const scope of metadata.scope.split(" ").filter((s) =>
        s !== ""
      )
    ) {
      if (!isScopeToken(scope)) throw bad(`bad scope ${scope}`);
      if (policy.scopes !== undefined && !policy.scopes.includes(scope)) {
        throw bad(`scope ${scope} is not supported`);
      }
    }
  }
  for (const name of ["client_uri", "logo_uri", "tos_uri", "policy_uri"]) {
    const value = (metadata as Record<string, unknown>)[name];
    if (typeof value === "string" && secureUrlProblem(value) !== null) {
      throw bad(`${name} must be an https URL`);
    }
  }
  const known: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(metadata)) {
    if (CLIENT_METADATA_MEMBERS.has(name)) {
      Object.defineProperty(known, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return {
    ...known,
    token_endpoint_auth_method: method,
    grant_types: grants,
    response_types: responses,
    redirect_uris: redirects,
    application_type: applicationType,
  } as ReturnType<typeof validateClientMetadata>;
}

/** The credentials a token-endpoint-style request presented. */
export interface PresentedCredentials {
  readonly method: AuthMethod;
  readonly clientId: string;
  readonly secret?: string;
  readonly assertion?: string;
}

/**
 * Reads how a request authenticates, refusing more than one method at
 * once (RFC 6749 section 2.3) and a `client_id` parameter that disagrees
 * with the credentials. Null when it presents none at all.
 */
export function presentedCredentials(
  request: Request,
  form: URLSearchParams,
): PresentedCredentials | null {
  const basic = parseBasicAuthorization(request.headers.get("authorization"));
  if (request.headers.has("authorization") && basic === null) {
    throw new ProtocolError("invalid_client", {
      description: "the Authorization header is not Basic credentials",
      headers: { "www-authenticate": 'Basic realm="oauth"' },
    });
  }
  const secret = form.get("client_secret");
  const assertion = form.get("client_assertion");
  const clientId = form.get("client_id");
  const used = [basic !== null, secret !== null, assertion !== null].filter(
    Boolean,
  ).length;
  if (used > 1) {
    throw new ProtocolError("invalid_request", {
      description: "use one client authentication method",
    });
  }
  for (
    const name of [
      "client_id",
      "client_secret",
      "client_assertion",
      "client_assertion_type",
    ]
  ) {
    if (form.getAll(name).length > 1) {
      throw new ProtocolError("invalid_request", {
        description: `${name} is repeated`,
      });
    }
  }
  if (basic !== null) {
    if (clientId !== null && clientId !== basic.clientId) {
      throw new ProtocolError("invalid_request", {
        description: "client_id does not match the credentials",
      });
    }
    return {
      method: "client_secret_basic",
      clientId: basic.clientId,
      secret: basic.secret,
    };
  }
  if (assertion !== null) {
    if (form.get("client_assertion_type") !== JWT_BEARER_ASSERTION) {
      throw new ProtocolError("invalid_client", {
        description: "unsupported client_assertion_type",
      });
    }
    const iss = tryDecode(assertion)?.payload.iss;
    if (typeof iss !== "string" || (clientId !== null && clientId !== iss)) {
      throw new ProtocolError("invalid_client", {
        description: "the client assertion's iss is not the client",
      });
    }
    return { method: "private_key_jwt", clientId: iss, assertion };
  }
  if (clientId === null) return null;
  if (secret !== null) {
    return { method: "client_secret_post", clientId, secret };
  }
  return { method: "none", clientId };
}

/** The longest a client assertion may live, in seconds. */
const MAX_ASSERTION_AGE = 300;
/** Clock skew allowed on a client assertion's times, in seconds. */
const ASSERTION_TOLERANCE = 5;

/** What {@link authenticateClient} checks assertions with. */
export interface AssertionContext {
  readonly issuer: string;
  /** Other audiences an assertion may name (the endpoint URL, for RFC 7523's form). */
  readonly extraAudiences: readonly string[];
  readonly replay: ReplayStore;
  readonly now: Clock;
  readonly algorithms: readonly JwsAlgorithm[];
  /** The keys of a client with a `jwks_uri`. */
  readonly remoteKeys: (uri: string) => KeySet;
}

/**
 * Checks presented credentials against the client's registration: the
 * method must be the registered one (no downgrade to `none`), secrets are
 * compared in constant time (a stored hash against the presented secret's
 * hash), an expired secret fails, and a `private_key_jwt` assertion must
 * be signed by the client's keys with `iss` and `sub` the client, `aud`
 * the issuer, an `iat` no more than five minutes old and not in the
 * future, an `exp` at most five minutes after `iat` and after now, and a
 * `jti` not seen before. Any failure is `invalid_client`.
 */
export async function authenticateClient(
  client: RegisteredClient,
  presented: PresentedCredentials,
  context: AssertionContext,
): Promise<void> {
  const refuse = (description: string) =>
    new ProtocolError("invalid_client", {
      description,
      headers: presented.method === "client_secret_basic"
        ? { "www-authenticate": 'Basic realm="oauth"' }
        : {},
    });
  if (presented.method !== client.token_endpoint_auth_method) {
    throw refuse(
      `the client authenticates with ${client.token_endpoint_auth_method}`,
    );
  }
  switch (presented.method) {
    case "none":
      return;
    case "client_secret_basic":
    case "client_secret_post": {
      const secret = presented.secret ?? "";
      const matches = client.client_secret_hash !== undefined
        ? timingSafeEqual(await sha256(secret), client.client_secret_hash)
        : client.client_secret !== undefined &&
          timingSafeEqual(secret, client.client_secret);
      if (!matches) throw refuse("bad client credentials");
      const expires = client.client_secret_expires_at ?? 0;
      if (expires > 0 && expires * 1000 <= context.now()) {
        throw refuse("the client secret has expired");
      }
      return;
    }
    case "private_key_jwt": {
      let keys: KeySet | null;
      try {
        keys = client.jwks !== undefined
          ? localJwks({ keys: publicVerificationKeys(client.jwks.keys) })
          : client.jwks_uri !== undefined
          ? context.remoteKeys(client.jwks_uri)
          : null;
      } catch {
        // A jwks_uri the egress policy refuses (stored before it did).
        throw refuse("the client's keys cannot be fetched");
      }
      if (keys === null) throw refuse("the client has no keys");
      let claims: Record<string, unknown>;
      try {
        ({ payload: claims } = await verify(presented.assertion!, keys, {
          // Never HS*: a client's registered keys are not a secret store.
          algorithms: context.algorithms.filter((alg) =>
            (SIGNING_ALGORITHMS as readonly string[]).includes(alg)
          ),
          issuer: client.client_id,
          subject: client.client_id,
          audience: [context.issuer, ...context.extraAudiences],
          requiredClaims: ["exp", "iat", "jti"],
          maxTokenAge: MAX_ASSERTION_AGE,
          clockTolerance: ASSERTION_TOLERANCE,
          now: context.now,
        }));
      } catch (cause) {
        rethrowRuntimeUnsupported(cause);
        throw refuse("the client assertion does not verify");
      }
      const exp = claims.exp as number;
      const iat = claims.iat as number;
      const nowSec = context.now() / 1000;
      if (
        typeof iat !== "number" || exp - iat > MAX_ASSERTION_AGE ||
        exp > nowSec + MAX_ASSERTION_AGE + ASSERTION_TOLERANCE
      ) {
        throw refuse("the client assertion lives too long");
      }
      if (typeof claims.jti !== "string" || claims.jti === "") {
        throw refuse("the client assertion has no jti");
      }
      const key = `assertion:${await sha256(
        `${client.client_id}\n${claims.jti}`,
      )}`;
      if ((await context.replay.claim(key, (exp + 5) * 1000)) !== true) {
        throw refuse("the client assertion has been used before");
      }
      return;
    }
  }
}

/** Options for {@link fetchClientMetadataDocument}. */
export interface MetadataDocumentOptions {
  readonly fetch: FetchLike;
  readonly policy: MetadataPolicy;
  /** Decides which URLs may be fetched, on top of the egress policy. */
  readonly allowUrl?: (url: URL) => boolean;
  /** Merged over {@link clientEgressPolicy}. */
  readonly egress?: Partial<EgressPolicy>;
}

/** The most bytes of a Client ID Metadata Document read. */
export const METADATA_DOCUMENT_MAX_BYTES = 5120;

/**
 * Fetches and validates a Client ID Metadata Document: `https:` with a
 * path, through `boundedFetch` under {@link clientEgressPolicy} (no
 * redirects, 5 s, public addresses only), at most 5 KiB read as a stream
 * whatever `Content-Length` says, `client_id` equal to the URL, no
 * secret, `none` or `private_key_jwt`. Null when it is not usable.
 */
export async function fetchClientMetadataDocument(
  clientId: string,
  options: MetadataDocumentOptions,
): Promise<RegisteredClient | null> {
  if (
    typeof clientId !== "string" || clientId.length > 4096 ||
    secureUrlProblem(clientId) !== null
  ) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  const egress = clientEgressPolicy({
    ...options.egress,
    maxBytes: bytes(METADATA_DOCUMENT_MAX_BYTES),
  });
  if (
    url.protocol !== "https:" || url.pathname === "/" || url.hash !== "" ||
    url.username !== "" || url.password !== "" ||
    egressUrlProblem(clientId, egress) !== null ||
    (options.allowUrl !== undefined && options.allowUrl(url) !== true)
  ) {
    return null;
  }
  const allowUrl = options.allowUrl;
  const get = boundedFetch(
    {
      ...egress,
      allow: (target, hop) =>
        egress.allow(target, hop) === true &&
        (allowUrl === undefined || allowUrl(target) === true),
    },
    (input, init) => options.fetch(input, init),
  );
  let body: unknown;
  try {
    const response = await get(url.href, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      await response.discard();
      return null;
    }
    body = await response.json();
  } catch {
    return null;
  }
  if (!isObject(body) || body.client_id !== clientId) return null;
  if ("client_secret" in body || "client_secret_expires_at" in body) {
    return null;
  }
  try {
    const metadata = validateClientMetadata(
      { token_endpoint_auth_method: "none", ...body },
      {
        ...options.policy,
        authMethods: options.policy.authMethods.filter((method) =>
          method === "none" || method === "private_key_jwt"
        ),
      },
    );
    return {
      ...metadata,
      client_id: clientId,
      source: "metadata_document",
    } as RegisteredClient;
  } catch {
    return null;
  }
}

/**
 * The key set cache for clients' `jwks_uri`s. Each is a `RemoteJwks`
 * under the egress policy (its default, public addresses only, with the
 * operator's `egress` over it), with at most {@link MAX_CLIENT_KEYS} keys.
 */
export function remoteKeyCache(
  fetch: FetchLike,
  now: Clock,
  egress: Partial<EgressPolicy> = {},
): (uri: string) => KeySet {
  const cache = new Map<string, RemoteJwks>();
  return (uri) => {
    let keys = cache.get(uri);
    if (keys === undefined) {
      keys = new RemoteJwks(uri, {
        fetch,
        now,
        maxKeys: MAX_CLIENT_KEYS,
        egress,
      });
      cache.set(uri, keys);
      if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    }
    return keys;
  };
}
