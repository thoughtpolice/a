// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * Provisioning a VM as a Workflow: create it, wait for it to run, install
 * an app with a bootstrap script, and check the result.
 *
 * `POST /deploys` with `{"id", "vm", "version"}` starts a `Deploy` run
 * with that instance id; `GET /deploys/<id>` returns the run's status and
 * output. Each stage is a helper from `@celld/api/exedev/workflow` built from
 * `step.do` calls with stable names, and each is safe to repeat:
 *
 * - `provisionVm` looks the VM up before `new` and adopts one that exists;
 * - `waitForVm` polls `ls` with durable sleeps until it is running;
 * - `bootstrapVm` runs the script detached (`setsid nohup`), past the 30
 *   second request limit, polls a status file, and leaves a marker keyed by
 *   the script's hash, so the same script never runs twice on one VM one
 *   deploy after another. The marker is not an atomic claim: two deploys
 *   of one VM running at the same time (two ids, one `vm`) can both start
 *   the script, so an operator runs one deploy per VM at a time;
 * - `verifyVm` runs a read-only check.
 *
 * Deploying the same version again adopts the VM and skips the bootstrap;
 * a new version runs the new script. The deploy body is checked by a sieve
 * schema on the `@celld/web/router` route, so the Workflow only ever starts
 * with a valid VM name.
 *
 * Every route drives real VMs on the account, so every route needs the
 * operator's token, `Authorization: Bearer <token>`: a random token of at
 * least 128 bits, such as `op_$(openssl rand -hex 16)`. The Worker holds
 * only its SHA-256, in the secret `OPERATOR_TOKEN_SHA256`; with that unset
 * or malformed, every request is a 401. The spec sets it in its `vars`,
 * which reach only `.dev.vars`.
 *
 * `version` goes into the install script, so the route accepts only a plain
 * version string (letters, digits, `.`, `+`, `-`; at most 64): a version
 * holding a quote would otherwise run as shell on the VM.
 *
 * ```sh
 * buck2 run root//src/celld/api/exedev/examples:provision-dev
 * curl -sS localhost:9876/deploys -H 'content-type: application/json' \
 * -H 'authorization: Bearer op_2091cb0cfd599bcfd3dfad37fb9dab3c' \
 *   -d '{"id": "first", "vm": "app-0", "version": "1.0"}'
 * curl -sS localhost:9876/deploys/first -H 'authorization: Bearer op_2091cb0cfd599bcfd3dfad37fb9dab3c'
 * ```
 *
 * @module
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import { ExeClient, type ExeEnv, VmName } from "@celld/api/exedev";
import {
  bootstrapVm,
  provisionVm,
  verifyVm,
  waitForVm,
} from "@celld/api/exedev/workflow";
import { bearer, hashApiKey, router, timingSafeEqual } from "@celld/web/router";
import { v } from "@celld/sieve";

interface DeployParams {
  readonly vm: string;
  readonly version: string;
}

interface Env extends ExeEnv {
  readonly DEPLOY: Workflow<DeployParams, unknown>;
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

/** A version the install script can hold between single quotes. */
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

function installScript(version: string): string {
  // The route checked this already; a run started any other way is refused.
  if (!VERSION.test(version)) throw new Error("not a plain version string");
  return [
    "set -e",
    "mkdir -p app",
    `printf '%s\\n' '${version}' > app/VERSION`,
    "echo installed",
  ].join("\n");
}

/** Provisions, bootstraps and verifies one VM for one app version. */
export class Deploy extends WorkflowEntrypoint<Env, DeployParams> {
  async run(event: WorkflowEvent<DeployParams>, step: WorkflowStep) {
    const client = ExeClient.fromEnv(this.env);
    const { vm, version } = event.payload;
    const provisioned = await provisionVm(step, "provision", client, {
      name: vm,
      tags: ["app"],
      noEmail: true,
    });
    if (!provisioned.ok) throw new Error(provisioned.error.message);
    const running = await waitForVm(step, "wait", client, vm, {
      interval: "1 second",
    });
    if (!running.ok) throw new Error(running.error.message);
    const bootstrap = await bootstrapVm(
      step,
      "install",
      client,
      vm,
      installScript(version),
      { interval: "1 second" },
    );
    if (!bootstrap.ok) throw new Error(bootstrap.error.message);
    const verified = await verifyVm(step, "verify", client, vm, {
      command: ["cat", "app/VERSION"],
      contains: version,
    });
    if (!verified.ok) throw new Error(verified.error.message);
    return {
      created: provisioned.value.created,
      bootstrap: {
        exitCode: bootstrap.value.exitCode,
        skipped: bootstrap.value.skipped,
        output: bootstrap.value.output,
      },
      verified: verified.value.passed,
    };
  }
}

const app = router<Env>({ auth: operator });

const DeployId = v.string().regex(/^[\w.-]{1,64}$/, "must be a deploy id");

const Version = v.string().regex(
  VERSION,
  "must be a version: 1-64 letters, digits, `.`, `+` or `-`",
);

app.post("/deploys", {
  body: v.object({ id: DeployId, vm: VmName, version: Version }),
}, async (c) => {
  const { id, vm, version } = c.body;
  const instance = await c.env.DEPLOY.create({ id, params: { vm, version } });
  return c.json({ id: instance.id }, 202);
});

app.get(
  "/deploys/:id",
  { params: v.object({ id: DeployId }) },
  async (c) => c.json(await (await c.env.DEPLOY.get(c.params.id)).status()),
);

export default { fetch: app.fetch };
