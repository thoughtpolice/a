// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A small VM API over exe.dev's control plane.
 *
 * - `GET /vms` lists the account's VMs (`ls`).
 * - `POST /vms` with `{"name", "tags"?, "comment"?}` creates one (`new`).
 * - `DELETE /vms/<name>` deletes one (`rm`).
 *
 * Routes are `@celld/router`'s, and bodies and path parameters are checked
 * with the library's sieve value types (`VmName`, `Word`), so a name that
 * cannot be a VM is a 400 from the router with the issue by field. Every
 * call is `POST https://exe.dev/exec` with the command line as the body;
 * `ExeClient` builds that line (each value quoted into one word, flag
 * values attached, so caller data cannot become a flag), sends the token
 * and decodes the documented JSON. Calls are paced by one `ExeKeyLimiter`
 * Durable Object per SSH key, which every Worker using that key shares.
 * Failures are plain data through `outcome()`, and their `kind` picks the
 * status code: a request the client refused before sending (a comment over
 * 200 bytes) is a 400, a command the lobby ran and rejected (a taken name)
 * a 409.
 *
 * ```sh
 * buck2 run root//src/celld/api/exedev/examples:vms-dev
 * curl -sS localhost:9876/vms -H 'content-type: application/json' \
 *   -d '{"name": "web-0", "tags": ["web"]}'
 * curl -sS localhost:9876/vms
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
  outcome,
  VmName,
  Word,
} from "@celld/api/exedev";
import { durableLimiter, type KeyLimiterApi } from "@celld/api/exedev/limiter";
import { type Context, router } from "@celld/router";
import { v } from "@celld/sieve";

export { ExeKeyLimiter } from "@celld/api/exedev/durable";

interface Env extends ExeEnv {
  readonly EXE_LIMITER: DurableObjectNamespace<KeyLimiterApi>;
}

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
    limiter: durableLimiter(env.EXE_LIMITER, "default"),
  });
}

const NewVm = v.object({
  name: VmName,
  tags: v.array(Word).max(20).optional(),
  // The client checks the comment's documented 200-byte limit itself.
  comment: v.string().optional(),
});

const app = router<Env>({ auth: "none" });

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
