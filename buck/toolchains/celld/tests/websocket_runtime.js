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
 * - #252: a Durable Object facet could neither accept a socket nor open one.
 *   `/facet` reaches a facet's accepted socket through its root, and
 *   `/facet-dial` has a facet open a socket to this Worker's `/echo`.
 */
import { DurableObject } from "cloudflare:workers";

/** How long `hold` waits for `release` before giving up. */
const HOLD_MS = 5000;

/** A facet of `Sockets`, started from `ctx.exports` with no binding. */
export class Facet extends DurableObject {
  fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    socket.send(`facet ${message}`);
  }

  /** Opens a socket to `url`, sends one message and returns the reply. */
  async dial(url) {
    const { webSocket } = await fetch(url, {
      headers: { Upgrade: "websocket" },
    });
    webSocket.accept();
    const reply = new Promise((resolve) =>
      webSocket.addEventListener("message", (event) => resolve(event.data), {
        once: true,
      })
    );
    webSocket.send("dialed");
    try {
      return await reply;
    } finally {
      webSocket.close(1000, "done");
    }
  }
}

export class Sockets extends DurableObject {
  #sent = 0;
  #release = null;

  #facet() {
    return this.ctx.facets.get("facet", () => ({
      class: this.ctx.exports.Facet,
    }));
  }

  fetch(request) {
    if (new URL(request.url).pathname === "/facet") {
      return this.#facet().fetch(request);
    }
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

  async facetDial(url) {
    return await this.#facet().dial(url);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/echo") {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.addEventListener("message", (event) => {
        server.send(`echo ${event.data}`);
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    const stub = env.SOCKETS.getByName(url.searchParams.get("room") ?? "room");
    if (url.pathname === "/broadcast") {
      await stub.broadcast();
      return Response.json("ok");
    }
    if (url.pathname === "/facet-dial") {
      return Response.json(await stub.facetDial(`${url.origin}/echo`));
    }
    return await stub.fetch(request);
  },
};
