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
 *   limit, with its exit status written to a file when it ends. The id is
 *   claimed on the VM first with an exclusive create, so an id already
 *   used (finished or still running, or two starts racing) is a 409
 *   `job_exists` and nothing is started over its files.
 * - `GET /vms/<vm>/jobs/<id>` reads that file and the job's log.
 *
 * The routes are `@celld/web/router`'s: the VM name, job id and body are checked
 * by sieve schemas before a handler runs, so `/vms/Not A Name/run` is a
 * 400 that never reaches the lobby.
 *
 * Every route drives real VMs on the account, so every route needs the
 * operator's token, `Authorization: Bearer <token>`: a random token of at
 * least 128 bits, such as `op_$(openssl rand -hex 16)`. The Worker holds
 * only its SHA-256, in the secret `OPERATOR_TOKEN_SHA256`; with that unset
 * or malformed, every request is a 401. The spec sets it in its `vars`,
 * which reach only `.dev.vars`.
 *
 * `fetch` cannot read the `X-Exe-Exit` trailer the lobby sends, so the
 * client wraps each command to print its status after a random marker and
 * strips it again (`exitSource: "marker"`). That keeps ordinary output from
 * faking a status; a hostile command can still forge its own.
 *
 * ```sh
 * buck2 run root//src/celld/api/exedev/examples:exec-dev
 * curl -sS localhost:9876/vms/box/run -H 'content-type: application/json' \
 * -H 'authorization: Bearer op_2091cb0cfd599bcfd3dfad37fb9dab3c' \
 *   -d '{"argv": ["uname", "-a"]}'
 * ```
 *
 * The fake lobby knows no VMs at first; create `box` through `vms` or script
 * one with `{"seedVm": {"name": "box"}}`.
 *
 * @module
 */

import { ExeClient, type ExeEnv, outcome, VmName } from "@celld/api/exedev";
import { bearer, hashApiKey, router, timingSafeEqual } from "@celld/web/router";
import { v } from "@celld/sieve";

interface Env extends ExeEnv {
  /** Hex SHA-256 of the operator token. A secret; unset, every request is a 401. */
  readonly OPERATOR_TOKEN_SHA256?: string;
}

/** Whether `token` hashes to the configured operator hash. Fails closed. */
async function isOperator(env: Env, token: string): Promise<boolean> {
  const want = env.OPERATOR_TOKEN_SHA256?.trim().toLowerCase();
  if (want === undefined || !/^[0-9a-f]{64}$/.test(want)) return false;
  return timingSafeEqual(await hashApiKey(token), want);
}

const operator = bearer({
  realm: "exedev",
  verify: async ({ token, context }) =>
    await isOperator(context.env, token) ? { subject: "operator" } : null,
});

const JobId = v.string().regex(/^[a-z0-9-]{1,32}$/, "must be a job id");

function jobFiles(id: string) {
  return {
    claim: `jobs/${id}.claim`,
    status: `jobs/${id}.status`,
    log: `jobs/${id}.log`,
  };
}

const Run = v.object({
  argv: v.array(v.string()).optional(),
  script: v.string().optional(),
}).refine(
  (body) => (body.argv === undefined) !== (body.script === undefined),
  "give argv or script",
);

const app = router<Env>({ auth: operator });

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
  const made = await outcome(client.runOnVm(vm, ["mkdir", "-p", "jobs"]));
  if (!made.ok) return c.json({ error: made.error.message }, 502);
  if (made.value.exitCode !== 0) {
    return c.json({ error: "cannot make the jobs directory" }, 502);
  }
  // Claim the id on the VM before starting anything: `set -C` makes the
  // redirection create the file exclusively (O_EXCL), so of two starts for
  // one id exactly one gets it, and a used id is never started again over
  // its old status file.
  const claimed = await outcome(client.runOnVm(vm, {
    shell:
      `if (set -C; : > ${files.claim}) 2>/dev/null; then echo claimed; elif [ -e ${files.claim} ]; then echo taken; else exit 1; fi`,
  }));
  if (!claimed.ok) return c.json({ error: claimed.error.message }, 502);
  const answer = claimed.value.text.trim();
  if (answer === "taken") return c.json({ error: "job_exists" }, 409);
  if (claimed.value.exitCode !== 0 || answer !== "claimed") {
    return c.json({ error: "cannot claim the job id" }, 502);
  }
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
  // The status file is text on the VM: only a plain exit status counts,
  // so an empty or garbled file is no exit code rather than exit 0.
  return c.json({
    id,
    done: state !== "running",
    exitCode: /^\d{1,3}$/.test(state) ? Number(state) : null,
    log: log.text,
  });
});

export default { fetch: app.fetch };
