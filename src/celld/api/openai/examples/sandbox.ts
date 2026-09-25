// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `@celld/api/openai/sandbox` over a real container: one sandbox per
 * authenticated caller, patched with the staged `apply_patch` and analyzed
 * with `reverseEngineerFile`.
 *
 * Every route needs a bearer JWT access token (HS256, `typ: at+jwt`, issuer
 * `https://auth.example.com`, audience `https://analyzer.example.com`),
 * checked with `ANALYZER_JWT_SECRET`. The sandbox is named by an HMAC of
 * the caller's principal key under `ANALYZER_CASE_KEY`, so it is chosen by
 * who the caller is, never by anything the request says, and the name does
 * not reveal the subject. The spec's values of both are for development
 * only; a deployment sets its own as secrets (at least 32 bytes each), and
 * real tokens come from its issuer.
 *
 * - `PUT /files/<path>` writes the body (any bytes, up to the router's 1 MiB
 *   body limit) into the caller's workspace, holding the workspace lease as
 *   every writer does (`sandboxWriteFile`), so an upload never lands in the
 *   middle of a patch;
 *   `GET /files/<path>` answers the text, or a 409 when the file grew past
 *   the read limit while it was being read.
 * - `POST /patch` applies the body, a Codex `apply_patch` patch, and
 *   answers its summary; a patch that does not fit is a 422 and changes
 *   nothing, and one stopped halfway (the caller went away) is a 500 that
 *   lists the files it did and did not change.
 * - `GET /search?pattern=<ERE>&dir=<path>` runs a `grep_files` regular
 *   expression in the container (`search` of `sandboxFileSystem`): regular
 *   files only, never through a symbolic link; a pattern grep refuses is a
 *   422.
 * - `POST /analyze/<path>?tool=strings` runs the analyzer in the container
 *   and answers GPT's reverse-engineering notes; the query is a sieve
 *   schema, so an analyzer that is not one of `DISASSEMBLERS` is the
 *   router's 400.
 *
 * Only typed failures say what went wrong (GPT's, the sandbox's, a
 * refused patch or path); anything else is the router's opaque 500 with a
 * request id.
 *
 * The image is the pinned busybox, which has `strings` and `hexdump`.
 *
 * **Runtime tier.** Uploaded samples are hostile input, so `Analyzer` is
 * the production class: tier `hostile`, which refuses to run anything
 * unless its container runs on gVisor. Declare it with
 * `"runtime": "runsc"` and install runsc on every node. `UnsafeTrustedAnalyzer`
 * is the same on the `trusted` tier, which does not contain hostile code
 * (under runc it shares the host kernel). The Worker uses it only when
 * `UNSAFE_ANALYZER_ON_RUNC` is `"1"`, which only `sandbox.json`'s `vars`
 * set to deliberately exercise runc in the development fixture; the JSON
 * answers then say `"tier": "trusted (unsafe)"`. Never set it where the
 * samples are not your own. See the README's "Sandboxes".
 *
 * ```sh
 * buck2 run root//src/celld/api/openai/examples:sandbox-dev
 * TOKEN=...   # an HS256 at+jwt signed with the development secret; see sandbox.json
 * curl -sS -X PUT localhost:9876/files/sample -H "authorization: Bearer $TOKEN" --data-binary @/bin/true
 * curl -sS -X POST 'localhost:9876/analyze/sample?tool=strings' -H "authorization: Bearer $TOKEN"
 * ```
 *
 * @module
 */

import { GptClient, type GptEnv, GptError } from "@celld/api/openai";
import {
  ApplyPatchError,
  normalizePath,
  PartialPatchError,
} from "@celld/api/openai/coding";
import {
  type Disassembler,
  DISASSEMBLERS,
  reverseEngineerFile,
  sandboxApplyPatch,
  sandboxFileSystem,
  sandboxWriteFile,
} from "@celld/api/openai/sandbox";
import {
  bearer,
  type Context,
  HttpError,
  jwtVerifier,
  type Principal,
  router,
  type TokenVerifier,
} from "@celld/web/router";
import {
  deriveSandboxId,
  getSandbox,
  SandboxError,
  type SandboxSettings,
} from "@celld/box/sandbox";
import { errorResponse, Sandbox } from "@celld/box/sandbox/durable";
import { v } from "@celld/sieve";

const SETTINGS: Omit<SandboxSettings, "tier"> = {
  maxExecTimeout: "60s",
  maxOutputBytes: 1024 * 1024,
};

/** Production: refuses to run unless the container runs on gVisor. */
export class Analyzer extends Sandbox {
  override sleepAfter = "2m";
  override settings: SandboxSettings = { ...SETTINGS, tier: "hostile" };
}

/** UNSAFE for untrusted samples: the trusted tier, on any runtime. */
export class UnsafeTrustedAnalyzer extends Sandbox {
  override sleepAfter = "2m";
  override settings: SandboxSettings = { ...SETTINGS, tier: "trusted" };
}

interface Env extends GptEnv {
  ANALYZER: DurableObjectNamespace<Analyzer>;
  UNSAFE_TRUSTED_ANALYZER?: DurableObjectNamespace<UnsafeTrustedAnalyzer>;
  /** `"1"` picks `UnsafeTrustedAnalyzer`; development only. */
  UNSAFE_ANALYZER_ON_RUNC?: string;
  /** The HS256 key access tokens are signed with. */
  ANALYZER_JWT_SECRET: string;
  /** The HMAC key that turns a principal into a sandbox name. */
  ANALYZER_CASE_KEY: string;
}

const encoder = new TextEncoder();

function secret(value: unknown, name: string): Uint8Array<ArrayBuffer> {
  const bytes = typeof value === "string" ? encoder.encode(value) : null;
  // Fail closed: a missing or short key is the operator's mistake, an
  // opaque 500, never an open door.
  if (bytes === null || bytes.byteLength < 32) {
    throw new Error(`${name} must be set to at least 32 bytes`);
  }
  return bytes;
}

// One verifier per signing secret, built on first use.
const verifiers = new Map<string, TokenVerifier>();

function verifierFor(env: Env): TokenVerifier {
  const raw = env.ANALYZER_JWT_SECRET;
  let verify = verifiers.get(raw);
  if (verify === undefined) {
    verify = jwtVerifier({
      keys: secret(raw, "ANALYZER_JWT_SECRET"),
      algorithms: ["HS256"],
      typ: "at+jwt",
      issuer: "https://auth.example.com",
      audience: "https://analyzer.example.com",
    });
    verifiers.set(raw, verify);
  }
  return verify;
}

const auth = bearer({
  verify: (request) => verifierFor(request.context.env as Env)(request),
  realm: "analyzer",
  bearerFormat: "JWT",
});

/** Whether this deployment opted into the unsafe trusted tier. */
function unsafeTier(env: Env): boolean {
  return env.UNSAFE_ANALYZER_ON_RUNC === "1" &&
    env.UNSAFE_TRUSTED_ANALYZER !== undefined;
}

/** The tier the caller's sandbox runs on, as the answers name it. */
function tierName(env: Env): string {
  return unsafeTier(env) ? "trusted (unsafe)" : "hostile";
}

/**
 * The caller's sandbox: `analyzer-` and the hex HMAC-SHA256 of its
 * principal key (scheme, issuer, tenant, client and subject), so two
 * callers never share one and nothing in the request can pick another's.
 */
async function sandbox(env: Env, principal: Principal | null) {
  if (principal === null) throw new HttpError(401);
  const key = await crypto.subtle.importKey(
    "raw",
    secret(env.ANALYZER_CASE_KEY, "ANALYZER_CASE_KEY"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const id = await deriveSandboxId(key, "openai-analyzer", principal.key);
  const namespace =
    (unsafeTier(env)
      ? env.UNSAFE_TRUSTED_ANALYZER!
      : env.ANALYZER) as DurableObjectNamespace<Sandbox>;
  return getSandbox(namespace, id);
}

/**
 * Typed failures as answers: GPT's as a 502 with the kind, the sandbox's
 * as its own status. The router's own errors (a 400 query, a 413 body, a
 * 422 below) stay its own, and anything else is left to the router, which
 * answers an opaque 500 with the request id.
 */
function failures(error: unknown, c: Context): Response | null {
  if (error instanceof HttpError) return null;
  if (error instanceof GptError) {
    return c.json({ kind: error.kind, error: error.message }, 502);
  }
  if (SandboxError.from(error) !== null) return errorResponse(error);
  return null;
}

/** A workspace file path, or a 422 saying why not. */
function filePath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.ok) throw new HttpError(422, normalized.message);
  if (normalized.path === "") throw new HttpError(422, "a file path is needed");
  return normalized.path;
}

const Tool = v.enum(
  Object.keys(DISASSEMBLERS) as [Disassembler, ...Disassembler[]],
);

const app = router<Env>({
  auth,
  mapError: failures,
  limits: { maxTimeout: 600 },
});

app.put("/files/*path", async (c) => {
  const bytes = await c.readBytes();
  await sandboxWriteFile(
    await sandbox(c.env, c.principal),
    c.params.path,
    bytes,
    { signal: c.signal },
  );
  return c.json({
    path: c.params.path,
    size: bytes.byteLength,
    tier: tierName(c.env),
  }, 201);
});

app.get("/files/*path", async (c) => {
  const found = await (await sandbox(c.env, c.principal)).readFile(
    c.params.path,
    {
      encoding: "utf-8",
    },
  );
  // Only part of a file that grew while it was read: say so, not a text
  // that looks whole.
  if (found.truncated) {
    return c.json({ error: "changed_during_read" }, 409);
  }
  return c.text(found.content as string);
});

app.get("/search", {
  query: v.object({
    pattern: v.string().min(1).max(256),
    dir: v.string().default(""),
  }),
}, async (c) => {
  const fs = sandboxFileSystem(await sandbox(c.env, c.principal));
  try {
    const found = await fs.search!({
      pattern: c.query.pattern,
      dir: c.query.dir,
      limit: 100,
      signal: c.signal,
    });
    return c.json(found);
  } catch (error) {
    if (SandboxError.from(error) !== null) throw error;
    // The search's own refusals: a bad pattern or directory.
    throw new HttpError(422, (error as Error).message);
  }
});

app.post("/patch", async (c) => {
  try {
    const applied = await sandboxApplyPatch(
      await sandbox(c.env, c.principal),
      await c.readText(),
      { signal: c.signal },
    );
    return c.text(applied.summary);
  } catch (error) {
    if (error instanceof PartialPatchError) {
      // Typed, so it may say which files changed before it stopped.
      return c.json({
        error: error.message,
        committed: error.committed,
        pending: error.pending,
      }, 500);
    }
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
    await sandbox(c.env, c.principal),
    filePath(c.params.path),
    { tool: c.query.tool, effort: "medium", call: { signal: c.signal } },
  );
  return c.json({
    tier: tierName(c.env),
    argv: disassembly.argv,
    truncated: disassembly.truncated,
    summary: result.summary,
    capabilities: result.capabilities,
    indicators: result.indicators.map((item) => item.value),
  });
});

export default { fetch: app.fetch };
