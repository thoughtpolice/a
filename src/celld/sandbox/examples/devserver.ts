// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A dev server behind a preview URL: a background process serves the
 * workspace on port 8080, the port is exposed, and requests to
 * `8080-<sandbox>-<token>.<PREVIEW_HOST>` reach it through
 * `proxyToSandbox`. A request without the right token gets a 404.
 *
 * - `POST /start` writes a page, starts busybox httpd (unless it runs),
 *   waits for its port and answers `{"process", "exposed"}` with the
 *   preview URL.
 * - `POST /stop` kills the server and unexposes the port.
 * - Anything on a preview host goes to the server.
 *
 * ```console
 * $ buck2 run root//src/celld/sandbox/examples:devserver-dev
 * $ curl -s -X POST localhost:9876/start
 * $ curl -s localhost:9876/ -H 'host: 8080-dev-<token>.preview.localhost'
 * ```
 */

import { getSandbox, proxyToSandbox } from "@celld/sandbox";
import { errorResponse, Sandbox } from "@celld/sandbox/durable";

export class Dev extends Sandbox {
  override sleepAfter = "15m";
}

interface Env {
  DEV: DurableObjectNamespace<Dev>;
  PREVIEW_HOST: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const preview = await proxyToSandbox(request, env.DEV, {
      hostname: env.PREVIEW_HOST,
    });
    if (preview !== null) return preview;
    const sandbox = getSandbox(env.DEV, "dev", {
      hostname: env.PREVIEW_HOST,
      protocol: "http",
    });
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "POST" && pathname === "/start") {
        const running = (await sandbox.listProcesses()).find((process) =>
          process.name === "httpd" && process.status === "running"
        );
        await sandbox.writeFile(
          "site/index.html",
          "<h1>hello from the dev server</h1>\n",
        );
        const process = running ?? await sandbox.startProcess(
          ["httpd", "-f", "-p", "8080", "-h", "site"],
          { name: "httpd" },
        );
        await sandbox.waitForPort(8080, { path: "/" });
        const exposed = await sandbox.exposePort(8080, { name: "web" });
        return Response.json({ process, exposed });
      }
      if (request.method === "POST" && pathname === "/stop") {
        await sandbox.unexposePort(8080);
        return Response.json({ processes: await sandbox.killAllProcesses() });
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },
};
