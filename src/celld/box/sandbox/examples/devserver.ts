// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A dev server behind a preview URL: a background process serves the
 * workspace on port 8080, the port is exposed, and requests to
 * `8080-<sandbox>-<token>.<PREVIEW_HOST>` reach it through
 * `proxyToSandbox`. A request without the right token gets the sandbox's
 * 404 (text `not found`); anything else unknown gets the Worker's JSON 404.
 *
 * - `POST /start` writes a page, starts busybox httpd (unless it runs),
 *   waits for its port and answers `{"process", "exposed"}` with the
 *   preview URL. The object does the check and the start (`Dev.serve`),
 *   and overlapping starts share one, so two `POST /start`s at once run
 *   one httpd and both answer it (`devserver_race-test`).
 * - `POST /stop` kills the server and unexposes the port.
 * - Anything on a preview host goes to the server.
 *
 * **Deliberately unauthenticated demo; never deploy it.** Anyone who can
 * reach this Worker can start and stop the dev server and obtain its
 * preview token from `POST /start`, and with it the preview URL. Errors
 * answer only the sandbox's code.
 *
 * Preview URLs are `https` unless `PREVIEW_PROTOCOL` says `http`
 * (`httpForDevelopment`, which needs the `*.localhost` `PREVIEW_HOST`);
 * only the spec's `vars` (`devserver.json`) set that, for the loopback test. The
 * token is a bearer capability and must not travel in cleartext.
 *
 * ```console
 * $ buck2 run root//src/celld/box/sandbox/examples:devserver-dev
 * $ curl -s -X POST localhost:9876/start
 * $ curl -s localhost:9876/ -H 'host: 8080-dev-<token>.preview.localhost'
 * ```
 */

import {
  getSandbox,
  type ProcessInfo,
  proxyToSandbox,
} from "@celld/box/sandbox";
import { errorResponse, Sandbox } from "@celld/box/sandbox/durable";
import { serveOnce } from "./httpd.ts";

export class Dev extends Sandbox {
  override settings = { tier: "trusted" as const };
  override sleepAfter = "15m";

  /** httpd on port 8080, started unless it runs; see `httpd.ts`. */
  serve(): Promise<ProcessInfo> {
    return serveOnce(this);
  }
}

interface Env {
  DEV: DurableObjectNamespace<Dev>;
  PREVIEW_HOST: string;
  /** `https` (default) or `http`, for a loopback test only. */
  PREVIEW_PROTOCOL?: string;
  UNSAFE_LOCAL_DEMO?: string;
}

// The sandbox's code and status, without its message.
async function opaque(error: unknown): Promise<Response> {
  const answer = errorResponse(error);
  const { error: code } = await answer.json() as { error: string };
  return Response.json({ error: code }, { status: answer.status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = new URL(request.url);
    if (
      env.UNSAFE_LOCAL_DEMO !== "1" ||
      !(origin.hostname === "127.0.0.1" || origin.hostname === "localhost" ||
        origin.hostname.endsWith(".localhost"))
    ) return Response.json({ error: "unsafe_demo_disabled" }, { status: 403 });
    const preview = await proxyToSandbox(request, env.DEV, {
      hostname: env.PREVIEW_HOST,
      httpForDevelopment: env.PREVIEW_PROTOCOL === "http",
      port: origin.port === "" ? undefined : Number(origin.port),
    });
    if (preview !== null) return preview;
    const sandbox = getSandbox(env.DEV, "dev", {
      hostname: env.PREVIEW_HOST,
      httpForDevelopment: env.PREVIEW_PROTOCOL === "http",
      port: origin.port === "" ? undefined : Number(origin.port),
    });
    const { pathname } = new URL(request.url);
    try {
      if (request.method === "POST" && pathname === "/start") {
        const process = await env.DEV.getByName("dev").serve();
        await sandbox.waitForPort(8080, { path: "/" });
        const exposed = await sandbox.exposePort(8080, { name: "web" });
        return Response.json({ process, exposed });
      }
      if (request.method === "POST" && pathname === "/stop") {
        await sandbox.unexposePort(8080);
        return Response.json({ processes: await sandbox.killAllProcesses() });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      return await opaque(error);
    }
  },
};
