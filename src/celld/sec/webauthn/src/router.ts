// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link passkeyRoutes}: the passkey ceremonies as `@celld/web/router`
 * routes, to mount under a prefix of an app whose auth includes a
 * `session()` scheme.
 *
 * | Route | Who | What |
 * | --- | --- | --- |
 * | `POST /signup/options`, `/signup/verify` | anyone, only with `signUp: true` and a limiter | a new account whose only credential is a passkey |
 * | `POST /login/options`, `/login/verify` | anyone | a discoverable sign-in (also for autofill) |
 * | `POST /register/options`, `/register/verify` | a signed-in user allowed by `authorizeRegistration` | another passkey for the same account |
 * | `GET /credentials` | a signed-in user | their passkeys and user handle |
 * | `PATCH /credentials/:id`, `DELETE /credentials/:id` | a signed-in user | rename or delete one |
 *
 * Each ceremony's challenge travels in a sealed, `HttpOnly`,
 * `SameSite=Strict` cookie (`__Host-webauthn-{scope}-create` or
 * `__Host-webauthn-{scope}-get`, so an autofill sign-in waiting on the page
 * does not lose its challenge to a sign-up). Its required scope isolates
 * sibling passkey routers on one origin; the seal also binds the RP ID and
 * scope into the ceremony and, for `/register`, the principal who started
 * it. Enrollment is denied unless
 * the application's explicit authorization policy allows both requests;
 * that policy should require recent independent authentication. The store
 * atomically claims each challenge before attempting the ceremony's write, so
 * a response is accepted once however many Workers see it, and stays spent if
 * a later write is refused or interrupted. A successful sign-in or
 * sign-up issues a session for the account's principal: a passkey added
 * while signed in keeps that principal (scheme and issuer too), so it
 * signs in to the same account.
 *
 * Failures answer 400 (a malformed or stale ceremony) or 401 (a passkey
 * that did not verify) with the {@link WebAuthnError} code, and a message
 * that says no more. `unknown_credential` tells the page to call
 * `signalUnknownCredential`, so the browser stops offering a passkey the
 * server deleted.
 *
 * @module
 */

import { ulid } from "@celld/core/ulid";
import { fromBase64Url, toBase64Url } from "@celld/sec/jwt";
import type { RateLimiter } from "@celld/sec/ratelimit";
import { byIp, rateLimit } from "@celld/sec/ratelimit/router";
import {
  type Context,
  type CookieKey,
  CookieKeyring,
  HttpError,
  type Middleware,
  type Principal,
  type PrincipalInput,
  principalKey,
  router,
  type SessionScheme,
} from "@celld/web/router";
import { WebAuthnError, type WebAuthnErrorCode } from "./errors.ts";
import type { RelyingParty } from "./rp.ts";
import {
  checkCredentialName,
  type PasskeyCredential,
  type PasskeyPrincipal,
  type PasskeyStore,
  type PasskeyUser,
} from "./store.ts";

/** Options for {@link passkeyRoutes}. */
export interface PasskeyRoutesOptions<Env = unknown> {
  readonly rp: RelyingParty;
  /** The store, or a function of the Worker's `env` returning it (for a binding). */
  readonly store: PasskeyStore | ((env: Env) => PasskeyStore);
  /** The session scheme a sign-in issues; the app's router must accept it. */
  readonly sessions: SessionScheme;
  /**
   * A stable security-domain namespace for this router's ceremony cookies.
   * It must be unique among `passkeyRoutes` mounted on the same origin, and
   * should identify the same tenant boundary as `store`. Required so two
   * tenants that share an RP ID and cookie keys cannot finish one another's
   * ceremonies. One to 64 ASCII letters, digits, `_` or `-`.
   */
  readonly ceremonyScope: string;
  /**
   * Keys sealing the ceremony cookies: a keyring, or keys for one (newest
   * first, at least 32 bytes each). The session's keys will do: a sealed
   * value is bound to its cookie's name.
   */
  readonly keys: CookieKeyring | readonly CookieKey[];
  /**
   * Whether anyone may create an account with a passkey; default false.
   * Enabling it also requires `limiter`, unless the explicitly unsafe
   * `unsafeUnthrottledSignUp` escape hatch is set.
   */
  readonly signUp?: boolean;
  /**
   * A per-address limit on the public routes (sign-up and sign-in),
   * checked before the body is read. Strongly recommended; see
   * `@celld/sec/ratelimit`.
   */
  readonly limiter?: RateLimiter;
  /**
   * Explicitly allow public sign-up without a limiter. This is unsafe on an
   * Internet-facing route because anyone can create persistent records.
   */
  readonly unsafeUnthrottledSignUp?: boolean;
  /**
   * Authorizes adding a passkey to an existing principal. Default deny.
   * It runs for both `/register/options` and `/register/verify`; use it to
   * require a recent independent authentication, dedicated scope, or role.
   * Returning anything except the boolean `true` denies the request.
   */
  readonly authorizeRegistration?: (
    principal: Principal,
    context: Context,
  ) => boolean | Promise<boolean>;
  /**
   * The principal a new account signs in as, from its name; default a
   * fresh ULID as the subject, with the session's scheme.
   */
  readonly newPrincipal?: (name: string) => PasskeyPrincipal;
  /**
   * What a sign-in issues for a user; default the user's principal. Scopes
   * and roles go here: a passkey says who, not what they may do.
   */
  readonly principal?: (user: PasskeyUser) => PrincipalInput;
  /**
   * Whether a user may delete their last passkey; default false (409
   * `last_passkey`), which keeps a passkey-only account reachable.
   */
  readonly allowRemovingLast?: boolean;
  /** Milliseconds since the epoch; default `Date.now`. */
  readonly now?: () => number;
}

interface Ceremony {
  readonly v: 2;
  /** The RP and route security-domain this ceremony was issued for. */
  readonly r: string;
  readonly s: string;
  readonly t: "create" | "get";
  readonly c: string;
  readonly exp: number;
  /** For `create`: the user handle, principal, names, and who started it. */
  readonly u?: string;
  readonly p?: PasskeyPrincipal;
  readonly n?: string;
  readonly d?: string;
  readonly k?: string;
  /** Whether the user is new (sign-up). */
  readonly new?: boolean;
}

const CEREMONY_SCOPE = /^[A-Za-z0-9_-]{1,64}$/;

const BAD_REQUEST: ReadonlySet<WebAuthnErrorCode> = new Set([
  "invalid_response",
  "wrong_ceremony",
  "challenge_mismatch",
  "challenge_expired",
  "unsupported_algorithm",
  "unsupported_attestation",
  "credential_exists",
]);

function refuse(code: WebAuthnErrorCode, cause?: unknown): never {
  throw new HttpError(
    BAD_REQUEST.has(code) ? 400 : 401,
    BAD_REQUEST.has(code)
      ? "the passkey ceremony failed"
      : "the passkey was not accepted",
    { code, cause },
  );
}

function limitedName(value: unknown, what: string, fallback?: string): string {
  const text = value === undefined ? fallback : value;
  if (
    typeof text !== "string" || text.trim() === "" || text.length > 64 ||
    // deno-lint-ignore no-control-regex
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw new HttpError(400, `${what} is 1 to 64 characters`, {
      code: "invalid_request",
    });
  }
  return text.trim();
}

function publicCredential(credential: PasskeyCredential) {
  return {
    id: credential.id,
    name: credential.name,
    createdAt: credential.createdAt,
    lastUsedAt: credential.lastUsedAt,
    backupEligible: credential.backupEligible,
    backupState: credential.backupState,
    uvInitialized: credential.uvInitialized,
    transports: credential.transports,
    aaguid: credential.aaguid,
  };
}

function principalOf(principal: {
  readonly subject: string;
  readonly scheme?: string;
  readonly issuer?: string;
  readonly tenant?: string;
  readonly clientId?: string;
}): PasskeyPrincipal {
  return {
    subject: principal.subject,
    ...(principal.scheme === undefined ? {} : { scheme: principal.scheme }),
    ...(principal.issuer === undefined ? {} : { issuer: principal.issuer }),
    ...(principal.tenant === undefined ? {} : { tenant: principal.tenant }),
    ...(principal.clientId === undefined
      ? {}
      : { clientId: principal.clientId }),
  };
}

/**
 * A router with the passkey routes, to mount: `app.mount("/passkeys",
 * passkeyRoutes({ ... }))`. It inherits the app's auth, which must accept
 * the `sessions` scheme it issues.
 */
export function passkeyRoutes<Env = unknown>(
  options: PasskeyRoutesOptions<Env>,
) {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("passkeyRoutes takes an options object");
  }
  const { rp, sessions } = options;
  if (typeof rp?.registrationOptions !== "function") {
    throw new TypeError("passkeyRoutes needs a RelyingParty");
  }
  if (typeof sessions?.issue !== "function") {
    throw new TypeError("passkeyRoutes needs a session scheme");
  }
  if (
    typeof options.ceremonyScope !== "string" ||
    !CEREMONY_SCOPE.test(options.ceremonyScope)
  ) {
    throw new TypeError(
      "ceremonyScope must be 1 to 64 ASCII letters, digits, _ or -",
    );
  }
  if (options.signUp !== undefined && typeof options.signUp !== "boolean") {
    throw new TypeError("signUp must be a boolean");
  }
  if (
    options.unsafeUnthrottledSignUp !== undefined &&
    typeof options.unsafeUnthrottledSignUp !== "boolean"
  ) {
    throw new TypeError("unsafeUnthrottledSignUp must be a boolean");
  }
  if (
    options.authorizeRegistration !== undefined &&
    typeof options.authorizeRegistration !== "function"
  ) {
    throw new TypeError("authorizeRegistration must be a function");
  }
  const keyring = options.keys instanceof CookieKeyring
    ? options.keys
    : new CookieKeyring(options.keys);
  const ceremonyScope = options.ceremonyScope;
  const cookie = {
    create: `__Host-webauthn-${ceremonyScope}-create`,
    get: `__Host-webauthn-${ceremonyScope}-get`,
  } as const;
  const given = options.store;
  const storeOf = (c: Context): PasskeyStore =>
    typeof given === "function" ? given(c.env as Env) : given;
  const now = options.now ?? Date.now;
  const signUp = options.signUp === true;
  if (options.unsafeUnthrottledSignUp === true && !signUp) {
    throw new TypeError(
      "unsafeUnthrottledSignUp has no effect unless signUp is true",
    );
  }
  if (
    signUp && options.limiter === undefined &&
    options.unsafeUnthrottledSignUp !== true
  ) {
    throw new TypeError(
      "public passkey sign-up needs a limiter; set unsafeUnthrottledSignUp only for a trusted environment",
    );
  }
  const authorizeRegistration = options.authorizeRegistration ?? (() => false);
  const newPrincipal = options.newPrincipal ??
    ((): PasskeyPrincipal => ({ subject: ulid(), scheme: sessions.name }));
  const issued = options.principal ??
    ((user: PasskeyUser): PrincipalInput => user.principal);
  const before: Middleware[] = options.limiter === undefined
    ? []
    : [rateLimit({ limiter: options.limiter, key: byIp() })];
  const body = { limits: { body: 64 * 1024 } } as const;

  async function start(
    c: Context,
    ceremony: Omit<Ceremony, "v" | "r" | "s" | "exp">,
  ) {
    const sealed = await keyring.seal(
      cookie[ceremony.t],
      JSON.stringify({
        v: 2,
        r: rp.id,
        s: ceremonyScope,
        exp: now() + rp.timeoutMs,
        ...ceremony,
      }),
    );
    c.setCookie(cookie[ceremony.t], sealed, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
      maxAge: rp.timeoutMs / 1000,
    });
  }

  async function finish(c: Context, type: "create" | "get"): Promise<Ceremony> {
    const text = c.cookie(cookie[type]);
    c.deleteCookie(cookie[type], {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
    const opened = text === undefined
      ? null
      : await keyring.unseal(cookie[type], text);
    let ceremony: Ceremony | null = null;
    try {
      ceremony = opened === null ? null : JSON.parse(opened.value);
    } catch {
      ceremony = null;
    }
    if (
      ceremony === null || ceremony.v !== 2 || ceremony.r !== rp.id ||
      ceremony.s !== ceremonyScope || ceremony.t !== type ||
      typeof ceremony.c !== "string" || !(ceremony.exp > now())
    ) {
      refuse("challenge_expired");
    }
    return ceremony;
  }

  async function verified<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof WebAuthnError) refuse(error.code, error);
      throw error;
    }
  }

  async function beginCreate(
    c: Context,
    store: PasskeyStore,
    user: {
      handle: string;
      principal: PasskeyPrincipal;
      name: string;
      displayName: string;
      isNew: boolean;
      startedBy?: string;
    },
  ) {
    const existing = user.isNew ? [] : await store.credentials(user.handle);
    const { options: creation, challenge } = rp.registrationOptions({
      user: {
        id: fromBase64Url(user.handle, 64)!,
        name: user.name,
        displayName: user.displayName,
      },
      exclude: existing.map((credential) => ({
        id: credential.id,
        transports: credential.transports,
      })),
    });
    await start(c, {
      t: "create",
      c: challenge,
      u: user.handle,
      p: user.principal,
      n: user.name,
      d: user.displayName,
      new: user.isNew,
      ...(user.startedBy === undefined ? {} : { k: user.startedBy }),
    });
    return c.json(creation);
  }

  async function completeCreate(c: Context, ceremony: Ceremony) {
    const store = storeOf(c);
    const response = await c.readJson();
    const registration = await verified(() =>
      rp.verifyRegistration(response, { challenge: ceremony.c })
    );
    const at = now();
    const principal = ceremony.p!;
    const user: PasskeyUser = {
      handle: ceremony.u!,
      principal,
      principalKey: principalKey({
        ...principal,
        scheme: principal.scheme ?? sessions.name,
      }),
      name: ceremony.n!,
      displayName: ceremony.d!,
      createdAt: at,
    };
    const result = await store.register({
      challenge: { challenge: ceremony.c, expiresAt: ceremony.exp },
      user,
      credential: {
        id: registration.id,
        userHandle: user.handle,
        publicKey: registration.publicKey,
        algorithm: registration.algorithm,
        signCount: registration.signCount,
        transports: registration.transports,
        backupEligible: registration.backupEligible,
        backupState: registration.backupState,
        uvInitialized: registration.userVerified,
        aaguid: registration.aaguid,
        attestationFormat: registration.attestationFormat,
        name: registration.backupEligible ? "Synced passkey" : "Passkey",
        createdAt: at,
        lastUsedAt: null,
      },
    });
    if (!result.ok) {
      if (result.reason === "challenge_used") refuse("challenge_expired");
      if (result.reason === "credential_exists") refuse("credential_exists");
      throw new HttpError(409, "the passkey could not be added", {
        code: result.reason,
      });
    }
    return { user, registration };
  }

  const app = router<Env>({ auth: "inherit" });

  if (signUp) {
    app.post("/signup/options", {
      // Anyone may start an account; the limiter bounds how often.
      public: true,
      csrf: true,
      before,
      ...body,
    }, async (c) => {
      const input = await c.readJson() as Record<string, unknown> | null;
      const name = limitedName(input?.name, "name");
      const displayName = limitedName(input?.displayName, "displayName", name);
      return await beginCreate(c, storeOf(c), {
        handle: toBase64Url(crypto.getRandomValues(new Uint8Array(64))),
        principal: newPrincipal(name),
        name,
        displayName,
        isNew: true,
      });
    });

    app.post("/signup/verify", {
      public: true,
      csrf: true,
      before,
      ...body,
    }, async (c) => {
      const ceremony = await finish(c, "create");
      if (ceremony.new !== true || ceremony.k !== undefined) {
        refuse("wrong_ceremony");
      }
      const { user, registration } = await completeCreate(c, ceremony);
      await sessions.issue(c, issued(user));
      return c.json({
        user: { subject: user.principal.subject, name: user.name },
        credential: { id: registration.id },
      }, 201);
    });
  }

  app.post("/login/options", {
    public: true,
    csrf: true,
    before,
    ...body,
  }, async (c) => {
    const { options: request, challenge } = rp.authenticationOptions();
    await start(c, { t: "get", c: challenge });
    return c.json(request);
  });

  app.post("/login/verify", {
    public: true,
    csrf: true,
    before,
    ...body,
  }, async (c) => {
    const ceremony = await finish(c, "get");
    const store = storeOf(c);
    const response = await c.readJson();
    const rawId = typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).rawId
      : undefined;
    const credential = typeof rawId === "string" && rawId.length <= 1400
      ? await store.credential(rawId)
      : null;
    if (credential === null) refuse("unknown_credential");
    const verifiedLogin = await verified(() =>
      rp.verifyAuthentication(response, { challenge: ceremony.c, credential })
    );
    const result = await store.authenticate({
      challenge: { challenge: ceremony.c, expiresAt: ceremony.exp },
      credentialId: credential.id,
      expectedSignCount: credential.signCount,
      signCount: verifiedLogin.signCount,
      backupState: verifiedLogin.backupState,
      authenticatorUserVerified: verifiedLogin.authenticatorUserVerified,
      usedAt: now(),
    });
    if (!result.ok) {
      refuse(
        result.reason === "unknown_credential"
          ? "unknown_credential"
          : "challenge_expired",
      );
    }
    await sessions.issue(c, issued(result.user));
    return c.json({
      user: { subject: result.user.principal.subject, name: result.user.name },
      credential: { id: credential.id },
    });
  });

  app.post("/register/options", {
    authorize: authorizeRegistration,
    ...body,
  }, async (c) => {
    const store = storeOf(c);
    const principal = c.principal!;
    const input = await c.readJson() as Record<string, unknown> | null;
    const known = await store.userByPrincipal(principal.key);
    const name = limitedName(
      input?.name,
      "name",
      known?.name ?? principal.subject.slice(0, 64),
    );
    return await beginCreate(c, store, {
      handle: known?.handle ??
        toBase64Url(crypto.getRandomValues(new Uint8Array(64))),
      principal: known?.principal ?? principalOf(principal),
      name: known?.name ?? name,
      displayName: known?.displayName ??
        limitedName(input?.displayName, "displayName", name),
      isNew: known === null,
      startedBy: principal.key,
    });
  });

  app.post("/register/verify", {
    authorize: authorizeRegistration,
    ...body,
  }, async (c) => {
    const ceremony = await finish(c, "create");
    if (ceremony.k !== c.principal!.key) refuse("wrong_ceremony");
    const { registration } = await completeCreate(c, ceremony);
    return c.json({ credential: { id: registration.id } }, 201);
  });

  async function signedInUser(c: Context, store: PasskeyStore) {
    const user = await store.userByPrincipal(c.principal!.key);
    if (user === null) {
      throw new HttpError(404, "no passkeys", { code: "not_found" });
    }
    return user;
  }

  app.get("/credentials", async (c) => {
    const store = storeOf(c);
    const user = await store.userByPrincipal(c.principal!.key);
    const credentials = user === null
      ? []
      : await store.credentials(user.handle);
    return c.json({
      rpId: rp.id,
      userHandle: user?.handle ?? null,
      credentials: credentials.map(publicCredential),
    });
  });

  app.patch("/credentials/:id", { ...body }, async (c) => {
    const store = storeOf(c);
    const user = await signedInUser(c, store);
    const input = await c.readJson() as Record<string, unknown> | null;
    let name: string;
    try {
      name = checkCredentialName(input?.name);
    } catch (cause) {
      throw new HttpError(400, (cause as Error).message, {
        code: "invalid_request",
      });
    }
    if (!await store.rename(user.handle, c.params.id, name)) {
      throw new HttpError(404, "no such passkey", { code: "not_found" });
    }
    return c.json({ id: c.params.id, name });
  });

  app.delete("/credentials/:id", async (c) => {
    const store = storeOf(c);
    const user = await signedInUser(c, store);
    // The store decides "last" in the delete's own transaction, so two
    // removals at once cannot both see a second passkey.
    const removed = await store.remove(user.handle, c.params.id, {
      keepLast: options.allowRemovingLast !== true,
    });
    if (removed === "not_found") {
      throw new HttpError(404, "no such passkey", { code: "not_found" });
    }
    if (removed === "last") {
      throw new HttpError(409, "this is the account's last passkey", {
        code: "last_passkey",
      });
    }
    return c.empty();
  });

  return app;
}
