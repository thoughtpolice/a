// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

import { buildServer } from "@celld/web/switchboard/server";
import type { ChatServer, Env } from "@celld/web/switchboard/server";
export {
  ChannelDirectory,
  ChatRoom,
} from "@celld/web/switchboard/server/rooms";

let app: ChatServer | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      app ??= buildServer(env);
      return app.fetch(request, env, ctx);
    } catch (error) {
      console.error(error);
      return Promise.resolve(
        Response.json({ error: "internal_error" }, {
          status: 500,
          headers: { "cache-control": "no-store" },
        }),
      );
    }
  },
};
