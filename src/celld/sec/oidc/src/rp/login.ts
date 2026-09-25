// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link LoginFlow}: the redirect round trip of a login in a Worker, with
 * the pending login in a sealed, short-lived cookie instead of a store.
 *
 * ```ts
 * const flow = new LoginFlow({ client: rp, sealer });
 * // GET /login
 * return await flow.start(request, { scope: ["profile"], returnTo: "/account" });
 * // GET /callback
 * const { login, returnTo, clearCookie } = await flow.finish(request);
 * ```
 *
 * `start` answers a 303 to the provider and sets the cookie (the PKCE
 * verifier, `state`, `nonce` and `max_age`, sealed with a
 * {@link CookieSealer}, ten minutes). `finish` opens the cookie from the
 * same browser, which is what ties the callback to the browser that
 * started the login (login CSRF), and completes it with
 * `OidcClient.completeLogin`. The cookie is `SameSite=Lax`, which the
 * provider's top-level redirect back needs, and `HttpOnly`.
 *
 * @module
 */

import { OAuthError } from "@celld/sec/oauth";
import { safeInt, strictRecord } from "@celld/core/bounds";
import { redirectResponse, snapshotOptions } from "../util.ts";
import type {
  Login,
  LoginOptions,
  OidcClient,
  PendingLogin,
} from "./client.ts";
import {
  checkPendingCookies,
  clearCookie,
  type CookieSealer,
  readCookie,
  setCookie,
  transactionCookieName,
} from "./cookies.ts";

/** Options for {@link LoginFlow}. */
export interface LoginFlowOptions {
  readonly client: OidcClient;
  readonly sealer: CookieSealer;
  /**
   * Default `__Host-oidc-login`, or `oidc-login` when `secure` is false
   * (the `__Host-` prefix requires `Secure`).
   */
  readonly cookieName?: string;
  /** Mark the cookie `Secure`; default true. False only for `http:` on loopback. */
  readonly secure?: boolean;
  /** How long a login may take, in seconds; default 600. */
  readonly ttlSec?: number;
}

interface Pending {
  readonly login: PendingLogin;
  readonly returnTo?: string;
}

/** A finished login and what to answer the browser with. */
export interface FinishedLogin {
  readonly login: Login;
  /** The local path `start` was given, if any. */
  readonly returnTo?: string;
  /** A `Set-Cookie` value deleting the login cookie. */
  readonly clearCookie: string;
}

/** Whether `path` is a local path: `/...`, but not `//host` or `/\host`. */
export function isLocalPath(path: string): boolean {
  if (!/^\/(?![\/\\])/.test(path)) return false;
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/** The redirect round trip of a login; see the module documentation. */
export class LoginFlow {
  readonly #options: LoginFlowOptions;
  readonly cookieName: string;

  constructor(input: LoginFlowOptions) {
    strictRecord(
      input,
      ["client", "sealer", "cookieName", "secure", "ttlSec"],
      "LoginFlow options",
    );
    // Read once: `secure` and the cookie name cannot be changed afterwards.
    const options = snapshotOptions(input);
    this.#options = options;
    this.cookieName = options.cookieName ??
      ((options.secure ?? true) ? "__Host-oidc-login" : "oidc-login");
    safeInt(options.ttlSec ?? 600, { name: "ttlSec", min: 1, max: 600 });
    setCookie(this.cookieName, "", { secure: options.secure ?? true });
    Object.freeze(this);
  }

  /** Deletes exactly the callback's transaction, including on failed/expired completion. */
  async clearPendingCookie(request: Request): Promise<string | null> {
    const state = new URL(request.url).searchParams.get("state");
    if (state === null || state.length === 0 || state.length > 256) return null;
    return clearCookie(await transactionCookieName(this.cookieName, state), {
      secure: this.#options.secure ?? true,
    });
  }

  /**
   * Starts a login: a 303 to the provider's authorization URL with the
   * pending login sealed in the cookie. `returnTo` must be a local path.
   */
  async start(
    request: Request,
    options: LoginOptions & { readonly returnTo?: string } = {},
  ): Promise<Response> {
    checkPendingCookies(request, this.cookieName);
    if (options.returnTo !== undefined && !isLocalPath(options.returnTo)) {
      throw new TypeError("returnTo must be a local path");
    }
    const { returnTo, ...login } = options;
    const pending = await this.#options.client.authorizationUrl(login);
    const ttl = this.#options.ttlSec ?? 600;
    const value: Pending = {
      login: pending,
      ...(returnTo === undefined ? {} : { returnTo }),
    };
    const name = await transactionCookieName(
      this.cookieName,
      pending.authorization.state,
    );
    const sealed = await this.#options.sealer.seal(name, value, ttl);
    return redirectResponse(pending.authorization.url, {
      "set-cookie": setCookie(name, sealed, {
        maxAgeSec: ttl,
        secure: this.#options.secure ?? true,
      }),
    });
  }

  /**
   * Finishes a login at the redirect URI. Throws an `OAuthError`
   * (`state_mismatch`) when the browser has no pending login, and whatever
   * `completeLogin` throws otherwise. `callbackUrl` defaults to the
   * request's URL.
   */
  async finish(
    request: Request,
    options: { readonly callbackUrl?: string | URL } = {},
  ): Promise<FinishedLogin> {
    const state = new URL(options.callbackUrl ?? request.url).searchParams.get(
      "state",
    );
    const name = await transactionCookieName(this.cookieName, state ?? "");
    const pending = await this.#options.sealer.unseal<Pending>(
      name,
      readCookie(request.headers.get("cookie"), name),
    );
    if (pending === null) {
      throw new OAuthError(
        "state_mismatch",
        "this browser has no pending login (it expired, or began elsewhere)",
      );
    }
    const login = await this.#options.client.completeLogin(
      await this.#options.client.unsafeRestorePendingLogin(pending.login),
      options.callbackUrl ?? request.url,
    );
    return {
      login,
      ...(pending.returnTo === undefined ? {} : { returnTo: pending.returnTo }),
      clearCookie: clearCookie(name, {
        secure: this.#options.secure ?? true,
      }),
    };
  }
}
