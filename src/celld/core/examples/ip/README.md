<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/core/ip examples

Standalone Workers using `@celld/core/ip`. Each runs in its own test under
`celld dev`; see [the convention](../../../examples/README.md). `celld dev`
passes `CF-Connecting-IP` and `X-Forwarded-For` through as sent, so the
specs set the client address in those headers. Deployed, `CF-Connecting-IP`
is trustworthy only on Cloudflare's edge, which overwrites it; anywhere a
client reaches the Worker directly, the client picks it.

| Example | What it shows |
| --- | --- |
| [`firewall`](firewall.ts) | allow and deny lists of CIDR blocks; the peer from `CF-Connecting-IP` (trustworthy only on Cloudflare's edge), and `X-Forwarded-For` read only when the peer is a trusted proxy; mapped addresses; `firewall-typo` fails closed on a mistyped block. An allow list is not authentication |
| [`subnet`](subnet.ts) | a subnet calculator: block facts, canonical text, membership, summarizing a list; bodies capped at 64 KiB and lists at 256 entries |
| [`ratelimit`](ratelimit.ts) | a token bucket Durable Object per /24 or /64, not per address, keyed by `CF-Connecting-IP` (trustworthy only on Cloudflare's edge); `ratelimit-misconfigured` fails closed on a bad number |

```sh
buck2 test root//src/celld/core/examples/ip/...
buck2 run root//src/celld/core/examples/ip:subnet-dev   # then curl 127.0.0.1:9876
```
