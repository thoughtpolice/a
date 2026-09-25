// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Run tests in a sandbox: an authenticated caller uploads files and a test
 * command, which runs as a background process in a directory of its own;
 * the caller polls it or follows its output as server-sent events.
 *
 * Every request carries `authorization: Bearer <token>` (see `auth.ts`).
 * Each caller has their own sandbox, named by a keyed hash of the verified
 * subject, so a job id only means something in its owner's sandbox:
 * anyone else asking for it gets a 404.
 *
 * - `POST /jobs` `{"files": {path: text}, "command": [argv]}` writes the
 *   files into a new `jobs/<dir>/`, starts the command there and answers
 *   `{"job": id}`. No job ever touches another's directory.
 * - `GET /jobs/<id>` answers its status, exit code and output, with
 *   `truncated: true` when only the tail of the output was kept.
 * - `GET /jobs/<id>/events` streams its output until it exits.
 * - `DELETE /jobs/<id>` forgets a finished job and removes its directory
 *   (a running one is a 409).
 *
 * Delete jobs when done with them. The sandbox keeps a finished job's
 * record for 24 hours and at most 200 of them (`recordTtlMs`,
 * `maxFinishedRecords`); after that its id is a 404, and a directory never
 * deleted stays until the container stops (idle for `sleepAfter`, or
 * destroyed), since a container's disk does not outlive it. The Worker
 * does not sweep `jobs/` for such directories: a sweep cannot tell one
 * from the directory a concurrent `POST /jobs` has made and not yet
 * started, and would delete that job's files under it.
 *
 * A job body is at most 8 MiB (413 over it, however it is sent) and is
 * parsed under the shape's caps (64 files, 64 arguments), so an oversized
 * document is refused before anything is built from it. A caller may run 4
 * jobs at once (the sandbox's `maxProcesses`); more is a 429. Errors are
 * opaque codes. A job whose files or process fail to start leaves no
 * directory behind.
 *
 * This class runs on the `trusted` tier under runc: any token holder runs
 * any command in their own sandbox, and every caller's container shares
 * the host kernel. Isolation between callers holds only while no caller
 * attacks the runtime. Mutually untrusted callers need the `hostile` tier
 * with runsc (see `runner.ts`).
 *
 * ```console
 * $ buck2 run root//src/celld/box/sandbox/examples:jobs-dev
 * $ curl -s localhost:9876/jobs -H "authorization: Bearer $TOKEN" \
 *     -d '{"files": {"t.sh": "echo ok 1"}, "command": ["sh", "t.sh"]}'
 * $ curl -sN localhost:9876/jobs/<id>/events -H "authorization: Bearer $TOKEN"
 * ```
 */

import {
  BoundsError,
  bytes,
  parseJsonBounded,
  readTextBounded,
} from "@celld/core/bounds";
import {
  getSandbox,
  SandboxError,
  type SandboxSettings,
} from "@celld/box/sandbox";
import { Sandbox } from "@celld/box/sandbox/durable";
import { v } from "@celld/sieve";
import { authenticate, unauthorized } from "./auth.ts";

export class Ci extends Sandbox {
  override sleepAfter = "5m";
  override settings: SandboxSettings = {
    tier: "hostile",
    logPollInterval: "100ms",
    maxProcesses: 4,
    maxOpenTickets: 8,
  };
}

/** Development only; selected only with the separate unsafe binding and flag. */
export class UnsafeTrustedCi extends Ci {
  override settings: SandboxSettings = {
    tier: "trusted",
    logPollInterval: "100ms",
    maxProcesses: 4,
    maxOpenTickets: 8,
  };
}

interface Env {
  CI: DurableObjectNamespace<Ci>;
  UNSAFE_TRUSTED_CI?: DurableObjectNamespace<UnsafeTrustedCi>;
  UNSAFE_CI_ON_RUNC?: string;
  UNSAFE_DEMO_AUTH?: string;
  AUTH_SECRET: string;
}

// A relative path of plain names: no `..`, no leading `/`, no empty parts,
// so every file lands inside its job's directory.
const FilePath = v.string().min(1).max(256).refine(
  (path) =>
    path.split("/").every((part) =>
      part !== "." && part !== ".." && /^[A-Za-z0-9._ -]+$/.test(part)
    ),
  "must be a relative path of plain names, without . or .. parts",
);

const Job = v.strictObject({
  files: v.record(FilePath, v.string().max(1024 * 1024)).refine(
    (files) => Object.keys(files).length <= 64,
    "at most 64 files",
  ),
  command: v.array(v.string().max(4096)).min(1).max(64),
});

const JOB_ID = /^[0-9A-Z]{26}$/;

/** A job's whole body: its files and command, as JSON. */
const MAX_JOB_BYTES = 8 * 1024 * 1024;

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const caller = await authenticate(
      request,
      env.AUTH_SECRET,
      env.UNSAFE_DEMO_AUTH === "1",
    );
    if (caller === null) return unauthorized();
    const unsafe = env.UNSAFE_CI_ON_RUNC === "1" &&
      env.UNSAFE_TRUSTED_CI !== undefined;
    const sandbox = getSandbox(
      unsafe ? env.UNSAFE_TRUSTED_CI! : env.CI,
      caller.tenant,
    );
    if (unsafe) {
      console.warn("sandbox jobs: trusted (unsafe) development runtime");
    }
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    try {
      if (
        request.method === "POST" && parts.length === 1 && parts[0] === "jobs"
      ) {
        // Parsed under the shape's own caps (two levels, at most 64 keys
        // per object and 64 items per list), so an oversized document is
        // refused while it is parsed, before the schema sees a value.
        let body: unknown;
        try {
          body = parseJsonBounded(
            await readTextBounded(request, { maxBytes: bytes(MAX_JOB_BYTES) }),
            { maxDepth: 3, maxKeys: 64, maxItems: 64 },
          );
        } catch (error) {
          if (error instanceof BoundsError && error.code === "too_large") {
            return refuse(413, "too_large");
          }
          return refuse(400, "bad_request");
        }
        const parsed = Job.safeParse(body);
        if (!parsed.success) {
          return Response.json({
            error: "bad_request",
            fields: parsed.error.format(),
          }, { status: 400 });
        }
        // A fresh directory per job: nothing a running job uses is ever
        // replaced or removed by a newer one.
        const dir = `jobs/${crypto.randomUUID()}`;
        await sandbox.mkdir(dir, { recursive: true });
        let process;
        try {
          for (const [path, content] of Object.entries(parsed.data.files)) {
            await sandbox.writeFile(`${dir}/${path}`, content);
          }
          process = await sandbox.startProcess(parsed.data.command, {
            cwd: dir,
            name: dir,
            timeoutMs: 120_000,
          });
        } catch (error) {
          await sandbox.remove(dir, { recursive: true }).catch((cleanup) =>
            console.error("jobs: cleanup of", dir, "failed:", cleanup)
          );
          throw error;
        }
        return Response.json({ job: process.id }, { status: 202 });
      }
      if (parts[0] !== "jobs" || !JOB_ID.test(parts[1] ?? "")) {
        return refuse(404, "not_found");
      }
      const id = parts[1];
      if (parts.length === 2 && request.method === "GET") {
        const logs = await sandbox.getProcessLogs(id);
        return Response.json({
          status: logs.process.status,
          exitCode: logs.process.exitCode,
          stdout: logs.stdout,
          stderr: logs.stderr,
          truncated: logs.truncated,
        });
      }
      if (parts.length === 2 && request.method === "DELETE") {
        const job = await sandbox.getProcess(id);
        if (job.status === "running") return refuse(409, "running");
        // The directory goes first: while the record stays, a failed
        // removal can be retried with another DELETE.
        if (job.name?.startsWith("jobs/")) {
          try {
            await sandbox.remove(job.name, { recursive: true });
          } catch (error) {
            if (SandboxError.from(error)?.code !== "not_found") throw error;
          }
        }
        await sandbox.deleteProcess(id);
        return new Response(null, { status: 204 });
      }
      if (parts.length === 3 && parts[2] === "events") {
        return new Response(await sandbox.streamProcessLogs(id), {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          },
        });
      }
      return refuse(404, "not_found");
    } catch (error) {
      const known = SandboxError.from(error);
      console.error("jobs:", known?.code ?? "internal");
      if (known?.code === "no_such_process") return refuse(404, "not_found");
      if (known?.code === "too_many_processes") return refuse(429, "busy");
      if (
        known?.code === "invalid" || known?.code === "too_large" ||
        known?.code === "outside_workspace" || known?.code === "invalid_path"
      ) {
        return refuse(400, "bad_request");
      }
      if (known !== null) return refuse(503, "unavailable");
      return refuse(500, "internal");
    }
  },
};
