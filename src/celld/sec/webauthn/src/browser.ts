// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser half: {@link passkeyClient} runs the ceremonies against the
 * routes of `@celld/sec/webauthn/router`, and the JSON conversions it uses
 * are exported for pages that talk to their own endpoints.
 *
 * It runs in a page (it imports nothing from the Workers runtime). The
 * options' JSON is turned into `navigator.credentials` arguments by the
 * browser's own `parseCreationOptionsFromJSON` where there is one (Chrome
 * 129, Firefox 119, Safari 18.4) and by this module elsewhere; responses
 * likewise through `toJSON()`.
 *
 * ```ts
 * import { passkeyClient } from "@celld/sec/webauthn/browser";
 *
 * const passkeys = passkeyClient({ base: "/passkeys" });
 * await passkeys.signUp({ name: "ada@example.com" });
 * await passkeys.signIn(); // or signIn({ conditional: true }) for autofill
 * ```
 *
 * @module
 */

import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";

/** A JSON object as the server sends it. */
type Json = Record<string, unknown>;

function decode(text: unknown, what: string): Uint8Array<ArrayBuffer> {
  const bytes = typeof text === "string" ? fromBase64Url(text) : null;
  if (bytes === null) throw new TypeError(`${what} is not base64url`);
  return bytes;
}

function descriptors(list: unknown): PublicKeyCredentialDescriptor[] {
  return (Array.isArray(list) ? list : []).map((item: Json) => ({
    type: "public-key",
    id: decode(item.id, "a credential ID"),
    ...(Array.isArray(item.transports)
      ? { transports: item.transports as AuthenticatorTransport[] }
      : {}),
  }));
}

interface PublicKeyCredentialStatic {
  parseCreationOptionsFromJSON?(
    json: unknown,
  ): PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?(
    json: unknown,
  ): PublicKeyCredentialRequestOptions;
  isConditionalMediationAvailable?(): Promise<boolean>;
  signalUnknownCredential?(options: {
    rpId: string;
    credentialId: string;
  }): Promise<void>;
  signalAllAcceptedCredentials?(options: {
    rpId: string;
    userId: string;
    allAcceptedCredentialIds: string[];
  }): Promise<void>;
}

function native(): PublicKeyCredentialStatic | undefined {
  return (globalThis as { PublicKeyCredential?: PublicKeyCredentialStatic })
    .PublicKeyCredential;
}

/** `PublicKeyCredentialCreationOptionsJSON` as `create()` takes it. */
export function creationOptionsFromJSON(
  json: Json,
): PublicKeyCredentialCreationOptions {
  const parse = native()?.parseCreationOptionsFromJSON;
  if (parse !== undefined) return parse(json);
  const user = json.user as Json;
  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: decode(json.challenge, "the challenge"),
    user: {
      id: decode(user.id, "the user handle"),
      name: user.name as string,
      displayName: user.displayName as string,
    },
    excludeCredentials: descriptors(json.excludeCredentials),
  };
}

/** `PublicKeyCredentialRequestOptionsJSON` as `get()` takes it. */
export function requestOptionsFromJSON(
  json: Json,
): PublicKeyCredentialRequestOptions {
  const parse = native()?.parseRequestOptionsFromJSON;
  if (parse !== undefined) return parse(json);
  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: decode(json.challenge, "the challenge"),
    allowCredentials: descriptors(json.allowCredentials),
  };
}

/** What a credential from `create()` or `get()` offers, structurally. */
export interface BrowserCredential {
  readonly id: string;
  readonly rawId: ArrayBuffer;
  readonly type: string;
  readonly authenticatorAttachment?: string | null;
  readonly response: {
    readonly clientDataJSON: ArrayBuffer;
    readonly attestationObject?: ArrayBuffer;
    readonly authenticatorData?: ArrayBuffer;
    readonly signature?: ArrayBuffer;
    readonly userHandle?: ArrayBuffer | null;
    getTransports?(): string[];
    getAuthenticatorData?(): ArrayBuffer;
    getPublicKeyAlgorithm?(): number;
  };
  getClientExtensionResults(): Record<string, unknown>;
  toJSON?(): Json;
}

function bytes(buffer: ArrayBuffer): string {
  return toBase64Url(new Uint8Array(buffer));
}

/** A credential from `create()` or `get()` as the JSON the server takes. */
export function credentialToJSON(credential: BrowserCredential): Json {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const response = credential.response;
  const common = {
    id: credential.id,
    rawId: bytes(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    // Extension outputs here carry no binary values (credProps is a boolean).
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  if (response.attestationObject !== undefined) {
    return {
      ...common,
      response: {
        clientDataJSON: bytes(response.clientDataJSON),
        attestationObject: bytes(response.attestationObject),
        transports: response.getTransports?.() ?? [],
        ...(response.getAuthenticatorData === undefined
          ? {}
          : { authenticatorData: bytes(response.getAuthenticatorData()) }),
        ...(response.getPublicKeyAlgorithm === undefined
          ? {}
          : { publicKeyAlgorithm: response.getPublicKeyAlgorithm() }),
      },
    };
  }
  return {
    ...common,
    response: {
      clientDataJSON: bytes(response.clientDataJSON),
      authenticatorData: bytes(response.authenticatorData!),
      signature: bytes(response.signature!),
      ...(response.userHandle
        ? { userHandle: bytes(response.userHandle) }
        : {}),
    },
  };
}

/** A refusal from the passkey routes, with the server's error code. */
export class PasskeyError extends Error {
  override readonly name = "PasskeyError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Options for {@link passkeyClient}. */
export interface PasskeyClientOptions {
  /** Where the routes are mounted; default `/passkeys`. */
  readonly base?: string;
  /** Default the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Default `navigator.credentials`. */
  readonly credentials?: {
    create(options: CredentialCreationOptions): Promise<unknown>;
    get(options: CredentialRequestOptions): Promise<unknown>;
  };
}

/** What a sign-up or sign-in returns. */
export interface SignedIn {
  readonly user: { readonly subject: string; readonly name: string };
  readonly credential: { readonly id: string };
}

/** A passkey as the account page lists it. */
export interface ListedPasskey {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly backupEligible: boolean;
  readonly backupState: boolean;
  readonly transports: readonly string[];
  readonly aaguid: string;
}

/**
 * The ceremonies against `@celld/sec/webauthn/router`'s routes. Every request
 * is same-origin with the page's cookies; a refusal throws
 * {@link PasskeyError}, and a browser that gives up (the user cancels)
 * throws its own `DOMException`.
 */
export function passkeyClient(options: PasskeyClientOptions = {}) {
  const base = (options.base ?? "/passkeys").replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const container = () =>
    options.credentials ??
      (globalThis as unknown as {
        navigator: {
          credentials: NonNullable<PasskeyClientOptions["credentials"]>;
        };
      }).navigator.credentials;

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Json | null> {
    const response = await doFetch(`${base}${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text === "" ? null : JSON.parse(text) as Json;
    if (!response.ok) {
      throw new PasskeyError(
        response.status,
        typeof json?.error === "string" ? json.error : "error",
        typeof json?.message === "string" ? json.message : response.statusText,
      );
    }
    return json;
  }

  async function create(path: string, input: Json): Promise<Json> {
    const json = await call("POST", `${path}/options`, input);
    const credential = await container().create({
      publicKey: creationOptionsFromJSON(json!),
    }) as BrowserCredential;
    return (await call(
      "POST",
      `${path}/verify`,
      credentialToJSON(credential),
    ))!;
  }

  return {
    /** Creates an account whose credential is a new passkey, and signs in. */
    async signUp(
      input: { name: string; displayName?: string },
    ): Promise<SignedIn> {
      return await create("/signup", input) as unknown as SignedIn;
    },

    /**
     * Signs in with any passkey for this site. With `conditional`, waits for
     * the user to pick one from the autofill of an input with
     * `autocomplete="username webauthn"`; abort `signal` to stop waiting
     * (and start again before the challenge expires, in 5 minutes by
     * default).
     */
    async signIn(
      input: { conditional?: boolean; signal?: AbortSignal } = {},
    ): Promise<SignedIn> {
      const json = (await call("POST", "/login/options", {}))!;
      const credential = await container().get({
        publicKey: requestOptionsFromJSON(json),
        ...(input.conditional ? { mediation: "conditional" } : {}),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }) as BrowserCredential;
      try {
        return (await call(
          "POST",
          "/login/verify",
          credentialToJSON(credential),
        )) as unknown as SignedIn;
      } catch (error) {
        // The server forgot this passkey: have the browser stop offering it.
        if (
          error instanceof PasskeyError && error.code === "unknown_credential"
        ) {
          await native()?.signalUnknownCredential?.({
            rpId: json.rpId as string,
            credentialId: credential.id,
          }).catch(() => {});
        }
        throw error;
      }
    },

    /** Adds a passkey to the signed-in account. */
    async add(
      input: { name?: string } = {},
    ): Promise<{ credential: { id: string } }> {
      return await create("/register", input) as unknown as {
        credential: { id: string };
      };
    },

    /**
     * The signed-in account's passkeys. With `signal`, also tells the
     * browser which of its passkeys are still valid, so ones deleted here
     * disappear from its lists.
     */
    async list(input: { signal?: boolean } = {}): Promise<ListedPasskey[]> {
      const json = (await call("GET", "/credentials"))!;
      const listed = json.credentials as ListedPasskey[];
      if (input.signal && typeof json.userHandle === "string") {
        await native()?.signalAllAcceptedCredentials?.({
          rpId: json.rpId as string,
          userId: json.userHandle,
          allAcceptedCredentialIds: listed.map((passkey) => passkey.id),
        }).catch(() => {});
      }
      return listed;
    },

    async rename(id: string, name: string): Promise<void> {
      await call("PATCH", `/credentials/${encodeURIComponent(id)}`, { name });
    },

    async remove(id: string): Promise<void> {
      await call("DELETE", `/credentials/${encodeURIComponent(id)}`);
    },

    /** Whether this browser can offer passkeys in an input's autofill. */
    async autofillAvailable(): Promise<boolean> {
      return await native()?.isConditionalMediationAvailable?.() ?? false;
    },
  };
}
