// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import {
  ExeError,
  mintExe0,
  mintingTokenSource,
  signerFromOpenSsh,
  verifyExe0,
} from "@celld/api/exedev";
import {
  basicAuthorization,
  devIdentityHeaders,
  exeAuth,
  exeIdentity,
  integrationAddLink,
  isAuthenticated,
  loginPath,
  LOGOUT_PATH,
  newVmLink,
  suggestLink,
  VmEndpointClient,
  vmOrigin,
} from "@celld/api/exedev/proxy";
import { fakeFetch } from "@celld/api/exedev/testing";
import { router } from "@celld/router";
import * as fixture from "./fixtures.ts";

Deno.test("exeIdentity reads the proxy's headers and the token ctx", () => {
  const request = new Request("https://my-vm.exe.xyz/api", {
    headers: {
      "X-ExeDev-UserID": "usr1234",
      "X-ExeDev-Email": "alice@example.com",
      "X-ExeDev-Token-Ctx": '{"role":"deploy","n":1}',
      "X-Exedev-Source-Vm": "alice-vm",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "my-vm.exe.xyz:8443",
      "X-Forwarded-For":
        "10.0.0.1, unknown, 2001:DB8::1, 010.0.0.1, 64.34.88.25",
    },
  });
  const identity = exeIdentity(request);
  assertEquals(identity, {
    userId: "usr1234",
    email: "alice@example.com",
    tokenCtxRaw: '{"role":"deploy","n":1}',
    tokenCtx: { role: "deploy", n: 1 },
    sourceVm: "alice-vm",
    forwarded: {
      proto: "https",
      host: "my-vm.exe.xyz:8443",
      // Hops that are not addresses are dropped; IPv6 is canonical.
      for: ["10.0.0.1", "2001:db8::1", "64.34.88.25"],
    },
  });
  assert(isAuthenticated(identity), "authenticated");
});

Deno.test("anonymous requests and unreadable ctx", () => {
  const anonymous = exeIdentity(new Headers());
  assertEquals([
    anonymous.userId,
    anonymous.email,
    anonymous.tokenCtxRaw,
    anonymous.tokenCtx,
    anonymous.forwarded.for,
  ], [null, null, null, undefined, []]);
  assert(!isAuthenticated(anonymous), "anonymous");
  const duplicate = exeIdentity(
    new Headers({ "x-exedev-token-ctx": '{"a":1,"a":2}' }),
  );
  assertEquals([duplicate.tokenCtxRaw, duplicate.tokenCtx], [
    '{"a":1,"a":2}',
    undefined,
  ]);
});

Deno.test("login and logout paths", () => {
  assertEquals(
    loginPath("/dashboard?tab=1"),
    "/__exe.dev/login?redirect=%2Fdashboard%3Ftab%3D1",
  );
  assertEquals(LOGOUT_PATH, "/__exe.dev/logout");
  for (const bad of ["https://evil.example/", "//evil.example/x", "relative"]) {
    try {
      loginPath(bad);
      throw new Error(`accepted ${bad}`);
    } catch (error) {
      assert(error instanceof ExeError, String(error));
    }
  }
});

function exeApp() {
  const app = router({ auth: exeAuth() });
  app.get("/me", (c) =>
    c.json({
      subject: c.principal.subject,
      scheme: c.principal.scheme,
      claims: c.principal.claims,
    }));
  app.post("/notes", (c) => c.json({ by: c.principal.subject }, 201));
  app.get(
    "/health",
    { public: true },
    (c) => c.json({ user: c.principal?.subject ?? null }),
  );
  return app;
}

const ORIGIN = "https://my-vm.exe.xyz";
const ALICE = {
  "X-ExeDev-UserID": "usr1234",
  "X-ExeDev-Email": "alice@example.com",
};

Deno.test("exeAuth: the proxy's user is the principal", async () => {
  const app = exeApp();
  const response = await app.fetch(
    new Request(`${ORIGIN}/me`, {
      headers: {
        ...ALICE,
        "X-ExeDev-Token-Ctx": '{"role":"deploy"}',
        "X-Exedev-Source-Vm": "bob-vm",
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    subject: "usr1234",
    scheme: "exe",
    claims: {
      email: "alice@example.com",
      tokenCtx: { role: "deploy" },
      tokenCtxRaw: '{"role":"deploy"}',
      sourceVm: "bob-vm",
    },
  });
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("exeAuth: browsers go to the login page, other clients get a 401", async () => {
  const app = exeApp();
  const browser = await app.fetch(
    new Request(`${ORIGIN}/me?tab=1`, {
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    }),
  );
  assertEquals([browser.status, browser.headers.get("location")], [
    302,
    "/__exe.dev/login?redirect=%2Fme%3Ftab%3D1",
  ]);
  assertEquals(browser.headers.get("x-content-type-options"), "nosniff");
  const head = await app.fetch(
    new Request(`${ORIGIN}/me`, {
      method: "HEAD",
      headers: { accept: "text/html" },
    }),
  );
  assertEquals(head.status, 302);
  const others: RequestInit[] = [
    { headers: { accept: "application/json" } },
    { headers: { accept: "*/*" } },
    { headers: { accept: "text/html;q=0" } },
    {},
    { method: "POST", headers: { accept: "text/html", origin: ORIGIN } },
  ];
  for (const init of others) {
    const path = init.method === "POST" ? "/notes" : "/me";
    const response = await app.fetch(new Request(`${ORIGIN}${path}`, init));
    assertEquals(response.status, 401, JSON.stringify(init));
    await response.body?.cancel();
  }
  const quiet = router({ auth: exeAuth({ loginRedirect: false }) });
  quiet.get("/me", (c) => c.text(c.principal.subject));
  const refused = await quiet.fetch(
    new Request(`${ORIGIN}/me`, { headers: { accept: "text/html" } }),
  );
  assertEquals(refused.status, 401);
  await refused.body?.cancel();
});

Deno.test("exeAuth: the login cookie is ambient, so CSRF applies", async () => {
  const app = exeApp();
  const crossSite = await app.fetch(
    new Request(`${ORIGIN}/notes`, {
      method: "POST",
      headers: {
        ...ALICE,
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
    }),
  );
  assertEquals(crossSite.status, 403);
  await crossSite.body?.cancel();
  const sameOrigin = await app.fetch(
    new Request(`${ORIGIN}/notes`, {
      method: "POST",
      headers: { ...ALICE, "sec-fetch-site": "same-origin" },
    }),
  );
  assertEquals([sameOrigin.status, await sameOrigin.json()], [201, {
    by: "usr1234",
  }]);
});

Deno.test("exeAuth: public routes serve anonymous requests", async () => {
  const app = exeApp();
  const anonymous = await app.fetch(
    new Request(`${ORIGIN}/health`, { headers: { accept: "text/html" } }),
  );
  assertEquals([anonymous.status, await anonymous.json()], [200, {
    user: null,
  }]);
  const known = await app.fetch(
    new Request(`${ORIGIN}/health`, { headers: ALICE }),
  );
  assertEquals(await known.json(), { user: "usr1234" });
  assertEquals(exeAuth().openapi, {
    type: "apiKey",
    in: "header",
    name: "X-ExeDev-UserID",
    description:
      "Set by exe.dev's HTTPS proxy for a logged-in user or a token's owner; log in at /__exe.dev/login.",
  });
});

Deno.test("devIdentityHeaders stand in for the proxy", () => {
  const headers = devIdentityHeaders({
    userId: "usr1234",
    email: "user@example.com",
    ctx: { a: 1 },
    sourceVm: "bob",
  });
  const identity = exeIdentity(new Headers(headers));
  assertEquals([
    identity.userId,
    identity.email,
    identity.tokenCtx,
    identity.sourceVm,
  ], ["usr1234", "user@example.com", { a: 1 }, "bob"]);
});

Deno.test("VM endpoint calls carry the token in X-Exedev-Authorization", async () => {
  const fetch = fakeFetch(() => new Response("ok"));
  const client = new VmEndpointClient({
    vm: "my-vm",
    port: 3000,
    token: fixture.VM_TOKEN,
    fetch,
  });
  await client.fetch("/repo.git/info/refs", { headers: { accept: "*/*" } });
  assertEquals(
    fetch.calls[0].url,
    "https://my-vm.exe.xyz:3000/repo.git/info/refs",
  );
  assertEquals(
    fetch.calls[0].headers.get("x-exedev-authorization"),
    `Bearer ${fixture.VM_TOKEN}`,
  );
  assertEquals(fetch.calls[0].headers.get("accept"), "*/*");
  try {
    await client.fetch("relative");
    throw new Error("accepted");
  } catch (error) {
    assert(error instanceof ExeError, String(error));
  }
});

Deno.test("VM tokens can be minted on the fly for a VM endpoint", async () => {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const fetch = fakeFetch(() => new Response("ok"));
  const client = new VmEndpointClient({
    vm: "fixture-vm",
    token: mintingTokenSource({
      signer,
      vm: "fixture-vm",
      ctx: { user: "alice" },
    }),
    fetch,
  });
  await client.fetch("/");
  const token = fetch.calls[0].headers.get("x-exedev-authorization")!.slice(
    "Bearer ".length,
  );
  const verified = await verifyExe0(token, {
    vm: "fixture-vm",
    keys: [fixture.PUBLIC_KEY],
  });
  assert(
    verified.ok &&
      JSON.stringify(verified.permissions.ctx) === '{"user":"alice"}',
    JSON.stringify(verified),
  );
  assertEquals(
    await mintExe0({
      signer,
      vm: "fixture-vm",
      permissions: fixture.VM_PERMISSIONS,
    }),
    fixture.VM_TOKEN,
  );
});

Deno.test("vmOrigin allows 443 and the forwarded 3000-9999 range", () => {
  assertEquals(vmOrigin("my-vm"), "https://my-vm.exe.xyz");
  assertEquals(vmOrigin("my-vm", 443), "https://my-vm.exe.xyz");
  assertEquals(vmOrigin("my-vm", 9999), "https://my-vm.exe.xyz:9999");
  for (
    const [vm, port] of [["my-vm", 8], ["my-vm", 10000], [
      "My_VM",
      undefined,
    ]] as const
  ) {
    try {
      vmOrigin(vm, port);
      throw new Error("accepted");
    } catch (error) {
      assert(error instanceof ExeError, String(error));
    }
  }
});

Deno.test("basic auth carries the token as the password", () => {
  assertEquals(basicAuthorization("exe1.x"), `Basic ${btoa("exe:exe1.x")}`);
  assertEquals(
    basicAuthorization("exe1.x", "git"),
    `Basic ${btoa("git:exe1.x")}`,
  );
});

Deno.test("suggest, new-VM and integration links", () => {
  assertEquals(
    suggestLink(["share", "set-public", "mybox"]),
    "https://exe.dev/suggest?command=share+set-public+mybox",
  );
  assertEquals(
    suggestLink("resize mybox --memory=4G", { preflight: true }),
    "https://exe.dev/suggest?command=resize+mybox+--memory%3D4G&preflight=1",
  );
  assertEquals(
    suggestLink(["comment", "mybox", "two words"]),
    "https://exe.dev/suggest?command=comment+mybox+%27two+words%27",
  );
  assertEquals(
    newVmLink({ repo: "https://github.com/O/R", tags: ["a", "b"] }),
    "https://exe.dev/new?repo=https%3A%2F%2Fgithub.com%2FO%2FR&tags=a%2Cb",
  );
  assertEquals(newVmLink({}), "https://exe.dev/new");
  assertEquals(
    integrationAddLink("stripe", {
      attach: "vm:dev1",
      for: "2h",
      source: "shelley",
    }),
    "https://exe.dev/integrations/add?service=stripe&attach=vm%3Adev1&for=2h&source=shelley",
  );
});
