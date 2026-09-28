// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import { memoryLimiter } from "@celld/sec/ratelimit";
import {
  apiKey,
  CookieKeyring,
  hashApiKey,
  hashedKeys,
  router,
  session,
} from "@celld/web/router";
import { RelyingParty } from "@celld/sec/webauthn";
import {
  passkeyRoutes,
  type PasskeyRoutesOptions,
} from "@celld/sec/webauthn/router";
import {
  memoryPasskeyStore,
  VirtualAuthenticator,
} from "@celld/sec/webauthn/testing";

const ORIGIN = "https://example.com";
const CEREMONY_SCOPE = "test";
const CREATE_COOKIE = `__Host-webauthn-${CEREMONY_SCOPE}-create`;
const GET_COOKIE = `__Host-webauthn-${CEREMONY_SCOPE}-get`;
const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  abort: () => {},
  exports: {},
  props: undefined,
};

type App = {
  fetch(r: Request, env: unknown, c: ExecutionContext): Promise<Response>;
};

/** A browser's cookie jar over one app. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(
    readonly app: App,
    readonly headers: Record<string, string> = {},
  ) {}

  async send(method: string, path: string, body?: unknown) {
    const headers = new Headers(this.headers);
    if (this.cookies.size > 0) {
      headers.set(
        "cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      {},
      ctx,
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    return {
      status: response.status,
      json: text === "" ? null : JSON.parse(text),
      headers: response.headers,
    };
  }
}

function setup(options: Partial<PasskeyRoutesOptions> = {}) {
  const sessions = session({ keys: [{ id: "k1", secret: "s".repeat(32) }] });
  const store = memoryPasskeyStore();
  const rp = new RelyingParty({ id: "example.com", origins: [ORIGIN] });
  const app = router({ auth: sessions });
  app.mount(
    "/passkeys",
    passkeyRoutes({
      rp,
      store,
      sessions,
      ceremonyScope: CEREMONY_SCOPE,
      keys: [{ id: "w1", secret: "w".repeat(32) }],
      signUp: options.signUp ?? true,
      unsafeUnthrottledSignUp: options.unsafeUnthrottledSignUp ??
        ((options.signUp ?? true) && options.limiter === undefined),
      authorizeRegistration: () => true,
      ...options,
    }),
  );
  app.get(
    "/me",
    (c) => c.json({ subject: c.principal.subject, key: c.principal.key }),
  );
  return { app, store, rp };
}

async function signUp(
  browser: Browser,
  device: VirtualAuthenticator,
  name = "ada@example.com",
) {
  const options = await browser.send("POST", "/passkeys/signup/options", {
    name,
  });
  assertEquals(options.status, 200, JSON.stringify(options.json));
  return await browser.send(
    "POST",
    "/passkeys/signup/verify",
    await device.create(options.json),
  );
}

async function signIn(
  browser: Browser,
  device: VirtualAuthenticator,
  credentialId?: string,
) {
  const options = await browser.send("POST", "/passkeys/login/options", {});
  assertEquals(options.status, 200);
  return await browser.send(
    "POST",
    "/passkeys/login/verify",
    await device.get(
      options.json,
      credentialId === undefined ? {} : { credentialId },
    ),
  );
}

Deno.test("routes: sign up, sign in again, same account", async () => {
  const { app } = setup();
  const phone = new VirtualAuthenticator({ origin: ORIGIN });
  const first = new Browser(app);
  const created = await signUp(first, phone);
  assertEquals(created.status, 201, JSON.stringify(created.json));
  assertEquals(created.json.user.name, "ada@example.com");
  assert(first.cookies.has("__Host-session"), "signed in");
  assert(!first.cookies.has(CREATE_COOKIE), "the ceremony cookie is spent");
  const me = await first.send("GET", "/me");
  assertEquals(me.json.subject, created.json.user.subject);

  const second = new Browser(app);
  assertEquals((await second.send("GET", "/me")).status, 401);
  const signedIn = await signIn(second, phone);
  assertEquals(signedIn.status, 200, JSON.stringify(signedIn.json));
  assertEquals((await second.send("GET", "/me")).json, me.json);
});

Deno.test("routes: the ceremony cookie is sealed, single-use and per ceremony", async () => {
  const { app } = setup();
  const phone = new VirtualAuthenticator({ origin: ORIGIN });
  const browser = new Browser(app);
  await signUp(browser, phone);
  const fresh = new Browser(app);
  const options = await fresh.send("POST", "/passkeys/login/options", {});
  const cookie = fresh.cookies.get(GET_COOKIE)!;
  assert(cookie.startsWith("e1."), "sealed");
  // A sign-up started meanwhile does not disturb the sign-in's challenge.
  await fresh.send("POST", "/passkeys/signup/options", { name: "someone" });
  const response = await phone.get(options.json);
  assertEquals(
    (await fresh.send("POST", "/passkeys/login/verify", response)).status,
    200,
  );
  // The same response again, even with the cookie put back, is refused.
  const replay = new Browser(app);
  replay.cookies.set(GET_COOKIE, cookie);
  const again = await replay.send("POST", "/passkeys/login/verify", response);
  assertEquals([again.status, again.json.error], [400, "challenge_expired"]);
  // And none at all, or one sealed for the other ceremony, is refused too.
  const none = await new Browser(app).send(
    "POST",
    "/passkeys/login/verify",
    response,
  );
  assertEquals([none.status, none.json.error], [400, "challenge_expired"]);
  const swapped = new Browser(app);
  swapped.cookies.set(
    GET_COOKIE,
    fresh.cookies.get(CREATE_COOKIE)!,
  );
  assertEquals(
    (await swapped.send("POST", "/passkeys/login/verify", response)).json.error,
    "challenge_expired",
  );
});

// Two tenants may deliberately share an RP ID, origin, and keyring. Their
// credential stores are separate, so accepting one tenant's create ceremony
// in the other would create an account in the wrong security domain.
Deno.test("routes: ceremony scopes isolate same-origin passkey routers", async () => {
  const sessions = session({ keys: [{ id: "k1", secret: "s".repeat(32) }] });
  const keys = [{ id: "w1", secret: "w".repeat(32) }] as const;
  const rp = new RelyingParty({ id: "example.com", origins: [ORIGIN] });
  const app = router({ auth: sessions });
  for (
    const [path, ceremonyScope] of [
      ["/north", "tenant-north"],
      ["/south", "tenant-south"],
    ] as const
  ) {
    app.mount(
      path,
      passkeyRoutes({
        rp,
        store: memoryPasskeyStore(),
        sessions,
        ceremonyScope,
        keys,
        signUp: true,
        unsafeUnthrottledSignUp: true,
      }),
    );
  }

  const browser = new Browser(app);
  const device = new VirtualAuthenticator({ origin: ORIGIN });
  const options = await browser.send("POST", "/north/signup/options", {
    name: "ada",
  });
  const response = await device.create(options.json);
  const northName = "__Host-webauthn-tenant-north-create";
  const southName = "__Host-webauthn-tenant-south-create";

  // The browser sends the north cookie to the same origin, but the south
  // router only consumes its own namespace.
  const crossed = await browser.send(
    "POST",
    "/south/signup/verify",
    response,
  );
  assertEquals([crossed.status, crossed.json.error], [
    400,
    "challenge_expired",
  ]);
  assert(browser.cookies.has(northName), "the north ceremony is untouched");

  // Cookie-name associated data is one boundary. Even a correctly resealed
  // value for the other name is refused because RP ID and scope are also in
  // the authenticated ceremony payload and checked by the route.
  const keyring = new CookieKeyring(keys);
  const opened = await keyring.unseal(
    northName,
    browser.cookies.get(northName)!,
  );
  assert(opened !== null, "the north ceremony cookie opens under its name");
  browser.cookies.set(southName, await keyring.seal(southName, opened.value));
  const rebound = await browser.send(
    "POST",
    "/south/signup/verify",
    response,
  );
  assertEquals([rebound.status, rebound.json.error], [
    400,
    "challenge_expired",
  ]);

  // Refusing both cross-tenant attempts does not spend the issuing tenant's
  // cookie or challenge.
  const completed = await browser.send(
    "POST",
    "/north/signup/verify",
    response,
  );
  assertEquals(completed.status, 201, JSON.stringify(completed.json));
});

Deno.test("routes: a signed-in user adds, renames and removes passkeys", async () => {
  const { app } = setup();
  const phone = new VirtualAuthenticator({ origin: ORIGIN });
  const key = new VirtualAuthenticator({
    origin: ORIGIN,
    backupEligible: false,
    counter: true,
  });
  const browser = new Browser(app);
  const created = await signUp(browser, phone);
  const options = await browser.send("POST", "/passkeys/register/options", {});
  assertEquals(
    options.json.excludeCredentials.map((c: { id: string }) => c.id),
    [
      created.json.credential.id,
    ],
  );
  assertEquals(options.json.user.name, "ada@example.com");
  // The phone is excluded; the security key registers.
  let refused = false;
  await phone.create(options.json).catch(() => refused = true);
  assert(refused, "an excluded authenticator refuses");
  const added = await browser.send(
    "POST",
    "/passkeys/register/verify",
    await key.create(options.json),
  );
  assertEquals(added.status, 201, JSON.stringify(added.json));

  const list = await browser.send("GET", "/passkeys/credentials");
  assertEquals(list.json.rpId, "example.com");
  assertEquals(list.json.credentials.map((c: { name: string }) => c.name), [
    "Synced passkey",
    "Passkey",
  ]);
  const keyId = added.json.credential.id;
  assertEquals(
    (await browser.send("PATCH", `/passkeys/credentials/${keyId}`, {
      name: "YubiKey",
    })).json,
    { id: keyId, name: "YubiKey" },
  );
  assertEquals(
    (await browser.send("PATCH", `/passkeys/credentials/nope`, { name: "x" }))
      .status,
    404,
  );
  assertEquals(
    (await browser.send("PATCH", `/passkeys/credentials/${keyId}`, {
      name: "",
    })).status,
    400,
  );

  // Signing in with the key counts its signatures.
  const other = new Browser(app);
  assertEquals((await signIn(other, key)).status, 200);
  assertEquals(
    (await other.send("GET", "/passkeys/credentials")).json.credentials[1]
      .lastUsedAt === null,
    false,
  );

  assertEquals(
    (await browser.send(
      "DELETE",
      `/passkeys/credentials/${created.json.credential.id}`,
    )).status,
    204,
  );
  const last = await browser.send("DELETE", `/passkeys/credentials/${keyId}`);
  assertEquals([last.status, last.json.error], [409, "last_passkey"]);

  // The deleted passkey is still on the phone: signing in with it is refused
  // as unknown, which tells the page to signal the browser.
  const stale = await signIn(new Browser(app), phone);
  assertEquals([stale.status, stale.json.error], [401, "unknown_credential"]);
});

Deno.test("routes: sign-up and passkey enrollment are denied by default", async () => {
  const sessions = session({ keys: [{ id: "k1", secret: "s".repeat(32) }] });
  const rp = new RelyingParty({ id: "example.com", origins: [ORIGIN] });
  const app = router({ auth: sessions });
  app.mount(
    "/passkeys",
    passkeyRoutes({
      rp,
      store: memoryPasskeyStore(),
      sessions,
      ceremonyScope: CEREMONY_SCOPE,
      keys: [{ id: "w1", secret: "w".repeat(32) }],
    }),
  );
  assertEquals(
    (await new Browser(app).send("POST", "/passkeys/signup/options", {
      name: "ada",
    })).status,
    404,
  );

  const { app: enrolled } = setup({ authorizeRegistration: undefined });
  const browser = new Browser(enrolled);
  await signUp(browser, new VirtualAuthenticator({ origin: ORIGIN }));
  assertEquals(
    (await browser.send("POST", "/passkeys/register/options", {})).status,
    403,
  );

  const common = {
    rp,
    store: memoryPasskeyStore(),
    sessions,
    ceremonyScope: CEREMONY_SCOPE,
    keys: [{ id: "w1", secret: "w".repeat(32) }],
  } as const;
  assertThrows(
    () => {
      const { ceremonyScope: _scope, ...withoutScope } = common;
      passkeyRoutes(withoutScope as never);
    },
    TypeError,
    "ceremonyScope",
  );
  assertThrows(
    () => passkeyRoutes({ ...common, ceremonyScope: "tenant/a" }),
    TypeError,
    "ceremonyScope",
  );
  assertThrows(
    () => passkeyRoutes({ ...common, signUp: true }),
    TypeError,
    "needs a limiter",
  );
  assertThrows(
    () =>
      passkeyRoutes({
        ...common,
        unsafeUnthrottledSignUp: true,
      }),
    TypeError,
    "has no effect",
  );
  assertThrows(
    () =>
      passkeyRoutes({
        ...common,
        authorizeRegistration: "yes" as never,
      }),
    TypeError,
    "must be a function",
  );
});

Deno.test("routes: enrollment authorization is rechecked before persistence", async () => {
  let authorized = true;
  let checks = 0;
  const { app, store } = setup({
    authorizeRegistration: () => {
      checks++;
      return authorized;
    },
  });
  const browser = new Browser(app);
  const phone = new VirtualAuthenticator({ origin: ORIGIN });
  const created = await signUp(browser, phone);
  const original = (await store.credential(created.json.credential.id))!;

  const options = await browser.send("POST", "/passkeys/register/options", {});
  assertEquals(options.status, 200);
  authorized = false;
  const refused = await browser.send(
    "POST",
    "/passkeys/register/verify",
    await new VirtualAuthenticator({ origin: ORIGIN }).create(options.json),
  );
  assertEquals(refused.status, 403);
  assertEquals(checks, 2);
  assertEquals((await store.credentials(original.userHandle)).length, 1);
});

// The 2026-09-29 review: the route listed the passkeys and removed in a
// second call, so two removals at once both saw a second passkey and left a
// passkey-only account with none.
Deno.test("routes: two removals at once still keep the last passkey", async () => {
  const { app, store } = setup();
  const phone = new VirtualAuthenticator({ origin: ORIGIN });
  const key = new VirtualAuthenticator({
    origin: ORIGIN,
    backupEligible: false,
  });
  const browser = new Browser(app);
  const created = await signUp(browser, phone);
  const options = await browser.send("POST", "/passkeys/register/options", {});
  const added = await browser.send(
    "POST",
    "/passkeys/register/verify",
    await key.create(options.json),
  );
  assertEquals(added.status, 201);
  const removals = await Promise.all(
    [created.json.credential.id, added.json.credential.id].map((id) =>
      browser.send("DELETE", `/passkeys/credentials/${id}`)
    ),
  );
  assertEquals(removals.map((r) => r.status).sort(), [204, 409]);
  const handle = (await store.credential(created.json.credential.id) ??
    await store.credential(added.json.credential.id))!.userHandle;
  assertEquals((await store.credentials(handle)).length, 1);
});

Deno.test("routes: a registration is bound to the principal who started it", async () => {
  const { app } = setup();
  const ada = new Browser(app);
  const bob = new Browser(app);
  const adaPhone = new VirtualAuthenticator({ origin: ORIGIN });
  const bobPhone = new VirtualAuthenticator({ origin: ORIGIN });
  await signUp(ada, adaPhone, "ada");
  await signUp(bob, bobPhone, "bob");
  const options = await ada.send("POST", "/passkeys/register/options", {});
  const response = await new VirtualAuthenticator({ origin: ORIGIN }).create(
    options.json,
  );
  bob.cookies.set(
    CREATE_COOKIE,
    ada.cookies.get(CREATE_COOKIE)!,
  );
  const stolen = await bob.send("POST", "/passkeys/register/verify", response);
  assertEquals([stolen.status, stolen.json.error], [400, "wrong_ceremony"]);
  // A sign-up ceremony cannot finish as an add, nor the reverse.
  const signup = new Browser(app);
  const started = await signup.send("POST", "/passkeys/signup/options", {
    name: "eve",
  });
  bob.cookies.set(
    CREATE_COOKIE,
    signup.cookies.get(CREATE_COOKIE)!,
  );
  const crossed = await bob.send(
    "POST",
    "/passkeys/register/verify",
    await new VirtualAuthenticator({ origin: ORIGIN }).create(started.json),
  );
  assertEquals(crossed.json.error, "wrong_ceremony");
  // The management routes need a session.
  assertEquals(
    (await new Browser(app).send("GET", "/passkeys/credentials")).status,
    401,
  );
  assertEquals(
    (await new Browser(app).send("POST", "/passkeys/register/options", {}))
      .status,
    401,
  );
});

Deno.test("routes: a passkey added under another scheme signs in as that principal", async () => {
  const sessions = session({ keys: [{ id: "k1", secret: "s".repeat(32) }] });
  const keys = hashedKeys({
    [await hashApiKey("key-grace")]: { subject: "grace" },
  });
  const rp = new RelyingParty({ id: "example.com", origins: [ORIGIN] });
  const app = router({ auth: [sessions, apiKey({ lookup: keys })] });
  app.mount(
    "/passkeys",
    passkeyRoutes({
      rp,
      store: memoryPasskeyStore(),
      sessions,
      ceremonyScope: CEREMONY_SCOPE,
      keys: [{ id: "w1", secret: "w".repeat(32) }],
      signUp: false,
      authorizeRegistration: () => true,
    }),
  );
  app.get("/me", (c) => c.json({ key: c.principal.key }));
  const withKey = new Browser(app, { "x-api-key": "key-grace" });
  const before = (await withKey.send("GET", "/me")).json.key;
  const device = new VirtualAuthenticator({ origin: ORIGIN });
  const options = await withKey.send("POST", "/passkeys/register/options", {
    name: "grace",
  });
  assertEquals(options.status, 200, JSON.stringify(options.json));
  const added = await withKey.send(
    "POST",
    "/passkeys/register/verify",
    await device.create(options.json),
  );
  assertEquals(added.status, 201, JSON.stringify(added.json));
  const browser = new Browser(app);
  assertEquals((await signIn(browser, device)).status, 200);
  assertEquals((await browser.send("GET", "/me")).json.key, before);
  // Sign-up is off.
  assertEquals(
    (await browser.send("POST", "/passkeys/signup/options", { name: "x" }))
      .status,
    404,
  );
});

Deno.test("routes: a failed passkey says why only in its code", async () => {
  const { app } = setup();
  const phone = new VirtualAuthenticator({ origin: ORIGIN });
  await signUp(new Browser(app), phone);
  const browser = new Browser(app);
  const options = await browser.send("POST", "/passkeys/login/options", {});
  const forged = await browser.send(
    "POST",
    "/passkeys/login/verify",
    await phone.get(options.json, { badSignature: true }),
  );
  assertEquals(forged.status, 401);
  assertEquals(forged.json.error, "bad_signature");
  assertEquals(forged.json.message, "the passkey was not accepted");
  assert(!browser.cookies.has("__Host-session"), "no session");
  const elsewhere = new VirtualAuthenticator({
    origin: "https://evil.example",
  });
  await signUp(new Browser(app), elsewhere).then((answer) =>
    assertEquals([answer.status, answer.json.error], [
      401,
      "origin_not_allowed",
    ])
  );
});

Deno.test("routes: public routes are limited per address, and inputs are bounded", async () => {
  const { app } = setup({
    limiter: memoryLimiter({
      policies: [{ name: "passkeys", limit: 2, window: "PT1M" }],
    }),
  });
  const browser = new Browser(app, { "cf-connecting-ip": "192.0.2.7" });
  assertEquals(
    (await browser.send("POST", "/passkeys/login/options", {})).status,
    200,
  );
  assertEquals(
    (await browser.send("POST", "/passkeys/signup/options", { name: "a" }))
      .status,
    200,
  );
  const limited = await browser.send("POST", "/passkeys/login/options", {});
  assertEquals([limited.status, limited.json.error], [429, "rate_limited"]);

  const open = new Browser(setup().app);
  assertEquals(
    (await open.send("POST", "/passkeys/signup/options", { name: "" })).status,
    400,
  );
  assertEquals(
    (await open.send("POST", "/passkeys/signup/options", { name: "a\u0000b" }))
      .status,
    400,
  );
  assertEquals(
    (await open.send("POST", "/passkeys/signup/options", {
      name: "x".repeat(100_000),
    })).status,
    413,
  );
});
