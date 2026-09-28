// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@celld/core/assert";
import { CloudflareClient, CloudflareError } from "@celld/api/cloudflare";
import { FakeCloudflare } from "@celld/api/cloudflare/testing";
import {
  DnsRecords,
  recordBody,
  Zones,
  ZoneSettings,
} from "@celld/api/cloudflare/zones";

function setup() {
  const fake = new FakeCloudflare({ token: "tok" });
  const zone = fake.addZone("example.com");
  const cf = new CloudflareClient({ token: "tok", fetch: fake.fetch });
  return { fake, zone, cf, dns: new DnsRecords(cf, zone.id) };
}

Deno.test("zones: list, find by name, create, edit, delete", async () => {
  const { fake, cf, zone } = setup();
  fake.addZone("example.org");
  const zones = new Zones(cf);
  assertEquals((await zones.list()).map((z) => z.name), [
    "example.com",
    "example.org",
  ]);
  assertEquals((await zones.byName("example.org")).name, "example.org");
  const missing = await assertRejects(
    () => zones.byName("example.net"),
    CloudflareError,
  );
  assertEquals(missing.status, 404);
  const made = await zones.create({
    name: "example.net",
    account: { id: fake.accountId },
  });
  assertEquals(made.status, "pending");
  assertEquals((await zones.edit(zone.id, { paused: true })).paused, true);
  await zones.delete(made.id);
  assertEquals(fake.zone(made.id), undefined);
  await assertRejects(
    () => zones.edit(zone.id, { paused: true, type: "full" } as never),
    TypeError,
    "one field",
  );
  await assertRejects(
    () =>
      zones.create({ name: "not a domain", account: { id: fake.accountId } }),
    TypeError,
    "domain",
  );
  await assertRejects(() => zones.get("example.com"), TypeError, "zoneId");
});

Deno.test("zones: the fake refuses a wrong or missing token as Cloudflare does", async () => {
  const { fake } = setup();
  const wrong = await assertRejects(
    () =>
      new Zones(new CloudflareClient({ token: "other", fetch: fake.fetch }))
        .list(),
    CloudflareError,
  );
  assertEquals(wrong.status, 401);
  assert(wrong.hasCode(10000), "authentication error");
  const missing = await assertRejects(
    () => new Zones(new CloudflareClient({ fetch: fake.fetch })).list(),
    CloudflareError,
  );
  assertEquals(missing.status, 403);
  assert(missing.hasCode(9106), "no credentials");
});

Deno.test("settings: read and change, with values Cloudflare refuses refused", async () => {
  const { fake, cf, zone } = setup();
  const settings = new ZoneSettings(cf, zone.id);
  assertEquals((await settings.get("ssl")).value, "flexible");
  assertEquals((await settings.set("ssl", "strict")).value, "strict");
  assertEquals(fake.setting(zone.id, "ssl"), "strict");
  const bad = await assertRejects(
    () => settings.set("ssl", "maximum"),
    CloudflareError,
  );
  assert(bad.hasCode(1007), "invalid value");
  await assertRejects(() => settings.get("../ssl"), TypeError, "settingId");
});

Deno.test("dns: create, find, edit, overwrite, delete", async () => {
  const { fake, dns, zone } = setup();
  const www = await dns.create({
    type: "A",
    name: "www",
    content: "192.0.2.1",
    proxied: true,
    tags: ["team:web"],
  });
  assertEquals(www.name, "www.example.com");
  assertEquals(www.ttl, 1);
  await dns.create({ type: "TXT", name: "@", content: "v=spf1 -all" });
  await dns.create({
    type: "MX",
    name: "example.com",
    content: "mx.example.com",
    priority: 10,
  });
  assertEquals((await dns.find("www.example.com", "A")).length, 1);
  assertEquals(
    (await dns.list({ type: "TXT" })).map((record) => record.content),
    ["v=spf1 -all"],
  );
  assertEquals((await dns.list({ tag: "team" })).length, 1);
  assertEquals(
    (await dns.list({ name: { endswith: "example.com" } })).length,
    3,
  );
  const edited = await dns.edit(www.id, { content: "192.0.2.2" });
  assertEquals(edited.content, "192.0.2.2");
  assertEquals(edited.proxied, true);
  const replaced = await dns.overwrite(www.id, {
    type: "A",
    name: "www",
    content: "192.0.2.3",
  });
  assertEquals(replaced.proxied, false);
  await dns.delete(www.id);
  assertEquals(fake.records(zone.id).length, 2);
  const gone = await assertRejects(() => dns.get(www.id), CloudflareError);
  assert(gone.hasCode(81044), "record does not exist");
});

Deno.test("dns: Cloudflare's refusals come back as api errors with their codes", async () => {
  const { dns } = setup();
  await dns.create({ type: "A", name: "www", content: "192.0.2.1" });
  const identical = await assertRejects(
    () => dns.create({ type: "A", name: "www", content: "192.0.2.1" }),
    CloudflareError,
  );
  assert(identical.hasCode(81058), "identical record");
  const cname = await assertRejects(
    () => dns.create({ type: "CNAME", name: "www", content: "example.net" }),
    CloudflareError,
  );
  assert(cname.hasCode(81053), "CNAME conflict");
});

Deno.test("dns: record bodies are checked before sending", () => {
  assertThrows(
    () => recordBody({ type: "A", name: "www", content: "not-an-ip" }),
    TypeError,
    "IPv4",
  );
  assertThrows(
    () => recordBody({ type: "AAAA", name: "www", content: "192.0.2.1" }),
    TypeError,
    "IPv6",
  );
  assertThrows(
    () => recordBody({ type: "TXT", name: "t", content: "x", proxied: true }),
    TypeError,
    "cannot be proxied",
  );
  assertThrows(
    () => recordBody({ type: "A", name: "www", content: "192.0.2.1", ttl: 5 }),
    RangeError,
    "ttl",
  );
  assertThrows(
    () => recordBody({ type: "MX", name: "@", content: "mx.example.com" }),
    TypeError,
    "priority",
  );
  assertThrows(
    () => recordBody({ type: "SRV", name: "_sip._tcp" }),
    TypeError,
    "data",
  );
  assertThrows(
    () =>
      recordBody({
        type: "SRV",
        name: "_sip._tcp",
        data: { service: "_sip", port: 5060 },
      }),
    TypeError,
    "not its data",
  );
  assertThrows(
    () =>
      recordBody({
        type: "CNAME",
        name: "www.example.com",
        content: "www.example.com.",
      }),
    TypeError,
    "its own name",
  );
  assertThrows(
    () => recordBody({ type: "TXT", name: "t", content: "x", comment: "a\nb" }),
    TypeError,
    "one line",
  );
  assertThrows(
    () =>
      recordBody({
        type: "TXT",
        name: "t",
        content: "x",
        tags: ["bad name:x"],
      }),
    TypeError,
    "tags",
  );
  assertThrows(
    () =>
      recordBody({
        type: "TXT",
        name: "t",
        content: "x",
        tags: Array.from({ length: 21 }, (_, i) => `t${i}:x`),
      }),
    TypeError,
    "at most 20",
  );
  assertEquals(
    recordBody({
      type: "SRV",
      name: "_sip._tcp",
      data: { priority: 1, weight: 5, port: 5060, target: "sip.example.com" },
    }).data,
    { priority: 1, weight: 5, port: 5060, target: "sip.example.com" },
  );
});

Deno.test("dns: upsert creates, then overwrites, and refuses to guess among several", async () => {
  const { dns } = setup();
  const first = await dns.upsert({
    type: "TXT",
    name: "_verify",
    content: "one",
  });
  assert(first.created, "created");
  const second = await dns.upsert({
    type: "TXT",
    name: "_verify.example.com",
    content: "two",
  });
  assertEquals(second.created, false);
  assertEquals(second.record.id, first.record.id);
  assertEquals(second.record.content, "two");
  await dns.create({ type: "TXT", name: "_verify", content: "three" });
  await assertRejects(
    () =>
      dns.upsert({ type: "TXT", name: "_verify.example.com", content: "x" }),
    RangeError,
    "2 TXT records",
  );
});

Deno.test("dns: a batch applies whole or not at all", async () => {
  const { fake, dns, zone } = setup();
  const a = await dns.create({ type: "A", name: "a", content: "192.0.2.1" });
  const b = await dns.create({ type: "A", name: "b", content: "192.0.2.2" });
  const result = await dns.batch({
    deletes: [{ id: a.id }],
    patches: [{ id: b.id, content: "192.0.2.20" }],
    posts: [{ type: "A", name: "c", content: "192.0.2.3" }],
  });
  assertEquals(result.deletes?.map((record) => record.id), [a.id]);
  assertEquals(result.patches?.[0].content, "192.0.2.20");
  assertEquals(result.posts?.[0].name, "c.example.com");
  const before = fake.records(zone.id).map((record) => record.id);
  await assertRejects(
    () =>
      dns.batch({
        deletes: [{ id: b.id }],
        posts: [{ type: "CNAME", name: "c", content: "example.net" }],
      }),
    CloudflareError,
  );
  assertEquals(fake.records(zone.id).map((record) => record.id), before);
  assertEquals(await dns.batch({}), {});
});

Deno.test("dns: list walks every page", async () => {
  const { fake, dns, zone } = setup();
  for (let i = 0; i < 7; i++) {
    await dns.create({ type: "TXT", name: `t${i}`, content: `value ${i}` });
  }
  assertEquals((await dns.list({}, { perPage: 3 })).length, 7);
  const pages = fake.calls.filter((call) =>
    call.method === "GET" && call.path === `/zones/${zone.id}/dns_records`
  );
  assertEquals(pages.map((call) => call.query.get("page")), ["1", "2", "3"]);
});

Deno.test("dns: export is the zone file as text", async () => {
  const { dns } = setup();
  await dns.create({ type: "A", name: "www", content: "192.0.2.1", ttl: 300 });
  const text = await dns.export();
  assert(text.includes("www.example.com.\t300\tIN\tA\t192.0.2.1"), text);
});
