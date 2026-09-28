// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/** The examples in README.md and src/mod.ts, as written there. */

import { assertEquals, assertThrows } from "@celld/core/assert";
import { durableLimiter, type ShardNamespace } from "@celld/sec/ratelimit";
import { memoryNamespace } from "@celld/sec/ratelimit/testing";
import { router, session } from "@celld/web/router";
import {
  type DirectoryNamespace,
  durablePasskeys,
  RelyingParty,
} from "@celld/sec/webauthn";
import { passkeyRoutes } from "@celld/sec/webauthn/router";
import {
  memoryPasskeyStore,
  VirtualAuthenticator,
} from "@celld/sec/webauthn/testing";

interface Env {
  readonly PASSKEYS: DirectoryNamespace;
  readonly RATE_LIMITS: ShardNamespace;
  readonly SESSION_SECRET: string;
}

function build(env: Env) {
  const keys = [{ id: "k1", secret: env.SESSION_SECRET }];
  const sessions = session({ keys });
  const rp = new RelyingParty({
    id: "example.com",
    origins: ["https://example.com"],
  });
  const app = router<Env>({ auth: sessions });
  app.mount(
    "/passkeys",
    passkeyRoutes<Env>({
      rp,
      store: (env) => durablePasskeys(env.PASSKEYS, { rpId: rp.id }),
      sessions,
      ceremonyScope: "accounts",
      keys,
      signUp: true,
      limiter: durableLimiter(env.RATE_LIMITS, {
        name: "passkeys",
        policies: [{ name: "passkeys", limit: 60, window: "PT1M", burst: 30 }],
      }),
      principal: (user) => ({
        ...user.principal,
        claims: { passkeyAuthenticatedAt: Date.now() },
      }),
      authorizeRegistration: (principal) => {
        const at = principal.claims.passkeyAuthenticatedAt;
        const age = typeof at === "number" ? Date.now() - at : Infinity;
        return age >= 0 && age <= rp.timeoutMs;
      },
    }),
  );
  app.get("/me", (c) => c.json({ subject: c.principal.subject }));
  return app;
}

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  abort: () => {},
  exports: {},
  props: undefined,
};

Deno.test("the README's quick tour signs up and signs in", async () => {
  const store = memoryPasskeyStore();
  const env: Env = {
    PASSKEYS: { getByName: () => store },
    RATE_LIMITS: memoryNamespace(),
    SESSION_SECRET: "s".repeat(32),
  };
  const app = build(env);
  const cookies = new Map<string, string>();
  const send = async (path: string, body?: unknown) => {
    const response = await app.fetch(
      new Request(`https://example.com${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx,
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      cookies.set(
        pair.slice(0, pair.indexOf("=")),
        pair.slice(pair.indexOf("=") + 1),
      );
    }
    return { status: response.status, json: await response.json() };
  };
  const phone = new VirtualAuthenticator({ origin: "https://example.com" });
  const options = await send("/passkeys/signup/options", {
    name: "ada@example.com",
  });
  const created = await send(
    "/passkeys/signup/verify",
    await phone.create(options.json),
  );
  assertEquals(created.status, 201);
  cookies.clear();
  const login = await send("/passkeys/login/options", {});
  const signedIn = await send(
    "/passkeys/login/verify",
    await phone.get(login.json),
  );
  assertEquals(signedIn.json.user.subject, created.json.user.subject);
  assertEquals((await send("/me")).json, {
    subject: created.json.user.subject,
  });
});

Deno.test("durablePasskeys derives distinct, explicit RP and tenant scopes", async () => {
  const names: string[] = [];
  const store = memoryPasskeyStore();
  const namespace: DirectoryNamespace = {
    getByName: (name) => {
      names.push(name);
      return store;
    },
  };
  await durablePasskeys(namespace, { rpId: "example.com" }).user("none");
  await durablePasskeys(namespace, {
    rpId: "example.com",
    tenant: "north",
  }).user("none");
  await durablePasskeys(namespace, { rpId: "example.net" }).user("none");
  assertEquals(names, [
    '["celld-passkeys-v2","example.com",null]',
    '["celld-passkeys-v2","example.com","north"]',
    '["celld-passkeys-v2","example.net",null]',
  ]);
  assertThrows(
    () => durablePasskeys(namespace, undefined as never),
    TypeError,
    "explicit RP scope",
  );
  assertThrows(
    () => durablePasskeys(namespace, { rpId: "" }),
    TypeError,
    "rpId",
  );
  assertThrows(
    () =>
      durablePasskeys(namespace, {
        rpId: "example.com",
        tenent: "north",
      } as never),
    TypeError,
    "no option tenent",
  );
});

Deno.test("the module documentation's relying party", async () => {
  const rp = new RelyingParty({
    id: "example.com",
    origins: ["https://example.com"],
  });
  const device = new VirtualAuthenticator({ origin: "https://example.com" });
  const registered = rp.registrationOptions({
    user: { id: new Uint8Array(64).fill(1), name: "ada" },
  });
  const credential = await rp.verifyRegistration(
    await device.create(registered.options),
    { challenge: registered.challenge },
  );
  const { options, challenge } = rp.authenticationOptions();
  const response = await device.get(options);
  const result = await rp.verifyAuthentication(response, {
    challenge,
    credential: {
      ...credential,
      userHandle: registered.options.user.id,
      uvInitialized: credential.userVerified,
    },
  });
  assertEquals(result.credentialId, credential.id);
});
