<!-- SPDX-FileCopyrightText: © 2026 Austin Seipp -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celld/web/realtime

Realtime rooms for celld over WebSockets. Each room is a Durable Object
whose sockets hibernate while idle. A room carries:

- **channels** of ordered, numbered messages;
- a **history** it keeps for replay;
- **presence**: who is in the room, with a small state each.

A **client** for browsers and Deno reconnects and resumes without missing
or repeating a message the room still keeps. The Worker decides who
connects and what they may do, through `@celld/web/router`.

```python
celld.library(
    name = "app",
    srcs = glob(["src/*.ts"]),
    deps = [
        "root//src/celld/web/realtime:realtime",
        "root//src/celld/web/router:router",
    ],
)
```

| Import | What it has |
| --- | --- |
| `@celld/web/realtime` | the protocol's types, `RoomCore`, `RoomOptions`, `RoomRefusal` |
| `@celld/web/realtime/durable` | `RealtimeRoom`, the Durable Object (the only module importing `cloudflare:workers`) |
| `@celld/web/realtime/router` | `connectRoom`, for a route's handler |
| `@celld/web/realtime/client` | `RoomClient` |
| `@celld/web/realtime/testing` | `memoryRoom`: a room over maps, with hand-driven connections and in-process sockets |

It depends on `@celld/core`, `@celld/web/router`, and `@celld/sec/ratelimit`, which
supplies each connection's frame limit.

## A quick tour

The Worker authenticates, then hands the socket to the room with an
identity and grants:

```typescript
import { type RoomApi, RoomRefusal, type Draft } from "@celld/web/realtime";
import { RealtimeRoom } from "@celld/web/realtime/durable";
import { connectRoom, principalIdentity } from "@celld/web/realtime/router";

export class ChatRoom extends RealtimeRoom {
  protected override validate(draft: Draft): void {
    if (typeof draft.data !== "string") throw new RoomRefusal("text only");
  }
}

app.get("/rooms/:room/socket", async (c) =>
  connectRoom(c, c.env.ROOMS, c.params.room, {
    identity: {
      ...await principalIdentity(c.principal),
      name: c.principal.claims.name as string,
    },
    grants: { read: ["chat", "cursor:*"], write: ["chat"], presence: true },
  }));

// The server publishes too, from any handler or Workflow:
await c.env.ROOMS.getByName("lobby").publish({ channel: "chat", data: "hello" });
```

Bind the class in the project:

```python
celld.project(..., bindings = {"ROOMS": "ChatRoom"})
```

The page connects with the client:

```typescript
import { RoomClient } from "@celld/web/realtime/client";

const room = new RoomClient({
  url: "/rooms/lobby/socket",
  onPresence: (members) => renderMembers(members),
});
room.subscribe("chat", (message) => renderLine(message.from, message.data));
await room.publish("chat", "hi");
room.setPresence({ typing: false });
```

## Rooms

A room is the `RealtimeRoom` object named by the room (`getByName`). Its
sockets are hibernatable: an idle room holds its connections without
running, and wakes for the next frame. Pings are answered by the runtime's
auto-response, so keeping a connection alive never wakes the room. The room
keeps everything a wake needs in SQLite:

- each connection's identity, grants, subscriptions and presence state;
- the kept messages;
- the room's sequence counter and each channel's latest message.

The socket's attachment holds only its connection id.

- **Channels** are named with 1 to 64 of `A-Z a-z 0-9 _ . : -`. A message
  gets the room's next sequence number (`seq`), and names the previous
  message of its channel (`prev`, 0 for the first). A client's publish,
  once accepted, is acknowledged with its `seq`.
- **History.** The room keeps the newest `history` messages (default 100,
  0 for none). A subscription with `after: seq` first replays that
  channel's kept messages after `seq`. When the room dropped one of that
  channel's messages after `seq`, it gets `reset` instead, so the page
  reloads the channel's state (from its own store, or from `history` over
  RPC). Dropped messages of other channels do not count: the channel's
  `prev` chain shows what it missed, so a quiet channel in a busy room
  resumes without a reset.
- **Presence** lists the connections granted it, each with a state of at
  most `maxPresenceBytes` (1 KiB). Joins, updates and leaves reach every
  connection.
- **Grants** come from the Worker: `read` and `write` hold channel names,
  prefixes ending in `*` (`cursor:*`), or `*`, and `presence` is a
  boolean. A frame outside them is refused as `forbidden`.
- **Validation.** Extend `RealtimeRoom` and override `validate(draft)` to
  check a message before it is numbered, from a client or the server.
  Throw `RoomRefusal` to refuse it. Override `roomOptions()` to change the
  limits.
- **Limits.** The defaults are:
  - 1000 connections; the 1001st is refused with 503.
  - 32 subscriptions per connection.
  - 64 KiB per frame.
  - 20 frames a second per connection, with bursts of 40, through a
    `LocalLimiter`. Every frame the room reads counts, malformed ones
    included. Pings sent exactly as `PING` are answered by the runtime
    and are not counted.

  Refusals come back as `error` frames with a code: `bad_frame`,
  `forbidden`, `rate_limited`, `too_large`, `too_many_subscriptions` or
  `invalid`.

The room's RPC methods, for the Worker (`DurableObjectNamespace<RoomApi>`):

| Method | What it does |
| --- | --- |
| `publish({ channel, data, from? })` | Publishes from the server. Returns `{ ok: true, message }`, or `{ ok: false, refusal }` when `validate` refuses. It does not throw, because an error thrown across RPC loses its class. |
| `history({ channel?, after?, limit? })` | The kept messages, for a page's first render. |
| `presence()` | Who is in the room. |
| `disconnect({ identity, reason? })` | Closes every socket of one identity with code 4000, which clients do not reconnect after. Use it for a removal or a sign-out. |

### Delivery order

A client receives a room's frames in the order the room sent them, and
`RoomClient` delivers them as they arrive. The toolchain's runtime test pins
that order on hibernatable sockets, which celld once broke ([celld
#236](https://github.com/denoland/celld/issues/236); see the toolchain's
[AGENTS.md](../../../../buck/toolchains/celld/AGENTS.md)).

Each message still names its channel's previous one (`prev`), and
`subscribed` gives the channel's latest when a subscription starts. The
room follows that chain to tell whether a resumed subscription missed
anything of its channel, and a client resumes from the last `seq` it
delivered, dropping any message it already has.

A room's `seq` numbers are all distinct, but a replay can arrive after
live messages of other channels, so `seq` orders messages only within a
channel. The frames and their fields are listed in
[`src/protocol.ts`](src/protocol.ts).

## Connecting

`connectRoom(c, namespace, room, { identity?, grants, origins? })` runs in
a route's handler, after the router has authenticated the caller:

- **The request must be a WebSocket upgrade.** Otherwise it answers 426
  with `Upgrade: websocket`.
- **Its `Origin` must be allowed.** The default allows only the app's
  public origin; `origins` lists others. Otherwise it answers 403.
  Browsers send cookies on a WebSocket opened from any site, and the CSRF
  check does not cover a `GET`, so without this check any page could open
  a socket as the visitor (cross-site WebSocket hijacking). A client
  without an `Origin` header is not a browser, so it cannot be a visitor.
- **The room name is checked.** A bad one answers 400.
- **Only the identity and grants are forwarded.** The room receives a
  fresh request with the upgrade and those two, so nothing the client sent
  reaches the room as trusted. The room accepts connections only this way,
  and nothing but the Worker can reach it.
- **The identity is what other members see.** It is a public `id` and any
  display fields, never a credential. The default,
  `principalIdentity(principal)`, is the SHA-256 of the principal's `key`
  with its `subject` shown: two schemes or issuers can each have a user
  `ada`, and a room must not take one for the other, in presence or in
  `disconnect`. An `id` of your own (a user id) must be unique across
  everything that can authenticate.

The room's 101 response goes back untouched: the router passes upgrades
through.

## The client

`new RoomClient({ url, connect?, reconnect?, pingMs?, ackTimeoutMs?,
onStatus?, onPresence?, onError?, runtime? })`:

- **URLs.** `url` may be `ws(s)://`, `http(s)://`, or a path resolved
  against the page.
- **Headers.** In Deno, `connect: (url) => new WebSocket(url, { headers })`
  sets headers (an API key, say); a browser's `WebSocket` sends cookies.
- **Reconnecting.** When the socket drops, the client reconnects after
  `minMs` (default 500), doubling up to `maxMs` (default 30,000), with
  jitter. It resubscribes each channel from the last message it delivered
  and sets its presence state again. A room closing with code 4000 or
  higher (a removal) is final.
- **Heartbeat.** A ping goes out every `pingMs` (default 25 s). Two
  unanswered pings drop the socket as dead.
- **Publishing is at most once.** A publish waiting for its `ack` when the
  socket drops is rejected (`disconnected`) rather than sent again, since
  the room may have taken it. One not yet sent waits for the next
  connection. A refusal rejects with `RoomClientError` and the room's code.
- **`subscribe`.** `subscribe(channel, handler, { after?, onReset? })`
  returns the function that unsubscribes. `after: 0` replays everything
  the room keeps. Calling a function from an earlier subscription of the
  same name, after it ended, leaves the current one alone.
- **`ready()`** resolves once the room welcomes the current (or next)
  connection. After a final close (`close()`, a removal, or a drop with
  `reconnect: false`) it rejects with `closed`.

## Testing

`memoryRoom()` from `@celld/web/realtime/testing` runs the same `RoomCore` as
the Durable Object, over maps:

- `connect(identity, grants)` gives a connection the test drives frame by
  frame.
- `socket(identity, grants)` gives an in-process socket for a real
  `RoomClient`. It opens asynchronously, and `drop()` cuts it like a
  network failure.
- `hibernate()` makes the room forget its memory, as a woken object does.

## Examples

[`examples/chat.ts`](examples/chat.ts) is a chat Worker. It has members and
viewers, server announcements, history, presence and removal. Its HTTP side
is a harness spec. Its WebSocket side is a runtime test
([`chat_runtime_test.ts`](examples/chat_runtime_test.ts)) that starts
`celld dev` on the packaged project and connects real `RoomClient`s. That
test covers:

- chat and presence;
- the room's checks;
- announcements, pings, and a cross-site socket refused at the handshake;
- a removal;
- a restart the clients reconnect across without missing a message;
- order with messages from sockets and the server interleaved.

## Tests

```sh
buck/bin/buck2 test root//src/celld/web/realtime/...
```

| Suite | What it covers |
| --- | --- |
| `protocol` | Frames, names and grants. |
| `room` | The engine over maps: delivery, grants, presence, replay and reset, limits, validation, hibernation, disconnects. |
| `client` | The client against in-process rooms and hand-written frames: reconnects and resumes, backoff, at-most-once publishing, resets, stale stops, `ready()` after a close, pings. |
| `router` | `connectRoom`'s checks. |
| `readme` | The examples on this page. |
| `examples:chat-runtime-test` | The runtime, as above. |
