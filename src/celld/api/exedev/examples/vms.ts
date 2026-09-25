// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A small VM API over exe.dev's control plane.
 *
 * - `GET /vms` lists the account's VMs (`ls`).
 * - `POST /vms` with `{"name", "tags"?, "comment"?}` creates one (`new`).
 * - `DELETE /vms/<name>` deletes one (`rm`).
 *
 * Routes are `@celld/web/router`'s, and bodies and path parameters are checked
 * with the library's sieve value types (`VmName`, `Word`), so a name that
 * cannot be a VM is a 400 from the router with the issue by field. Every
 * call is `POST https://exe.dev/exec` with the command line as the body;
 * `ExeClient` builds that line (each value quoted into one word, flag
 * values attached, so caller data cannot become a flag), sends the token
 * and decodes the documented JSON. Calls are paced by an
 * `@celld/sec/ratelimit` limiter over the `RateLimitShard` Durable Objects,
 * one key per SSH key, which every Worker using that key shares.
 * Failures are plain data through `outcome()`, and their `kind` picks the
 * status code: a request the client refused before sending (a comment over
 * 200 bytes) is a 400, a command the lobby ran and rejected (a taken name)
 * a 409.
 *
 * Every route drives real VMs on the account, so every route needs the
 * operator's token, `Authorization: Bearer <token>`: a random token of at
 * least 128 bits, such as `op_$(openssl rand -hex 16)`. The Worker holds
 * only its SHA-256, in the secret `OPERATOR_TOKEN_SHA256`; with that unset
 * or malformed, every request is a 401. The spec sets it in its `vars`,
 * which reach only `.dev.vars`.
 *
 * ```sh
 * buck2 run root//src/celld/api/exedev/examples:vms-dev
 * curl -sS localhost:9876/vms -H 'content-type: application/json' \
 * -H 'authorization: Bearer op_2091cb0cfd599bcfd3dfad37fb9dab3c' \
 *   -d '{"name": "web-0", "tags": ["web"]}'
 * curl -sS localhost:9876/vms -H 'authorization: Bearer op_2091cb0cfd599bcfd3dfad37fb9dab3c'
 * ```
 *
 * Add `-- --live --var EXE_API_TOKEN=exe1...` to manage real VMs.
 *
 * @module
 */

import {
  ExeClient,
  type ExeEnv,
  type ExeErrorData,
  type ExeOutcome,
  exePolicies,
  outcome,
  VmName,
  Word,
} from "@celld/api/exedev";
import { durableLimiter, type RateLimitShardApi } from "@celld/sec/ratelimit";
import {
  bearer,
  type Context,
  hashApiKey,
  router,
  timingSafeEqual,
} from "@celld/web/router";
import { v } from "@celld/sieve";

export { RateLimitShard } from "@celld/sec/ratelimit/durable";

interface Env extends ExeEnv {
  readonly RATE_LIMITS: DurableObjectNamespace<RateLimitShardApi>;
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

const STATUS: Partial<Record<ExeErrorData["kind"], number>> = {
  invalid_request: 400,
  command_failed: 409,
  not_found: 404,
  permission: 403,
};

function reply<T>(
  c: Context,
  result: ExeOutcome<T>,
  ok: (value: T) => Response,
): Response {
  if (result.ok) return ok(result.value);
  const { kind, message, detail } = result.error;
  return c.json({ kind, error: detail ?? message }, STATUS[kind] ?? 502);
}

function client(env: Env): ExeClient {
  return ExeClient.fromEnv(env, {
    limiter: durableLimiter(env.RATE_LIMITS, {
      name: "exedev",
      policies: exePolicies(),
    }),
  });
}

const NewVm = v.object({
  name: VmName,
  tags: v.array(Word).max(20).optional(),
  // The client checks the comment's documented 200-byte limit itself.
  comment: v.string().optional(),
});

const app = router<Env>({ auth: operator });

app.get(
  "/vms",
  async (c) =>
    reply(c, await outcome(client(c.env).ls()), ({ vms }) =>
      c.json({
        vms: vms.map((vm) => ({
          name: vm.vm_name,
          status: vm.status,
          url: vm.https_url ?? null,
        })),
      })),
);

app.post("/vms", { body: NewVm }, async (c) =>
  reply(
    c,
    await outcome(client(c.env).new({ ...c.body, noEmail: true })),
    (vm) => c.json({ name: vm.vm_name, url: vm.https_url ?? null }, 201),
  ));

app.delete(
  "/vms/:name",
  { params: v.object({ name: VmName }) },
  async (c) =>
    reply(c, await outcome(client(c.env).rm(c.params.name)), () => c.empty()),
);

export default { fetch: app.fetch };
