// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The fake exe.dev the exedev examples run against.
 *
 * `POST /exec` goes to `FakeExe` from `@celld/api/exedev/testing`, a stateful
 * lobby that lexes each command line, checks it against the catalog and the
 * token, and keeps VMs, tags, comments and shares between calls. A VM's
 * commands (`ssh <vm> ...`) run through a real `/bin/sh` in a directory of
 * its own under the harness's scratch directory, so scripts, marker files
 * and detached jobs behave as they would on a VM.
 *
 * Requests to any other host are an integration's: the examples reach
 * `https://<name>.int.exe.xyz` as `http://<name>.localhost:<port>`, which
 * resolves to this server, and it answers with what it received.
 *
 * `script` entries:
 *
 * - `{"seedVm": {"name": "web-0", "tags": ["web"]}}` adds a VM, as if it
 *   existed before;
 * - `{"fail": {"path": "new", "status": 504, "execute": true}}` makes the
 *   next matching command fail, after running it when `execute` is set (an
 *   answer lost on the way back);
 * - `{"vmExec": {"match": "regex", "output": "...", "exitCode": 0}}`
 *   answers matching VM commands without running them;
 * - `{"integration": {"status": 200, "body": {...}}}` queues an integration
 *   answer instead of the echo.
 *
 * It sets `EXE_BASE_URL` and `EXE_API_TOKEN` (a token it issued for every
 * command), plus `EXE_INTEGRATION_DOMAIN` and `EXE_INTEGRATION_SCHEME` for
 * the examples that call integrations.
 *
 * @module
 */

import type { JsonValue } from "@celld/api/exedev";
import {
  FakeExe,
  type FakeVm,
  type FakeVmRun,
} from "@celld/api/exedev/testing";
import { scratchDirectory, serveUpstream } from "@celld/examples/upstream";

interface Rule {
  readonly match: RegExp;
  readonly output: string;
  readonly exitCode: number;
}

interface Instruction {
  readonly seedVm?: { readonly name: string } & Partial<FakeVm>;
  readonly fail?: {
    readonly path: string;
    readonly status: number;
    readonly execute?: boolean;
    readonly times?: number;
  };
  readonly vmExec?: {
    readonly match: string;
    readonly output?: string;
    readonly exitCode?: number;
  };
  readonly integration?: { readonly status?: number; readonly body: JsonValue };
}

const scratch = scratchDirectory();
const rules: Rule[] = [];
const integrationReplies: { status?: number; body: JsonValue }[] = [];

async function shell(vm: string, command: string): Promise<FakeVmRun> {
  const rule = rules.find((candidate) => candidate.match.test(command));
  if (rule !== undefined) {
    return { output: rule.output, exitCode: rule.exitCode };
  }
  const { code, stdout } = await new Deno.Command("/bin/sh", {
    args: [
      "-c",
      'mkdir -p "$0" && cd "$0" && HOME="$0" exec /bin/sh -c "$1" 2>&1',
      `${scratch}/${vm}`,
      command,
    ],
    clearEnv: true,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    stdin: "null",
    stdout: "piped",
    stderr: "inherit",
    signal: AbortSignal.timeout(25_000),
  }).output();
  return { output: stdout, exitCode: code };
}

const fake = new FakeExe({ vmExec: shell });
const token = fake.issueAdminToken();

async function integration(request: Request, host: string): Promise<Response> {
  const reply = integrationReplies.shift();
  if (reply !== undefined) {
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }
  const url = new URL(request.url);
  return Response.json({
    integration: host.split(".")[0],
    method: request.method,
    path: url.pathname + url.search,
    body: await request.text(),
  });
}

serveUpstream({
  async fetch(request) {
    const host = request.headers.get("host") ?? "";
    if (!host.startsWith("127.0.0.1")) return await integration(request, host);
    return await fake.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    });
  },
  script(instruction) {
    const { seedVm, fail, vmExec, integration } = instruction as Instruction;
    if (seedVm !== undefined) {
      const { name, ...settings } = seedVm;
      fake.seedVm(name, settings);
    }
    if (fail !== undefined) {
      fake.failNext(fail.path, {
        status: fail.status,
        execute: fail.execute,
      }, fail.times);
    }
    if (vmExec !== undefined) {
      rules.push({
        match: new RegExp(vmExec.match),
        output: vmExec.output ?? "",
        exitCode: vmExec.exitCode ?? 0,
      });
    }
    if (integration !== undefined) integrationReplies.push(integration);
  },
  vars: (origin) => ({
    EXE_BASE_URL: origin,
    EXE_API_TOKEN: token,
    EXE_INTEGRATION_DOMAIN: `localhost:${new URL(origin).port}`,
    EXE_INTEGRATION_SCHEME: "http",
  }),
});
