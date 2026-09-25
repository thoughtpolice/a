<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/ulid examples

Standalone Workers using `@celld/ulid`. Each runs in its own test under
`celld dev`; see [the convention](../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`mint`](mint.ts) | minting with `monotonicFactory` (never going back in time), reading an ID back |
| [`events`](events.ts) | a Durable Object event log keyed by ULIDs: time order, time ranges and cursors from the key |
| [`convert`](convert.ts) | ULIDs in a UUID-keyed store, and canonical URLs (301/308 to one spelling) |

```sh
buck2 test root//src/celld/ulid/examples/...
buck2 run root//src/celld/ulid/examples:mint-dev   # then curl 127.0.0.1:9876
```
