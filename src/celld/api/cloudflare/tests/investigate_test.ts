// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals, assertRejects } from "@celld/core/assert";
import { CloudflareClient, CloudflareError } from "@celld/api/cloudflare";
import { Intel, UrlScanner } from "@celld/api/cloudflare/investigate";
import { FakeCloudflare } from "@celld/api/cloudflare/testing";
import type { Runtime } from "@celld/http";

function instant(): Runtime & { slept: number[] } {
  const slept: number[] = [];
  let now = 0;
  return {
    slept,
    now: () => now,
    random: () => 0,
    sleep: (ms: number) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    setTimer: () => () => {},
  };
}

function setup() {
  const fake = new FakeCloudflare({ token: "tok" });
  const runtime = instant();
  const cf = new CloudflareClient({ token: "tok", fetch: fake.fetch, runtime });
  return {
    fake,
    runtime,
    intel: new Intel(cf, fake.accountId),
    scanner: new UrlScanner(cf, fake.accountId),
  };
}

Deno.test("intel: domains, addresses, WHOIS and ASNs, each call counted", async () => {
  const { fake, intel } = setup();
  fake.investigate.setDomain({
    domain: "evil.example",
    risk_types: [{ id: 131, name: "Phishing", super_category_id: 21 }],
    popularity_rank: 90000,
  });
  fake.investigate.setAsn({
    asn: 13335,
    description: "CLOUDFLARENET",
    country: "US",
  });
  const evil = await intel.domain("Evil.Example");
  assertEquals(evil.risk_types?.map((risk) => risk.name), ["Phishing"]);
  assertEquals((await intel.domain("example.com")).risk_types, []);
  const bulk = await intel.domains(["evil.example", "example.com"]);
  assertEquals(bulk.map((item) => item.domain), [
    "evil.example",
    "example.com",
  ]);
  assert(!("resolves_to_refs" in bulk[1]), "bulk leaves out resolution refs");
  assertEquals((await intel.ip("1.1.1.1"))[0].ip, "1.1.1.1");
  assertEquals(
    (await intel.ip("2606:4700:4700::1111"))[0].ip,
    "2606:4700:4700::1111",
  );
  assertEquals((await intel.whois("example.com")).found, false);
  assertEquals((await intel.asn(13335)).description, "CLOUDFLARENET");
  assertEquals((await intel.asnSubnets(13335)).subnets, ["192.0.2.0/24"]);
  assertEquals(
    (await intel.url("https://evil.example/login")).full_url,
    "https://evil.example/login",
  );
  assertEquals(fake.investigate.intelCalls, 9);
  const ipCall = fake.calls.find((call) => call.path.endsWith("/intel/ip"));
  assertEquals(ipCall?.query.get("ipv4"), "1.1.1.1");
});

Deno.test("intel: bad input fails before spending quota", async () => {
  const { fake, intel } = setup();
  await assertRejects(() => intel.domain("not a domain"), TypeError);
  await assertRejects(() => intel.ip("1.1.1"), TypeError, "IP address");
  await assertRejects(
    () => intel.passiveDns("2606:4700::1"),
    TypeError,
    "IPv4",
  );
  await assertRejects(
    () => intel.passiveDns("1.1.1.1", { start: "yesterday" }),
    TypeError,
    "YYYY-MM-DD",
  );
  await assertRejects(() => intel.asn(0), RangeError);
  await assertRejects(() => intel.domains([]), RangeError);
  await assertRejects(() => intel.url("javascript:alert(1)"), TypeError);
  assertEquals(fake.investigate.intelCalls, 0);
});

Deno.test("intel: passive DNS carries its paging in the answer", async () => {
  const { fake, intel } = setup();
  fake.investigate.setPassiveDns("192.0.2.10", {
    reverse_records: [{
      hostname: "shop.example",
      first_seen: "2026-01-01",
      last_seen: "2026-09-01",
    }],
    count: 1,
    page: 1,
    per_page: 20,
  });
  const seen = await intel.passiveDns("192.0.2.10", {
    start: "2026-01-01",
    end: "2026-09-28",
  });
  assertEquals(seen.reverse_records?.map((record) => record.hostname), [
    "shop.example",
  ]);
  const call = fake.calls.find((call) => call.path.endsWith("/intel/dns"));
  assertEquals(call?.query.get("start"), "2026-01-01");
});

Deno.test("url scanner: submit unlisted, poll while it runs, read the verdict", async () => {
  const { fake, runtime, scanner } = setup();
  fake.investigate.scanPolls = 2;
  fake.investigate.maliciousUrls.add("https://evil.example/login");
  const submitted = await scanner.submit({ url: "https://evil.example/login" });
  assertEquals(submitted.visibility, "unlisted");
  assertEquals(await scanner.result(submitted.uuid), null);
  const result = await scanner.wait(submitted.uuid, { intervalMs: 10_000 });
  assertEquals(result.task.uuid, submitted.uuid);
  assertEquals(result.verdicts?.overall?.malicious, true);
  assertEquals(runtime.slept, [10_000]);
  const hits = await scanner.search('page.domain:"evil.example"');
  assertEquals(hits.map((hit) => hit.task?.uuid), [submitted.uuid]);
  const png = await scanner.screenshot(submitted.uuid);
  assertEquals([...png.subarray(1, 4)], [80, 78, 71]);
  assert(
    (await scanner.dom(submitted.uuid)).startsWith("<html>"),
    "the DOM as text",
  );
  assertEquals(
    ((await scanner.har(submitted.uuid)) as { log: { version: string } }).log
      .version,
    "1.2",
  );
});

Deno.test("url scanner: an unknown scan is an error, not a scan that never ends", async () => {
  const { scanner } = setup();
  const error = await assertRejects(
    () => scanner.result("5ca40000-0000-4000-8000-00000000ffff"),
    CloudflareError,
    "Scan not found",
  );
  assertEquals(error.status, 404);
  assertEquals(error.kind, "api");
});

Deno.test("url scanner: waiting gives up at its deadline", async () => {
  const { fake, scanner } = setup();
  fake.investigate.scanPolls = 100;
  const submitted = await scanner.submit({
    url: "https://slow.example/",
    visibility: "Public",
  });
  assertEquals(submitted.visibility, "public");
  const error = await assertRejects(
    () =>
      scanner.wait(submitted.uuid, { intervalMs: 10_000, deadlineMs: 35_000 }),
    CloudflareError,
  );
  assertEquals(error.kind, "timeout");
});

Deno.test("url scanner: bulk submissions and refused input", async () => {
  const { fake, scanner } = setup();
  const made = await scanner.submitMany([
    { url: "https://a.example/" },
    { url: "https://b.example/" },
  ]);
  assertEquals(made.length, 2);
  assertEquals(fake.investigate.scans().map((scan) => scan.visibility), [
    "unlisted",
    "unlisted",
  ]);
  await assertRejects(
    () => scanner.submit({ url: "file:///etc/passwd" }),
    TypeError,
    "http or https",
  );
  await assertRejects(
    () => scanner.submit({ url: "https://a.example/", country: "usa" }),
    TypeError,
    "country",
  );
  await assertRejects(() => scanner.submitMany([]), RangeError);
});
