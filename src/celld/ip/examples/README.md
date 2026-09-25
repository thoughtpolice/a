<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/ip examples

Standalone Workers using `@celld/ip`. Each runs in its own test under
`celld dev`; see [the convention](../../examples/README.md). `celld dev`
passes `CF-Connecting-IP` and `X-Forwarded-For` through as sent, so the
specs set the client address in those headers.

| Example | What it shows |
| --- | --- |
| [`firewall`](firewall.ts) | allow and deny lists of CIDR blocks; the client from `CF-Connecting-IP` or `X-Forwarded-For` past trusted proxies; mapped addresses; `firewall-typo` fails closed on a mistyped block |
| [`subnet`](subnet.ts) | a subnet calculator: block facts, canonical text, membership, summarizing a list |
| [`ratelimit`](ratelimit.ts) | a token bucket Durable Object per /24 or /64, not per address |

```sh
buck2 test root//src/celld/ip/examples/...
buck2 run root//src/celld/ip/examples:subnet-dev   # then curl 127.0.0.1:9876
```
