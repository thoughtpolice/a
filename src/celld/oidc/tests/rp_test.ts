// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "@celld/assert";
import { CookieSealer, LoginFlow, OidcClient } from "@celld/oidc/rp";
import { testBrowser, testProvider } from "@celld/oidc/testing";
import { routeFetch } from "@celld/oauth/testing";
import { clock, rejects } from "./fixture.ts";

const OP = "https://op.test";
const APP = "https://app.test";

async function setup() {
  const time = clock();
  const op = await testProvider({
    issuer: OP,
    now: time.now,
    clients: [{ client_id: "app", redirect_uris: [`${APP}/callback`] }],
  });
  const sealer = await CookieSealer.create({
    secret: "an-app-cookie-secret-0123456789abcd",
    now: time.now,
  });
  const fetch = routeFetch({
    [OP]: op.handle,
    [APP]: (request) => app(request),
  });
  const flow = new LoginFlow({
    client: new OidcClient({
      issuer: OP,
      client: { method: "none", clientId: "app" },
      redirectUri: `${APP}/callback`,
      fetch,
      now: time.now,
    }),
    sealer,
  });
  const app = async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === "/login") {
      return await flow.start({
        scope: ["email"],
        returnTo: url.searchParams.get("next") ?? "/",
      });
    }
    if (url.pathname === "/callback") {
      const done = await flow.finish(request);
      return Response.json(
        { subject: done.login.subject, returnTo: done.returnTo },
        { headers: { "set-cookie": done.clearCookie } },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { time, fetch, flow, browser: testBrowser(fetch) };
}

Deno.test("LoginFlow: the pending login rides in a sealed cookie and comes back once", async () => {
  const { browser } = await setup();
  const start = await browser.request(`${APP}/login?next=/account`);
  assertEquals(start.status, 303);
  const cookie = start.headers.get("set-cookie")!;
  assert(cookie.startsWith("__Host-oidc-login=v1."), cookie);
  assert(
    cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax"),
    cookie,
  );
  assert(!cookie.includes("code_verifier"), "the verifier is sealed");
  const callback = await browser.navigate(
    start.headers.get("location")!,
    `${APP}/callback`,
  );
  const finished = await browser.request(callback);
  assertEquals(await finished.json(), {
    subject: "user-1",
    returnTo: "/account",
  });
  assertEquals(browser.cookies.get(APP)?.has("__Host-oidc-login"), false);
});

Deno.test("LoginFlow: a callback without this browser's cookie is refused", async () => {
  const { browser, flow, fetch } = await setup();
  const start = await browser.request(`${APP}/login`);
  const callback = await browser.navigate(
    start.headers.get("location")!,
    `${APP}/callback`,
  );
  await rejects(() => flow.finish(new Request(callback)), {
    kind: "state_mismatch",
  });
  const other = testBrowser(fetch);
  await other.request(`${APP}/login`);
  const stolen = new Request(callback, {
    headers: {
      cookie: `__Host-oidc-login=${
        other.cookies.get(APP)!.get("__Host-oidc-login")
      }`,
    },
  });
  await rejects(() => flow.finish(stolen), { kind: "state_mismatch" });
});

Deno.test("LoginFlow: the pending login expires", async () => {
  const { browser, time } = await setup();
  const start = await browser.request(`${APP}/login`);
  const callback = await browser.navigate(
    start.headers.get("location")!,
    `${APP}/callback`,
  );
  time.advance(601_000);
  await rejects(() => browser.request(callback), { kind: "state_mismatch" });
});

Deno.test("LoginFlow: returnTo must be local", async () => {
  const { flow } = await setup();
  await rejects(() => flow.start({ returnTo: "//evil.test/" }), {
    name: "TypeError",
  });
  await rejects(() => flow.start({ returnTo: "https://evil.test/" }), {
    name: "TypeError",
  });
});
