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
 *   issuer that issued them and never offered to another.
 *
 * @module
 */

import { OAuthError } from "../errors.ts";
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
  readJsonObject,
} from "../util.ts";
import type { ClientInformation, OAuthStore } from "./store.ts";

/**
 * Checks a Client ID Metadata Document URL: `https:` with a path, no
 * fragment, no user information, no dot segments.
 */
export function checkClientIdUrl(clientId: string): URL {
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
  checkClientIdUrl(document.client_id);
  if (document.redirect_uris.length === 0) {
    throw new OAuthError("registration", "redirect_uris must not be empty");
  }
  if ("client_secret" in document) {
    throw new OAuthError(
      "registration",
      "a metadata document is public; it cannot carry a client_secret",
    );
  }
  return {
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...document,
  };
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
export interface RegisterOptions {
  /** RFC 7591 section 3: a bearer token the server may require. */
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
 * issued identity.
 */
export async function registerClient(
  endpoint: string,
  metadata: ClientMetadata,
  options: RegisterOptions = {},
): Promise<ClientInformation & { readonly metadata: ClientMetadata }> {
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
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.initialAccessToken !== undefined) {
    headers.authorization = `Bearer ${options.initialAccessToken}`;
  }
  let response: Response;
  try {
    response = await (options.fetch ?? defaultFetch)(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (cause) {
    throw new OAuthError(
      "network",
      `could not reach the registration endpoint: ${
        (cause as Error)?.message ?? cause
      }`,
      { cause, issuer: options.issuer },
    );
  }
  const json = await readJsonObject(response);
  if (!response.ok || json === null || typeof json.client_id !== "string") {
    const error = typeof json?.error === "string" ? json.error : null;
    const description = typeof json?.error_description === "string"
      ? json.error_description
      : null;
    throw new OAuthError(
      response.status >= 500 ? "network" : "registration",
      `dynamic client registration failed (${response.status}${
        error === null ? "" : ` ${error}`
      })${description === null ? "" : `: ${description}`}`,
      { status: response.status, error, description, issuer: options.issuer },
    );
  }
  const string = (name: string) =>
    typeof json[name] === "string" ? { [name]: json[name] as string } : {};
  return {
    client_id: json.client_id,
    token_endpoint_auth_method:
      typeof json.token_endpoint_auth_method === "string"
        ? json.token_endpoint_auth_method
        : body.token_endpoint_auth_method as string,
    source: "dynamic",
    ...string("client_secret"),
    ...string("registration_access_token"),
    ...string("registration_client_uri"),
    ...(typeof json.client_secret_expires_at === "number"
      ? { client_secret_expires_at: json.client_secret_expires_at }
      : {}),
    metadata: json as ClientMetadata,
  };
}

/** How a session gets a client id. */
export interface RegistrationOptions {
  /** Pre-registered clients, by issuer. */
  readonly preregistered?:
    | Readonly<Record<string, ClientInformation>>
    | ((issuer: string) => ClientInformation | undefined);
  /** The HTTPS URL of this client's metadata document, used as `client_id`. */
  readonly metadataDocument?: string;
  /** Metadata for Dynamic Client Registration; omit (or false) to never register dynamically. */
  readonly dynamic?: ClientMetadata | false;
  /** For servers that require one to register. */
  readonly initialAccessToken?: string;
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
  const issuer = context.metadata.issuer;
  const pre = typeof options.preregistered === "function"
    ? options.preregistered(issuer)
    : options.preregistered?.[issuer];
  if (pre !== undefined) return { ...pre, source: "preregistered" };

  if (
    options.metadataDocument !== undefined &&
    context.metadata.client_id_metadata_document_supported === true
  ) {
    checkClientIdUrl(options.metadataDocument);
    return {
      client_id: options.metadataDocument,
      token_endpoint_auth_method: "none",
      source: "metadata_document",
    };
  }

  const now = (context.now ?? defaultClock)();
  const stored = await context.store.getClient(issuer);
  if (
    stored !== undefined &&
    !(stored.client_secret_expires_at !== undefined &&
      stored.client_secret_expires_at > 0 &&
      stored.client_secret_expires_at * 1000 <= now)
  ) {
    return stored;
  }

  const dynamic = options.dynamic;
  const endpoint = context.metadata.registration_endpoint;
  if (dynamic !== undefined && dynamic !== false && endpoint !== undefined) {
    const { metadata: _metadata, ...client } = await registerClient(
      endpoint,
      { redirect_uris: context.redirectUris, ...dynamic },
      {
        initialAccessToken: options.initialAccessToken,
        issuer,
        fetch: context.fetch,
        signal: context.signal,
      },
    );
    await context.store.setClient(issuer, client);
    return client;
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
