<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/web/realtime examples

Standalone Workers using `@celld/web/realtime`; see [the convention](../../../examples/README.md).
The harness drives HTTP only, so each example's WebSocket side is a runtime
test of its own: `RoomClient`s against the packaged project under
`celld dev` ([`dev_server.ts`](dev_server.ts) starts it as the harness
does), on loopback.

| Example | What it shows |
| --- | --- |
| [`chat`](chat.ts) | chat rooms over a `ChatRoom` that checks each message: members chat and appear in presence, viewers only read, admins announce from the server and remove members (code 4000, not reconnected to), history for a first render, the `Origin` check against cross-site sockets, a restart the clients resume across without a gap, and in-order delivery although celld shuffles a room's frames. [`chat.json`](chat.json) is the HTTP spec; [`chat_runtime_test.ts`](chat_runtime_test.ts) the WebSocket one |

The API keys the example accepts (`API_KEYS`) live only in its spec's
`vars`, which the harness (and the runtime test) write to `.dev.vars` for
`celld dev`. They are public: never deploy them. A deployment sets its own
with `celld secret put`.

## Browser chat application

[`Switchboard`](../../kit/examples/chat/) combines the room API with the web
kit, router guest sessions/CSRF, Worker SSR, a hydrated Svelte UI and shared
theme-driven controls. It adds persistent public channel creation, typing
expiry, unread counts, draft preservation, history search and native HTML
forms. See the [kit example guide](../../kit/README.md#switchboard-live-channel-chat)
for its guest-security limits and development-only secret.

```sh
buck2 run root//src/celld/web/kit/examples/chat:switchboard-dev
buck2 test root//src/celld/web/kit/examples/chat/...
```

Its runtime scenarios use the same private-project `DevServer` helper,
exported for checked first-party tests as `@celld/examples/dev-server`.
