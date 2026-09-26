<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/core/isotime examples

Standalone Workers that do their time with `Temporal` and use
`@celld/core/isotime` only to check the text they are given. Each runs in its
own test under `celld dev`; see [the convention](../../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`reminders`](reminders.ts) | "in PT15M" or "at" a date-time, in an IANA time zone via `Temporal.ZonedDateTime` (`P1D` vs `PT24H` across daylight saving, skipped wall-clock times refused); anchored months; ULID keys in due order, with due times a ULID cannot hold refused; a Durable Object alarm that also deletes what fired over a week ago. Unauthenticated: every caller shares one list |
| [`durations`](durations.ts) | `Temporal.Duration` arithmetic: fixed and anchored lengths, between, repeating series, days in a zone |
| [`convert`](convert.ts) | instants between offsets, IANA zones and precisions; what the RFC 3339 profile accepts, and what `Temporal.Instant.from` alone would let through |
| [`ttl`](ttl.ts) | a store whose TTLs (and default TTL setting) are `Temporal.Duration`s, capped at `P31D` and expired by an alarm, with at most `MAX_ENTRIES` live keys (507 past that); a bad `DEFAULT_TTL` is a 500 (`ttl-misconfigured`). Unauthenticated: every caller shares one store |

Every Worker that reads a body reads it with `@celld/core/bounds` under a cap
(16 KiB, or 64 KiB for a `ttl` value) and answers 413 above it.

```sh
buck2 test root//src/celld/core/examples/isotime/...
buck2 run root//src/celld/core/examples/isotime:durations-dev   # then curl 127.0.0.1:9876
```
