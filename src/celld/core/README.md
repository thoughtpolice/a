<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/core

The modules every other celld library builds on. It depends on nothing,
and each module is its own entry point, so a Worker bundles only the
modules it imports.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/core:core"],
)
```

| Import | What it has |
| --- | --- |
| [`@celld/core/assert`](#celldcoreassert) | assertions for Deno tests (and Workers' self-checks) |
| [`@celld/core/bounds`](#celldcorebounds) | resource limits: checked numbers, capped body reads, bounded JSON |
| [`@celld/core/ip`](#celldcoreip), `@celld/core/ip/patterns` | IPv4 and IPv6 addresses and CIDR blocks |
| [`@celld/core/isotime`](#celldcoreisotime) | strict ISO 8601 / RFC 3339 checks in front of `Temporal` |
| [`@celld/core/ulid`](#celldcoreulid) | ULIDs, monotonic factories and byte/UUID conversion |

## `@celld/core/assert`

Assertions for celld Deno tests. celld code has no module registry
dependencies (a JSR assertion library would need a lockfile and a network
fetch), so tests share these instead.

```typescript
import { assertEquals, assertRejects, assertThrows } from "@celld/core/assert";

Deno.test("parses", async () => {
  assertEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2]));
  const error = assertThrows(() => JSON.parse("{"), SyntaxError);
  assertEquals(error.name, "SyntaxError");
  await assertRejects(Promise.reject(new RangeError("late")), RangeError, "late");
});
```

| Export | What it does |
| --- | --- |
| `assert(condition, message)` | throws `message` unless `condition` holds, and narrows it |
| `assertEquals(actual, expected, message?)` | structural equality through `equals` |
| `assertThrows(fn, Class?, includes?)` | returns what `fn` threw synchronously, checked against the class and message text |
| `assertRejects(work, Class?, includes?)` | the same for a promise, or a function returning one |
| `assertCode(result, code)`, `assertOk(result)` | check a result's `code`, or that it is `ok` (and narrow it) |
| `equals(left, right)`, `show(value)` | the comparison and rendering the assertions use |

`equals` compares plain data: objects by own enumerable keys, arrays and
`Uint8Array`s item by item, everything else with `===`. It is not a deep
equality for classes: two `Map`s compare equal whatever they hold. Use
`assertThrows` and `assertRejects` rather than a local try/catch helper;
they return the error for further checks. The functions are plain, so a
Worker can use them too ([`examples/assert`](examples/assert)).

## `@celld/core/bounds`

Resource limits for code that takes numbers, bodies and documents from outside:
checked numbers, branded limit types, a streamed body reader that stops at a
byte cap, a JSON parser that enforces depth and collection caps while it parses,
and list and string caps.

```typescript
import {
  bytes,
  nonNegativeMs,
  parseJsonBounded,
  readTextBounded,
} from "@celld/core/bounds";

const ttlMs = nonNegativeMs(options.ttlMs ?? 60_000, {
  name: "ttlMs",
  max: 3_600_000,
});
const text = await readTextBounded(response, { maxBytes: bytes(64 * 1024) });
const document: unknown = parseJsonBounded(text, {
  maxDepth: 16,
  maxKeys: 64,
  maxItems: 256,
});
```

| Export                                                                                                    | What it does                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `finite(value, { name, min?, max? })`                                                                     | a finite number in range                                                                                                                    |
| `safeInt(value, { name, min?, max? })`                                                                    | a safe integer in range                                                                                                                     |
| `nonNegativeMs(value, { name, min?, max? })`                                                              | a duration from 0 to `max` (default and ceiling `MAX_TIMER_MS`)                                                                             |
| `bytes`, `count`, `depth`, `millis`                                                                       | check a number and brand it `ByteLimit`, `CountLimit`, `DepthLimit`, `DurationMs`                                                           |
| `readBounded(body, { maxBytes, signal? })`                                                                | reads a `ReadableStream`, `Request` or `Response` into bytes, stopping at the cap                                                           |
| `readTextBounded(body, { maxBytes, signal?, fatal? })`                                                    | the same, decoded as UTF-8                                                                                                                  |
| `parseJsonBounded(text, { maxDepth, maxKeys, maxItems, maxBytes?, allowPrototypeKeys?, duplicateKeys? })` | JSON as `unknown`, refused at the first broken limit                                                                                        |
| `boundedList(items, { max, name })`                                                                       | an array of at most `max` items                                                                                                             |
| `boundedString(value, { maxLength \| maxBytes, name })`                                                   | a string within a UTF-16 length or UTF-8 byte cap                                                                                           |
| `utf8Length(text)`                                                                                        | the UTF-8 length of a string, without encoding it                                                                                           |
| `BoundsError`, `BoundsCode`                                                                               | the error every check throws                                                                                                                |
| `strictRecord(value, allowedKeys, name?)`                                                                 | rejects unknown keys, non-plain objects, getters, hidden/symbol properties without invoking getters; throws `TypeError`                     |
| `jsonSnapshot(value, { maxDepth?, maxItems?, maxBytes? }?)`                                               | copies and deeply freezes JSON data; defaults 32 levels, 4096 total values/members, 64 KiB encoded JSON; throws `TypeError` or `RangeError` |
| `opaqueIdentity(secret, namespace, identity)`                                                             | HMAC-SHA-256 over a versioned, framed namespace and canonical identity; fixed 52-character lowercase base32 output                          |

Use `strictRecord` before reading security options, then validate each value's
meaning in the consuming library. Use `jsonSnapshot` for cached authorization
facts: unlike `Object.freeze`, nested arrays and records are copied and frozen.
It rejects accessors, cycles, `undefined`, non-finite numbers, prototype keys,
non-plain objects and sparse arrays. Omit optional properties rather than
writing `undefined` into JSON data. These helpers never coerce strings into
booleans.

`opaqueIdentity` expects an explicit application purpose and a canonical
identity that includes the issuer, tenant, client and subject where applicable.
Raw subjects or emails are not globally unique. Supply at least 32 secret bytes
or a prepared HMAC-SHA-256 signing key; reuse a `CryptoKey` on hot paths to
avoid reimport. Secret/namespace changes intentionally change record identities,
so plan migration before rotating. The full result carries 256 bits; a sandbox
DNS label may use its first 26 characters (130 bits). Namespace is bounded to
256 characters, identity to 16384, and raw secret material to 4096 bytes.

### Behaviour

- **Options are strict plain data.** Unknown fields, getters, inherited values,
  symbol keys and non-plain dictionaries fail with `TypeError` before values are
  read. Booleans must be booleans; `null` never means an omitted limit or flag.
  Numeric range endpoints must be finite numbers in ascending order; `NaN`,
  strings and infinities cannot disable a bound. Diagnostic names are nonempty
  strings of at most 256 characters. Omit an optional field or use `undefined`
  to select its default.
- **Checks return their input.** Each one returns the value it was given, so it
  composes inline, and throws `BoundsError` for a rejected value. `BoundsError` extends
  `RangeError` and has a `code`: `type` (wrong kind of value, used body),
  `range` (`NaN`, `±Infinity`, fraction, unsafe integer, out of range),
  `too_large`, `too_many`, `too_deep`, `syntax`, `duplicate_key`,
  `forbidden_key`. A bad limit (a negative `maxBytes`, say) is also a
  `RangeError`, so misconfiguration fails at once.
- **Durations stay within a timer's range.** `setTimeout` fires at once for
  delays above 2^31 - 1 ms, so `nonNegativeMs` refuses them and refuses a `max`
  above `MAX_TIMER_MS`.
- **Branded limits.** `ByteLimit` and the others are numbers with a type brand.
  Only the constructors make them, so a function that takes a `ByteLimit` knows
  it was checked, and a count cannot be passed where a byte limit belongs.
- **Streamed reads.** `readBounded` pulls one chunk at a time and fails the
  moment the total passes `maxBytes`, holding at most the cap plus the chunk
  that crossed it. It does not need `Content-Length`: a chunked body is capped
  the same way. A `Content-Length` above the cap is refused before reading; a
  smaller one is not trusted. On every failure the source is cancelled (without
  waiting for the cancel to settle), which releases a `fetch` connection.
  Aborting `signal` stops even a body that never sends another chunk, and
  rejects with the signal's reason.
  Each nonempty chunk is copied before requesting another, so a producer may
  reuse its buffer without corrupting prior bytes. Empty chunks are not retained.
  The reader lock is released on both success and failure, without waiting for a
  hostile cancellation promise. `maxBytes` bounds data retained, not elapsed
  time: use a deadline signal for streams that stall or send empty chunks forever.
- **Bounded JSON.** `parseJsonBounded` is a complete RFC 8259 parser (it accepts
  exactly what `JSON.parse` does) that counts nesting, members per object and
  items per array as it goes, so a hostile document is refused when it reaches a
  limit, not after it is built. Depth is the number of nested containers (`[]`
  is 1) and at most `MAX_JSON_DEPTH` (1000), so the parser's recursion is
  bounded. `maxBytes` counts UTF-8 bytes. `maxKeys` and `maxItems` apply to each
  object and array on its own, not to the document, so many small containers add
  up: the total work is bounded only by the text's length. Pass `maxBytes`, or
  read the text with `readTextBounded` first, as the example at the top does.
- **Prototype keys and duplicates.** Objects with `__proto__`, `constructor` or
  `prototype` keys are refused by default, however the key is escaped. With
  `allowPrototypeKeys` they become ordinary own properties and never change a
  prototype. A key named twice in one object is refused unless
  `duplicateKeys: "last"` asks for `JSON.parse`'s last-wins.

## `@celld/core/ip`

IPv4 and IPv6 addresses and CIDR blocks for celld. It parses, writes
canonical text and does the usual block arithmetic.

```typescript
import { contains, parseCidr, parseIp } from "@celld/core/ip";

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
| `@celld/core/ip` | `IpAddress`, `Cidr`, `parseIp`/`parseIpv4`/`parseIpv6`, `parseCidr`/`parseCidrV4`/`parseCidrV6`, `isIp*`, `isCidr*`, `contains`, `toIp`, `toCidr`, `formatIp`, `compareIp`, `IpError` |
| `@celld/core/ip/patterns` | `IPV4_PATTERN`, `IPV6_PATTERN`, `CIDR_V4_PATTERN`, `CIDR_V6_PATTERN` |

### Behaviour

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
  `IPv6address`, built from its nine alternatives). [`patterns_test.ts`](tests/ip/patterns_test.ts)
  checks the two agree on fixed and random inputs. `@celld/sieve` uses them
  for JSON Schema.

- **Parsing is text only.** An address is as trustworthy as whoever wrote
  it. A client address from a header (`CF-Connecting-IP`,
  `X-Forwarded-For`) is only as good as the peer that set it:
  `CF-Connecting-IP` holds on Cloudflare's edge, which overwrites it, and
  nowhere a client can reach the Worker directly; `X-Forwarded-For` holds
  only for entries appended by proxies you trust, read from the right. In a
  `@celld/web/router` app use `clientIpForAuthorization(c)` for access
  decisions, with `clientIp.trustedProxies`, and `clientIp.peer` from the
  platform off Cloudflare's edge.
- **An allow list is not authentication.** It narrows who can try; it does
  not say who is asking. Keep real authentication behind it.

`IpAddress` and `Cidr` are classes. Structured clone, and so Durable Object
RPC, drops the prototype, so send the string form.

## `@celld/core/isotime`

Strict ISO 8601 / RFC 3339 checks for text arriving at a trust boundary,
in front of `Temporal`.

Use `Temporal` for time itself: instants, time zones, calendars,
arithmetic, differences, formatting. celld supports it natively and the
toolchain's TypeScript has its types. Use this library only where text
comes in, to decide whether that text is acceptable before `Temporal`
sees it.

`Temporal`'s parsers are lenient on purpose. `Temporal.Instant.from` takes
`2026-09-25 10:15+0200`, `+002026-09-25T10:15Z`, and
`2026-09-25T10:15Z[Europe/Paris][u-ca=gregory]`. They also cannot express
rules such as "exactly three fractional digits" or "`Z` only, no offset".
This library reads only RFC 3339's profile, applies zod 4's
`precision`/`offset`/`local` rules, and then returns the `Temporal` value
for text that passes.

```typescript
import { parseDateTime, parseDuration } from "@celld/core/isotime";

const at = parseDateTime("2026-09-25T10:15:30.25+02:00", { offset: true });
// Temporal.Instant 2026-09-25T08:15:30.25Z
at!.toZonedDateTimeISO("America/New_York").toString();
// "2026-09-25T04:15:30.25-04:00[America/New_York]"

parseDateTime("2026-09-25T10:15:30+02:00"); // null: Z only by default
parseDateTime("2026-09-25T10:15:30Z[UTC]"); // null: no annotations

const every = parseDuration("P1M")!; // Temporal.Duration
Temporal.PlainDate.from("2024-01-31").add(every).toString(); // "2024-02-29"
```

### What it accepts

| Function | Text | Options | Returns |
| --- | --- | --- | --- |
| `parseDate` | `YYYY-MM-DD` | none | `Temporal.PlainDate` |
| `parseYearMonth` | `YYYY-MM` | none | `Temporal.PlainYearMonth` |
| `parseTime` | `HH:MM[:SS[.f]]` | `precision`, `zone: "none" \| "required" \| "any"` (default `"none"`) | `Temporal.PlainTime` |
| `parseDateTime` | `YYYY-MM-DDTHH:MM[:SS[.f]]` + zone | `precision`, `offset`, `local` | `Temporal.Instant`, or with `local: true` also `Temporal.PlainDateTime` |
| `parseLocalDateTime` | the same, with no zone | `precision` | `Temporal.PlainDateTime` |
| `parseDuration` | `PnYnMnDTnHnMnS` or `PnW` | none | `Temporal.Duration` |

Each returns null for text it does not accept, and each has an `is*` form
that returns a boolean (`isDate`, `isYearMonth`, `isTime`, `isDateTime`,
`isDuration`).
`parseDateTime` is overloaded: without `local: true` its result is typed as
an `Instant`; with it, callers tell the two apart with `instanceof`. The
options match zod 4's `z.iso.*`, and `@celld/sieve` builds on them:

- `precision`: `-1` means minutes only, `0` whole seconds, `n` exactly `n`
  fractional digits. Without it, seconds are optional and a fraction may
  have any number of digits (digits past nanoseconds are cut off).
- Date-times accept `Z` by default. `offset: true` also accepts `±HH:MM`,
  and `local: true` also accepts no zone.
- Times take no zone by default, like `z.iso.time`. `zone: "required"` is
  RFC 3339's `full-time`. A `PlainTime` has no zone, so the zone is
  checked and then dropped.

Deliberately rejected: lower-case `t` and `z`, a space instead of `T`,
`±HHMM` and `±HH` offsets, bracketed zone or calendar annotations, leap
seconds (`:60`), `24:00`, years outside 0000-9999 (including `±YYYYYY`),
week and ordinal dates, and `,` as the decimal mark in times. RFC 3339's
`-00:00` ("offset unknown") is the same instant as `Z`.

Durations need at least one component, and `T` needs one after it. Weeks
stand alone. Only the last component may have a fraction, written with `.`
or `,`, and only when it is hours, minutes or seconds: a fractional day,
week, month or year has no fixed length, and `Temporal.Duration` refuses
one. Signs are not accepted, and neither is a duration too large for
`Temporal.Duration`.

### What it does not check

Accepted values are not bounded in size. `P9999Y`, `PT99999999999H` and
the year 0000 all pass, as long as `Temporal` can hold them, and the text
itself may be as long as the caller sends. The library decides what the
text means, not whether the value is reasonable for your use. So:

- Cap the input's length (and the body it came in) before parsing.
- Range-check the result before it reaches a timer, an alarm, a stored
  expiry or an ID. `setTimeout` fires at once past 2^31 - 1 ms, celld's
  Durable Object alarms abort the node past 2^36 ms from now (see the
  toolchain README), and a ULID's time holds only 1970 to 10889. The
  examples cap a TTL at `P31D`, and refuse a reminder whose due time a ULID
  cannot hold.
- `Temporal`'s own `RangeError` (a sum past its range) is the caller's
  mistake, not a server error: answer 400.

## `@celld/core/ulid`

[ULIDs](https://github.com/ulid/spec) for celld. A ULID is 128 bits: a
48-bit Unix time in milliseconds, then 80 random bits, written as 26
characters of Crockford base32. Sorting the strings sorts by time.

```typescript
import { decodeTime, isUlid, monotonicFactory, ulid, ulidToUuid } from "@celld/core/ulid";

const id = ulid(); // fresh randomness every call
decodeTime(id); // epoch milliseconds
isUlid(id.toLowerCase()); // true: decoding ignores case

const next = monotonicFactory();
next() < next(); // true, even within one millisecond

ulidToUuid(id); // the same 128 bits in UUID spelling
```

| Export | What it does |
| --- | --- |
| `ulid(time?)` | A new ULID at `time` (default now). |
| `ulidFactory({ now, random })` | The same, with an injected clock and random source. |
| `monotonicFactory({ now, random })` | ULIDs that strictly increase. |
| `isUlid`, `canonicalUlid` | Test text; upper-case it after checking it. |
| `decodeTime`, `encodeTime` | The time part, both ways. |
| `ulidToBytes`, `ulidFromBytes` | 16 big-endian bytes, both ways. |
| `ulidToUuid`, `ulidFromUuid` | UUID text, both ways. |
| `ULID_PATTERN`, `ENCODING`, `MAX_TIME` | The regex source, alphabet and largest time. |

Errors throw `UlidError`.

### Rules taken from the spec

- The first character is at most `7`. Anything larger would need more than
  128 bits.
- Decoding ignores case. `I`, `L`, `O` and `U` are rejected. Crockford reads
  the first three as `1`, `1` and `0`, but no ULID encoder writes them, so
  accepting them would give one ULID several spellings.
- Within one millisecond, the monotonic factory adds one to the previous
  random part. If the clock goes backwards it keeps the last time and keeps
  counting. When the 80-bit random part would overflow it throws, as the
  spec requires, instead of wrapping around or borrowing from the time.
- `ulidToUuid` copies bits. The result is usually not a valid RFC 9562 UUID,
  because the version and variant bits are whatever the ULID had.

### What a ULID does not protect

- A ULID is an identifier, not a capability. Do not let knowing one grant
  access to a record. From a monotonic factory, the next ID in the same
  millisecond is the previous one plus one, so it is easy to guess. Even
  from `ulid()`, the first ten characters say when the ID was made, to the
  millisecond. Anyone who sees the ID learns that time.
- A factory's state is shared by everything that calls it. A
  `monotonicFactory` never goes back in time, so a caller-supplied `time`
  in the future moves it forward for every later ID it makes. Refuse future
  times from callers (the [`mint`](examples/ulid/mint.ts) example does), or use a
  separate factory for them. `ulid(time)` keeps no state between calls.
- `time` is only range-checked (0 to `MAX_TIME`, about the year 10889).
  Check a caller's time against your own clock before you use it.

## Examples

[`examples/`](examples) has standalone Workers for each module, each tested
under `celld dev` (`buck2 test root//src/celld/core/examples/...`) and
runnable with `buck2 run root//src/celld/core/examples/<module>:<name>-dev`:
[assert](examples/assert), [ip](examples/ip), [isotime](examples/isotime)
and [ulid](examples/ulid). Every example reads its bodies through
`@celld/core/bounds`.

## Tests

```sh
buck2 test root//src/celld/core/...
```
