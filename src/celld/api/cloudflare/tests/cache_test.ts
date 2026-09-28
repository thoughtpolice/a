// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import { CloudflareClient, CloudflareError } from "@celld/api/cloudflare";
import { Cache } from "@celld/api/cloudflare/cache";
import { FakeCloudflare } from "@celld/api/cloudflare/testing";
import type { Runtime } from "@celld/http";

const instant: Runtime = {
  now: () => 0,
  random: () => 0,
  sleep: () => Promise.resolve(),
  setTimer: () => () => {},
};

function setup(options?: { purgeBatchSize?: number }) {
  const fake = new FakeCloudflare();
  const zone = fake.addZone("example.com");
  const cf = new CloudflareClient({ fetch: fake.fetch, runtime: instant });
  return { fake, zone, cache: new Cache(cf, zone.id, options) };
}

Deno.test("purge: one kind per request, long lists split to the batch size", async () => {
  const { fake, cache } = setup();
  const urls = Array.from(
    { length: 230 },
    (_, i) => `https://example.com/asset-${i}.js`,
  );
  const ids = await cache.purge({ files: urls });
  assertEquals(ids.length, 3);
  assertEquals(
    fake.cache.purges.map((purge) => (purge.body.files as unknown[]).length),
    [100, 100, 30],
  );
  await cache.purge({ everything: true });
  await cache.purge({ tags: ["product-42", "home"] });
  await cache.purge({ hosts: ["Static.Example.com"] });
  await cache.purge({ prefixes: ["example.com/assets/"] });
  await cache.purge({
    files: [{
      url: "https://example.com/",
      headers: { "CF-Device-Type": "mobile" },
    }],
  });
  assertEquals(fake.cache.purges.slice(3).map((purge) => purge.body), [
    { purge_everything: true },
    { tags: ["product-42", "home"] },
    { hosts: ["static.example.com"] },
    { prefixes: ["example.com/assets/"] },
    {
      files: [{
        url: "https://example.com/",
        headers: { "CF-Device-Type": "mobile" },
      }],
    },
  ]);
});

Deno.test("purge: what Cloudflare would refuse is refused before sending", async () => {
  const { fake, cache } = setup();
  const refusals: [unknown, string][] = [
    [{ files: [] }, "non-empty"],
    [{ files: ["/relative"] }, "absolute URL"],
    [{ files: ["ftp://example.com/x"] }, "http(s)"],
    [{ tags: ["has space"] }, "without spaces"],
    [{ hosts: ["https://example.com"] }, "hostname"],
    [{ prefixes: ["https://example.com/a"] }, "without a scheme"],
    [{ prefixes: ["example.com/a?x=1"] }, "query"],
    [{ files: ["https://a.example/"], tags: ["x"] }, "one kind"],
    [{ everything: false }, "must be true"],
  ];
  for (const [request, message] of refusals) {
    await assertRejects(
      () => cache.purge(request as never),
      TypeError,
      message,
    );
  }
  assertEquals(fake.cache.purges, []);
});

Deno.test("purge: a failed purge is retried, since purging twice changes nothing", async () => {
  const { fake, cache } = setup();
  fake.failNext({ path: /purge_cache$/, status: 502, html: true });
  assertEquals((await cache.purge({ tags: ["a"] })).length, 1);
  assertEquals(fake.cache.purges.length, 1);
});

Deno.test("purge: a larger batch size is used when set, and the zone's limit still applies", async () => {
  const { fake, cache } = setup({ purgeBatchSize: 500 });
  const tags = Array.from({ length: 150 }, (_, i) => `t${i}`);
  const error = await assertRejects(
    () => cache.purge({ tags }),
    CloudflareError,
  );
  assert(error.hasCode(1134), "over the zone's limit");
  fake.cache.purgeLimit = 500;
  assertEquals((await cache.purge({ tags })).length, 1);
  assertThrows(
    () =>
      new Cache(new CloudflareClient(), fake.addZone("x.test").id, {
        purgeBatchSize: 0,
      }),
    RangeError,
  );
});

Deno.test("settings: the cache ones by name", async () => {
  const { fake, zone, cache } = setup();
  assertEquals((await cache.setting("cache_level")).value, "aggressive");
  await cache.set("cache_level", "simplified");
  await cache.set("browser_cache_ttl", 3600);
  await cache.set("development_mode", "on");
  assertEquals(fake.setting(zone.id, "cache_level"), "simplified");
  assertEquals(fake.setting(zone.id, "browser_cache_ttl"), 3600);
  await assertRejects(
    () => cache.set("browser_cache_ttl", -1),
    RangeError,
  );
  await assertRejects(
    () => cache.set("browser_cache_ttl", 31_536_001),
    RangeError,
  );
  const bad = await assertRejects(
    () => cache.set("edge_cache_ttl", 45),
    CloudflareError,
  );
  assert(bad.hasCode(1007), "not one of the allowed TTLs");
});

Deno.test("cache rules: none before the entrypoint exists, then replaced whole", async () => {
  const { fake, zone, cache } = setup();
  assertEquals(await cache.rules(), []);
  const set = await cache.setRules([
    {
      description: "cache API GETs for a minute",
      expression:
        'http.host eq "api.example.com" and http.request.method eq "GET"',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: "override_origin", default: 60 },
      },
    },
    {
      expression: 'starts_with(http.request.uri.path, "/admin")',
      action_parameters: { cache: false },
      enabled: false,
    },
  ]);
  assertEquals(set.rules.length, 2);
  const rules = await cache.rules();
  assertEquals(rules.map((rule) => rule.action), [
    "set_cache_settings",
    "set_cache_settings",
  ]);
  assertEquals(rules[1].enabled, false);
  assertEquals(fake.cache.rules(zone.id)?.length, 2);
  await cache.setRules([]);
  assertEquals(await cache.rules(), []);
  await assertRejects(
    () =>
      cache.setRules([{ expression: " ", action_parameters: { cache: true } }]),
    TypeError,
    "expression",
  );
});

Deno.test("cache rules: one added and one removed, the others left alone", async () => {
  const { fake, zone, cache } = setup();
  const first = await cache.addRule({
    expression: 'http.host eq "a.example.com"',
    action_parameters: { cache: true },
  });
  assertEquals(fake.cache.rules(zone.id)?.length, 1);
  const second = await cache.addRule({
    ref: "static",
    expression: 'http.request.uri.path.extension eq "js"',
    action_parameters: {
      cache: true,
      browser_ttl: { mode: "override_origin", default: 86400 },
    },
  });
  assertEquals((await cache.rules()).map((rule) => rule.id), [
    first.id,
    second.id,
  ]);
  await cache.deleteRule(first.id);
  assertEquals((await cache.rules()).map((rule) => rule.id), [second.id]);
  // Replacing the list keeps a rule whose id is passed.
  await cache.setRules([{ ...second, description: "static assets" }]);
  assertEquals((await cache.rules()).map((rule) => rule.id), [second.id]);
});

Deno.test("tiered cache and cache reserve switch on and off", async () => {
  const { cache } = setup();
  assertEquals(await cache.tieredCaching(), "off");
  assertEquals(await cache.setTieredCaching("on"), "on");
  assertEquals(await cache.tieredCaching(), "on");
  assertEquals(await cache.setSmartTopology("on"), "on");
  assertEquals(await cache.setCacheReserve("on"), "on");
  assertEquals(await cache.cacheReserve(), "on");
  await assertRejects(
    () => cache.setCacheReserve("yes" as "on"),
    TypeError,
    '"on" or "off"',
  );
});
