// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * {@link connectRoom}: opens a WebSocket to a room from an
 * `@celld/web/router` handler, after the router has authenticated the caller.
 *
 * ```ts
 * app.get("/rooms/:room", (c) =>
 *   connectRoom(c, c.env.ROOMS, c.params.room, {
 *     grants: { read: ["chat"], write: ["chat"], presence: true },
 *   }));
 * ```
 *
 * What it checks before the room sees anything:
 *
 * - the request is a WebSocket upgrade (`GET` with `Upgrade: websocket`),
 *   or it answers 426;
 * - its `Origin`, when there is one, is allowed (default: the app's own
 *   public origin), or it answers 403. Browsers send cookies with a
 *   WebSocket opened from any site, and the CSRF check does not cover a
 *   `GET`, so without this any page could open a socket as the visitor
 *   (cross-site WebSocket hijacking). A client without an `Origin` is not
 *   a browser, and cannot be a visitor's;
 * - the room name is a room name, or 400.
 *
 * It forwards a fresh request carrying only the upgrade and the identity
 * and grants, so nothing the client sent reaches the room as trusted.
 *
 * @module
 */

import { type Context, HttpError, type Principal } from "@celld/web/router";
import {
  checkGrants,
  checkIdentity,
  CONNECT_HEADER,
  type Grants,
  type Identity,
  isRoomName,
} from "./protocol.ts";

/** What {@link connectRoom} needs of a namespace binding. */
export interface RoomNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

/** Options for {@link connectRoom}. */
export interface ConnectOptions {
  /**
   * Who the connection is, as other members see it: a public id and
   * whatever display fields the app chooses. Default
   * {@link principalIdentity} of the principal.
   */
  readonly identity?: Identity;
  /** What it may read, write, and whether it is in presence. */
  readonly grants: Partial<Grants>;
  /**
   * The `Origin`s allowed to open it, exactly as browsers send them.
   * Default the app's public origin (`c.publicUrl.origin`) only.
   */
  readonly origins?: readonly string[];
}

/**
 * The identity {@link connectRoom} gives a principal by default. Its `id`
 * is the SHA-256 of the principal's `key` in hex, so equal subjects from
 * two schemes, issuers, tenants or clients are two identities, and nothing
 * but the subject (as `subject`) is shown to other members. Pass the same
 * `id` to the room's `disconnect`.
 */
export async function principalIdentity(
  principal: Principal,
): Promise<Identity> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(principal.key),
  );
  const id = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return { id, subject: principal.subject };
}

/**
 * Opens a WebSocket from the client to the room `room` of `namespace`, as
 * `identity` with `grants`; see the module documentation. Returns the
 * room's 101 response, which the router passes on untouched.
 */
export async function connectRoom(
  c: Context,
  namespace: RoomNamespace,
  room: string,
  options: ConnectOptions,
): Promise<Response> {
  const request = c.unsafeRequest;
  if (
    request.method !== "GET" ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  ) {
    throw new HttpError(426, "this is a WebSocket endpoint", {
      code: "upgrade_required",
      headers: { upgrade: "websocket" },
    });
  }
  const origin = request.headers.get("origin");
  const allowed = options.origins ?? [c.publicUrl.origin];
  if (origin !== null && !allowed.includes(origin)) {
    throw new HttpError(403, "this origin may not open the socket", {
      code: "forbidden_origin",
    });
  }
  if (!isRoomName(room)) {
    throw new HttpError(400, "not a room name", { code: "bad_room" });
  }
  const principal = c.principal;
  const identity = checkIdentity(
    options.identity ??
      (principal === null ? null : await principalIdentity(principal)),
  );
  const grants = checkGrants({
    read: options.grants.read ?? [],
    write: options.grants.write ?? [],
    presence: options.grants.presence ?? false,
  });
  const protocol = request.headers.get("sec-websocket-protocol");
  return await namespace.getByName(room).fetch(
    new Request("https://room.invalid/connect", {
      headers: {
        upgrade: "websocket",
        [CONNECT_HEADER]: JSON.stringify({ room, identity, grants }),
        ...(protocol === null ? {} : { "sec-websocket-protocol": protocol }),
      },
    }),
  );
}
