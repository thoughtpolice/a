// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A code runner endpoint: each caller gets their own sandbox (one container
 * per `x-user`), and every run is a shell script with a deadline, an output
 * cap, no network, a non-root user and a clean environment.
 *
 * - `POST /run` `{"code": "...", "stdin"?: "...", "timeoutMs"?: n}` writes
 *   the code to `main.sh` and answers the `exec` result.
 *
 * ```console
 * $ buck2 run root//src/celld/sandbox/examples:runner-dev
 * $ curl -s localhost:9876/run -H 'x-user: ada' -d '{"code": "echo hi; id -u"}'
 * ```
 */

import { getSandbox, SandboxError } from "@celld/sandbox";
import { Sandbox } from "@celld/sandbox/durable";
import { v } from "@celld/sieve";

export class Runner extends Sandbox {
  override sleepAfter = "2m";
  override settings = {
    execTimeout: "5s",
    maxExecTimeout: "10s",
    maxOutputBytes: 16 * 1024,
  };
}

interface Env {
  RUNNER: DurableObjectNamespace<Runner>;
}

const RunRequest = v.strictObject({
  code: v.string().min(1).max(64 * 1024),
  stdin: v.string().max(64 * 1024).optional(),
  timeoutMs: v.int().positive().optional(),
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/run") {
      return new Response("not found", { status: 404 });
    }
    const parsed = RunRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: parsed.error.format() }, { status: 400 });
    }
    const user = request.headers.get("x-user") ?? "anonymous";
    const sandbox = getSandbox(env.RUNNER, `runner-${user}`);
    try {
      await sandbox.writeFile("main.sh", parsed.data.code);
      const result = await sandbox.exec(["sh", "main.sh"], {
        stdin: parsed.data.stdin,
        timeoutMs: parsed.data.timeoutMs,
      });
      return Response.json(result);
    } catch (error) {
      const known = SandboxError.from(error);
      if (known === null) throw error;
      return Response.json({ error: known.code, message: known.detail }, {
        status: 400,
      });
    }
  },
};
