<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/ulid

[ULIDs](https://github.com/ulid/spec) for celld. A ULID is 128 bits: a
48-bit Unix time in milliseconds, then 80 random bits, written as 26
characters of Crockford base32. Sorting the strings sorts by time.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    import_name = "@example/app",
    deps = ["root//src/celld/ulid:ulid"],
)
```

```typescript
import { decodeTime, isUlid, monotonicFactory, ulid, ulidToUuid } from "@celld/ulid";

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

## Rules taken from the spec

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

## Examples

[`examples/`](examples) has standalone Workers using this library, each
tested under `celld dev`
(`buck2 test root//src/celld/ulid/examples/...`) and runnable with
`buck2 run root//src/celld/ulid/examples:<name>-dev`.

## Tests

```sh
buck2 test root//src/celld/ulid/...
```
