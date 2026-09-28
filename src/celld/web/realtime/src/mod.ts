// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Realtime rooms for celld: WebSocket channels with ordered, replayable
 * messages and presence, one hibernating Durable Object per room, and a
 * client that reconnects and resumes.
 *
 * | Import | What it has |
 * | --- | --- |
 * | `@celld/web/realtime` | the protocol's types, `RoomCore`, `RoomOptions` |
 * | `@celld/web/realtime/durable` | `RealtimeRoom`, the Durable Object |
 * | `@celld/web/realtime/router` | `connectRoom`, for a route's handler |
 * | `@celld/web/realtime/client` | `RoomClient`, for browsers and Deno |
 * | `@celld/web/realtime/testing` | `memoryRoom` |
 *
 * @module
 */

export {
  checkGrants,
  checkIdentity,
  type ClientFrame,
  CONNECT_HEADER,
  granted,
  type Grants,
  type Identity,
  isChannel,
  isRoomName,
  type Json,
  MAX_IDENTITY_BYTES,
  type Message,
  parseClientFrame,
  PING,
  PONG,
  type PresenceEntry,
  type PublishResult,
  type RoomApi,
  type RoomErrorCode,
  type ServerFrame,
} from "./protocol.ts";
export {
  type Connection,
  type Draft,
  type ResolvedRoomOptions,
  resolveRoomOptions,
  RoomCore,
  type RoomHost,
  type RoomOptions,
  RoomRefusal,
} from "./room.ts";
