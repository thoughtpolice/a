<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/isotime examples

Standalone Workers that do their time with `Temporal` and use
`@celld/isotime` only to check the text they are given. Each runs in its
own test under `celld dev`; see [the convention](../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`reminders`](reminders.ts) | "in PT15M" or "at" a date-time, in an IANA time zone via `Temporal.ZonedDateTime` (`P1D` vs `PT24H` across daylight saving, skipped wall-clock times refused); anchored months; ULID keys in due order; a Durable Object alarm |
| [`durations`](durations.ts) | `Temporal.Duration` arithmetic: fixed and anchored lengths, between, repeating series, days in a zone |
| [`convert`](convert.ts) | instants between offsets, IANA zones and precisions; what the RFC 3339 profile accepts, and what `Temporal.Instant.from` alone would let through |
| [`ttl`](ttl.ts) | a store whose TTLs (and default TTL setting) are `Temporal.Duration`s, expired by an alarm |

```sh
buck2 test root//src/celld/isotime/examples/...
buck2 run root//src/celld/isotime/examples:durations-dev   # then curl 127.0.0.1:9876
```
