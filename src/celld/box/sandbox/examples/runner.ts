// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A code runner endpoint for untrusted code: each authenticated caller
 * gets their own sandbox, and every run is a shell script with a deadline,
 * an output cap, no network, a non-root user and a clean environment.
 *
 * - `POST /run` `{"code": "...", "stdin"?: "...", "timeoutMs"?: n}` with
 *   `authorization: Bearer <token>` (see `auth.ts`) runs the code in a
 *   directory of its own and answers `{runId, tier, ...the exec result}`.
 *
 * **Runtime tier.** `Runner` is the production class: tier `hostile`, so
 * it refuses to run anything unless its container runs on gVisor. Declare
 * it with `"runtime": "runsc"` and install runsc on every node:
 *
 * ```python
 * containers = [{"class_name": "Runner", "image": "container/Dockerfile", "runtime": "runsc"}],
 * ```
 *
 * `UnsafeTrustedRunner` is the same on the `trusted` tier, which does not
 * contain hostile code (it shares the host kernel under runc). The Worker
 * uses it only when the variable `UNSAFE_RUNNER_ON_RUNC` is `"1"`, which
 * only the development spec's `vars` (`runner.json`) set to deliberately
 * exercise runc; every answer then says `"tier": "trusted (unsafe)"`.
 * Never set it where the code is not your own. Without it (the
 * `runner-hostile` spec, and any deployment) a run on runc is refused with
 * a 503.
 *
 * A run writes its code to `runs/<runId>/main.sh` and runs it there, in one
 * exec, so two concurrent runs of a caller never share a file. The Worker
 * then removes the directory with a second call, whether the run finished,
 * was killed at its deadline or failed; a removal that fails is logged.
 * Each caller may run 2 commands at once (the sandbox's `maxProcesses`);
 * more is a 429. Errors are opaque: a short code, never the sandbox's own
 * message.
 *
 * ```console
 * $ buck2 run root//src/celld/box/sandbox/examples:runner-dev
 * # The local fixture explicitly enables UNSAFE_DEMO_AUTH for this legacy token.
 * $ curl -s localhost:9876/run -H 'authorization: Bearer ada.8UExLMxXeQkdoI_XpTgwAVFGn2_14yFRHhJ22IH2n2w' \
 *     -d '{"code": "echo hi; id -u"}'
 * ```
 */

import { readTextBounded } from "@celld/core/bounds";
import {
  getSandbox,
  SandboxError,
  type SandboxSettings,
} from "@celld/box/sandbox";
import { Sandbox } from "@celld/box/sandbox/durable";
import { v } from "@celld/sieve";
import { authenticate, unauthorized } from "./auth.ts";

const SETTINGS: Omit<SandboxSettings, "tier"> = {
  execTimeout: "5s",
  maxExecTimeout: "10s",
  maxOutputBytes: 16 * 1024,
  maxProcesses: 2,
  maxSessions: 1,
  maxOpenTickets: 1,
};

/** Production: refuses to run unless the container runs on gVisor. */
export class Runner extends Sandbox {
  override sleepAfter = "2m";
  override settings: SandboxSettings = { ...SETTINGS, tier: "hostile" };
}

/** UNSAFE for untrusted code: the trusted tier, on any runtime. */
export class UnsafeTrustedRunner extends Sandbox {
  override sleepAfter = "2m";
  override settings: SandboxSettings = { ...SETTINGS, tier: "trusted" };
}

interface Env {
  RUNNER: DurableObjectNamespace<Runner>;
  UNSAFE_TRUSTED_RUNNER?: DurableObjectNamespace<UnsafeTrustedRunner>;
  AUTH_SECRET: string;
  UNSAFE_RUNNER_ON_RUNC?: string;
  UNSAFE_DEMO_AUTH?: string;
}

const RunRequest = v.strictObject({
  code: v.string().min(1).max(64 * 1024),
  stdin: v.string().max(64 * 1024).optional(),
  timeoutMs: v.int().positive().max(60_000).optional(),
});

// Makes the run's directory, writes the code and runs it, in one command:
// `$1` is the directory, `$2` the code. The directory is removed by the
// Worker afterwards, since a killed run never reaches a cleanup of its own.
const RUN = `d=$1
mkdir -p "$d" && cd "$d" || exit 125
printf '%s' "$2" > main.sh || exit 125
exec sh main.sh`;

function refuse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/run") {
      return refuse(404, "not_found");
    }
    const caller = await authenticate(
      request,
      env.AUTH_SECRET,
      env.UNSAFE_DEMO_AUTH === "1",
    );
    if (caller === null) return unauthorized();
    let body: unknown;
    try {
      body = JSON.parse(await readTextBounded(request, { maxBytes: 160_000 }));
    } catch {
      return refuse(400, "bad_request");
    }
    const parsed = RunRequest.safeParse(body);
    if (!parsed.success) {
      return Response.json({
        error: "bad_request",
        fields: parsed.error.format(),
      }, {
        status: 400,
      });
    }
    const unsafe = env.UNSAFE_RUNNER_ON_RUNC === "1" &&
      env.UNSAFE_TRUSTED_RUNNER !== undefined;
    const sandbox = getSandbox(
      (unsafe
        ? env.UNSAFE_TRUSTED_RUNNER!
        : env.RUNNER) as DurableObjectNamespace<
          Sandbox
        >,
      caller.tenant,
    );
    const runId = crypto.randomUUID();
    const dir = `runs/${runId}`;
    try {
      const result = await sandbox.exec(
        ["sh", "-c", RUN, "run", dir, parsed.data.code],
        { stdin: parsed.data.stdin, timeoutMs: parsed.data.timeoutMs },
      );
      return Response.json({
        runId,
        tier: unsafe ? "trusted (unsafe)" : "hostile",
        ...result,
      });
    } catch (error) {
      const known = SandboxError.from(error);
      // The details stay in the log; the caller gets a code.
      console.error("run failed:", known?.code ?? "internal");
      if (known?.code === "too_many_processes") return refuse(429, "busy");
      if (known?.code === "invalid" || known?.code === "too_large") {
        return refuse(400, "bad_request");
      }
      if (known !== null) return refuse(503, "unavailable");
      return refuse(500, "internal");
    } finally {
      try {
        await sandbox.remove(dir, { recursive: true });
      } catch (error) {
        if (SandboxError.from(error)?.code !== "not_found") {
          console.error(
            "run cleanup failed:",
            runId,
            SandboxError.from(error)?.code ?? "internal",
          );
        }
      }
    }
  },
};
