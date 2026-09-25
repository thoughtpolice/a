// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/sec/oidc/testing`: OpenID Connect in one process.
 *
 * - {@link testBrowser}: a browser without a screen: follows redirects
 *   across origins, keeps cookies per origin, and stops at a URL prefix
 *   (a redirect URI) without requesting it.
 * - {@link testProvider}: an {@link OpenIdProvider} with a fresh ES256
 *   key, an in-memory store, a user table for claims, and consent that
 *   signs `user-1` in at once (or as the test decides).
 *
 * Use `@celld/sec/oauth/testing`'s `routeFetch` and `manualClock` alongside.
 * Everything keeps its state in memory; it is for tests and demos only.
 *
 * @module
 */

import type { Clock, FetchLike } from "@celld/sec/oauth";
import {
  generateSigningKey,
  type RecordStore,
  type SigningKey,
  unsafeMemoryRecordStore,
} from "@celld/sec/oauth/server";
import {
  type OidcAuthorizationContext,
  type OidcDecision,
  OpenIdProvider,
  type OpenIdProviderOptions,
  TEST_SESSION_SID_KEY,
  testSidKeys,
} from "./provider/provider.ts";

/** A fresh instance of {@link TEST_SESSION_SID_KEY} that `OpenIdProvider` accepts. */
function testSidKey(): Uint8Array {
  const key = new TextEncoder().encode(TEST_SESSION_SID_KEY);
  testSidKeys.add(key);
  return key;
}

/** A cookie-keeping, redirect-following user agent. */
export interface TestBrowser {
  /** Cookies by origin, `name=value`. */
  readonly cookies: Map<string, Map<string, string>>;
  /**
   * Requests `url` and follows redirects until one leads to a URL that
   * starts with `stop`, which it returns without requesting. Throws on a
   * response that is not a redirect, with its status and body.
   */
  navigate(url: string, stop: string): Promise<string>;
  /** One request with this browser's cookies for the origin; records any it sets. */
  request(url: string, init?: RequestInit): Promise<Response>;
}

/** A {@link TestBrowser} over `fetch`. */
export function testBrowser(fetch: FetchLike): TestBrowser {
  const cookies = new Map<string, Map<string, string>>();
  const jar = (origin: string) => {
    let entry = cookies.get(origin);
    if (entry === undefined) {
      entry = new Map();
      cookies.set(origin, entry);
    }
    return entry;
  };
  const request = async (url: string, init: RequestInit = {}) => {
    const origin = new URL(url).origin;
    const headers = new Headers(init.headers);
    const mine = [...jar(origin)].map(([name, value]) => `${name}=${value}`);
    if (mine.length > 0) headers.set("cookie", mine.join("; "));
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const gone = value === "" ||
        attributes.some((item) => /^\s*max-age=0\s*$/i.test(item));
      if (gone) jar(origin).delete(name);
      else jar(origin).set(name, value);
    }
    return response;
  };
  return {
    cookies,
    request,
    async navigate(url, stop) {
      let current = url;
      for (let hop = 0; hop < 20; hop++) {
        if (current.startsWith(stop)) return current;
        const response = await request(current);
        const location = response.headers.get("location");
        if (
          response.status < 300 || response.status >= 400 || location === null
        ) {
          throw new Error(
            `${current} answered ${response.status}: ${await response.text()}`,
          );
        }
        await response.body?.cancel();
        current = new URL(location, current).href;
      }
      throw new Error("too many redirects");
    },
  };
}

/** A user's claims, for {@link testProvider}'s claims hook. */
export type TestUsers = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** Options for {@link testProvider}. */
export type TestProviderOptions =
  & Partial<Omit<OpenIdProviderOptions, "interaction" | "claims">>
  & {
    readonly issuer: string;
    /** Claims by subject; default `user-1`, Ada Lovelace. */
    readonly users?: TestUsers;
    /** Decides each authorization; default signs `user-1` in now, with session `session-1`. */
    readonly consent?: (
      context: OidcAuthorizationContext,
    ) => OidcDecision | Response | Promise<OidcDecision | Response>;
  };

/** An in-memory provider and what it was built from. */
export interface TestProvider {
  readonly provider: OpenIdProvider;
  readonly store: RecordStore;
  readonly keys: readonly SigningKey[];
  /** Every authorization the consent hook saw. */
  readonly interactions: OidcAuthorizationContext[];
  /** The provider's handler, answering 404 for paths it does not serve. */
  readonly handle: (request: Request) => Promise<Response>;
}

/** The default users of {@link testProvider}. */
export const TEST_USERS: TestUsers = {
  "user-1": {
    name: "Ada Lovelace",
    given_name: "Ada",
    family_name: "Lovelace",
    email: "ada@example.com",
    email_verified: true,
    phone_number: "+1 555 0100",
    address: { country: "GB" },
  },
};

/**
 * The `sessionSidKey` of {@link testProvider} unless the test gives one.
 * It is public, so `OpenIdProvider` refuses it anywhere else.
 */
export { TEST_SESSION_SID_KEY };

/** An {@link OpenIdProvider} for tests; see the module documentation. */
export async function testProvider(
  options: TestProviderOptions,
): Promise<TestProvider> {
  const now: Clock = options.now ?? (() => Date.now());
  const keys = options.keys ?? [await generateSigningKey("ES256", "op-key")];
  const store = options.store ?? unsafeMemoryRecordStore({ now });
  const users = options.users ?? TEST_USERS;
  const interactions: OidcAuthorizationContext[] = [];
  const consent = options.consent ??
    (() => ({
      grant: {
        subject: "user-1",
        authTime: Math.floor(now() / 1000),
        sessionId: "session-1",
      },
    }));
  const provider = new OpenIdProvider({
    sessionSidKey: testSidKey(),
    ...Object.fromEntries(
      Object.entries(options).filter(([name]) =>
        name !== "users" && name !== "consent"
      ),
    ),
    issuer: options.issuer,
    keys,
    store,
    now,
    resources: options.resources ?? {},
    interaction: (context) => {
      interactions.push(context);
      return consent(context);
    },
    claims: ({ subject }) =>
      Object.hasOwn(users, subject) ? users[subject] : {},
  });
  return {
    provider,
    store,
    keys,
    interactions,
    handle: async (request) =>
      await provider.handle(request) ??
        new Response("not found", { status: 404 }),
  };
}
