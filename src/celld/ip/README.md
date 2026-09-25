<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/ip

IPv4 and IPv6 addresses and CIDR blocks for celld. It parses, writes
canonical text and does the usual block arithmetic. It has no
dependencies.

```typescript
import { contains, parseCidr, parseIp } from "@celld/ip";

parseIp("2001:0DB8:0:0:0:0:0:1")?.toString(); // "2001:db8::1"
parseIp("::ffff:192.0.2.1")?.toIpv4()?.toString(); // "192.0.2.1"

const block = parseCidr("192.0.2.77/26")!;
block.network.toString(); // "192.0.2.64"
block.broadcast.toString(); // "192.0.2.127"
block.netmask.toString(); // "255.255.255.192"
block.size; // 64n
parseCidr("192.0.2.77/26", { strict: true }); // null: host bits set

contains("10.0.0.0/8", "10.20.30.40"); // true
```

| Import | What it has |
| --- | --- |
| `@celld/ip` | `IpAddress`, `Cidr`, `parseIp`/`parseIpv4`/`parseIpv6`, `parseCidr`/`parseCidrV4`/`parseCidrV6`, `isIp*`, `isCidr*`, `contains`, `toIp`, `toCidr`, `formatIp`, `compareIp`, `IpError` |
| `@celld/ip/patterns` | `IPV4_PATTERN`, `IPV6_PATTERN`, `CIDR_V4_PATTERN`, `CIDR_V6_PATTERN` |

## Behaviour

- **Parsers return null, helpers throw.** `parse*` and `is*` never throw.
  `contains`, `toIp` and `toCidr` take text too, and throw `IpError` when it
  does not parse. A typo in an allow list or deny list then fails loudly
  instead of matching nothing.
- **IPv4** is four decimal octets without leading zeros. `010.0.0.1` is
  rejected because some parsers read it as octal.
- **IPv6** accepts every RFC 4291 text form: `::`, either case, and an IPv4
  tail (`64:ff9b::192.0.2.1`). Zone indices (`fe80::1%eth0`) and brackets
  are rejected.
- **Output** follows RFC 5952: lower case, no leading zeros, the longest run
  of two or more zero groups becomes `::` (the first run on a tie), and
  IPv4-mapped addresses print as `::ffff:a.b.c.d`. `toJSON` returns the same
  string.
- **CIDR**. The prefix is decimal without leading zeros, 0-32 or 0-128. By
  default the address may have host bits set, which `Cidr.address` keeps and
  `Cidr.network` clears; `{ strict: true }` rejects them. `broadcast` is the
  last address of the block for both versions. IPv6 has no broadcast
  address, but the last address is still useful.
- **Versions never mix.** `contains("10.0.0.0/8", "::ffff:10.0.0.1")` is
  false. Call `toIpv4()` first if a mapped address should match an IPv4
  block.
- **Patterns** accept exactly what the parsers accept (IPv6 is RFC 3986's
  `IPv6address`, built from its nine alternatives). `patterns_test.ts`
  checks the two agree on fixed and random inputs. `@celld/sieve` uses them
  for JSON Schema.

`IpAddress` and `Cidr` are classes. Structured clone, and so Durable Object
RPC, drops the prototype, so send the string form.

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev`
(`buck2 test root//src/celld/ip/examples/...`) and runnable with
`buck2 run root//src/celld/ip/examples:<name>-dev`.

## Tests

```sh
buck2 test root//src/celld/ip/...
```
