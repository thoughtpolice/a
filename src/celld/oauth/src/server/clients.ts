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

import {
  type JwsAlgorithm,
  type KeySet,
  localJwks,
  RemoteJwks,
  tryDecode,
  verify,
} from "@celld/jwt";
import { v } from "@celld/sieve";
import { JWT_BEARER_ASSERTION } from "../constants.ts";
import type { ReplayStore } from "../dpop/verify.ts";
import { ProtocolError } from "../errors.ts";
import { type ClientMetadata, secureUrlProblem } from "../metadata.ts";
import {
  type Clock,
  type FetchLike,
  isLoopbackHost,
  isObject,
  isScopeToken,
  parseBasicAuthorization,
  readJsonObject,
  rethrowRuntimeUnsupported,
  sha256,
  timingSafeEqual,
} from "../util.ts";

/** The client authentication methods the server implements. */
export type AuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post"
  | "private_key_jwt";

/** Every {@link AuthMethod}. */
export const AUTH_METHODS: readonly AuthMethod[] = [
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
];

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
}

/** A client the server knows, with every default filled in. */
export interface RegisteredClient extends ClientConfig {
  readonly token_endpoint_auth_method: AuthMethod;
  readonly redirect_uris: readonly string[];
  readonly grant_types: readonly string[];
}

/** A configured client with its defaults: `client_secret_basic` with a secret, `private_key_jwt` with keys, else `none`; the code and refresh grants. */
export function registeredClient(config: ClientConfig): RegisteredClient {
  const method = config.token_endpoint_auth_method ??
    (config.client_secret !== undefined ||
        config.client_secret_hash !== undefined
      ? "client_secret_basic"
      : config.jwks !== undefined || config.jwks_uri !== undefined
      ? "private_key_jwt"
      : "none");
  return {
    ...config,
    token_endpoint_auth_method: method,
    grant_types: config.grant_types ?? ["authorization_code", "refresh_token"],
    redirect_uris: config.redirect_uris ?? [],
    source: config.source ?? "static",
  };
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

const FORBIDDEN_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
  "about:",
]);

/**
 * Why a redirect URI cannot be registered, or null: it must be absolute
 * without a fragment; `https:`, `http:` on a loopback host, or (for a
 * native client) a private-use scheme; never `javascript:`, `data:` and
 * the like.
 */
export function redirectUriProblem(
  uri: string,
  applicationType: "web" | "native",
): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "is not an absolute URI";
  }
  if (url.hash !== "" || uri.includes("#")) return "has a fragment";
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return "uses a forbidden scheme";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    return isLoopbackHost(url.hostname)
      ? null
      : "uses http on a host that is not loopback";
  }
  if (applicationType === "native") {
    return url.protocol.includes(".")
      ? null
      : "a private-use scheme needs a reverse domain name";
  }
  return "uses a scheme a web client cannot";
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

/** What a registration may use. */
export interface MetadataPolicy {
  readonly authMethods: readonly AuthMethod[];
  readonly grantTypes: readonly string[];
  readonly scopes?: readonly string[];
}

/**
 * Validates client metadata for registration (RFC 7591 section 2), for
 * Dynamic Client Registration and Client ID Metadata Documents alike.
 * Throws `invalid_redirect_uri` or `invalid_client_metadata`
 * {@link ProtocolError}s. Returns the metadata with defaults filled in.
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
  const parsed = ClientMetadataSchema.safeParse(body);
  if (!parsed.success) throw bad(parsed.error.message);
  const metadata = parsed.data;
  const method = (metadata.token_endpoint_auth_method ??
    "client_secret_basic") as AuthMethod;
  if (!policy.authMethods.includes(method)) {
    throw bad(`token_endpoint_auth_method ${method} is not supported`);
  }
  const grants = metadata.grant_types ?? ["authorization_code"];
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
    const problem = secureUrlProblem(metadata.jwks_uri);
    if (problem !== null) throw bad(`jwks_uri ${problem}`);
  }
  if (metadata.scope !== undefined) {
    for (const scope of metadata.scope.split(" ").filter((s) => s !== "")) {
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
  return {
    ...metadata,
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
  for (const name of ["client_id", "client_secret", "client_assertion"]) {
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
 * the issuer, a lifetime of at most five minutes, and a `jti` not seen
 * before. Any failure is `invalid_client`.
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
      const keys = client.jwks !== undefined
        ? localJwks(client.jwks)
        : client.jwks_uri !== undefined
        ? context.remoteKeys(client.jwks_uri)
        : null;
      if (keys === null) throw refuse("the client has no keys");
      let claims: Record<string, unknown>;
      try {
        ({ payload: claims } = await verify(presented.assertion!, keys, {
          algorithms: context.algorithms,
          issuer: client.client_id,
          subject: client.client_id,
          audience: [context.issuer, ...context.extraAudiences],
          requiredClaims: ["exp", "jti"],
          clockTolerance: 5,
          now: context.now,
        }));
      } catch (cause) {
        rethrowRuntimeUnsupported(cause);
        throw refuse("the client assertion does not verify");
      }
      const exp = claims.exp as number;
      const nowSec = context.now() / 1000;
      if (exp - (typeof claims.iat === "number" ? claims.iat : nowSec) > 300) {
        throw refuse("the client assertion lives too long");
      }
      if (typeof claims.jti !== "string" || claims.jti === "") {
        throw refuse("the client assertion has no jti");
      }
      const key = `assertion:${await sha256(
        `${client.client_id}\n${claims.jti}`,
      )}`;
      if (!(await context.replay.claim(key, (exp + 5) * 1000))) {
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
  /** Decides which hosts may be fetched; default any (see the README on SSRF). */
  readonly allowUrl?: (url: URL) => boolean;
}

/**
 * Fetches and validates a Client ID Metadata Document: `https:` with a
 * path, no redirects followed, at most 5 KiB, `client_id` equal to the
 * URL, no secret, `none` or `private_key_jwt`. Null when it is not usable.
 */
export async function fetchClientMetadataDocument(
  clientId: string,
  options: MetadataDocumentOptions,
): Promise<RegisteredClient | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" || url.pathname === "/" || url.hash !== "" ||
    url.username !== "" || url.password !== "" ||
    (options.allowUrl !== undefined && !options.allowUrl(url))
  ) {
    return null;
  }
  let body: Record<string, unknown> | null;
  try {
    const response = await options.fetch(url.href, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > 5120) return null;
    body = await readJsonObject(response);
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

/** The key set cache for clients' `jwks_uri`s. */
export function remoteKeyCache(
  fetch: FetchLike,
  now: Clock,
): (uri: string) => KeySet {
  const cache = new Map<string, RemoteJwks>();
  return (uri) => {
    let keys = cache.get(uri);
    if (keys === undefined) {
      keys = new RemoteJwks(uri, { fetch, now });
      cache.set(uri, keys);
      if (cache.size > 1000) cache.delete(cache.keys().next().value!);
    }
    return keys;
  };
}
