// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat rooms: a `ChatRoom` Durable Object per room, WebSockets for members,
 * and HTTP for what the server does to a room.
 *
 * - `GET /rooms/:room/socket`: a WebSocket to the room (426 without an
 *   upgrade, 403 from another site's page). Members may read and write
 *   `chat`, read `announcements`, and are in presence; viewers only read.
 * - `POST /rooms/:room/announcements` (admins): `{text}`, published by the
 *   server to `announcements`.
 * - `GET /rooms/:room/history?after=`: the messages the room keeps (the
 *   last 50), for a page's first render.
 * - `GET /rooms/:room/presence`: who is in the room.
 * - `DELETE /rooms/:room/members/:member` (admins): closes that member's
 *   sockets with code 4000, which clients do not reconnect after.
 *
 * `ChatRoom` checks every message before it is numbered: a `chat` message
 * is `{text}` of 1 to 500 characters, and only the server announces. The
 * room also limits each connection to 20 frames a second.
 *
 * Callers authenticate with `x-api-key` (the router's `apiKey`), which a
 * Deno or server client sets on its WebSocket; a browser page would use a
 * session cookie instead (see `@celld/sec/webauthn`). Any member may enter any
 * room here; an app would check the room against the principal first.
 * `API_KEYS` maps SHA-256 hashes of keys to principals with roles
 * (`member`, `viewer`, `admin`); it is a secret, set by the spec's `vars`.
 * Unset, every key is refused.
 *
 * ```sh
 * buck2 run root//src/celld/web/realtime/examples:chat-dev
 * curl -sS localhost:9876/rooms/lobby/history -H 'x-api-key: example-key-ada'
 * ```
 *
 * @module
 */

import {
  type Draft,
  isRoomName,
  type RoomApi,
  type RoomOptions,
  RoomRefusal,
} from "@celld/web/realtime";
import { RealtimeRoom } from "@celld/web/realtime/durable";
import { connectRoom } from "@celld/web/realtime/router";
import {
  apiKey,
  hashedKeys,
  HttpError,
  type PrincipalInput,
  router,
} from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env {
  readonly ROOMS: DurableObjectNamespace<RoomApi>;
  /** `{"<sha256 of key>": {"subject": ..., "roles": [...]}}` */
  readonly API_KEYS?: string;
}

/** A room that keeps 50 messages and accepts only chat-shaped ones. */
export class ChatRoom extends RealtimeRoom<Env> {
  protected override roomOptions(): RoomOptions {
    return { history: 50 };
  }

  protected override validate(draft: Draft): void {
    if (draft.channel === "announcements" && draft.from !== null) {
      throw new RoomRefusal("only the server announces");
    }
    const data = draft.data as { text?: unknown } | null;
    if (
      typeof data !== "object" || data === null || Array.isArray(data) ||
      Object.keys(data).length !== 1 || typeof data.text !== "string" ||
      data.text.length < 1 || data.text.length > 500
    ) {
      throw new RoomRefusal("a message is {text} of 1 to 500 characters");
    }
  }
}

function room(name: string) {
  if (!isRoomName(name)) {
    throw new HttpError(400, "not a room name", { code: "bad_room" });
  }
  return name;
}

function build(env: Env) {
  const table: Record<string, PrincipalInput> = env.API_KEYS === undefined
    ? {}
    : JSON.parse(env.API_KEYS);
  const app = router<Env>({ auth: apiKey({ lookup: hashedKeys(table) }) });

  app.get("/rooms/:room/socket", (c) => {
    const viewer = !c.principal.roles.includes("member");
    return connectRoom(c, c.env.ROOMS, c.params.room, {
      grants: viewer
        ? { read: ["chat", "announcements"] }
        : { read: ["chat", "announcements"], write: ["chat"], presence: true },
    });
  });

  app.post("/rooms/:room/announcements", {
    roles: ["admin"],
    limits: { body: 2048 },
    body: v.object({ text: v.string().min(1).max(500) }),
  }, async (c) => {
    const result = await c.env.ROOMS.getByName(room(c.params.room)).publish({
      channel: "announcements",
      data: { text: c.body.text },
    });
    if (!result.ok) {
      throw new HttpError(422, result.refusal, { code: "refused" });
    }
    return c.json({ seq: result.message.seq }, 201);
  });

  app.get("/rooms/:room/history", {
    query: v.object({ after: v.coerce.number().int().min(0).optional() }),
  }, async (c) =>
    c.json(
      await c.env.ROOMS.getByName(room(c.params.room)).history({
        after: c.query.after ?? 0,
      }),
    ));

  app.get("/rooms/:room/presence", async (c) =>
    c.json({
      presence: await c.env.ROOMS.getByName(room(c.params.room)).presence(),
    }));

  app.delete(
    "/rooms/:room/members/:member",
    { roles: ["admin"] },
    async (c) =>
      c.json({
        closed: await c.env.ROOMS.getByName(room(c.params.room)).disconnect({
          identity: c.params.member,
          reason: "removed",
        }),
      }),
  );

  return app;
}

let app: ReturnType<typeof build> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    app ??= build(env);
    return app.fetch(request, env, ctx);
  },
};
