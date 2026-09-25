// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The real-container integration test's Worker: the sandbox client's
 * methods over JSON, so `integration.json` can drive a real busybox
 * container under `celld dev` step by step.
 *
 * - `POST /call` `{"method", "args", "sandbox"?}` answers
 *   `{"ok": true, "value"}` or `{"ok": false, "code", "message"}`. A
 *   `{"bytes64": base64}` argument becomes a `Uint8Array`, and a
 *   `Uint8Array` in a result comes back the same way.
 * - `POST /stream` `{"argv"}` answers `execStream`'s SSE as it is.
 * - `POST /logs` `{"id"}` answers `streamProcessLogs`'s SSE.
 * - `POST /upload?path=P` streams the body into a file; `GET /download?path=P`
 *   streams it back.
 *
 * ```console
 * $ buck2 run root//src/celld/sandbox:integration-dev
 * $ curl -s localhost:9876/call -d '{"method":"exec","args":[["id"]]}'
 * ```
 */

import { getSandbox, SandboxError } from "@celld/sandbox";
import { Sandbox } from "@celld/sandbox/durable";

export class TestSandbox extends Sandbox {
  override sleepAfter = "4s";
  override settings = { logPollInterval: "100ms" };
}

interface Env {
  SANDBOX: DurableObjectNamespace<TestSandbox>;
}

const METHODS = new Set([
  "exec",
  "execShell",
  "readFile",
  "writeFile",
  "mkdir",
  "deleteFile",
  "remove",
  "renameFile",
  "exists",
  "stat",
  "listFiles",
  "startProcess",
  "startShellProcess",
  "listProcesses",
  "getProcess",
  "killProcess",
  "getProcessLogs",
  "waitForExit",
  "waitForLog",
  "waitForPort",
  "exposePort",
  "setEnvVars",
  "createSession",
  "getState",
  "stop",
  "destroy",
]);

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.bytes64 === "string") {
      return Uint8Array.from(
        atob(record.bytes64),
        (char) => char.charCodeAt(0),
      );
    }
    return Object.fromEntries(
      Object.entries(record).map(([k, v]) => [k, revive(v)]),
    );
  }
  return value;
}

function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes64: base64(value) };
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map((
        [k, v],
      ) => [k, plain(v)]),
    );
  }
  return value;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(
      env.SANDBOX,
      url.searchParams.get("sandbox") ?? "it",
    );
    try {
      switch (url.pathname) {
        case "/call": {
          const { method, args = [] } = await request.json() as {
            method: string;
            args?: unknown[];
          };
          if (!METHODS.has(method)) {
            return Response.json({ ok: false, code: "unknown_method" }, {
              status: 400,
            });
          }
          const call = (sandbox as unknown as Record<
            string,
            (...a: unknown[]) => Promise<unknown>
          >)[method];
          const value = await call.apply(sandbox, revive(args) as unknown[]);
          return Response.json({ ok: true, value: plain(value) ?? null });
        }
        case "/stream": {
          const { argv } = await request.json() as { argv: string[] };
          return new Response(await sandbox.execStream(argv), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        case "/logs": {
          const { id } = await request.json() as { id: string };
          return new Response(await sandbox.streamProcessLogs(id), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        case "/upload":
          return Response.json(
            await sandbox.writeFileStream(
              url.searchParams.get("path")!,
              request.body!,
            ),
          );
        case "/download":
          return new Response(
            await sandbox.readFileStream(url.searchParams.get("path")!),
          );
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      const known = SandboxError.from(error);
      if (known === null) throw error;
      return Response.json({
        ok: false,
        code: known.code,
        message: known.detail,
      });
    }
  },
};
