// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Hibernatable WebSocket ordering, pinned here so a release that regresses
 * it fails before an application meets it (AGENTS.md has the history).
 *
 * - #236: a frame sent from `webSocketMessage()` could arrive after a frame
 *   the object sent later from an RPC. Every frame carries a number taken at
 *   `send()` time, so the client sees send order directly.
 * - #242: a message waited for the previous message's handler to finish. A
 *   `hold` handler waits for a later `release` message on the same socket.
 */
import { DurableObject } from "cloudflare:workers";

/** How long `hold` waits for `release` before giving up. */
const HOLD_MS = 5000;

export class Sockets extends DurableObject {
  #sent = 0;
  #release = null;

  fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  #send(socket, source) {
    socket.send(JSON.stringify({ n: ++this.#sent, source }));
  }

  async webSocketMessage(socket, message) {
    switch (message) {
      case "tick":
        this.#send(socket, "message");
        break;
      case "hold": {
        const released = Promise.withResolvers();
        this.#release = released.resolve;
        socket.send("holding");
        let timer;
        const outcome = await Promise.race([
          released.promise.then(() => "released"),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("timed out"), HOLD_MS);
          }),
        ]);
        clearTimeout(timer);
        socket.send(outcome);
        break;
      }
      case "release":
        socket.send("releasing");
        this.#release?.();
        break;
    }
  }

  broadcast() {
    for (const socket of this.ctx.getWebSockets()) this.#send(socket, "rpc");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.SOCKETS.getByName(url.searchParams.get("room") ?? "room");
    if (url.pathname === "/broadcast") {
      await stub.broadcast();
      return Response.json("ok");
    }
    return await stub.fetch(request);
  },
};
