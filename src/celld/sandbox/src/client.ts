// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

/**
 * The Worker side of a sandbox: {@link getSandbox} wraps a `Sandbox`
 * Durable Object stub in a {@link SandboxClient}, which turns RPC errors
 * back into `SandboxError`s, redeems stream tickets through the object's
 * `fetch`, and builds preview URLs; {@link proxyToSandbox} routes preview
 * requests.
 *
 * ```ts
 * import { getSandbox } from "@celld/sandbox";
 *
 * const sandbox = getSandbox(env.SANDBOX, "user-42");
 * await sandbox.writeFile("hello.sh", "echo hello from $0\n");
 * const result = await sandbox.exec(["sh", "hello.sh"]);
 * for await (const event of sandbox.events(await sandbox.execStream(["make", "test"]))) {
 *   if (event.type === "stdout") console.log(event.data);
 * }
 * ```
 *
 * @module
 */

import { SandboxError } from "./errors.ts";
import { parseSSEStream } from "./sse.ts";
import type {
  ExecOptions,
  ExecResult,
  ExistsResult,
  ExposedPort,
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
  SandboxEvent,
  SessionInfo,
  SessionOptions,
  StreamRequest,
  WriteFileOptions,
} from "./types.ts";

/** The path the `Sandbox` object serves stream tickets under. */
export const STREAM_PATH = "/.celld-sandbox/stream/";

/** The header carrying `port:token` for a preview request. */
export const PREVIEW_HEADER = "x-celld-sandbox-preview";

/** How a client builds preview URLs. */
export interface SandboxClientOptions {
  /** The domain preview hosts live under, such as `preview.example.com`. */
  readonly hostname?: string;
  /** Default `https`. */
  readonly protocol?: "https" | "http";
  /** Appended to the host, such as `:9876` for a local `celld dev`. */
  readonly port?: number;
}

const PREVIEW_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const PREVIEW_LABEL =
  /^(\d{1,5})-([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)-([a-z2-7]{16})$/;

/**
 * The preview URL of an exposed port: `https://<port>-<id>-<token>.<hostname>`.
 * The sandbox id must be a DNS label of lowercase letters, digits and `-`,
 * at most 40 characters.
 */
export function previewUrl(
  id: string,
  exposed: Pick<ExposedPort, "port" | "token">,
  options: SandboxClientOptions & { readonly hostname: string },
): string {
  if (!PREVIEW_ID.test(id)) {
    throw new SandboxError(
      "invalid",
      "preview URLs need a sandbox id of at most 40 lowercase letters, digits and -",
    );
  }
  const port = options.port === undefined ? "" : `:${options.port}`;
  return `${
    options.protocol ?? "https"
  }://${exposed.port}-${id}-${exposed.token}.${options.hostname}${port}`;
}

/** The port, sandbox id and token of a preview host name, or null. */
export function parsePreviewHost(
  host: string,
  hostname?: string,
): { port: number; id: string; token: string } | null {
  const name = host.toLowerCase().replace(/:\d+$/, "");
  const dot = name.indexOf(".");
  if (dot < 0) return null;
  if (
    hostname !== undefined && name.slice(dot + 1) !== hostname.toLowerCase()
  ) {
    return null;
  }
  const match = PREVIEW_LABEL.exec(name.slice(0, dot));
  if (match === null) return null;
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return null;
  return { port, id: match[2], token: match[3] };
}

/**
 * Routes a preview request (`<port>-<id>-<token>.<hostname>`) to its
 * sandbox, which forwards it to the port if the token matches. Answers
 * null for any other request, so a Worker can fall through to its own
 * routes.
 */
export async function proxyToSandbox<T extends SandboxApi>(
  request: Request,
  namespace: DurableObjectNamespace<T>,
  options: { readonly hostname?: string } = {},
): Promise<Response | null> {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const target = parsePreviewHost(host, options.hostname);
  if (target === null) return null;
  const headers = new Headers(request.headers);
  headers.set(PREVIEW_HEADER, `${target.port}:${target.token}`);
  const stub = namespace.getByName(target.id);
  return await stub.fetch(new Request(request, { headers }));
}

type Stub = DurableObjectStub<SandboxApi>;

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw SandboxError.wrap(error);
  }
}

/** See the module documentation. Every method maps to the object's RPC method. */
export class SandboxClient {
  readonly #stub: Stub;
  readonly #options: SandboxClientOptions;

  constructor(
    stub: Stub,
    readonly id: string,
    options: SandboxClientOptions = {},
  ) {
    this.#stub = stub;
    this.#options = options;
  }

  /** The underlying stub, for `fetch` and anything this class does not wrap. */
  get stub(): Stub {
    return this.#stub;
  }

  /** Parses a stream from `execStream` or `streamProcessLogs` into events. */
  events(stream: ReadableStream<Uint8Array>): AsyncGenerator<SandboxEvent> {
    return parseSSEStream<SandboxEvent>(stream);
  }

  exec(argv: string[], options?: ExecOptions): Promise<ExecResult> {
    return call(() => this.#stub.exec(argv, options));
  }

  execShell(script: string, options?: ExecOptions): Promise<ExecResult> {
    return call(() => this.#stub.execShell(script, options));
  }

  async #open(
    request: StreamRequest,
    body?: BodyInit,
    method = "GET",
  ): Promise<Response> {
    const ticket = await call(() => this.#stub.openStream(request));
    const response = await this.#stub.fetch(
      new Request(`http://sandbox${STREAM_PATH}${ticket}`, {
        method,
        ...(body === undefined ? {} : { body }),
      }),
    );
    if (!response.ok) {
      const problem = await response.json().catch(() => null) as
        | { error?: string; message?: string }
        | null;
      throw SandboxError.from(
        new Error(
          `[${problem?.error ?? "command_failed"}] ${
            problem?.message ?? response.statusText
          }`,
        ),
      ) ?? new Error(problem?.message ?? response.statusText);
    }
    return response;
  }

  /**
   * A command's events as a server-sent event stream (`start`, `stdout`,
   * `stderr`, then `complete` or `error`), ready to return to a browser or
   * to read with {@link events}.
   */
  async execStream(
    argv: string[],
    options?: ExecOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return (await this.#open({ kind: "exec", argv, options })).body!;
  }

  async execShellStream(
    script: string,
    options?: ExecOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return (await this.#open({ kind: "shell", script, options })).body!;
  }

  readFile(path: string, options?: ReadFileOptions): Promise<ReadFileResult> {
    return call(() => this.#stub.readFile(path, options));
  }

  /** A file's bytes as a stream, for files past `readFile`'s limit. */
  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    return (await this.#open({ kind: "read", path })).body!;
  }

  writeFile(
    path: string,
    content: string | Uint8Array,
    options?: WriteFileOptions,
  ): Promise<void> {
    return call(() => this.#stub.writeFile(path, content, options));
  }

  /** Writes a stream to a file, for files past `writeFile`'s limit. */
  async writeFileStream(
    path: string,
    body: ReadableStream<Uint8Array> | Uint8Array | string,
    options?: Omit<WriteFileOptions, "encoding">,
  ): Promise<{ path: string; size: number }> {
    const response = await this.#open(
      { kind: "write", path, options },
      body as BodyInit,
      "PUT",
    );
    return await response.json();
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return call(() => this.#stub.mkdir(path, options));
  }

  deleteFile(path: string): Promise<void> {
    return call(() => this.#stub.deleteFile(path));
  }

  remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    return call(() => this.#stub.remove(path, options));
  }

  renameFile(from: string, to: string): Promise<void> {
    return call(() => this.#stub.renameFile(from, to));
  }

  moveFile(from: string, to: string): Promise<void> {
    return call(() => this.#stub.moveFile(from, to));
  }

  exists(path: string): Promise<ExistsResult> {
    return call(() => this.#stub.exists(path));
  }

  stat(path: string): Promise<FileStat> {
    return call(() => this.#stub.stat(path));
  }

  listFiles(
    path?: string,
    options?: ListFilesOptions,
  ): Promise<ListFilesResult> {
    return call(() => this.#stub.listFiles(path, options));
  }

  gitCheckout(url: string, options?: GitCheckoutOptions): Promise<ExecResult> {
    return call(() => this.#stub.gitCheckout(url, options));
  }

  startProcess(argv: string[], options?: ProcessOptions): Promise<ProcessInfo> {
    return call(() => this.#stub.startProcess(argv, options));
  }

  startShellProcess(
    script: string,
    options?: ProcessOptions,
  ): Promise<ProcessInfo> {
    return call(() => this.#stub.startShellProcess(script, options));
  }

  listProcesses(): Promise<ProcessInfo[]> {
    return call(() => this.#stub.listProcesses());
  }

  getProcess(id: string): Promise<ProcessInfo> {
    return call(() => this.#stub.getProcess(id));
  }

  killProcess(id: string, signal?: string): Promise<ProcessInfo> {
    return call(() => this.#stub.killProcess(id, signal));
  }

  killAllProcesses(signal?: string): Promise<ProcessInfo[]> {
    return call(() => this.#stub.killAllProcesses(signal));
  }

  getProcessLogs(id: string): Promise<ProcessLogs> {
    return call(() => this.#stub.getProcessLogs(id));
  }

  waitForExit(
    id: string,
    options?: { timeoutMs?: number },
  ): Promise<ProcessInfo> {
    return call(() => this.#stub.waitForExit(id, options));
  }

  waitForLog(
    id: string,
    pattern: string,
    options?: { timeoutMs?: number; stream?: "stdout" | "stderr" | "both" },
  ): Promise<{ matched: boolean; line: string | null; process: ProcessInfo }> {
    return call(() => this.#stub.waitForLog(id, pattern, options));
  }

  /** A process's output as it is written, then an `exit` event. */
  async streamProcessLogs(
    id: string,
    options: { fromStart?: boolean } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    return (await this.#open({
      kind: "logs",
      processId: id,
      fromStart: options.fromStart,
    })).body!;
  }

  /** Waits for a container port to accept connections. */
  waitForPort(
    port: number,
    options?: { timeoutMs?: number; path?: string },
  ): Promise<void> {
    return call(() => this.#stub.waitForPort(port, options));
  }

  #withUrl(exposed: ExposedPort, hostname?: string): ExposedPort {
    const host = hostname ?? this.#options.hostname;
    if (host === undefined) return exposed;
    return {
      ...exposed,
      url: previewUrl(this.id, exposed, { ...this.#options, hostname: host }),
    };
  }

  /** Exposes a port; with a host name (here or in the client options) the result has its URL. */
  async exposePort(
    port: number,
    options: { name?: string; hostname?: string } = {},
  ): Promise<ExposedPort> {
    const { hostname, ...rest } = options;
    const exposed = await call(() => this.#stub.exposePort(port, rest));
    return this.#withUrl(exposed, hostname);
  }

  unexposePort(port: number): Promise<void> {
    return call(() => this.#stub.unexposePort(port));
  }

  async getExposedPorts(): Promise<ExposedPort[]> {
    const ports = await call(() => this.#stub.getExposedPorts());
    return ports.map((exposed) => this.#withUrl(exposed));
  }

  setEnvVars(
    env: Record<string, string | null>,
  ): Promise<Record<string, string>> {
    return call(() => this.#stub.setEnvVars(env));
  }

  createSession(options?: SessionOptions): Promise<SessionInfo> {
    return call(() => this.#stub.createSession(options));
  }

  deleteSession(id: string): Promise<void> {
    return call(() => this.#stub.deleteSession(id));
  }

  listSessions(): Promise<SessionInfo[]> {
    return call(() => this.#stub.listSessions());
  }

  /** Commands with this session's defaults filled in. */
  session(sessionId: string): SandboxSession {
    return new SandboxSession(this, sessionId);
  }

  getState(): Promise<Awaited<ReturnType<SandboxApi["getState"]>>> {
    return call(async () => await this.#stub.getState());
  }

  stop(signal?: number): Promise<void> {
    return call(() => this.#stub.stop(signal));
  }

  destroy(): Promise<void> {
    return call(() => this.#stub.destroy());
  }
}

/** The command methods of a {@link SandboxClient} bound to one session. */
export class SandboxSession {
  constructor(readonly client: SandboxClient, readonly id: string) {}

  exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.client.exec(argv, { ...options, sessionId: this.id });
  }

  execShell(script: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.client.execShell(script, { ...options, sessionId: this.id });
  }

  execStream(
    argv: string[],
    options: ExecOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    return this.client.execStream(argv, { ...options, sessionId: this.id });
  }

  startProcess(
    argv: string[],
    options: ProcessOptions = {},
  ): Promise<ProcessInfo> {
    return this.client.startProcess(argv, { ...options, sessionId: this.id });
  }

  startShellProcess(
    script: string,
    options: ProcessOptions = {},
  ): Promise<ProcessInfo> {
    return this.client.startShellProcess(script, {
      ...options,
      sessionId: this.id,
    });
  }
}

/** The sandbox named `id` in `namespace`, one container per id. */
export function getSandbox<T extends SandboxApi>(
  namespace: DurableObjectNamespace<T>,
  id: string,
  options: SandboxClientOptions = {},
): SandboxClient {
  if (typeof id !== "string" || id === "" || id.length > 128) {
    throw new SandboxError("invalid", "a sandbox id is 1 to 128 characters");
  }
  return new SandboxClient(
    namespace.getByName(id) as unknown as Stub,
    id,
    options,
  );
}
