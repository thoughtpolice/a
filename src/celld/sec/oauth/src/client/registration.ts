// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Getting a client id at an authorization server:
 *
 * - {@link registerClient}: Dynamic Client Registration (RFC 7591).
 * - {@link clientMetadataDocument}: a Client ID Metadata Document, where
 *   the client's own HTTPS URL is its `client_id`
 *   (draft-ietf-oauth-client-id-metadata-document).
 * - {@link resolveClient}: the order a session tries them in: a
 *   pre-registered client for that issuer, a metadata document when the
 *   server supports them, a client registered earlier and kept in the
 *   store, then Dynamic Client Registration. Credentials are bound to the
 *   issuer that issued them and never offered to another; so are initial
 *   access tokens, which are looked up by the issuer being registered at.
 *
 * @module
 */

import { EgressError } from "@celld/http/egress";
import { jsonSnapshot, strictRecord } from "@celld/core/bounds";
import { AUTH_METHODS, validateClientMetadata } from "../server/clients.ts";
import { GRANT_TYPES } from "../constants.ts";
import { checkSecureUrl, isIssuer, secureUrlProblem } from "../metadata.ts";
import {
  egressFetch,
  type EgressOptions,
  egressUrlProblem,
  metadataEgressPolicy,
} from "../egress.ts";
import { OAuthError, ProtocolError } from "../errors.ts";
import type {
  AuthorizationServerMetadata,
  ClientMetadata,
} from "../metadata.ts";
import {
  type Clock,
  defaultClock,
  defaultFetch,
  type FetchLike,
  isLoopbackHost,
  isObject,
} from "../util.ts";
import type { ClientInformation, OAuthStore } from "./store.ts";
import { checkAuthorizationServerMetadata } from "./discovery.ts";

/**
 * Checks a Client ID Metadata Document URL: `https:` with a path, no
 * fragment, no user information, no dot segments.
 */
export function checkClientIdUrl(clientId: string): URL {
  if (
    typeof clientId !== "string" || clientId.length > 4096 ||
    secureUrlProblem(clientId) !== null
  ) {
    throw new OAuthError(
      "registration",
      "client metadata document URL is invalid",
    );
  }
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError("registration", `${clientId} is not a URL`);
  }
  if (
    url.protocol !== "https:" || url.pathname === "/" || url.hash !== "" ||
    clientId.includes("#") || url.username !== "" || url.password !== "" ||
    /\/\.\.?(\/|$)/.test(clientId.replace(/^https:\/\/[^/]*/, ""))
  ) {
    throw new OAuthError(
      "registration",
      `a client metadata document URL must be https with a path: ${clientId}`,
    );
  }
  return url;
}

/**
 * The document to serve at `client_id` as a Client ID Metadata Document,
 * with a public client's defaults (`none`, code and refresh grants).
 * `client_id` must be the exact URL it is served at.
 */
export function clientMetadataDocument(
  document: ClientMetadata & {
    readonly client_id: string;
    readonly client_name: string;
    readonly redirect_uris: readonly string[];
  },
): ClientMetadata & { readonly client_id: string } {
  document = jsonSnapshot(document, { maxBytes: 5120 });
  checkClientIdUrl(document.client_id);
  if (document.redirect_uris.length === 0) {
    throw new OAuthError("registration", "redirect_uris must not be empty");
  }
  if (
    ["client_secret", "client_secret_hash", "registration_access_token"].some((
      name,
    ) => Object.hasOwn(document, name))
  ) {
    throw new OAuthError(
      "registration",
      "a metadata document is public; it cannot carry a client_secret",
    );
  }
  const result = {
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...document,
  };
  const checked = validateClientMetadata(result, {
    authMethods: ["none", "private_key_jwt"],
    grantTypes: Object.values(GRANT_TYPES),
    network: "any",
  });
  return jsonSnapshot({ ...result, ...checked });
}

function nativeRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return isLoopbackHost(url.hostname);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The `application_type` for these redirect URIs: `native` when every one
 * is loopback or a private-use scheme, else `web`.
 */
export function applicationTypeFor(
  redirectUris: readonly string[],
): "native" | "web" {
  return redirectUris.length > 0 && redirectUris.every(nativeRedirect)
    ? "native"
    : "web";
}

/** Options for {@link registerClient}. */
export interface RegisterOptions extends EgressOptions {
  /**
   * RFC 7591 section 3: a bearer token the server may require. It is sent
   * to `endpoint` and nowhere else; the caller must know that endpoint
   * belongs to the issuer the token is for ({@link resolveClient} looks
   * the token up by issuer).
   */
  readonly initialAccessToken?: string;
  /** The issuer, for errors. */
  readonly issuer?: string;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

/**
 * Registers a client (RFC 7591 section 3.1). `application_type` defaults
 * from the redirect URIs, `token_endpoint_auth_method` to `none` (a public
 * client), and grant and response types to the code flow's. Returns the
 * issued identity. The request goes through `boundedFetch` (no redirects,
 * so the initial access token cannot be forwarded; 5 s; a 64 KiB answer;
 * public addresses, as `egress` adjusts it).
 */
export async function registerClient(
  endpoint: string,
  metadata: ClientMetadata,
  options: RegisterOptions = {},
): Promise<ClientInformation & { readonly metadata: ClientMetadata }> {
  strictRecord(options as unknown, [
    "egress",
    "allowLoopbackForDevelopment",
    "initialAccessToken",
    "issuer",
    "fetch",
    "signal",
  ], "registration options");
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new TypeError("registration fetch must be a function");
  }
  if (options.issuer !== undefined && !isIssuer(options.issuer)) {
    throw new TypeError("registration issuer is invalid");
  }
  if (
    options.initialAccessToken !== undefined &&
    (typeof options.initialAccessToken !== "string" ||
      options.initialAccessToken.length === 0 ||
      options.initialAccessToken.length > 16_384)
  ) throw new TypeError("initial access token length is invalid");
  metadata = jsonSnapshot(metadata);
  const redirectUris = metadata.redirect_uris ?? [];
  const body: Record<string, unknown> = {
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(redirectUris.length > 0
      ? { application_type: applicationTypeFor(redirectUris) }
      : {}),
    ...metadata,
  };
  try {
    validateClientMetadata(body, {
      authMethods: AUTH_METHODS,
      grantTypes: Object.values(GRANT_TYPES),
      network: "any",
    });
  } catch (cause) {
    throw new OAuthError("registration", "registration metadata is invalid", {
      cause,
      error: cause instanceof ProtocolError
        ? cause.code
        : "invalid_client_metadata",
      issuer: options.issuer,
    });
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.initialAccessToken !== undefined) {
    headers.authorization = `Bearer ${options.initialAccessToken}`;
  }
  const policy = metadataEgressPolicy(options);
  const problem = egressUrlProblem(endpoint, policy);
  if (problem !== null) {
    throw new OAuthError(
      "registration",
      `the registration endpoint ${problem}`,
      { issuer: options.issuer },
    );
  }
  const post = egressFetch(policy, options.fetch ?? defaultFetch);
  let status: number;
  let json: Record<string, unknown> | null;
  try {
    const response = await post(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    status = response.status;
    try {
      const parsed = await response.json();
      json = isObject(parsed) ? parsed : null;
    } catch (cause) {
      if (!(cause instanceof EgressError && cause.code === "json")) throw cause;
      json = null;
    }
  } catch (cause) {
    throw new OAuthError(
      cause instanceof EgressError && cause.code !== "fetch" &&
        cause.code !== "timeout"
        ? "registration"
        : "network",
      "could not reach the registration endpoint",
      { cause, issuer: options.issuer },
    );
  }
  if (
    status < 200 || status >= 300 || json === null ||
    typeof json.client_id !== "string" || json.client_id.length === 0 ||
    json.client_id.length > 4096
  ) {
    const error = typeof json?.error === "string" ? json.error : null;
    const description = typeof json?.error_description === "string"
      ? json.error_description
      : null;
    throw new OAuthError(
      status >= 500 ? "network" : "registration",
      `dynamic client registration failed (${status})`,
      { status, error, description, issuer: options.issuer },
    );
  }
  const answer = json;
  const method = answer.token_endpoint_auth_method ??
    body.token_endpoint_auth_method;
  if (
    typeof method !== "string" ||
    !["none", "client_secret_basic", "client_secret_post", "private_key_jwt"]
      .includes(method) ||
    method !== body.token_endpoint_auth_method ||
    (answer.client_secret_expires_at !== undefined &&
      (typeof answer.client_secret_expires_at !== "number" ||
        !Number.isSafeInteger(answer.client_secret_expires_at) ||
        answer.client_secret_expires_at < 0)) ||
    ((method === "client_secret_basic" || method === "client_secret_post") &&
      (typeof answer.client_secret !== "string" ||
        answer.client_secret.length === 0 ||
        answer.client_secret.length > 4096)) ||
    ((method === "none" || method === "private_key_jwt") &&
      answer.client_secret !== undefined)
  ) {
    throw new OAuthError(
      "registration",
      "the registration response violates the requested credential policy",
    );
  }
  const grantTypes = body.grant_types as readonly string[];
  const checked = validateClientMetadata({ ...body, ...answer }, {
    authMethods: AUTH_METHODS.filter((value) => value === method),
    grantTypes,
    network: "any",
  });
  for (const name of ["redirect_uris", "response_types"] as const) {
    const requested = body[name] as readonly string[] | undefined;
    const returned = checked[name];
    if (
      returned !== undefined &&
      (!Array.isArray(returned) ||
        returned.some((value) => !requested?.includes(value)))
    ) {
      throw new OAuthError(
        "registration",
        "the registration response widened requested metadata",
      );
    }
  }
  for (
    const name of [
      "registration_access_token",
      "registration_client_uri",
    ] as const
  ) {
    if (
      answer[name] !== undefined &&
      (typeof answer[name] !== "string" || answer[name].length === 0 ||
        answer[name].length >
          (name === "registration_access_token" ? 16_384 : 4096))
    ) {
      throw new OAuthError(
        "registration",
        "invalid registration management credential",
      );
    }
  }
  if (answer.registration_client_uri !== undefined) {
    const uri = checkSecureUrl(
      answer.registration_client_uri,
      "registration_client_uri",
    );
    if (uri.origin !== new URL(endpoint).origin) {
      throw new OAuthError(
        "registration",
        "registration management endpoint changed origin",
      );
    }
  }
  const string = (name: string) =>
    typeof answer[name] === "string" ? { [name]: answer[name] as string } : {};
  return jsonSnapshot({
    client_id: answer.client_id as string,
    token_endpoint_auth_method:
      typeof answer.token_endpoint_auth_method === "string"
        ? answer.token_endpoint_auth_method
        : body.token_endpoint_auth_method as string,
    source: "dynamic",
    ...string("client_secret"),
    ...string("registration_access_token"),
    ...string("registration_client_uri"),
    ...(typeof answer.client_secret_expires_at === "number"
      ? { client_secret_expires_at: answer.client_secret_expires_at }
      : {}),
    metadata: checked,
  });
}

/** How a session gets a client id. */
export interface RegistrationOptions extends EgressOptions {
  /** Pre-registered clients, by issuer. */
  readonly preregistered?:
    | Readonly<Record<string, ClientInformation>>
    | ((issuer: string) => ClientInformation | undefined);
  /** The HTTPS URL of this client's metadata document, used as `client_id`. */
  readonly metadataDocument?: string;
  /** Metadata for Dynamic Client Registration; omit (or false) to never register dynamically. */
  readonly dynamic?: ClientMetadata | false;
  /**
   * Initial access tokens (RFC 7591 section 3) for servers that require
   * one to register, by issuer: a map, or a function of the issuer. A
   * token is sent only to the registration endpoint of the issuer it is
   * listed under, never to a server a resource's metadata named instead.
   */
  readonly initialAccessTokens?:
    | Readonly<Record<string, string>>
    | ((issuer: string) => string | undefined);
}

/** Checks and snapshots a registration read from a host callback or store. */
export function checkClientInformation(
  value: ClientInformation,
): ClientInformation {
  strictRecord(value as unknown, [
    "client_id",
    "client_secret",
    "client_secret_expires_at",
    "token_endpoint_auth_method",
    "registration_access_token",
    "registration_client_uri",
    "source",
  ], "client information");
  const copy = jsonSnapshot(value);
  const method = copy.token_endpoint_auth_method ??
    (copy.client_secret === undefined ? "none" : "client_secret_basic");
  if (
    typeof copy.client_id !== "string" || copy.client_id.length === 0 ||
    copy.client_id.length > 4096 ||
    !(AUTH_METHODS as readonly unknown[]).includes(method)
  ) throw new TypeError("invalid client identity or authentication method");
  const secretMethod = method === "client_secret_basic" ||
    method === "client_secret_post";
  if (
    secretMethod !== (copy.client_secret !== undefined) ||
    (copy.client_secret !== undefined &&
      (typeof copy.client_secret !== "string" ||
        copy.client_secret.length === 0 || copy.client_secret.length > 4096)) ||
    (copy.client_secret_expires_at !== undefined &&
      (!Number.isSafeInteger(copy.client_secret_expires_at) ||
        copy.client_secret_expires_at < 0 ||
        (!secretMethod && copy.client_secret_expires_at !== 0)))
  ) {
    throw new TypeError(
      "client credentials do not match their authentication method",
    );
  }
  if (
    copy.source !== undefined &&
    !["preregistered", "metadata_document", "dynamic"].includes(copy.source)
  ) {
    throw new TypeError("invalid client information source");
  }
  if (copy.source === "metadata_document") checkClientIdUrl(copy.client_id);
  if (
    copy.registration_access_token !== undefined &&
    (typeof copy.registration_access_token !== "string" ||
      copy.registration_access_token.length === 0 ||
      copy.registration_access_token.length > 16_384)
  ) {
    throw new TypeError("invalid registration management credential");
  }
  if (copy.registration_client_uri !== undefined) {
    checkSecureUrl(copy.registration_client_uri, "registration_client_uri");
  }
  return Object.freeze({ ...copy, token_endpoint_auth_method: method });
}

/**
 * Synchronously checks all nested registration configuration. Host callback
 * answers are checked separately when called; no callback is invoked here.
 */
export function checkRegistrationOptions(options: RegistrationOptions): void {
  strictRecord(options as unknown, [
    "egress",
    "allowLoopbackForDevelopment",
    "preregistered",
    "metadataDocument",
    "dynamic",
    "initialAccessTokens",
  ], "client resolution options");
  metadataEgressPolicy(options);
  if (options.metadataDocument !== undefined) {
    checkClientIdUrl(options.metadataDocument);
  }
  for (
    const [name, entries] of [
      ["preregistered", options.preregistered],
      ["initialAccessTokens", options.initialAccessTokens],
    ] as const
  ) {
    if (entries === undefined || typeof entries === "function") continue;
    const copied = jsonSnapshot(entries);
    if (
      typeof copied !== "object" || copied === null || Array.isArray(copied)
    ) {
      throw new TypeError(`${name} must be an issuer-keyed record or callback`);
    }
    if (Object.keys(copied).length > 256) {
      throw new RangeError(`${name} has too many issuers`);
    }
    for (const [issuer, value] of Object.entries(copied)) {
      if (!isIssuer(issuer)) {
        throw new TypeError(`${name} key must be an issuer`);
      }
      if (name === "preregistered") {
        checkClientInformation(value as ClientInformation);
      } else checkInitialAccessToken(value);
    }
  }
  if (options.dynamic !== undefined && options.dynamic !== false) {
    const dynamic = jsonSnapshot(options.dynamic);
    if (!isObject(dynamic)) {
      throw new TypeError("dynamic must be client metadata or false");
    }
    // A session supplies its redirect URI later. Use an inert validation-only
    // placeholder when absent; it is never retained, registered or sent.
    const redirects = dynamic.redirect_uris ??
      ["https://client.invalid/callback"];
    validateClientMetadata({
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...dynamic,
      redirect_uris: redirects,
      application_type: dynamic.application_type ??
        (Array.isArray(redirects) &&
            redirects.every((uri) => typeof uri === "string")
          ? applicationTypeFor(redirects as string[])
          : "web"),
    }, {
      authMethods: AUTH_METHODS,
      grantTypes: Object.values(GRANT_TYPES),
      network: "any",
    });
  }
}

function checkInitialAccessToken(token: unknown): asserts token is string {
  if (
    typeof token !== "string" || token.length === 0 || token.length > 16_384
  ) {
    throw new TypeError(
      "initial access token must be a bounded nonempty string",
    );
  }
}

/** The initial access token for `issuer`, if `options` has one. */
function initialAccessTokenFor(
  options: RegistrationOptions,
  issuer: string,
): string | undefined {
  const tokens = options.initialAccessTokens;
  if (tokens === undefined) return undefined;
  const token = typeof tokens === "function"
    ? tokens(issuer)
    : Object.hasOwn(tokens, issuer)
    ? tokens[issuer]
    : undefined;
  if (token !== undefined) checkInitialAccessToken(token);
  return token;
}

/** What {@link resolveClient} needs besides the options. */
export interface ResolveContext {
  readonly metadata: AuthorizationServerMetadata;
  readonly redirectUris: readonly string[];
  readonly store: OAuthStore;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
  readonly now?: Clock;
}

/** A client id for the server in `context`, in the order of the module documentation. */
export async function resolveClient(
  options: RegistrationOptions,
  context: ResolveContext,
): Promise<ClientInformation> {
  checkRegistrationOptions(options);
  strictRecord(context as unknown, [
    "metadata",
    "redirectUris",
    "store",
    "fetch",
    "signal",
    "now",
  ], "client resolution context");
  const metadata = jsonSnapshot(context.metadata);
  const issuer = metadata.issuer;
  if (typeof checkAuthorizationServerMetadata(metadata, issuer) === "string") {
    throw new TypeError("client resolution metadata is invalid");
  }
  for (const name of ["fetch", "now"] as const) {
    if (context[name] !== undefined && typeof context[name] !== "function") {
      throw new TypeError(`client resolution ${name} must be a function`);
    }
  }
  const pre = typeof options.preregistered === "function"
    ? options.preregistered(issuer)
    : options.preregistered !== undefined &&
        Object.hasOwn(options.preregistered, issuer)
    ? options.preregistered[issuer]
    : undefined;
  if (pre !== undefined) {
    return Object.freeze({
      ...checkClientInformation(pre),
      source: "preregistered",
    });
  }

  if (
    options.metadataDocument !== undefined &&
    context.metadata.client_id_metadata_document_supported === true
  ) {
    checkClientIdUrl(options.metadataDocument);
    return Object.freeze({
      client_id: options.metadataDocument,
      token_endpoint_auth_method: "none",
      source: "metadata_document",
    });
  }

  const now = (context.now ?? defaultClock)();
  const reuse = async () => {
    const raw = await context.store.getClient(issuer);
    const stored = raw === undefined ? undefined : checkClientInformation(raw);
    return stored !== undefined &&
        !(stored.client_secret_expires_at !== undefined &&
          stored.client_secret_expires_at > 0 &&
          stored.client_secret_expires_at * 1000 <= now)
      ? stored
      : undefined;
  };
  const stored = await reuse();
  if (stored !== undefined) return stored;
  const registerDynamic = async (
    dynamic: ClientMetadata,
    endpoint: string,
  ): Promise<ClientInformation> => {
    const { metadata: _metadata, ...client } = await registerClient(
      endpoint,
      { redirect_uris: context.redirectUris, ...dynamic },
      {
        initialAccessToken: initialAccessTokenFor(options, issuer),
        issuer,
        fetch: context.fetch,
        signal: context.signal,
        ...(options.egress === undefined ? {} : { egress: options.egress }),
        ...(options.allowLoopbackForDevelopment === undefined ? {} : {
          allowLoopbackForDevelopment: options.allowLoopbackForDevelopment,
        }),
      },
    );
    await context.store.setClient(issuer, client);
    return client;
  };

  const dynamic = options.dynamic;
  const endpoint = context.metadata.registration_endpoint;
  if (dynamic !== undefined && dynamic !== false && endpoint !== undefined) {
    const register = async () => {
      // Under the store's lock, another session may have registered
      // first: adopt its client rather than make a second one.
      const again = await reuse();
      if (again !== undefined) return again;
      return await registerDynamic(dynamic, endpoint);
    };
    const store = context.store;
    return store.lock === undefined
      ? await register()
      : await store.lock<ClientInformation>(
        JSON.stringify(["client", issuer]),
        register,
      );
  }

  throw new OAuthError(
    "registration",
    `no way to get a client id at ${issuer}: no pre-registered client${
      options.metadataDocument === undefined
        ? ""
        : ", no client_id_metadata_document_supported"
    }${
      dynamic === undefined || dynamic === false
        ? ""
        : endpoint === undefined
        ? ", no registration_endpoint"
        : ""
    }`,
    { issuer },
  );
}
