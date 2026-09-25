// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Regressions for the findings other wave-4 sweepers filed to WP-13
 * against `@celld/sec/oauth` (the WP-13b follow-up): numbers from the server,
 * store growth, lost compare-and-swap races and races over a shared client
 * store. Each is named by its `DB-SWP` identifier and failed on the code
 * before it.
 *
 * @module
 */

import { assert, assertEquals } from "@celld/core/assert";
import { generateKeyPair } from "@celld/sec/jwt";
import {
  type AuthorizationServerMetadata,
  parseWwwAuthenticate,
} from "@celld/sec/oauth";
import {
  memoryOAuthStore,
  OAuthClient,
  OAuthSession,
} from "@celld/sec/oauth/client";
import {
  type RecordStore,
  unsafeMemoryRecordStore,
} from "@celld/sec/oauth/server";
import {
  routeFetch,
  testResourceServer,
  testUserAgent,
} from "@celld/sec/oauth/testing";
import {
  API,
  authorize,
  body,
  ISSUER,
  oauthError,
  post,
  redeem,
  SECRET,
  WEB_AUTH,
  type World,
  world,
} from "./fixture.ts";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * A RecordStore that delegates to `inner`, with hooks for interleavings.
 * `inner` defaults to a memory store on the fixture world's starting time
 * (its clock moves only forward, so records live at least as long).
 */
function hookedStore(
  inner: RecordStore = unsafeMemoryRecordStore({
    now: () => Date.UTC(2026, 8, 25, 12),
  }),
) {
  const hooks = {
    /** Called after each `get`, with the key. */
    afterGet: undefined as ((key: string) => Promise<void>) | undefined,
    /** Decides whether a `swap` on the key is let through. */
    swapAllowed: (_key: string) => true,
  };
  const store: RecordStore = {
    async get<T>(key: string) {
      const found = await inner.get<T>(key);
      await hooks.afterGet?.(key);
      return found;
    },
    put: (key, value, expiresAt) => inner.put(key, value, expiresAt),
    create: (key, value, expiresAt) => inner.create(key, value, expiresAt),
    swap: (key, version, value, expiresAt) =>
      hooks.swapAllowed(key)
        ? inner.swap(key, version, value, expiresAt)
        : Promise.resolve(false),
    delete: (key) => inner.delete(key),
  };
  return { store, hooks };
}

async function refreshWith(w: World, token: string): Promise<Response> {
  return await w.handle(post(w.server.endpoint("token"), {
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: "public-app",
  }));
}

// ----- DB-SWP-F8-107: the in-memory record store is bounded -----

Deno.test("DB-SWP-F8-107: the memory record store is unsafe-named, bounded and purges expired records", async () => {
  let now = 1_000_000;
  const store = unsafeMemoryRecordStore({ now: () => now, maxEntries: 2 });
  await store.put("a", 1, now + 1000);
  await store.put("b", 2, null);
  now += 2000;
  // Full, but "a" expired: it is purged to make room.
  await store.put("c", 3, null);
  let full: unknown;
  try {
    await store.create("d", 4, null);
  } catch (error) {
    full = error;
  }
  assert(full instanceof RangeError, `a full store refuses: ${full}`);
  // Existing keys can still be rewritten.
  await store.put("b", 5, null);
  assertEquals((await store.get("b"))?.value, 5);
  for (const maxEntries of [0, -1, NaN, Infinity, 1.5]) {
    let threw = false;
    try {
      unsafeMemoryRecordStore({ maxEntries });
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, `maxEntries ${maxEntries}`);
  }
});

// ----- DB-SWP-F8-106: dynamic clients expire unless they are used -----

Deno.test("DB-SWP-F8-106: an unused registered client expires; a used one is renewed", async () => {
  const w = await world({ registration: { clientTtlSec: 100 } });
  const register = async () =>
    await body(
      await w.handle(
        new Request(w.server.endpoint("registration"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: ["https://app.test/cb"],
            grant_types: ["authorization_code", "refresh_token"],
            token_endpoint_auth_method: "client_secret_basic",
          }),
        }),
      ),
    );
  const unused = await register();
  const used = await register();
  const authorization = (client: Record<string, unknown>) => ({
    authorization: `Basic ${
      btoa(`${client.client_id}:${client.client_secret}`)
    }`,
  });
  const revoke = async (client: Record<string, unknown>) =>
    await w.handle(
      post(
        w.server.endpoint("revocation"),
        { token: "x" },
        authorization(client),
      ),
    );
  w.clock.advance(70_000);
  // Authenticating renews the registration.
  assertEquals((await revoke(used)).status, 200);
  w.clock.advance(70_000);
  assertEquals(await w.server.client(unused.client_id as string), null);
  assert(
    (await w.server.client(used.client_id as string)) !== null,
    "the used client was renewed",
  );
  await oauthError(await revoke(unused), 401, "invalid_client");
  let threw = false;
  try {
    await world({ registration: { clientTtlSec: NaN } });
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert(threw, "clientTtlSec is checked");
});

Deno.test("DB-REV-OAUTH-2: a registration cannot choose its own expiry or store unknown members", async () => {
  const w = await world({ registration: { clientTtlSec: 3600 } });
  for (const method of ["none", "client_secret_basic"]) {
    const response = await w.handle(
      new Request(w.server.endpoint("registration"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://app.test/cb"],
          token_endpoint_auth_method: method,
          client_name: "kept",
          client_secret_expires_at: 99_999_999_999,
          client_id_issued_at: 1,
          client_id: "chosen",
          source: "static",
          registration_access_token: "mine",
          foo: { deep: 1 },
        }),
      }),
    );
    assertEquals(response.status, 201);
    const answer = await body(response);
    const stored = await w.store.get<Record<string, unknown>>(
      `client:${answer.client_id}`,
    );
    assert(stored !== null, "the client is stored");
    assertEquals(stored.expiresAt, w.clock.now() + 3600 * 1000, method);
    assertEquals(stored.value.client_name, "kept");
    assert(answer.client_id !== "chosen", "the server picks the id");
    assertEquals(stored.value.source, "dynamic");
    assertEquals(
      stored.value.client_id_issued_at,
      Math.floor(w.clock.now() / 1000),
    );
    for (const name of ["foo", "registration_access_token"]) {
      assertEquals(name in stored.value, false, `${name} is not stored`);
      assertEquals(name in answer, false, `${name} is not echoed`);
    }
    // Only a secret has an expiry, and the server sets it (0: never).
    const secretExpiry = method === "none" ? undefined : 0;
    assertEquals(stored.value.client_secret_expires_at, secretExpiry);
    assertEquals(answer.client_secret_expires_at, secretExpiry);
  }
});

// ----- DB-SWP-F12-205: a replay during issuance still revokes -----

Deno.test("DB-OAUTH-009: concurrent prepared code responses have exactly one commit winner", async () => {
  let calls = 0;
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const w = await world({
    tokenResponse: async () => {
      if (++calls === 1) {
        ready.resolve();
        await release.promise;
      }
      return {};
    },
  });
  const authorized = await authorize(w, "public-app");
  const first = redeem(w, authorized);
  await ready.promise;
  const second = await redeem(w, authorized);
  release.resolve();
  const loser = await first;
  assertEquals(second.status, 200);
  await oauthError(loser, 400, "invalid_grant");
  // A replay after commit still revokes the winning issued credentials.
  const issued = await body(second);
  await oauthError(await redeem(w, authorized), 400, "invalid_grant");
  assertEquals(
    await w.server.verifyAccessToken(issued.access_token as string),
    null,
  );
  await oauthError(
    await refreshWith(w, issued.refresh_token as string),
    400,
    "invalid_grant",
  );
});

// ----- DB-SWP-F12-206: revocation does not give up silently -----

Deno.test("DB-SWP-F12-206: a revocation that keeps losing its race fails instead of reporting success", async () => {
  const { store, hooks } = hookedStore();
  const w = await world({ store });
  const first = await body(await redeem(w, await authorize(w, "public-app")));
  const second = await body(
    await refreshWith(w, first.refresh_token as string),
  );
  // Every write to the family now loses (a thief rotating it each time).
  hooks.swapAllowed = (key) => !key.startsWith("family:");
  const reuse = await refreshWith(w, first.refresh_token as string);
  // Not "its family is revoked": it is not.
  assertEquals(reuse.status, 503);
  assertEquals((await body(reuse)).error, "temporarily_unavailable");
  hooks.swapAllowed = () => true;
  await oauthError(
    await refreshWith(w, first.refresh_token as string),
    400,
    "invalid_grant",
  );
  await oauthError(
    await refreshWith(w, second.refresh_token as string),
    400,
    "invalid_grant",
  );
});

// ----- DB-SWP-F12-207 / F12-208: device approval and polling races -----

async function startDevice(w: World) {
  return await body(
    await w.handle(
      post(
        w.server.endpoint("device"),
        { scope: "read", resource: API },
        WEB_AUTH,
      ),
    ),
  );
}

function pollDevice(w: World, deviceCode: string) {
  return w.handle(post(w.server.endpoint("token"), {
    grant_type: DEVICE_GRANT,
    device_code: deviceCode,
  }, WEB_AUTH));
}

Deno.test("DB-SWP-F12-207: an approval that races a poll still lands", async () => {
  const { store, hooks } = hookedStore();
  const w = await world({ store });
  const device = await startDevice(w);
  let interfered = false;
  hooks.afterGet = async (key) => {
    if (!key.startsWith("device:") || interfered) return;
    interfered = true;
    // The device polls between the approval's read and its write.
    await oauthError(
      await pollDevice(w, device.device_code as string),
      400,
      "authorization_pending",
    );
  };
  assert(
    await w.server.decideDevice(device.user_code as string, {
      grant: { subject: "tv-user" },
    }),
    "the approval was recorded",
  );
  assert(interfered, "the poll ran in between");
  hooks.afterGet = undefined;
  w.clock.advance(60_000);
  assertEquals((await pollDevice(w, device.device_code as string)).status, 200);
});

Deno.test("DB-SWP-F12-208: a poll that loses its write to another poll gets slow_down", async () => {
  const { store, hooks } = hookedStore();
  const w = await world({ store });
  const device = await startDevice(w);
  let inner: string | undefined;
  hooks.afterGet = async (key) => {
    if (!key.startsWith("device:") || inner !== undefined) return;
    inner = "running";
    // A second poll lands between the first one's read and its write.
    inner = (await body(await pollDevice(w, device.device_code as string)))
      .error as string;
  };
  const outer = (await body(await pollDevice(w, device.device_code as string)))
    .error;
  // One of the two was too fast, whichever wrote first.
  assertEquals([inner, outer], ["authorization_pending", "slow_down"]);
});

// ----- DB-SWP-F13-212: user codes without modulo bias -----

Deno.test("DB-SWP-F13-212: user codes reject bytes that would bias the alphabet", async () => {
  const real = crypto.getRandomValues.bind(crypto);
  const codeWith = async (first: number | null, rest: number) => {
    let calls = 0;
    // deno-lint-ignore no-explicit-any
    (crypto as any).getRandomValues = <T extends ArrayBufferView | null>(
      array: T,
    ): T => {
      if (!(array instanceof Uint8Array) || array.length !== 8) {
        return real(array as never) as T;
      }
      array.fill(calls++ === 0 && first !== null ? first : rest);
      return array;
    };
    try {
      // A fresh server each time: the same code twice would collide.
      return (await startDevice(await world())).user_code as string;
    } finally {
      // deno-lint-ignore no-explicit-any
      (crypto as any).getRandomValues = real;
    }
  };
  // 255 % 20 would pick a letter; it lies in the biased tail and must be
  // drawn again, giving what 3 gives.
  assertEquals(await codeWith(255, 3), await codeWith(null, 3));
  assert((await codeWith(239, 3)) !== (await codeWith(null, 3)), "239 is kept");
});

// ----- DB-SWP-F9-02: the exchange hook's audience is checked -----

Deno.test("DB-SWP-F9-02: a token exchange hook cannot name an audience the server does not allow", async () => {
  for (const audience of [["constructor"], ["https://evil.test"], []]) {
    const w = await world({
      unsafeTokenExchange: async (context) => {
        const claims = await context.verifyAccessToken(context.subjectToken);
        if (claims === null) return null;
        return { subject: claims.sub as string, audience };
      },
    });
    const subject = await body(
      await redeem(w, await authorize(w, "public-app")),
    );
    const answer = await w.handle(post(w.server.endpoint("token"), {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subject.access_token as string,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }, WEB_AUTH));
    await oauthError(answer, 400, "invalid_target");
  }
});

Deno.test("DB-REV-OAUTH-4: a token exchange hook's scope is held to the client's and the server's", async () => {
  const exchanger = {
    client_id: "exchanger",
    client_secret: SECRET,
    scope: "read",
    grant_types: ["urn:ietf:params:oauth:grant-type:token-exchange"],
  };
  const auth = {
    authorization: `Basic ${btoa(`exchanger:${SECRET}`)}`,
  };
  for (
    const [scope, status] of [
      [["admin"], 400], // supported, but not the client's
      [["unknown"], 400], // not supported
      [["a b"], 400], // malformed
      [["read"], 200],
    ] as const
  ) {
    const w = await world({
      unsafeTokenExchange: async (context) => {
        const claims = await context.verifyAccessToken(context.subjectToken);
        if (claims === null) return null;
        return { subject: claims.sub as string, scope: [...scope] };
      },
    }, [exchanger]);
    const subject = await body(
      await redeem(w, await authorize(w, "public-app")),
    );
    const answer = await w.handle(post(w.server.endpoint("token"), {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subject.access_token as string,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      resource: API,
    }, auth));
    if (status === 200) {
      const issued = await body(answer);
      assertEquals(issued.scope, "read");
    } else {
      await oauthError(answer, 400, "invalid_scope");
    }
  }
});

// ----- Client side -----

const METADATA: AuthorizationServerMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  device_authorization_endpoint: `${ISSUER}/device`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
};

/** A client whose server answers `answer`, JSON text (so `1e999` survives). */
function scriptedClient(answer: string, status = 200) {
  let posts = 0;
  const client = new OAuthClient({
    issuer: ISSUER,
    metadata: METADATA,
    client: { method: "none", clientId: "tv" },
    fetch: () => {
      posts++;
      return Promise.resolve(
        new Response(answer, {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    },
  });
  return { client, posts: () => posts };
}

// ----- DB-SWP-F7-104: numbers from the server are range-checked -----

Deno.test("DB-SWP-F7-104: device and token numbers from the server are bounded", async () => {
  const device = {
    device_code: "d",
    user_code: "BCDF-GHJK",
    verification_uri: `${ISSUER}/device`,
  };
  const fields =
    `"device_code":"d","user_code":"BCDF-GHJK","verification_uri":"${ISSUER}/device"`;
  for (
    const bad of [
      `"expires_in":1e999,"interval":5`,
      `"expires_in":600,"interval":1e9`,
      `"expires_in":600,"interval":1e999`,
      `"expires_in":-1`,
      `"expires_in":600,"interval":0.5`,
    ]
  ) {
    let kind: string | undefined;
    try {
      await scriptedClient(`{${fields},${bad}}`).client.deviceAuthorization();
    } catch (error) {
      kind = (error as { kind?: string }).kind;
    }
    assertEquals(kind, "token", bad);
  }
  // A hand-built authorization with a huge interval never polls at once.
  const { client, posts } = scriptedClient(
    `{"error":"authorization_pending"}`,
    400,
  );
  let waited: number[] = [];
  let threw = false;
  try {
    await client.pollDeviceToken(
      client.unsafeRestoreDevice({
        ...device,
        issuer: ISSUER,
        clientId: client.clientId,
        resource: [],
        scope: [],
        expires_at: Infinity,
        interval: 1e9,
      }),
      {
        sleep: (ms) => {
          waited.push(ms);
          return Promise.resolve();
        },
      },
    );
  } catch (error) {
    threw = error instanceof RangeError || error instanceof TypeError;
  }
  assert(threw, "the interval and expiry are checked");
  assertEquals([posts(), waited.length], [0, 0]);
  // slow_down never pushes the wait past five minutes.
  waited = [];
  let polls = 0;
  const slow = new OAuthClient({
    issuer: ISSUER,
    metadata: METADATA,
    client: { method: "none", clientId: "tv" },
    fetch: () =>
      Promise.resolve(
        Response.json(
          ++polls < 80 ? { error: "slow_down" } : { error: "access_denied" },
          { status: 400 },
        ),
      ),
  });
  try {
    await slow.pollDeviceToken(
      slow.unsafeRestoreDevice({
        ...device,
        issuer: ISSUER,
        clientId: slow.clientId,
        resource: [],
        scope: [],
        expires_at: Date.now() + 3_600_000,
        interval: 5,
      }),
      {
        sleep: (ms) => {
          waited.push(ms);
          return Promise.resolve();
        },
      },
    );
  } catch {
    // access_denied ends it.
  }
  assertEquals(Math.max(...waited), 300_000);
  // A token response whose expires_in is out of range is refused.
  const tokens = scriptedClient(
    `{"access_token":"a","token_type":"Bearer","expires_in":1e999}`,
  );
  let kind: string | undefined;
  try {
    await tokens.client.unsafeRefresh("r", {
      issuer: ISSUER,
      clientId: tokens.client.clientId,
      resource: [],
      scope: [],
    });
  } catch (error) {
    kind = (error as { kind?: string }).kind;
  }
  assertEquals(kind, "token");
});

// ----- DB-SWP-F7-105: assertion lifetimes are checked -----

Deno.test("DB-SWP-F7-105: a private_key_jwt lifetime outside 1..300 s is refused at construction", async () => {
  const key = await generateKeyPair("ES256");
  for (const lifetimeSec of [NaN, -1, 0, 301, 1e9, 1.5]) {
    let threw = false;
    try {
      new OAuthClient({
        issuer: ISSUER,
        metadata: METADATA,
        client: {
          method: "private_key_jwt",
          clientId: "c",
          privateKey: key.privateKey,
          alg: "ES256",
          lifetimeSec,
        },
      });
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assert(threw, `lifetimeSec ${lifetimeSec}`);
  }
});

// ----- DB-SWP-F12-209 / F12-210: sessions sharing one store -----

async function sharedSetup(options: { readonly registration?: boolean } = {}) {
  const w = await world(options.registration ? { registration: {} } : {});
  const api = testResourceServer(w, {
    resource: API,
    scopesSupported: ["read"],
    now: w.clock.now,
  });
  const handle = async (request: Request) => {
    const metadata = api.handleMetadata(request);
    if (metadata !== null) return metadata;
    const result = await api.verifyRequest(request, { scopes: ["read"] });
    if (!result.ok) return result.challenge.toResponse();
    return Response.json({ subject: result.principal.subject });
  };
  const issuer = { down: false };
  const fetch = routeFetch({
    [ISSUER]: (request) =>
      issuer.down ? new Response("down", { status: 503 }) : w.handle(request),
    [API]: handle,
  });
  const agent = testUserAgent(fetch);
  const store = memoryOAuthStore();
  const session = () =>
    new OAuthSession({
      resource: API,
      redirectUri: "https://app.test/cb",
      registration: options.registration
        ? { dynamic: { client_name: "shared" } }
        : { preregistered: { [ISSUER]: { client_id: "public-app" } } },
      userAgent: agent,
      fetch,
      store,
      now: w.clock.now,
    });
  const count = (suffix: string) =>
    fetch.requests.filter((request) =>
      new URL(request.url).pathname.endsWith(suffix)
    ).length;
  return { w, store, session, count, issuer };
}

Deno.test("DB-SWP-F12-209: two sessions over one store refresh once and keep the family", async () => {
  const { w, session, count } = await sharedSetup();
  const a = session();
  assertEquals((await a.resourceFetch(`${API}/files`)).status, 200);
  const b = session();
  assertEquals((await b.resourceFetch(`${API}/files`)).status, 200);
  const before = count("/token");
  w.clock.advance(290_000);
  const answers = await Promise.all([
    a.resourceFetch(`${API}/files`),
    b.resourceFetch(`${API}/files`),
  ]);
  assertEquals(answers.map((answer) => answer.status), [200, 200]);
  assertEquals(count("/token") - before, 1, "one refresh for both");
  // The family survived: a later refresh works.
  w.clock.advance(290_000);
  assertEquals((await a.resourceFetch(`${API}/files`)).status, 200);
  assertEquals(count("/token") - before, 2);
});

Deno.test("DB-SWP-F12-210: two sessions over one store register one client", async () => {
  const { session, count, store } = await sharedSetup({ registration: true });
  const a = session();
  const b = session();
  const answers = await Promise.all([
    a.resourceFetch(`${API}/files`),
    b.resourceFetch(`${API}/files`),
  ]);
  assertEquals(answers.map((answer) => answer.status), [200, 200]);
  assertEquals(count("/register"), 1);
  assert((await store.getClient(ISSUER)) !== undefined, "stored");
});

// ----- DB-SWP-F10-211: signOut reports a failed revocation -----

Deno.test("DB-SWP-F10-211: signOut says whether the refresh token was revoked", async () => {
  const { session, store, issuer } = await sharedSetup();
  const a = session();
  assertEquals((await a.resourceFetch(`${API}/files`)).status, 200);
  // The revocation endpoint is down: the tokens still go, and the caller
  // learns that the refresh token was not revoked.
  issuer.down = true;
  const outcome = await a.signOut({ revoke: true });
  issuer.down = false;
  assertEquals(outcome.revoked, false);
  assert(outcome.error !== undefined, "the failure is reported");
  assertEquals(await store.getTokens(ISSUER, API), undefined);
});

// ----- challenge parameters are null-prototype -----

Deno.test("DB-SWP-F9-13b.O1: challenge parameters named after Object.prototype are plain keys", () => {
  const [found] = parseWwwAuthenticate(
    'Bearer __proto__="x", constructor="y", error="e"',
  );
  assertEquals(Object.getPrototypeOf(found.params), null);
  assertEquals(found.params["__proto__"], "x");
  assertEquals(found.params.constructor as unknown, "y");
  assertEquals(found.params.error, "e");
});
