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
  checkIngress,
  Tunnels,
  tunnelTarget,
} from "@celld/api/cloudflare/tunnels";
import { DnsRecords } from "@celld/api/cloudflare/zones";

function setup() {
  const fake = new FakeCloudflare();
  const zone = fake.addZone("example.com");
  const cf = new CloudflareClient({ fetch: fake.fetch });
  return { fake, zone, tunnels: new Tunnels(cf, fake.accountId) };
}

Deno.test("tunnels: create, find, token, delete", async () => {
  const { fake, tunnels } = setup();
  const tunnel = await tunnels.create({ name: "web" });
  assertEquals(tunnel.status, "inactive");
  assertEquals(tunnel.remote_config, true);
  assertEquals((await tunnels.byName("web"))?.id, tunnel.id);
  assertEquals(await tunnels.byName("nope"), null);
  const token = JSON.parse(atob(await tunnels.token(tunnel.id)));
  assertEquals(token.t, tunnel.id);
  assertEquals(token.a, fake.accountId);
  const duplicate = await assertRejects(
    () => tunnels.create({ name: "web" }),
    CloudflareError,
  );
  assertEquals(duplicate.status, 409);
  await tunnels.delete(tunnel.id);
  assertEquals(await tunnels.list(), []);
  assertEquals((await tunnels.list({ includeDeleted: true })).length, 1);
  await assertRejects(() => tunnels.get("web"), TypeError, "tunnelId");
  await assertRejects(
    () => tunnels.create({ name: "x", tunnel_secret: btoa("short") }),
    TypeError,
    "32 random bytes",
  );
});

Deno.test("tunnels: a connected tunnel is not deleted until its connections are cleaned up", async () => {
  const { fake, tunnels } = setup();
  const tunnel = await tunnels.create({ name: "api" });
  const client = fake.tunnels.connect(tunnel.id);
  assertEquals((await tunnels.get(tunnel.id)).status, "healthy");
  const connectors = await tunnels.connections(tunnel.id);
  assertEquals(connectors.map((connector) => connector.id), [client]);
  const refused = await assertRejects(
    () => tunnels.delete(tunnel.id),
    CloudflareError,
  );
  assert(refused.hasCode(1022), "active connections");
  await tunnels.cleanupConnections(tunnel.id, { clientId: client });
  await tunnels.delete(tunnel.id);
});

Deno.test("ingress: the last rule catches everything, and nothing else does", () => {
  checkIngress([
    { hostname: "app.example.com", service: "http://localhost:8080" },
    { hostname: "*.example.com", path: "^/api/", service: "https://10.0.0.2" },
    { service: "http_status:404" },
  ]);
  checkIngress([{ service: "hello_world" }]);
  assertThrows(() => checkIngress([]), TypeError, "catch-all");
  assertThrows(
    () =>
      checkIngress([
        { hostname: "app.example.com", service: "http://localhost:8080" },
      ]),
    TypeError,
    "last ingress rule",
  );
  assertThrows(
    () =>
      checkIngress([
        { service: "http_status:404" },
        { hostname: "app.example.com", service: "http://localhost:8080" },
        { service: "http_status:404" },
      ]),
    TypeError,
    "never run",
  );
  assertThrows(
    () =>
      checkIngress([
        { hostname: "app.example.com", service: "ftp://files" },
        { service: "http_status:404" },
      ]),
    TypeError,
    "service",
  );
  assertThrows(
    () =>
      checkIngress([
        { hostname: "app.example.com", path: "([", service: "hello_world" },
        { service: "http_status:404" },
      ]),
    TypeError,
    "regular expression",
  );
});

Deno.test("configure: checked before sending; a local tunnel's config is not Cloudflare's", async () => {
  const { fake, tunnels } = setup();
  const remote = await tunnels.create({ name: "remote" });
  await assertRejects(
    () =>
      tunnels.configure(remote.id, {
        ingress: [{ hostname: "a.example.com", service: "http://localhost:1" }],
      }),
    TypeError,
    "last ingress rule",
  );
  await assertRejects(
    () =>
      tunnels.configure(remote.id, { ingress: [{ service: "hello_world" }] }),
    TypeError,
    "locally managed",
  );
  const configured = await tunnels.configure(remote.id, {
    ingress: [{ service: "http_status:404" }],
  });
  assertEquals(configured.version, 1);
  assertEquals(fake.tunnels.configuration(remote.id)?.config?.ingress, [
    { service: "http_status:404" },
  ]);
  // What comes back can go straight back in, read-only fields and all.
  const readBack = {
    ...configured.config!,
    "warp-routing": { enabled: false },
  };
  await tunnels.configure(remote.id, readBack);
  assertEquals(
    "warp-routing" in (fake.tunnels.configuration(remote.id)?.config ?? {}),
    false,
  );
  const local = await tunnels.create({ name: "local", config_src: "local" });
  const refused = await assertRejects(
    () =>
      tunnels.configure(local.id, {
        ingress: [{ service: "http_status:404" }],
      }),
    CloudflareError,
  );
  assert(refused.hasCode(1056), "locally managed");
});

Deno.test("publish: rule ahead of the catch-all, and a proxied CNAME to the tunnel", async () => {
  const { fake, zone, tunnels } = setup();
  const tunnel = await tunnels.create({ name: "web" });
  const first = await tunnels.publish(tunnel.id, {
    hostname: "app.example.com",
    service: "http://localhost:8080",
    zoneId: zone.id,
  });
  assertEquals(first.configuration.config?.ingress, [
    { hostname: "app.example.com", service: "http://localhost:8080" },
    { service: "http_status:404" },
  ]);
  assertEquals(first.record.content, tunnelTarget(tunnel.id));
  assertEquals(first.record.proxied, true);
  await tunnels.publish(tunnel.id, {
    hostname: "api.example.com",
    service: "http://localhost:9000",
    zoneId: zone.id,
  });
  // Publishing a hostname again replaces its rule and its record.
  await tunnels.publish(tunnel.id, {
    hostname: "app.example.com",
    service: "http://localhost:8081",
    zoneId: zone.id,
  });
  assertEquals(
    fake.tunnels.configuration(tunnel.id)?.config?.ingress.map((rule) =>
      `${rule.hostname ?? "*"} ${rule.service}`
    ),
    [
      "api.example.com http://localhost:9000",
      "app.example.com http://localhost:8081",
      "* http_status:404",
    ],
  );
  assertEquals(
    fake.records(zone.id).map((record) => record.name).sort(),
    ["api.example.com", "app.example.com"],
  );
  await tunnels.unpublish(tunnel.id, {
    hostname: "app.example.com",
    zoneId: zone.id,
  });
  assertEquals(
    fake.records(zone.id).map((record) => record.name),
    ["api.example.com"],
  );
  assertEquals(
    fake.tunnels.configuration(tunnel.id)?.config?.ingress.length,
    2,
  );
});

Deno.test("publish: a hostname that already has other records is refused by Cloudflare", async () => {
  const { fake, zone, tunnels } = setup();
  const cf = new CloudflareClient({ fetch: fake.fetch });
  await new DnsRecords(cf, zone.id).create({
    type: "A",
    name: "app",
    content: "192.0.2.1",
  });
  const tunnel = await tunnels.create({ name: "web" });
  const error = await assertRejects(
    () =>
      tunnels.publish(tunnel.id, {
        hostname: "app.example.com",
        service: "http://localhost:8080",
        zoneId: zone.id,
      }),
    CloudflareError,
  );
  assert(error.hasCode(81053), "a CNAME cannot sit beside an A record");
});
