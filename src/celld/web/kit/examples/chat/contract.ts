// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { v } from "@celld/sieve";
import { defineRoute } from "@celld/web/router/client";
import type { Message, PresenceEntry } from "@celld/web/realtime";

export interface Channel {
  name: string;
  topic: string;
}
export interface Viewer {
  id: string;
  nickname: string;
}
export interface ChatMessage {
  seq: number;
  at: number;
  from: Viewer | null;
  text: string;
}
export interface Member extends Viewer {
  typing: boolean;
}
export interface PageData {
  channel: Channel;
  channels: Channel[];
  messages: ChatMessage[];
  members: Member[];
  viewer: Viewer | null;
  csrf: string;
}

/** Every joined channel owns a browser socket, so the workspace is bounded. */
export const MAX_CHANNELS = 32;
export const ChannelNameSchema = v.string().trim().min(1).max(32).regex(
  /^[a-z0-9][a-z0-9-]*$/,
  "Use lowercase letters, numbers and hyphens.",
);
export const NicknameSchema = v.string().trim().min(2).max(24).regex(
  /^[A-Za-z0-9_\-]+$/,
  "Use letters, numbers, underscores and hyphens.",
);
export const TextSchema = v.string().trim().min(1).max(2000);
export const MessageBodySchema = v.object({ text: TextSchema });
const ViewerSchema = v.object({ id: v.string(), nickname: v.string() });
const ChannelSchema = v.object({
  name: ChannelNameSchema,
  topic: v.string().max(160),
});
export const ChatMessageSchema = v.object({
  seq: v.number().int().min(1),
  at: v.number(),
  from: ViewerSchema.nullable(),
  text: TextSchema,
});
export const PageSchema = v.object({
  channel: ChannelSchema,
  channels: v.array(ChannelSchema).max(MAX_CHANNELS),
  messages: v.array(ChatMessageSchema).max(200),
  members: v.array(
    v.object({ id: v.string(), nickname: v.string(), typing: v.boolean() }),
  ).max(1000),
  viewer: ViewerSchema.nullable(),
  csrf: v.string(),
});

const params = v.object({ channel: ChannelNameSchema });
export const HomeRoute = defineRoute("GET", "/", { response: PageSchema });
export const ChannelRoute = defineRoute("GET", "/channels/:channel", {
  params,
  response: PageSchema,
});
export const EnterRoute = defineRoute("POST", "/session", {
  bodyType: "form",
  body: v.object({ nickname: NicknameSchema, channel: ChannelNameSchema }),
  response: PageSchema,
});
export const LeaveRoute = defineRoute("POST", "/session/leave", {
  bodyType: "form",
  body: v.object({ channel: ChannelNameSchema }),
  response: PageSchema,
});
export const CreateChannelRoute = defineRoute("POST", "/channels", {
  bodyType: "form",
  body: v.object({
    name: ChannelNameSchema,
    topic: v.string().trim().max(160),
  }),
  response: PageSchema,
});
export const SendRoute = defineRoute("POST", "/channels/:channel/messages", {
  params,
  bodyType: "form",
  body: v.object({ text: TextSchema }),
  response: PageSchema,
});
export const routes = {
  home: HomeRoute,
  channel: ChannelRoute,
  enter: EnterRoute,
  leave: LeaveRoute,
  create: CreateChannelRoute,
  send: SendRoute,
};

/** One public projection for SSR history and live room frames. */
export function chatMessage(message: Message): ChatMessage {
  const body = MessageBodySchema.parse(message.data);
  return ChatMessageSchema.parse({
    seq: message.seq,
    at: message.at,
    from: message.from,
    text: body.text,
  });
}

/** Presence is per socket; the member list groups tabs by stable identity. */
export function roomMembers(
  entries: readonly PresenceEntry[],
  now = Date.now(),
): Member[] {
  const members = new Map<string, Member>();
  for (const entry of entries) {
    const nickname = entry.identity.nickname;
    if (typeof nickname !== "string") continue;
    const state = entry.state;
    const typingUntil =
      typeof state === "object" && state !== null && "typingUntil" in state
        ? state.typingUntil
        : undefined;
    const typing = typeof typingUntil === "number" && typingUntil > now &&
      typingUntil <= now + 10_000;
    const previous = members.get(entry.identity.id);
    members.set(entry.identity.id, {
      id: entry.identity.id,
      nickname,
      typing: typing || previous?.typing === true,
    });
  }
  return [...members.values()].sort((a, b) =>
    a.nickname.localeCompare(b.nickname) || a.id.localeCompare(b.id)
  );
}
