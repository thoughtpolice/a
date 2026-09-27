<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/sec/cedar examples

Standalone Workers using `@celld/sec/cedar`; see [the convention](../../../examples/README.md).
Every spec checks the denies as well as the allows, and which policies
decided.

| Example | What it shows |
| --- | --- |
| [`docs`](docs.ts) | document sharing decided in a Durable Object: a policy store and an entity store on its SQLite, sharing as template links (idempotent, revocable, surviving a restart), the document list as one SQL query filtered by the policies, admins editing policies through the API with validate-on-write (422 with Cedar's diagnostics rendered against the text; an impossible policy refused too) |
| [`gate`](gate.ts) | route authorization with policies shipped in the Worker: `cedarAuthorize` on each route, the caller's entity built from the API key's claims and roles, report entities from an in-memory loader, attribute conditions (region, level), forbids that need `mfa`, and the actions a caller may take on a report |

The API keys the examples accept (`API_KEYS`) live only in each spec's
`vars`, which the harness writes to `.dev.vars` for `celld dev`; the keys
are in the specs and the doc comments. They are public: never deploy them.
A deployment sets its own with `celld secret put`, and each Worker refuses
every key while it is unset.
