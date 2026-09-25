// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * A Worker that exercises `@celld/api/exedev` on the real celld runtime: the
 * client over real `fetch`, exe0 minting with Web Crypto, the `ExeFleet` and
 * `ExeKeyLimiter` Durable Objects, and a provisioning Workflow.
 * `tests/runtime_test.py` drives it against a fake lobby whose address each
 * request names (`?base=` or the payload), since the port is only known once
 * the test has bound it. This is a test fixture, not an example of taking a
 * base URL from a request.
 *
 * @module
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import {
  ExeClient,
  type ExeEnv,
  mintExe0,
  outcome,
  signerFromOpenSsh,
} from "@celld/api/exedev";
import {
  ExeFleet,
  type ExeFleetApi,
  type ExeFleetEnv,
} from "@celld/api/exedev/durable";
import type { FleetClient, FleetSpec } from "@celld/api/exedev/fleet";
import { durableLimiter, type KeyLimiterApi } from "@celld/api/exedev/limiter";
import {
  bootstrapVm,
  provisionVm,
  verifyVm,
  waitForVm,
} from "@celld/api/exedev/workflow";
import * as fixture from "../fixtures.ts";

export { ExeKeyLimiter } from "@celld/api/exedev/durable";

interface Env extends ExeEnv {
  FLEET: DurableObjectNamespace<ExeFleetApi & { setBase(base: string): void }>;
  EXE_LIMITER: DurableObjectNamespace<KeyLimiterApi>;
  PROVISION: Workflow<ProvisionParams, unknown>;
}

/** `ExeFleet` with the fake lobby's address stored in its own SQLite. */
export class TestFleet extends ExeFleet<ExeFleetEnv> {
  constructor(ctx: DurableObjectState, env: ExeFleetEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS test_base (id INTEGER PRIMARY KEY CHECK (id = 1), base TEXT NOT NULL)",
    ).toArray();
  }

  async setBase(base: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO test_base (id, base) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET base = excluded.base",
      base,
    ).toArray();
    await this.ctx.storage.sync();
  }

  protected override createClient(): FleetClient {
    const rows = this.ctx.storage.sql.exec<{ base: string }>(
      "SELECT base FROM test_base WHERE id = 1",
    ).toArray();
    return ExeClient.fromEnv(this.env, {
      baseUrl: rows[0]?.base,
      retry: { maxRetries: 0 },
    });
  }
}

interface ProvisionParams {
  readonly base: string;
  readonly vm: string;
}

/** Provision, wait, bootstrap (inline and detached), verify. */
export class ProvisionWorkflow
  extends WorkflowEntrypoint<Env, ProvisionParams> {
  async run(event: WorkflowEvent<ProvisionParams>, step: WorkflowStep) {
    const client = ExeClient.fromEnv(this.env, {
      baseUrl: event.payload.base,
      retry: { maxRetries: 0 },
    });
    const config = {
      retries: { limit: 2, delay: "1 second", backoff: "constant" },
      timeout: "1 minute",
    } as const;
    const vm = event.payload.vm;
    const provisioned = await provisionVm(step, "provision", client, {
      name: vm,
      tags: ["wf"],
    }, config);
    if (!provisioned.ok) return { provisioned };
    const running = await waitForVm(step, "wait", client, vm, {
      interval: "1 second",
      maxPolls: 20,
      config,
    });
    const inline = await bootstrapVm(
      step,
      "inline",
      client,
      vm,
      "mkdir -p app\necho inline > app/inline.txt\necho 'inline done'\n",
      {
        mode: "inline",
        key: "inline-v1",
        config,
      },
    );
    const detached = await bootstrapVm(
      step,
      "detached",
      client,
      vm,
      "sleep 2\necho detached > app/detached.txt\necho 'detached done'\n",
      {
        key: "detached-v1",
        interval: "1 second",
        maxPolls: 30,
        config,
      },
    );
    const verified = await verifyVm(step, "verify", client, vm, {
      command: { shell: "cat app/inline.txt app/detached.txt" },
      contains: "detached",
    }, config);
    return { provisioned, running, inline, detached, verified };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(
      body,
      (_key, value) => value instanceof Uint8Array ? Array.from(value) : value,
    ),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

async function clientScenario(base: string, env: Env): Promise<Response> {
  const client = ExeClient.fromEnv(env, {
    baseUrl: base,
    retry: { maxRetries: 0 },
  });
  const results: Record<string, unknown> = {};
  results.whoami = await outcome(client.whoami());
  results.created = await outcome(
    client.new({
      name: "rt-0",
      tags: ["rt"],
      comment: 'it\'s a "test"; $HOME',
      setupScript: "#!/bin/sh\necho hi\n",
    }),
  );
  results.duplicate = await outcome(client.new({ name: "rt-0" }));
  results.listed = await outcome(client.ls());
  results.argv = await outcome(
    client.runOnVm("rt-0", [
      "printf",
      "%s|",
      "it's $HOME",
      "a  b",
      "`id`",
      "",
      "\\n",
    ]),
  );
  results.script = await outcome(client.runOnVm("rt-0", {
    script: "#!/bin/sh\necho \"args: $1 $2\"\necho 'to stderr' >&2\nexit 3\n",
    args: ["one", "two words"],
  }));
  results.header = await outcome(
    client.runOnVm("rt-0", { shell: "echo plain; exit 4" }, { exit: "header" }),
  );
  results.detached = await outcome(
    client.startDetached("rt-0", { shell: "sleep 1; echo later > later.txt" }, {
      log: "detached.log",
      statusFile: "detached.status",
    }),
  );
  results.missing = await outcome(client.runOnVm("rt-404", ["true"]));
  results.badFlag = await outcome(client.exec("ls --bogus"));
  const stranger = new ExeClient({
    token: "exe1.wrong",
    baseUrl: base,
    retry: { maxRetries: 0 },
  });
  results.unauthorized = await outcome(stranger.ls());
  const narrow = new ExeClient({ token: "exe1.narrow", baseUrl: base });
  results.forbidden = await outcome(narrow.rm("rt-0"));
  const hanging = new ExeClient({
    token: env.EXE_API_TOKEN!,
    baseUrl: base,
    timeoutMs: 300,
    retry: { maxRetries: 1, backoffInitialMs: 10 },
  });
  const started = Date.now();
  results.timeout = await outcome(hanging.stat("rt-0"));
  results.timeoutElapsedMs = Date.now() - started;
  return json(results);
}

async function mintScenario(base: string): Promise<Response> {
  const signer = await signerFromOpenSsh(fixture.PRIVATE_KEY);
  const minted = await mintExe0({ signer, permissions: fixture.PERMISSIONS });
  const vm = await mintExe0({
    signer,
    vm: fixture.VM_NAME,
    permissions: fixture.VM_PERMISSIONS,
  });
  // A client that mints its own short-lived tokens from a private key binding.
  const client = ExeClient.fromEnv({
    EXE_SSH_PRIVATE_KEY: fixture.PRIVATE_KEY,
    EXE_TOKEN_CMDS: "whoami,ls",
    EXE_TOKEN_TTL_SECONDS: "600",
    EXE_BASE_URL: base,
  }, { retry: { maxRetries: 0 } });
  return json({
    minted,
    matches: minted === fixture.TOKEN,
    vmMatches: vm === fixture.VM_TOKEN,
    whoami: await outcome(client.whoami()),
    ls: await outcome(client.ls()),
    denied: await outcome(client.rm("anything")),
  });
}

async function limiterScenario(
  base: string,
  env: Env,
  name: string,
): Promise<Response> {
  const limiter = env.EXE_LIMITER.getByName(name);
  await limiter.configure({ requestsPerSecond: 2, burst: 1 });
  const client = ExeClient.fromEnv(env, {
    baseUrl: base,
    limiter: durableLimiter(env.EXE_LIMITER, name),
  });
  const started = Date.now();
  for (let i = 0; i < 3; i++) await client.whoami();
  return json({
    elapsedMs: Date.now() - started,
    snapshot: await limiter.snapshot(),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const base = url.searchParams.get("base") ?? "";
    const fleet = env.FLEET.getByName(
      url.searchParams.get("fleet") ?? "default",
    );
    switch (`${request.method} ${url.pathname}`) {
      case "POST /client":
        return await clientScenario(base, env);
      case "POST /mint":
        return await mintScenario(base);
      case "POST /limiter":
        return await limiterScenario(
          base,
          env,
          url.searchParams.get("name") ?? "limiter",
        );
      case "POST /fleet/configure": {
        await fleet.setBase(base);
        const body = await request.json() as {
          spec: FleetSpec;
          intervalMs?: number | null;
        };
        return json(
          await fleet.configure(body.spec, { intervalMs: body.intervalMs }),
        );
      }
      case "POST /fleet/reconcile":
        return json(await fleet.reconcile());
      case "POST /fleet/request":
        await fleet.requestReconcile();
        return json({ ok: true });
      case "GET /fleet/status":
        return json(await fleet.status());
      case "POST /workflow": {
        const body = await request.json() as { id: string; vm: string };
        const instance = await env.PROVISION.create({
          id: body.id,
          params: { base, vm: body.vm },
        });
        return json({ id: instance.id });
      }
      case "GET /workflow": {
        const instance = await env.PROVISION.get(url.searchParams.get("id")!);
        return json(await instance.status());
      }
    }
    return json({ error: "not found" }, 404);
  },
};
