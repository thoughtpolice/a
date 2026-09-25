// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `Sandbox`: a `Container` Durable Object with the sandbox API, one
 * isolated container per object id.
 *
 * ```ts
 * import { Sandbox } from "@celld/sandbox/durable";
 * import { getSandbox } from "@celld/sandbox";
 *
 * export class CodeBox extends Sandbox {
 *   override sleepAfter = "5m";
 *   override settings = { execTimeout: "20s" };
 * }
 *
 * export default {
 *   async fetch(request: Request, env: { BOX: DurableObjectNamespace<CodeBox> }) {
 *     const box = getSandbox(env.BOX, "user-42");
 *     return Response.json(await box.exec(["uname", "-a"]));
 *   },
 * };
 * ```
 *
 * The object's `fetch` serves stream tickets (see `SandboxClient`) and
 * preview requests (see `proxyToSandbox`); everything else goes to the
 * `Container` default, a proxy to `defaultPort`.
 *
 * @module
 */

import { ContainerError } from "@celld/container";
import { Container } from "@celld/container/durable";
import { PREVIEW_HEADER, STREAM_PATH } from "./client.ts";
import { SandboxCore, type SandboxSettings } from "./core.ts";
import { SandboxError } from "./errors.ts";
import type {
  ExecOptions,
  ExecResult,
  ExistsResult,
  ExposedPort,
  ExposePortOptions,
  FileStat,
  GitCheckoutOptions,
  ListFilesOptions,
  ListFilesResult,
  ProcessInfo,
  ProcessLogs,
  ProcessOptions,
  ReadFileOptions,
  ReadFileResult,
  SandboxApi,
  SessionInfo,
  SessionOptions,
  StreamRequest,
  WriteFileOptions,
} from "./types.ts";

function status(code: string): number {
  switch (code) {
    case "invalid":
    case "invalid_path":
    case "outside_workspace":
      return 400;
    case "bad_ticket":
    case "not_found":
    case "no_such_process":
    case "no_such_session":
    case "port_not_exposed":
      return 404;
    case "too_large":
      return 413;
    case "exists":
    case "is_directory":
    case "not_directory":
    case "not_regular":
    case "not_empty":
    case "not_text":
    case "too_many_processes":
      return 409;
    default:
      return 503;
  }
}

/** An error as the JSON answer of the object's `fetch`. */
export function errorResponse(error: unknown): Response {
  const known = SandboxError.from(error);
  if (known === null) throw error;
  return Response.json({ error: known.code, message: known.detail }, {
    status: status(known.code),
  });
}

/** See the module documentation. */
export class Sandbox<Env = unknown> extends Container<Env>
  implements SandboxApi {
  /** Workspace, users, limits; see `SandboxSettings` for every default. */
  settings: SandboxSettings = {};

  #core: SandboxCore | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /** The sandbox behind the RPC methods, built from the fields on first use. */
  protected get core(): SandboxCore {
    this.#core ??= new SandboxCore(
      this.controller,
      this.ctx.storage.kv,
      this.settings,
    );
    return this.#core;
  }

  exec(argv: string[], options?: ExecOptions): Promise<ExecResult> {
    return this.core.exec(argv, options);
  }

  execShell(script: string, options?: ExecOptions): Promise<ExecResult> {
    return this.core.execShell(script, options);
  }

  openStream(request: StreamRequest): Promise<string> {
    return this.core.openStream(request);
  }

  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult> {
    return this.core.readFile(path, options);
  }

  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: WriteFileOptions,
  ): Promise<void> {
    return this.core.writeFile(path, content, options);
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.core.mkdir(path, options);
  }

  deleteFile(path: string): Promise<void> {
    return this.core.deleteFile(path);
  }

  remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.core.remove(path, options);
  }

  renameFile(from: string, to: string): Promise<void> {
    return this.core.renameFile(from, to);
  }

  moveFile(from: string, to: string): Promise<void> {
    return this.core.moveFile(from, to);
  }

  exists(path: string): Promise<ExistsResult> {
    return this.core.exists(path);
  }

  stat(path: string): Promise<FileStat> {
    return this.core.stat(path);
  }

  listFiles(
    path?: string,
    options?: ListFilesOptions,
  ): Promise<ListFilesResult> {
    return this.core.listFiles(path, options);
  }

  gitCheckout(url: string, options?: GitCheckoutOptions): Promise<ExecResult> {
    return this.core.gitCheckout(url, options);
  }

  startProcess(argv: string[], options?: ProcessOptions): Promise<ProcessInfo> {
    return this.core.startProcess(argv, options);
  }

  startShellProcess(
    script: string,
    options?: ProcessOptions,
  ): Promise<ProcessInfo> {
    return this.core.startShellProcess(script, options);
  }

  listProcesses(): Promise<ProcessInfo[]> {
    return this.core.listProcesses();
  }

  getProcess(id: string): Promise<ProcessInfo> {
    return this.core.getProcess(id);
  }

  killProcess(id: string, signal?: string): Promise<ProcessInfo> {
    return this.core.killProcess(id, signal);
  }

  killAllProcesses(signal?: string): Promise<ProcessInfo[]> {
    return this.core.killAllProcesses(signal);
  }

  getProcessLogs(id: string): Promise<ProcessLogs> {
    return this.core.getProcessLogs(id);
  }

  waitForExit(
    id: string,
    options?: { timeoutMs?: number },
  ): Promise<ProcessInfo> {
    return this.core.waitForExit(id, options);
  }

  waitForLog(
    id: string,
    pattern: string,
    options?: { timeoutMs?: number; stream?: "stdout" | "stderr" | "both" },
  ): Promise<{ matched: boolean; line: string | null; process: ProcessInfo }> {
    return this.core.waitForLog(id, pattern, options);
  }

  /** Waits for a container port; `path` makes it an HTTP check. */
  override waitForPort(
    port: number,
    options?: { timeoutMs?: number; path?: string },
  ): Promise<void> {
    return this.core.waitForPort(port, options);
  }

  exposePort(port: number, options?: ExposePortOptions): Promise<ExposedPort> {
    return this.core.exposePort(port, options);
  }

  unexposePort(port: number): Promise<void> {
    return this.core.unexposePort(port);
  }

  getExposedPorts(): Promise<ExposedPort[]> {
    return this.core.getExposedPorts();
  }

  setEnvVars(
    env: Record<string, string | null>,
  ): Promise<Record<string, string>> {
    return this.core.setEnvVars(env);
  }

  createSession(options?: SessionOptions): Promise<SessionInfo> {
    return this.core.createSession(options);
  }

  deleteSession(id: string): Promise<void> {
    return this.core.deleteSession(id);
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.core.listSessions();
  }

  /** Stream tickets, preview requests, then the `Container` default. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith(STREAM_PATH)) {
        return await this.core.stream(
          url.pathname.slice(STREAM_PATH.length),
          request.body,
        );
      }
      const preview = request.headers.get(PREVIEW_HEADER);
      if (preview !== null) {
        const [port, token] = preview.split(":");
        const headers = new Headers(request.headers);
        headers.delete(PREVIEW_HEADER);
        return await this.core.previewFetch(
          Number(port),
          token ?? "",
          new Request(request, { headers }),
        );
      }
    } catch (error) {
      if (
        ContainerError.from(error) !== null || SandboxError.from(error) !== null
      ) {
        return errorResponse(error);
      }
      throw error;
    }
    return await super.fetch(request);
  }
}
