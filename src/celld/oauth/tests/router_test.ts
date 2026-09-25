// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { ProtocolError, resourceChallenge } from "@celld/oauth";
import { DpopKey, DpopNonceIssuer, memoryReplayStore } from "@celld/oauth/dpop";
import {
  jwtAccessTokenVerifier,
  ResourceServer,
  type ResourceServerOptions,
} from "@celld/oauth/resource";
import { oauthSchemes, protectedResourceRoutes } from "@celld/oauth/router";
import {
  generateSigningKey,
  issueAccessToken,
  publicJwks,
} from "@celld/oauth/server";
import { manualClock } from "@celld/oauth/testing";
import { router } from "@celld/router";
import { API, ISSUER } from "./fixture.ts";

const clock = manualClock(Date.UTC(2026, 8, 25, 12));
const key = await generateSigningKey("ES256", "k1");
const METADATA = `${API}/.well-known/oauth-protected-resource`;

async function token(
  options: { jkt?: string; scope?: string[] } = {},
): Promise<string> {
  return (await issueAccessToken(
    key,
    ISSUER,
    {
      subject: "alice",
      clientId: "app",
      scope: options.scope ?? ["read"],
      audience: [API],
      ...(options.jkt === undefined ? {} : { jkt: options.jkt }),
    },
    300,
    clock.now,
  )).token;
}

function resource(
  options: Partial<ResourceServerOptions> = {},
): ResourceServer {
  return new ResourceServer({
    resource: API,
    authorizationServers: [ISSUER],
    verifier: jwtAccessTokenVerifier({
      issuer: ISSUER,
      audience: API,
      keys: publicJwks([key]),
      now: clock.now,
    }),
    dpop: { replay: memoryReplayStore({ now: clock.now }) },
    now: clock.now,
    ...options,
  });
}

function app(server: ResourceServer) {
  const app = router({ auth: oauthSchemes(server) });
  app.get("/files", { scopes: ["read"] }, (c) =>
    c.json({
      subject: c.principal.subject,
      client: c.principal.clientId ?? null,
      scheme: c.principal.scheme,
      jkt: c.principal.cnf?.jkt ?? null,
    }));
  app.post("/files", { scopes: ["write"] }, (c) => c.text("saved"));
  return app;
}

async function call(
  fetches: ReturnType<typeof app>,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Response> {
  return await fetches.fetch(new Request(`${API}/files`, { method, headers }));
}

async function proof(
  dpop: DpopKey,
  access: string,
  options: { method?: string; nonce?: string } = {},
): Promise<Record<string, string>> {
  return {
    authorization: `DPoP ${access}`,
    dpop: await dpop.proof({
      method: options.method ?? "GET",
      url: `${API}/files`,
      accessToken: access,
      nonce: options.nonce,
      now: clock.now,
    }),
  };
}

Deno.test("schemes follow the resource server: DPoP and Bearer, DPoP only, Bearer only", () => {
  assertEquals(
    oauthSchemes(resource()).map((scheme) => scheme.name),
    ["dpop", "bearer"],
  );
  assertEquals(
    oauthSchemes(resource({ dpop: { required: true } })).map((s) => s.name),
    ["dpop"],
  );
  assertEquals(
    oauthSchemes(resource({ dpop: false })).map((s) => s.name),
    ["bearer"],
  );
  assertEquals(
    oauthSchemes(resource(), { names: { dpop: "d", bearer: "b" } }).map((
      s,
    ) => s.name),
    ["d", "b"],
  );
});

Deno.test("a bearer token becomes the principal", async () => {
  const response = await call(app(resource()), {
    authorization: `Bearer ${await token()}`,
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    subject: "alice",
    client: "app",
    scheme: "bearer",
    jkt: null,
  });
  assertEquals(response.headers.get("dpop-nonce"), null);
});

Deno.test("no credential: every challenge with realm and resource_metadata", async () => {
  const response = await call(app(resource({ realm: "files" })));
  assertEquals(response.status, 401);
  assertEquals(
    response.headers.get("www-authenticate"),
    `DPoP realm="files", algs="ES256 ES384 ES512 PS256 PS384 PS512 RS256", resource_metadata="${METADATA}", ` +
      `Bearer realm="files", resource_metadata="${METADATA}"`,
  );
});

Deno.test("a refused token keeps the resource server's code and description", async () => {
  const response = await call(app(resource()), {
    authorization: "Bearer not.a.jwt",
  });
  assertEquals(response.status, 401);
  const challenge = resourceChallenge(
    response.headers.get("www-authenticate"),
    "Bearer",
  )!;
  assertEquals(challenge.error, "invalid_token");
  assertEquals(challenge.resourceMetadata, METADATA);
});

Deno.test("a missing scope is 403 insufficient_scope with resource_metadata", async () => {
  const response = await call(
    app(resource()),
    { authorization: `Bearer ${await token()}` },
    "POST",
  );
  assertEquals(response.status, 403);
  const challenge = resourceChallenge(
    response.headers.get("www-authenticate"),
    "Bearer",
  )!;
  assertEquals(challenge.error, "insufficient_scope");
  assertEquals(challenge.scopes, ["write"]);
  assertEquals(challenge.resourceMetadata, METADATA);
});

Deno.test("DPoP: use_dpop_nonce, then success; the fresh nonce reaches every answer", async () => {
  const nonce = await DpopNonceIssuer.create({ now: clock.now });
  const server = resource({ dpop: { nonce, replay: memoryReplayStore() } });
  const api = app(server);
  const dpop = await DpopKey.generate({ now: clock.now });
  const access = await token({ jkt: dpop.jkt });

  const first = await call(api, await proof(dpop, access));
  assertEquals(first.status, 401);
  const challenge = resourceChallenge(
    first.headers.get("www-authenticate"),
    "DPoP",
  )!;
  assertEquals(challenge.error, "use_dpop_nonce");
  assertEquals(challenge.resourceMetadata, METADATA);
  const fresh = first.headers.get("dpop-nonce");
  assert(fresh !== null, "a DPoP-Nonce on the refusal");

  const second = await call(api, await proof(dpop, access, { nonce: fresh }));
  assertEquals(second.status, 200);
  assertEquals(await second.json(), {
    subject: "alice",
    client: "app",
    scheme: "dpop",
    jkt: dpop.jkt,
  });
  assertEquals(second.headers.get("dpop-nonce"), await nonce.current());

  const denied = await call(
    api,
    await proof(dpop, access, { method: "POST", nonce: fresh }),
    "POST",
  );
  assertEquals(denied.status, 403);
  assertEquals(denied.headers.get("dpop-nonce"), await nonce.current());
  assertEquals(
    resourceChallenge(denied.headers.get("www-authenticate"), "DPoP")!.error,
    "insufficient_scope",
  );
});

Deno.test("DPoP: a replayed proof is refused", async () => {
  const api = app(resource());
  const dpop = await DpopKey.generate({ now: clock.now });
  const access = await token({ jkt: dpop.jkt });
  const headers = await proof(dpop, access);
  assertEquals((await call(api, headers)).status, 200);
  const again = await call(api, headers);
  assertEquals(again.status, 401);
  assertEquals(
    resourceChallenge(again.headers.get("www-authenticate"), "DPoP")!.error,
    "invalid_dpop_proof",
  );
});

Deno.test("DPoP behind a proxy: htu is checked against publicUrl", async () => {
  const server = resource();
  const dpop = await DpopKey.generate({ now: clock.now });
  const access = await token({ jkt: dpop.jkt });
  const internal = (headers: Record<string, string>) =>
    new Request("http://10.0.0.7:8080/files", { headers });
  // The Worker sees an internal URL; the proof names the public one.
  const plain = app(server);
  const refused = await plain.fetch(internal(await proof(dpop, access)));
  assertEquals(refused.status, 401);
  assertEquals(
    resourceChallenge(refused.headers.get("www-authenticate"), "DPoP")!.error,
    "invalid_dpop_proof",
  );
  const proxied = router({
    auth: oauthSchemes(server, {
      publicUrl: (c) => new URL(c.url.pathname + c.url.search, API),
    }),
  });
  proxied.get("/files", (c) => c.text(c.principal.subject));
  const accepted = await proxied.fetch(internal(await proof(dpop, access)));
  assertEquals([accepted.status, await accepted.text()], [200, "alice"]);
});

Deno.test("a verifier that is down is a 503, not a 401", async () => {
  const api = app(resource({
    verifier: {
      verify: () =>
        Promise.reject(
          new ProtocolError("temporarily_unavailable", {
            status: 503,
            description: "introspection is down",
          }),
        ),
    },
  }));
  const response = await call(api, { authorization: "Bearer opaque" });
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("www-authenticate"), null);
});

Deno.test("protectedResourceRoutes: the metadata is public at the resource's well-known URL", async () => {
  const server = resource({ scopesSupported: ["read", "write"] });
  const api = protectedResourceRoutes(app(server), server);
  assertEquals(
    api.routes().filter((route) => route.pattern.startsWith("/.well-known"))
      .map((route) => [route.method, route.pattern, route.options.public]),
    [["GET", "/.well-known/oauth-protected-resource", true]],
  );
  const response = await api.fetch(new Request(METADATA));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "max-age=300");
  const document = await response.json();
  assertEquals(document, server.metadata);
  assertEquals(document.resource, API);
  const head = await api.fetch(new Request(METADATA, { method: "HEAD" }));
  assertEquals(head.status, 200);
  const post = await api.fetch(new Request(METADATA, { method: "POST" }));
  assertEquals(post.status, 405);
  // Public, but a bad credential is still refused.
  const bad = await api.fetch(
    new Request(METADATA, { headers: { authorization: "Bearer not.a.jwt" } }),
  );
  assertEquals(bad.status, 401);
});

Deno.test("protectedResourceRoutes: a resource at the origin root, with or without its slash", async () => {
  for (const id of [API, `${API}/`]) {
    const server = resource({ resource: id });
    const api = protectedResourceRoutes(
      router({ auth: oauthSchemes(server) }),
      server,
      { root: true },
    );
    assertEquals(api.routes().map((route) => route.pattern), [
      "/.well-known/oauth-protected-resource",
    ]);
    const response = await api.fetch(new Request(server.resourceMetadataUrl));
    assertEquals(server.resourceMetadataUrl, METADATA);
    assertEquals((await response.json()).resource, id);
  }
});

Deno.test("protectedResourceRoutes: a resource with a path, and the root form on request", async () => {
  const id = `${API}/v1/my%20files`;
  const server = resource({ resource: id });
  const pathOnly = protectedResourceRoutes(
    router({ auth: oauthSchemes(server) }),
    server,
  );
  assertEquals(pathOnly.routes().map((route) => route.pattern), [
    "/.well-known/oauth-protected-resource/v1/my files",
  ]);
  assertEquals(
    (await pathOnly.fetch(new Request(server.resourceMetadataUrl))).status,
    200,
  );
  assertEquals((await pathOnly.fetch(new Request(METADATA))).status, 404);

  const both = protectedResourceRoutes(
    router({ auth: oauthSchemes(server) }),
    server,
    { root: true },
  );
  for (const url of [server.resourceMetadataUrl, METADATA]) {
    const response = await both.fetch(new Request(url));
    assertEquals(response.status, 200, url);
    assertEquals((await response.json()).resource, id);
  }
});

Deno.test("protectedResourceRoutes: a custom metadata URL, and one no pattern can hold", () => {
  const custom = resource({ resourceMetadataUrl: `${API}/meta/prm.json` });
  assertEquals(
    protectedResourceRoutes(router({ auth: "none" }), custom).routes().map((
      route,
    ) => route.pattern),
    ["/meta/prm.json"],
  );
  const odd = resource({ resourceMetadataUrl: `${API}/meta/:x` });
  let thrown: unknown;
  try {
    protectedResourceRoutes(router({ auth: "none" }), odd);
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof TypeError, "a TypeError");
});
