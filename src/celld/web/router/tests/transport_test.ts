// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// DB-RTR-010: one public URL per request, resolved by the router from
// explicitly trusted metadata and shared by every security module.
// DB-RTR-011: one cleartext rule for every credential scheme.

import { assert, assertEquals, assertThrows } from "@celld/core/assert";
import {
  apiKey,
  type AuthScheme,
  basic,
  bearer,
  dpop,
  HSTS,
  router,
  RouterError,
  type RouterOptions,
  session,
  unsafeMemoryReplayStore,
} from "@celld/web/router";
import {
  assertHeader,
  assertMatch,
  assertStatus,
  call,
  dpopProof,
  proofKey,
} from "./fixture.ts";

/** The peer source named explicitly, as trusted-proxy mode requires. */
const EDGE = { peerHeader: "cf-connecting-ip" };

function echo(options: Omit<RouterOptions, "auth"> = {}) {
  const app = router({ auth: "none", ...options });
  app.get("/*rest", (c) => c.text(c.publicUrl.href));
  return app;
}

Deno.test("publicUrl: by default the request URL", async () => {
  assertEquals(
    (await call(echo(), "/a/b?x=1", { origin: "http://10.0.0.7:8080" })).text,
    "http://10.0.0.7:8080/a/b?x=1",
  );
  assertEquals(
    (await call(echo({ publicUrl: { mode: "request" } }), "/a")).text,
    "https://api.example.com/a",
  );
});

Deno.test("publicUrl: a fixed origin keeps the path and query", async () => {
  const app = echo({
    publicUrl: { mode: "fixed", origin: "https://api.example.org" },
  });
  const answer = await call(app, "/a/b?x=1", {
    origin: "http://10.0.0.7:8080",
    headers: {
      "x-forwarded-proto": "http",
      "x-forwarded-host": "evil.example.net",
    },
  });
  assertEquals(answer.text, "https://api.example.org/a/b?x=1");
});

Deno.test("publicUrl: authority-like paths cannot replace the trusted origin", async () => {
  for (const mode of ["fixed", "trusted-proxy"] as const) {
    const app = echo({
      publicUrl: mode === "fixed"
        ? { mode, origin: "https://public.example" }
        : { mode, trustedProxies: ["10.0.0.0/8"] },
      clientIp: EDGE,
    });
    for (
      const path of [
        "//attacker.example/x?next=1",
        "///attacker.example/x",
        "//user@attacker.example/",
      ]
    ) {
      const answer = await call(app, path, {
        origin: "http://10.0.0.7:8080",
        headers: {
          "cf-connecting-ip": "10.0.0.2",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "public.example",
        },
      });
      assertStatus(answer, 200);
      assertEquals(answer.text, `https://public.example${path}`, mode);
      assertEquals(new URL(answer.text).origin, "https://public.example");
    }
  }
});

Deno.test("publicUrl: constructor rejects discriminant getters without invoking them", () => {
  let called = false;
  assertThrows(
    () =>
      echo({
        publicUrl: {
          get mode() {
            called = true;
            return "fixed" as const;
          },
          origin: "https://public.example",
        },
      }),
    RouterError,
  );
  assertEquals(called, false);
});

Deno.test("publicUrl: forwarded headers count only from a trusted proxy", async () => {
  const app = echo({
    publicUrl: { mode: "trusted-proxy", trustedProxies: ["10.0.0.0/8"] },
    clientIp: EDGE,
  });
  const forwarded = {
    "x-forwarded-proto": "https",
    "x-forwarded-host": "public.example.com",
  };
  const origin = "http://10.0.0.7:8080";
  assertEquals(
    (await call(app, "/a?q", {
      origin,
      headers: { "cf-connecting-ip": "10.0.0.2", ...forwarded },
    })).text,
    "https://public.example.com/a?q",
  );
  assertEquals(
    (await call(app, "/a", {
      origin,
      headers: { "cf-connecting-ip": "198.51.100.7", ...forwarded },
    })).text,
    "http://10.0.0.7:8080/a",
    "an untrusted peer's headers are ignored",
  );
  assertEquals(
    (await call(app, "/a", { origin, headers: forwarded })).text,
    "http://10.0.0.7:8080/a",
    "no peer, no trust",
  );
  for (
    const bad of [
      { "x-forwarded-proto": "https, http" },
      { "x-forwarded-proto": "gopher" },
      { "x-forwarded-host": "a.example.com/path" },
      { "x-forwarded-host": "user@a.example.com" },
      { "x-forwarded-host": "a.example.com, b.example.com" },
    ]
  ) {
    assertEquals(
      (await call(app, "/a", {
        origin,
        headers: { "cf-connecting-ip": "10.0.0.2", ...forwarded, ...bad },
      })).status,
      400,
      `malformed trusted metadata is refused: ${JSON.stringify(bad)}`,
    );
  }
  const named = echo({
    publicUrl: {
      mode: "trusted-proxy",
      trustedProxies: ["10.0.0.0/8"],
      proto: "x-scheme",
      host: "x-host",
    },
    clientIp: EDGE,
  });
  assertEquals(
    (await call(named, "/a", {
      origin,
      headers: {
        "cf-connecting-ip": "10.0.0.2",
        "x-scheme": "https",
        "x-host": "b.example.com:8443",
        ...forwarded,
      },
    })).text,
    "https://b.example.com:8443/a",
  );
});

Deno.test("publicUrl: a function decides; a non-URL is a 500", async () => {
  const app = echo({
    publicUrl: (c) => new URL(c.url.pathname, "https://fn.example.com"),
  });
  assertEquals(
    (await call(app, "/a", { origin: "http://10.0.0.7" })).text,
    "https://fn.example.com/a",
  );
  const broken = echo({
    publicUrl: () => "https://x.example.com" as unknown as URL,
  });
  assertStatus(await call(broken, "/a"), 500);
});

Deno.test("publicUrl: settings are checked when the router is made", () => {
  for (
    const bad of [
      { mode: "fixed", origin: "https://a.example.com/path" },
      { mode: "fixed", origin: "ftp://a.example.com" },
      { mode: "fixed" },
      { mode: "trusted-proxy" },
      { mode: "trusted-proxy", trustedProxies: ["10.0.0.0/8"], proto: 7 },
      { mode: "forwarded" },
      "request",
    ]
  ) {
    assertThrows(
      () => router({ auth: "none", publicUrl: bad as never }),
      RouterError,
      "publicUrl",
    );
  }
  assertThrows(
    () =>
      router({
        auth: "none",
        publicUrl: { mode: "trusted-proxy", trustedProxies: ["10.0.0.0/33"] },
        clientIp: EDGE,
      }),
    Error,
    "",
  );
});

Deno.test("publicUrl: trusted-proxy mode needs an explicit peer source", async () => {
  // Sweep DB-SWP-F6-13.R1: the default peer is the `CF-Connecting-IP`
  // header, which any client writes when it reaches the Worker directly;
  // trusting forwarded scheme and host on its word lets a client claim
  // https (and so send credentials) over plain http.
  assertThrows(
    () =>
      router({
        auth: "none",
        publicUrl: { mode: "trusted-proxy", trustedProxies: ["10.0.0.0/8"] },
      }),
    RouterError,
    "clientIp.peer",
  );
  assertThrows(
    () =>
      router({
        auth: "none",
        publicUrl: { mode: "trusted-proxy", trustedProxies: ["10.0.0.0/8"] },
        clientIp: { trustedProxies: ["10.0.0.0/8"] },
      }),
    RouterError,
    "clientIp.peer",
  );
  const adapter = echo({
    publicUrl: { mode: "trusted-proxy", trustedProxies: ["10.0.0.0/8"] },
    clientIp: { peer: () => "10.0.0.2" },
  });
  assertEquals(
    (await call(adapter, "/a", {
      origin: "http://10.0.0.7:8080",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "p.example",
      },
    })).text,
    "https://p.example/a",
  );
});

Deno.test("publicUrl: HSTS, CSRF and redirects use it", async () => {
  const cookie: AuthScheme = {
    name: "cookie",
    ambient: true,
    authenticate: (c) => c.cookie("sid") === "s1" ? { subject: "ada" } : null,
  };
  const app = router({
    auth: cookie,
    publicUrl: { mode: "fixed", origin: "https://app.example.com" },
    allowCleartextCredentialsForDevelopment: false,
  });
  app.post("/transfer", (c) => c.text("sent"));
  app.get(
    "/go",
    { public: true },
    (c) => c.redirect("https://app.example.com/next"),
  );
  const internal = "http://10.0.0.7:8080";
  const same = await call(app, "/transfer", {
    method: "POST",
    origin: internal,
    headers: { cookie: "sid=s1", origin: "https://app.example.com" },
  });
  assertStatus(same, 200);
  assertHeader(same, "strict-transport-security", HSTS);
  const inner = await call(app, "/transfer", {
    method: "POST",
    origin: internal,
    headers: { cookie: "sid=s1", origin: internal },
  });
  assertStatus(inner, 403);
  assertMatch(inner.json, { error: "csrf" });
  const go = await call(app, "/go", { origin: internal });
  assertHeader(go, "location", "/next");

  const plain = router({
    auth: "none",
    publicUrl: { mode: "fixed", origin: "http://127.0.0.1:8080" },
  });
  plain.get("/", (c) => c.text("x"));
  assertHeader(
    await call(plain, "/"),
    "strict-transport-security",
    null,
  );
});

// DB-RTR-011

const key = await proofKey();

/** One router per built-in credential scheme, with a request carrying it. */
async function credentialed(): Promise<
  {
    name: string;
    scheme: AuthScheme;
    path: string;
    headers: () => Promise<Record<string, string>>;
  }[]
> {
  const sessions = session({
    keys: [{ id: "k", secret: "0123456789abcdef0123456789abcdef" }],
  });
  const issuing = router({ auth: sessions });
  issuing.post("/login", { public: true, csrf: false }, async (c) => {
    await sessions.issue(c, { subject: "ada" });
    return c.text("in");
  });
  const login = await call(issuing, "/login", { method: "POST" });
  const sessionCookie = login.headers.get("set-cookie")!.split(";")[0];
  return [
    {
      name: "basic",
      scheme: basic({ verify: () => ({ subject: "ada" }) }),
      path: "/things",
      headers: () =>
        Promise.resolve({ authorization: `Basic ${btoa("ada:pw")}` }),
    },
    {
      name: "bearer",
      scheme: bearer({ verify: () => ({ subject: "ada" }) }),
      path: "/things",
      headers: () => Promise.resolve({ authorization: "Bearer t" }),
    },
    {
      name: "apiKey header",
      scheme: apiKey({ lookup: () => ({ subject: "ada" }) }),
      path: "/things",
      headers: () => Promise.resolve({ "x-api-key": "k-1" }),
    },
    {
      name: "apiKey query",
      scheme: apiKey({ query: "key", lookup: () => ({ subject: "ada" }) }),
      path: "/things?key=k-1",
      headers: () => Promise.resolve({}),
    },
    {
      name: "session",
      scheme: sessions,
      path: "/things",
      headers: () => Promise.resolve({ cookie: sessionCookie }),
    },
  ];
}

function served(scheme: AuthScheme, options: Omit<RouterOptions, "auth"> = {}) {
  const app = router({ auth: scheme, ...options });
  app.get("/things", (c) => c.text(c.principal.subject));
  return app;
}

Deno.test("every credential scheme refuses plain http off loopback", async () => {
  for (const { name, scheme, path, headers } of await credentialed()) {
    const app = served(scheme);
    for (
      const origin of [
        "http://api.example.com",
        "http://10.0.0.7:8080",
        "http://localhost:8080",
      ]
    ) {
      const answer = await call(app, path, {
        origin,
        headers: await headers(),
      });
      assertStatus(answer, 403);
      assertMatch(answer.json, { error: "insecure_transport" });
      assertHeader(answer, "www-authenticate", null);
      assertEquals(
        answer.headers.get("cache-control"),
        "private, no-store",
        `${name} over ${origin}`,
      );
    }
    for (
      const origin of [
        "https://api.example.com",
        "http://127.0.0.1:8080",
        "http://127.8.9.10",
        "http://[::1]:8080",
      ]
    ) {
      const answer = await call(app, path, {
        origin,
        headers: await headers(),
      });
      assertEquals(
        [answer.status, answer.text],
        [200, "ada"],
        `${name} over ${origin}`,
      );
    }
    const dev = served(scheme, {
      allowCleartextCredentialsForDevelopment: true,
    });
    assertEquals(
      (await call(dev, path, {
        origin: "http://api.example.com",
        headers: await headers(),
      })).text,
      "ada",
      `${name} with the development override`,
    );
    const proxied = served(scheme, {
      publicUrl: {
        mode: "trusted-proxy",
        trustedProxies: ["10.0.0.0/8"],
      },
      clientIp: EDGE,
    });
    assertEquals(
      (await call(proxied, path, {
        origin: "http://10.0.0.7:8080",
        headers: {
          ...await headers(),
          "cf-connecting-ip": "10.0.0.2",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "api.example.com",
        },
      })).text,
      "ada",
      `${name} behind a trusted TLS proxy`,
    );
    assertStatus(
      await call(proxied, path, {
        origin: "http://10.0.0.7:8080",
        headers: {
          ...await headers(),
          "cf-connecting-ip": "198.51.100.7",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "api.example.com",
        },
      }),
      403,
    );
  }
});

Deno.test("dpop refuses plain http, and checks htu against the router's public URL", async () => {
  const scheme = dpop({
    verify: () => ({ subject: "ada", cnf: { jkt: key.jkt } }),
    replay: unsafeMemoryReplayStore(),
  });
  const headers = async (url: string) => ({
    authorization: "DPoP t",
    dpop: await dpopProof(key, { token: "t", url }),
  });
  const plain = served(scheme);
  const refused = await call(plain, "/things", {
    origin: "http://api.example.com",
    headers: await headers("http://api.example.com/things"),
  });
  assertStatus(refused, 403);
  assertMatch(refused.json, { error: "insecure_transport" });
  assertHeader(refused, "www-authenticate", null);

  const proxied = served(scheme, {
    publicUrl: { mode: "fixed", origin: "https://public.example.com" },
  });
  const internal = "http://10.0.0.7:8080";
  assertEquals(
    (await call(proxied, "/things", {
      origin: internal,
      headers: await headers("https://public.example.com/things"),
    })).text,
    "ada",
  );
  assertStatus(
    await call(proxied, "/things", {
      origin: internal,
      headers: await headers(`${internal}/things`),
    }),
    401,
  );

  // The scheme's own publicUrl still overrides the router's.
  const own = served(
    dpop({
      verify: () => ({ subject: "ada", cnf: { jkt: key.jkt } }),
      replay: unsafeMemoryReplayStore(),
      publicUrl: (c) => new URL(c.url.pathname, "https://own.example.com"),
    }),
    { publicUrl: { mode: "fixed", origin: "https://public.example.com" } },
  );
  assertEquals(
    (await call(own, "/things", {
      origin: internal,
      headers: await headers("https://own.example.com/things"),
    })).text,
    "ada",
  );
});

Deno.test("without a credential, plain http is the usual 401", async () => {
  const app = served(bearer({ verify: () => ({ subject: "ada" }) }));
  const answer = await call(app, "/things", {
    origin: "http://api.example.com",
  });
  assertStatus(answer, 401);
  assertHeader(answer, "www-authenticate", "Bearer");
  const basicApp = served(basic({ verify: () => ({ subject: "ada" }) }));
  const none = await call(basicApp, "/things", {
    origin: "http://api.example.com",
  });
  assertStatus(none, 401);
  assertHeader(none, "www-authenticate", null);
  assert(
    (await call(basicApp, "/things")).headers.get("www-authenticate") !== null,
    "https still challenges",
  );
});

Deno.test("the development override must be a boolean", () => {
  assertThrows(
    () =>
      router({
        auth: "none",
        allowCleartextCredentialsForDevelopment: "yes" as unknown as boolean,
      }),
    RouterError,
    "allowCleartextCredentialsForDevelopment",
  );
});

// DB-REV-RTR-10: in trusted-proxy mode the operator names the headers the
// proxy sets; a header it is said to set but did not send is a 400 (not
// the request's own value, which the client may have chosen), and `false`
// says the proxy does not set it, so it is never read.
Deno.test("publicUrl: a trusted proxy's missing header is a 400, and false never reads it", async () => {
  const origin = "http://10.0.0.7:8080";
  const peer = { "cf-connecting-ip": "10.0.0.2" };
  const app = echo({
    publicUrl: { mode: "trusted-proxy", trustedProxies: ["10.0.0.0/8"] },
    clientIp: EDGE,
  });
  const noHost = await call(app, "/a", {
    origin,
    headers: { ...peer, "x-forwarded-proto": "https" },
  });
  assertStatus(noHost, 400);
  assert(noHost.text.includes("x-forwarded-host"), noHost.text);
  assertStatus(
    await call(app, "/a", {
      origin,
      headers: { ...peer, "x-forwarded-host": "p.example" },
    }),
    400,
  );
  // An untrusted peer's headers are still just ignored.
  assertEquals(
    (await call(app, "/a", {
      origin,
      headers: { "x-forwarded-proto": "https" },
    }))
      .text,
    `${origin}/a`,
  );
  // host: false: a proxy that forwards the Host itself; X-Forwarded-Host,
  // which the client may have written, is never read.
  const hostless = echo({
    publicUrl: {
      mode: "trusted-proxy",
      trustedProxies: ["10.0.0.0/8"],
      host: false,
    },
    clientIp: EDGE,
  });
  assertEquals(
    (await call(hostless, "/a", {
      origin: "http://api.example.com",
      headers: {
        ...peer,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
      },
    })).text,
    "https://api.example.com/a",
  );
  assertStatus(
    await call(hostless, "/a", {
      origin: "http://api.example.com",
      headers: peer,
    }),
    400,
  );
  assertThrows(
    () =>
      echo({
        publicUrl: {
          mode: "trusted-proxy",
          trustedProxies: ["10.0.0.0/8"],
          host: false,
          proto: false,
        },
        clientIp: EDGE,
      }),
    RouterError,
    "proto",
  );
});
