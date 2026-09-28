// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A live smoke test against the real Cloudflare API. No test target runs
 * it: `buck2 run :live-smoke-run -- [options]` bundles it and runs it with
 * Deno, here with `CLOUDFLARE_API_TOKEN` from the environment, or on an
 * exe.dev VM through the Cloudflare integration (`--vm`); see
 * `tests/live_smoke.py`.
 *
 * By default it only reads. `--write` also changes things, all of them
 * named `celld-smoke-<random>` and removed at the end even when a check
 * fails: a TXT record in `--zone`, a purge of one URL nobody requests, a
 * tunnel, and a Turnstile widget. `--intel` spends two Intel calls of the
 * account's monthly quota (100 on non-Enterprise plans); `--scan` submits
 * one unlisted URL Scanner scan of `https://example.com/` and waits for it.
 *
 * Options: `--account <id>` (default: the token's only account), `--zone
 * <name>`, `--integration <name>` (through an exe.dev integration instead
 * of a token), `--write`, `--intel`, `--scan`.
 *
 * @module
 */

import { CloudflareClient, CloudflareError } from "@celld/api/cloudflare";
import { Cache } from "@celld/api/cloudflare/cache";
import { Intel, UrlScanner } from "@celld/api/cloudflare/investigate";
import {
  TEST_KEYS,
  TurnstileWidgets,
  verifyTurnstile,
} from "@celld/api/cloudflare/turnstile";
import { Tunnels } from "@celld/api/cloudflare/tunnels";
import {
  DnsRecords,
  type Zone,
  Zones,
  ZoneSettings,
} from "@celld/api/cloudflare/zones";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: unknown;
}

const args = Deno.args;
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const integration = flag("integration");
const token = integration === undefined
  ? Deno.env.get("CLOUDFLARE_API_TOKEN")?.trim()
  : undefined;
if (integration === undefined && !token) {
  console.error(
    "set CLOUDFLARE_API_TOKEN, or pass --integration <name> on an exe.dev VM",
  );
  Deno.exit(2);
}
const cf = new CloudflareClient(
  integration === undefined ? { token } : { integration },
);
const checks: Check[] = [];
const tag = `celld-smoke-${
  crypto.randomUUID().replaceAll("-", "").slice(0, 10)
}`;

async function check<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const started = performance.now();
  try {
    const detail = await fn();
    checks.push({
      name,
      ok: true,
      ms: Math.round(performance.now() - started),
      ...(detail === undefined ? {} : { detail }),
    });
    report(true, name);
    return detail;
  } catch (error) {
    checks.push({
      name,
      ok: false,
      ms: Math.round(performance.now() - started),
      detail: error instanceof CloudflareError
        ? error.toJSON()
        : String(error instanceof Error ? error.stack : error),
    });
    report(false, name);
    return undefined;
  }
}

function report(ok: boolean, name: string): void {
  const last = checks[checks.length - 1];
  console.error(`${ok ? "ok" : "FAIL"} ${name} (${last.ms} ms)`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await check("token is active", async () => {
  const status = await cf.verifyToken();
  assert(status.status === "active", `status ${status.status}`);
  return { id: status.id, expires_on: status.expires_on ?? null };
});

const accountId = flag("account") ?? await check("one account", async () => {
  const accounts = await cf.list<{ id: string; name: string }>(
    "/accounts",
    {},
    {
      maxItems: 50,
    },
  );
  assert(
    accounts.length === 1,
    `the token sees ${accounts.length} accounts; pass --account`,
  );
  return accounts[0].id;
});

const zones = new Zones(cf);
await check("zones list", async () => {
  const listed = await zones.list({}, { maxItems: 50, truncate: true });
  return listed.map((zone) => `${zone.name} (${zone.status})`);
});

const zoneName = flag("zone");
let zone: Zone | undefined;
if (zoneName !== undefined) {
  zone = await check("zone by name", () => zones.byName(zoneName));
}

if (zone !== undefined) {
  const dns = new DnsRecords(cf, zone.id);
  await check("dns records list", async () => {
    const records = await dns.list({}, { maxItems: 500, truncate: true });
    return {
      count: records.length,
      types: [...new Set(records.map((r) => r.type))],
    };
  });
  await check("dns export is a zone file", async () => {
    const text = await dns.export();
    assert(text.includes(zone!.name), "the zone's name is in its file");
    return { bytes: text.length };
  });
  await check(
    "zone setting ssl",
    async () => (await new ZoneSettings(cf, zone!.id).get("ssl")).value,
  );
  const cache = new Cache(cf, zone.id);
  await check(
    "cache level",
    async () => (await cache.setting("cache_level")).value,
  );
  await check("cache rules", async () => (await cache.rules()).length);
  await check("tiered caching", () => cache.tieredCaching());
}

if (accountId !== undefined) {
  const tunnels = new Tunnels(cf, accountId);
  await check(
    "tunnels list",
    async () =>
      (await tunnels.list({}, { maxItems: 100, truncate: true })).map((t) =>
        `${t.name} (${t.status})`
      ),
  );
  await check(
    "turnstile widgets list",
    async () =>
      (await new TurnstileWidgets(cf, accountId).list({}, {
        maxItems: 100,
        truncate: true,
      })).map((widget) => widget.name),
  );
}

await check("siteverify passes the test secret's dummy token", async () => {
  const verdict = await verifyTurnstile({
    secret: TEST_KEYS.secrets.alwaysPasses,
    token: TEST_KEYS.dummyToken,
  });
  assert(verdict.success, JSON.stringify(verdict.errorCodes));
  return {
    testingKey: verdict.testingKey ?? false,
    hostname: verdict.hostname,
  };
});

await check("siteverify refuses with the failing test secret", async () => {
  const verdict = await verifyTurnstile({
    secret: TEST_KEYS.secrets.alwaysFails,
    token: TEST_KEYS.dummyToken,
  });
  assert(!verdict.success, "refused");
  return verdict.errorCodes;
});

await check("siteverify refuses a made-up secret", async () => {
  const verdict = await verifyTurnstile({
    secret: "0x0000000000000000000000000000000000",
    token: TEST_KEYS.dummyToken,
  });
  assert(!verdict.success, "refused");
  return verdict.errorCodes;
});

if (has("intel") && accountId !== undefined) {
  const intel = new Intel(cf, accountId);
  await check("intel domain (1 of the monthly quota)", async () => {
    const found = await intel.domain("cloudflare.com", { skipDns: true });
    return {
      rank: found.popularity_rank ?? null,
      categories: (found.content_categories ?? []).map((c) => c.name),
    };
  });
  await check(
    "intel ip (1 of the monthly quota)",
    async () =>
      (await intel.ip("1.1.1.1")).map((item) =>
        item.belongs_to_ref?.description
      ),
  );
}

if (has("scan") && accountId !== undefined) {
  const scanner = new UrlScanner(cf, accountId);
  await check("url scan of example.com", async () => {
    const scan = await scanner.submit({ url: "https://example.com/" });
    const result = await scanner.wait(scan.uuid, { deadlineMs: 180_000 });
    return {
      uuid: scan.uuid,
      success: result.task.success ?? null,
      malicious: result.verdicts?.overall?.malicious ?? null,
    };
  });
}

if (has("write")) {
  const cleanups: (() => Promise<unknown>)[] = [];
  try {
    if (zone !== undefined) {
      const dns = new DnsRecords(cf, zone.id);
      const name = `_${tag}.${zone.name}`;
      await check("dns create, upsert and find a TXT record", async () => {
        const made = await dns.create({
          type: "TXT",
          name,
          content: `"${tag}"`,
          comment: tag,
        });
        cleanups.push(() => dns.delete(made.id));
        const again = await dns.upsert({
          type: "TXT",
          name,
          content: `"${tag} 2"`,
        });
        assert(
          !again.created && again.record.id === made.id,
          "upsert overwrote it",
        );
        const found = await dns.find(name, "TXT");
        assert(found.length === 1, `found ${found.length}`);
        return found[0].content;
      });
      await check(
        "purge one URL nobody requests",
        async () =>
          await new Cache(cf, zone!.id).purge({
            files: [`https://${zone!.name}/__${tag}`],
          }),
      );
    }
    if (accountId !== undefined) {
      const tunnels = new Tunnels(cf, accountId);
      await check("tunnel create, token, configure", async () => {
        const tunnel = await tunnels.create({ name: tag });
        cleanups.push(() => tunnels.delete(tunnel.id));
        const token = await tunnels.token(tunnel.id);
        assert(
          JSON.parse(atob(token)).t === tunnel.id,
          "the token names the tunnel",
        );
        const hostname = zone === undefined
          ? `${tag}.example.com`
          : `${tag}.${zone.name}`;
        const configured = await tunnels.configure(tunnel.id, {
          ingress: [
            { hostname, service: "http://localhost:1" },
            { service: "http_status:404" },
          ],
        });
        const read = await tunnels.configuration(tunnel.id);
        assert(read.version === configured.version, "read back");
        return { id: tunnel.id, version: read.version };
      });
      await check("turnstile widget create and rotate", async () => {
        const widgets = new TurnstileWidgets(cf, accountId);
        const widget = await widgets.create({
          name: tag,
          domains: [zone?.name ?? "example.com"],
          mode: "managed",
        });
        cleanups.push(() => widgets.delete(widget.sitekey));
        assert(typeof widget.secret === "string", "a secret on create");
        const rotated = await widgets.rotateSecret(widget.sitekey, {
          invalidateImmediately: true,
        });
        assert(rotated.secret !== widget.secret, "a new secret");
        return { sitekey: widget.sitekey };
      });
    }
  } finally {
    // Nothing of a cleanup's answer is reported: a deleted widget carries
    // its secret.
    for (const cleanup of cleanups.reverse()) {
      await check("clean up", async () => {
        await cleanup();
      });
    }
  }
}

const failed = checks.filter((c) => !c.ok).length;
console.log(
  JSON.stringify({ passed: checks.length - failed, failed, checks }, null, 2),
);
Deno.exit(failed === 0 ? 0 : 1);
