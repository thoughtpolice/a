// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A Container Durable Object serving HTTP from its container, as
 * `@cloudflare/containers` does: the first request starts it and waits for
 * its port, idle sleep stops it after `sleepAfter`, and a crash is noticed
 * and restarted on the next request. The hooks record what happened.
 *
 * - `GET /` goes to the container's busybox httpd on port 8080.
 * - `GET /state` answers the lifecycle state and the hooks that ran.
 * - `POST /stop` stops it; `POST /crash` kills its main process behind the
 *   object's back.
 *
 * ```console
 * $ buck2 run root//src/celld/container/examples:web-dev
 * $ curl -s localhost:9876/
 * $ curl -s localhost:9876/state
 * ```
 */

import type { StopEvent } from "@celld/container";
import { Container, getContainer } from "@celld/container/durable";

export class Web extends Container {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "3s";
  override envVars = { GREETING: "a celld container" };
  override entrypoint = [
    "sh",
    "-c",
    'mkdir -p /tmp/www && echo "hello from $GREETING" > /tmp/www/index.html && exec httpd -f -p 8080 -h /tmp/www',
  ];

  override onStart(): void {
    this.#record("start");
  }

  override onStop(event: StopEvent): void {
    this.#record(`stop:${event.reason}`);
  }

  #record(entry: string): void {
    const log = this.ctx.storage.kv.get<string[]>("hooks") ?? [];
    log.push(entry);
    this.ctx.storage.kv.put("hooks", log);
  }

  /** The state and the hook log. */
  report(): { state: ReturnType<Container["getState"]>; hooks: string[] } {
    return {
      state: this.getState(),
      hooks: this.ctx.storage.kv.get<string[]>("hooks") ?? [],
    };
  }

  /** Kills the container's main process without telling the controller. */
  crash(): void {
    this.ctx.container!.signal(9);
  }
}

interface Env {
  WEB: DurableObjectNamespace<Web>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const web = getContainer(env.WEB, "main");
    const { pathname } = new URL(request.url);
    if (pathname === "/state") return Response.json(await web.report());
    if (request.method === "POST" && pathname === "/stop") {
      await web.stop();
      return Response.json({ stopped: true });
    }
    if (request.method === "POST" && pathname === "/crash") {
      await web.crash();
      return Response.json({ crashed: true });
    }
    return await web.fetch(request);
  },
};
