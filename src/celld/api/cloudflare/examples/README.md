<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/api/cloudflare examples

Standalone Workers using `@celld/api/cloudflare`, each tested under
`celld dev` against a fake Cloudflare (the v4 API and siteverify on one
origin; see [`upstream.ts`](upstream.ts)). See
[the convention](../../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`signup`](signup.ts) | a waitlist behind Turnstile: siteverify with the expected hostname and action, fail closed when siteverify is down, each address added once by a Durable Object insert; public on purpose |
| [`admin`](admin.ts) | an operator API behind an `x-api-key`: publish a hostname through a tunnel (ingress rule and proxied CNAME), hand out the connector token, purge URLs, look a domain up in Intel, submit and poll an unlisted URL scan |

```sh
buck2 test root//src/celld/api/cloudflare/examples/...
buck2 run root//src/celld/api/cloudflare/examples:admin-dev   # then curl 127.0.0.1:9876
```

With `-- --live` the examples reach the real Cloudflare: give them
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ZONE_ID`
(and the Turnstile widget's `TURNSTILE_SITEKEY` and `TURNSTILE_SECRET`)
with `-- --var NAME=VALUE`.
