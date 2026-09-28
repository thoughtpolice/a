<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/cloudflare

A typed client for the [Cloudflare API](https://developers.cloudflare.com/api/)
from celld. It covers zones and DNS, the CDN cache, Cloudflare Tunnel,
Turnstile, and Investigate (Intel lookups and URL Scanner). Requests go
through an exe.dev HTTP proxy integration that holds the API token, or
straight to Cloudflare with one.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/api/cloudflare:cloudflare"],
)
```

```typescript
import { CloudflareClient } from "@celld/api/cloudflare";
import { DnsRecords, Zones } from "@celld/api/cloudflare/zones";
import { Tunnels } from "@celld/api/cloudflare/tunnels";

const cf = new CloudflareClient(); // https://cloudflare.int.exe.xyz
const zone = await new Zones(cf).byName("example.com");
await new DnsRecords(cf, zone.id).upsert({
  type: "TXT",
  name: "_verify.example.com",
  content: "token",
});

const tunnels = new Tunnels(cf, accountId);
const tunnel = await tunnels.create({ name: "web" });
await tunnels.publish(tunnel.id, {
  hostname: "app.example.com",
  service: "http://localhost:8080",
  zoneId: zone.id,
});
const token = await tunnels.token(tunnel.id); // cloudflared tunnel run --token ...
```

| Import | Target | What it has |
| --- | --- | --- |
| `@celld/api/cloudflare` | `:cloudflare` | `CloudflareClient` (requests, pagination, `verifyToken`), `CloudflareError`, id checks |
| `@celld/api/cloudflare/zones` | `:cloudflare` | `Zones`, `ZoneSettings`, `DnsRecords` (list, CRUD, `batch`, `export`, `upsert`), `recordBody` |
| `@celld/api/cloudflare/cache` | `:cloudflare` | `Cache`: `purge`, cache settings, Cache Rules, Tiered Cache, Cache Reserve |
| `@celld/api/cloudflare/tunnels` | `:cloudflare` | `Tunnels`: CRUD, `token`, `configure`, `publish`/`unpublish`, connections; `checkIngress` |
| `@celld/api/cloudflare/turnstile` | `:cloudflare` | `verifyTurnstile` (siteverify), `TurnstileWidgets`, `TEST_KEYS` |
| `@celld/api/cloudflare/investigate` | `:cloudflare` | `Intel` (domain, IP, WHOIS, passive DNS, ASN, URL), `UrlScanner` |
| `@celld/api/cloudflare/testing` | `:cloudflare` | `FakeCloudflare`, a stateful model of all of the above |
| `@celld/api/cloudflare/reflection` | `:reflection` | `cloudflareFromReflection`, `chooseCloudflareIntegration` |

## The token

Through exe.dev, the VM (and celld Workers on it) never holds the token.
An HTTP proxy integration injects it:

```
exe.dev ▶ integrations add http-proxy --name cloudflare \
  --target https://api.cloudflare.com \
  --header 'Authorization:Bearer <token>' \
  --attach tag:cloudflare
```

`new CloudflareClient()` then talks to `https://cloudflare.int.exe.xyz/client/v4`;
`integration` names another, and `cloudflareFromReflection()` finds it
through exe.dev's reflection service. Outside exe.dev, `new
CloudflareClient({ token })` sends it to `https://api.cloudflare.com`.
`CloudflareClient.fromEnv(env)` reads `CLOUDFLARE_API_TOKEN` (or, with none
bound, `CLOUDFLARE_INTEGRATION`), and `CLOUDFLARE_BASE_URL` for a fake.

Make a *user* API token (`cfut_...`) with what the areas you use need.
Cloudflare does not accept account-owned tokens (`cfat_...`) for
Turnstile.

| Area | Dashboard permission |
| --- | --- |
| Zones | `Zone > Zone > Read` (`Edit` to add, pause or delete) |
| DNS | `Zone > DNS > Read` / `Edit` |
| Zone settings, Tiered Cache, Cache Reserve | `Zone > Zone Settings > Read` / `Edit` |
| Purging | `Zone > Cache Purge > Purge` |
| Cache Rules | `Zone > Cache Rules > Edit` |
| Tunnels | `Account > Cloudflare Tunnel > Read` / `Edit` (reading a tunnel's token needs `Edit`) |
| Turnstile widgets | `Account > Turnstile > Edit` |
| Intel | `Account > Intel > Read` |
| URL Scanner | `Account > URL Scanner > Edit` |

Siteverify is different: it takes the widget's secret in the request
body, which a header-injecting integration cannot add, so that secret is
a Worker secret of its own.

## Requests

- **Errors.** A refusal is a `CloudflareError` with `kind: "api"`, the
  HTTP `status`, and the envelope's `errors` (each a numeric `code`, a
  message, and sometimes an `error_chain`): `error.hasCode(81058)` asks
  whether an identical DNS record already exists. The other kinds are
  `rate-limited` (429, with `retryAfterMs`), `http` (a status without an
  envelope, such as a proxy's page), `too-large`, `timeout`, `network` and
  `response` (an answer that is not what the endpoint sends). `rayId` is
  the response's `cf-ray`, for Cloudflare's support.
- **Retries.** GET, PUT and DELETE are retried on 429 (waiting as
  `Retry-After` asks) and on 500, 502, 503 and 504, up to three times
  within two minutes. POST and PATCH are not, since a write whose answer
  was lost may have happened: a DNS record created twice is two records.
  The writes that are safe twice say so: purging, and setting a zone
  setting.
- **Lists.** `list()` walks the pages and returns at most `maxItems`
  (default 10 000). With more it throws rather than return part of the
  list, unless asked to `truncate`; `pages()` walks a page at a time.
- **Ids.** Account, zone, record and rule ids must be 32 hex digits,
  tunnel and scan ids UUIDs, so a zone's name passed as its id fails
  before anything is sent, and no id can change the request's path.
- **Limits.** Responses are read up to 16 MiB (`maxResponseBytes`), error
  bodies up to 64 KiB, and each attempt has 30 s (`timeoutMs`). Cloudflare
  allows each user 1,200 requests per five minutes, across the dashboard
  and every token.

## Zones and DNS

`Zones` lists, finds (`byName`), adds, edits (one field per call, as
Cloudflare takes it) and deletes zones; `ZoneSettings` reads and changes a
setting by id. `DnsRecords` covers one zone's records:

- `create`, `overwrite` (PUT: a whole record), `edit` (PATCH: some fields),
  `delete`, `get`, `list` with Cloudflare's filters (`name`, `content` and
  `comment` exact or by `contains`/`startswith`/`endswith`, `type`, `tag`,
  `proxied`, `search`).
- `batch` applies deletes, then patches, then puts, then posts, all or
  nothing; at most 3,500 changes (200 on the Free plan).
- `upsert` makes a record the only one of its name and type, and refuses
  to guess when there are several.
- `export` returns the zone as a BIND file.

`recordBody` checks a record before it is sent: the value's form for its
type (an IPv4 address for `A`, `data` for SRV and CAA), `proxied` only for
A, AAAA and CNAME, a TTL of 1 (automatic) or 30 to 86400 seconds, a
one-line comment, and at most 20 tags. Cloudflare no longer changes a
record's type in place; delete and post it in one `batch`.

## Cache

`Cache` purges by URL (with the headers a custom cache key varies on), tag,
host, prefix or everything, splitting long lists into requests of 100 (set
`purgeBatchSize` to 500 for an Enterprise zone's URLs). A 200 means
Cloudflare took the purge, not that the objects are gone. It also reads and
sets the cache settings (`cache_level`, `browser_cache_ttl`,
`edge_cache_ttl`, `development_mode`, ...), Tiered Cache and Smart Topology,
and Cache Reserve.

Cache Rules live in the zone's `http_request_cache_settings` ruleset.
`setRules` replaces every rule in it, including rules Terraform or the
dashboard made; pass an existing rule's `id` to keep it. `addRule` and
`deleteRule` change one rule and leave the others alone.

## Tunnels

`Tunnels` creates remotely managed tunnels (Cloudflare holds the ingress
rules), hands out the token `cloudflared tunnel run --token` needs,
replaces the configuration, and lists or cleans up connectors. A tunnel
with connectors attached cannot be deleted. `checkIngress` checks rules as
`cloudflared` would: a service it knows, and a last rule that matches
everything (`{ service: "http_status:404" }`).

`publish(tunnelId, { hostname, service, zoneId })` puts the hostname's rule
ahead of the catch-all (replacing an older one for the same hostname) and
makes a proxied CNAME to `<tunnel id>.cfargotunnel.com` the name's one
record. Its two steps are separate requests; calling it again after a
failure finishes the job. `unpublish` removes both. The tunnel object's
`connections` list goes away on 2026-10-05; use `connections()`.

## Turnstile

`verifyTurnstile({ secret, token, remoteip, expectedHostname,
expectedAction })` asks siteverify about a token and checks the hostname,
action and age it reports. A refused token is a verdict with `success:
false` and siteverify's `errorCodes` (or `hostname-mismatch`,
`action-mismatch`, `challenge-too-old`), not an error; only failing to
reach siteverify throws, and the caller decides whether that fails
closed. Tokens are single use, so each call carries an `idempotency_key`,
which lets a check whose answer was lost be asked again safely.
`TEST_KEYS` are Cloudflare's documented test sitekeys and secrets.

`TurnstileWidgets` creates, lists (without secrets), replaces and deletes
widgets, and rotates a secret (the old one keeps working for two hours
unless `invalidateImmediately`).

## Investigate

`Intel` answers what Security Center's Investigate shows: a domain's
categories, risk types and popularity (`domain`, `domains`,
`domainHistory`), an address's owner and risks (`ip`), WHOIS, passive DNS
for an IPv4 address, ASNs and their prefixes, and a URL's categories.
**Intel calls count against a monthly quota**, 100 on the Free, Pro and
Business plans and 2,500 on Enterprise, shared with the dashboard, so
cache what you look up.

`UrlScanner` submits scans (`submit`, `submitMany`), polls them (`result`
is null while a scan runs; `wait` polls every 10 s up to a deadline), and
reads a finished scan's verdict, screenshot, HAR and DOM, or searches past
scans. Scans are `Unlisted` unless you ask for `Public`, so a private URL
is not published by accident. The Free plan cannot make unlisted scans,
so pass `visibility: "Public"` there. A host scanned very recently is
refused with 409.

## Testing

`FakeCloudflare` from `./testing` is a stateful model of every area. It
answers in the v4 envelope with Cloudflare's error codes for the mistakes
it checks. For example, it refuses an identical record (81058), a CNAME
beside another record (81053), deleting a connected tunnel, a spent or
foreign Turnstile token, and more than 100 purge items. `calls` records
every request, `failNext` injects failures (an HTML 502, a 429 with
`Retry-After`, a failure after the change was applied), and the area
handles (`fake.turnstile.issueToken`, `fake.tunnels.connect`,
`fake.investigate.setDomain`, ...) set up what a test needs. Pass
`fake.fetch` as the client's `fetch`, or serve `fake.handle`.

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev` against the fake
(`buck2 test root//src/celld/api/cloudflare/examples/...`): a waitlist
behind Turnstile, and an operator API over tunnels, the cache and
Investigate.

## Live smoke test

`:live-smoke-run` runs `tests/live/smoke.ts` against the real API, here
with a token or on an exe.dev VM through the integration:

```sh
CLOUDFLARE_API_TOKEN=... buck2 run root//src/celld/api/cloudflare:live-smoke-run -- --zone example.com
buck2 run root//src/celld/api/cloudflare:live-smoke-run -- --vm my-vm.exe.xyz --zone example.com
```

It only reads unless given `--write`. With `--write` it creates a TXT
record, a tunnel and a widget, all named `celld-smoke-<random>` and
deleted at the end, and purges one URL. `--intel` spends two Intel calls
of the monthly quota; `--scan` submits one unlisted scan of
`https://example.com/`.

## Tests

```sh
buck2 test root//src/celld/api/cloudflare/...
```
