<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/core/ulid examples

Standalone Workers using `@celld/core/ulid`. Each runs in its own test under
`celld dev`; see [the convention](../../../examples/README.md).

| Example | What it shows |
| --- | --- |
| [`mint`](mint.ts) | minting with a shared `monotonicFactory` (never going back in time, and refusing a caller's future time, which would move it for everyone), reading an ID back |
| [`events`](events.ts) | a Durable Object event log keyed by ULIDs: time order, time ranges and cursors from the key; an `at` more than a minute ahead is refused |
| [`convert`](convert.ts) | ULIDs in a UUID-keyed store, and canonical URLs (301/308 to one spelling) |

Every body is read under a cap with `@celld/core/bounds` (413 over it). The
examples are deliberately unauthenticated demos: any caller can mint IDs,
append to any stream and overwrite any item. A deployment authenticates
callers first; a ULID in a URL is not a credential.

```sh
buck2 test root//src/celld/core/examples/ulid/...
buck2 run root//src/celld/core/examples/ulid:mint-dev   # then curl 127.0.0.1:9876
```
