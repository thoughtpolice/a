// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * `Sandbox`: a `Container` Durable Object with the sandbox API, one
 * container per object id. Under runc that container shares the host
 * kernel; code that may attack it needs the `hostile` tier (gVisor), see
 * the README's "Threat tiers".
 *
 * ```ts
 * import { Sandbox } from "@celld/box/sandbox/durable";
 * import { getSandbox } from "@celld/box/sandbox";
 *
 * export class CodeBox extends Sandbox {
 *   override sleepAfter = "5m";
 *   override settings = { tier: "hostile" as const, execTimeout: "20s" };
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
 * The object's `fetch` serves two things only: preview requests (see
 * `proxyToSandbox`), whose token is checked against the exposed port, and
 * stream tickets (see `SandboxClient`) under the reserved path
 * `/.celld-sandbox/stream/`, for requests without the preview header. Everything else is a 404: it
 * never reaches a container port, whatever its headers say. A Worker that
 * forwards requests to the object therefore exposes the ports given to
 * `exposePort` to whoever holds their tokens, and stream tickets to whoever
 * holds a ticket; see the README's "Security defaults".
 *
 * @module
 */

import { ContainerError, type StartOverrides } from "@celld/box/container";
import { Container } from "@celld/box/container/durable";
import { PREVIEW_HEADER, STREAM_PATH } from "./client.ts";
import { SandboxCore, type SandboxSettings } from "./core.ts";
import { errorStatus, SandboxError } from "./errors.ts";
import type {
  ExecOptions,
  ExecResult,
  ExistsResult,
  ExposedPort,
  ExposePortOptions,
  FileStat,
  GitCheckoutOptions,
  Lease,
  LeaseOption,
  LeaseOptions,
  ListFilesOptions,
  ListFilesResult,
  ListProcessesOptions,
  NoFollowOptions,
  ProcessInfo,
  ProcessList,
  ProcessLogs,
  ProcessOptions,
  ReadFileOptions,
  ReadFileResult,
  RecursiveOptions,
  SandboxApi,
  SearchFilesOptions,
  SearchResult,
  SessionInfo,
  SessionOptions,
  SessionUpdate,
  StreamRequest,
  WaitForLogOptions,
  WriteFileOptions,
} from "./types.ts";

/** Options of {@link errorResponse}. */
export interface ErrorResponseOptions {
  /**
   * Put the error's detail in every answer, 5xx included, where it can be
   * a helper command's stderr (workspace paths, whatever the guest
   * wrote). Only for answers to the sandbox's owner.
   */
  readonly unsafeDetail?: boolean;
}

/**
 * A `SandboxError` as a JSON answer `{error: code, message}` with a status
 * for the code (anything else is rethrown). A 4xx answer's message is the
 * error's detail, which describes the caller's own request; a 5xx answer's
 * (a helper that failed or timed out, the container, the runtime) is a
 * fixed text, since its detail can be a helper's stderr, unless
 * `unsafeDetail` is set.
 */
export function errorResponse(
  error: unknown,
  options: ErrorResponseOptions = {},
): Response {
  const known = SandboxError.from(error);
  if (known === null) throw error;
  const code = errorStatus(known.code);
  const message = code < 500 || options.unsafeDetail === true
    ? known.detail
    : "the sandbox could not complete the request";
  return Response.json({ error: known.code, message }, { status: code });
}

/** See the module documentation. */
export abstract class Sandbox<Env = unknown> extends Container<Env>
  implements SandboxApi {
  /** Workspace, users, limits; see `SandboxSettings` for every default. */
  abstract settings: SandboxSettings;

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

  cancel(token: string): Promise<boolean> {
    return this.core.cancel(token);
  }

  openStream(request: StreamRequest): Promise<string> {
    return this.core.openStream(request);
  }

  cancelStream(ticket: string): Promise<boolean> {
    return this.core.cancelStream(ticket);
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

  mkdir(path: string, options?: RecursiveOptions): Promise<void> {
    return this.core.mkdir(path, options);
  }

  deleteFile(path: string, options?: LeaseOption): Promise<void> {
    return this.core.deleteFile(path, options);
  }

  remove(path: string, options?: RecursiveOptions): Promise<void> {
    return this.core.remove(path, options);
  }

  renameFile(from: string, to: string, options?: LeaseOption): Promise<void> {
    return this.core.renameFile(from, to, options);
  }

  moveFile(from: string, to: string, options?: LeaseOption): Promise<void> {
    return this.core.moveFile(from, to, options);
  }

  exists(path: string, options?: NoFollowOptions): Promise<ExistsResult> {
    return this.core.exists(path, options);
  }

  stat(path: string, options?: NoFollowOptions): Promise<FileStat> {
    return this.core.stat(path, options);
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

  searchFiles(
    pattern: string,
    options?: SearchFilesOptions,
  ): Promise<SearchResult> {
    return this.core.searchFiles(pattern, options);
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

  listProcesses(options?: ListProcessesOptions): Promise<ProcessList> {
    return this.core.listProcesses(options);
  }

  deleteProcess(id: string): Promise<void> {
    return this.core.deleteProcess(id);
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
    options?: WaitForLogOptions,
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

  rotatePort(
    port: number,
    options: { expectedToken: string; ttlMs?: number },
  ): Promise<ExposedPort> {
    return this.core.rotatePort(port, options);
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

  updateSession(id: string, patch?: SessionUpdate): Promise<SessionInfo> {
    return this.core.updateSession(id, patch);
  }

  deleteSession(id: string): Promise<void> {
    return this.core.deleteSession(id);
  }

  /**
   * Ends the sandbox: clears its stored state (environment, sessions,
   * exposed ports and their preview tokens, stream tickets, process
   * records) and destroys the container. `Container.destroy` stopped only
   * the container; that is {@link destroyContainer} here.
   */
  override async destroy(): Promise<void> {
    await this.core.destroy();
  }

  /** Destroys the container only; stored state and tokens stay. */
  destroyContainer(): Promise<void> {
    return this.core.destroyContainer();
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.core.listSessions();
  }

  acquireLease(name: string, options?: LeaseOptions): Promise<Lease | null> {
    return this.core.acquireLease(name, options);
  }

  renewLease(
    name: string,
    token: string,
    options?: LeaseOptions,
  ): Promise<Lease | null> {
    return this.core.renewLease(name, token, options);
  }

  releaseLease(name: string, token: string): Promise<boolean> {
    return this.core.releaseLease(name, token);
  }

  /**
   * Starts the container and prepares the sandbox (see `SandboxCore.ready`),
   * so the `hostile` tier's runtime check runs before anything else can
   * reach the container. In the `hostile` tier an override of
   * `entrypoint` or `enableInternet` is refused (`invalid`): the
   * entrypoint would run before that check.
   */
  override async start(overrides?: StartOverrides): Promise<void> {
    this.#checkOverrides(overrides);
    await super.start(overrides);
    await this.core.ready();
  }

  /** As {@link start}, then waits for `ports`. */
  override async startAndWaitForPorts(
    overrides?: StartOverrides,
    ports?: number[],
  ): Promise<void> {
    this.#checkOverrides(overrides);
    await super.start(overrides);
    await this.core.ready();
    const selected = ports ??
      (this.controller.options.requiredPorts.length > 0
        ? this.controller.options.requiredPorts
        : this.controller.options.defaultPort === undefined
        ? []
        : [this.controller.options.defaultPort]);
    for (const port of selected) await this.core.waitForPort(port);
  }

  #checkOverrides(overrides: StartOverrides | undefined): void {
    if (
      this.core.settings.tier === "hostile" &&
      overrides !== undefined
    ) {
      throw new SandboxError(
        "invalid",
        'tier "hostile" refuses all per-start overrides, including environment variables',
      );
    }
  }

  /**
   * An HTTP request to a container port, once the sandbox is ready (so a
   * `hostile` sandbox whose gVisor probe fails is refused, `unsafe_runtime`).
   */
  override async containerFetch(
    input: Request | string | URL,
    init?: RequestInit,
    port?: number,
  ): Promise<Response> {
    await this.core.ready();
    return await super.containerFetch(input, init, port);
  }

  /**
   * Forwards a request to `port` once the sandbox is ready; a sandbox that
   * cannot be made ready is answered as `errorResponse` does (a `hostile`
   * one whose gVisor probe fails: 503 `unsafe_runtime`).
   */
  override async fetchPort(request: Request, port: number): Promise<Response> {
    try {
      await this.core.ready();
    } catch (error) {
      if (
        ContainerError.from(error) !== null || SandboxError.from(error) !== null
      ) {
        return errorResponse(error, { unsafeDetail: this.unsafeDetail });
      }
      throw error;
    }
    return await super.fetchPort(request, port);
  }

  /**
   * Purges expired stream tickets and process records, then runs the
   * container's idle and crash checks. A subclass that overrides this
   * must call `super.alarm()`.
   */
  override async alarm(): Promise<void> {
    await this.core.alarm();
    await super.alarm();
  }

  /**
   * Preview requests, then stream tickets; a 404 for anything else. A
   * request carrying the preview header is a preview request whatever its
   * path, so the app behind an exposed port may serve paths under
   * `/.celld-sandbox/stream/` too; only a request without that header is
   * read as a ticket.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
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
      if (url.pathname.startsWith(STREAM_PATH)) {
        return await this.core.stream(
          url.pathname.slice(STREAM_PATH.length),
          request.body,
          request.signal,
        );
      }
    } catch (error) {
      if (
        ContainerError.from(error) !== null || SandboxError.from(error) !== null
      ) {
        return errorResponse(error, { unsafeDetail: this.unsafeDetail });
      }
      throw error;
    }
    return Response.json({ error: "not_found", message: "not found" }, {
      status: 404,
    });
  }
}
