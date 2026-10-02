// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import {
  ChannelNameSchema,
  ChannelRoute,
  chatMessage,
  CreateChannelRoute,
  EnterRoute,
  HomeRoute,
  LeaveRoute,
  roomMembers,
  SendRoute,
} from "@celld/web/switchboard/contracts";
import type {
  Channel,
  PageData,
  Viewer,
} from "@celld/web/switchboard/contracts";
import Page from "@celld/web/switchboard/views";
import type { ChannelDirectory } from "./rooms.ts";
import type { RoomApi } from "@celld/web/realtime";
import { connectRoom } from "@celld/web/realtime/router";
import { respondPage } from "@celld/web/kit/server";
import { csrfToken, HttpError, router, session } from "@celld/web/router";
import type { Context, Principal, SessionScheme } from "@celld/web/router";
import { v } from "@celld/sieve";

export interface Env {
  readonly ASSETS: Fetcher;
  readonly ROOMS: DurableObjectNamespace<RoomApi>;
  readonly DIRECTORY: DurableObjectNamespace<ChannelDirectory>;
  readonly SESSION_SECRET?: string;
  readonly PUBLIC_ORIGIN?: string;
}

export interface ChatServer {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

// Covers 200 maximally escaped 2k messages, 1000 members and 32 channels.
const pageOptions = {
  scripts: ["/app.js"],
  styles: ["/app.css"],
  snapshotLimits: { maxItems: 16384, maxBytes: 4 * 1024 * 1024 },
};
const mutationOptions = { limits: { body: 32768 } };

function viewer(principal: Principal | null): Viewer | null {
  if (principal === null) return null;
  const nickname = principal.claims.nickname;
  if (typeof nickname !== "string") {
    throw new HttpError(401, "Enter a guest nickname.");
  }
  return { id: principal.subject, nickname };
}

async function channel(env: Env, name: string): Promise<Channel> {
  const result = await env.DIRECTORY.getByName("channels").lookup(name);
  if (result === null) {
    throw new HttpError(404, "This channel does not exist.", {
      code: "not_found",
    });
  }
  return result;
}

async function snapshot(
  c: Context,
  env: Env,
  selected: Channel,
  currentViewer: Viewer | null,
): Promise<PageData> {
  const room = env.ROOMS.getByName(selected.name);
  const [channels, history, presence] = await Promise.all([
    env.DIRECTORY.getByName("channels").list(),
    room.history({ channel: "chat", limit: 200 }),
    room.presence(),
  ]);
  const members = roomMembers(presence);
  // Typing is ephemeral live presence, not a sticky SSR snapshot boolean.
  for (const member of members) member.typing = false;
  return {
    channel: selected,
    channels,
    messages: history.messages.map(chatMessage),
    members,
    viewer: currentViewer,
    csrf: csrfToken(c),
  };
}

async function disconnectGuest(
  env: Env,
  id: string,
  reason: string,
): Promise<void> {
  const channels = await env.DIRECTORY.getByName("channels").list();
  await Promise.all(
    channels.map((entry) =>
      env.ROOMS.getByName(entry.name).disconnect({ identity: id, reason })
    ),
  );
}

/** Cookie security and loopback-only HTTP exceptions remain router-owned. */
export function buildServer(env: Env): ChatServer {
  const secret = env.SESSION_SECRET;
  if (secret === undefined || new TextEncoder().encode(secret).length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes.");
  }
  if (
    env.PUBLIC_ORIGIN !== undefined &&
    new URL(env.PUBLIC_ORIGIN).protocol !== "https:"
  ) {
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin.");
  }
  const sessions: SessionScheme = session({
    keys: [{ id: "switchboard", secret }],
  });
  const app = router<Env>({
    auth: sessions,
    csrf: { token: true },
    publicUrl: env.PUBLIC_ORIGIN === undefined
      ? { mode: "request" }
      : { mode: "fixed", origin: env.PUBLIC_ORIGIN },
  });

  app.register(
    HomeRoute,
    { public: true },
    async (c) =>
      respondPage(
        c,
        HomeRoute,
        Page,
        await snapshot(
          c,
          c.env,
          await channel(c.env, "lobby"),
          viewer(c.principal),
        ),
        pageOptions,
      ),
  );
  app.register(
    ChannelRoute,
    { public: true },
    async (c) =>
      respondPage(
        c,
        ChannelRoute,
        Page,
        await snapshot(
          c,
          c.env,
          await channel(c.env, c.params.channel),
          viewer(c.principal),
        ),
        pageOptions,
      ),
  );

  app.register(
    EnterRoute,
    { ...mutationOptions, public: true, csrf: true },
    async (c) => {
      const selected = await channel(c.env, c.body.channel);
      const next: Viewer = {
        id: c.principal?.subject ?? crypto.randomUUID(),
        nickname: c.body.nickname,
      };
      if (c.principal !== null) {
        await disconnectGuest(
          c.env,
          next.id,
          "Nickname changed",
        );
      }
      await sessions.issue(c, {
        subject: next.id,
        claims: { nickname: next.nickname },
      });
      if (c.accepts("text/html", "application/json") === "text/html") {
        return c
          .redirect(`/channels/${selected.name}`, 303);
      }
      return respondPage(
        c,
        EnterRoute,
        Page,
        await snapshot(c, c.env, selected, next),
        pageOptions,
      );
    },
  );

  app.register(LeaveRoute, mutationOptions, async (c) => {
    const selected = await channel(c.env, c.body.channel);
    await disconnectGuest(c.env, c.principal.subject, "Signed out");
    sessions.clear(c);
    if (c.accepts("text/html", "application/json") === "text/html") {
      return c.redirect(`/channels/${selected.name}`, 303);
    }
    return respondPage(
      c,
      LeaveRoute,
      Page,
      await snapshot(c, c.env, selected, null),
      pageOptions,
    );
  });

  app.register(CreateChannelRoute, mutationOptions, async (c) => {
    const created = await c.env.DIRECTORY.getByName("channels").create(
      c.body.name,
      c.body.topic,
    );
    if (created === "exists") {
      throw new HttpError(409, "That channel already exists.", {
        code: "channel_exists",
      });
    }
    if (created === "full") {
      throw new HttpError(
        409,
        "This workspace has reached its 32-channel capacity.",
        { code: "channel_capacity" },
      );
    }
    const selected = await channel(c.env, c.body.name);
    if (c.accepts("text/html", "application/json") === "text/html") {
      return c.redirect(`/channels/${selected.name}`, 303);
    }
    return respondPage(
      c,
      CreateChannelRoute,
      Page,
      await snapshot(c, c.env, selected, viewer(c.principal)),
      pageOptions,
    );
  });

  app.register(SendRoute, mutationOptions, async (c) => {
    const selected = await channel(c.env, c.params.channel);
    const current = viewer(c.principal);
    if (current === null) throw new HttpError(401, "Enter a guest nickname.");
    const result = await c.env.ROOMS.getByName(selected.name).publish({
      channel: "chat",
      data: { text: c.body.text },
      from: { id: current.id, nickname: current.nickname },
    });
    if (!result.ok) {
      throw new HttpError(422, result.refusal, { code: "refused" });
    }
    if (c.accepts("text/html", "application/json") === "text/html") {
      return c.redirect(`/channels/${selected.name}`, 303);
    }
    return respondPage(
      c,
      SendRoute,
      Page,
      await snapshot(c, c.env, selected, current),
      pageOptions,
    );
  });

  app.get("/channels/:channel/socket", {
    params: v.object({ channel: ChannelNameSchema }),
  }, async (c) => {
    await channel(c.env, c.params.channel);
    const current = viewer(c.principal);
    if (current === null) throw new HttpError(401, "Enter a guest nickname.");
    return connectRoom(c, c.env.ROOMS, c.params.channel, {
      identity: { id: current.id, nickname: current.nickname },
      grants: { read: ["chat"], write: ["chat"], presence: true },
    });
  });

  for (const path of ["/app.js", "/app.css", "/app.js.map", "/app.css.map"]) {
    app.get(path, { public: true }, (c) => c.env.ASSETS.fetch(c.unsafeRequest));
  }
  return app;
}
