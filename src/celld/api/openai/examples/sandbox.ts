// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/sandbox` over a real container: one sandbox per
 * `x-case` header, patched with the staged `apply_patch` and analyzed with
 * `reverseEngineerFile`.
 *
 * - `PUT /files/<path>` writes the body (any bytes, up to the router's 1 MiB
 *   body limit) into the workspace;
 *   `GET /files/<path>` answers the text.
 * - `POST /patch` applies the body, a Codex `apply_patch` patch, and
 *   answers its summary; a patch that does not fit is a 422 and changes
 *   nothing.
 * - `POST /analyze/<path>?tool=strings` runs the analyzer in the container
 *   and answers GPT's reverse-engineering notes; the query is a sieve
 *   schema, so an analyzer that is not one of `DISASSEMBLERS` is the
 *   router's 400.
 *
 * The image is the pinned busybox, which has `strings` and `hexdump`.
 * Samples that are really untrusted belong in a container on the `runsc`
 * runtime; see the README's "Sandboxes".
 *
 * ```sh
 * buck2 run root//src/celld/api/openai/examples:sandbox-dev
 * curl -sS -X PUT localhost:9876/files/sample --data-binary @/bin/true
 * curl -sS -X POST 'localhost:9876/analyze/sample?tool=strings'
 * ```
 *
 * @module
 */

import { GptClient, type GptEnv, GptError } from "@celld/api/openai";
import { ApplyPatchError } from "@celld/api/openai/coding";
import {
  type Disassembler,
  DISASSEMBLERS,
  reverseEngineerFile,
  sandboxApplyPatch,
} from "@celld/api/openai/sandbox";
import { type Context, HttpError, router } from "@celld/router";
import { getSandbox, SandboxError } from "@celld/sandbox";
import { errorResponse, Sandbox } from "@celld/sandbox/durable";
import { v } from "@celld/sieve";

export class Analyzer extends Sandbox {
  override sleepAfter = "2m";
  override settings = {
    maxExecTimeout: "60s",
    maxOutputBytes: 1024 * 1024,
  };
}

interface Env extends GptEnv {
  ANALYZER: DurableObjectNamespace<Analyzer>;
}

/** One sandbox per `x-case` header, so the spec's cases do not meet. */
function sandbox(c: { readonly env: Env; readonly req: Request }) {
  return getSandbox(
    c.env.ANALYZER,
    `analyzer-${c.req.headers.get("x-case") ?? "default"}`,
  );
}

/**
 * Failures as answers: GPT's as a 502 with the kind, the sandbox's as its
 * own status, and `disassemble`'s refusals (a path outside the workspace, a
 * failed tool) as a 422. The router's own errors (a 400 query, a 413 body)
 * stay its own.
 */
function failures(error: unknown, c: Context): Response | null {
  if (error instanceof HttpError) return null;
  if (error instanceof GptError) {
    return c.json({ kind: error.kind, error: error.message }, 502);
  }
  if (SandboxError.from(error) !== null) return errorResponse(error);
  return c.json({ error: (error as Error).message }, 422);
}

const Tool = v.enum(
  Object.keys(DISASSEMBLERS) as [Disassembler, ...Disassembler[]],
);

const app = router<Env>({ auth: "none", mapError: failures });

app.put("/files/*path", async (c) => {
  const bytes = await c.readBytes();
  await sandbox(c).writeFile(c.params.path, bytes);
  return c.json({ path: c.params.path, size: bytes.byteLength }, 201);
});

app.get("/files/*path", async (c) => {
  const found = await sandbox(c).readFile(c.params.path, {
    encoding: "utf-8",
  });
  return c.text(found.content as string);
});

app.post("/patch", async (c) => {
  try {
    const applied = await sandboxApplyPatch(sandbox(c), await c.readText());
    return c.text(applied.summary);
  } catch (error) {
    if (!(error instanceof ApplyPatchError)) throw error;
    return c.json({ error: error.message }, 422);
  }
});

app.post("/analyze/*path", {
  query: v.object({ tool: Tool.default("strings") }),
  limits: { timeout: 600 },
}, async (c) => {
  const { result, disassembly } = await reverseEngineerFile(
    GptClient.fromEnv(c.env),
    sandbox(c),
    c.params.path,
    { tool: c.query.tool, effort: "medium", call: { signal: c.signal } },
  );
  return c.json({
    argv: disassembly.argv,
    truncated: disassembly.truncated,
    summary: result.summary,
    capabilities: result.capabilities,
    indicators: result.indicators.map((item) => item.value),
  });
});

export default { fetch: app.fetch };
