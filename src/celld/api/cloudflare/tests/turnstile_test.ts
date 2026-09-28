// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import { CloudflareClient, CloudflareError } from "@celld/api/cloudflare";
import { FakeCloudflare } from "@celld/api/cloudflare/testing";
import {
  TEST_KEYS,
  TurnstileWidgets,
  verifyTurnstile,
} from "@celld/api/cloudflare/turnstile";
import type { Runtime } from "@celld/http";

const instant: Runtime = {
  now: () => Date.now(),
  random: () => 0,
  sleep: () => Promise.resolve(),
  setTimer: () => () => {},
};

function setup(now?: () => number) {
  const fake = new FakeCloudflare({ now });
  const widget = fake.turnstile.addWidget({
    name: "signup",
    domains: ["example.com"],
  });
  const secret = fake.turnstile.widget(widget.sitekey)!.secret;
  const verify = (token: string | null, extra: object = {}) =>
    verifyTurnstile({ secret, token, fetch: fake.fetch, ...extra });
  return { fake, widget, secret, verify };
}

Deno.test("a token from the widget verifies once, then is spent", async () => {
  const { fake, widget, verify } = setup();
  const token = fake.turnstile.issueToken(widget.sitekey, {
    hostname: "example.com",
    action: "signup",
    cdata: "session-1",
  });
  const first = await verify(token, {
    expectedHostname: "example.com",
    expectedAction: "signup",
  });
  assert(first.success, JSON.stringify(first.errorCodes));
  assertEquals(first.hostname, "example.com");
  assertEquals(first.cdata, "session-1");
  const again = await verify(token);
  assertEquals(again.success, false);
  assertEquals(again.errorCodes, ["timeout-or-duplicate"]);
  const call = fake.calls.find((call) =>
    call.path === "/turnstile/v0/siteverify"
  )!;
  assertEquals(call.host, "challenges.cloudflare.com");
  assert(
    typeof (call.body as { idempotency_key?: unknown }).idempotency_key ===
      "string",
    "an idempotency key goes with every check",
  );
});

Deno.test("siteverify's refusals are verdicts, not errors", async () => {
  const { fake, widget, verify } = setup();
  const other = fake.turnstile.addWidget({
    name: "other",
    domains: ["x.test"],
  });
  const foreign = fake.turnstile.issueToken(other.sitekey, {
    hostname: "x.test",
  });
  assertEquals((await verify(foreign)).errorCodes, ["invalid-input-response"]);
  assertEquals((await verify("made-up")).errorCodes, [
    "invalid-input-response",
  ]);
  const token = fake.turnstile.issueToken(widget.sitekey, {
    hostname: "example.com",
  });
  assertEquals(
    (await verifyTurnstile({ secret: "0xwrong", token, fetch: fake.fetch }))
      .errorCodes,
    ["invalid-input-secret"],
  );
});

Deno.test("empty and oversized tokens fail without asking siteverify", async () => {
  const { fake, verify } = setup();
  assertEquals((await verify(null)).errorCodes, ["missing-input-response"]);
  assertEquals((await verify("")).errorCodes, ["missing-input-response"]);
  assertEquals(
    (await verify("x".repeat(2049))).errorCodes,
    ["invalid-input-response"],
  );
  assertEquals(
    (await verifyTurnstile({ secret: "", token: "t", fetch: fake.fetch }))
      .errorCodes,
    ["missing-input-secret"],
  );
  assertEquals(fake.calls.length, 0);
});

Deno.test("hostname, action and age are checked after siteverify says yes", async () => {
  let now = Date.parse("2026-09-28T12:00:00Z");
  const { fake, widget, verify: check } = setup(() => now);
  // The verifier reads the same clock as the fake.
  const verify = (token: string, extra: object = {}) =>
    check(token, { runtime: { ...instant, now: () => now }, ...extra });
  const issue = (action?: string) =>
    fake.turnstile.issueToken(widget.sitekey, {
      hostname: "evil.example.net",
      action,
    });
  const host = await verify(issue(), {
    expectedHostname: ["example.com", "www.example.com"],
  });
  assertEquals(host.success, false);
  assertEquals(host.errorCodes, ["hostname-mismatch"]);
  const action = await verify(issue("login"), { expectedAction: "signup" });
  assertEquals(action.errorCodes, ["action-mismatch"]);
  const token = issue();
  now += 60_000;
  const old = await verify(token, { maxAgeMs: 30_000 });
  assertEquals(old.errorCodes, ["challenge-too-old"]);
});

Deno.test("a lost answer is asked again with the same key, and gets the first verdict", async () => {
  const { fake, widget, verify } = setup();
  const token = fake.turnstile.issueToken(widget.sitekey, {
    hostname: "example.com",
  });
  fake.failNext({
    path: "/turnstile/v0/siteverify",
    status: 502,
    html: true,
    afterApplying: true,
  });
  const verdict = await verify(token, { runtime: instant });
  assert(verdict.success, JSON.stringify(verdict.errorCodes));
  const keys = fake.calls.map((call) =>
    (call.body as { idempotency_key: string }).idempotency_key
  );
  assertEquals(keys.length, 2);
  assertEquals(keys[0], keys[1]);
});

Deno.test("when siteverify cannot be reached the caller hears it", async () => {
  const error = await assertRejects(
    () =>
      verifyTurnstile({
        secret: "s",
        token: "t",
        fetch: () => Promise.reject(new TypeError("connection refused")),
        runtime: instant,
      }),
    CloudflareError,
  );
  assertEquals(error.kind, "network");
  await assertRejects(
    () =>
      verifyTurnstile({
        secret: "s",
        token: "t",
        siteverifyUrl: "http://example.com/verify",
      }),
    TypeError,
    "https",
  );
});

Deno.test("the documented test secrets behave as documented", async () => {
  const fake = new FakeCloudflare();
  const check = (secret: string, token: string = TEST_KEYS.dummyToken) =>
    verifyTurnstile({ secret, token, fetch: fake.fetch });
  assert((await check(TEST_KEYS.secrets.alwaysPasses)).success, "passes");
  assertEquals(
    (await check(TEST_KEYS.secrets.alwaysFails)).errorCodes,
    ["invalid-input-response"],
  );
  assertEquals(
    (await check(TEST_KEYS.secrets.alreadySpent)).errorCodes,
    ["timeout-or-duplicate"],
  );
  assertEquals(
    (await check(TEST_KEYS.secrets.alwaysPasses, "real-looking")).success,
    false,
  );
});

Deno.test("widgets: create, list without secrets, update, rotate, delete", async () => {
  const fake = new FakeCloudflare();
  const cf = new CloudflareClient({ fetch: fake.fetch });
  const widgets = new TurnstileWidgets(cf, fake.accountId);
  const made = await widgets.create({
    name: "login",
    domains: ["example.com"],
    mode: "managed",
  });
  assert(typeof made.secret === "string", "the secret comes back once");
  const listed = await widgets.list();
  assertEquals(listed.map((widget) => widget.sitekey), [made.sitekey]);
  assertEquals(listed[0].secret, undefined);
  assertEquals(
    (await widgets.update(made.sitekey, {
      name: "login",
      domains: ["example.com", "example.org"],
      mode: "invisible",
    })).mode,
    "invisible",
  );
  const token = fake.turnstile.issueToken(made.sitekey, {
    hostname: "example.com",
  });
  const rotated = await widgets.rotateSecret(made.sitekey);
  assert(rotated.secret !== made.secret, "a new secret");
  const old = await verifyTurnstile({
    secret: made.secret!,
    token,
    fetch: fake.fetch,
  });
  assert(old.success, "the old secret keeps working until it expires");
  await widgets.delete(made.sitekey);
  assertEquals(await widgets.list(), []);
  await assertRejects(() => widgets.get("../x"), TypeError, "sitekey");
  await assertRejects(
    () => widgets.create({ name: "x", domains: [], mode: "managed" }),
    TypeError,
    "domains",
  );
});
