// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Running commands on a VM, briefly or detached.
 *
 * - `POST /vms/<vm>/run` with `{"argv": [...]}` or `{"script": "..."}` runs
 *   a command through `ssh <vm> ...` and returns its exit code and output.
 *   An argv element arrives as exactly one argument, whatever it contains; a
 *   script (any text, newlines included) travels base64-encoded, so it
 *   crosses the lobby's parser and the VM's shell intact. A non-zero exit
 *   is a result, not an error.
 * - `POST /vms/<vm>/jobs` with `{"id", "script"}` starts the script with
 *   `startDetached` (`setsid nohup ... &`), past the 30 second request
 *   limit, with its exit status written to a file when it ends.
 * - `GET /vms/<vm>/jobs/<id>` reads that file and the job's log.
 *
 * The routes are `@celld/router`'s: the VM name, job id and body are checked
 * by sieve schemas before a handler runs, so `/vms/Not A Name/run` is a
 * 400 that never reaches the lobby.
 *
 * `fetch` cannot read the `X-Exe-Exit` trailer the lobby sends, so the
 * client wraps each command to print its status after a random marker and
 * strips it again (`exitSource: "marker"`).
 *
 * ```sh
 * buck2 run root//src/celld/api/exedev/examples:exec-dev
 * curl -sS localhost:9876/vms/box/run -H 'content-type: application/json' \
 *   -d '{"argv": ["uname", "-a"]}'
 * ```
 *
 * The fake lobby knows no VMs at first; create `box` through `vms` or script
 * one with `{"seedVm": {"name": "box"}}`.
 *
 * @module
 */

import { ExeClient, type ExeEnv, outcome, VmName } from "@celld/api/exedev";
import { router } from "@celld/router";
import { v } from "@celld/sieve";

const JobId = v.string().regex(/^[a-z0-9-]{1,32}$/, "must be a job id");

function jobFiles(id: string) {
  return { status: `jobs/${id}.status`, log: `jobs/${id}.log` };
}

const Run = v.object({
  argv: v.array(v.string()).optional(),
  script: v.string().optional(),
}).refine(
  (body) => (body.argv === undefined) !== (body.script === undefined),
  "give argv or script",
);

const app = router<ExeEnv>({ auth: "none" });

app.post("/vms/:vm/run", {
  params: v.object({ vm: VmName }),
  body: Run,
}, async (c) => {
  const client = ExeClient.fromEnv(c.env);
  const { argv, script } = c.body;
  const result = await outcome(
    client.runOnVm(
      c.params.vm,
      script !== undefined ? { script } : argv ?? [],
    ),
  );
  if (!result.ok) {
    const { kind, message } = result.error;
    return c.json(
      { kind, error: message },
      kind === "invalid_request" ? 400 : 502,
    );
  }
  const { exitCode, exitSource, text } = result.value;
  return c.json({ exitCode, exitSource, output: text });
});

app.post("/vms/:vm/jobs", {
  params: v.object({ vm: VmName }),
  body: v.object({ id: JobId, script: v.string() }),
}, async (c) => {
  const client = ExeClient.fromEnv(c.env);
  const { vm } = c.params;
  const files = jobFiles(c.body.id);
  await client.runOnVm(vm, ["mkdir", "-p", "jobs"]);
  const started = await outcome(
    client.startDetached(vm, { script: c.body.script }, {
      log: files.log,
      statusFile: files.status,
    }),
  );
  if (!started.ok) return c.json({ error: started.error.message }, 502);
  return c.json({ id: c.body.id, pid: started.value.pid }, 202);
});

app.get("/vms/:vm/jobs/:id", {
  params: v.object({ vm: VmName, id: JobId }),
}, async (c) => {
  const client = ExeClient.fromEnv(c.env);
  const { vm, id } = c.params;
  const files = jobFiles(id);
  const status = await client.runOnVm(vm, {
    shell: `cat ${files.status} 2>/dev/null || echo running`,
  }, { idempotent: true });
  const log = await client.runOnVm(vm, ["cat", files.log], {
    idempotent: true,
  });
  const state = status.text.trim();
  return c.json({
    id,
    done: state !== "running",
    exitCode: state === "running" ? null : Number(state),
    log: log.text,
  });
});

export default { fetch: app.fetch };
