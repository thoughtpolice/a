// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Run tests in a sandbox: a job uploads files and a test command, which
 * runs as a background process; callers poll it or follow its output as
 * server-sent events.
 *
 * - `POST /jobs` `{"files": {path: text}, "command": [argv]}` replaces the
 *   `work/` tree, starts the command there and answers `{"job": id}`.
 * - `GET /jobs/<id>` answers its status, exit code and output.
 * - `GET /jobs/<id>/events` streams its output until it exits.
 *
 * ```console
 * $ buck2 run root//src/celld/sandbox/examples:jobs-dev
 * $ curl -s localhost:9876/jobs -d '{"files": {"t.sh": "echo ok 1"}, "command": ["sh", "t.sh"]}'
 * $ curl -sN localhost:9876/jobs/<id>/events
 * ```
 */

import { getSandbox, SandboxError } from "@celld/sandbox";
import { Sandbox } from "@celld/sandbox/durable";
import { v } from "@celld/sieve";

export class Ci extends Sandbox {
  override sleepAfter = "5m";
  override settings = { logPollInterval: "100ms" };
}

interface Env {
  CI: DurableObjectNamespace<Ci>;
}

const Job = v.strictObject({
  files: v.record(v.string().min(1).max(256), v.string().max(1024 * 1024)),
  command: v.array(v.string()).min(1).max(64),
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sandbox = getSandbox(env.CI, "ci");
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    try {
      if (
        request.method === "POST" && parts.length === 1 && parts[0] === "jobs"
      ) {
        const parsed = Job.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: parsed.error.format() }, {
            status: 400,
          });
        }
        if ((await sandbox.exists("work")).exists) {
          await sandbox.remove("work", { recursive: true });
        }
        for (const [path, content] of Object.entries(parsed.data.files)) {
          await sandbox.writeFile(`work/${path}`, content);
        }
        const process = await sandbox.startProcess(parsed.data.command, {
          cwd: "work",
          name: "tests",
          timeoutMs: 120_000,
        });
        return Response.json({ job: process.id }, { status: 202 });
      }
      if (parts[0] === "jobs" && parts.length === 2) {
        const logs = await sandbox.getProcessLogs(parts[1]);
        return Response.json({
          status: logs.process.status,
          exitCode: logs.process.exitCode,
          stdout: logs.stdout,
          stderr: logs.stderr,
        });
      }
      if (parts[0] === "jobs" && parts.length === 3 && parts[2] === "events") {
        return new Response(await sandbox.streamProcessLogs(parts[1]), {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          },
        });
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      const known = SandboxError.from(error);
      if (known === null) throw error;
      const status = known.code === "no_such_process" ? 404 : 400;
      return Response.json({ error: known.code, message: known.detail }, {
        status,
      });
    }
  },
};
